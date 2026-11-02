import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AgentRuntime, AgentStopReason } from "@morrow/pi-adapter";
import type {
  SideEffectClass,
  TaskDetail,
  TaskNodeRecord,
  TaskStatus,
  TaskSummary,
} from "@morrow/protocol";
import { buildEventEnvelope } from "./envelope.ts";
import { DB_FILE_NAME, type EventLedger, type LedgerPage } from "./ledger.ts";
import type { ProviderResolver } from "./providers.ts";
import { ensureTaskTables } from "./task-migrations.ts";
import { openSqlite, type SqliteDatabase, type SqliteStatement } from "./db.ts";
import { uuidv7 } from "./uuid-v7.ts";

/**
 * 任务域（票 M1-T4 / Issue #16，PRD §4.3 FR-TASK-1/2/6、决策稿 §6 状态机；
 * M1-T6 / Issue #18 扩展人工介入：revise / takeover / complete / release）。
 *
 * 职责分界：
 * - TaskStore：tasks/task_nodes/task_edges 可变投影表（迁移见 task-migrations.ts）；
 * - TaskService：任务生命周期——建任务 + 规划（经 PiAdapter 接口，FR-TASK-1）、
 *   DAG 存取投影、任务级状态机与 task.* 事件族（FR-TASK-2）、人工介入操作
 *   （FR-TASK-3：修改未完成节点 / 接管子任务 / 提交结果 / 交还，全部以 owner
 *   actor 留审计事件）；
 * - 节点执行与调度在 scheduler.ts（节点行更新经 TaskService 的窄接缝写入）。
 *
 * 规划（FR-TASK-1）：目标描述 → Agent Loop（系统提示词要求只输出 JSON 计划）→
 * 累积 text 全文 → 剥代码围栏 → JSON Schema 校验（ajv 2020-12）→ 语义校验
 * （key 唯一 / 依赖可解析 / 无环）→ DAG 落表 + task.planned 事件。坏输出不抛给
 * 客户端：task.planning_failed（错误事件）+ task.failed 状态迁移，任务以 failed
 * 状态存在，全程留痕。
 *
 * 状态机（决策稿 §6，本票实现除 needs_reconcile 外全部）：
 *   created → planned | failed | cancelled
 *   planned → running | failed | cancelled
 *   running → paused | waiting_input | failed | completed | cancelled
 *   paused | waiting_input → running | failed | cancelled
 *   failed | completed | cancelled → （终端态，拒绝一切迁移）
 * paused→running / waiting_input→running 的恢复事件是 task.resumed（不是再次 started）。
 * 人工介入（M1-T6）：revise 是终端态回卷的正道——failed 任务经 reviseTask 回卷为
 * planned（不走 transition 表，terminal 直接迁移依旧全部拒绝）；running 任务 revise
 * 被拒（PRD §5.2 流程 2：先暂停再修改）；completed/cancelled 不可逆拒绝。
 * supplyContext（FR-TASK-3「补充上下文」）：context 追加节点描述/任务目标，DAG 不变
 * 不升版本；waiting_input 的自动重驱动在 HTTP 层经 scheduler.kick 完成。
 * takeover：节点 actor=owner，调度器跳过派发；Owner 经 complete 提交结果或 release
 * 交还调度，全部操作留 owner actor 审计事件（AC-12 前置）。
 */

/** 任务事件族（event_type 清单只增不减；点分风格同 PRD §6.3） */
export const TASK_EVENT_TYPES = {
  taskCreated: "task.created",
  taskPlanned: "task.planned",
  taskStarted: "task.started",
  taskResumed: "task.resumed",
  taskNodeStarted: "task.node_started",
  taskNodeFinished: "task.node_finished",
  taskPaused: "task.paused",
  taskWaitingInput: "task.waiting_input",
  taskCompleted: "task.completed",
  taskFailed: "task.failed",
  taskCancelled: "task.cancelled",
  taskPlanningFailed: "task.planning_failed",
  // M1-T6 人工介入族（actor 一律 owner——AC-12 审计前置）
  taskRevised: "task.revised",
  taskContextSupplied: "task.context_supplied",
  taskNodeTakenOver: "task.node_taken_over",
  taskNodeReleased: "task.node_released",
  taskNodeCompletedByOwner: "task.node_completed_by_owner",
} as const;

/**
 * Checkpoint 域事件族（M1-T5 / Issue #17；定义在 checkpoint.ts，此处 re-export 保持
 * 「任务事件清单只增不减」的单一查阅点）。
 */
export { TASK_CHECKPOINT_EVENT_TYPES } from "./checkpoint.ts";

/** 合法迁移表（含义见文件头）；测试逐项覆盖 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ["planned", "failed", "cancelled"],
  planned: ["running", "failed", "cancelled"],
  running: ["paused", "waiting_input", "failed", "completed", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  waiting_input: ["running", "failed", "cancelled"],
  failed: [],
  completed: [],
  cancelled: [],
};

/** 状态 → 事件类型（running 的恢复路径在 transition 内特判为 task.resumed） */
const STATUS_EVENT_TYPES: Record<TaskStatus, string> = {
  created: TASK_EVENT_TYPES.taskCreated,
  planned: TASK_EVENT_TYPES.taskPlanned,
  running: TASK_EVENT_TYPES.taskStarted,
  paused: TASK_EVENT_TYPES.taskPaused,
  waiting_input: TASK_EVENT_TYPES.taskWaitingInput,
  failed: TASK_EVENT_TYPES.taskFailed,
  completed: TASK_EVENT_TYPES.taskCompleted,
  cancelled: TASK_EVENT_TYPES.taskCancelled,
};

export type TaskErrorCode =
  | "invalid_transition"
  | "not_found"
  | "planner_unavailable"
  | "invalid_plan"
  | "invalid_revision"
  | "immutable_node"
  | "timeout";

export class TaskError extends Error {
  readonly code: TaskErrorCode;
  readonly details?: unknown;

  constructor(code: TaskErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "TaskError";
    this.code = code;
    this.details = details;
  }
}

/** 规划器工厂：goal → 一次规划用的 AgentRuntime（生产 = PiAdapter + 规划系统提示词；测试 = FakePi 脚本） */
export type PlannerFactory = (goal: string) => Promise<AgentRuntime>;

/** 规划器输出的节点（schema 校验前的原始形态；可选项在 validatePlannedDag 里补默认） */
export interface PlannedNodeInput {
  key: string;
  title: string;
  goal?: string;
  depends_on?: string[];
  agent_role?: string;
  model?: string;
  retriable?: boolean;
  side_effect?: SideEffectClass;
}

