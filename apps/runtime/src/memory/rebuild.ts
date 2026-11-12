import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import type { EventLedger, LedgerEntry } from "../ledger.ts";
import type {
  MemoryFactRow,
  MemoryProjectionSnapshot,
  MemoryRevisionRow,
  MemorySourceRow,
  MemoryStore,
} from "./store.ts";

/**
 * 记忆投影重建（票 M3-T3 / Issue #32，PRD §4.2 FR-DEP-5 / §4.1 FR-MEM-8）。
 *
 * 记忆可见状态是**事件账本的派生投影**：facts / revisions / 来源关系 / 事实 FTS 都可以
 * 从 memory.* 事件按账本 sequence 重放。跨副本同步只传事件（T1 口径），所以新副本在
 * 收到记忆事件之后必须重建投影，否则 GET /v1/memory/facts 会看到与账本不一致的空表。
 *
 * 重放口径（与 MemoryService 的写路径一一对应）：
 *   memory.candidate_created  记录来源行与 candidate→source 映射（后续事实回链用）
 *   memory.fact_created       事实 v1（payload 缺时间戳时用事件 occurred_at）
 *   memory.fact_updated       事实版本链推进 + MemoryRevision（同版本后到者覆盖，
 *                             版本严格更大者推进）
 *   memory.fact_deleted       删除是终态：之后同 fact 的任何事实事件不再重放（不复活）
 *   sync.conflict             其 remote_event_ids 里的事件是「已判定冲突、未采纳」的远端
 *                             修订——重放时跳过，保证待审核期间记忆视图仍是本地值
 *
 * 取舍：启动时不做无条件全量重建（O(账本) 且每次启动都重置 FTS）；运行时在同步导入
 * 批次末尾重建（只在小批量事件后发生），并提供 checkMemoryProjectionConsistency 供
 * 运维/测试显式校验。新副本首次启动若发现「账本有事实事件但事实表为空」会触发一次
 * 重建（见 runtime.ts 接线）。
 */

const MEMORY_KINDS: readonly MemoryEntryKind[] = ["fact", "preference", "profile", "procedural"];
const SENSITIVITY_LEVELS: readonly SensitivityLevel[] = ["public", "private", "locked"];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asVersion(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function asKind(value: unknown): MemoryEntryKind {
  return MEMORY_KINDS.includes(value as MemoryEntryKind) ? (value as MemoryEntryKind) : "fact";
}

function asSensitivity(value: unknown): SensitivityLevel {
  return SENSITIVITY_LEVELS.includes(value as SensitivityLevel) ? (value as SensitivityLevel) : "private";
}

export interface ReplayState {
  facts: Map<string, MemoryFactRow>;
  revisions: Map<string, MemoryRevisionRow>;
  sources: Map<string, MemorySourceRow>;
  /** candidate_id → source_id（fact 事件只带 candidate_id 时回链来源） */
  candidateSources: Map<string, string>;
  factSources: Map<string, { fact_id: string; source_id: string }>;
  deleted: Set<string>;
  conflictedEvents: Set<string>;
  ignored: number;
}

/** 收集 sync.conflict 明确判定为「不采纳」的远端事件 id（重放时跳过） */
function collectConflictedEvents(entries: LedgerEntry[], localReplicaId: string | undefined): Set<string> {
  // 事件作者表：冲突记录里的 id 可能是「对端冲突事件把本机原创修订记为 remote」的情形
  // （两端同时竞争时双方各写一条 sync.conflict，互为 remote）。重放的可见值必须按
  // **事件作者归属**过滤——本副本创作的修订永远不被对端冲突记录压下去（AC-05 修复）。
  const authorOf = new Map<string, string>();
  for (const entry of entries) authorOf.set(entry.envelope.event_id, entry.envelope.replica_id);

  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) return;
    if (localReplicaId !== undefined && authorOf.get(value) === localReplicaId) return;
    ids.add(value);
  };
  for (const entry of entries) {
    if (entry.envelope.event_type !== "sync.conflict") continue;
    const payload = entry.envelope.payload;
    for (const key of ["remote_event_id", "incoming_event_id"]) add(payload[key]);
    const list = payload.remote_event_ids;
    if (Array.isArray(list)) {
      for (const value of list) add(value);
    }
  }
  return ids;
}

