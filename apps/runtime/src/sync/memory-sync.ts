import type { EventEnvelope } from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import {
  MemoryProjectionRebuilder,
  type RebuildResult,
} from "../memory/rebuild.ts";
import type { MemoryConflictRow, MemoryFactRow, MemoryStore } from "../memory/store.ts";
import { MEMORY_EVENT_TYPES } from "../memory/service.ts";
import type { SyncConflictStore, SyncConflictMeta } from "./conflict-store.ts";
import { classifyFactMerge, type FactMergeDecision, type FactVersionView } from "./merge.ts";

/**
 * 记忆同步语义层（票 M3-T3 / Issue #32，PRD §4.2「冲突合并」/ FR-DEP-5 / AC-05）。
 *
 * T1 引擎负责「事件到齐」；本层负责「到齐之后记忆该怎么变」：
 *   1. 版本关系判定（M3 code-review B1）：远端版本更高 → fast-forward；同版本且内容
 *      不同 → 并发（交给 merge.ts，内部复用 M1 DefaultConsolidator）；远端版本更低 →
 *      陈旧跳过。**不再用 `min(local,remote)-1` 伪造共同基线**（它会让 fast-forward
 *      成为死分支、把普通新版本误判冲突、并放大 preference 版本）。
 *   2. 有效期参与合并（M3 code-review B2 / FR-DEP-5）：过期事实不作为冲突源——远端
 *      过期跳过（双方过期留 skip 审计），仅本地过期则有效远端胜出；
 *   3. 自动合并（同版本 preference）→ 追加 memory.fact_updated（reason=sync_merge，
 *      显式版本 = max+1）+ sync.merged 审计；
 *   4. 待审核（locked / sensitivity_change / fact_conflict）→ 远端修订写成候选 +
 *      冲突进 M1 memory_conflicts 队列 + sync.conflict 审计（含两侧 replica 与版本），
 *      绝不覆盖本地值；
 *   5. 重放：处理完本批后从账本重建 facts/revisions/FTS（memory/rebuild.ts），
 *      保证「记忆视图 = 账本事件 + 本副本冲突判定」。
 *
 * 幂等：远端事件 id 已进 sync_conflict_meta / 已被 sync.conflict 记录时不再处理；
 * 本层追加的事件也会随同步传播，但 reason=sync_merge / conflict_resolved 被视为
 * 权威结果，对端只重放、不再二次合并（避免两台设备互相生成合并事件）。
 */

const AUTHORITATIVE_REASONS = new Set(["sync_merge", "conflict_resolved", "conflict_merged"]);
/** 合并跳过审计（B2：双方/远端过期；不产生冲突也不改可见值） */
const MERGE_SKIPPED_EVENT_TYPE = "sync.merge_skipped";

export interface MemorySyncStats {
  merged: number;
  conflicts: number;
  suppressed: number;
  /** 本批是否需要重建投影（无事实相关事件时为 null，避免每批全账本重放） */
  rebuilt: RebuildResult | null;
}

export interface MemorySyncOptions {
  store: MemoryStore;
  ledger: EventLedger;
  replicaId: string;
  conflicts: SyncConflictStore;
  /** 注入时钟（valid_until 过期判定；测试零真实等待）；缺省系统时间 */
  now?: () => Date;
}

export class MemorySyncService {
  readonly #store: MemoryStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #conflicts: SyncConflictStore;
  readonly #rebuilder: MemoryProjectionRebuilder;
  readonly #now: () => Date;

