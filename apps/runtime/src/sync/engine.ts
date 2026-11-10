import {
  computeIntegrityHash,
  type EventEnvelope,
  type SyncCursorRecord,
  type SyncEnvelope,
  type SyncPeerRunResult,
  type SyncPeerStatus,
  type SyncPullBatch,
  type SyncPushOutcome,
  type SyncRunReport,
  type SyncStatus,
} from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import { LedgerError, type EventLedger } from "../ledger.ts";
import type { SyncCursorStore } from "./cursors.ts";
import { SyncError } from "./errors.ts";
import type { SyncTransport } from "./transport.ts";
import type { TombstoneStore } from "./tombstones.ts";

/**
 * 同步引擎核心（M3-T1 / Issue #30，PRD §4.6 FR-DEP-3）。
 *
 * 只同步逻辑事件（信封原文），绝不复制活跃 SQLite 文件：
 *   - 导出：本副本账本按 sequence 升序取批（`exportBatch`），每条带 source_replica_id；
 *   - 导入：按 event_id 幂等（唯一约束 + 预检）、integrity_hash 复算校验（整批拒绝）、
 *     sequence 连续性/与游标衔接校验（缺口 → sync_gap 且游标不推进），最终经
 *     账本 append-only 通道写入（不绕过库级触发器）；
 *   - 游标：每对 peer 维护拉取方向与 push 方向进度（见 migrations.ts 口径）；
 *   - 审计：sync.pulled / sync.pushed / sync.gap_detected 作为普通事件落账本。
 *
 * 传输是可注入接缝（SyncTransport）：生产用 HTTP，契约测试用内存实现。
 */

export const SYNC_EVENT_TYPES = {
  pulled: "sync.pulled",
  pushed: "sync.pushed",
  gapDetected: "sync.gap_detected",
  tombstoneSkipped: "sync.tombstone_skipped",
  merged: "sync.merged",
  conflict: "sync.conflict",
  fileConflict: "sync.file_conflict",
  runCompleted: "sync.run_completed",
} as const;

export const SYNC_PULL_DEFAULT_LIMIT = 100;
export const SYNC_PULL_MAX_LIMIT = 1000;

export interface SyncEngineOptions {
  ledger: EventLedger;
  replicaId: string;
  cursors: SyncCursorStore;
  /** 出站编排（pullFromPeer / pushToPeer）用的传输；HTTP 端点本身不需要它 */
  transport?: SyncTransport;
  /**
   * 删除集合（票 M3-T3 / Issue #32）：导入路径命中 fact/event tombstone 时跳过并落
   * sync.tombstone_skipped 审计。缺省（T1 单测）不启用删除语义。
   */
  tombstones?: TombstoneStore;
  /**
   * 导入批次落账后的语义回调（票 M3-T3）：参数 = 本批真正新增的事件 + peer replica id。
   * runtime 注入 MemorySyncService.handleImported 做三方合并/投影重建。缺省不触发。
   */
  afterImport?: (envelopes: EventEnvelope[], peerReplicaId: string) => void;
  /**
   * 已配对 peer 的 replica_id 来源（M3 修复批 / Issue #35）：status 的 peers 与
   * POST /v1/sync/run 的「全部已配对 peer」都从这里取。runtime 注入 devices 表中
   * trusted 且未撤销的远端设备；缺省只用已有同步游标。
   */
  knownPeers?: () => string[];
  /**
   * 每个 peer 成功同步后回调（M3 修复批）：runtime 用它写 devices.last_sync_at。
   * 只在 pull / push / 接收 push 成功后调用（失败不更新）。
   */
  onSynced?: (peerReplicaId: string, at: Date) => void;
  /** 可注入时钟（last_synced_at 测试零真实等待）；缺省系统时间 */
  now?: () => Date;
}

export interface PullOptions {
  /** 缺省 = peer 游标 last_pulled_sequence */
  since?: number;
  /** 缺省 100，钳制到 [1,1000] */
  limit?: number;
}

export interface PushOptions {
  /** 缺省 100，钳制到 [1,1000] */
  limit?: number;
}