function resolveSourceId(state: ReplayState, payload: Record<string, unknown>): string | null {
  const sourceId = asString(payload.source_id);
  if (sourceId !== null && state.sources.has(sourceId)) return sourceId;
  const candidateId = asString(payload.candidate_id);
  if (candidateId !== null) {
    const mapped = state.candidateSources.get(candidateId);
    if (mapped !== undefined && state.sources.has(mapped)) return mapped;
  }
  const eventId = asString(payload.source_event_id);
  if (eventId !== null) {
    for (const source of state.sources.values()) {
      if (source.event_id === eventId) return source.source_id;
    }
  }
  return null;
}

function linkSource(state: ReplayState, factId: string, sourceId: string | null): void {
  if (sourceId === null || !state.sources.has(sourceId)) return;
  state.factSources.set(`${factId}\u0000${sourceId}`, { fact_id: factId, source_id: sourceId });
}

export interface MemoryReplayOptions {
  /**
   * 本副本 replica_id（AC-05 修复）：sync.conflict 只压制**非本副本**创作的修订。
   * 缺省 undefined = 旧行为（不按作者归属过滤，供离线纯重放/兼容测试）。
   */
  localReplicaId?: string;
}

/** 纯重放：不触库，便于单测与一致性校验 */
export function replayMemoryEvents(entries: LedgerEntry[], options: MemoryReplayOptions = {}): ReplayState {
  const state: ReplayState = {
    facts: new Map(),
    revisions: new Map(),
    sources: new Map(),
    candidateSources: new Map(),
    factSources: new Map(),
    deleted: new Set(),
    conflictedEvents: collectConflictedEvents(entries, options.localReplicaId),
    ignored: 0,
  };

  for (const entry of entries) {
    const envelope = entry.envelope;
    if (!envelope.event_type.startsWith("memory.")) continue;
    const payload = envelope.payload;
    const occurredAt = envelope.occurred_at;

    switch (envelope.event_type) {
      case "memory.candidate_created": {
        const sourceId = asString(payload.source_id);
        const sourceEventId = asString(payload.source_event_id);
        if (sourceId === null || sourceEventId === null) break;
        if (!state.sources.has(sourceId)) {
          state.sources.set(sourceId, {
            source_id: sourceId,
            kind: "memory",
            event_id: sourceEventId,
            session_id: typeof envelope.session_id === "string" ? envelope.session_id : null,
            created_at: occurredAt,
          });
        }
        const candidateId = asString(payload.candidate_id);
        if (candidateId !== null) state.candidateSources.set(candidateId, sourceId);
        break;
      }
      case "memory.fact_created": {
        if (state.conflictedEvents.has(envelope.event_id)) break;
        const factId = asString(payload.fact_id);
        if (factId === null) break;
        if (state.deleted.has(factId)) break;
        const version = asVersion(payload.version, 1);
        const existing = state.facts.get(factId);
        if (existing !== undefined && existing.version > version) break;
        const fact: MemoryFactRow = {
          fact_id: factId,
          content: asString(payload.content) ?? "",
          kind: asKind(payload.kind),
          sensitivity: asSensitivity(payload.sensitivity),
          version,
          valid_from: asString(payload.valid_from) ?? occurredAt,
          valid_until: asString(payload.valid_until),
          created_at: asString(payload.created_at) ?? occurredAt,
          updated_at: occurredAt,
          deleted_at: null,
          // 票 M7-A-T3：事实作用域由事件携带（缺省 owner；临时会话事实 session:<id>）
          scope: asString(payload.scope) ?? "owner",
          expired_at: null,
        };
        state.facts.set(factId, fact);
        linkSource(state, factId, resolveSourceId(state, payload));
        break;
      }
      case "memory.fact_updated": {
        if (state.conflictedEvents.has(envelope.event_id)) break;
        const factId = asString(payload.fact_id);
        if (factId === null) break;
        if (state.deleted.has(factId)) break;
        const version = asVersion(payload.version, 1);
        const existing = state.facts.get(factId);
        if (existing !== undefined && version < existing.version) break;
        const fact: MemoryFactRow = {
          fact_id: factId,
          content: asString(payload.content) ?? existing?.content ?? "",
          kind: asKind(payload.kind ?? existing?.kind),
          sensitivity: asSensitivity(payload.sensitivity ?? existing?.sensitivity),
          version,
          valid_from: asString(payload.valid_from) ?? existing?.valid_from ?? occurredAt,
          valid_until: asString(payload.valid_until) ?? existing?.valid_until ?? null,
          created_at: existing?.created_at ?? asString(payload.created_at) ?? occurredAt,
          updated_at: occurredAt,
          deleted_at: null,
          // 更新不改变作用域（提升单独走 memory.promoted）
          scope: existing?.scope ?? "owner",
          expired_at: null,
        };
        state.facts.set(factId, fact);
        const sourceId = resolveSourceId(state, payload);
        linkSource(state, factId, sourceId);
        const revisionId = asString(payload.revision_id) ?? `replayed:${envelope.event_id}`;
        state.revisions.set(revisionId, {
          revision_id: revisionId,
          fact_id: factId,
          version,
          content: fact.content,
          sensitivity: fact.sensitivity,
          reason: asString(payload.reason),
          source_id: sourceId,
          created_at: occurredAt,
        });
        break;
      }
      case "memory.fact_deleted": {
        const factId = asString(payload.fact_id);
        if (factId === null) break;
        const deletedAt = asString(payload.deleted_at) ?? occurredAt;
        const version = asVersion(payload.version, state.facts.get(factId)?.version ?? 1);
        const existing = state.facts.get(factId);
        // 删除是终态：删除事件本身携带事实终态，用来补齐缺失的 fact_created（如事件被
        // tombstone 跳过的新副本）。payload 无 kind，缺省 fact。
        const fact: MemoryFactRow = {
          fact_id: factId,
          content: asString(payload.content) ?? existing?.content ?? "",
          kind: asKind(payload.kind ?? existing?.kind),
          sensitivity: asSensitivity(payload.sensitivity ?? existing?.sensitivity),
          version: version >= (existing?.version ?? 1) ? version : (existing?.version ?? version),
          valid_from: existing?.valid_from ?? deletedAt,
          valid_until: existing?.valid_until ?? null,
          created_at: existing?.created_at ?? deletedAt,
          updated_at: deletedAt,
          deleted_at: deletedAt,
          scope: existing?.scope ?? "owner",
          expired_at: existing?.expired_at ?? null,
        };
        state.facts.set(factId, fact);
        state.deleted.add(factId);
        break;
      }
      case "memory.promoted": {
        // 票 M7-A-T3：「提升为长期记忆」的作用域迁移必须可重放，否则重建会把已提升
        // 事实打回 session 作用域。payload 记录 entry_kind/entry_id/from_scope。
        if (asString(payload.entry_kind) !== "fact") break;
        const entryId = asString(payload.entry_id);
        if (entryId === null) break;
        const existing = state.facts.get(entryId);
        if (existing !== undefined) existing.scope = "owner";
        break;
      }
      default:
        break;
    }
  }
  return state;
}

