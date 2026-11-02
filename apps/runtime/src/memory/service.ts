import type { MemoryEntryKind, MemoryWriteInput, SensitivityLevel } from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { SESSION_EVENT_TYPES } from "../sessions.ts";
import {
  type ConflictReason,
  type ConsolidationAction,
  type ConsolidationCandidateView,
  type ConsolidationFactView,
  DefaultConsolidator,
  type MemoryConsolidator,
} from "./consolidator.ts";
import {
  type ExtractionInput,
  HeuristicExtractor,
  type MemoryExtractor,
} from "./extraction.ts";
import {
  type CandidateStatus,
  type ConflictResolution,
  type CreateCandidateInput,
  type MemoryCandidateRow,
  type MemoryConflictRow,
  type MemorySearchHit,
  type MemorySourceRow,
  MemoryStore,
} from "./store.ts";
import { detectHighValue } from "./heuristics.ts";

/**
 * 记忆服务（票 M1-T1 / Issue #13；抽取/巩固管线 M1-T2 / Issue #14）。
 * 候选写入的三条路径共用一个落库+记账出口：
 *
 *   1. observeUserMessage —— 对话中命中高价值规则（heuristics.ts，确定性启发式）时，
 *      SessionManager 在 message.user 入账本后立即调用；来源 = 刚落账的 message.user 事件。
 *   2. writeFromTool —— 模型经 PiAdapter tools 通道显式调用 memory.write 工具；
 *      来源 = 会话最新一条 message.user。
 *   3. extractTurn —— 轮次收尾（message.assistant 落账）后的后台抽取（T2）：注入的
 *      Extractor 产出候选（同来源+同内容去重，避免与路径 1/2 重复），运行留
 *      memory.extracted 事件；随后把达到自动巩固准入线（confidence ≥ 0.8）的新候选
 *      交给注入的 Consolidator 巩固（低于准入线的候选留 pending，等 Owner 经
 *      decideCandidate 采纳——确定性启发式的低置信命中不静默转正）。
 *
 * 巩固（T2）：Consolidator（纯判定）逐条产出动作，服务执行写路径——create_fact /
 * update_fact（版本+1 + MemoryRevision）/ corroborate（只补来源）/ escalate（冲突进
 * memory_conflicts 待确认队列，绝不静默覆盖）。批内逐条决策并即时刷新事实视图，
 * 杜绝同批同主题重复建事实。
 *
 * memory.* 事件族（event_type 清单只增不减；actor 一律 agent:runtime）：
 *   memory.candidate_created  候选落库后记账（T1）
 *   memory.extracted          抽取运行收尾（T2；causation → message.assistant）
 *   memory.consolidated       巩固运行收尾（T2；自动路径 causation → 同轮 memory.extracted，
 *                             decide 路径 causation → 候选来源事件）
 *   memory.fact_created       巩固新建事实（T2 激活；causation → 证据 message.user）
 *   memory.fact_updated       事实版本链推进（T2；自动偏好更新 / 冲突裁决采纳新值或合并）
 *   memory.conflict_detected  冲突上报进待确认队列（T2）
 *   memory.conflict_resolved  冲突裁决落定（T2；keep_old 只留此事件，事实不动）
 *
 * 顺序约定：先落行（事务），后记账本事件；账本 append 失败向调用方抛错（后台路径
 * 由 fire-and-forget 捕获记日志）——行是可重建投影，事件缺失即本次写入未生效。
 */

export const MEMORY_EVENT_TYPES = {
  candidateCreated: "memory.candidate_created",
  extracted: "memory.extracted",
  consolidated: "memory.consolidated",
  factCreated: "memory.fact_created",
  factUpdated: "memory.fact_updated",
  conflictDetected: "memory.conflict_detected",
  conflictResolved: "memory.conflict_resolved",
} as const;

/** memory.write 工具路径在事件 payload.rule 里的标注值 */
export const MEMORY_WRITE_RULE = "memory.write";

