import type { MemoryEntryKind, MemoryWriteInput, SensitivityLevel } from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { EPHEMERAL_SESSION_TTL_MS, SESSION_EVENT_TYPES } from "../sessions.ts";
import {
  type ConflictReason,
  type ConsolidationAction,
  type ConsolidationCandidateView,
  type ConsolidationFactView,
  DefaultConsolidator,
  normalizeForComparison,
  type MemoryConsolidator,
} from "./consolidator.ts";
import {
  type ExtractionInput,
  HeuristicExtractor,
  type MemoryExtractor,
} from "./extraction.ts";
import {
  MarkdownParseError,
  parseFactMarkdown,
  type MemoryProjector,
} from "./projection.ts";
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
 * 记忆服务（票 M1-T1 / Issue #13；抽取/巩固管线 M1-T2 / Issue #14；投影/受控导入/删除
 * 标记 M1-T3 / Issue #15）。
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
 *   memory.import_received    受控导入证据事件（T3 / Issue #15；人工编辑的来源回链目标）
 *   memory.fact_deleted       删除标记 tombstone（T3；软删 + 投影移除，M3 同步传播的单机前置）
 *   memory.promoted           提升为长期记忆（M7-A-T3：scope session:* → owner）
 *
 * 作用域（M7-A-T3 / ADR-0010）：普通会话写入 scope=owner；临时会话（session.created
 * payload.kind="ephemeral"）的写入（即时/工具/后台抽取）一律 scope=session:<id>，
 * 检索默认 owner（全局），会话上下文用 session:<id>（全局 + 本会话）。临时会话关闭
 * 24h 后由 sweepExpiredEphemeralScopes 逻辑清理（标记过期 + FTS/投影移除，账本保留）。
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
  importReceived: "memory.import_received",
  factDeleted: "memory.fact_deleted",
  promoted: "memory.promoted",
} as const;

/** memory.write 工具路径在事件 payload.rule 里的标注值 */
export const MEMORY_WRITE_RULE = "memory.write";

/** 受控导入（票 M1-T3）的 rule/reason 标注值：候选 payload.rule 与修订 reason 共用 */
export const MEMORY_IMPORT_RULE = "manual_import";

/**
 * 自动巩固准入线（票 M1-T2）：抽取产生的候选 confidence ≥ 此值时随抽取运行自动巩固；
 * 更低置信的候选（确定性启发式的弱命中）留 pending，等 Owner 经 decideCandidate 采纳。
 * 冲突上报不受此线影响（escalate 的候选必先进队列）。
 */
export const AUTO_CONSOLIDATE_MIN_CONFIDENCE = 0.8;

/**
 * 候选/冲突控制面错误（decideCandidate / resolveConflict / 列表参数 / 受控导入 / 删除）
 * → HTTP 400/404/409。stale_version 与 locked_confirm 都是 409：前者防覆盖（库内版本
 * 已领先 frontmatter），后者要求显式确认（locked 记忆删除需 Owner 确认）。
 */
export type MemoryControlErrorCode = "not_found" | "invalid_input" | "invalid_state" | "stale_version" | "locked_confirm";

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

/** 受控导入结果（票 M1-T3）：
 *   updated   版本化修订已落（revision_id + fact_updated 事件 id）
 *   conflict  编辑与 locked/敏感分级冲突，进待确认队列（conflict_id + reason），未直写
 *   unchanged 归一化内容与分级均未变，只留 memory.import_received 证据事件
 */
export interface MemoryImportResult {
  status: "updated" | "conflict" | "unchanged";
  fact_id: string;
  /** 操作后事实版本（conflict/unchanged = 库内原版本） */
  version: number;
  /** memory.import_received 证据事件 id（候选来源与修订 causation 的回链目标） */
  import_event_id: string;
  /** status=updated：MemoryRevision id */
  revision_id?: string;
  /** status=updated：memory.fact_updated 事件 id */
  event_id?: string;
  /** status=conflict：待确认冲突 id 与原因 */
  conflict_id?: string;
  reason?: ConflictReason;
}

