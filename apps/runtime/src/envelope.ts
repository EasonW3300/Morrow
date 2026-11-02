import { computeIntegrityHash, type ActorId, type EventEnvelope } from "@morrow/protocol";
import { uuidv7 } from "./uuid-v7.ts";

/**
 * 事件信封工厂：runtime 内所有事件写入账本前的统一出口（T2 生命周期事件 + T4 会话事件族
 * + M1-T4 任务事件族）。integrity_hash 在此按 protocol 规则复算；账本层再校验一遍（双重防线）。
 */
export function buildEventEnvelope(input: {
  replicaId: string;
  actorId: ActorId;
  eventType: string;
  sessionId?: string | null;
  /** 关联任务 id（M1-T4 起；非任务事件缺省，信封不携带该字段） */
  taskId?: string | null;
  payload: Record<string, unknown>;
  causationId?: string | null;
}): EventEnvelope {
  const envelope: EventEnvelope = {
    event_id: uuidv7(),
    replica_id: input.replicaId,
    actor_id: input.actorId,
    ...(input.sessionId !== undefined && input.sessionId !== null ? { session_id: input.sessionId } : {}),
    ...(input.taskId !== undefined && input.taskId !== null ? { task_id: input.taskId } : {}),
    event_type: input.eventType,
    occurred_at: new Date().toISOString(),
    causation_id: input.causationId ?? null,
    schema_version: 1,
    payload: input.payload,
    integrity_hash: "",
  };
  envelope.integrity_hash = computeIntegrityHash(envelope);
  return envelope;
}