/**
 * 自动巩固准入线（票 M1-T2）：抽取产生的候选 confidence ≥ 此值时随抽取运行自动巩固；
 * 更低置信的候选（确定性启发式的弱命中）留 pending，等 Owner 经 decideCandidate 采纳。
 * 冲突上报不受此线影响（escalate 的候选必先进队列）。
 */
export const AUTO_CONSOLIDATE_MIN_CONFIDENCE = 0.8;

/** 候选/冲突控制面错误（decideCandidate / resolveConflict / 列表参数）→ HTTP 400/404/409 */
export type MemoryControlErrorCode = "not_found" | "invalid_input" | "invalid_state";

export class MemoryControlError extends Error {
  code: MemoryControlErrorCode;

  constructor(code: MemoryControlErrorCode, message: string) {
    super(message);
    this.name = "MemoryControlError";
    this.code = code;
  }
}

/** 巩固运行摘要（memory.consolidated payload 的同构投影） */
export interface ConsolidationRunSummary {
  candidateCount: number;
  createdFactIds: string[];
  updatedFactIds: string[];
  corroboratedFactIds: string[];
  conflictIds: string[];
  /** memory.consolidated 事件 id */
  consolidatedEventId: string;
}

/** 工具入参非法（空内容 / 越界 confidence / 未知 sensitivity 或 kind） */
export class MemoryWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryWriteError";
  }
}

export interface ObserveUserMessageInput {
  sessionId: string;
  /** 触发本轮的 message.user 账本事件 id（来源回链目标） */
  userEventId: string;
  /** 来源事件发生时间（信封 occurred_at，候选的发生时间） */
  occurredAt: string;
  text: string;
}

export interface MemoryWriteResult {
  source: MemorySourceRow;
  candidate: MemoryCandidateRow;
  /** memory.candidate_created 事件 */
  eventId: string;
  sequence: number;
}

const MEMORY_KINDS: readonly MemoryEntryKind[] = ["fact", "preference", "profile", "procedural"];
const SENSITIVITY_LEVELS: readonly SensitivityLevel[] = ["public", "private", "locked"];

export class MemoryService {
  readonly #store: MemoryStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #extractor: MemoryExtractor;
  readonly #consolidator: MemoryConsolidator;