  constructor(options: MemorySyncOptions) {
    this.#store = options.store;
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#conflicts = options.conflicts;
    this.#now = options.now ?? (() => new Date());
    this.#rebuilder = new MemoryProjectionRebuilder({
      store: options.store,
      ledger: options.ledger,
      replicaId: options.replicaId,
    });
  }

  /** 同步导入批次落账后的语义处理（引擎 afterImport 回调） */
  handleImported(envelopes: EventEnvelope[], peerReplicaId: string): MemorySyncStats {
    const byFact = new Map<string, EventEnvelope[]>();
    for (const envelope of envelopes) {
      if (envelope.event_type !== "memory.fact_created" && envelope.event_type !== "memory.fact_updated") {
        continue;
      }
      const factId = envelope.payload.fact_id;
      if (typeof factId !== "string" || factId.length === 0) continue;
      const list = byFact.get(factId) ?? [];
      list.push(envelope);
      byFact.set(factId, list);
    }

    let merged = 0;
    let conflicts = 0;
    let suppressed = 0;
    for (const [factId, events] of byFact) {
      const latest = events[events.length - 1];
      const local = this.#store.getFact(factId);
      if (local === null || local.deleted_at !== null) continue; // 新建 / 已删除：重建即可
      if (latest.event_type === "memory.fact_created") continue; // 已有同 id 事实：不重放创建
      if (this.#conflicts.hasRemoteEvent(latest.event_id)) continue;

      // 权威裁决结果（sync_merge / conflict_resolved / conflict_merged）由重放直接采纳：
      // 即使本副本还有未裁决冲突，也不能把对端的裁决/合并事件继续压制（否则 keep_new /
      // merge 的版本链永远传不到对端——AC-05 裁决后可见值不符合裁决）。
      if (isAuthoritative(latest)) continue;

      const remote = viewFromEnvelope(latest, local);
      if (remote === null) continue;

      // 有效期参与合并（M3 code-review B2 / FR-DEP-5）：过期事实不得作为冲突源。
      // - 远端过期（含双方都过期）→ 跳过；双方都过期留 sync.merge_skipped 审计；
      // - 仅本地过期 → 有效远端胜出（本地不再是可竞争的当前值）。
      const nowMs = this.#now().getTime();
      const localExpired = isExpired(local.valid_until, nowMs);
      const remoteExpired = isExpired(remote.validUntil, nowMs);
      if (remoteExpired) {
        this.#auditMergeSkipped(factId, latest, peerReplicaId, localExpired ? "both_expired" : "remote_expired", local.version, remote.version);
        suppressed += 1;
        continue;
      }
      if (localExpired) {
        if (remote.version > local.version) {
          // 远端事件已在账本里且版本更高，重放会直接采纳；只留审计。
          this.#appendMergedEvent(local, remote, latest, "expired_local_fast_forward", peerReplicaId, remote.version, null);
          merged += 1;
        } else if (
          this.#applyMergeRevision(
            local,
            remote,
            latest,
            {
              content: remote.content,
              sensitivity: remote.sensitivity,
              resultVersion: Math.max(local.version, remote.version) + 1,
              mergedReason: "expired_local",
            },
            peerReplicaId,
          )
        ) {
          // 远端版本不高于本地：重放会跳过它，显式写一条权威修订覆盖过期本地值。
          merged += 1;
        }
        continue;
      }

      // 已有一条未裁决的跨设备冲突：该事实后续远端修订继续被压制（记录事件 id 供重放跳过），
      // 不再制造第二条冲突——Owner 裁决前不扩大战线。
      const open = this.#openConflictMeta(factId);
      if (open !== null) {
        this.#appendConflictEvent({
          conflictId: open.conflict_id,
          factId,
          reason: "open_conflict",
          remoteEvents: events,
          peerReplicaId,
          localReplicaId: this.#replicaId,
          localVersion: local.version,
          remoteVersion: remote.version,
          baseVersion: open.base_version,
        });
        suppressed += 1;
        continue;
      }

      // 版本关系由 classifyFactMerge 直接按 local/remote 的 version 判定（B1）：
      // 不再从 min(version)-1 伪造共同基线（那会让 fast_forward 成为死分支）。
      const decision = classifyFactMerge({ base: null, local: viewOfFact(local), remote });

      if (decision.action === "auto_merge") {
        if (this.#applyAutoMerge(local, remote, latest, decision, peerReplicaId)) merged += 1;
        continue;
      }
      if (decision.action === "fast_forward") {
        // 远端事件已在账本里，重放会直接采纳；sync.merged 只留审计（不追加修订）
        this.#appendMergedEvent(local, remote, latest, decision.reason, peerReplicaId, decision.resultVersion, decision.baseVersion);
        merged += 1;
        continue;
      }
      if (decision.action === "escalate") {
        this.#raiseConflict(local, remote, events, decision, peerReplicaId);
        conflicts += 1;
        continue;
      }
      if (decision.action === "remote_is_base") {
        // 远端版本低于本地：陈旧修订，重放会跳过；不产生任何修订/冲突审计。
        suppressed += 1;
      }
      // identical / no_local：无需动作
    }

    const rebuilt = needsRebuild(envelopes) ? this.#rebuilder.rebuild() : null;
    return { merged, conflicts, suppressed, rebuilt };
  }

  /** 显式重建（运维/测试） */
  rebuild(): RebuildResult {
    return this.#rebuilder.rebuild();
  }

  /** 合并跳过审计（B2）：过期事实不参与冲突，留痕供运维核对（不影响可见值） */
  #auditMergeSkipped(
    factId: string,
    remoteEnvelope: EventEnvelope,
    peerReplicaId: string,
    reason: "both_expired" | "remote_expired",
    localVersion: number,
    remoteVersion: number,
  ): void {
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType: MERGE_SKIPPED_EVENT_TYPE,
        payload: {
          fact_id: factId,
          reason,
          local_version: localVersion,
          remote_version: remoteVersion,
          local_replica_id: this.#replicaId,
          remote_replica_id: peerReplicaId,
          remote_event_id: remoteEnvelope.event_id,
        },
        causationId: remoteEnvelope.event_id,
      }),
    );
  }

  #openConflictMeta(factId: string): SyncConflictMeta | null {
    for (const meta of this.#conflicts.list()) {
      if (meta.fact_id !== factId || meta.resolved_at !== null) continue;
      const conflict = this.#store.getConflict(meta.conflict_id);
      if (conflict !== null && conflict.status === "open") return meta;
    }
    return null;
  }

  #applyAutoMerge(
    local: MemoryFactRow,
    remote: FactVersionView,
    remoteEnvelope: EventEnvelope,
    decision: Extract<FactMergeDecision, { action: "auto_merge" }>,
    peerReplicaId: string,
  ): boolean {
    return this.#applyMergeRevision(
      local,
      remote,
      remoteEnvelope,
      {
        content: decision.content,
        sensitivity: decision.sensitivity,
        resultVersion: decision.resultVersion,
        mergedReason: "preference_update",
      },
      peerReplicaId,
    );
  }

  /**
   * 写一条 reason=sync_merge 的权威修订 + 审计（自动合并 / 本地过期让位给有效远端）。
   * 版本已由另一端推进时收敛为 no-op（返回 false）。
   */
  #applyMergeRevision(
    local: MemoryFactRow,
    remote: FactVersionView,
    remoteEnvelope: EventEnvelope,
    input: {
      content: string;
      sensitivity: MemoryFactRow["sensitivity"];
      resultVersion: number;
      mergedReason: string;
    },
    peerReplicaId: string,
  ): boolean {
    const { source, candidate } = this.#store.createCandidate({
      content: input.content,
      kind: remote.kind,
      confidence: 1,
      sensitivity: input.sensitivity,
      occurredAt: remoteEnvelope.occurred_at,
      source: { kind: "sync", eventId: remoteEnvelope.event_id, sessionId: null },
    });
    this.#appendCandidateCreated(candidate.candidate_id, candidate.content, candidate.kind, candidate.sensitivity, candidate.confidence, source.source_id, remoteEnvelope.event_id);
    try {
      const { revision } = this.#store.applyFactRevision({
        factId: local.fact_id,
        version: input.resultVersion,
        content: input.content,
        sensitivity: input.sensitivity,
        reason: "sync_merge",
        candidateId: candidate.candidate_id,
        sourceId: source.source_id,
      });
      this.#ledger.append(
        buildEventEnvelope({
          replicaId: this.#replicaId,
          actorId: "agent:runtime",
          eventType: MEMORY_EVENT_TYPES.factUpdated,
          payload: {
            fact_id: local.fact_id,
            version: input.resultVersion,
            content: input.content,
            kind: local.kind,
            sensitivity: input.sensitivity,
            revision_id: revision.revision_id,
            reason: "sync_merge",
            candidate_id: candidate.candidate_id,
            source_event_id: remoteEnvelope.event_id,
            local_version: local.version,
            remote_version: remote.version,
            remote_replica_id: peerReplicaId,
          },
          causationId: remoteEnvelope.event_id,
        }),
      );
    } catch (err) {
      // 版本已由另一端推进（并发合并事件先行到达）：结果收敛，无需重复写。
      if (err instanceof Error && err.message.includes("must advance")) return false;
      throw err;
    }
    this.#appendMergedEvent(local, remote, remoteEnvelope, input.mergedReason, peerReplicaId, input.resultVersion, null);
    return true;
  }

  #appendMergedEvent(
    local: MemoryFactRow,
    remote: FactVersionView,
    remoteEnvelope: EventEnvelope,
    reason: string,
    peerReplicaId: string,
    resultVersion: number,
    baseVersion: number | null,
  ): void {
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType: "sync.merged",
        payload: {
          fact_id: local.fact_id,
          reason,
          local_version: local.version,
          remote_version: remote.version,
          base_version: baseVersion,
          result_version: resultVersion,
          local_replica_id: this.#replicaId,
          remote_replica_id: peerReplicaId,
          remote_event_id: remoteEnvelope.event_id,
        },
        causationId: remoteEnvelope.event_id,
      }),
    );
  }

  #raiseConflict(
    local: MemoryFactRow,
    remote: FactVersionView,
    events: EventEnvelope[],
    decision: Extract<FactMergeDecision, { action: "escalate" }>,
    peerReplicaId: string,
  ): void {
    const latest = events[events.length - 1];
    const { source, candidate } = this.#store.createCandidate({
      content: remote.content,
      kind: remote.kind,
      confidence: 1,
      sensitivity: remote.sensitivity,
      occurredAt: latest.occurred_at,
      source: { kind: "sync", eventId: latest.event_id, sessionId: null },
    });
    this.#appendCandidateCreated(candidate.candidate_id, candidate.content, candidate.kind, candidate.sensitivity, candidate.confidence, source.source_id, latest.event_id);
    const conflict: MemoryConflictRow = this.#store.escalateConflict({
      candidateId: candidate.candidate_id,
      factId: local.fact_id,
      reason: decision.reason,
      existingContent: decision.existingContent,
      incomingContent: decision.incomingContent,
      existingSensitivity: decision.existingSensitivity,
      incomingSensitivity: decision.incomingSensitivity,
      sourceId: source.source_id,
    });
    this.#conflicts.record({
      conflict_id: conflict.conflict_id,
      fact_id: local.fact_id,
      local_replica_id: this.#replicaId,
      remote_replica_id: peerReplicaId,
      local_version: local.version,
      remote_version: remote.version,
      base_version: decision.baseVersion,
      reason: decision.reason,
      remote_event_id: latest.event_id,
      created_at: conflict.created_at,
    });
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType: MEMORY_EVENT_TYPES.conflictDetected,
        payload: {
          conflict_id: conflict.conflict_id,
          fact_id: local.fact_id,
          candidate_id: candidate.candidate_id,
          reason: conflict.reason,
          existing_content: conflict.existing_content,
          incoming_content: conflict.incoming_content,
          remote_event_id: latest.event_id,
          remote_replica_id: peerReplicaId,
        },
        causationId: latest.event_id,
      }),
    );
    this.#appendConflictEvent({
      conflictId: conflict.conflict_id,
      factId: local.fact_id,
      reason: decision.reason,
      remoteEvents: events,
      peerReplicaId,
      localReplicaId: this.#replicaId,
      localVersion: local.version,
      remoteVersion: remote.version,
      baseVersion: decision.baseVersion,
    });
  }

  /**
   * sync.conflict 审计：remote_event_ids 是重放时跳过的「未采纳远端修订」全集。
   * M3 修复批（#32 #36）：冲突记录同时保留**本地版本引用**（local_version +
   * local_revision_id + local_event_id）与远端事件引用（remote_event_ids）——
   * 重放按事件作者归属只压制远端修订，本地已合并的可见值不会回落到基线。
   * 防御性过滤：本副本创作的事件绝不进 remote_event_ids（两端互为 remote 的场景）。
   */
  #appendConflictEvent(input: {
    conflictId: string;
    factId: string;
    reason: string;
    remoteEvents: EventEnvelope[];
    peerReplicaId: string;
    localReplicaId: string;
    localVersion: number;
    remoteVersion: number;
    baseVersion: number | null;
  }): void {
    const ids = input.remoteEvents
      .filter((event) => event.replica_id !== this.#replicaId)
      .map((event) => event.event_id);
    const localRevisionId = this.#store.getRevision(input.factId, input.localVersion)?.revision_id ?? null;
    const localEventId = this.#localEventId(input.factId, input.localVersion);
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType: "sync.conflict",
        payload: {
          conflict_id: input.conflictId,
          fact_id: input.factId,
          reason: input.reason,
          local_replica_id: input.localReplicaId,
          remote_replica_id: input.peerReplicaId,
          local_version: input.localVersion,
          local_revision_id: localRevisionId,
          local_event_id: localEventId,
          remote_version: input.remoteVersion,
          base_version: input.baseVersion,
          remote_event_id: ids[ids.length - 1] ?? null,
          remote_event_ids: ids,
        },
        causationId: ids[ids.length - 1] ?? null,
      }),
    );
  }

  /** 本地可见版本的账本事件 id（冲突记录里的 local 版本引用；找不到返回 null） */
  #localEventId(factId: string, version: number): string | null {
    const candidates = [
      ...this.#ledger.scan({ eventType: MEMORY_EVENT_TYPES.factCreated }),
      ...this.#ledger.scan({ eventType: MEMORY_EVENT_TYPES.factUpdated }),
    ];
    let found: string | null = null;
    for (const entry of candidates) {
      if (entry.envelope.replica_id !== this.#replicaId) continue;
      if (entry.envelope.payload.fact_id !== factId) continue;
      if (entry.envelope.payload.version !== version) continue;
      found = entry.envelope.event_id;
    }
    return found;
  }

  #appendCandidateCreated(
    candidateId: string,
    content: string,
    kind: string,
    sensitivity: string,
    confidence: number,
    sourceId: string,
    sourceEventId: string,
  ): void {
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType: MEMORY_EVENT_TYPES.candidateCreated,
        payload: {
          candidate_id: candidateId,
          content,
          kind,
          sensitivity,
          confidence,
          source_id: sourceId,
          source_event_id: sourceEventId,
          rule: "sync",
        },
        causationId: sourceEventId,
      }),
    );
  }
}

