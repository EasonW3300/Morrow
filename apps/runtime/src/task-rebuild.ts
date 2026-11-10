import type {
  NodeResources,
  SideEffectClass,
  TaskNodeStatus,
  TaskStatus,
} from "@morrow/protocol";
import type { EventLedger, LedgerEntry } from "./ledger.ts";
import type { TaskStore } from "./tasks.ts";

/**
 * 任务投影重建（M3 修复批 / Issue #32 #36，PRD §4.3 FR-TASK-2、§4.6 FR-DEP-3/4）。
 *
 * tasks / task_nodes / task_edges 是**事件账本的派生投影**（与 memory/rebuild.ts 同一
 * 模式）：task.* 事件按账本 sequence 重放即可重建任务列表与详情。跨副本同步只传事件，
 * 所以对端收到任务事件后必须重建投影，否则 GET /v1/tasks 为空、GET /v1/tasks/:id 404。
 *
 * 重放口径（与 TaskService / TaskScheduler 的写路径一一对应）：
 *   task.created                任务行（goal / session_id / created_at）
 *   task.planned                DAG 全量投影（payload.nodes 缺省时只改状态/版本，修订回卷路径）
 *   task.revised                修改集应用（payload.nodes 为全量投影时直接替换；旧账本按
 *                               changes.update/add/remove 尽力重放，新增节点 id 缺省用稳定派生值）
 *   task.context_supplied       目标追加「[Owner 补充] …」
 *   task.started / resumed      状态 running
 *   task.paused / waiting_input / completed / failed / cancelled / needs_reconcile
 *   task.node_started           running + attempts（清空上次结果）
 *   task.node_finished          节点终态 / pending_review + result/error
 *   task.node_taken_over|released|completed_by_owner   actor / 结果
 *
 * 取舍：重建只写投影表，**绝不**触发调度器——同步来的未完成任务只读可见，执行权仍由
 * 本地租约与 needs_reconcile 语义决定（不自动接管）。启动时不做无条件全量重建；只在
 * 「任务表为空但账本有 task.* 事件」时补建一次（runtime.ts 接线），同步导入批次末尾
 * 带 task.* 事件时重建一次。
 */

const TASK_STATUSES: readonly TaskStatus[] = [
  "created",
  "planned",
  "running",
  "paused",
  "waiting_input",
  "failed",
  "completed",
  "cancelled",
  "needs_reconcile",
];

const NODE_STATUSES: readonly TaskNodeStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "pending_review",
];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asTaskStatus(value: unknown): TaskStatus | null {
  return TASK_STATUSES.includes(value as TaskStatus) ? (value as TaskStatus) : null;
}

