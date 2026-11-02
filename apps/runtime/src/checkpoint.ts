import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SideEffectClass, TaskDetail, TaskNodeStatus, TaskStatus } from "@morrow/protocol";
import { buildEventEnvelope } from "./envelope.ts";
import { DB_FILE_NAME, type EventLedger } from "./ledger.ts";
import { ensureCheckpointTable } from "./task-migrations.ts";
import { openSqlite, type SqliteDatabase, type SqliteStatement } from "./db.ts";
import { uuidv7 } from "./uuid-v7.ts";

/**
 * Checkpoint 域（票 M1-T5 / Issue #17，PRD §4.3 FR-TASK-5/6、§6 恢复语义）。
 *
 * 职责分界：
 * - CheckpointStore：task_checkpoints 表（JSON 快照 + 元数据；迁移见 task-migrations.ts）；
 * - CheckpointService：快照构建（FR-TASK-5 字段集）+ task.checkpoint_created /
 *   task.restored 事件 + 恢复决策的落地（planReconcile 决策 → 节点行更新）；
 * - 暂停/恢复/指定恢复的编排（含驱动）在 scheduler.ts；本模块不驱动任务。
 *
 * 恢复语义（FR-TASK-6 / PRD §6「未知状态不自动重发」）——决策函数 planReconcile：
 * 恢复的danger是「重复送达」，不是「首跑」：从未执行过的节点照常调度；只有
 * 已完成/在跑（半写）节点被回卷重执行时按副作用分类 gate：
 *   - reversible            → 回卷为 pending，resume 时重放；
 *   - compensatable         → 回卷为 pending 重放，并登记待补偿动作（M1 只记录不执行真实补偿）；
 *   - irreversible / delivery_unknown → 不自动重发，置 pending_review（节点级人工核对态；
 *     保留原 result 供核对），含此类节点的任务在无可跑节点时由调度器转 waiting_input。
 * （选择节点级 pending_review 而非任务级 needs_reconcile：任务级冻结会让可继续的
 * 兄弟节点陪停，且核对范围本来就是节点级；needs_reconcile 留给 M3 执行租约冲突。）
 *
 * 写入顺序与中断一致性：先写行、后写事件；事件写失败（进程崩溃/注入故障）时
 * 补偿删除已写行再抛错——checkpoint 不留无事件引用的孤儿行，重试路径完好。
 * （崩溃在「行已写、事件未写」窗口：行有 event 引用缺失，但恢复只依赖行本身，
 * 事件是审计索引——一致性优先保证可恢复性，孤儿审计缺口接受并留补偿路径。）
 */

/** 快照 schema 版本（演进规则：只加字段不删改；破坏性变更升版本号） */
export const CHECKPOINT_SNAPSHOT_SCHEMA = "morrow.checkpoint/1";

/** 快照内节点形态（全量显式，不借投影的可选字段省略语义） */
export interface CheckpointNodeSnapshot {
  node_id: string;
  key: string;
  title: string;
  goal: string | null;
  depends_on: string[];
  agent_role: string | null;
  model: string | null;
  retriable: boolean;
  side_effect: SideEffectClass;
  status: TaskNodeStatus;
  attempts: number;
  result: string | null;
  error: string | null;
}

/** 待处理副作用条目（按分类；GLOSSARY: SideEffect） */
export interface CheckpointPendingSideEffect {
  key: string;
  side_effect: SideEffectClass;
  /**
   * not_delivered：节点未完成，副作用未发生（首跑不属重发）；
   * delivered_unverified：已完成且不可逆/不可核验（irreversible/delivery_unknown）——
   * 回卷重跑会被 gate 进 pending_review；
   * compensation_pending：已完成且可补偿（compensatable）——回卷重跑需先登记补偿。
   */
  state: "not_delivered" | "delivered_unverified" | "compensation_pending";
}

