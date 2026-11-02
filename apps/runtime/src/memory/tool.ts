import type { MorrowTool, MorrowToolResult } from "@morrow/pi-adapter";
import type { MemoryWriteInput } from "@morrow/protocol";
import { MemoryService, MemoryWriteError } from "./service.ts";

/**
 * memory.write 工具（票 M1-T1 / Issue #13）：前台 Memory Tool，经 PiAdapter 的
 * tools 通道注册（AdapterConfig.tools / FakePiConfig.tools），模型在对话中显式调用。
 *
 * 入参 schema 与 protocol 的 MemoryWriteInput 一一对应（共享类型唯一真相源）；
 * 参数的 JSON Schema 校验发生在 PiAdapter 侧，业务校验（空内容等）在 MemoryService，
 * 失败以 isError 文本返回给模型而不是抛异常。
 */

export const MEMORY_WRITE_TOOL_NAME = "memory.write";

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    content: {
      type: "string",
      minLength: 1,
      description: "要保存的记忆内容，一句完整且自包含的陈述（把指代补全成 Owner 可检索的事实）",
    },
    kind: {
      type: "string",
      enum: ["fact", "preference", "profile", "procedural"],
      description: "记忆类型：fact 事实 / preference 偏好 / profile 用户画像 / procedural 操作经验；缺省 fact",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "置信度 [0,1]；缺省 0.9（显式写入）",
    },
    sensitivity: {
      type: "string",
      enum: ["public", "private", "locked"],
      description: "敏感等级：public 可同步可引用 / private 仅 Owner 会话（默认）/ locked 禁止自动改写",
    },
  },
  required: ["content"],
  additionalProperties: false,
} as const;

/** memory.write 的入参 JSON Schema（票 M2-T1：builtin manifest 的 input_schema 单一真相源） */
export const MEMORY_WRITE_TOOL_PARAMETERS: typeof TOOL_PARAMETERS = TOOL_PARAMETERS;

export function createMemoryWriteTool(deps: { service: MemoryService; sessionId: string }): MorrowTool {
  return {
    name: MEMORY_WRITE_TOOL_NAME,
    description:
      "Save a durable memory about the Owner (facts, preferences, profile) for later retrieval. " +
      "Use when the user states something worth remembering long-term or explicitly asks to remember.",
    parameters: TOOL_PARAMETERS,
    async execute(_toolCallId, args): Promise<MorrowToolResult> {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return { text: "memory.write expects an object with a non-empty `content` string", isError: true };
      }
      try {
        const result = deps.service.writeFromTool(deps.sessionId, args as MemoryWriteInput);
        return {
          text: `memory saved (candidate ${result.candidate.candidate_id}, sensitivity ${result.candidate.sensitivity})`,
        };
      } catch (err) {
        if (err instanceof MemoryWriteError) {
          return { text: `memory.write rejected: ${err.message}`, isError: true };
        }
        throw err;
      }
    },
  };
}