/** 删除标记结果（memory.fact_deleted tombstone 的同构投影） */
export interface MemoryDeleteResult {
  deleted: true;
  fact_id: string;
  /** 删除时事实版本（tombstone payload 同值） */
  version: number;
  deleted_at: string;
  /** memory.fact_deleted 事件 id */
  event_id: string;
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
  /** 投影器（票 M1-T3，可选）：导入修订后单事实刷新、删除后投影文件移除由服务回调，
   *  保证导入/删除与投影目录一致；缺省（单元测试）时跳过文件操作。 */
  readonly #projector: MemoryProjector | null;
  /** 删除事件观察者（票 M3-T3）：删除 tombstone 落账后通知同步层维护删除集合。 */
  readonly #onFactDeleted: ((envelope: ReturnType<typeof buildEventEnvelope>) => void) | null;
  /** 时钟注入（票 M7-A-T3：临时会话 24h 到期测试零 sleep）；缺省系统时间 */
  readonly #now: () => Date;
  /** 临时会话关闭后的保留窗口（毫秒，默认 24h；与 SessionManager 同口径） */
  readonly #ephemeralTtlMs: number;

  constructor(deps: {
    store: MemoryStore;
    ledger: EventLedger;
    replicaId: string;
    /** 抽取器注入 seam（票 M1-T2）；缺省 = 确定性启发式（HeuristicExtractor） */
    extractor?: MemoryExtractor;
    /** 巩固器注入 seam（票 M1-T2）；缺省 = 确定性决策矩阵（DefaultConsolidator） */
    consolidator?: MemoryConsolidator;
    /** 投影器注入 seam（票 M1-T3）；缺省 = 不维护投影文件（全量投影经 MemoryProjector 命令） */
    projector?: MemoryProjector;
    /** 删除事件观察者（票 M3-T3）：runtime 注入 TombstoneStore.recordFactDeletion。 */
    onFactDeleted?: (envelope: ReturnType<typeof buildEventEnvelope>) => void;
    /** 时钟注入（票 M7-A-T3：24h 到期判定/清理时间戳）；缺省系统时间 */
    now?: () => Date;
    /** 临时会话保留窗口（毫秒，默认 24h） */
    ephemeralTtlMs?: number;
  }) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#replicaId = deps.replicaId;
    this.#extractor = deps.extractor ?? new HeuristicExtractor();
    this.#consolidator = deps.consolidator ?? new DefaultConsolidator();
    this.#projector = deps.projector ?? null;
    this.#onFactDeleted = deps.onFactDeleted ?? null;
    this.#now = deps.now ?? (() => new Date());
    this.#ephemeralTtlMs = deps.ephemeralTtlMs ?? EPHEMERAL_SESSION_TTL_MS;
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

  /** FTS5 关键词检索（MemoryStore 透传；命中含来源回链）。options 在检索层过滤。
   *  scope（票 M7-A-T3）：缺省 owner 只查全局；session:<id> 查全局 + 该会话。
   *  检索前先做一次临时会话到期清理，保证读到的是清理后的检索面（零定时器依赖）。 */
  search(q: string, options: { sensitivity?: SensitivityLevel; scope?: string } = {}): MemorySearchHit[] {
    this.sweepExpiredEphemeralScopes();
    return this.#store.search(q, options);
  }

  /**
   * 临时会话 24h 到期的逻辑清理（票 M7-A-T3 / ADR-0010）：
   * 关闭（session.closed）且无后续 session.restored、距 closed_at 已满保留窗口的会话，
   * 其 session:<id> 作用域的候选与事实标记 expired_at 并移出 FTS；投影文件同步移除。
   * 账本事件不删不改（append-only），到期状态可由 close/restore 事件重新导出。
   * 返回本次新清理的会话 id（供测试/运维观察；幂等：已清理的不会重复返回）。
   */
  sweepExpiredEphemeralScopes(): string[] {
    const nowMs = this.#now().getTime();
    // 折叠会话关闭状态：close 记 closed_at，restore 清除（与 SessionManager 同口径）
    const closedAt = new Map<string, string>();
    for (const { envelope } of this.#ledger.scan()) {
      const sessionId = envelope.session_id;
      if (sessionId === undefined || sessionId === null) continue;
      if (envelope.event_type === SESSION_EVENT_TYPES.sessionEphemeralClosed) {
        const at = typeof envelope.payload.closed_at === "string" ? envelope.payload.closed_at : envelope.occurred_at;
        closedAt.set(sessionId, at);
      } else if (envelope.event_type === SESSION_EVENT_TYPES.sessionEphemeralRestored) {
        closedAt.delete(sessionId);
      }
    }
    const swept: string[] = [];
    for (const [sessionId, at] of closedAt) {
      const expiresAt = Date.parse(at) + this.#ephemeralTtlMs;
      if (!Number.isFinite(expiresAt) || nowMs < expiresAt) continue;
      const scope = `session:${sessionId}`;
      const { candidateIds, factIds } = this.#store.expireScope(scope, new Date(nowMs).toISOString());
      if (candidateIds.length === 0 && factIds.length === 0) continue;
      for (const factId of factIds) this.#projector?.removeFact(factId);
      swept.push(sessionId);
    }
    return swept;
  }

