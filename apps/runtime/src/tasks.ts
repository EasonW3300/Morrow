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
 * 任务域（票 M1-T4 / Issue #16，PRD §4.3 FR-TASK-1/2/6、决策稿 §6 状态机）。
 *
 * 职责分界：
 * - TaskStore：tasks/task_nodes/task_edges 可变投影表（迁移见 task-migrations.ts）；
 * - TaskService：任务生命周期——建任务 + 规划（经 PiAdapter 接口，FR-TASK-1）、
 *   DAG 存取投影、任务级状态机与 task.* 事件族（FR-TASK-2）；
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
 * 暂停/补充输入的人工介入端点是 FR-TASK-3 的范围；本票状态机先行，服务层
 * transition 即可驱动（测试与后续票共用）。
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
} as const;

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
  | "invalid_plan";

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
  #updateTaskStmt;
  #insertNodeStmt;
  #nodesOfStmt;
  #getNodeStmt;
  #updateNodeStmt;
  #insertEdgeStmt;
  #edgesOfStmt;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureTaskTables(db);
    this.#insertTaskStmt = db.prepare(
      "INSERT INTO tasks (task_id, goal, status, task_version, error, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    );
    this.#getTaskStmt = db.prepare("SELECT * FROM tasks WHERE task_id = ?");
    this.#listTasksStmt = db.prepare("SELECT * FROM tasks ORDER BY created_at, task_id");
    this.#updateTaskStmt = db.prepare("UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE task_id = ?");
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
    this.#insertEdgeStmt = db.prepare(
      "INSERT INTO task_edges (edge_id, task_id, from_node, to_node) VALUES (?, ?, ?, ?)",
    );
    this.#edgesOfStmt = db.prepare("SELECT * FROM task_edges WHERE task_id = ? ORDER BY rowid");
  }

  insertTask(row: { taskId: string; goal: string; now: string }): void {
    this.#insertTaskStmt.run(row.taskId, row.goal, "created", 1, row.now, row.now);
  }

  getTask(taskId: string): TaskRow | null {
    return (this.#getTaskStmt.get(taskId) as TaskRow | undefined) ?? null;
  }

  listTasks(): TaskRow[] {
    return this.#listTasksStmt.all() as unknown as TaskRow[];
  }

  /** 状态推进 + 失败原因（error 仅 failed 时有值；恢复/完成清空） */
  updateTaskStatus(taskId: string, status: TaskStatus, error: string | null, now: string): void {
    this.#updateTaskStmt.run(status, status === "failed" ? error : null, now, taskId);
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

  nodesOf(taskId: string): NodeRow[] {
    return this.#nodesOfStmt.all(taskId) as unknown as NodeRow[];
  }

  edgesOf(taskId: string): EdgeRow[] {
    return this.#edgesOfStmt.all(taskId) as unknown as EdgeRow[];
  }

  getNode(nodeId: string): NodeRow | null {
    return (this.#getNodeStmt.get(nodeId) as NodeRow | undefined) ?? null;
  }

  /** 节点行更新（调度器窄接缝：认领 = running+attempts；收尾 = 终态+结果/错误） */
  updateNode(
    nodeId: string,
    patch: { status: string; attempts: number; result: string | null; error: string | null },
    now: string,
  ): void {
    this.#updateNodeStmt.run(patch.status, patch.attempts, patch.result, patch.error, now, nodeId);
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
   */
  async createTask(goal: string): Promise<TaskDetail> {
    if (this.#factory === null) {
      throw new TaskError("planner_unavailable", this.#unavailableReason);
    }
    const taskId = uuidv7();
    const now = new Date().toISOString();
    this.#store.insertTask({ taskId, goal, now });
    const created = this.#appendTaskEvent(
      taskId,
      TASK_EVENT_TYPES.taskCreated,
      "owner",
      { goal },
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

  listTasks(): TaskSummary[] {
    return this.#store.listTasks().map((row) => this.#summaryOf(row));
  }

  /**
   * 任务级状态机迁移（非法迁移抛 invalid_transition 且不落任何事件）。
   * planned→running 记 task.started；paused/waiting_input→running 记 task.resumed。
   */
  transition(taskId: string, to: TaskStatus, options: TransitionOptions = {}): TransitionResult {
    return this.#transition(taskId, to, options);
  }

  /** 任务事件分页（账本 task_id 专列过滤）；未知任务返回 null（HTTP 404 依据） */
  taskEvents(taskId: string, options: { limit?: number; offset?: number } = {}): LedgerPage | null {
    if (this.#store.getTask(taskId) === null) return null;
    return this.ledger.list({ taskId, ...options });
  }

  // --- 调度器窄接缝（节点行更新；M1 单机单调度器，无并发争用）---------------------

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
      attempts: row.attempts,
      ...(row.result === null ? {} : { result: row.result }),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }
}