/** 权威结果标记（重放直接采纳，不再二次分类/压制） */
function isAuthoritative(envelope: EventEnvelope): boolean {
  const reason = envelope.payload.reason;
  return typeof reason === "string" && AUTHORITATIVE_REASONS.has(reason);
}

/** 只有事实状态或冲突判定变化才需要重建投影（避免每批 sync.* 事件都全账本重放） */
function needsRebuild(envelopes: EventEnvelope[]): boolean {
  return envelopes.some(
    (envelope) =>
      envelope.event_type === "memory.fact_created" ||
      envelope.event_type === "memory.fact_updated" ||
      envelope.event_type === "memory.fact_deleted" ||
      envelope.event_type === "sync.conflict",
  );
}

function viewOfFact(fact: MemoryFactRow): FactVersionView {
  return {
    factId: fact.fact_id,
    content: fact.content,
    kind: fact.kind,
    sensitivity: fact.sensitivity,
    version: fact.version,
    updatedAt: fact.updated_at,
    validUntil: fact.valid_until,
  };
}

/** valid_until 非空且已到期（解析失败按「未过期」处理，避免误删有效事实） */
function isExpired(validUntil: string | null | undefined, nowMs: number): boolean {
  if (validUntil === null || validUntil === undefined) return false;
  const at = Date.parse(validUntil);
  return Number.isFinite(at) && at <= nowMs;
}