  constructor(deps: {
    store: MemoryStore;
    ledger: EventLedger;
    replicaId: string;
    /** 抽取器注入 seam（票 M1-T2）；缺省 = 确定性启发式（HeuristicExtractor） */
    extractor?: MemoryExtractor;
    /** 巩固器注入 seam（票 M1-T2）；缺省 = 确定性决策矩阵（DefaultConsolidator） */
    consolidator?: MemoryConsolidator;
  }) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#replicaId = deps.replicaId;
    this.#extractor = deps.extractor ?? new HeuristicExtractor();
    this.#consolidator = deps.consolidator ?? new DefaultConsolidator();
  }

  /**
   * 对话观察入口：对用户消息跑确定性高价值启发式；命中则即时写入候选 + 来源 +
   * memory.candidate_created 事件。无命中（闲聊）返回 null，零副作用。
   */
  observeUserMessage(input: ObserveUserMessageInput): MemoryWriteResult | null {
    const hit = detectHighValue(input.text);
    if (hit === null) return null;
    return this.#persist({
      sessionId: input.sessionId,
      sourceEventId: input.userEventId,
      content: hit.content,
      kind: hit.kind,
      confidence: hit.confidence,
      sensitivity: "private",
      occurredAt: input.occurredAt,
      rule: hit.rule,
    });
  }

  /**
   * memory.write 工具入口：入参为 protocol MemoryWriteInput（schema 校验由 PiAdapter
   * 参数校验 + 此处的业务校验共同把关）；显式写入默认置信度 0.9、sensitivity private。
   */
  writeFromTool(sessionId: string, input: MemoryWriteInput): MemoryWriteResult {
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      throw new MemoryWriteError("content must be a non-empty string");
    }
    if (input.kind !== undefined && !MEMORY_KINDS.includes(input.kind)) {
      throw new MemoryWriteError(`unknown kind: ${String(input.kind)}`);
    }
    if (input.sensitivity !== undefined && !SENSITIVITY_LEVELS.includes(input.sensitivity)) {
      throw new MemoryWriteError(`unknown sensitivity: ${String(input.sensitivity)}`);
    }
    if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1)) {
      throw new MemoryWriteError("confidence must be within [0, 1]");
    }
    const source = this.latestUserEvent(sessionId);
    if (source === null) {
      throw new MemoryWriteError("no user message in this session to attribute the memory to");
    }
    return this.#persist({
      sessionId,
      sourceEventId: source.event_id,
      content: input.content.trim(),
      kind: input.kind ?? "fact",
      confidence: input.confidence ?? 0.9,
      sensitivity: input.sensitivity ?? "private",
      occurredAt: source.occurred_at,
      rule: MEMORY_WRITE_RULE,
    });
  }

  /** FTS5 关键词检索（MemoryStore 透传；命中含来源回链） */
  search(q: string): MemorySearchHit[] {
    return this.#store.search(q);
  }

  /** 会话最新一条 message.user 账本事件（工具写入的来源回链目标） */
  latestUserEvent(sessionId: string): { event_id: string; occurred_at: string } | null {
    const entries = this.#ledger.scan({ sessionId, eventType: SESSION_EVENT_TYPES.messageUser });
    const last = entries.at(-1);
    if (last === undefined) return null;
    return { event_id: last.envelope.event_id, occurred_at: last.envelope.occurred_at };
  }

  // --- 抽取/巩固管线（票 M1-T2 / Issue #14）------------------------------------

  /**
   * 轮次收尾触发点（SessionManager 在 message.assistant 落账后调用）：fire-and-forget
   * 异步抽取，失败只记日志——候选是增强路径，不得影响会话主链路。
   */
  observeTurnEnd(input: { sessionId: string; userEventId: string; assistantEventId: string; occurredAt: string; text: string }): void {
    void this.extractTurn(input).catch((err: unknown) => {
      console.error("[morrow] memory extraction failed:", err);
    });
  }

  /**
   * 后台抽取一轮用户消息：Extractor 产出候选 → 校验 → 同来源+同内容去重 → 落库 +
   * memory.candidate_created 事件 → memory.extracted 运行事件 → 达准入线（confidence ≥
   * AUTO_CONSOLIDATE_MIN_CONFIDENCE）的新候选自动巩固。抽取器输出非法时整体拒绝
   * （不写半截候选），由 fire-and-forget 捕获记日志。
   */
  async extractTurn(input: {
    sessionId: string;
    userEventId: string;
    /** 本轮 message.assistant 事件 id（memory.extracted 的 causation）；缺省回退 userEventId */
    assistantEventId?: string;
    occurredAt: string;
    text: string;
  }): Promise<{ extractedCount: number; skippedDuplicates: number; candidateIds: string[]; extractedEventId: string; consolidation: ConsolidationRunSummary | null }> {
    const extracted = await this.#extractor.extract({
      sessionId: input.sessionId,
      userEventId: input.userEventId,
      occurredAt: input.occurredAt,
      userText: input.text,
      recentUserTexts: [input.text],
    });
    // 先整体校验（注入实现的防线）：坏输出不写半截候选
    for (const item of extracted) {
      if (typeof item.content !== "string" || item.content.trim().length === 0) {
        throw new MemoryWriteError("extractor produced empty content");
      }
      if (!MEMORY_KINDS.includes(item.kind)) {
        throw new MemoryWriteError(`extractor produced unknown kind: ${String(item.kind)}`);
      }
      if (!SENSITIVITY_LEVELS.includes(item.sensitivity)) {
        throw new MemoryWriteError(`extractor produced unknown sensitivity: ${String(item.sensitivity)}`);
      }
      if (typeof item.confidence !== "number" || !(item.confidence >= 0 && item.confidence <= 1)) {
        throw new MemoryWriteError("extractor produced confidence outside [0, 1]");
      }
      if (typeof item.rule !== "string" || item.rule.trim().length === 0) {
        throw new MemoryWriteError("extractor produced an empty rule name");
      }
    }
    const candidateIds: string[] = [];
    let skippedDuplicates = 0;
    for (const item of extracted) {
      // 去重：同一来源事件 + 同一内容只写一次（T1 即时写入/工具路径先写走的候选不重复）
      if (this.#store.hasCandidateFromSource(input.userEventId, item.content)) {
        skippedDuplicates += 1;
        continue;
      }
      const result = this.#persist({
        sessionId: input.sessionId,
        sourceEventId: input.userEventId,
        content: item.content,
        kind: item.kind,
        confidence: item.confidence,
        sensitivity: item.sensitivity,
        occurredAt: input.occurredAt,
        rule: item.rule,
      });
      candidateIds.push(result.candidate.candidate_id);
    }
    const extractedEnvelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: MEMORY_EVENT_TYPES.extracted,
      sessionId: input.sessionId,
      payload: {
        user_event_id: input.userEventId,
        ...(input.assistantEventId !== undefined ? { assistant_event_id: input.assistantEventId } : {}),
        extracted_count: candidateIds.length,
        skipped_duplicates: skippedDuplicates,
        candidate_ids: candidateIds,
      },
      causationId: input.assistantEventId ?? input.userEventId,
    });
    const { sequence } = this.#ledger.append(extractedEnvelope);
    // 自动巩固批次 = 当前全部 pending 候选中达准入线者——不只本运行新写的：
    // T1 即时写入 / memory.write 工具路径产生的候选同样在下一轮收尾时被巩固
    //（跨写路径补齐）；低置信弱命中留在 pending 等 Owner decide。
    const pending = this.#store.listCandidates({ status: "pending" });
    const batch = pending
      .filter((row) => row.confidence >= AUTO_CONSOLIDATE_MIN_CONFIDENCE)
      .map<ConsolidationCandidateView>((row) => ({
        candidateId: row.candidate_id,
        content: row.content,
        kind: row.kind,
        sensitivity: row.sensitivity,
        confidence: row.confidence,
        sourceId: row.source_id,
      }));
    const consolidation = batch.length > 0 ? this.#consolidateBatch(batch, extractedEnvelope.event_id) : null;
    return {
      extractedCount: candidateIds.length,
      skippedDuplicates,
      candidateIds,
      extractedEventId: extractedEnvelope.event_id,
      consolidation,
    };
  }

  /**
   * 手动巩固全部 pending 候选（crash 恢复 / Owner 补跑）；无 pending 候选返回 null
   * （不产生空的巩固运行事件）。
   */
  consolidatePending(limit = 50): ConsolidationRunSummary | null {
    const pending = this.#store.listCandidates({ status: "pending", limit });
    if (pending.length === 0) return null;
    const views = pending.map((row) => ({
      candidateId: row.candidate_id,
      content: row.content,
      kind: row.kind,
      sensitivity: row.sensitivity,
      confidence: row.confidence,
      sourceId: row.source_id,
    }));
    // 批的 causation = 各候选自己的来源事件；运行事件取首条（同批同轮的常规情形即来源事件）
    return this.#consolidateBatch(views, pending[0].source_event_id);
  }

  /**
   * Owner 候选决定（票面端点语义）：accept → 立即巩固该候选（绕过置信度准入线——
   * 显式采纳即授权）；dismiss → 状态置 dismissed。conflicted 候选不可 decide
   * （走冲突裁决端点）。
   */
  decideCandidate(candidateId: string, decision: "accept" | "dismiss"): { candidateId: string; decision: "accept" | "dismiss"; result: ConsolidationRunSummary | null } {
    const candidate = this.#store.getCandidate(candidateId);
    if (candidate === null) {
      throw new MemoryControlError("not_found", `candidate "${candidateId}" does not exist`);
    }
    if (candidate.status === "conflicted") {
      throw new MemoryControlError("invalid_state", `candidate "${candidateId}" has a pending conflict; resolve it via POST /v1/memory/conflicts/:id/resolve`);
    }
    if (candidate.status !== "pending") {
      throw new MemoryControlError("invalid_state", `candidate "${candidateId}" is ${candidate.status}; only pending candidates can be decided`);
    }
    if (decision === "dismiss") {
      this.#store.setCandidateStatus(candidateId, "dismissed");
      return { candidateId, decision, result: null };
    }
    const view: ConsolidationCandidateView = {
      candidateId: candidate.candidate_id,
      content: candidate.content,
      kind: candidate.kind,
      sensitivity: candidate.sensitivity,
      confidence: candidate.confidence,
      sourceId: candidate.source_id,
    };
    return { candidateId, decision, result: this.#consolidateBatch([view], candidate.source_event_id) };
  }

  listCandidates(filter: { status?: CandidateStatus; limit?: number; offset?: number } = {}): Array<MemoryCandidateRow & { source_event_id: string }> {
    return this.#store.listCandidates(filter);
  }

  listConflicts(filter: { status?: "open" | "resolved"; limit?: number; offset?: number } = {}): MemoryConflictRow[] {
    return this.#store.listConflicts(filter);
  }

  /**
   * 冲突裁决（FR-MEM-5 待确认队列的出口）：
   *   keep_new → 采纳候选值（版本+1 + 修订 reason=conflict_resolved + fact_updated）
   *   keep_old → 事实不动、候选 dismissed（只留 conflict_resolved——"不改"也是裁决）
   *   merge    → Owner 提供的合并文本进版本链（reason=conflict_merged；敏感性维持既有分级）
   */
  resolveConflict(conflictId: string, input: { resolution: ConflictResolution; content?: unknown }): {
    conflictId: string;
    factId: string;
    resolution: ConflictResolution;
    version: number;
    revisionId: string | null;
    factUpdatedEventId: string | null;
    conflictResolvedEventId: string;
  } {
    const conflict = this.#store.getConflict(conflictId);
    if (conflict === null) {
      throw new MemoryControlError("not_found", `conflict "${conflictId}" does not exist`);
    }
    if (conflict.status === "resolved") {
      throw new MemoryControlError("invalid_state", `conflict "${conflictId}" is already resolved (${conflict.resolution})`);
    }
    const resolution = input.resolution;
    if (resolution !== "keep_new" && resolution !== "keep_old" && resolution !== "merge") {
      throw new MemoryControlError("invalid_input", "resolution must be one of keep_new | keep_old | merge");
    }
    let resolvedContent: string | null = null;
    let factUpdate: { content: string; sensitivity: SensitivityLevel; reason: string; sourceId: string } | null = null;
    let candidateStatus: "consolidated" | "dismissed";
    if (resolution === "keep_new") {
      factUpdate = { content: conflict.incoming_content, sensitivity: conflict.incoming_sensitivity, reason: "conflict_resolved", sourceId: conflict.source_id };
      candidateStatus = "consolidated";
    } else if (resolution === "keep_old") {
      candidateStatus = "dismissed";
    } else {
      if (typeof input.content !== "string" || input.content.trim().length === 0) {
        throw new MemoryControlError("invalid_input", "merge resolution requires a non-empty `content` (the merged text)");
      }
      resolvedContent = input.content.trim();
      // 合并不改变既有事实的可见性分级——内容合入由 Owner 文本承载
      factUpdate = { content: resolvedContent, sensitivity: conflict.existing_sensitivity, reason: "conflict_merged", sourceId: conflict.source_id };
      candidateStatus = "consolidated";
    }
    const { fact, revision } = this.#store.resolveConflict({
      conflictId,
      resolution,
      resolvedContent,
      factUpdate,
      candidateStatus,
    });
    let factUpdatedEventId: string | null = null;
    if (factUpdate !== null) {
      const updatedEnvelope = buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType: MEMORY_EVENT_TYPES.factUpdated,
        payload: {
          fact_id: fact.fact_id,
          version: fact.version,
          content: fact.content,
          sensitivity: fact.sensitivity,
          revision_id: revision?.revision_id ?? null,
          reason: factUpdate.reason,
          conflict_id: conflictId,
          source_event_id: conflict.source_id,
        },
        causationId: conflict.source_id,
      });
      this.#ledger.append(updatedEnvelope);
      factUpdatedEventId = updatedEnvelope.event_id;
    }
    const resolvedEnvelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: MEMORY_EVENT_TYPES.conflictResolved,
      payload: {
        conflict_id: conflictId,
        resolution,
        fact_id: fact.fact_id,
        version: fact.version,
        revision_id: revision?.revision_id ?? null,
        ...(resolvedContent !== null ? { resolved_content: resolvedContent } : {}),
      },
      causationId: conflict.source_id,
    });
    this.#ledger.append(resolvedEnvelope);
    return {
      conflictId,
      factId: fact.fact_id,
      resolution,
      version: fact.version,
      revisionId: revision?.revision_id ?? null,
      factUpdatedEventId,
      conflictResolvedEventId: resolvedEnvelope.event_id,
    };
  }

  /**
   * 巩固执行：Consolidator 逐条决策（事实视图即时刷新，杜绝批内同主题重复建事实），
   * 每个动作 = 行事务 + 对应账本事件；最后落 memory.consolidated 运行事件。
   */
  #consolidateBatch(batch: ConsolidationCandidateView[], causationId: string): ConsolidationRunSummary {
    const createdFactIds: string[] = [];
    const updatedFactIds: string[] = [];
    const corroboratedFactIds: string[] = [];
    const conflictIds: string[] = [];
    for (const candidate of batch) {
      const facts: ConsolidationFactView[] = this.#store.listFacts().map((row) => ({
        factId: row.fact_id,
        content: row.content,
        kind: row.kind,
        sensitivity: row.sensitivity,
        version: row.version,
      }));
      const [action] = this.#consolidator.consolidate({ candidates: [candidate], facts });
      if (action === undefined) {
        throw new Error(`consolidator returned no action for candidate ${candidate.candidateId}`);
      }
      const sourceEventId = this.#sourceEventOf(candidate.sourceId);
      switch (action.action) {
        case "create_fact": {
          const fact = this.#store.createFact({
            content: action.content,
            kind: action.kind,
            sensitivity: action.sensitivity,
            candidateId: action.candidateId,
            sourceId: candidate.sourceId,
          });
          createdFactIds.push(fact.fact_id);
          this.#appendMemoryEvent(MEMORY_EVENT_TYPES.factCreated, {
            fact_id: fact.fact_id,
            content: fact.content,
            kind: fact.kind,
            sensitivity: fact.sensitivity,
            version: fact.version,
            candidate_id: action.candidateId,
            source_event_id: sourceEventId,
          }, sourceEventId);
          break;
        }
        case "update_fact": {
          const { fact, revision } = this.#store.updateFact({
            factId: action.factId,
            content: action.content,
            sensitivity: action.sensitivity,
            reason: action.reason,
            candidateId: action.candidateId,
            sourceId: candidate.sourceId,
          });
          updatedFactIds.push(fact.fact_id);
          this.#appendMemoryEvent(MEMORY_EVENT_TYPES.factUpdated, {
            fact_id: fact.fact_id,
            version: fact.version,
            content: fact.content,
            sensitivity: fact.sensitivity,
            revision_id: revision.revision_id,
            reason: action.reason,
            candidate_id: action.candidateId,
            source_event_id: sourceEventId,
          }, sourceEventId);
          break;
        }
        case "corroborate": {
          this.#store.corroborateFact({ factId: action.factId, candidateId: action.candidateId, sourceId: candidate.sourceId });
          corroboratedFactIds.push(action.factId);
          break;
        }
        case "escalate": {
          const conflict = this.#store.escalateConflict({
            candidateId: action.candidateId,
            factId: action.factId,
            reason: action.reason,
            existingContent: action.existingContent,
            incomingContent: action.incomingContent,
            existingSensitivity: this.#sensitivityOf(action.factId),
            incomingSensitivity: candidate.sensitivity,
            sourceId: candidate.sourceId,
          });
          conflictIds.push(conflict.conflict_id);
          this.#appendMemoryEvent(MEMORY_EVENT_TYPES.conflictDetected, {
            conflict_id: conflict.conflict_id,
            fact_id: conflict.fact_id,
            candidate_id: conflict.candidate_id,
            reason: conflict.reason,
            existing_content: conflict.existing_content,
            incoming_content: conflict.incoming_content,
          }, sourceEventId);
          break;
        }
      }
    }
    const summary: ConsolidationRunSummary = {
      candidateCount: batch.length,
      createdFactIds,
      updatedFactIds,
      corroboratedFactIds,
      conflictIds,
      consolidatedEventId: "",
    };
    const consolidatedEnvelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: MEMORY_EVENT_TYPES.consolidated,
      payload: {
        candidate_count: summary.candidateCount,
        created_fact_ids: createdFactIds,
        updated_fact_ids: updatedFactIds,
        corroborated_fact_ids: corroboratedFactIds,
        conflict_ids: conflictIds,
        candidate_ids: batch.map((c) => c.candidateId),
      },
      causationId,
    });
    this.#ledger.append(consolidatedEnvelope);
    summary.consolidatedEventId = consolidatedEnvelope.event_id;
    return summary;
  }

  #appendMemoryEvent(eventType: string, payload: Record<string, unknown>, causationId: string): void {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType,
      payload,
      causationId,
    });
    this.#ledger.append(envelope);
  }

  /** 来源 id → 账本事件 id（巩固事件 causation 的证据回链） */
  #sourceEventOf(sourceId: string): string {
    return this.#store.getSource(sourceId)?.event_id ?? sourceId;
  }

  #sensitivityOf(factId: string): SensitivityLevel {
    return this.#store.getFact(factId)?.sensitivity ?? "private";
  }

  #persist(input: {
    sessionId: string;
    sourceEventId: string;
    content: string;
    kind: MemoryEntryKind;
    confidence: number;
    sensitivity: SensitivityLevel;
    occurredAt: string;
    rule: string;
  }): MemoryWriteResult {
    const createInput: CreateCandidateInput = {
      content: input.content,
      kind: input.kind,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      occurredAt: input.occurredAt,
      source: { kind: "message", eventId: input.sourceEventId, sessionId: input.sessionId },
    };
    const { source, candidate } = this.#store.createCandidate(createInput);
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: MEMORY_EVENT_TYPES.candidateCreated,
      sessionId: input.sessionId,
      payload: {
        candidate_id: candidate.candidate_id,
        content: candidate.content,
        kind: candidate.kind,
        sensitivity: candidate.sensitivity,
        confidence: candidate.confidence,
        source_id: source.source_id,
        source_event_id: source.event_id,
        rule: input.rule,
      },
      causationId: source.event_id,
    });
    const { sequence } = this.#ledger.append(envelope);
    return { source, candidate, eventId: envelope.event_id, sequence };
  }
}
