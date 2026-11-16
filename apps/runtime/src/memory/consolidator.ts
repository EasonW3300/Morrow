import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";

/**
 * 巩固器（票 M1-T2 / Issue #14，FR-MEM-4/5）：记忆管线的第二个内部接缝。
 *
 *   输入 = 待巩固候选批次 + 现存长期事实视图
 *   输出 = 每条候选恰好一个巩固动作（顺序与输入一致）：
 *     create_fact   新建事实（无同主题事实）
 *     corroborate   印证（归一化内容相同）→ 只补来源关系，不改写事实
 *     update_fact   自动更新（同主题偏好，低风险）→ 由服务执行版本+1 + MemoryRevision
 *     escalate      冲突上报 → 进待确认队列，绝不静默覆盖
 *
 * 冲突矩阵（PRD §4.1 FR-MEM-5 / GLOSSARY Sensitivity Level，按序判定）：
 *   1. 既有事实 locked 且内容不同        → escalate "locked"
 *      （GLOSSARY：locked 禁止一切自动改写，变更必须经 Owner 确认——连偏好也不豁免）
 *   2. 候选与事实敏感等级不同            → escalate "sensitivity_change"
 *      （可见性分级是同步/引用语义的一部分，升级与放宽都不静默变更）
 *   3. kind = preference                 → update_fact（常规偏好自动更新留历史）
 *   4. 其余 kind 且内容不同              → escalate "fact_conflict"（重大事实冲突）
 *
 * 同主题判定是确定性的：kind 相同 且 显著词元交集非空。显著词元 = ASCII 词（≥2 字符，
 * 小写）∪ CJK 单字（去常用虚词停用字表）。这是启发式：判定过宽会把无关候选卷进冲突
 * 审核（宁可多问，不静默覆盖），判定过窄会多建事实——两者都可由 Owner 经裁决端点纠偏。
 *
 * 可注入：生产用 DefaultConsolidator；LLM 巩固（语义合并/置信度整合）后续经同接口替换。
 */

/** 冲突上报原因（memory.conflict_detected / memory_conflicts.reason 的取值集合） */
export type ConflictReason = "fact_conflict" | "locked" | "sensitivity_change";

/** 进入巩固器的候选视图（MemoryCandidateRow + 来源 id；服务层投影，不含存储细节） */
export interface ConsolidationCandidateView {
  candidateId: string;
  content: string;
  kind: MemoryEntryKind;
  sensitivity: SensitivityLevel;
  confidence: number;
  /** 候选来源（memory_sources.source_id），修订历史回链用 */
  sourceId: string;
  /**
   * 候选作用域（票 M7-A-T3）：巩固匹配只在同作用域事实之间进行——
   * 临时会话候选不会改写/冲突到长期记忆；缺省 owner（旧注入实现无需改动）。
   */
  scope?: string;
}

/** 现存长期事实视图（仅巩固判定所需字段） */
export interface ConsolidationFactView {
  factId: string;
  content: string;
  kind: MemoryEntryKind;
  sensitivity: SensitivityLevel;
  version: number;
}

export type ConsolidationAction =
  | { action: "create_fact"; candidateId: string; content: string; kind: MemoryEntryKind; sensitivity: SensitivityLevel }
  | { action: "corroborate"; factId: string; candidateId: string }
  | {
      action: "update_fact";
      factId: string;
      candidateId: string;
      content: string;
      sensitivity: SensitivityLevel;
      reason: "preference_update";
    }
  | {
      action: "escalate";
      factId: string;
      candidateId: string;
      reason: ConflictReason;
      existingContent: string;
      incomingContent: string;
    };

export interface ConsolidationInput {
  candidates: ConsolidationCandidateView[];
  facts: ConsolidationFactView[];
}

/** 巩固器接缝（唯一新增内部接缝之一）：实现必须纯——只读输入，不触存储与账本 */
export interface MemoryConsolidator {
  consolidate(input: ConsolidationInput): ConsolidationAction[];
}