/** 纯重放结果 → MemoryStore 可落库的快照（只保留来源/事实/修订的稳定顺序） */
export function snapshotFromReplay(state: ReplayState): MemoryProjectionSnapshot {
  const facts = [...state.facts.values()].sort(compareFactRows);
  const revisions = [...state.revisions.values()].sort(
    (a, b) => a.fact_id.localeCompare(b.fact_id) || a.version - b.version || a.revision_id.localeCompare(b.revision_id),
  );
  const sources = [...state.sources.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.source_id.localeCompare(b.source_id));
  const factSources = [...state.factSources.values()]
    .filter((link) => state.facts.has(link.fact_id) && state.sources.has(link.source_id))
    .sort((a, b) => a.fact_id.localeCompare(b.fact_id) || a.source_id.localeCompare(b.source_id));
  return { facts, revisions, sources, factSources };
}

function compareFactRows(a: MemoryFactRow, b: MemoryFactRow): number {
  return a.created_at.localeCompare(b.created_at) || a.fact_id.localeCompare(b.fact_id);
}

export interface RebuildResult {
  facts: number;
  revisions: number;
  sources: number;
  factSources: number;
  /** sync.conflict 判定不采纳、重放时跳过的远端事件数 */
  conflictedEvents: number;
}

/** 从账本按序重放 memory.* 事件并整体替换记忆投影（facts / revisions / FTS） */
export function rebuildMemoryProjection(deps: {
  store: MemoryStore;
  ledger: EventLedger;
  replicaId?: string;
}): RebuildResult {
  const state = replayMemoryEvents(deps.ledger.scan(), { localReplicaId: deps.replicaId });
  const snapshot = snapshotFromReplay(state);
  deps.store.replaceMemoryProjection(snapshot);
  return {
    facts: snapshot.facts.length,
    revisions: snapshot.revisions.length,
    sources: snapshot.sources.length,
    factSources: snapshot.factSources.length,
    conflictedEvents: state.conflictedEvents.size,
  };
}