type ImportDirection = "pulled" | "acked";

export class SyncEngine {
  readonly replicaId: string;
  readonly #ledger: EventLedger;
  readonly #cursors: SyncCursorStore;
  readonly #tombstones: TombstoneStore | undefined;
  readonly #afterImport: ((envelopes: EventEnvelope[], peerReplicaId: string) => void) | undefined;
  readonly #knownPeers: (() => string[]) | undefined;
  readonly #onSynced: ((peerReplicaId: string, at: Date) => void) | undefined;
  readonly #now: () => Date;
  #transport: SyncTransport | undefined;

  constructor(options: SyncEngineOptions) {
    this.#ledger = options.ledger;
    this.replicaId = options.replicaId;
    this.#cursors = options.cursors;
    this.#transport = options.transport;
    this.#tombstones = options.tombstones;
    this.#afterImport = options.afterImport;
    this.#knownPeers = options.knownPeers;
    this.#onSynced = options.onSynced;
    this.#now = options.now ?? (() => new Date());
    // 启动时从账本重建删除集合（本机历史删除 + 上次会话已导入的删除）
    this.#tombstones?.reconcileFromLedger(this.#ledger);
  }

  /** 注入/替换出站传输（宿主接线或契约测试用它把两个副本连起来） */
  setTransport(transport: SyncTransport | null): void {
    this.#transport = transport ?? undefined;
  }