/** FR-TASK-5 字段集（PRD §4.3）：Graph/Run 状态、输出引用、文件快照、执行配置、会话、待处理副作用 */
export interface CheckpointSnapshot {
  schema: typeof CHECKPOINT_SNAPSHOT_SCHEMA;
  task: { task_id: string; goal: string; status: TaskStatus; task_version: number };
  graph: {
    nodes: CheckpointNodeSnapshot[];
    edges: Array<{ from: string; to: string }>;
  };
  run: {
    status: TaskStatus;
    /** 当前 run 的根事件（最近一次 task.started/task.resumed）；未开跑为 null */
    run_root_event_id: string | null;
    /** Run 在账本中的推进位置：任务事件最大 seq（恢复对账基准） */
    event_cursor: number;
    /** 已完成节点 key → 其 task.node_finished(completed) 账本事件 id（输出引用） */
    output_refs: Record<string, string>;
  };
  /** M1 任务无工作区（FR-TASK-8 为 P1 未实现）：恒 null，说明见 workspace_note */
  workspace: null;
  workspace_note: string;
  execution: {
    runtime_version: string | null;
    /** 恢复时解析的默认 Provider（不含任何密钥；不可解析为 null） */
    provider: { provider_id: string; model_id: string; base_url: string } | null;
    /** 节点建议模型（M1 仅记录不执行） */
    node_models: Record<string, string>;
    /**
     * 工具版本表（M1 code-review 填实）：pi-adapter 版本由 startRuntime 注入（可证来源）；
     * 逐工具版本无来源——M1 任务执行无工具通道（memory tool 为会话级），留空待
     * 后续票交付工具通道时补记。
     */
    tool_versions: Record<string, string>;
  };
  /**
   * Task↔Session 关联（M1 code-review 填实）：创建来源会话（tasks.session_id）；
   * 节点执行在 M1 为一次性 AgentRuntime、不建会话，无来源可记——执行会话关联由
   * 后续票交付时追加。
   */
  session_ids: string[];
  pending_side_effects: CheckpointPendingSideEffect[];
}

export interface CheckpointMeta {
  checkpoint_id: string;
  task_id: string;
  task_version: number;
  reason: string;
  created_at: string;
}

export interface CheckpointRecord extends CheckpointMeta {
  snapshot: CheckpointSnapshot;
}

export type CheckpointErrorCode = "checkpoint_not_found" | "checkpoint_version_mismatch" | "task_not_found";

export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;
  readonly details?: unknown;

  constructor(code: CheckpointErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
    this.details = details;
  }
}

// --- 恢复决策（纯函数；调度器/服务共用同一口径）----------------------------------

export type ReconcileActionKind =
  | "keep_completed"
  | "keep_pending"
  | "keep_pending_review"
  | "keep_failed"
  | "replay"
  | "replay_with_compensation"
  | "flag_pending_review";

export interface ReconcileAction {
  node_id: string;
  key: string;
  side_effect: SideEffectClass;
  from_status: TaskNodeStatus;
  /** checkpoint 中记录的状态；无 checkpoint 或该节点不在快照中为 null */
  checkpoint_status: TaskNodeStatus | null;
  to_status: TaskNodeStatus;
  action: ReconcileActionKind;
}

export interface ReconcileReport {
  actions: ReconcileAction[];
  /** 需人工核对的节点 key（pending_review） */
  pending_review_keys: string[];
  /** 待补偿动作（M1 只登记不执行真实补偿） */
  pending_compensations: Array<{ key: string; side_effect: SideEffectClass; note: string }>;
  /** 将被重放的节点 key */
  replay_keys: string[];
}

/**
 * 恢复决策表（副作用分类 → 动作）。输入当前任务投影 + 恢复基准快照（可为 null）：
 * - completed 且（无 checkpoint 或 checkpoint 亦记 completed）→ keep_completed（不重放）；
 * - pending / pending_review / failed → 原状保持（pending_review 已在人工核对队列）；
 * - 回卷不确定区（checkpoint 记未完成但现在 completed，或当前 running 的半写状态）：
 *   reversible → replay；compensatable → replay_with_compensation；
 *   irreversible/delivery_unknown → flag_pending_review（不自动重发）。
 */