/** 归一后的规划节点（retriable/side_effect/depends_on 已补默认；落表与调度消费此形态） */
export interface PlannedNode {
  key: string;
  title: string;
  goal?: string;
  depends_on: string[];
  agent_role?: string;
  model?: string;
  retriable: boolean;
  side_effect: SideEffectClass;
}

export interface PlannedDag {
  nodes: PlannedNode[];
}

// --- 人工介入：修订修改集（M1-T6 / FR-TASK-3）------------------------------------

/** 节点 key 模式（与规划 schema 一致：小写字母数字开头，短标识） */
export const NODE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 节点修改（update 项）：仅声明的字段被改；depends_on 全量替换；goal/model/
 * agent_role 显式传 null 清除（goal 清除后执行时回退 title）。
 */
export interface TaskRevisionChange {
  key: string;
  title?: string;
  goal?: string | null;
  model?: string | null;
  agent_role?: string | null;
  depends_on?: string[];
  retriable?: boolean;
  side_effect?: SideEffectClass;
}

/** 新增节点（add 项；retriable/side_effect 缺省与规划一致：true / delivery_unknown） */
export interface TaskRevisionAdd {
  key: string;
  title: string;
  goal?: string;
  model?: string;
  agent_role?: string;
  depends_on?: string[];
  retriable?: boolean;
  side_effect?: SideEffectClass;
}

/** POST /v1/tasks/:id/revise 修改集（update/add/remove 至少一项） */
export interface TaskRevision {
  update?: TaskRevisionChange[];
  add?: TaskRevisionAdd[];
  remove?: string[];
}

export interface ReviseTaskResult {
  task: TaskDetail;
  revision: {
    task_version: number;
    updated_keys: string[];
    added_keys: string[];
    removed_keys: string[];
    /** failed 任务修订回卷 planned 时为 true */
    status_rolled_back: boolean;
    event_id: string;
    sequence: number;
  };
}

interface ValidatedRevision {
  update: Array<Required<Pick<TaskRevisionChange, "key">> & TaskRevisionChange>;
  add: TaskRevisionAdd[];
  removedKeys: string[];
  /** 现存节点 key → 记录（update/remove 目标解析） */
  existing: Map<string, TaskNodeRecord>;
  /** key → node_id（update/add 的 depends_on 落边解析；add 项在插入时回填） */
  keyId: Map<string, string>;
}

/**
 * 修订修改集校验（纯函数）：空修改集 / 未知与重复 key / key 模式 / 空 title、goal /
 * 依赖可解析（对照修改后的 key 集）/ 自依赖 / 成环（Kahn，复用规划期口径）逐一拒绝；
 * 已完成节点出现在 update/remove → immutable_node。产出归一化修改集供应用层执行。
 */
export function validateRevision(detail: TaskDetail, revision: TaskRevision): ValidatedRevision {
  const update = [...(revision.update ?? [])];
  const add = [...(revision.add ?? [])];
  const remove = [...(revision.remove ?? [])];
  if (update.length === 0 && add.length === 0 && remove.length === 0) {
    throw new TaskError("invalid_revision", "revision must contain at least one of update/add/remove");
  }
  const existing = new Map(detail.nodes.map((n) => [n.key, n]));
  const keyId = new Map(detail.nodes.map((n) => [n.key, n.node_id]));
  const seen = new Set<string>();
  const claim = (key: string, source: string): void => {
    if (seen.has(key)) {
      throw new TaskError("invalid_revision", `node "${key}" appears in more than one change (${source})`);
    }
    seen.add(key);
  };
  for (const change of update) {
    claim(change.key, "update");
    const target = existing.get(change.key);
    if (target === undefined) {
      throw new TaskError("invalid_revision", `update references unknown node "${change.key}"`);
    }
    if (target.status === "completed") {
      throw new TaskError("immutable_node", `node "${change.key}" is completed and cannot be revised`);
    }
    if (change.title !== undefined && change.title.trim().length === 0) {
      throw new TaskError("invalid_revision", `update "${change.key}": title must be non-empty`);
    }
    if (change.goal !== undefined && change.goal !== null && change.goal.trim().length === 0) {
      throw new TaskError("invalid_revision", `update "${change.key}": goal must be non-empty when present`);
    }
  }
  for (const key of remove) {
    claim(key, "remove");
    const target = existing.get(key);
    if (target === undefined) {
      throw new TaskError("invalid_revision", `remove references unknown node "${key}"`);
    }
    if (target.status === "completed") {
      throw new TaskError("immutable_node", `node "${key}" is completed and cannot be removed`);
    }
  }
  for (const node of add) {
    claim(node.key, "add");
    if (!NODE_KEY_RE.test(node.key)) {
      throw new TaskError("invalid_revision", `add "${node.key}": key must match ${NODE_KEY_RE.source}`);
    }
    if (existing.has(node.key)) {
      throw new TaskError("invalid_revision", `add "${node.key}": key already exists`);
    }
    if (node.title === undefined || node.title.trim().length === 0) {
      throw new TaskError("invalid_revision", `add "${node.key}": title must be non-empty`);
    }
    if (node.goal !== undefined && node.goal.trim().length === 0) {
      throw new TaskError("invalid_revision", `add "${node.key}": goal must be non-empty when present`);
    }
  }
  // 依赖解析对照「修改后」的 key 集：现存 - 移除 + 新增
  const keysAfter = new Set([...existing.keys()].filter((k) => !remove.includes(k)).concat(add.map((a) => a.key)));
  const depsOfUpdate = new Map<string, string[]>();
  for (const change of update) {
    if (change.depends_on === undefined) continue;
    assertDeps(change.key, change.depends_on, keysAfter);
    depsOfUpdate.set(change.key, change.depends_on);
  }
  for (const node of add) {
    assertDeps(node.key, node.depends_on ?? [], keysAfter);
  }
  // 成环检查（Kahn）：update 携带 depends_on 时替换原依赖，其余沿用现图
  const graph = new Map<string, string[]>();
  for (const node of detail.nodes) {
    if (remove.includes(node.key)) continue;
    graph.set(node.key, depsOfUpdate.get(node.key) ?? node.depends_on.filter((d) => !remove.includes(d)));
  }
  for (const node of add) graph.set(node.key, node.depends_on ?? []);
  assertAcyclic(graph);
  return { update, add, removedKeys: remove, existing, keyId };
}

function assertDeps(key: string, deps: string[], keysAfter: Set<string>): void {
  for (const dep of deps) {
    if (dep === key) {
      throw new TaskError("invalid_revision", `node "${key}" depends on itself`);
    }
    if (!keysAfter.has(dep)) {
      throw new TaskError("invalid_revision", `node "${key}" depends on unknown node "${dep}"`);
    }
  }
}

