import type { ExecutionReconcileEvidence, ReconcileEvidenceSource } from "@morrow/protocol";
import type { EventLedger, LedgerEntry } from "../ledger.ts";

/**
 * 远端租约视图（M3 同步接线修复 / Issue #34）。
 *
 * 租约表本身是每个副本私有的可变协调态（`execution_leases` 按 dataDir 打开）；跨设备
 * 可见的只有账本事件。本模块按 `task.lease_acquired / .renewed / .released / .lost /
 * .execution_transferred` 事件重放出「每个 holder 的当前租约」，供 acquire 前的事前
 * 互斥检查使用。
 *
 * 事件语义：
 * - acquired：覆盖该 holder 的当前租约（token / expires_at）；
 * - renewed：holder+fencing_token 匹配时刷新 expires_at（远端心跳可被对端看到，
 *   否则仅凭 acquire 的 TTL 会把仍在续租的远端误判为过期）；
 * - released / lost：holder+token 匹配时清空；
 * - execution_transferred：from 侧执行权交还（清空 from），to 侧随后自行 acquire；
 * - denied：不改变状态（拒绝不是持有）。
 *
 * 时间判据使用本机时钟。跨设备时钟偏差可能把远端租约提前/延后判为过期——这是
 * 无共识协议的残余窗口，由 fencing token（副作用最终护栏）与 needs_reconcile 兜底。
 */

const LEASE_EVENT_TYPES = {
  acquired: "task.lease_acquired",
  renewed: "task.lease_renewed",
  released: "task.lease_released",
  lost: "task.lease_lost",
  transferred: "task.execution_transferred",
} as const;

/** 重放出的单条持有记录 */
export interface ReplayedLease {
  task_id: string;
  holder_replica_id: string;
  fencing_token: number;
  expires_at: string;
  acquired_at: string;
  /** 产生该持有状态的事件 id（诊断/审计用） */
  event_id: string;
  /** 该事件所在账本的来源副本（>1 跳同步时与 holder 可能不同） */
  source_replica_id: string;
  /** 本机账本 sequence（重放排序依据） */
  sequence: number;
}

interface HolderState {
  lease: ReplayedLease;
}

/**
 * 租约重放视图：
 * - `leases`：当前持有者（已释放/丢失的 holder 不在其中）；
 * - `max_granted_token`：账本中**实际发放过**的最大 fencing token；
 * - `max_reserved_token`：`task.execution_transferred.next_fencing_token` 声明的最大
 *   预留 token（转移目标应当拿到的下一个号）。
 *
 * 跨副本计数（M3 修复批 / #33）：租约表是副本私有态，各副本各自从 1 起号会让
 * 旧设备的旧 token 在新设备接管后仍然有效。调用方把这两个值喂给 LeaseStore
 * （observeGranted/ReservedToken）：取号用 max(本地 token, granted)+1，校验拒绝
 * 任何 < max(granted, reserved) 的 token。
 */
export interface LeaseView {
  leases: ReplayedLease[];
  max_granted_token: number;
  max_reserved_token: number;
}

/**
 * 按 task 重放租约事件，返回**当前持有**（holder 非 null）的记录与观察到的最大
 * token（见 LeaseView）。记录按账本 sequence 排序。
 */