/** 投影重建器（runtime 内的可复用句柄；无资源需要关闭） */
export class MemoryProjectionRebuilder {
  readonly #store: MemoryStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string | undefined;
  #lastResult: RebuildResult | null = null;

  constructor(deps: { store: MemoryStore; ledger: EventLedger; replicaId?: string }) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#replicaId = deps.replicaId;
  }

  get lastResult(): RebuildResult | null {
    return this.#lastResult;
  }

  rebuild(): RebuildResult {
    const result = rebuildMemoryProjection({
      store: this.#store,
      ledger: this.#ledger,
      ...(this.#replicaId === undefined ? {} : { replicaId: this.#replicaId }),
    });
    this.#lastResult = result;
    return result;
  }

  check(): ConsistencyReport {
    return checkMemoryProjectionConsistency({
      store: this.#store,
      ledger: this.#ledger,
      ...(this.#replicaId === undefined ? {} : { replicaId: this.#replicaId }),
    });
  }
}

export interface ConsistencyReport {
  ok: boolean;
  facts: { missing: string[]; extra: string[]; mismatched: Array<{ fact_id: string; fields: string[] }> };
  revisions: { missing: string[]; extra: string[]; mismatched: Array<{ revision_id: string; fields: string[] }> };
}

/** 投影 vs 事件重放快照的一致性校验（只读；不做修复） */
export function checkMemoryProjectionConsistency(deps: {
  store: MemoryStore;
  ledger: EventLedger;
  replicaId?: string;
}): ConsistencyReport {
  const snapshot = snapshotFromReplay(
    replayMemoryEvents(deps.ledger.scan(), { localReplicaId: deps.replicaId }),
  );
  const expectedFacts = new Map(snapshot.facts.map((fact) => [fact.fact_id, fact]));
  const actualFacts = new Map(deps.store.listAllFacts().map((fact) => [fact.fact_id, fact]));
  const factMismatch: ConsistencyReport["facts"] = { missing: [], extra: [], mismatched: [] };
  for (const [factId, expected] of expectedFacts) {
    const actual = actualFacts.get(factId);
    if (actual === undefined) {
      factMismatch.missing.push(factId);
      continue;
    }
    const fields = changedFields(expected, actual, [
      "content",
      "kind",
      "sensitivity",
      "version",
      "valid_from",
      "valid_until",
      "created_at",
      "updated_at",
      "deleted_at",
    ]);
    if (fields.length > 0) factMismatch.mismatched.push({ fact_id: factId, fields });
  }
  for (const factId of actualFacts.keys()) {
    if (!expectedFacts.has(factId)) factMismatch.extra.push(factId);
  }

  const expectedRevisions = new Map(snapshot.revisions.map((revision) => [revision.revision_id, revision]));
  const actualRevisions = new Map(deps.store.listAllRevisions().map((revision) => [revision.revision_id, revision]));
  const revisionMismatch: ConsistencyReport["revisions"] = { missing: [], extra: [], mismatched: [] };
  for (const [revisionId, expected] of expectedRevisions) {
    const actual = actualRevisions.get(revisionId);
    if (actual === undefined) {
      revisionMismatch.missing.push(revisionId);
      continue;
    }
    const fields = changedFields(expected, actual, ["fact_id", "version", "content", "sensitivity", "reason"]);
    if (fields.length > 0) revisionMismatch.mismatched.push({ revision_id: revisionId, fields });
  }
  for (const revisionId of actualRevisions.keys()) {
    if (!expectedRevisions.has(revisionId)) revisionMismatch.extra.push(revisionId);
  }

  const ok =
    factMismatch.missing.length === 0 &&
    factMismatch.extra.length === 0 &&
    factMismatch.mismatched.length === 0 &&
    revisionMismatch.missing.length === 0 &&
    revisionMismatch.extra.length === 0 &&
    revisionMismatch.mismatched.length === 0;
  return { ok, facts: factMismatch, revisions: revisionMismatch };
}

function changedFields(expected: object, actual: object, fields: string[]): string[] {
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  const changed: string[] = [];
  for (const field of fields) {
    if ((left[field] ?? null) !== (right[field] ?? null)) changed.push(field);
  }
  return changed;
}