export function planReconcile(task: TaskDetail, snapshot: CheckpointSnapshot | null): ReconcileReport {
  const cpStatus = new Map<string, TaskNodeStatus>(
    (snapshot?.graph.nodes ?? []).map((n) => [n.key, n.status]),
  );
  const actions: ReconcileAction[] = [];
  const pendingReviewKeys: string[] = [];
  const pendingCompensations: ReconcileReport["pending_compensations"] = [];
  const replayKeys: string[] = [];

  for (const node of task.nodes) {
    const cp = cpStatus.get(node.key) ?? null;
    const base = {
      node_id: node.node_id,
      key: node.key,
      side_effect: node.side_effect,
      from_status: node.status,
      checkpoint_status: cp,
    };
    // 回卷不确定区：checkpoint 说它当时未完成、现在却已完成（checkpoint 后才跑完），
    // 或它还挂在 running（半写：node_started 已落、结果未知）。
    const completedAfterCheckpoint = node.status === "completed" && cp !== null && cp !== "completed";
    const staleRunning = node.status === "running";
    if (node.status === "completed" && !completedAfterCheckpoint) {
      actions.push({ ...base, to_status: node.status, action: "keep_completed" });
      continue;
    }
    if (node.status === "pending") {
      actions.push({ ...base, to_status: node.status, action: "keep_pending" });
      continue;
    }
    if (node.status === "pending_review") {
      actions.push({ ...base, to_status: node.status, action: "keep_pending_review" });
      continue;
    }
    if (node.status === "failed") {
      actions.push({ ...base, to_status: node.status, action: "keep_failed" });
      continue;
    }
    if (!completedAfterCheckpoint && !staleRunning) {
      // 防御分支：running/completed 之外的未知组合原状保持（不产生意外重放）
      actions.push({ ...base, to_status: node.status, action: "keep_failed" });
      continue;
    }
    if (node.side_effect === "reversible") {
      actions.push({ ...base, to_status: "pending", action: "replay" });
      replayKeys.push(node.key);
      continue;
    }
    if (node.side_effect === "compensatable") {
      actions.push({ ...base, to_status: "pending", action: "replay_with_compensation" });
      replayKeys.push(node.key);
      pendingCompensations.push({
        key: node.key,
        side_effect: node.side_effect,
        note: "rewound for replay; prior delivery (if any) requires compensation before/after re-execution (M1 records only, no real compensation)",
      });
      continue;
    }
    actions.push({ ...base, to_status: "pending_review", action: "flag_pending_review" });
    pendingReviewKeys.push(node.key);
  }
  return {
    actions,
    pending_review_keys: pendingReviewKeys,
    pending_compensations: pendingCompensations,
    replay_keys: replayKeys,
  };
}

// --- 存储 ------------------------------------------------------------------------

interface CheckpointRow {
  checkpoint_id: string;
  task_id: string;
  task_version: number;
  reason: string;
  snapshot: string;
  created_at: string;
}

