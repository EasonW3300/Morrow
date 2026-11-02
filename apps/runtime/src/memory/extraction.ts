import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import { detectAllHighValue } from "./heuristics.ts";

/**
 * 抽取器（票 M1-T2 / Issue #14，FR-MEM-3）：记忆管线的第一个内部接缝。
 *
 *   输入 = 一轮会话的用户消息（含来源事件回链信息与近几轮上下文）
 *   输出 = 候选列表（内容/类型/置信度/敏感等级/命中规则）
 *
 * 可注入：生产默认 = HeuristicExtractor（确定性启发式，零网络）；LLM 抽取后续经
 * 同接口 + PiAdapter 替换（异步 extract 已在接口层预留 Promise）。实现契约：
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