  /**
   * 导出：本副本账本中 sequence > sinceSeq 的条目，按 seq 升序返回 SyncEnvelope 批次。
   * 同时取 limit+1 条判定 has_more，避免额外 COUNT 查询。
   */
  exportBatch(sinceSeq: number, limit = SYNC_PULL_DEFAULT_LIMIT): SyncPullBatch {
    const since = Number.isInteger(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;
    const pageSize = normalizeLimit(limit);
    const rows = this.#ledger.listSince(since, pageSize + 1);
    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    const envelopes: SyncEnvelope[] = page.map((row) => ({
      source_replica_id: this.replicaId,
      sequence: row.sequence,
      envelope: row.envelope,
    }));
    const nextSeq = page.length > 0 ? page[page.length - 1].sequence : since;
    return { envelopes, next_seq: nextSeq, has_more: hasMore };
  }

  /**
   * 接收 peer 推送的批次并幂等导入（POST /v1/sync/push / SyncTransport.push 的对端入口）。
   * 缺口或完整性校验失败时整批不落库、游标不推进，并落 sync.gap_detected 审计。
   */
  receivePush(peerReplicaId: string, envelopes: SyncEnvelope[]): SyncPushOutcome {
    const outcome = this.#importEnvelopes(peerReplicaId, envelopes, "acked");
    // 接收对端推送也是一次成功同步（空批也算——对端确实来沟通了）
    this.#markSynced(peerReplicaId);
    return outcome;
  }

  /** 从 peer 拉取一批（since = last_pulled_sequence 缺省）并导入 */
  async pullFromPeer(peerReplicaId: string, options: PullOptions = {}): Promise<SyncPullBatch & { accepted: number; duplicates: number }> {
    const transport = this.#requireTransport();
    const cursor = this.#cursors.getOrZero(peerReplicaId);
    const since = normalizeSince(options.since ?? cursor.last_pulled_sequence);
    const limit = normalizeLimit(options.limit);
    const result = await transport.pull(peerReplicaId, since, limit);
    const outcome = this.#importEnvelopes(peerReplicaId, result.envelopes, "pulled");
    // 正常推进游标：以批内最后一条实际 sequence 为准（不盲信对端 nextSeq，避免跳过空洞）
    const lastSequence = result.envelopes.length > 0 ? result.envelopes[result.envelopes.length - 1].sequence : since;
    this.#cursors.advancePulled(peerReplicaId, lastSequence);
    this.#markSynced(peerReplicaId);
    return {
      envelopes: result.envelopes,
      next_seq: result.nextSeq,
      has_more: result.hasMore,
      accepted: outcome.accepted,
      duplicates: outcome.duplicates,
    };
  }

  /** 把本地新事件推给 peer（从 last_acked_sequence 之后的本地 sequence 起） */
  async pushToPeer(peerReplicaId: string, options: PushOptions = {}): Promise<SyncPushOutcome> {
    const transport = this.#requireTransport();
    const acked = this.#cursors.getOrZero(peerReplicaId).last_acked_sequence;
    const batch = this.exportBatch(acked, normalizeLimit(options.limit));
    if (batch.envelopes.length === 0) {
      this.#markSynced(peerReplicaId);
      return { accepted: 0, duplicates: 0, next_seq: acked };
    }
    const receipt = await transport.push(peerReplicaId, batch.envelopes);
    this.#cursors.advanceAcked(peerReplicaId, batch.next_seq);
    this.#markSynced(peerReplicaId);
    // 出站侧不另落 sync.pushed：对端接收时必落一条（同一次动作的单侧审计），
    // 避免发送方审计事件反过来被下一次推送携带、形成审计自增殖。
    return { accepted: receipt.accepted, duplicates: receipt.duplicates, next_seq: batch.next_seq };
  }

  /**
   * GET /v1/sync/status 的本地快照（不发网络请求）：sequence 范围 + 游标 + peers
   * （pending_download 未知 → null、unreachable=false）。HTTP 层缺省走 statusWithPeers。
   */
  status(): SyncStatus {
    const sequence = this.#ledger.sequenceRange();
    const cursors = this.#cursors.list();
    return {
      replica_id: this.replicaId,
      sequence,
      last_sync_at: latestSyncTime(cursors.map((cursor) => cursor.last_synced_at)),
      cursors,
      peers: this.#peerStatuses(cursors, sequence.max, false, []),
    };
  }

  /**
   * GET /v1/sync/status 的完整快照（M3 修复批 / Issue #35）：向每个 peer 实时探测
   * 对端账本上界以计算 pending_download；单个 peer 不可达只影响该 peer
   * （pending_download=null + unreachable=true），绝不让整张状态表 5xx。
   */
  async statusWithPeers(): Promise<SyncStatus> {
    const sequence = this.#ledger.sequenceRange();
    const cursors = this.#cursors.list();
    const peerIds = this.#peerIds(cursors);
    const probes = await Promise.all(
      peerIds.map(async (peerId) => {
        if (this.#transport === undefined) return { peerId, probe: null };
        try {
          return { peerId, probe: await this.#transport.status(peerId) };
        } catch {
          return { peerId, probe: null };
        }
      }),
    );
    return {
      replica_id: this.replicaId,
      sequence,
      last_sync_at: latestSyncTime(cursors.map((cursor) => cursor.last_synced_at)),
      cursors,
      peers: this.#peerStatuses(cursors, sequence.max, true, probes),
    };
  }

  /**
   * POST /v1/sync/run（M3 修复批 / Issue #35）：对给定或全部已配对 peer 执行一轮
   * pull → push → push → pull（每步排空到底）。双向两轮确保一次调用后两端收敛：
   *   1. pull 把对端事件带入本地；
   *   2. push 把本地（含刚拉到的）事件推给对端；
   *   3. 第二次 push 处理第 2 步期间对端新增事件被拉取前的增量；
   *   4. 第二次 pull 收下 push 期间对端产生的审计/业务事件。
   * 单 peer 失败（缺口/不可达/integrity）只记录到该 peer 的 errors，继续其他 peer。
   */
  async runOnce(peerReplicaId?: string): Promise<SyncRunReport> {
    const requested = peerReplicaId ?? null;
    const peerIds = requested === null ? this.#peerIds(this.#cursors.list()) : [requested];
    const peers: SyncPeerRunResult[] = [];
    for (const peerId of peerIds) {
      peers.push(await this.#runPeerRound(peerId));
    }
    const totals = {
      peers: peers.length,
      ok: peers.filter((peer) => peer.ok).length,
      failed: peers.filter((peer) => !peer.ok).length,
      pulled: peers.reduce((sum, peer) => sum + peer.pulled, 0),
      pushed: peers.reduce((sum, peer) => sum + peer.pushed, 0),
      duplicates: peers.reduce((sum, peer) => sum + peer.duplicates, 0),
      gaps: peers.reduce((sum, peer) => sum + peer.gaps, 0),
    };
    this.#audit(SYNC_EVENT_TYPES.runCompleted, {
      requested_peer_replica_id: requested,
      ...totals,
      errors: peers.flatMap((peer) => peer.errors.map((error) => ({ peer_replica_id: peer.peer_replica_id, error }))),
    });
    return { requested_peer_replica_id: requested, peers, totals };
  }

  /** 单个 peer 的一轮；任何步骤失败即停止该 peer（不影响其他 peer） */
  async #runPeerRound(peerId: string): Promise<SyncPeerRunResult> {
    const result: SyncPeerRunResult = {
      peer_replica_id: peerId,
      pulled: 0,
      pushed: 0,
      duplicates: 0,
      gaps: 0,
      errors: [],
      ok: true,
    };
    try {
      for (const step of ["pull", "push", "push", "pull"] as const) {
        if (step === "pull") await this.#drainPull(peerId, result);
        else await this.#drainPush(peerId, result);
      }
    } catch (err) {
      result.ok = false;
      if (err instanceof SyncError && err.code === "sync_gap") result.gaps += 1;
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
    return result;
  }

  async #drainPull(peerId: string, result: SyncPeerRunResult): Promise<void> {
    // 排空到底（limit 由引擎上限钳制）；254 页防御性上限避免对端异常导致死循环。
    for (let page = 0; page < 254; page++) {
      const batch = await this.pullFromPeer(peerId);
      result.pulled += batch.accepted;
      result.duplicates += batch.duplicates;
      if (!batch.has_more) return;
    }
  }

  async #drainPush(peerId: string, result: SyncPeerRunResult): Promise<void> {
    for (let page = 0; page < 254; page++) {
      const before = this.#cursors.getOrZero(peerId).last_acked_sequence;
      const outcome = await this.pushToPeer(peerId);
      result.pushed += outcome.accepted;
      result.duplicates += outcome.duplicates;
      if (outcome.next_seq === null || outcome.next_seq <= before) return;
    }
  }