export class CheckpointStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertStmt;
  #listStmt;
  #getStmt;
  #latestStmt;
  #deleteStmt;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureCheckpointTable(db);
    this.#insertStmt = db.prepare(
      "INSERT INTO task_checkpoints (checkpoint_id, task_id, task_version, reason, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#listStmt = db.prepare(
      "SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at DESC, checkpoint_id DESC",
    );
    this.#getStmt = db.prepare("SELECT * FROM task_checkpoints WHERE checkpoint_id = ?");
    this.#latestStmt = db.prepare(
      "SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at DESC, checkpoint_id DESC LIMIT 1",
    );
    this.#deleteStmt = db.prepare("DELETE FROM task_checkpoints WHERE checkpoint_id = ?");
  }

  insert(record: CheckpointRecord): void {
    this.#insertStmt.run(
      record.checkpoint_id,
      record.task_id,
      record.task_version,
      record.reason,
      JSON.stringify(record.snapshot),
      record.created_at,
    );
  }

  listForTask(taskId: string): CheckpointRecord[] {
    return (this.#listStmt.all(taskId) as unknown as CheckpointRow[]).map(parseRow);
  }

  get(checkpointId: string): CheckpointRecord | null {
    const row = this.#getStmt.get(checkpointId) as CheckpointRow | undefined;
    return row === undefined ? null : parseRow(row);
  }

  latestForTask(taskId: string): CheckpointRecord | null {
    const row = this.#latestStmt.get(taskId) as CheckpointRow | undefined;
    return row === undefined ? null : parseRow(row);
  }

  /** 补偿删除（仅 createCheckpoint 的事件写入失败路径使用；普通操作不做删除） */
  delete(checkpointId: string): void {
    this.#deleteStmt.run(checkpointId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

function parseRow(row: CheckpointRow): CheckpointRecord {
  return {
    checkpoint_id: row.checkpoint_id,
    task_id: row.task_id,
    task_version: row.task_version,
    reason: row.reason,
    created_at: row.created_at,
    snapshot: JSON.parse(row.snapshot) as CheckpointSnapshot,
  };
}

// --- 服务 ------------------------------------------------------------------------

/**
 * CheckpointService 依赖的任务视图（结构化最小接口，TaskService 实现之）：
 * 读任务详情投影 + 恢复落地的节点行补丁接缝（回卷/标记待核对）。
 */
export interface CheckpointTaskView {
  getTask(taskId: string): TaskDetail | null;
  setNodeState(
    nodeId: string,
    patch: { status: TaskNodeStatus; result?: string | null; error?: string | null },
  ): void;
}

export interface CheckpointServiceOptions {
  /** 任务视图（TaskService 注入；测试可用桩） */
  tasks: CheckpointTaskView;
  /** 任务表同库目录（events.sqlite；独立连接，WAL + busy_timeout 支撑多连接） */
  dataDir?: string;
  /** 直接注入打开的库（测试/宿主复用连接时）；与 dataDir 二选一 */
  db?: SqliteDatabase;
  ledger: EventLedger;
  replicaId: string;
  /**
   * 执行配置采集（FR-TASK-5「执行配置/模型与工具版本」）：生产由 startRuntime 注入
   * （runtime 版本 + 默认 Provider 投影 + 工具版本表，绝不含密钥）；缺省为 null 字段。
   */
  executionInfo?: () => Promise<{
    runtime_version: string | null;
    provider: CheckpointSnapshot["execution"]["provider"];
    /** 工具版本表（可证来源的条目；注入方决定口径，缺省空表） */
    tool_versions?: Record<string, string>;
  }>;
}

export interface RestoreOutcome {
  report: ReconcileReport;
  /** task.restored 事件 id（后续驱动的 causation 根之一） */
  eventId: string;
  sequence: number;
  checkpoint_id: string | null;
  checkpoint_version: number | null;
}

export class CheckpointService {
  ledger: EventLedger;
  readonly #replicaId: string;
  readonly #tasks: CheckpointTaskView;
  readonly #store: CheckpointStore;
  readonly #executionInfo: NonNullable<CheckpointServiceOptions["executionInfo"]> | null;
  readonly #ownsDb: boolean;
  #closed = false;

  constructor(options: CheckpointServiceOptions) {
    this.ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#tasks = options.tasks;
    this.#executionInfo = options.executionInfo ?? null;
    if (options.db !== undefined) {
      this.#store = new CheckpointStore(options.db);
      this.#ownsDb = false;
    } else {
      if (options.dataDir === undefined) {
        throw new Error("CheckpointService requires either dataDir or db");
      }
      mkdirSync(options.dataDir, { recursive: true });
      this.#store = new CheckpointStore(openSqlite(join(options.dataDir, DB_FILE_NAME)));
      this.#ownsDb = true;
    }
  }

  /**
   * 构建并持久化一个 checkpoint：FR-TASK-5 快照 + task.checkpoint_created 事件。
   * 先行后事件；事件写失败 → 补偿删行后原样抛出（不留孤儿行）。
   */
  async createCheckpoint(taskId: string, reason: string): Promise<CheckpointRecord> {
    const snapshot = await this.#buildSnapshot(taskId, this.#currentDetail(taskId));
    const record: CheckpointRecord = {
      checkpoint_id: uuidv7(),
      task_id: taskId,
      task_version: snapshot.task.task_version,
      reason,
      created_at: new Date().toISOString(),
      snapshot,
    };
    this.#store.insert(record);
    try {
      this.#appendTaskEvent(taskId, TASK_CHECKPOINT_EVENT_TYPES.checkpointCreated, {
        checkpoint_id: record.checkpoint_id,
        task_version: record.task_version,
        reason,
        event_cursor: snapshot.run.event_cursor,
        node_stats: nodeStats(snapshot),
      });
    } catch (err) {
      this.#store.delete(record.checkpoint_id);
      throw err;
    }
    return record;
  }

  listCheckpoints(taskId: string): CheckpointRecord[] {
    return this.#store.listForTask(taskId);
  }

  getCheckpoint(checkpointId: string): CheckpointRecord | null {
    return this.#store.get(checkpointId);
  }

  latestCheckpoint(taskId: string): CheckpointRecord | null {
    return this.#store.latestForTask(taskId);
  }

  /**
   * 恢复落地：按快照（或无快照的活状态）做 reconcile → 应用节点行变更 →
   * task.restored 事件（causation 指向 checkpoint_created；无 checkpoint 时 null）。
   * 只做状态与事件，不驱动任务（驱动归 scheduler）。
   */
  restoreCheckpoint(taskId: string, checkpointId: string | null): RestoreOutcome {
    const detail = this.#currentDetail(taskId);
    let record: CheckpointRecord | null = null;
    if (checkpointId !== null) {
      record = this.#store.get(checkpointId);
      if (record === null || record.task_id !== taskId) {
        throw new CheckpointError(
          "checkpoint_not_found",
          `checkpoint "${checkpointId}" does not exist for task ${taskId}`,
        );
      }
      if (record.task_version !== detail.task_version) {
        throw new CheckpointError(
          "checkpoint_version_mismatch",
          `checkpoint ${checkpointId} was taken at task_version ${record.task_version}, task is at ${detail.task_version}`,
          { checkpoint_version: record.task_version, task_version: detail.task_version },
        );
      }
    }
    const report = planReconcile(detail, record?.snapshot ?? null);
    for (const action of report.actions) {
      if (action.to_status === action.from_status) continue;
      this.#applyAction(action);
    }
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: TASK_CHECKPOINT_EVENT_TYPES.restored,
      taskId,
      payload: {
        checkpoint_id: record?.checkpoint_id ?? null,
        checkpoint_version: record?.task_version ?? null,
        task_version: detail.task_version,
        replay_keys: report.replay_keys,
        pending_review_keys: report.pending_review_keys,
        pending_compensations: report.pending_compensations,
        actions: report.actions,
      },
      causationId: record === null ? null : this.#checkpointEventId(record.checkpoint_id),
    });
    const { sequence } = this.ledger.append(envelope);
    return {
      report,
      eventId: envelope.event_id,
      sequence,
      checkpoint_id: record?.checkpoint_id ?? null,
      checkpoint_version: record?.task_version ?? null,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // 注入共享 db 的实例不拥有连接，不关闭（连接所有者负责）
    if (this.#ownsDb) this.#store.close();
  }

  // --- 内部 ------------------------------------------------------------------

  #currentDetail(taskId: string): TaskDetail {
    const detail = this.#tasks.getTask(taskId);
    if (detail === null) {
      throw new CheckpointError("task_not_found", `task ${taskId} does not exist`);
    }
    return detail;
  }

  #applyAction(action: ReconcileAction): void {
    // 回卷为 pending 清空旧结果（重放会重新产出）；pending_review 保留 result 供核对
    const clearResult = action.to_status === "pending";
    this.#tasks.setNodeState(action.node_id, {
      status: action.to_status,
      ...(clearResult ? { result: null, error: null } : {}),
    });
  }

  #checkpointEventId(checkpointId: string): string | null {
    const entry = this.ledger
      .scan({ taskId: undefined, eventType: TASK_CHECKPOINT_EVENT_TYPES.checkpointCreated })
      .find((e) => e.envelope.payload.checkpoint_id === checkpointId);
    return entry?.envelope.event_id ?? null;
  }

  async #buildSnapshot(taskId: string, detail: TaskDetail): Promise<CheckpointSnapshot> {
    const execution = this.#executionInfo === null
      ? { runtime_version: null, provider: null, tool_versions: {} }
      : await this.#executionInfo();

    // 输出引用：每个已完成节点最近一次 task.node_finished(completed) 事件 id
    const outputRefs: Record<string, string> = {};
    const nodeFinished = this.#ledger.scan({ taskId, eventType: "task.node_finished" });
    for (const node of detail.nodes) {
      if (node.status !== "completed") continue;
      const finished = [...nodeFinished]
        .reverse()
        .find((e) => e.envelope.payload.node_id === node.node_id && e.envelope.payload.status === "completed");
      if (finished !== undefined) outputRefs[node.key] = finished.envelope.event_id;
    }

    // run 根事件：最近一次 task.started / task.resumed
    const started = this.ledger.scan({ taskId, eventType: "task.started" });
    const resumed = this.ledger.scan({ taskId, eventType: "task.resumed" });
    const roots = [...started, ...resumed].sort((x, y) => x.sequence - y.sequence);
    const runRoot = roots.at(-1)?.envelope.event_id ?? null;
    const allEvents = this.ledger.scan({ taskId });
    const eventCursor = allEvents.at(-1)?.sequence ?? 0;

    const nodeModels: Record<string, string> = {};
    for (const node of detail.nodes) {
      if (node.model !== undefined) nodeModels[node.key] = node.model;
    }

    return {
      schema: CHECKPOINT_SNAPSHOT_SCHEMA,
      task: {
        task_id: detail.task_id,
        goal: detail.goal,
        status: detail.status,
        task_version: detail.task_version,
      },
      graph: {
        nodes: detail.nodes.map((node) => ({
          node_id: node.node_id,
          key: node.key,
          title: node.title,
          goal: node.goal ?? null,
          depends_on: [...node.depends_on],
          agent_role: node.agent_role ?? null,
          model: node.model ?? null,
          retriable: node.retriable,
          side_effect: node.side_effect,
          status: node.status,
          attempts: node.attempts,
          result: node.result ?? null,
          error: node.error ?? null,
        })),
        edges: detail.nodes.flatMap((node) =>
          node.depends_on.map((dep) => ({ from: dep, to: node.key })),
        ),
      },
      run: {
        status: detail.status,
        run_root_event_id: runRoot,
        event_cursor: eventCursor,
        output_refs: outputRefs,
      },
      workspace: null,
      workspace_note:
        "M1 tasks have no isolated workspace (FR-TASK-8, P1); file snapshot is null by design",
      execution: {
        runtime_version: execution.runtime_version,
        provider: execution.provider,
        node_models: nodeModels,
        tool_versions: execution.tool_versions ?? {},
      },
      session_ids: detail.session_id === undefined ? [] : [detail.session_id],
      pending_side_effects: detail.nodes.map((node) => ({
        key: node.key,
        side_effect: node.side_effect,
        state: pendingSideEffectState(node.status, node.side_effect),
      })),
    };
  }

  #appendTaskEvent(taskId: string, eventType: string, payload: Record<string, unknown>): void {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType,
      taskId,
      payload,
      causationId: null,
    });
    this.ledger.append(envelope);
  }
}

/** 待处理副作用状态机（快照时点；说明见 CheckpointPendingSideEffect） */
function pendingSideEffectState(status: TaskNodeStatus, sideEffect: SideEffectClass): CheckpointPendingSideEffect["state"] {
  if (status === "completed") {
    return sideEffect === "compensatable" ? "compensation_pending" : "delivered_unverified";
  }
  return "not_delivered";
}

function nodeStats(snapshot: CheckpointSnapshot): Record<string, number> {
  const stats: Record<string, number> = { total: snapshot.graph.nodes.length };
  for (const node of snapshot.graph.nodes) {
    stats[node.status] = (stats[node.status] ?? 0) + 1;
  }
  return stats;
}

/** Checkpoint 域事件族（event_type 清单只增不减） */
export const TASK_CHECKPOINT_EVENT_TYPES = {
  checkpointCreated: "task.checkpoint_created",
  restored: "task.restored",
} as const;