export function replayLeaseView(ledger: EventLedger, taskId: string): LeaseView {
  const entries = ledger.scan({ taskId });
  const holders = new Map<string, HolderState>();
  let maxGranted = 0;
  let maxReserved = 0;
  for (const entry of entries) {
    const type = entry.envelope.event_type;
    const payload = entry.envelope.payload;
    if (
      type === LEASE_EVENT_TYPES.acquired ||
      type === LEASE_EVENT_TYPES.renewed ||
      type === LEASE_EVENT_TYPES.released ||
      type === LEASE_EVENT_TYPES.lost ||
      type === LEASE_EVENT_TYPES.transferred
    ) {
      const observed = asNumber(payload.fencing_token);
      if (observed !== null && observed > maxGranted) maxGranted = observed;
      if (type === LEASE_EVENT_TYPES.transferred) {
        const reserved = asNumber(payload.next_fencing_token);
        if (reserved !== null && reserved > maxReserved) maxReserved = reserved;
      }
    }
    if (type === LEASE_EVENT_TYPES.acquired) {
      const holder = asString(payload.holder_replica_id) ?? entry.envelope.replica_id;
      const token = asNumber(payload.fencing_token);
      const expiresAt = asString(payload.expires_at);
      if (holder === null || token === null || expiresAt === null) continue;
      holders.set(holder, {
        lease: {
          task_id: taskId,
          holder_replica_id: holder,
          fencing_token: token,
          expires_at: expiresAt,
          acquired_at: asString(payload.acquired_at) ?? entry.envelope.occurred_at,
          event_id: entry.envelope.event_id,
          source_replica_id: entry.envelope.replica_id,
          sequence: entry.sequence,
        },
      });
      continue;
    }
    if (type === LEASE_EVENT_TYPES.renewed) {
      const holder = asString(payload.holder_replica_id) ?? entry.envelope.replica_id;
      const token = asNumber(payload.fencing_token);
      const expiresAt = asString(payload.expires_at);
      if (holder === null || token === null || expiresAt === null) continue;
      const state = holders.get(holder);
      if (state === undefined) continue;
      if (state.lease.fencing_token !== token) continue;
      state.lease.expires_at = expiresAt;
      state.lease.event_id = entry.envelope.event_id;
      state.lease.sequence = entry.sequence;
      continue;
    }
    if (
      type === LEASE_EVENT_TYPES.released ||
      type === LEASE_EVENT_TYPES.lost ||
      type === LEASE_EVENT_TYPES.transferred
    ) {
      const holder = asString(payload.holder_replica_id) ?? asString(payload.from_replica_id) ?? entry.envelope.replica_id;
      if (holder === null) continue;
      const token = asNumber(payload.fencing_token);
      const state = holders.get(holder);
      if (state === undefined) continue;
      if (token !== null && state.lease.fencing_token !== token) continue;
      holders.delete(holder);
    }
  }
  return {
    leases: [...holders.values()]
      .map((state) => state.lease)
      .sort(
        (left, right) =>
          left.sequence - right.sequence || left.holder_replica_id.localeCompare(right.holder_replica_id),
      ),
    max_granted_token: maxGranted,
    max_reserved_token: maxReserved,
  };
}

/** 只取当前持有记录（replayLeaseView 的便捷包装） */
export function replayLeases(ledger: EventLedger, taskId: string): ReplayedLease[] {
  return replayLeaseView(ledger, taskId).leases;
}

/** 仅返回未过期（expires_at > now）的持有记录 */
export function activeLeases(leases: ReplayedLease[], now: Date): ReplayedLease[] {
  const nowMs = now.getTime();
  return leases.filter((lease) => Date.parse(lease.expires_at) > nowMs);
}

/** 其他副本持有的未过期租约（排除本机） */
export function findRemoteActiveLease(
  leases: ReplayedLease[],
  selfReplicaId: string,
  now: Date,
): ReplayedLease | null {
  return activeLeases(leases, now).find((lease) => lease.holder_replica_id !== selfReplicaId) ?? null;
}

/**
 * 双持有证据：重放后仍有 ≥2 个副本持有未过期租约（近同时 acquire 的事后确认）。
 * 返回结构与 detectDualExecution 同一协议类型，直接交给 TaskService.flagNeedsReconcile。
 */
export function detectDualLeaseHold(
  ledger: EventLedger,
  taskId: string,
  now: Date,
): ExecutionReconcileEvidence | null {
  const active = activeLeases(replayLeases(ledger, taskId), now);
  const holders = [...new Set(active.map((lease) => lease.holder_replica_id))].sort();
  if (holders.length < 2) return null;
  const entries = ledger.scan({ taskId });
  const sources: ReconcileEvidenceSource[] = holders.map((holder) => {
    const lease = active.find((candidate) => candidate.holder_replica_id === holder) as ReplayedLease;
    const related = entries.filter(
      (entry) =>
        entry.envelope.event_type.startsWith("task.lease_") ||
        entry.envelope.event_type === LEASE_EVENT_TYPES.transferred,
    );
    return {
      replica_id: holder,
      sources: [...new Set(related.map((entry) => entry.envelope.event_type))].sort(),
      event_count: related.filter((entry) => holderOf(entry) === holder).length,
      first_sequence: lease.sequence,
      last_sequence: related.reduce((max, entry) => Math.max(max, entry.sequence), lease.sequence),
      task_versions: [],
    };
  });
  return {
    task_id: taskId,
    replicas: holders,
    independent_replicas: holders,
    sources,
    transfers: [],
    reasons: ["dual_lease_hold"],
  };
}

function holderOf(entry: LedgerEntry): string | null {
  return asString(entry.envelope.payload.holder_replica_id) ?? entry.envelope.replica_id;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