  /**
   * peer 全集：注入了「已配对设备」来源时只用它（trusted 且未撤销——被撤销的 peer 不再
   * 参与同步/状态）；未注入时（引擎单测）退回已有游标的 peer。去重保序。
   */
  #peerIds(cursors: SyncCursorRecord[]): string[] {
    const source = this.#knownPeers?.() ?? cursors.map((cursor) => cursor.peer_replica_id);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of source) {
      if (id === this.replicaId || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  #peerStatuses(
    cursors: SyncCursorRecord[],
    localMax: number | null,
    probed: boolean,
    probes: Array<{ peerId: string; probe: { max_sequence: number | null } | null }>,
  ): SyncPeerStatus[] {
    const probeById = new Map(probes.map((entry) => [entry.peerId, entry.probe]));
    const cursorById = new Map(cursors.map((cursor) => [cursor.peer_replica_id, cursor]));
    // 已配对但从未同步的 peer 也要出现在状态表（pending 从 0 游标算起）
    const ids = this.#peerIds(cursors);
    return ids.map((peerId) => {
      const cursor = cursorById.get(peerId) ?? {
        peer_replica_id: peerId,
        last_pulled_sequence: 0,
        last_acked_sequence: 0,
        last_synced_at: null,
        updated_at: null,
      };
      const probe = probeById.get(peerId) ?? null;
      const remoteMax = probe?.max_sequence ?? null;
      return {
        peer_replica_id: peerId,
        last_pulled_sequence: cursor.last_pulled_sequence,
        last_acked_sequence: cursor.last_acked_sequence,
        last_synced_at: cursor.last_synced_at,
        // 口径：本副本账本最大 seq − 该 peer 已确认的 sequence（钳到 0）。
        pending_upload: Math.max(0, (localMax ?? 0) - cursor.last_acked_sequence),
        pending_download:
          remoteMax === null ? null : Math.max(0, remoteMax - cursor.last_pulled_sequence),
        unreachable: probed && probe === null,
        remote_max_sequence: remoteMax,
      };
    });
  }