function asNodeStatus(value: unknown): TaskNodeStatus | null {
  return NODE_STATUSES.includes(value as TaskNodeStatus) ? (value as TaskNodeStatus) : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asSideEffect(value: unknown, fallback: SideEffectClass = "delivery_unknown"): SideEffectClass {
  return value === "reversible" ||
    value === "compensatable" ||
    value === "irreversible" ||
    value === "delivery_unknown"
    ? value
    : fallback;
}

function asResources(value: unknown): NodeResources | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as NodeResources)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface MutableTask {
  task_id: string;
  goal: string;
  status: TaskStatus;
  task_version: number;
  session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface MutableNode {
  /** 账本投影给出的真实 id；旧版 task.revised 的 add 项未带 id 时为 null（派生稳定值） */
  node_id: string | null;
  key: string;
  title: string;
  goal: string | null;
  agent_role: string | null;
  model: string | null;
  retriable: boolean;
  side_effect: SideEffectClass;
  resources: NodeResources | null;
  status: TaskNodeStatus;
  actor: "owner" | null;
  attempts: number;
  result: string | null;
  error: string | null;
  depends_on: string[];
  seq: number;
  created_at: string;
  updated_at: string;
}

interface MutableTaskState {
  task: MutableTask;
  nodes: Map<string, MutableNode>;
}

export interface TaskReplayState {
  tasks: Map<string, MutableTaskState>;
  /** 重放的 task.* 事件数（不含 task.checkpoint_* 等非任务投影事件也计入：它们仍是 task.*） */
  replayedEvents: number;
}

/** 纯重放：不触库，便于单测、一致性校验与幂等断言 */
export function replayTaskEvents(entries: LedgerEntry[]): TaskReplayState {
  const tasks = new Map<string, MutableTaskState>();
  let replayedEvents = 0;

  const ensureTask = (taskId: string, occurredAt: string, payload: Record<string, unknown>): MutableTaskState => {
    const existing = tasks.get(taskId);
    if (existing !== undefined) return existing;
    const created: MutableTaskState = {
      task: {
        task_id: taskId,
        goal: asString(payload.goal) ?? "",
        status: "created",
        task_version: 1,
        session_id: asString(payload.session_id),
        error: null,
        created_at: occurredAt,
        updated_at: occurredAt,
      },
      nodes: new Map(),
    };
    tasks.set(taskId, created);
    return created;
  };

  const ensureNode = (
    state: MutableTaskState,
    payload: Record<string, unknown>,
    occurredAt: string,
    nodeIdHint?: string | null,
  ): MutableNode => {
    const nodeId = nodeIdHint ?? asString(payload.node_id);
    const key = asString(payload.key) ?? nodeId ?? `node-${state.nodes.size + 1}`;
    for (const node of state.nodes.values()) {
      if (node.node_id !== null && nodeId !== null && node.node_id === nodeId) return node;
    }
    const existing = state.nodes.get(key);
    if (existing !== undefined) {
      if (existing.node_id === null && nodeId !== null) existing.node_id = nodeId;
      return existing;
    }
    const created: MutableNode = {
      node_id: nodeId,
      key,
      title: asString(payload.title) ?? key,
      goal: asString(payload.goal),
      agent_role: asString(payload.agent_role),
      model: asString(payload.model),
      retriable: asBoolean(payload.retriable, true),
      side_effect: asSideEffect(payload.side_effect),
      resources: asResources(payload.resources),
      status: "pending",
      actor: null,
      attempts: 0,
      result: null,
      error: null,
      depends_on: asStringArray(payload.depends_on),
      seq: state.nodes.size,
      created_at: occurredAt,
      updated_at: occurredAt,
    };
    state.nodes.set(key, created);
    return created;
  };

  /** 全量节点投影（计划 / 修订快照）：以 payload.nodes 为准替换节点集合 */
  const applyNodeProjection = (
    state: MutableTaskState,
    value: unknown,
    occurredAt: string,
  ): void => {
    if (!Array.isArray(value)) return;
    const seen = new Set<string>();
    value.forEach((raw, index) => {
      if (typeof raw !== "object" || raw === null) return;
      const record = raw as Record<string, unknown>;
      const nodeId = asString(record.node_id);
      const key = asString(record.key);
      if (key === null) return;
      seen.add(key);
      const node = ensureNode(state, record, occurredAt, nodeId);
      node.node_id = nodeId ?? node.node_id;
      node.key = key;
      node.title = asString(record.title) ?? node.title;
      node.goal = asString(record.goal);
      node.agent_role = asString(record.agent_role);
      node.model = asString(record.model);
      node.retriable = asBoolean(record.retriable, node.retriable);
      node.side_effect = asSideEffect(record.side_effect, node.side_effect);
      node.resources = asResources(record.resources);
      node.status = asNodeStatus(record.status) ?? node.status;
      node.actor = record.actor === "owner" ? "owner" : null;
      node.attempts = asPositiveInt(record.attempts) ?? node.attempts;
      node.result = asString(record.result);
      node.error = asString(record.error);
      node.depends_on = asStringArray(record.depends_on);
      node.seq = index;
      node.updated_at = occurredAt;
    });
    for (const key of [...state.nodes.keys()]) {
      if (!seen.has(key)) state.nodes.delete(key);
    }
  };

  /** 旧账本修订重放：changes.update/add/remove 尽力应用（无 payload.nodes 时） */
  const applyRevisionChanges = (
    state: MutableTaskState,
    changes: Record<string, unknown>,
    occurredAt: string,
  ): void => {
    const update = Array.isArray(changes.update) ? changes.update : [];
    for (const raw of update) {
      if (typeof raw !== "object" || raw === null) continue;
      const change = raw as Record<string, unknown>;
      const key = asString(change.key);
      if (key === null) continue;
      const node = ensureNode(state, { key }, occurredAt);
      if (typeof change.title === "string") node.title = change.title;
      if (change.goal === null) node.goal = null;
      else if (typeof change.goal === "string") node.goal = change.goal;
      if (change.agent_role === null) node.agent_role = null;
      else if (typeof change.agent_role === "string") node.agent_role = change.agent_role;
      if (change.model === null) node.model = null;
      else if (typeof change.model === "string") node.model = change.model;
      if (typeof change.retriable === "boolean") node.retriable = change.retriable;
      if (typeof change.side_effect === "string") node.side_effect = asSideEffect(change.side_effect, node.side_effect);
      if (change.depends_on !== undefined) node.depends_on = asStringArray(change.depends_on);
      node.status = "pending";
      node.result = null;
      node.error = null;
      node.updated_at = occurredAt;
    }
    const add = Array.isArray(changes.add) ? changes.add : [];
    for (const raw of add) {
      if (typeof raw !== "object" || raw === null) continue;
      const addition = raw as Record<string, unknown>;
      const key = asString(addition.key);
      if (key === null) continue;
      const node = ensureNode(state, addition, occurredAt);
      node.seq = state.nodes.size;
      node.status = "pending";
      node.result = null;
      node.error = null;
      node.updated_at = occurredAt;
    }
    for (const key of asStringArray(changes.remove)) state.nodes.delete(key);
  };

  for (const entry of entries) {
    const envelope = entry.envelope;
    if (!envelope.event_type.startsWith("task.")) continue;
    const taskId = typeof envelope.task_id === "string" ? envelope.task_id : null;
    if (taskId === null || taskId.length === 0) continue;
    const payload = envelope.payload as Record<string, unknown>;
    const occurredAt = envelope.occurred_at;
    const state = ensureTask(taskId, occurredAt, payload);
    const task = state.task;
    replayedEvents += 1;

    switch (envelope.event_type) {
      case "task.created": {
        if (typeof payload.goal === "string" && payload.goal.length > 0) task.goal = payload.goal;
        if (payload.session_id === null) task.session_id = null;
        else if (typeof payload.session_id === "string") task.session_id = payload.session_id;
        if (task.status === "created") task.created_at = occurredAt;
        break;
      }
      case "task.planned": {
        applyNodeProjection(state, payload.nodes, occurredAt);
        task.status = "planned";
        task.task_version = asPositiveInt(payload.task_version) ?? task.task_version;
        task.error = null;
        break;
      }
      case "task.started":
      case "task.resumed": {
        task.status = "running";
        task.error = null;
        break;
      }
      case "task.paused": {
        task.status = "paused";
        break;
      }
      case "task.waiting_input": {
        task.status = "waiting_input";
        break;
      }
      case "task.completed": {
        task.status = "completed";
        task.error = null;
        break;
      }
      case "task.failed": {
        task.status = "failed";
        task.error = asString(payload.error) ?? asString(payload.message) ?? task.error;
        break;
      }
      case "task.cancelled": {
        task.status = "cancelled";
        break;
      }
      case "task.needs_reconcile": {
        task.status = "needs_reconcile";
        break;
      }
      case "task.reconciled": {
        // 裁决审计本身不改状态；随后的 task.completed / task.failed 迁移落状态
        break;
      }
      case "task.revised": {
        task.task_version = asPositiveInt(payload.task_version) ?? task.task_version;
        if (Array.isArray(payload.nodes)) {
          applyNodeProjection(state, payload.nodes, occurredAt);
        } else if (typeof payload.changes === "object" && payload.changes !== null) {
          applyRevisionChanges(state, payload.changes as Record<string, unknown>, occurredAt);
        }
        break;
      }
      case "task.context_supplied": {
        const context = asString(payload.context);
        const suffix = context === null ? null : `[Owner 补充] ${context}`;
        if (suffix === null) break;
        if (payload.target === "node") {
          const nodeId = asString(payload.node_id);
          const key = asString(payload.key);
          for (const node of state.nodes.values()) {
            if ((nodeId !== null && node.node_id === nodeId) || (key !== null && node.key === key)) {
              node.goal = `${node.goal ?? node.title}\n\n${suffix}`;
              node.updated_at = occurredAt;
              break;
            }
          }
        } else {
          task.goal = `${task.goal}\n\n${suffix}`;
        }
        break;
      }
      case "task.node_started": {
        const node = ensureNode(state, payload, occurredAt);
        node.status = "running";
        node.attempts = asPositiveInt(payload.attempt) ?? node.attempts;
        node.result = null;
        node.error = null;
        node.updated_at = occurredAt;
        break;
      }
      case "task.node_finished": {
        const node = ensureNode(state, payload, occurredAt);
        node.status = asNodeStatus(payload.status) ?? node.status;
        node.attempts = asPositiveInt(payload.attempt) ?? node.attempts;
        if (typeof payload.result === "string") node.result = payload.result;
        if (typeof payload.error === "string") node.error = payload.error;
        node.updated_at = occurredAt;
        break;
      }
      case "task.node_taken_over": {
        const node = ensureNode(state, payload, occurredAt);
        node.actor = "owner";
        node.updated_at = occurredAt;
        break;
      }
      case "task.node_released": {
        const node = ensureNode(state, payload, occurredAt);
        node.actor = null;
        node.updated_at = occurredAt;
        break;
      }
      case "task.node_completed_by_owner": {
        const node = ensureNode(state, payload, occurredAt);
        node.status = "completed";
        if (typeof payload.result === "string") node.result = payload.result;
        node.error = null;
        node.updated_at = occurredAt;
        break;
      }
      default:
        // task.planning_failed / lease_* / execution_transferred / merged / merge_conflict /
        // checkpoint_* 不改变任务/节点投影（node_finished 已承载 pending_review 的结果）。
        break;
    }
    task.updated_at = occurredAt;
  }

  return { tasks, replayedEvents };
}

/** 稳定派生 node_id（旧版 task.revised add 项无 id 时的兜底；仅影响新副本的节点标识） */
function derivedNodeId(taskId: string, key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = `${taskId}\u0000${key}`;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ code, 0x85ebca6b) >>> 0) + i;
    h2 >>>= 0;
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface TaskProjectionTaskRow {
  task_id: string;
  goal: string;
  status: TaskStatus;
  task_version: number;
  session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskProjectionNodeRow {
  node_id: string;
  task_id: string;
  node_key: string;
  title: string;
  goal: string | null;
  agent_role: string | null;
  model: string | null;
  retriable: number;
  side_effect: string;
  status: TaskNodeStatus;
  actor: string | null;
  resources: string | null;
  attempts: number;
  result: string | null;
  error: string | null;
  node_seq: number;
  created_at: string;
  updated_at: string;
}

export interface TaskProjectionEdgeRow {
  edge_id: string;
  task_id: string;
  from_node: string;
  to_node: string;
}

export interface TaskProjectionSnapshot {
  tasks: TaskProjectionTaskRow[];
  nodes: TaskProjectionNodeRow[];
  edges: TaskProjectionEdgeRow[];
}

/** 纯重放结果 → 可落库快照（任务按创建时间、节点按 (task, seq) 的稳定顺序） */
export function snapshotFromTaskReplay(state: TaskReplayState): TaskProjectionSnapshot {
  const taskStates = [...state.tasks.values()].sort(
    (left, right) =>
      left.task.created_at.localeCompare(right.task.created_at) ||
      left.task.task_id.localeCompare(right.task.task_id),
  );
  const tasks: TaskProjectionTaskRow[] = [];
  const nodes: TaskProjectionNodeRow[] = [];
  const edges: TaskProjectionEdgeRow[] = [];
  for (const taskState of taskStates) {
    const task = taskState.task;
    tasks.push({ ...task });
    const nodeList = [...taskState.nodes.values()].sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key));
    const idOf = new Map<string, string>();
    for (const node of nodeList) {
      idOf.set(node.key, node.node_id ?? derivedNodeId(task.task_id, node.key));
    }
    nodeList.forEach((node, index) => {
      const nodeId = idOf.get(node.key) as string;
      nodes.push({
        node_id: nodeId,
        task_id: task.task_id,
        node_key: node.key,
        title: node.title,
        goal: node.goal,
        agent_role: node.agent_role,
        model: node.model,
        retriable: node.retriable ? 1 : 0,
        side_effect: node.side_effect,
        status: node.status,
        actor: node.actor,
        resources: node.resources === null ? null : JSON.stringify(node.resources),
        attempts: node.attempts,
        result: node.result,
        error: node.error,
        node_seq: index,
        created_at: node.created_at,
        updated_at: node.updated_at,
      });
      for (const dependency of node.depends_on) {
        const fromId = idOf.get(dependency);
        if (fromId === undefined) continue;
        edges.push({
          edge_id: `edge:${task.task_id}:${dependency}:${node.key}`,
          task_id: task.task_id,
          from_node: fromId,
          to_node: nodeId,
        });
      }
    });
  }
  return { tasks, nodes, edges };
}

