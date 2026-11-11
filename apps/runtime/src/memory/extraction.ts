import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import type { AgentRuntime } from "@morrow/pi-adapter";
import { detectAllHighValue } from "./heuristics.ts";

/**
 * 抽取器（票 M1-T2 / Issue #14，FR-MEM-3）：记忆管线的第一个内部接缝。
 *
 *   输入 = 一轮会话的用户消息（含来源事件回链信息与近几轮上下文）
 *   输出 = 候选列表（内容/类型/置信度/敏感等级/命中规则）
 *
 * 可注入：生产默认 = HeuristicExtractor（确定性启发式，零网络）；LlmMemoryExtractor
 * 经同接口走 PiAdapter（一次 prompt，config 选择，M1 code-review 补齐）。实现契约：
 * 抽取是纯判定——不落库、不记账（写路径统一在 MemoryService，含去重与校验）。
 */

/** 一次抽取产出：候选内容 + 判定元数据（写路径补来源与时间） */
export interface ExtractedCandidate {
  content: string;
  kind: MemoryEntryKind;
  confidence: number;
  sensitivity: SensitivityLevel;
  /** 命中的抽取规则名（memory.candidate_created payload.rule 的标注值） */
  rule: string;
}

export interface ExtractionInput {
  sessionId: string;
  /** 本轮 message.user 账本事件 id（候选证据回链目标） */
  userEventId: string;
  /** 来源事件发生时间（候选的 occurred_at） */
  occurredAt: string;
  /** 本轮用户消息全文 */
  userText: string;
  /** 近几轮用户消息（含本轮，时间升序）；默认实现只用本轮文本，LLM 实现可用 */
  recentUserTexts: string[];
}

export interface MemoryExtractor {
  extract(input: ExtractionInput): ExtractedCandidate[] | Promise<ExtractedCandidate[]>;
}

/**
 * 默认抽取器：确定性启发式（heuristics.ts 的多句扫描）。与 T1 即时写入同源规则——
 * 同一轮里即时路径先写走的候选由 MemoryService 按来源+内容去重，后台抽取补上
 * 即时路径（取首命中）漏掉的第二条及以后的高价值句子。
 */
export class HeuristicExtractor implements MemoryExtractor {
  extract(input: ExtractionInput): ExtractedCandidate[] {
    return detectAllHighValue(input.userText).map((match) => ({
      content: match.content,
      kind: match.kind,
      confidence: match.confidence,
      sensitivity: "private" as const,
      rule: match.rule,
    }));
  }
}

// --- LLM 抽取器（M1 code-review / Issue #14 补齐）：经 PiAdapter 一次 prompt -----------

/** 抽取运行时工厂：一次抽取一个 AgentRuntime（生产 = 默认 Provider + 抽取系统提示词） */
export type ExtractorRuntimeFactory = () => Promise<AgentRuntime>;

/** 抽取系统提示词：契约 = 只输出一个 JSON 数组，每个元素形如候选投影 */
export const LLM_EXTRACTOR_SYSTEM_PROMPT = [
  "你是 Morrow 的记忆抽取器。判断用户消息里是否包含值得长期记住的高价值信息",
  "（事实、偏好、用户画像、操作经验），输出候选记忆。",
  "只输出一个 JSON 数组，不要输出任何解释文字，每个元素形如：",
  '{"content": "记忆内容（独立成句）", "kind": "fact|preference|profile|procedural",',
  ' "confidence": 0.0到1.0, "sensitivity": "public|private|locked"}',
  "规则：没有值得记的内容就输出 []；confidence 反映确定性（<0.6 的不要输出）；",
  "拿不准的敏感等级一律 private。",
].join("\n");

const LLM_KINDS: readonly MemoryEntryKind[] = ["fact", "preference", "profile", "procedural"];
const LLM_SENSITIVITIES: readonly SensitivityLevel[] = ["public", "private", "locked"];

/** 抽取规则的标注名（memory.candidate_created payload.rule） */
const LLM_EXTRACTOR_RULE = "llm-extractor";

/** 剥掉 ```json … ``` 围栏（模型最常见的违规形态）；其余原文返回 */
function stripCodeFence(text: string): string {
  const fenced = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?\s*```$/.exec(text.trim());
  return fenced !== null ? fenced[1] : text.trim();
}

/**
 * LLM 抽取器：经 PiAdapter 一次 prompt（近几轮上下文 + 本轮消息），模型只输出
 * JSON 候选数组；解析失败 / 形状非法 / 运行报错一律返回空数组——抽取是
 * fire-and-forget 的后台链路，坏输出绝不抛进会话主链路（契约同 HeuristicExtractor
 * 的「不静默丢弃」由写路径去重与置信度准入兜底，这里只保证不破坏）。
 * 单条候选逐项校验（content 非空 / kind、sensitivity 枚举 / confidence 有限数），
 * 非法项丢弃不拖累整批；confidence 钳位 [0,1]。
 */
export class LlmMemoryExtractor implements MemoryExtractor {
  readonly #factory: ExtractorRuntimeFactory;

  constructor(factory: ExtractorRuntimeFactory) {
    this.#factory = factory;
  }

  async extract(input: ExtractionInput): Promise<ExtractedCandidate[]> {
    const run: { text: string; error: string | null; stopReason: string | null } = {
      text: "",
      error: null,
      stopReason: null,
    };
    let runtime: AgentRuntime;
    try {
      runtime = await this.#factory();
    } catch {
      return []; // 工厂不可用（无 Provider 等）：本轮无候选，不抛
    }
    const unsubscribe = runtime.subscribe((event) => {
      switch (event.type) {
        case "text_delta":
          run.text += event.delta;
          break;
        case "error":
          run.error = event.message;
          break;
        case "agent_end":
          run.stopReason = event.stopReason;
          break;
        default:
          break;
      }
    });
    const recent = input.recentUserTexts.filter((t) => t !== input.userText).join("\n---\n");
    const prompt = [
      recent.length > 0 ? `近几轮上下文：\n${recent}\n` : "",
      `本轮用户消息：\n${input.userText}`,
    ].join("\n");
    try {
      await runtime.prompt(prompt);
    } catch {
      return []; // prompt 误用/中止契约外异常：同坏输出处理
    } finally {
      unsubscribe();
      runtime.dispose();
    }
    if (run.error !== null || run.stopReason === "error" || run.stopReason === "aborted") {
      return [];
    }
    return parseLlmCandidates(run.text);
  }
}

/** 模型输出 → 候选数组（纯函数）：任何不合法形态返回空数组，非法项逐条丢弃 */
export function parseLlmCandidates(rawText: string): ExtractedCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const candidates: ExtractedCandidate[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const content = record.content;
    if (typeof content !== "string" || content.trim().length === 0) continue;
    const kind = record.kind;
    if (typeof kind !== "string" || !(LLM_KINDS as readonly string[]).includes(kind)) continue;
    const confidence = record.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) continue;
    const sensitivity = record.sensitivity;
    const resolvedSensitivity =
      typeof sensitivity === "string" && (LLM_SENSITIVITIES as readonly string[]).includes(sensitivity)
        ? (sensitivity as SensitivityLevel)
        : "private";
    candidates.push({
      content: content.trim(),
      kind: kind as MemoryEntryKind,
      confidence: Math.min(1, Math.max(0, confidence)),
      sensitivity: resolvedSensitivity,
      rule: LLM_EXTRACTOR_RULE,
    });
  }
  return candidates;
}