function viewFromEnvelope(envelope: EventEnvelope, local: MemoryFactRow): FactVersionView | null {
  const version = envelope.payload.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  const reason = envelope.payload.reason;
  if (typeof reason === "string" && AUTHORITATIVE_REASONS.has(reason)) {
    // 权威结果：由重放直接采纳，不再二次分类（避免合并事件 ping-pong）
    return null;
  }
  const content = envelope.payload.content;
  if (typeof content !== "string") return null;
  const kind = envelope.payload.kind;
  const validUntil = envelope.payload.valid_until;
  return {
    factId: local.fact_id,
    content,
    kind: kind === "fact" || kind === "preference" || kind === "profile" || kind === "procedural" ? kind : local.kind,
    sensitivity:
      envelope.payload.sensitivity === "public" ||
      envelope.payload.sensitivity === "private" ||
      envelope.payload.sensitivity === "locked"
        ? envelope.payload.sensitivity
        : local.sensitivity,
    version,
    updatedAt: envelope.occurred_at,
    // 缺省沿用本地有效期（与 rebuild 的合并口径一致：payload 未携带时不清空）。
    validUntil: typeof validUntil === "string" ? validUntil : (validUntil === null ? null : local.valid_until),
  };
}

/** 冲突视图：memory_conflicts 本体 + sync_conflict_meta（来源副本与三方版本） */
export interface SyncConflictView extends MemoryConflictRow {
  origin: "sync" | "local";
  local_replica_id: string | null;
  remote_replica_id: string | null;
  local_version: number | null;
  remote_version: number | null;
  base_version: number | null;
  remote_event_id: string | null;
  sync_resolved_at: string | null;
}

