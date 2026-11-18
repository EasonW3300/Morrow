/**
 * Pi 事件 → Morrow 五类窄事件的纯翻译。
 *
 * 输入刻意是 unknown：本函数只读取 Pi 1.4.0 事件里它认识的字段（结构化判定），
 * 不 import Pi 类型、容忍额外/缺失字段——Pi 周更且字段持续演进（ADR-0001），
 * 翻译必须对未知形态鲁棒（返回空数组而不是抛出）。
 *
 * 映射表（NOTES-pi §9）：
 *   message_update(text_delta)      → text_delta
 *   tool_execution_start            → tool_start
 *   tool_execution_end              → tool_end
 *   agent_end(最后一条 assistant)    → agent_end
 *   agent_end(assistant.stopReason === "error") → error（先于 agent_end）
 *   其余（agent/turn/message 生命周期、thinking、toolcall 流式细节）→ 丢弃
 */
import type { AgentStopReason, MorrowAgentEvent } from "./types.ts";
import { resolveRunUsage } from "./usage.ts";

const KNOWN_STOP_REASONS: readonly AgentStopReason[] = [
  "stop",
  "length",
  "toolUse",
  "aborted",
  "error",
  "deferred",
];

export function translatePiEvent(event: unknown): MorrowAgentEvent[] {
  if (typeof event !== "object" || event === null) return [];
  const record = event as Record<string, unknown>;

  switch (record.type) {
    case "message_update": {
      const sub = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (sub?.type !== "text_delta" || typeof sub.delta !== "string") return [];
      return [{ type: "text_delta", delta: sub.delta }];
    }
    case "tool_execution_start": {
      const { toolCallId, toolName, args } = record;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") return [];
      return [{ type: "tool_start", toolCallId, toolName, args }];
    }
    case "tool_execution_end": {
      const { toolCallId, toolName, result, isError, durationMs } = record;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") return [];
      const narrowed: MorrowAgentEvent = {
        type: "tool_end",
        toolCallId,
        toolName,
        text: extractToolText(result),
        isError: isError === true,
        ...(typeof durationMs === "number" ? { durationMs } : {}),
      };
      return [narrowed];
    }
    case "agent_end": {
      return translateAgentEnd(record.messages);
    }
    default:
      return [];
  }
}

function translateAgentEnd(messages: unknown): MorrowAgentEvent[] {
  const lastAssistant = findLastAssistant(messages);
  const stopReason = normalizeStopReason(lastAssistant?.stopReason);
  const out: MorrowAgentEvent[] = [];

  // 用量在 agent_end **之前**发（Goal 的预算累加只关心它，收尾时必须已到账）。
  // 优先采信供应商返回的 usage；缺失则按 messages 的字符数估算并标 estimated
  // ——这一步必须在这里做，因为 messages 只在 agent_end 事件里拿得到。
  const usage = resolveRunUsage({
    assistantMessage: lastAssistant,
    promptChars: countChars(messages, "user"),
    outputChars: countChars(messages, "assistant"),
  });
  out.push({ type: "usage", usage });

  if (stopReason === "error") {
    const message =
      typeof lastAssistant?.errorMessage === "string" && lastAssistant.errorMessage.length > 0
        ? lastAssistant.errorMessage
        : "unknown provider error";
    out.push({ type: "error", message });
  }
  out.push({ type: "agent_end", stopReason });
  return out;
}

interface AssistantLike {
  stopReason?: unknown;
  errorMessage?: unknown;
}

function findLastAssistant(messages: unknown): AssistantLike | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | null | undefined;
    if (m?.role === "assistant") return m as AssistantLike;
  }
  return undefined;
}

/**
 * 统计某角色的消息文本总字符数（估算路径用）。
 *
 * 只数 text 内容块：tool call 参数与工具结果不计入（它们的 token 由供应商的
 * usage 覆盖；估算路径下把它们算进来会让数字虚高，而我们宁愿低估——低估会让
 * 预算判定偏向"再跑一轮"，比高估导致过早停摆更安全）。
 */
function countChars(messages: unknown, role: "user" | "assistant"): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const message = raw as Record<string, unknown>;
    if (message.role !== role) continue;
    const content = message.content;
    if (typeof content === "string") {
      total += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const typed = block as Record<string, unknown>;
      if (typed.type === "text" && typeof typed.text === "string") total += typed.text.length;
    }
  }
  return total;
}

function normalizeStopReason(value: unknown): AgentStopReason {
  return KNOWN_STOP_REASONS.find((r) => r === value) ?? "stop";
}

/** Pi AgentToolResult.content（TextContent[]）→ 纯文本；容忍字符串与畸形形态 */
function extractToolText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const c = item as Record<string, unknown>;
      if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}