export interface TaskRebuildResult {
  tasks: number;
  nodes: number;
  edges: number;
  /** 参与重放的 task.* 事件数 */
  replayedEvents: number;
}

/** 从账本按序重放 task.* 事件并整体替换任务投影（tasks / task_nodes / task_edges） */
export function rebuildTaskProjection(deps: { store: Pick<TaskStore, "replaceTaskProjection">; ledger: EventLedger }): TaskRebuildResult {
  const state = replayTaskEvents(deps.ledger.scan());
  const snapshot = snapshotFromTaskReplay(state);
  deps.store.replaceTaskProjection(snapshot);
  return {
    tasks: snapshot.tasks.length,
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
    replayedEvents: state.replayedEvents,
  };
}

/** 投影重建器（runtime 内的可复用句柄；绑定 TaskService 的私有 store） */
export class TaskProjectionRebuilder {
  readonly #rebuild: () => TaskRebuildResult;
  #lastResult: TaskRebuildResult | null = null;

  constructor(rebuild: () => TaskRebuildResult) {
    this.#rebuild = rebuild;
  }

  get lastResult(): TaskRebuildResult | null {
    return this.#lastResult;
  }

  rebuild(): TaskRebuildResult {
    const result = this.#rebuild();
    this.#lastResult = result;
    return result;
  }
}
