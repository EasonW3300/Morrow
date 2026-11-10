import type {
  ExecutionReconcileEvidence,
  ExecutionTransferRecord,
  ReconcileEvidenceSource,
} from "@morrow/protocol";
import type { EventLedger, LedgerEntry } from "../ledger.ts";

/**
 * 双端独立执行检测（M3-T4 / Issue #33，FR-DEP-4）。
 *
 * 判定依据（只读账本，不改状态）：
 * - 同一 task_id 的账本里存在 ≥2 个不同 replica 的执行证据（task.started /
 *   task.node_started / task.completed）；或
 * - ≥2 个不同 replica 各自推进过 task_version（task.revised 事件）。
 *
 * 显式执行权转移（task.execution_transferred）会授权目标副本接管：若某副本的全部
 * 执行证据都发生在其作为转移目标的事件之后，则不计入「独立执行」——合法的
 * A→B 转移不会被误报。跨副本事件导入顺序可能与本机 sequence 不一致，本检测用本机
 * 账本 sequence 作为先后判据（同步层按来源 sequence 保序导入）；这是已知边界。
 *
 * 返回 null = 无冲突证据；否则返回两侧证据（含两侧 replica、来源事件与转移记录），
 * 由调用方把任务置 needs_reconcile 并原样写进 task.needs_reconcile 事件——不自动
 * 合并任何一侧的结果。
 */

const EXECUTION_EVENT_TYPES = new Set(["task.started", "task.node_started", "task.completed"]);
const VERSION_EVENT_TYPES = new Set(["task.revised"]);
const TRANSFER_EVENT_TYPE = "task.execution_transferred";

interface ReplicaEvidence {
  sources: Set<string>;
  eventCount: number;
  firstSequence: number;
  lastSequence: number;
  taskVersions: number[];
  executionSequences: number[];
}

export function detectDualExecution(ledger: EventLedger, taskId: string): ExecutionReconcileEvidence | null {
  const entries = ledger.scan({ taskId });
  const byReplica = new Map<string, ReplicaEvidence>();
  const transfers: ExecutionTransferRecord[] = [];

  const ensure = (replicaId: string): ReplicaEvidence => {
    const existing = byReplica.get(replicaId);
    if (existing !== undefined) return existing;
    const created: ReplicaEvidence = {
      sources: new Set<string>(),
      eventCount: 0,
      firstSequence: Number.POSITIVE_INFINITY,
      lastSequence: -1,
      taskVersions: [],
      executionSequences: [],
    };
    byReplica.set(replicaId, created);
    return created;
  };

  for (const entry of entries) {
    const eventType = entry.envelope.event_type;
    if (eventType === TRANSFER_EVENT_TYPE) {
      transfers.push(transferOf(entry));
      continue;
    }
    const isExecution = EXECUTION_EVENT_TYPES.has(eventType);
    const isVersion = VERSION_EVENT_TYPES.has(eventType);
    if (!isExecution && !isVersion) continue;
    const replicaId = entry.envelope.replica_id;
    const evidence = ensure(replicaId);
    evidence.sources.add(eventType);
    evidence.eventCount += 1;
    evidence.firstSequence = Math.min(evidence.firstSequence, entry.sequence);
    evidence.lastSequence = Math.max(evidence.lastSequence, entry.sequence);
    if (isExecution) evidence.executionSequences.push(entry.sequence);
    if (isVersion) {
      const version = entry.envelope.payload.task_version;
      if (typeof version === "number" && Number.isInteger(version) && !evidence.taskVersions.includes(version)) {
        evidence.taskVersions.push(version);
      }
    }
  }

  const replicas = [...byReplica.keys()].sort();
  if (replicas.length < 2) return null;

  // 转移目标副本：仅当其执行证据全部发生在「首次被指定为目标」之后才视为授权接管
  const transferTargetSequences = new Map<string, number[]>();
  for (const transfer of transfers) {
    const list = transferTargetSequences.get(transfer.to_replica_id) ?? [];
    list.push(transfer.sequence);
    transferTargetSequences.set(transfer.to_replica_id, list);
  }
  const independentExecutionReplicas = replicas.filter((replicaId) => {
    const evidence = byReplica.get(replicaId) as ReplicaEvidence;
    if (evidence.executionSequences.length === 0) return false;
    const targetSequences = transferTargetSequences.get(replicaId);
    if (targetSequences === undefined) return true;
    const firstTarget = Math.min(...targetSequences);
    return evidence.executionSequences.some((sequence) => sequence < firstTarget);
  });
  const versionReplicas = replicas.filter((replicaId) => {
    const evidence = byReplica.get(replicaId) as ReplicaEvidence;
    return evidence.taskVersions.length > 0;
  });

  const reasons: string[] = [];
  if (independentExecutionReplicas.length >= 2) reasons.push("dual_execution");
  if (versionReplicas.length >= 2) reasons.push("task_version_diverged");
  if (reasons.length === 0) return null;

  const independent = new Set<string>(independentExecutionReplicas);
  for (const replicaId of versionReplicas) independent.add(replicaId);

  const sources: ReconcileEvidenceSource[] = replicas.map((replicaId) => {
    const evidence = byReplica.get(replicaId) as ReplicaEvidence;
    return {
      replica_id: replicaId,
      sources: [...evidence.sources].sort(),
      event_count: evidence.eventCount,
      first_sequence: evidence.firstSequence === Number.POSITIVE_INFINITY ? 0 : evidence.firstSequence,
      last_sequence: evidence.lastSequence,
      task_versions: [...evidence.taskVersions].sort((a, b) => a - b),
    };
  });

  return {
    task_id: taskId,
    replicas,
    independent_replicas: [...independent].sort(),
    sources,
    transfers: transfers.sort((a, b) => a.sequence - b.sequence),
    reasons,
  };
}

function transferOf(entry: LedgerEntry): ExecutionTransferRecord {
  const payload = entry.envelope.payload;
  const from = typeof payload.from_replica_id === "string" ? payload.from_replica_id : "";
  const to = typeof payload.to_replica_id === "string" ? payload.to_replica_id : "";
  const token = typeof payload.fencing_token === "number" ? payload.fencing_token : undefined;
  return {
    from_replica_id: from,
    to_replica_id: to,
    sequence: entry.sequence,
    ...(token === undefined ? {} : { fencing_token: token }),
  };
}