function assertAcyclic(graph: Map<string, string[]>): void {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [key, deps] of graph) {
    indegree.set(key, deps.length);
    for (const dep of deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), key]);
    }
  }
  let frontier = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  let visited = frontier.length;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const dependent of dependents.get(key) ?? []) {
        const d = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, d);
        if (d === 0) {
          next.push(dependent);
          visited += 1;
        }
      }
    }
    frontier = next;
  }
  if (visited !== graph.size) {
    throw new TaskError("invalid_revision", "revision would introduce a dependency cycle");
  }
}

/**
 * 规划系统提示词（生产默认工厂用；FakePi 测试不消费提示词、直接脚本化输出）。
 * 契约：只输出一个 JSON 对象（可带代码围栏），nodes ≥ 1，key task 内唯一，
 * depends_on 只引用已定义 key，不得成环。
 */
export const PLANNER_SYSTEM_PROMPT = [
  "你是 Morrow 的任务规划器。把主人的目标拆解为一个可执行的 DAG 计划。",
  "只输出一个 JSON 对象，不要输出任何解释文字，形如：",
  '{"nodes": [{"key": "短标识(小写字母数字)", "title": "节点标题", "goal": "给执行节点的指令",',
  ' "depends_on": ["依赖节点的 key"], "agent_role": "责任角色", "model": "建议模型(可选)",',
  ' "retriable": true, "side_effect": "reversible|compensatable|irreversible|delivery_unknown"}]}',
  "规则：key 在任务内唯一；depends_on 只能引用已定义的 key；不得出现环；至少一个节点。",
  "把握不大的副作用分类一律写 delivery_unknown（保守默认）。",
].join("\n");

const PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  required: ["nodes"],
  additionalProperties: false,
  properties: {
    nodes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["key", "title"],
        additionalProperties: false,
        properties: {
          key: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
          title: { type: "string", minLength: 1 },
          goal: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
          agent_role: { type: "string" },
          model: { type: "string" },
          retriable: { type: "boolean" },
          side_effect: {
            enum: ["reversible", "compensatable", "irreversible", "delivery_unknown"],
          },
        },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true });
const validatePlanOutput = ajv.compile<{ nodes: PlannedNodeInput[] }>(PLANNER_OUTPUT_SCHEMA);