  /**
   * 提升为长期记忆（票 M7-A-T3，ADR-0010）：候选或事实的 scope 由 session:<id> 改为
   * owner，并写 memory.promoted（payload 含原 scope）。非 session 作用域 → 409
   * （invalid_state）；未知 id → 404。事实提升后补写 §6.4 投影文件（候选在巩固后
   * 按 owner 落投影）。
   */
  promoteMemory(entryId: string): {
    id: string;
    entry_kind: "candidate" | "fact";
    from_scope: string;
    to_scope: "owner";
    event_id: string;
  } {
    const candidate = this.#store.getCandidate(entryId);
    const fact = candidate === null ? this.#store.getFact(entryId) : null;
    const row = candidate ?? fact;
    if (row === null) {
      throw new MemoryControlError("not_found", `memory entry "${entryId}" does not exist`);
    }
    const stage: "candidate" | "fact" = candidate !== null ? "candidate" : "fact";
    const fromScope = row.scope;
    if (!fromScope.startsWith("session:")) {
      throw new MemoryControlError(
        "invalid_state",
        `memory entry "${entryId}" is in scope "${fromScope}"; only session-scoped entries can be promoted`,
      );
    }
    if (row.expired_at !== null) {
      throw new MemoryControlError("invalid_state", `memory entry "${entryId}" has expired and cannot be promoted`);
    }
    const promoted = this.#store.promoteToOwner(entryId);
    if (promoted === null) {
      throw new MemoryControlError("not_found", `memory entry "${entryId}" does not exist`);
    }
    if (stage === "fact") this.#projector?.writeFact(entryId);
    const sessionId = fromScope.slice("session:".length);
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "owner",
      eventType: MEMORY_EVENT_TYPES.promoted,
      sessionId,
      payload: {
        entry_id: entryId,
        entry_kind: stage,
        from_scope: fromScope,
        to_scope: "owner",
      },
    });
    this.#ledger.append(envelope);
    return { id: entryId, entry_kind: stage, from_scope: fromScope, to_scope: "owner", event_id: envelope.event_id };
  }

  /** 会话最新一条 message.user 账本事件（工具写入的来源回链目标） */
  latestUserEvent(sessionId: string): { event_id: string; occurred_at: string } | null {
    const entries = this.#ledger.scan({ sessionId, eventType: SESSION_EVENT_TYPES.messageUser });
    const last = entries.at(-1);
    if (last === undefined) return null;
    return { event_id: last.envelope.event_id, occurred_at: last.envelope.occurred_at };
  }

  // --- Markdown 投影 / 受控导入 / 删除标记（票 M1-T3 / Issue #15）-----------------

  /**
   * 受控导入（FR-MEM-6）：人工编辑的 §6.4 Markdown 全文（投影文件原样回贴）转为版本化
   * 修订，不绕过冲突检测。body 形态取「编辑后的 Markdown 全文」（{markdown} 包裹）——
   * 一次携带全部 frontmatter（id/version/sensitivity），与投影文件互为往返；结构化
   * {fact_id, content} 形态会绕过 §6.4 解析与 frontmatter 版本对账，不做。
   *
   * 流程（先证据事件，后行，行后动作事件——来源回链目标必须已在账本）：
   *   1. 解析 frontmatter + 正文 → id 定位事实（不存在/已删 404）；version 与库内不一致
   *      → stale_version 409（防覆盖：编辑基于旧投影时拒绝，要求重投影后再改）；
   *   2. memory.import_received 证据事件入账；
   *   3. 内容与分级均未变 → unchanged（只留证据事件，不写候选不推进版本）；
   *   4. 变更 = 一次显式写入：来源（import 事件）+ 候选（confidence 1，人工编辑即
   *      Owner 授权）+ candidate_created 事件；
   *   5. 与 T2 巩固同一冲突口径（按序判定）：locked 且有任何变更 → escalate "locked"；
   *      分级不同 → escalate "sensitivity_change"（纯分级变更也算——可见性不静默改，
   *      比 T2 更严：T2 只在内容不同时比分级，这里编辑显式写了分级就照单对账）；
   *      其余 → 版本+1 + MemoryRevision（reason=manual_import）+ fact_updated 事件
   *      + 投影单事实刷新。
   *
   * frontmatter 其余字段（type/confidence/valid_from/valid_until/sources/created_at/
   * updated_at）为投影只读面：type 在 v1 不可变（不一致忽略，kind 恒取库内），confidence
   * 是候选属性，sources/时间戳是审计事实——一律以库内为准，不因导入改写。
   */
  importMarkdown(markdown: string): MemoryImportResult {
    let parsed: { fields: Record<string, string>; body: string };
    try {
      parsed = parseFactMarkdown(markdown);
    } catch (err) {
      if (err instanceof MarkdownParseError) {
        throw new MemoryControlError("invalid_input", `malformed memory markdown: ${err.message}`);
      }
      throw err;
    }
    const id = parsed.fields.id?.trim();
    if (id === undefined || id.length === 0) {
      throw new MemoryControlError("invalid_input", "frontmatter `id` is required for import");
    }
    const versionRaw = parsed.fields.version;
    if (versionRaw === undefined || !/^\d+$/.test(versionRaw) || Number(versionRaw) < 1) {
      throw new MemoryControlError("invalid_input", "frontmatter `version` must be a positive integer");
    }
    const baseVersion = Number(versionRaw);
    const fact = this.#store.getFact(id);
    if (fact === null || fact.deleted_at !== null) {
      throw new MemoryControlError("not_found", `fact "${id}" does not exist`);
    }
    if (fact.version !== baseVersion) {
      throw new MemoryControlError(
        "stale_version",
        `frontmatter version ${baseVersion} does not match current fact version ${fact.version}; re-project and edit the current version`,
      );
    }
    const newContent = parsed.body.trim();
    if (newContent.length === 0) {
      throw new MemoryControlError("invalid_input", "markdown body (the memory content) must be non-empty");
    }
    const sensitivityRaw = parsed.fields.sensitivity;
    if (sensitivityRaw !== undefined && !SENSITIVITY_LEVELS.includes(sensitivityRaw as SensitivityLevel)) {
      throw new MemoryControlError("invalid_input", `unknown sensitivity: ${sensitivityRaw}`);
    }
    const newSensitivity = (sensitivityRaw as SensitivityLevel | undefined) ?? fact.sensitivity;

    const contentEqual = normalizeForComparison(newContent) === normalizeForComparison(fact.content);
    const sensitivityEqual = newSensitivity === fact.sensitivity;

    // 导入证据事件先行：候选来源与修订 causation 都回链到它（人工编辑也是证据）
    const importEnvelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: MEMORY_EVENT_TYPES.importReceived,
      payload: {
        fact_id: fact.fact_id,
        base_version: baseVersion,
        content: newContent,
        sensitivity: newSensitivity,
      },
    });
    this.#ledger.append(importEnvelope);

    if (contentEqual && sensitivityEqual) {
      return { status: "unchanged", fact_id: fact.fact_id, version: fact.version, import_event_id: importEnvelope.event_id };
    }

    // 编辑 = 一次显式记忆写入（候选先落行，candidate_created 随后；来源 = import 事件）
    const { candidate } = this.#persist({
      sessionId: null,
      sourceEventId: importEnvelope.event_id,
      content: newContent,
      // type 在 v1 不可变：frontmatter type 与库内不一致时忽略，恒按库内 kind
      kind: fact.kind,
      confidence: 1,
      sensitivity: newSensitivity,
      occurredAt: importEnvelope.occurred_at,
      rule: MEMORY_IMPORT_RULE,
      sourceKind: "import",
    });

    // 与 T2 巩固同一冲突口径（按序判定），escalate 后绝不直写
    let reason: ConflictReason | null = null;
    if (fact.sensitivity === "locked") {
      reason = "locked"; // GLOSSARY：locked 禁止一切自动改写，任何变更（内容或分级）都经 Owner 确认
    } else if (!sensitivityEqual) {
      reason = "sensitivity_change"; // 可见性分级升级与放宽都不静默变更
    }
    if (reason !== null) {
      const conflict = this.#store.escalateConflict({
        candidateId: candidate.candidate_id,
        factId: fact.fact_id,
        reason,
        existingContent: fact.content,
        incomingContent: newContent,
        existingSensitivity: fact.sensitivity,
        incomingSensitivity: newSensitivity,
        sourceId: candidate.source_id,
      });
      this.#appendMemoryEvent(MEMORY_EVENT_TYPES.conflictDetected, {
        conflict_id: conflict.conflict_id,
        fact_id: conflict.fact_id,
        candidate_id: conflict.candidate_id,
        reason: conflict.reason,
        existing_content: conflict.existing_content,
        incoming_content: conflict.incoming_content,
        source_event_id: importEnvelope.event_id,
      }, importEnvelope.event_id);
      return {
        status: "conflict",
        fact_id: fact.fact_id,
        version: fact.version,
        conflict_id: conflict.conflict_id,
        reason,
        import_event_id: importEnvelope.event_id,
      };
    }

    // 无冲突：版本化修订（版本+1 + MemoryRevision + FTS 刷新 + 来源多对多）
    const { fact: updated, revision } = this.#store.updateFact({
      factId: fact.fact_id,
      content: newContent,
      sensitivity: newSensitivity,
      reason: MEMORY_IMPORT_RULE,
      candidateId: candidate.candidate_id,
      sourceId: candidate.source_id,
    });
    const updatedEnvelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: MEMORY_EVENT_TYPES.factUpdated,
      payload: {
        fact_id: updated.fact_id,
        version: updated.version,
        content: updated.content,
        sensitivity: updated.sensitivity,
        revision_id: revision.revision_id,
        reason: MEMORY_IMPORT_RULE,
        candidate_id: candidate.candidate_id,
        source_event_id: importEnvelope.event_id,
      },
      causationId: importEnvelope.event_id,
    });
    this.#ledger.append(updatedEnvelope);
    // 投影单事实刷新：文件跟随版本链头部（幂等——下次全量投影字节不变）
    this.#projector?.writeFact(updated.fact_id);
    return {
      status: "updated",
      fact_id: updated.fact_id,
      version: updated.version,
      import_event_id: importEnvelope.event_id,
      revision_id: revision.revision_id,
      event_id: updatedEnvelope.event_id,
    };
  }

  /**
   * 删除标记（FR-MEM-8 的 M1 单机前置）：软删——facts 行标记 deleted_at（不物理删，
   * 行/修订/来源多对多保留作回链审计）+ FTS 索引移除（检索面立即退出）+
   * memory.fact_deleted tombstone 事件入账本（M3 同步传播的证据，payload 带事实终态）
   * + 投影文件移除；重投影只认现存事实，不复活已删记忆。
   *
   * locked 记忆删除需确认：默认拒绝（409 locked_confirm，提示带 confirm 参数重试），
   * 显式 `?confirm=true`（HTTP 层）放行——locked 的语义是「变更必须经 Owner 确认」，
   * 删除是不可逆变更，宁可多问一次。
   */
  deleteFact(factId: string, options: { confirm?: boolean } = {}): MemoryDeleteResult {
    const fact = this.#store.getFact(factId);
    if (fact === null || fact.deleted_at !== null) {
      throw new MemoryControlError("not_found", `fact "${factId}" does not exist`);
    }
    if (fact.sensitivity === "locked" && options.confirm !== true) {
      throw new MemoryControlError(
        "locked_confirm",
        `fact "${factId}" is locked; locked memories require explicit confirmation to delete — retry with ?confirm=true`,
      );
    }
    const { fact: deleted, deleted_at } = this.#store.deleteFact(factId);
    // tombstone causation 指向事实最近一次来源事件（回链审计；无来源时为 null）
    const sourceEventIds = this.#store.factSourceEventIds(factId);
    const tombstone = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: MEMORY_EVENT_TYPES.factDeleted,
      payload: {
        fact_id: deleted.fact_id,
        version: deleted.version,
        content: deleted.content,
        sensitivity: deleted.sensitivity,
        deleted_at,
      },
      causationId: sourceEventIds.at(-1) ?? null,
    });
    this.#ledger.append(tombstone);
    // 通知同步层：该事实进入删除集合（离线副本的旧修订不得复活）
    this.#onFactDeleted?.(tombstone);
    this.#projector?.removeFact(factId);
    return { deleted: true, fact_id: deleted.fact_id, version: deleted.version, deleted_at, event_id: tombstone.event_id };
  }

  /** 现存有效事实（读投影；M3-T3 同步语义与测试的自检面） */
  listFacts(): ReturnType<MemoryStore["listFacts"]> {
    return this.#store.listFacts();
  }

  /** 单事实（含已删标记；同步合并/测试用） */
  getFact(factId: string): ReturnType<MemoryStore["getFact"]> {
    return this.#store.getFact(factId);
  }

  /** 单事实版本历史（三方合并基线查找；同步语义用） */
  listRevisions(factId: string): ReturnType<MemoryStore["listRevisions"]> {
    return this.#store.listRevisions(factId);
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
        scope: row.scope,
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
      scope: row.scope,
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
    if (candidate.expired_at !== null) {
      throw new MemoryControlError("invalid_state", `candidate "${candidateId}" has expired (ephemeral session retention window ended)`);
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
      scope: candidate.scope,
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
      // 同作用域匹配（票 M7-A-T3）：临时会话候选只与同会话事实比对，绝不改写/冲突
      // 到 owner 长期事实；owner 候选也只与 owner 事实比对。
      const scope = candidate.scope ?? "owner";
      const facts: ConsolidationFactView[] = this.#store.listFacts({ scope }).map((row) => ({
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
            scope: fact.scope,
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
    /** 会话 id；受控导入（票 M1-T3）无会话上下文，传 null（信封不带 session_id） */
    sessionId: string | null;
    sourceEventId: string;
    content: string;
    kind: MemoryEntryKind;
    confidence: number;
    sensitivity: SensitivityLevel;
    occurredAt: string;
    rule: string;
    /** 来源证据形态；缺省 "message"（对话路径），受控导入传 "import" */
    sourceKind?: string;
  }): MemoryWriteResult {
    // 作用域（票 M7-A-T3）：由会话 kind 推导——临时会话的即时/工具/抽取写入一律
    // 落在 session:<id>，避免随手一问污染长期画像；导入（无会话）恒 owner。
    const scope = this.#scopeForSession(input.sessionId);
    const createInput: CreateCandidateInput = {
      content: input.content,
      kind: input.kind,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      occurredAt: input.occurredAt,
      scope,
      source: { kind: input.sourceKind ?? "message", eventId: input.sourceEventId, sessionId: input.sessionId },
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
        scope: candidate.scope,
        source_id: source.source_id,
        source_event_id: source.event_id,
        rule: input.rule,
      },
      causationId: source.event_id,
    });
    const { sequence } = this.#ledger.append(envelope);
    return { source, candidate, eventId: envelope.event_id, sequence };
  }

  /**
   * 会话 → 记忆作用域（票 M7-A-T3）：session.created payload.kind="ephemeral" 时
   * 返回 session:<id>，其余（含未知/导入）返回 owner。读账本而非会话缓存——作用域
   * 语义不依赖进程内会话状态，重启后同口径。
   */
  #scopeForSession(sessionId: string | null): string {
    if (sessionId === null) return "owner";
    for (const { envelope } of this.#ledger.scan({ sessionId })) {
      if (envelope.event_type === SESSION_EVENT_TYPES.sessionCreated) {
        return envelope.payload.kind === "ephemeral" ? `session:${sessionId}` : "owner";
      }
    }
    return "owner";
  }
}