/** 常用虚词停用字（CJK 单字词元剔除；覆盖代词/助词/介词/常用单字动词） */
const CJK_STOPWORDS = new Set(
  "的了是在我你他她它这那有不没就都还很也但和与跟吧呢吗啊呀哦把被让给到对就才刚已经会说要想去能可以下上个们之或若而且".split(""),
);

/** ASCII 词（≥2 字符）——单字母（I/a）与数字孤立出现不构成主题信号 */
const ASCII_TOKEN_RE = /[a-z0-9][a-z0-9'+._-]*/gi;

/** 显著词元：主题判定的确定性特征（小写 ASCII 词 ∪ 非停用 CJK 单字） */
export function salientTokens(content: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of content.toLowerCase().matchAll(ASCII_TOKEN_RE)) {
    if (match[0].length >= 2) tokens.add(match[0]);
  }
  for (const ch of content) {
    if (CJK_STOPWORDS.has(ch)) continue;
    // 与 store.ts 的 CJK_RE 同区段：表意文字/假名/谚文按单字成词
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(ch)) tokens.add(ch);
  }
  return tokens;
}

/** 归一化内容：印证判定用（去全部空白 + 小写；CJK 文本中的空格是排版噪声）。
 *  受控导入（票 M1-T3）的内容变更比对复用同一口径——「与 T2 巩固相同的冲突判定」。 */
export function normalizeForComparison(content: string): string {
  return content.replace(/\s+/g, "").toLowerCase();
}

function overlapSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
}

/** 默认巩固器：确定性决策矩阵（见文件头），零依赖、可离线重放 */
export class DefaultConsolidator implements MemoryConsolidator {
  consolidate(input: ConsolidationInput): ConsolidationAction[] {
    return input.candidates.map((candidate) => this.#decide(candidate, input.facts));
  }

  #decide(candidate: ConsolidationCandidateView, facts: ConsolidationFactView[]): ConsolidationAction {
    const candidateTokens = salientTokens(candidate.content);
    // 最优匹配 = 词元交集最大；并列取 facts 数组中更早者（服务层按 created_at 升序给）
    let best: { fact: ConsolidationFactView; overlap: number } | null = null;
    for (const fact of facts) {
      if (fact.kind !== candidate.kind) continue;
      const overlap = overlapSize(candidateTokens, salientTokens(fact.content));
      if (overlap === 0) continue;
      if (best === null || overlap > best.overlap) best = { fact, overlap };
    }
    if (best === null) {
      return {
        action: "create_fact",
        candidateId: candidate.candidateId,
        content: candidate.content,
        kind: candidate.kind,
        sensitivity: candidate.sensitivity,
      };
    }
    const fact = best.fact;
    if (normalizeForComparison(candidate.content) === normalizeForComparison(fact.content)) {
      return { action: "corroborate", factId: fact.factId, candidateId: candidate.candidateId };
    }
    if (fact.sensitivity === "locked") {
      return {
        action: "escalate",
        factId: fact.factId,
        candidateId: candidate.candidateId,
        reason: "locked",
        existingContent: fact.content,
        incomingContent: candidate.content,
      };
    }
    if (candidate.sensitivity !== fact.sensitivity) {
      return {
        action: "escalate",
        factId: fact.factId,
        candidateId: candidate.candidateId,
        reason: "sensitivity_change",
        existingContent: fact.content,
        incomingContent: candidate.content,
      };
    }
    if (candidate.kind === "preference") {
      return {
        action: "update_fact",
        factId: fact.factId,
        candidateId: candidate.candidateId,
        content: candidate.content,
        sensitivity: candidate.sensitivity,
        reason: "preference_update",
      };
    }
    return {
      action: "escalate",
      factId: fact.factId,
      candidateId: candidate.candidateId,
      reason: "fact_conflict",
      existingContent: fact.content,
      incomingContent: candidate.content,
    };
  }
}