  #markSynced(peerReplicaId: string): void {
    const at = this.#now();
    this.#cursors.markSynced(peerReplicaId, at);
    this.#onSynced?.(peerReplicaId, at);
  }

  #importEnvelopes(
    peerReplicaId: string,
    envelopes: SyncEnvelope[],
    direction: ImportDirection,
  ): SyncPushOutcome {
    if (!Array.isArray(envelopes)) {
      throw new SyncError("sync_invalid_batch", "envelopes must be an array", { peer_replica_id: peerReplicaId });
    }
    if (envelopes.length === 0) {
      return { accepted: 0, duplicates: 0, next_seq: null };
    }

    const cursor =
      direction === "pulled"
        ? this.#cursors.getOrZero(peerReplicaId).last_pulled_sequence
        : this.#cursors.getOrZero(peerReplicaId).last_acked_sequence;

    // 1) 形状 + sequence 连续性/游标衔接（缺口 → sync_gap；整批未写库）
    let expected = cursor + 1;
    let previous: number | undefined;
    for (const [index, item] of envelopes.entries()) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw invalidBatch(peerReplicaId, `envelopes[${index}] must be an object`);
      }
      if (item.source_replica_id !== peerReplicaId) {
        throw invalidBatch(peerReplicaId, `envelopes[${index}].source_replica_id must equal peer_replica_id`, {
          actual_source_replica_id: item.source_replica_id,
        });
      }
      const sequence = item.sequence;
      if (!Number.isInteger(sequence) || sequence < 1) {
        throw invalidBatch(peerReplicaId, `envelopes[${index}].sequence must be a positive integer`, {
          sequence,
        });
      }
      if (previous !== undefined && sequence !== previous + 1) {
        this.#gap(peerReplicaId, direction, previous + 1, sequence, envelopes.length);
      }
      if (sequence > cursor && sequence !== expected) {
        this.#gap(peerReplicaId, direction, expected, sequence, envelopes.length);
      }
      if (sequence > cursor) expected = sequence + 1;
      previous = sequence;
      if (typeof item.envelope !== "object" || item.envelope === null || typeof item.envelope.event_id !== "string") {
        throw invalidBatch(peerReplicaId, `envelopes[${index}].envelope must be an event envelope`);
      }
    }

    // 2) integrity_hash 复算（整批先验；不符拒绝整批，前置合法事件也不落库）
    for (const item of envelopes) {
      let actual: string;
      try {
        actual = computeIntegrityHash(item.envelope);
      } catch (err) {
        throw invalidBatch(peerReplicaId, `cannot hash envelopes: ${(err as Error).message}`);
      }
      if (actual !== item.envelope.integrity_hash) {
        throw new SyncError(
          "sync_integrity_mismatch",
          `integrity_hash mismatch for event ${item.envelope.event_id}`,
          {
            peer_replica_id: peerReplicaId,
            event_id: item.envelope.event_id,
            sequence: item.sequence,
          },
        );
      }
    }

    // 3) 逐条幂等导入（账本 append-only；event_id 唯一约束是最终防线）
    const seen = new Set<string>();
    const acceptedEnvelopes: EventEnvelope[] = [];
    let accepted = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const item of envelopes) {
      const eventId = item.envelope.event_id;
      if (seen.has(eventId) || this.#ledger.hasEvent(eventId)) {
        duplicates += 1;
        continue;
      }
      seen.add(eventId);
      // 删除集合（M3-T3）：已删事实的陈旧修订 / 已删事件不得复活。跳过但仍是「本批
      // 已到达的事件」——游标照常推进，审计单独留痕。
      const tombstone = this.#tombstones?.shouldSkip(item.envelope);
      if (tombstone !== undefined && tombstone.skip) {
        skipped += 1;
        this.#audit(SYNC_EVENT_TYPES.tombstoneSkipped, {
          peer_replica_id: peerReplicaId,
          direction,
          event_id: eventId,
          event_type: item.envelope.event_type,
          reason: tombstone.reason,
          ...(tombstone.fact_id !== undefined ? { fact_id: tombstone.fact_id } : {}),
        });
        continue;
      }
      try {
        this.#ledger.append(item.envelope);
        accepted += 1;
        acceptedEnvelopes.push(item.envelope);
        if (item.envelope.event_type === "memory.fact_deleted") {
          // 导入的 tombstone 立即生效：同批后续/下一批的旧修订都会被拦下
          this.#tombstones?.recordFactDeletion(item.envelope, this.#ledger);
        }
      } catch (err) {
        if (err instanceof LedgerError && err.code === "duplicate_event_id") {
          duplicates += 1;
          continue;
        }
        if (err instanceof LedgerError && err.code === "invalid_envelope") {
          throw invalidBatch(peerReplicaId, `event ${eventId} rejected by protocol schema`, {
            event_id: eventId,
            errors: err.details,
          });
        }
        throw err;
      }
    }

    const lastSequence = envelopes[envelopes.length - 1].sequence;
    if (direction === "pulled") {
      this.#cursors.advancePulled(peerReplicaId, lastSequence);
    } else {
      this.#cursors.advanceAcked(peerReplicaId, lastSequence);
    }
    // 只含 sync.* 元事件的导入不落新审计：审计事件本身会随账本传播，若每次导入
    // 元事件都再审一遍，两台副本会围绕审计事件互相触发（自增殖）。携带真实数据
    // 的导入（含全重复批）仍留痕。
    const carriesData = envelopes.some((item) => !item.envelope.event_type.startsWith("sync."));
    if (carriesData) {
      this.#audit(direction === "pulled" ? SYNC_EVENT_TYPES.pulled : SYNC_EVENT_TYPES.pushed, {
        peer_replica_id: peerReplicaId,
        direction: "inbound",
        accepted,
        duplicates,
        skipped,
        next_seq: Math.max(cursor, lastSequence),
      });
    }
    // 4) 语义层（记忆三方合并 / 投影重建）；只处理本批真正新增的事件
    if (acceptedEnvelopes.length > 0) {
      this.#afterImport?.(acceptedEnvelopes, peerReplicaId);
    }
    return {
      accepted,
      duplicates,
      next_seq: lastSequence,
      ...(skipped > 0 ? { skipped } : {}),
    };
  }

  #gap(
    peerReplicaId: string,
    direction: ImportDirection,
    expected: number,
    actual: number,
    received: number,
  ): never {
    this.#audit(SYNC_EVENT_TYPES.gapDetected, {
      peer_replica_id: peerReplicaId,
      direction,
      expected,
      actual,
      received,
    });
    throw new SyncError("sync_gap", `sequence gap: expected ${expected}, got ${actual}`, {
      peer_replica_id: peerReplicaId,
      expected,
      actual,
    });
  }

  #audit(eventType: string, payload: Record<string, unknown>): void {
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.replicaId,
        actorId: "agent:runtime",
        eventType,
        payload,
      }),
    );
  }

  #requireTransport(): SyncTransport {
    if (this.#transport === undefined) {
      throw new SyncError("sync_transport_unavailable", "no SyncTransport configured for outbound sync");
    }
    return this.#transport;
  }
}

function invalidBatch(
  peerReplicaId: string,
  reason: string,
  extra: Record<string, unknown> = {},
): SyncError {
  return new SyncError("sync_invalid_batch", reason, { peer_replica_id: peerReplicaId, ...extra });
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value)) return SYNC_PULL_DEFAULT_LIMIT;
  return Math.min(SYNC_PULL_MAX_LIMIT, Math.max(1, value));
}

function normalizeSince(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** 多个 ISO 时间取最大（null 跳过）；全空返回 null */
function latestSyncTime(values: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}