/** 汇总跨设备冲突（只读投影；裁决仍走 M1 resolve 语义） */
export function listSyncConflicts(
  source: { listConflicts(filter: { status?: "open" | "resolved"; limit?: number; offset?: number }): MemoryConflictRow[] },
  conflicts: SyncConflictStore,
  filter: { status?: "open" | "resolved"; limit?: number; offset?: number } = {},
): SyncConflictView[] {
  const metas = new Map(conflicts.list().map((meta) => [meta.conflict_id, meta]));
  return source.listConflicts(filter).map((conflict) => {
    const meta = metas.get(conflict.conflict_id) ?? null;
    // M1 端点也可以裁决同一冲突；列表读取时以 memory_conflicts 状态为准回填同步元数据，
    // 避免「M1 已裁决、同步视图仍显示 open」的双真相源。
    if (meta !== null && meta.resolved_at === null && conflict.status === "resolved") {
      conflicts.markResolved(conflict.conflict_id, conflict.resolved_at ?? new Date().toISOString());
      meta.resolved_at = conflict.resolved_at ?? new Date().toISOString();
    }
    return {
      ...conflict,
      origin: meta === null ? "local" : "sync",
      local_replica_id: meta?.local_replica_id ?? null,
      remote_replica_id: meta?.remote_replica_id ?? null,
      local_version: meta?.local_version ?? null,
      remote_version: meta?.remote_version ?? null,
      base_version: meta?.base_version ?? null,
      remote_event_id: meta?.remote_event_id ?? null,
      sync_resolved_at: meta?.resolved_at ?? null,
    };
  });
}