/** 剥掉 ```json … ``` 围栏（生产模型最常见的违规形态）；其余原文返回 */
function stripCodeFence(text: string): string {
  const fenced = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?\s*```$/.exec(text.trim());
  return fenced !== null ? fenced[1] : text.trim();
}

/**
 * 规划输出校验：schema（ajv）+ 语义（key 唯一 / 依赖可解析 / 无环）。
 * 任何不合法 → TaskError("invalid_plan")，由 createTask 转 task.failed 留痕。
 */
export function validatePlannedDag(rawText: string): PlannedDag {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    throw new TaskError("invalid_plan", "planner output is not valid JSON");
  }
  if (!validatePlanOutput(parsed)) {
    throw new TaskError("invalid_plan", "planner output violates the plan schema", validatePlanOutput.errors ?? []);
  }
  const nodes: PlannedNodeInput[] = parsed.nodes;
  const keys = new Set<string>();
  for (const node of nodes) {
    if (keys.has(node.key)) {
      throw new TaskError("invalid_plan", `duplicate node key "${node.key}"`);
    }
    keys.add(node.key);
  }
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (dep === node.key || !keys.has(dep)) {
        throw new TaskError("invalid_plan", `node "${node.key}" depends on unknown node "${dep}"`);
      }
    }
  }
  // Kahn 拓扑排序判环
  const indegree = new Map<string, number>(nodes.map((n) => [n.key, 0]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      indegree.set(node.key, (indegree.get(node.key) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.key]);
    }
  }
  let frontier = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  let visited = frontier.length;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const dependent of dependents.get(key) ?? []) {
        const d = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, d);
        if (d === 0) {
          next.push(dependent);
          visited += 1;
        }
      }
    }
    frontier = next;
  }
  if (visited !== nodes.length) {
    throw new TaskError("invalid_plan", "plan contains a dependency cycle");
  }
  return {
    nodes: nodes.map((n) => ({
      key: n.key,
      title: n.title,
      ...(n.goal === undefined ? {} : { goal: n.goal }),
      depends_on: [...(n.depends_on ?? [])],
      ...(n.agent_role === undefined ? {} : { agent_role: n.agent_role }),
      ...(n.model === undefined ? {} : { model: n.model }),
      retriable: n.retriable ?? true,
      side_effect: n.side_effect ?? "delivery_unknown",
    })),
  };
}

/**
 * 经一次 Agent Loop 规划：订阅窄事件累积 text 全文，prompt 结束后解析校验。
 * error 事件或 stop_reason=error 视为规划失败；FakePi/真实 Pi 同构适配。
 * （累积值收在 holder 对象里：闭包内赋值 + await 后读取，避免 TS CFA 对
 * 闭包捕获变量的过窄收窄。）
 */
export async function planWithRuntime(goal: string, runtime: AgentRuntime): Promise<PlannedDag> {
  const run: { text: string; error: string | null; stopReason: AgentStopReason | null } = {
    text: "",
    error: null,
    stopReason: null,
  };
  const unsubscribe = runtime.subscribe((event) => {
    switch (event.type) {
      case "text_delta":
        run.text += event.delta;
        break;
      case "error":
        run.error = event.message;
        break;
      case "agent_end":
        run.stopReason = event.stopReason;
        break;
      default:
        break;
    }
  });
  try {
    await runtime.prompt(goal);
  } finally {
    unsubscribe();
  }
  if (run.error !== null) {
    throw new TaskError("invalid_plan", `planner run errored: ${run.error}`);
  }
  if (run.stopReason === "error") {
    throw new TaskError("invalid_plan", "planner run finished with stop_reason error");
  }
  return validatePlannedDag(run.text);
}

// --- 存储（可变投影表；迁移 DDL 在 task-migrations.ts）--------------------------

interface TaskRow {
  task_id: string;
  goal: string;
  status: string;
  task_version: number;
  session_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  node_id: string;
  task_id: string;
  node_key: string;
  title: string;
  goal: string | null;
  agent_role: string | null;
  model: string | null;
  retriable: number;
  side_effect: string;
  status: string;
  actor: string | null;
  attempts: number;
  result: string | null;
  error: string | null;
  node_seq: number;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  edge_id: string;
  task_id: string;
  from_node: string;
  to_node: string;
}

export class TaskStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertTaskStmt;
  #getTaskStmt;
  #listTasksStmt;
  #listTasksBySessionStmt;
  #updateTaskStmt;
  #bumpVersionStmt;
  #insertNodeStmt;
  #nodesOfStmt;
  #getNodeStmt;
  #updateNodeStmt;
  #updateNodePlanStmt;
  #setNodeActorStmt;
  #updateTaskGoalStmt;
  #updateNodeGoalStmt;
  #deleteNodeStmt;
  #deleteEdgesTouchingStmt;
  #deleteEdgesToStmt;
  #maxNodeSeqStmt;
  #insertEdgeStmt;
  #edgesOfStmt;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureTaskTables(db);
    this.#insertTaskStmt = db.prepare(
      "INSERT INTO tasks (task_id, goal, status, task_version, session_id, error, created_at, updated_at) VALUES (?, ?, ?, 1, ?, NULL, ?, ?)",
    );
    this.#getTaskStmt = db.prepare("SELECT * FROM tasks WHERE task_id = ?");
    this.#listTasksStmt = db.prepare("SELECT * FROM tasks ORDER BY created_at, task_id");
    this.#listTasksBySessionStmt = db.prepare(
      "SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at, task_id",
    );
    this.#updateTaskStmt = db.prepare("UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE task_id = ?");
    this.#bumpVersionStmt = db.prepare(
      "UPDATE tasks SET task_version = task_version + 1, updated_at = ? WHERE task_id = ?",
    );
    this.#insertNodeStmt = db.prepare(
      `INSERT INTO task_nodes
        (node_id, task_id, node_key, title, goal, agent_role, model, retriable, side_effect, status, attempts, result, error, node_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, ?)`,
    );
    this.#nodesOfStmt = db.prepare("SELECT * FROM task_nodes WHERE task_id = ? ORDER BY node_seq");
    this.#getNodeStmt = db.prepare("SELECT * FROM task_nodes WHERE node_id = ?");
    this.#updateNodeStmt = db.prepare(
      "UPDATE task_nodes SET status = ?, attempts = ?, result = ?, error = ?, updated_at = ? WHERE node_id = ?",
    );
    // 修订（M1-T6）：计划字段补丁 + 状态/结果/错误整体重置（修改集应用时逐字段给定）
    this.#updateNodePlanStmt = db.prepare(
      `UPDATE task_nodes SET title = ?, goal = ?, agent_role = ?, model = ?, retriable = ?,
        side_effect = ?, status = ?, result = ?, error = ?, updated_at = ? WHERE node_id = ?`,
    );
    this.#setNodeActorStmt = db.prepare(
      "UPDATE task_nodes SET actor = ?, updated_at = ? WHERE node_id = ?",
    );
    // 补充上下文（FR-TASK-3）：goal 追加，其余字段不动（DAG 不变，版本不升）
    this.#updateTaskGoalStmt = db.prepare(
      "UPDATE tasks SET goal = ?, updated_at = ? WHERE task_id = ?",
    );
    this.#updateNodeGoalStmt = db.prepare(
      "UPDATE task_nodes SET goal = ?, updated_at = ? WHERE node_id = ?",
    );
    this.#deleteNodeStmt = db.prepare("DELETE FROM task_nodes WHERE node_id = ?");
    this.#deleteEdgesTouchingStmt = db.prepare(
      "DELETE FROM task_edges WHERE task_id = ? AND (from_node = ? OR to_node = ?)",
    );
    this.#deleteEdgesToStmt = db.prepare(
      "DELETE FROM task_edges WHERE task_id = ? AND to_node = ?",
    );
    this.#maxNodeSeqStmt = db.prepare("SELECT MAX(node_seq) AS max_seq FROM task_nodes WHERE task_id = ?");
    this.#insertEdgeStmt = db.prepare(
      "INSERT INTO task_edges (edge_id, task_id, from_node, to_node) VALUES (?, ?, ?, ?)",
    );
    this.#edgesOfStmt = db.prepare("SELECT * FROM task_edges WHERE task_id = ? ORDER BY rowid");
  }

  insertTask(row: { taskId: string; goal: string; sessionId?: string; now: string }): void {
    this.#insertTaskStmt.run(row.taskId, row.goal, "created", row.sessionId ?? null, row.now, row.now);
  }

  getTask(taskId: string): TaskRow | null {
    return (this.#getTaskStmt.get(taskId) as TaskRow | undefined) ?? null;
  }

  listTasks(sessionId?: string): TaskRow[] {
    const rows =
      sessionId === undefined
        ? (this.#listTasksStmt.all() as unknown as TaskRow[])
        : (this.#listTasksBySessionStmt.all(sessionId) as unknown as TaskRow[]);
    return rows;
  }

  /** 状态推进 + 失败原因（error 仅 failed 时有值；恢复/完成清空） */
  updateTaskStatus(taskId: string, status: TaskStatus, error: string | null, now: string): void {
    this.#updateTaskStmt.run(status, status === "failed" ? error : null, now, taskId);
  }

  /** 规划修订（FR-TASK-3）：版本 +1 */
  bumpTaskVersion(taskId: string, now: string): void {
    this.#bumpVersionStmt.run(now, taskId);
  }

  insertNode(row: {
    nodeId: string;
    taskId: string;
    key: string;
    title: string;
    goal: string | null;
    agentRole: string | null;
    model: string | null;
    retriable: boolean;
    sideEffect: string;
    seq: number;
    now: string;
  }): void {
    this.#insertNodeStmt.run(
      row.nodeId,
      row.taskId,
      row.key,
      row.title,
      row.goal,
      row.agentRole,
      row.model,
      row.retriable ? 1 : 0,
      row.sideEffect,
      row.seq,
      row.now,
      row.now,
    );
  }

  insertEdge(row: { taskId: string; fromNode: string; toNode: string }): void {
    this.#insertEdgeStmt.run(uuidv7(), row.taskId, row.fromNode, row.toNode);
  }

  // --- 修订/接管的存储接缝（M1-T6）----------------------------------------------

  /** 修订应用：计划字段补丁 + 状态整体重置（修改集验证后逐字段给定） */
  updateNodePlan(
    nodeId: string,
    patch: {
      title: string;
      goal: string | null;
      agent_role: string | null;
      model: string | null;
      retriable: boolean;
      side_effect: string;
      status: string;
      result: string | null;
      error: string | null;
    },
    now: string,
  ): void {
    this.#updateNodePlanStmt.run(
      patch.title,
      patch.goal,
      patch.agent_role,
      patch.model,
      patch.retriable ? 1 : 0,
      patch.side_effect,
      patch.status,
      patch.result,
      patch.error,
      now,
      nodeId,
    );
  }

  /** 接管/交还：节点责任方标记（NULL = 调度器，'owner' = Owner） */
  setNodeActor(nodeId: string, actor: string | null, now: string): void {
    this.#setNodeActorStmt.run(actor, now, nodeId);
  }

  /** 补充上下文（FR-TASK-3）：任务目标追加（node_id 缺省的补充目标） */
  updateTaskGoal(taskId: string, goal: string, now: string): void {
    this.#updateTaskGoalStmt.run(goal, now, taskId);
  }

  /** 补充上下文（FR-TASK-3）：节点描述（goal）追加，其余字段不动 */
  updateNodeGoal(nodeId: string, goal: string, now: string): void {
    this.#updateNodeGoalStmt.run(goal, now, nodeId);
  }

  /** 移除节点及其全部关联边（修订移除；仅未完成节点走到这里） */
  deleteNodeWithEdges(taskId: string, nodeId: string): void {
    this.#deleteEdgesTouchingStmt.run(taskId, nodeId, nodeId);
    this.#deleteNodeStmt.run(nodeId);
  }

  /** 重算某节点的入边（修订的 depends_on 全量替换；from 为 node_id 形态） */
  replaceEdgesTo(taskId: string, toNodeId: string, fromNodeIds: string[]): void {
    this.#deleteEdgesToStmt.run(taskId, toNodeId);
    for (const fromNodeId of fromNodeIds) {
      this.#insertEdgeStmt.run(uuidv7(), taskId, fromNodeId, toNodeId);
    }
  }

  maxNodeSeq(taskId: string): number {
    const row = this.#maxNodeSeqStmt.get(taskId) as unknown as { max_seq: number | null };
    return row.max_seq ?? -1;
  }

  nodesOf(taskId: string): NodeRow[] {
    return this.#nodesOfStmt.all(taskId) as unknown as NodeRow[];
  }

  edgesOf(taskId: string): EdgeRow[] {
    return this.#edgesOfStmt.all(taskId) as unknown as EdgeRow[];
  }

  /** 节点行更新（调度器窄接缝：认领 = running+attempts；收尾 = 终态+结果/错误） */
  updateNode(
    nodeId: string,
    patch: { status: string; attempts: number; result: string | null; error: string | null },
    now: string,
  ): void {
    this.#updateNodeStmt.run(patch.status, patch.attempts, patch.result, patch.error, now, nodeId);
  }

  /** 节点行只读快照（调度器 attempt 基准：跨恢复累计时读现值） */
  getNodeState(nodeId: string): { status: string; attempts: number } | null {
    const row = this.getNode(nodeId);
    return row === null ? null : { status: row.status, attempts: row.attempts };
  }

  getNode(nodeId: string): NodeRow | null {
    return (this.#getNodeStmt.get(nodeId) as NodeRow | undefined) ?? null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

// --- TaskService ----------------------------------------------------------------

export interface TaskServiceOptions {
  /** 任务表落库目录（与事件账本同库 events.sqlite） */
  dataDir: string;
  ledger: EventLedger;
  replicaId: string;
  /** 规划器工厂；null = 不可用（createTask 抛 planner_unavailable，HTTP 层 503 预检） */
  factory: PlannerFactory | null;
  /**
   * Provider 解析面（默认工厂路径注入，做 hasDefault 预检）；注入工厂的测试/宿主可不传
   * （null = 不解析，factory 非 null 即可用，语义对齐 SessionManager）。
   */
  providers?: ProviderResolver | null;
  /** true = 默认工厂路径，要求存在可解析的默认 Provider（startRuntime 设置） */
  providerRequired?: boolean;
  /** 不可用时给客户端的说明（HTTP 503 载荷） */
  factoryUnavailableReason?: string;
}

export interface TransitionOptions {
  /** 迁移事件的 causation_id（如 task.started 事件 id）；缺省 null */
  causeEventId?: string | null;
  /** 迁移事件 payload（如 task.planned 携带 DAG 投影） */
  payload?: Record<string, unknown>;
  /** 失败原因（写入 tasks.error 列并进 task.failed payload.message） */
  error?: string;
}

export interface TransitionResult {
  task: TaskSummary;
  eventId: string;
  sequence: number;
}

export class TaskService {
  readonly ledger: EventLedger;
  readonly #replicaId: string;
  readonly #store: TaskStore;
  readonly #factory: PlannerFactory | null;
  readonly #providers: ProviderResolver | null;
  readonly #providerRequired: boolean;
  readonly #unavailableReason: string;

  constructor(options: TaskServiceOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#store = new TaskStore(openSqlite(join(options.dataDir, DB_FILE_NAME)));
    this.#factory = options.factory;
    this.#providers = options.providers ?? null;
    this.#providerRequired = options.providerRequired ?? false;
    this.#unavailableReason =
      options.factoryUnavailableReason ??
      "no model provider configured (register one via POST /v1/providers or set MORROW_PROVIDER_BASE_URL / MORROW_PROVIDER_API_KEY / MORROW_PROVIDER_MODEL)";
  }

  /** 规划是否可用（HTTP 503 预检依据；语义对齐 SessionManager.agentAvailable） */
  get plannerAvailable(): boolean {
    if (this.#factory === null) return false;
    if (!this.#providerRequired) return true;
    return this.#providers !== null && this.#providers.hasDefault();
  }

  get plannerUnavailableReason(): string {
    return this.#unavailableReason;
  }

  /**
   * 建任务并规划：task.created（actor owner）→ Agent Loop 规划 → DAG 落表 +
   * task.planned（DAG 全量投影入 payload）。规划失败（工厂抛错 / 输出非法）不抛给
   * 调用方：task.planning_failed + task.failed 留痕后返回 failed 态任务。
   * 存储类错误原样抛出（HTTP 500）。
   * opts.sessionId（M1-T6）：创建来源会话，随 task.created 留痕并落 tasks.session_id
   * （Chat 任务卡片按会话关联任务）。
   */
  async createTask(goal: string, opts: { sessionId?: string } = {}): Promise<TaskDetail> {
    if (this.#factory === null) {
      throw new TaskError("planner_unavailable", this.#unavailableReason);
    }
    const taskId = uuidv7();
    const now = new Date().toISOString();
    this.#store.insertTask({
      taskId,
      goal,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      now,
    });
    const created = this.#appendTaskEvent(
      taskId,
      TASK_EVENT_TYPES.taskCreated,
      "owner",
      opts.sessionId === undefined ? { goal } : { goal, session_id: opts.sessionId },
      null,
    );

    let dag: PlannedDag;
    try {
      const runtime = await this.#factory(goal);
      try {
        dag = await planWithRuntime(goal, runtime);
      } finally {
        runtime.dispose();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#appendTaskEvent(
        taskId,
        TASK_EVENT_TYPES.taskPlanningFailed,
        "agent:runtime",
        { message },
        created.eventId,
      );
      this.#transition(taskId, "failed", {
        causeEventId: created.eventId,
        payload: { reason: "planning_failed", message },
        error: message,
      });
      return this.getTask(taskId) as TaskDetail;
    }

    // 持久化 DAG（key → node_id 解析边）+ task.planned（payload 携带全量投影）
    const now2 = new Date().toISOString();
    const nodeIds = new Map<string, string>();
    dag.nodes.forEach((node, index) => {
      const nodeId = uuidv7();
      nodeIds.set(node.key, nodeId);
      this.#store.insertNode({
        nodeId,
        taskId,
        key: node.key,
        title: node.title,
        goal: node.goal ?? null,
        agentRole: node.agent_role ?? null,
        model: node.model ?? null,
        retriable: node.retriable,
        sideEffect: node.side_effect,
        seq: index,
        now: now2,
      });
    });
    let edgeCount = 0;
    for (const node of dag.nodes) {
      for (const dep of node.depends_on) {
        this.#store.insertEdge({ taskId, fromNode: nodeIds.get(dep) as string, toNode: nodeIds.get(node.key) as string });
        edgeCount += 1;
      }
    }
    const nodeRows = this.#store.nodesOf(taskId);
    const edgeRows = this.#store.edgesOf(taskId);
    this.#transition(taskId, "planned", {
      causeEventId: created.eventId,
      payload: {
        task_version: 1,
        edge_count: edgeCount,
        nodes: nodeRows.map((row) => this.#nodeProjection(row, nodeRows, edgeRows)),
      },
    });
    return this.getTask(taskId) as TaskDetail;
  }

  getTask(taskId: string): TaskDetail | null {
    const row = this.#store.getTask(taskId);
    if (row === null) return null;
    const nodeRows = this.#store.nodesOf(taskId);
    const edgeRows = this.#store.edgesOf(taskId);
    return {
      ...this.#summaryOf(row),
      nodes: nodeRows.map((node) => this.#nodeProjection(node, nodeRows, edgeRows)),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }

  listTasks(sessionId?: string): TaskSummary[] {
    return this.#store.listTasks(sessionId).map((row) => this.#summaryOf(row));
  }

  /**
   * 任务级状态机迁移（非法迁移抛 invalid_transition 且不落任何事件）。
   * planned→running 记 task.started；paused/waiting_input→running 记 task.resumed。
   */
  transition(taskId: string, to: TaskStatus, options: TransitionOptions = {}): TransitionResult {
    return this.#transition(taskId, to, options);
  }

  /**
   * 中断恢复标记（M1-T5）：stale-running（进程崩溃残留）的 resume 无合法状态迁移
   * （running→running 非法），以 task.resumed 事件（payload.reason =
   * recovered_after_interruption）留痕后重新驱动；不改 tasks.status。
   */
  markResumedForRecovery(
    taskId: string,
    payload: Record<string, unknown>,
  ): { eventId: string; sequence: number } {
    if (this.#store.getTask(taskId) === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    return this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskResumed, "agent:runtime", payload, null);
  }

  /** 任务事件分页（账本 task_id 专列过滤）；未知任务返回 null（HTTP 404 依据） */
  taskEvents(taskId: string, options: { limit?: number; offset?: number } = {}): LedgerPage | null {
    if (this.#store.getTask(taskId) === null) return null;
    return this.ledger.list({ taskId, ...options });
  }

  // --- 人工介入（M1-T6 / FR-TASK-3；全部操作以 owner actor 留审计事件）-----------

  /**
   * 修订（FR-TASK-3「修改未完成节点」）：修改集只作用于未完成节点——
   * update 按节点 key 部分更新（title/goal/model/agent_role/retriable/side_effect/
   * depends_on 全量替换），未完成但曾失败/待核对的节点重置为 pending 重跑；
   * add 新增节点；remove 移除节点并重算下游（被移除 key 从依赖者剥离）。
   * 已完成节点不可改/不可移（immutable_node），版本 +1，task.revised（actor owner，
   * 携带修改摘要）留痕。failed 任务修订后回卷 planned（终端态回卷的正道；不走
   * transition 表——终端态直接迁移依旧全部拒绝）；其余状态保持不变。
   * Checkpoint 不在此创建（HTTP 编排层在事件后补 reason=revise 的快照）。
   */
  reviseTask(taskId: string, revision: TaskRevision): ReviseTaskResult {
    const row = this.#store.getTask(taskId);
    if (row === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    const status = row.status as TaskStatus;
    if (status === "running") {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is running; pause it before revising (PRD §5.2: pause → revise → resume)`,
        { from: status },
      );
    }
    if (status === "completed" || status === "cancelled") {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is terminal (${status}); revision cannot roll it back`,
        { from: status },
      );
    }
    if (status === "created") {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} has no plan (still created); recreate the task instead of revising`,
        { from: status },
      );
    }
    const plan = validateRevision(this.getTask(taskId) as TaskDetail, revision);
    const now = new Date().toISOString();

    // 行变更先行，事件后写（账本是审计层；修订不做副作用投递，无需补偿序）。
    // 被修改的未完成节点统一重置 pending（failed/pending_review 的旧结果随之清空重跑）
    for (const change of plan.update) {
      const target = plan.existing.get(change.key) as TaskNodeRecord;
      this.#store.updateNodePlan(
        target.node_id,
        {
          title: change.title ?? target.title,
          goal: change.goal !== undefined ? change.goal : target.goal ?? null,
          agent_role: change.agent_role !== undefined ? change.agent_role : target.agent_role ?? null,
          model: change.model !== undefined ? change.model : target.model ?? null,
          retriable: change.retriable ?? target.retriable,
          side_effect: change.side_effect ?? target.side_effect,
          status: "pending",
          result: null,
          error: null,
        },
        now,
      );
      if (change.depends_on !== undefined) {
        const keyToId = (key: string) => plan.keyId.get(key) as string;
        this.#store.replaceEdgesTo(taskId, target.node_id, change.depends_on.map(keyToId));
      }
    }
    for (const key of plan.removedKeys) {
      this.#store.deleteNodeWithEdges(taskId, (plan.existing.get(key) as TaskNodeRecord).node_id);
    }
    const seqBase = this.#store.maxNodeSeq(taskId);
    for (const [index, add] of plan.add.entries()) {
      const nodeId = uuidv7();
      plan.keyId.set(add.key, nodeId);
      this.#store.insertNode({
        nodeId,
        taskId,
        key: add.key,
        title: add.title,
        goal: add.goal ?? null,
        agentRole: add.agent_role ?? null,
        model: add.model ?? null,
        retriable: add.retriable ?? true,
        sideEffect: add.side_effect ?? "delivery_unknown",
        seq: seqBase + 1 + index,
        now,
      });
      for (const dep of add.depends_on ?? []) {
        this.#store.insertEdge({ taskId, fromNode: plan.keyId.get(dep) as string, toNode: nodeId });
      }
    }
    this.#store.bumpTaskVersion(taskId, now);

    const taskVersion = row.task_version + 1;
    const summary = {
      updated_keys: plan.update.map((c) => c.key),
      added_keys: plan.add.map((a) => a.key),
      removed_keys: plan.removedKeys,
    };
    const revised = this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskRevised, "owner", {
      task_version: taskVersion,
      summary,
      changes: { update: plan.update, add: plan.add, remove: plan.removedKeys },
    }, null);

    let rolledBack = false;
    if (status === "failed") {
      // 终端态回卷的正道：revise 专属路径（transition 表的 failed 依旧不可直接迁出）
      this.#store.updateTaskStatus(taskId, "planned", null, new Date().toISOString());
      this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskPlanned, "agent:runtime", {
        reason: "revised_after_failure",
        task_version: taskVersion,
      }, revised.eventId);
      rolledBack = true;
    }
    return {
      task: this.getTask(taskId) as TaskDetail,
      revision: {
        task_version: taskVersion,
        ...summary,
        status_rolled_back: rolledBack,
        event_id: revised.eventId,
        sequence: revised.sequence,
      },
    };
  }

  /**
   * 补充上下文（FR-TASK-3「补充上下文」，M1 code-review 补齐）：
   * - node_id 给定 → context 追加到该节点的描述（goal；goal 缺省时以 title 为基）；
   *   节点不存在 → not_found（404），已完成节点 → immutable_node（409）；
   * - node_id 缺省 → 追加到任务目标（tasks.goal）。
   * task.context_supplied（actor=owner）留痕；DAG 不变故不升 task_version、不落
   * checkpoint（恢复基准不受影响——与 revise 的「版本+1+新 checkpoint」刻意区分：
   * 补充不是计划修改）。waiting_input 的自动重新驱动在 HTTP 编排层经 scheduler.kick
   * 完成（语义同 complete/release：202 前同步迁移，驱动 fire-and-forget）。
   * running 节点也接受追加：在跑尝试的 prompt 已在途，追加内容自下次派发/重试生效。
   */
  supplyContext(
    taskId: string,
    input: { nodeId?: string; context: string },
  ): { task: TaskDetail; supplied: { target: "node" | "task"; node_id?: string; key?: string; event_id: string; sequence: number } } {
    const row = this.#store.getTask(taskId);
    if (row === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    const status = row.status as TaskStatus;
    if (status === "failed" || status === "completed" || status === "cancelled") {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is terminal (${status}); context cannot be supplied`,
        { from: status },
      );
    }
    const now = new Date().toISOString();
    const suffix = `[Owner 补充] ${input.context}`;
    let target: "node" | "task" = "task";
    let nodeId: string | undefined;
    let key: string | undefined;
    if (input.nodeId !== undefined) {
      const node = this.#store.getNode(input.nodeId);
      if (node === null || node.task_id !== taskId) {
        throw new TaskError("not_found", `node ${input.nodeId} does not exist in task ${taskId}`);
      }
      if (node.status === "completed") {
        throw new TaskError("immutable_node", `node "${node.node_key}" is completed; context cannot be appended`);
      }
      target = "node";
      nodeId = node.node_id;
      key = node.node_key;
      this.#store.updateNodeGoal(node.node_id, `${node.goal ?? node.title}\n\n${suffix}`, now);
    } else {
      this.#store.updateTaskGoal(taskId, `${row.goal}\n\n${suffix}`, now);
    }
    const event = this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskContextSupplied, "owner", {
      target,
      ...(nodeId !== undefined ? { node_id: nodeId, key } : {}),
      context: input.context,
    }, null);
    return {
      task: this.getTask(taskId) as TaskDetail,
      supplied: {
        target,
        ...(nodeId !== undefined ? { node_id: nodeId, key } : {}),
        event_id: event.eventId,
        sequence: event.sequence,
      },
    };
  }

  /**
   * 接管（FR-TASK-3「接管子任务」）：pending 节点标记 actor=owner（调度器从此跳过
   * 派发），task.node_taken_over（actor owner）留痕。仅 pending 可接管：running 节点
   * 在执行中（先暂停），completed 不可改（immutable_node），已接管的重复接管拒绝。
   */
  takeoverNode(taskId: string, nodeId: string): TaskDetail {
    const context = this.#nodeForIntervention(taskId, nodeId, "takeover");
    if (context.node.status === "completed") {
      throw new TaskError("immutable_node", `node "${context.node.key}" is completed and cannot be taken over`);
    }
    if (context.node.status !== "pending") {
      throw new TaskError(
        "invalid_transition",
        `node "${context.node.key}" is ${context.node.status}; only pending nodes can be taken over`,
      );
    }
    if (context.node.actor === "owner") {
      throw new TaskError("invalid_transition", `node "${context.node.key}" is already taken over by owner`);
    }
    this.#store.setNodeActor(nodeId, "owner", new Date().toISOString());
    this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeTakenOver, "owner", {
      node_id: nodeId,
      key: context.node.key,
      title: context.node.title,
    }, null);
    return this.getTask(taskId) as TaskDetail;
  }

  /**
   * Owner 提交接管节点的结果：节点 → completed（result 落行，actor 保持 owner 留痕），
   * task.node_completed_by_owner（actor owner）。未接管的节点不可经此完成。
   */
  completeNode(taskId: string, nodeId: string, result: string): TaskDetail {
    const context = this.#nodeForIntervention(taskId, nodeId, "complete");
    if (context.node.actor !== "owner") {
      throw new TaskError(
        "invalid_transition",
        `node "${context.node.key}" is not taken over by owner; take it over first`,
      );
    }
    if (context.node.status !== "pending") {
      throw new TaskError(
        "invalid_transition",
        `node "${context.node.key}" is ${context.node.status}; only pending nodes can be completed by owner`,
      );
    }
    this.#store.updateNode(nodeId, { status: "completed", attempts: context.node.attempts, result, error: null }, new Date().toISOString());
    this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeCompletedByOwner, "owner", {
      node_id: nodeId,
      key: context.node.key,
      status: "completed",
      result,
    }, null);
    return this.getTask(taskId) as TaskDetail;
  }

  /**
   * 交还（FR-TASK-3「交还」）：接管的节点清掉 actor 标记回到调度器队列，
   * task.node_released（actor owner）留痕。
   */
  releaseNode(taskId: string, nodeId: string): TaskDetail {
    const context = this.#nodeForIntervention(taskId, nodeId, "release");
    if (context.node.actor !== "owner") {
      throw new TaskError(
        "invalid_transition",
        `node "${context.node.key}" is not taken over by owner; nothing to release`,
      );
    }
    if (context.node.status !== "pending") {
      throw new TaskError(
        "invalid_transition",
        `node "${context.node.key}" is ${context.node.status}; only pending nodes can be released`,
      );
    }
    this.#store.setNodeActor(nodeId, null, new Date().toISOString());
    this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeReleased, "owner", {
      node_id: nodeId,
      key: context.node.key,
    }, null);
    return this.getTask(taskId) as TaskDetail;
  }

  /** 介入操作的公共前置：任务存在且非终端（终端态一律拒绝——409 语义） */
  #nodeForIntervention(
    taskId: string,
    nodeId: string,
    op: "takeover" | "complete" | "release",
  ): { node: TaskNodeRecord } {
    const detail = this.getTask(taskId);
    if (detail === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    if (detail.status === "failed" || detail.status === "completed" || detail.status === "cancelled") {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is terminal (${detail.status}); ${op} is not possible`,
        { from: detail.status },
      );
    }
    const node = detail.nodes.find((n) => n.node_id === nodeId);
    if (node === undefined) {
      throw new TaskError("not_found", `node ${nodeId} does not exist in task ${taskId}`);
    }
    return { node };
  }

  // --- 调度器窄接缝（节点行更新；M1 单机单调度器，无并发争用）---------------------

  /** 节点行只读快照（调度器 attempt 基准：跨恢复累计时读现值；M1-T5） */
  getNodeState(nodeId: string): { status: string; attempts: number } | null {
    const row = this.#store.getNode(nodeId);
    return row === null ? null : { status: row.status, attempts: row.attempts };
  }

  setNodeRunning(nodeId: string, attempt: number): void {
    const now = new Date().toISOString();
    this.#store.updateNode(nodeId, { status: "running", attempts: attempt, result: null, error: null }, now);
  }

  setNodeFinished(
    nodeId: string,
    status: "completed" | "failed",
    patch: { result?: string; error?: string },
  ): void {
    const row = this.#store.getNode(nodeId);
    if (row === null) return;
    const now = new Date().toISOString();
    this.#store.updateNode(
      nodeId,
      {
        status,
        attempts: Math.max(row.attempts, 1),
        result: status === "completed" ? patch.result ?? null : row.result,
        error: status === "failed" ? patch.error ?? null : row.error,
      },
      now,
    );
  }

  /**
   * 节点行补丁（恢复接缝，M1-T5）：回卷为 pending 清空结果/错误；pending_review
   * 保留 result 供人工核对。attempts 保持原值（重放时由调度器在现值上递增）。
   */
  setNodeState(
    nodeId: string,
    patch: { status: string; result?: string | null; error?: string | null },
  ): void {
    const row = this.#store.getNode(nodeId);
    if (row === null) return;
    const now = new Date().toISOString();
    this.#store.updateNode(
      nodeId,
      {
        status: patch.status,
        attempts: row.attempts,
        result: patch.result !== undefined ? patch.result : row.result,
        error: patch.error !== undefined ? patch.error : row.error,
      },
      now,
    );
  }

  close(): void {
    this.#store.close();
  }

  // --- 内部 ------------------------------------------------------------------

  #transition(taskId: string, to: TaskStatus, options: TransitionOptions): TransitionResult {
    const row = this.#store.getTask(taskId);
    if (row === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    const from = row.status as TaskStatus;
    if (!(TASK_TRANSITIONS[from] ?? []).includes(to)) {
      throw new TaskError(
        "invalid_transition",
        `illegal task transition ${from} → ${to}`,
        { from, to },
      );
    }
    this.#store.updateTaskStatus(taskId, to, options.error ?? null, new Date().toISOString());
    const eventType =
      to === "running" && from !== "planned" ? TASK_EVENT_TYPES.taskResumed : STATUS_EVENT_TYPES[to];
    const envelope = this.#appendTaskEvent(
      taskId,
      eventType,
      "agent:runtime",
      options.payload ?? {},
      options.causeEventId ?? null,
    );
    const updated = this.#store.getTask(taskId) as TaskRow;
    return { task: this.#summaryOf(updated), eventId: envelope.eventId, sequence: envelope.sequence };
  }

  #appendTaskEvent(
    taskId: string,
    eventType: string,
    actorId: "owner" | "agent:runtime",
    payload: Record<string, unknown>,
    causationId: string | null,
  ): { eventId: string; sequence: number } {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId,
      eventType,
      taskId,
      payload,
      causationId,
    });
    const { sequence } = this.ledger.append(envelope);
    return { eventId: envelope.event_id, sequence };
  }

  #summaryOf(row: TaskRow): TaskSummary {
    return {
      task_id: row.task_id,
      goal: row.goal,
      status: row.status as TaskStatus,
      task_version: row.task_version,
      ...(row.session_id === null ? {} : { session_id: row.session_id }),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** 节点投影：depends_on 以规划器 key 表示（edge from_node → key 一次解析） */
  #nodeProjection(row: NodeRow, siblings: NodeRow[], edges: EdgeRow[]): TaskNodeRecord {
    const keyOf = new Map(siblings.map((n) => [n.node_id, n.node_key]));
    return {
      node_id: row.node_id,
      key: row.node_key,
      title: row.title,
      ...(row.goal === null ? {} : { goal: row.goal }),
      depends_on: edges
        .filter((e) => e.to_node === row.node_id)
        .map((e) => keyOf.get(e.from_node) ?? e.from_node),
      ...(row.agent_role === null ? {} : { agent_role: row.agent_role }),
      ...(row.model === null ? {} : { model: row.model }),
      retriable: row.retriable === 1,
      side_effect: row.side_effect as SideEffectClass,
      status: row.status as TaskNodeRecord["status"],
      ...(row.actor === null ? {} : { actor: row.actor as TaskNodeRecord["actor"] }),
      attempts: row.attempts,
      ...(row.result === null ? {} : { result: row.result }),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }
}
