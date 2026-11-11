import type { AgentRuntime, MorrowAgentEvent } from "@morrow/pi-adapter";
import { buildEventEnvelope } from "./envelope.ts";
import type { EventLedger } from "./ledger.ts";
import type { NodeResources, TaskNodeRecord, TaskSummary } from "@morrow/protocol";
import { TASK_EVENT_TYPES, TaskError, type TaskService } from "./tasks.ts";
import {
  CheckpointService,
  planReconcile,
  type CheckpointRecord,
  type ReconcileReport,
} from "./checkpoint.ts";
import { SESSION_EVENT_TYPES } from "./sessions.ts";
import type { LockTable } from "./locks.ts";
import type { WorktreeManager, WorktreeRecord } from "./worktree.ts";
import { detectDualExecution } from "./lease/reconcile.ts";
import type { LeaseCoordinator } from "./lease/coordinator.ts";
import type { ExecutionLeaseRecord, LeaseStore } from "./lease/store.ts";

/**
 * 单机任务调度器（票 M1-T4 / Issue #16，FR-TASK-1 的调度半边；M1-T5 / Issue #17 扩展
 * pause/resume/restore 的编排；M2-T4 / Issue #25 扩展工作区隔离与资源锁）。
 *
 * 调度模型（M1 单机、单副本）：
 * - 就绪判定：节点 pending 且其全部依赖（task_edges 入边）completed——顺序由依赖
 *   拓扑保证；
 * - 并行：同批就绪节点并发执行，在跑数受 concurrency 上限约束（可配置，默认 2，
 *   最小 1）；同批按 node_seq（规划序）优先派发，行为确定；
 * - 资源锁（M2-T4 / FR-TASK-8）：节点 resources.lock 声明的 key 在派发前 acquire
 *   （全拿或全不拿；任一 key 被持有 → 本轮跳过，等持有者释放后重评——锁在节点终态
 *   finally 释放，故跳过只会等到同批在跑节点收尾，不产生空转）；无锁节点不受影响；
 * - 工作区隔离（M2-T4 / FR-TASK-8）：声明 resources.git_repo 的代码节点在独立
 *   Git Worktree 执行（每次尝试前 prepare/重置，工作目录 = worktree，经
 *   TaskNodeExecInput.workspace 注入节点 Agent 工具装配层——sandboxed 能力调用的
 *   workspace 据此指向 worktree）；节点成功后变更提交到 worktree 分支并合回主区：
 *   合并按仓库路径串行化（进程内互斥），先冲突检测（试合并 → 冲突 abort）→ 无冲突
 *   跑合并验证（git_repo.verify 命令在主区执行，缺省 diff 非空断言）→ 提交；
 *   冲突 → 节点 pending_review + task.merge_conflict 事件（needs_reconcile 语义的
 *   节点级落地；冲突 worktree 保留供 Owner 调解，任务转 waiting_input）；
 * - 多任务：schedule()/resume()/restore() 共用一条 FIFO 队列逐任务驱动（同一时刻
 *   至多一个任务在 #drive）——concurrency 是调度器级上限，串行化让它跨任务成立，
 *   任务内节点并行不受影响；
 * - 节点执行 = 一次 Agent Loop（复用 sessions.ts 的驱动模式：subscribe 窄事件 →
 *   账本事件 + causation 链）。工具事件复用既有 tool.started/tool.finished 类型
 *   （只加演进：信封带 task_id），causation 链到 task.node_started；
 * - 失败：节点失败（error 事件 / stop_reason error|aborted / prompt 拒绝 / 工厂抛错 /
 *   合并验证失败）时 retriable 节点自动重试一次（每次调度运行内最多 2 次；跨恢复的
 *   attempts 在节点行上累计递增）；最终失败标记节点 failed，等在跑兄弟节点收尾后整
 *   任务迁 failed（task.failed payload 带 node_id 与原因）；冲突不是失败——不重试，
 *   直接挂起等 Owner；
 * - 暂停（M1-T5）：pause = 停止派发（#pausing 标志即时生效）+ 等在跑节点到边界
 *   （自然收尾，不中止）→ task.paused 迁移 → checkpoint 落库。安全点语义：在跑
 *   节点的工作不浪费、事件流保持真实（不产生 aborted 节点簿记）；pause 一旦受理
 *   即粘滞（drive 主循环让位，不会并发地把任务迁到 completed）；
 * - 恢复（M1-T5）：resume = 从最新 checkpoint（可为空）reconcile（副作用分类 gate，
 *   见 checkpoint.ts planReconcile）→ task.restored → 迁回 running（或 stale-running
 *   恢复标记）→ 重新入队驱动；restore = 指定 checkpoint 的同一管线。reconcile 后
 *   只剩 pending_review 节点时任务转 waiting_input（reconciliation_required）；
 * - 接管（M1-T6）：actor=owner 的节点不派发（Owner 手工执行）；无可跑节点且只剩
 *   owner 节点/待核对节点时任务转 waiting_input（owner_intervention）。Owner 完成
 *   （completeNode）或交还（releaseNode）后经 kick() 重新驱动：waiting_input →
 *   running（task.resumed）→ 入队继续。
 *
 * 事件 actor 一律 agent:runtime；全部事件 task_id 关联，可经
 * GET /v1/tasks/:id/events（账本 task_id 专列）查询。
 */

export const DEFAULT_TASK_CONCURRENCY = 2;
export const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_ATTEMPTS_RETRIABLE = 2;
const PAUSE_SETTLE_TIMEOUT_MS = 10_000;
const PAUSE_POLL_MS = 20;
const TRANSFER_SETTLE_TIMEOUT_MS = 2_000;

const TERMINAL_TASK_STATUSES = new Set(["failed", "completed", "cancelled", "needs_reconcile"]);

/** 节点执行工作区（M2-T4）：git_repo 代码节点的 worktree（非代码节点缺省无此字段） */
export interface NodeWorkspaceInfo {
  /** worktree 检出目录（节点 Agent 的工作目录；sandboxed 调用的 workspace 根） */
  dir: string;
  /** 主区仓库顶层（变更合回目标） */
  repoPath: string;
  /** worktree 专属分支 morrow/<task_id>/<node_key> */
  branch: string;
  /** 基线提交（diff/合并基准） */
  base: string;
}

/** 节点执行输入（工厂 seam：生产按 Provider 构建 PiAdapter；测试注入 FakePi 脚本） */
export interface TaskNodeExecInput {
  taskId: string;
  nodeId: string;
  key: string;
  title: string;
  /** 执行指令：节点 goal，缺省 title */
  goal: string;
  agentRole?: string;
  model?: string;
  /** 第几次尝试（1 起；跨恢复累计：stale 半写的那次也计入） */
  attempt: number;
  /** 节点资源声明（M2-T4）：工具装配层可据此感知 git_repo/lock（如验证命令展示） */
  resources?: NodeResources;
  /**
   * 节点工作区（M2-T4 / FR-TASK-8）：仅 resources.git_repo 声明的代码节点有值。
   * 工具装配层据此把 sandboxed 能力调用的 workspace 指向 worktree（与 M2-T2
   * SandboxToolPackage.workspaceDir 契约对齐）；非代码节点缺省 = 无隔离工作区。
   */
  workspace?: NodeWorkspaceInfo;
}

export type NodeAgentFactory = (node: TaskNodeExecInput) => Promise<AgentRuntime>;

export interface TaskSchedulerOptions {
  tasks: TaskService;
  ledger: EventLedger;
  replicaId: string;
  /** null 时每个节点尝试即失败（error = 说明），任务以 failed 收尾——诚实留痕而非静默 */
  nodeAgentFactory: NodeAgentFactory | null;
  /** Checkpoint 服务（M1-T5：pause 落 checkpoint；resume/restore 经它 reconcile） */
  checkpoints: CheckpointService;
  /** 同时在跑节点上限；默认 2，最小 1 */
  concurrency?: number;
  /**
   * Worktree 管理器（M2-T4 / FR-TASK-8）：生产由 startRuntime 注入（root =
   * <dataDir>/worktrees）。缺省 null = 无隔离执行；代码节点（声明 git_repo）在
   * 无管理器时派发即失败（诚实留痕，不静默降级到主区执行）。
   */
  worktrees?: WorktreeManager | null;
  /**
   * 资源锁表（M2-T4 / FR-TASK-8）：生产由 startRuntime 注入（events.sqlite 同库）。
   * 缺省 null = 无互斥；声明 lock 的节点同样派发即失败。
   */
  locks?: LockTable | null;
  /**
   * 执行租约（M3-T4 / Issue #33，FR-DEP-4）：生产由 startRuntime 注入（同库）。
   * 缺省 null = 未启用（单机旧行为；测试/宿主可显式注入以启用单点执行）。
   * 启用后：planned→running 前 acquire（失败保持 planned + task.lease_denied）；
   * 执行期间心跳续租；节点完成/合并提交前校验 fencing token。
   */
  leases?: LeaseStore | null;
  /** 租约 TTL（毫秒，默认 30s） */
  leaseTtlMs?: number;
  /** 心跳续租间隔（毫秒，默认 ttl/3） */
  leaseHeartbeatMs?: number;
  /**
   * 跨设备执行权协调器（M3 同步接线修复 / Issue #34）：acquire 前向全部已配对 peer
   * 增量拉取并重放远端租约；acquire 后二次采样检测近同时 acquire。缺省 null = 纯本地
   * 互斥（旧行为，直接建 TaskScheduler 的单测）。
   */
  leaseCoordinator?: LeaseCoordinator | null;
}

interface NodeOutcome {
  ok: boolean;
  text: string;
  error?: string;
  stopReason?: string;
}

/** 节点 worktree → 主区的合并结果（事件由 #runNode 统一按行→事件次序写） */
type NodeMergeResult =
  | { kind: "merged"; merged_commit: string; files: string[]; validated_by: "verify_command" | "diff_nonempty" }
  | { kind: "conflict"; files: string[] }
  | { kind: "failed"; error: string };

export interface PauseResult {
  task: TaskSummary;
  checkpoint: CheckpointRecord;
}

export interface ResumeResult {
  task: TaskSummary;
  report: ReconcileReport;
  checkpoint_id: string | null;
  /** 后台驱动 promise（HTTP 层 202 后 fire-and-forget） */
  drive: Promise<void>;
}

/** 执行权转移结果（M3-T4 / Issue #33）：释放后的租约行保留 token 计数 */
export interface TransferExecutionResult {
  task: TaskSummary;
  lease: ExecutionLeaseRecord | null;
  transferEventId: string;
  sequence: number;
}

export class TaskScheduler {
  readonly #tasks: TaskService;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #factory: NodeAgentFactory | null;
  readonly #checkpoints: CheckpointService;
  readonly #concurrency: number;
  readonly #worktrees: WorktreeManager | null;
  readonly #locks: LockTable | null;
  readonly #leases: LeaseStore | null;
  readonly #leaseTtlMs: number;
  readonly #leaseHeartbeatMs: number;
  readonly #leaseCoordinator: LeaseCoordinator | null;
  readonly #active = new Set<AgentRuntime>();
  /** 任务 → 在跑 AgentRuntime（租约丢失/执行权转移时按任务中止） */
  readonly #activeByTask = new Map<string, Set<AgentRuntime>>();
  /** 本进程持有的租约 token + 心跳计时器 */
  readonly #leaseHandles = new Map<string, { token: number; timer: ReturnType<typeof setInterval> | null }>();
  /** 租约已丢失（心跳续租失败 / fencing token 被抢占）——本进程不再提交任何副作用 */
  readonly #leaseLost = new Set<string>();
  /** 执行权已转移离开本副本（本进程不再驱动该任务） */
  readonly #detached = new Set<string>();
  /** 待调度的任务 FIFO（schedule/resume/restore 共用；并发上限按调度器全局记账） */
  readonly #queue: Array<{ run: () => Promise<void>; resolve: () => void; reject: (err: unknown) => void }> = [];
  /** pause 已受理、正在等边界的任务（drive 主循环见之让位） */
  readonly #pausing = new Set<string>();
  /** 本进程内正在 #drive 的任务（stale-running 判定：running 且不在本集合 = 中断残留） */
  readonly #driving = new Set<string>();
  /** 主区合并互斥（M2-T4）：按仓库路径串行化 mergeToBase（进程内；跨进程由执行租约排除） */
  readonly #repoMerges = new Map<string, Promise<void>>();
  #draining = false;
  #disposed = false;

  constructor(options: TaskSchedulerOptions) {
    this.#tasks = options.tasks;
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#factory = options.nodeAgentFactory;
    this.#checkpoints = options.checkpoints;
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_TASK_CONCURRENCY));
    this.#worktrees = options.worktrees ?? null;
    this.#locks = options.locks ?? null;
    this.#leases = options.leases ?? null;
    this.#leaseTtlMs = Math.max(1, Math.floor(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS));
    this.#leaseHeartbeatMs = Math.max(
      1,
      Math.floor(options.leaseHeartbeatMs ?? Math.max(1, Math.floor(this.#leaseTtlMs / 3))),
    );
    this.#leaseCoordinator = options.leaseCoordinator ?? null;
  }

  /**
   * 驱动一个 planned 任务到终端态（或被外部暂停/取消而停止）。
   * 入队 FIFO 逐个驱动（同一时刻至多一个任务在 #drive）：并发上限是调度器级资源，
   * 串行化让「同时在跑节点 ≤ concurrency」跨任务成立；任务内的节点并行不受影响。
   * 只接受 planned 状态（否则 invalid_transition——running/planned 之外的迁移由
   * 状态机拒绝）；resolve 表示本轮调度结束（任务 completed/failed 或暂停让位）。
   */
  schedule(taskId: string): Promise<void> {
    const task = this.#tasks.getTask(taskId);
    if (task === null) {
      return Promise.reject(new TaskError("not_found", `task ${taskId} does not exist`));
    }
    if (this.#detached.has(taskId)) {
      return Promise.reject(new TaskError(
        "lease_not_held",
        `execution of task ${taskId} was transferred away from replica ${this.#replicaId}`,
      ));
    }
    return this.#enqueue(taskId, () => this.#scheduleOne(taskId));
  }

  /**
   * 暂停（M1-T5 / FR-TASK-3 暂停半边）：安全点暂停。
   * 流程：受理（#pausing 即刻停派发）→ 等在跑节点到边界（不中止，PAUSE_SETTLE_TIMEOUT_MS
   * 内未收尾则 timeout）→ task.paused 迁移 → checkpoint（FR-TASK-5 快照）落库。
   * 任务在等待期间被并发终结（completed/failed）时抛 invalid_transition（任务状态为准）。
   */
  async pause(taskId: string): Promise<PauseResult> {
    const task = this.#tasks.getTask(taskId);
    if (task === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    if (task.status !== "running") {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is ${task.status}, expected running to pause`,
        { from: task.status, to: "paused" },
      );
    }
    this.#pausing.add(taskId);
    try {
      await this.#waitForSettled(taskId);
      const fresh = this.#tasks.getTask(taskId);
      if (fresh === null) {
        throw new TaskError("not_found", `task ${taskId} does not exist`);
      }
      if (fresh.status !== "running") {
        throw new TaskError(
          "invalid_transition",
          `task ${taskId} is ${fresh.status}; it left running while pausing`,
          { from: task.status, to: "paused" },
        );
      }
      const transitioned = this.#tasks.transition(taskId, "paused", {
        payload: { reason: "owner_request" },
      });
      const checkpoint = await this.#checkpoints.createCheckpoint(taskId, "pause");
      return { task: transitioned.task, checkpoint };
    } finally {
      this.#pausing.delete(taskId);
    }
  }

  /**
   * 恢复（M1-T5）：从最新 checkpoint（无 checkpoint 时按活状态）reconcile 后续跑。
   * 接受 paused / waiting_input / planned（崩溃前未调度）/ running（中断残留：本进程
   * 未在驱动）；活跃 running 与终端态拒绝（invalid_transition）。
   */
  async resume(taskId: string): Promise<ResumeResult> {
    const task = this.#assertResumable(taskId);
    const latest = this.#checkpoints.latestCheckpoint(taskId);
    return this.#resumeFrom(task, latest?.checkpoint_id ?? null);
  }

  /** 指定 checkpoint 恢复（M1-T5）：与 resume 同一 reconcile 管线；校验归属与版本。 */
  async restore(taskId: string, checkpointId: string): Promise<ResumeResult> {
    const task = this.#assertResumable(taskId);
    return this.#resumeFrom(task, checkpointId);
  }

  /**
   * 介入后重新驱动（M1-T6）：Owner 完成接管节点（completeNode）、交还（releaseNode）
   * 或补充上下文（supply，FR-TASK-3）后调用。仅 waiting_input 会被迁回 running
   * （task.resumed，payload.reason 记录介入动作）并入队继续；其余状态（running 自会
   * 在跑、planned/paused 走显式 resume、终端态无可驱动）为无操作。未知任务抛 not_found。
   */
  async kick(
    taskId: string,
    reason: "owner_node_completed" | "owner_node_released" | "context_supplied" = "owner_node_completed",
  ): Promise<TaskSummary> {
    const task = this.#tasks.getTask(taskId);
    if (task === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    if (this.#detached.has(taskId)) {
      throw new TaskError(
        "lease_not_held",
        `execution of task ${taskId} was transferred away from replica ${this.#replicaId}`,
      );
    }
    if (task.status !== "waiting_input") return task;
    // 双端独立执行证据 → 冻结为 needs_reconcile，不重新驱动
    const evidence = detectDualExecution(this.#ledger, taskId);
    if (evidence !== null) {
      this.#tasks.flagNeedsReconcile(taskId, evidence);
      return this.#tasks.getTask(taskId) ?? task;
    }
    const acquired = await this.#acquireLease(taskId, null);
    if (!acquired.ok) {
      throw new TaskError(
        "lease_denied",
        `execution lease for task ${taskId} is held by replica ${acquired.heldBy}`,
        { task_id: taskId, holder_replica_id: acquired.heldBy, expires_at: acquired.expiresAt },
      );
    }
    try {
      const rootEventId = this.#tasks.transition(taskId, "running", {
        payload: { reason },
      }).eventId;
      await this.#enqueue(taskId, async () => {
        try {
          await this.#drive(taskId, rootEventId);
        } finally {
          this.#driving.delete(taskId);
        }
      });
    } catch (err) {
      this.#releaseLease(taskId);
      throw err;
    }
    return this.#tasks.getTask(taskId) ?? task;
  }

  /** 优雅退出：拒绝未开跑的排队任务、中止在跑节点运行时并等待收尾（上限 2s） */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const entry of this.#queue.splice(0)) {
      entry.reject(new Error("task scheduler disposed before the task started"));
    }
    const runtimes = [...this.#active];
    for (const runtime of runtimes) runtime.abort();
    if (runtimes.length > 0) {
      await Promise.race([
        Promise.allSettled(runtimes.map((runtime) => runtime.waitForIdle())),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    // 优雅退出释放本副本持有的租约（崩溃路径由 TTL 兜底）：另一副本可立即接管
    for (const taskId of [...this.#leaseHandles.keys()]) {
      this.#releaseLease(taskId);
    }
  }

  /**
   * 崩溃残留清扫（M2-T4 / FR-TASK-8）：启动时（startRuntime）或运维入口调用——
   * - worktree：清扫非存活任务的目录与分支。存活 = 本进程正在驱动，或任务中还有
   *   pending_review 节点（冲突 worktree 是 Owner 调解证据，重启不得丢）；
   * - 锁：清除不在本进程在跑任务的锁行。租约语义（GLOSSARY）下同一 Run 全局单点
   *   执行，启动时刻不可能有合法旧持有者 → 启动调用时全清。
   */
  async sweepResidue(): Promise<{ worktrees: string[]; locks: number }> {
    const worktrees = this.#worktrees === null
      ? []
      : await this.#worktrees.sweepStale((taskId) => {
          if (this.#driving.has(taskId)) return true;
          const detail = this.#tasks.getTask(taskId);
          return detail !== null && detail.nodes.some((n) => n.status === "pending_review");
        });
    const locks = this.#locks === null ? 0 : this.#locks.sweepStale((row) => this.#driving.has(row.task_id));
    return { worktrees, locks };
  }

  // --- 入口辅助 ----------------------------------------------------------------

  #enqueue(taskId: string, run: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ run, resolve, reject });
      void this.#drain();
    });
  }

  #enqueueDrive(taskId: string, rootEventId: string): Promise<void> {
    return this.#enqueue(taskId, () => this.#driveTracked(taskId, rootEventId));
  }

  #assertResumable(taskId: string): NonNullable<ReturnType<TaskService["getTask"]>> {
    const task = this.#tasks.getTask(taskId);
    if (task === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is terminal (${task.status}) and cannot resume`,
        { from: task.status, to: "running" },
      );
    }
    if (this.#detached.has(taskId)) {
      throw new TaskError(
        "lease_not_held",
        `execution of task ${taskId} was transferred away from replica ${this.#replicaId}`,
      );
    }
    if (task.status === "created") {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} has no plan (still created); recreate the task instead of resuming`,
        { from: task.status, to: "running" },
      );
    }
    if (task.status === "running" && this.#driving.has(taskId)) {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is already running in this process`,
        { from: task.status, to: "running" },
      );
    }
    return task;
  }

  /**
   * reconcile（checkpoint 可空）→ task.restored → 迁回 running / 恢复标记 → 入队驱动。
   * #driving 在同步段即登记（并发双 resume 的第二个在入队前就被 409），驱动收尾时注销。
   */
  async #resumeFrom(
    task: NonNullable<ReturnType<TaskService["getTask"]>>,
    checkpointId: string | null,
  ): Promise<ResumeResult> {
    const taskId = task.task_id;
    this.#driving.add(taskId);
    try {
      // 双端独立执行证据：冻结为 needs_reconcile（不 restore、不驱动）
      const evidence = detectDualExecution(this.#ledger, taskId);
      if (evidence !== null) {
        this.#tasks.flagNeedsReconcile(taskId, evidence);
        this.#driving.delete(taskId);
        const fresh = this.#tasks.getTask(taskId) as TaskSummary;
        return {
          task: fresh,
          report: { actions: [], pending_review_keys: [], pending_compensations: [], replay_keys: [] },
          checkpoint_id: null,
          drive: Promise.resolve(),
        };
      }
      const acquired = await this.#acquireLease(taskId, null);
      if (!acquired.ok) {
        throw new TaskError(
          "lease_denied",
          `execution lease for task ${taskId} is held by replica ${acquired.heldBy}`,
          { task_id: taskId, holder_replica_id: acquired.heldBy, expires_at: acquired.expiresAt },
        );
      }
      const outcome = this.#checkpoints.restoreCheckpoint(taskId, checkpointId);
      let rootEventId = outcome.eventId;
      if (task.status === "planned" || task.status === "paused" || task.status === "waiting_input") {
        // planned→running 记 task.started；paused/waiting_input→running 记 task.resumed
        rootEventId = this.#tasks.transition(taskId, "running").eventId;
      } else if (task.status === "running") {
        // 中断残留（stale-running）：无状态迁移，补恢复标记（cause 上挂 checkpoint）
        rootEventId = this.#tasks.markResumedForRecovery(taskId, {
          reason: "recovered_after_interruption",
          checkpoint_id: outcome.checkpoint_id,
        }).eventId;
      }
      const drive = this.#enqueue(taskId, async () => {
        try {
          await this.#drive(taskId, rootEventId);
        } finally {
          this.#driving.delete(taskId);
        }
      });
      const fresh = this.#tasks.getTask(taskId);
      return {
        task: (fresh ?? task) as TaskSummary,
        report: outcome.report,
        checkpoint_id: outcome.checkpoint_id,
        drive,
      };
    } catch (err) {
      this.#driving.delete(taskId);
      this.#releaseLease(taskId);
      throw err;
    }
  }

  /** 等待任务无 running 节点（安全点）；任务先于边界离开 running 时立即返回 */
  async #waitForSettled(taskId: string): Promise<void> {
    const deadline = Date.now() + PAUSE_SETTLE_TIMEOUT_MS;
    for (;;) {
      const task = this.#tasks.getTask(taskId);
      if (task === null) {
        throw new TaskError("not_found", `task ${taskId} does not exist`);
      }
      if (task.status !== "running") return;
      if (!task.nodes.some((node) => node.status === "running")) return;
      if (Date.now() > deadline) {
        throw new TaskError(
          "timeout",
          `pause timed out waiting for in-flight nodes of task ${taskId} to settle`,
        );
      }
      await sleep(PAUSE_POLL_MS);
    }
  }

  // --- 调度主循环 --------------------------------------------------------------

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0 && !this.#disposed) {
        const next = this.#queue.shift() as { run: () => Promise<void>; resolve: () => void; reject: (err: unknown) => void };
        try {
          await next.run();
          next.resolve();
        } catch (err) {
          next.reject(err);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  /** #drive 的本进程记账包装（#driving 供 stale-running 判定与活跃 resume 拒绝） */
  async #driveTracked(taskId: string, rootEventId: string): Promise<void> {
    this.#driving.add(taskId);
    try {
      await this.#drive(taskId, rootEventId);
    } finally {
      this.#driving.delete(taskId);
    }
  }

  async #scheduleOne(taskId: string): Promise<void> {
    // 驱动记账从迁移前开始：迁移到 #drive 之间 resume 不得把任务误判为中断残留
    this.#driving.add(taskId);
    try {
      const task = this.#tasks.getTask(taskId);
      if (task === null) {
        throw new TaskError("not_found", `task ${taskId} does not exist`);
      }
      if (task.status !== "planned") {
        throw new TaskError(
          "invalid_transition",
          `task ${taskId} is ${task.status}, expected planned before scheduling`,
          { from: task.status, to: "running" },
        );
      }
      // causation 链：task.started 由规划完成触发 → 指向 task.planned 事件
      const plannedEvent = this.#ledger
        .scan({ taskId, eventType: TASK_EVENT_TYPES.taskPlanned })
        .at(-1);
      const plannedEventId = plannedEvent?.envelope.event_id ?? null;
      // 双端独立执行证据（同步进本账本的异地执行事件）→ needs_reconcile，不执行
      const evidence = detectDualExecution(this.#ledger, taskId);
      if (evidence !== null) {
        this.#tasks.flagNeedsReconcile(taskId, evidence, plannedEventId);
        return;
      }
      // 执行权单点化（FR-DEP-4）：planned→running 前必须持租约；失败保持 planned
      // 并记 task.lease_denied（payload 带持有者），不把任务标成失败。
      const acquired = await this.#acquireLease(taskId, plannedEventId);
      if (!acquired.ok) return;
      try {
        const started = this.#tasks.transition(taskId, "running", {
          causeEventId: plannedEventId,
        });
        await this.#drive(taskId, started.eventId);
      } catch (err) {
        // 迁移/驱动异常：不留下无人续租的租约（终结态由 #drive finally 释放）
        this.#releaseLease(taskId);
        throw err;
      }
    } finally {
      this.#driving.delete(taskId);
    }
  }

  // --- 调度主循环 --------------------------------------------------------------

  /** 驱动主体收尾统一释放已终结任务的租约（paused/waiting_input 保留，供本副本续驱） */
  async #drive(taskId: string, startedEventId: string): Promise<void> {
    try {
      await this.#driveBody(taskId, startedEventId);
    } finally {
      this.#releaseLeaseIfFinished(taskId);
    }
  }

  async #driveBody(taskId: string, startedEventId: string): Promise<void> {
    const inflight = new Map<string, { promise: Promise<void>; entry: { done: boolean } }>();
    while (!this.#disposed) {
      if (this.#detached.has(taskId) || this.#leaseLost.has(taskId)) return; // 执行权已离开本副本
      if (this.#pausing.has(taskId)) return; // pause 已受理：让位（不再派发/不再终结任务）
      const task = this.#tasks.getTask(taskId);
      if (task === null || task.status !== "running") return; // 被外部 paused/cancelled/failed

      const nodes = task.nodes;
      const completedKeys = new Set(nodes.filter((n) => n.status === "completed").map((n) => n.key));
      // actor=owner 的节点由 Owner 手工执行（M1-T6），调度器跳过派发
      const ready = nodes.filter(
        (n) =>
          n.status === "pending" &&
          n.actor !== "owner" &&
          n.depends_on.every((dep) => completedKeys.has(dep)),
      );
      for (const node of ready) {
        if (inflight.size >= this.#concurrency) break;
        // 资源锁（M2-T4）：派发前 acquire（全拿或全不拿）。任一 key 被持有 → 本轮
        // 跳过（节点留在 pending，等持有者节点收尾释放后下一轮重评——持有者必是本
        // 批在跑节点，不会空转）。声明 lock 而无锁表 → 派发即失败（不静默降级）。
        const lockKeys = node.resources?.lock ?? [];
        if (lockKeys.length > 0) {
          if (this.#locks === null) {
            this.#failNodeAtDispatch(taskId, node, startedEventId,
              "node declares resources.lock but the scheduler has no lock table configured");
            continue;
          }
          if (!this.#locks.acquireAll(lockKeys, taskId, node.node_id, new Date().toISOString())) continue;
        }
        const entry = { done: false };
        const promise = this.#runNode(taskId, node, startedEventId)
          .catch((err: unknown) => {
            // runNode 不应抛（节点失败已留痕）；兜底防未处理拒绝中断调度
            console.error("[morrow] task node runner crashed:", err);
          })
          .finally(() => {
            entry.done = true;
          });
        inflight.set(node.node_id, { promise, entry });
      }

      if (inflight.size === 0) {
        if (this.#pausing.has(taskId)) return;
        const fresh = this.#tasks.getTask(taskId);
        if (fresh === null || fresh.status !== "running") return;
        const nodesNow = fresh.nodes;
        const failedNode = nodesNow.find((n) => n.status === "failed");
        if (failedNode !== undefined) {
          this.#tasks.transition(taskId, "failed", {
            causeEventId: startedEventId,
            payload: {
              reason: "node_failed",
              node_id: failedNode.node_id,
              key: failedNode.key,
              message: failedNode.error ?? "node failed",
            },
            error: `node "${failedNode.key}" failed: ${failedNode.error ?? "unknown"}`,
          });
          return;
        }
        if (nodesNow.length > 0 && nodesNow.every((n) => n.status === "completed")) {
          this.#tasks.transition(taskId, "completed", {
            causeEventId: startedEventId,
            payload: {
              nodes_completed: nodesNow.length,
              nodes_total: nodesNow.length,
            },
          });
          return;
        }
        // 人工介入挂起（M1-T5 核对 / M1-T6 接管）：pending_review 节点与 actor=owner
        // 节点不可派发也不算失败，任务转 waiting_input 等 Owner 处理
        // （waiting_input→running 之后仍可恢复；kick 是介入后的重新驱动入口）
        const reviewNodes = nodesNow.filter((n) => n.status === "pending_review");
        const ownedNodes = nodesNow.filter((n) => n.status === "pending" && n.actor === "owner");
        if (reviewNodes.length > 0 || ownedNodes.length > 0) {
          this.#tasks.transition(taskId, "waiting_input", {
            causeEventId: startedEventId,
            payload: {
              reason: ownedNodes.length > 0 ? "owner_intervention" : "reconciliation_required",
              node_ids: [...reviewNodes, ...ownedNodes].map((n) => n.node_id),
              keys: [...reviewNodes, ...ownedNodes].map((n) => n.key),
            },
          });
          return;
        }
        // 无就绪、无在跑、未完成：合法 DAG（规划期已拒环）不会到达；防御性收尾
        this.#tasks.transition(taskId, "failed", {
          causeEventId: startedEventId,
          payload: { reason: "stalled" },
          error: "scheduler stalled: no runnable nodes",
        });
        return;
      }

      await Promise.race([...inflight.values()].map((running) => running.promise));
      for (const [nodeId, running] of [...inflight]) {
        if (running.entry.done) inflight.delete(nodeId);
      }
    }
  }

  // --- 节点执行（一次 Agent Loop；失败按 retriable 重试一次）--------------------

  async #runNode(taskId: string, node: TaskNodeRecord, startedEventId: string): Promise<void> {
    // attempts 跨恢复累计（M1-T5）：半写/回卷重放的节点在原 attempts 上递增，
    // node_started 的 attempt 编号与账本史一致；本调度运行内 retriable 最多 2 次
    const baseAttempts = this.#tasks.getNodeState(node.node_id)?.attempts ?? 0;
    const totalAttempts = node.retriable ? MAX_ATTEMPTS_RETRIABLE : 1;
    const gitRepo = node.resources?.git_repo;
    const lockKeys = node.resources?.lock ?? [];
    let outcome: NodeOutcome = { ok: false, text: "", error: "node did not run" };
    let worktree: WorktreeRecord | null = null;
    let keepWorktreeForReview = false;
    try {
      for (let i = 1; i <= totalAttempts; i++) {
        const attempt = baseAttempts + i;
        this.#tasks.setNodeRunning(node.node_id, attempt);

        // M2-T4：代码节点（resources.git_repo）每次尝试前 prepare worktree——
        // 幂等（同任务同节点复用同目录）且重置回基线（retry 拿到干净起点）。
        // prepare 走主区仓库互斥（与合并同一把锁，按声明路径分键）：并发 `git
        // worktree add` 会在 git 锁文件上竞争，串行化消除该瞬态失败源。
        let prepareError: string | null = null;
        if (gitRepo !== undefined) {
          if (this.#worktrees === null) {
            prepareError = "node declares resources.git_repo but the scheduler has no worktree manager configured";
          } else {
            try {
              worktree = await this.#withRepoMutex(gitRepo.path, () => this.#worktrees!.prepare({
                repoPath: gitRepo.path,
                taskId,
                nodeId: node.node_id,
                key: node.key,
                ...(gitRepo.branch === undefined ? {} : { branch: gitRepo.branch }),
              }));
            } catch (err) {
              worktree = null;
              prepareError = `worktree prepare failed: ${errorMessage(err)}`;
            }
          }
        }

        const nodeStarted = this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeStarted, {
          node_id: node.node_id,
          key: node.key,
          title: node.title,
          goal: node.goal ?? node.title,
          attempt,
          ...(worktree === null ? {} : {
            worktree: { dir: worktree.dir, branch: worktree.branch, base: worktree.base },
          }),
        }, startedEventId);

        if (prepareError !== null) {
          outcome = { ok: false, text: "", error: prepareError };
        } else {
          outcome = await this.#attemptNode(taskId, node, attempt, nodeStarted.eventId, worktree);

          // 执行权转移离开本副本：不记录节点终态（半写 running 留给新持有者按
          // checkpoint reconcile）；租约丢失：中止且置 pending_review（不假装失败、
          // 不提交结果），并已由心跳路径记 task.lease_lost。
          if (this.#detached.has(taskId)) return;
          if (this.#leaseLost.has(taskId)) {
            this.#abandonNodeForLeaseLoss(taskId, node, attempt, outcome, nodeStarted.eventId);
            return;
          }

          // M2-T4：Agent Loop 成功的代码节点 → worktree 变更合回主区
          if (outcome.ok && worktree !== null && gitRepo !== undefined) {
            // 真实文件副作用提交前校验 fencing token（FR-DEP-4）：旧 token 不合并
            if (!this.#assertLeaseValid(taskId)) {
              this.#abandonNodeForLeaseLoss(taskId, node, attempt, outcome, nodeStarted.eventId);
              return;
            }
            const merge = await this.#mergeNodeWorktree(taskId, node, worktree, gitRepo.verify, nodeStarted.eventId);
            if (merge.kind === "conflict") {
              // 冲突 → pending_review（needs_reconcile 语义的节点级落地）：不重试，
              // 等 Owner 核对；worktree/分支保留作调解证据，任务转 waiting_input
              keepWorktreeForReview = true;
              this.#tasks.setNodeState(node.node_id, { status: "pending_review", result: outcome.text });
              this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskMergeConflict, {
                node_id: node.node_id,
                key: node.key,
                branch: worktree.branch,
                base: worktree.base,
                repo: worktree.repoPath,
                worktree_dir: worktree.dir,
                files: merge.files,
                note: "conflict kept in the worktree branch; reconcile then re-run or complete the node",
              }, nodeStarted.eventId);
              this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeFinished, {
                node_id: node.node_id,
                key: node.key,
                status: "pending_review",
                attempt,
                result: outcome.text,
              }, nodeStarted.eventId);
              return;
            }
            if (merge.kind === "merged") {
              this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskMerged, {
                node_id: node.node_id,
                key: node.key,
                branch: worktree.branch,
                base: worktree.base,
                merged_commit: merge.merged_commit,
                files: merge.files,
                validated_by: merge.validated_by,
                worktree_dir: worktree.dir,
              }, nodeStarted.eventId);
            } else {
              // 合并验证失败（empty_merge / verify_failed / git_failed）→ 按尝试失败走
              // 重试/终态路径（主区已回滚，下一尝试重置 worktree 从基线重来）
              outcome = { ok: false, text: outcome.text, error: merge.error };
            }
          }
        }

        const status = outcome.ok ? "completed" : "failed";
        // 节点完成提交前再校验一次 fencing token（合并可能耗时，租约可能在期间被抢占）
        if (outcome.ok && !this.#assertLeaseValid(taskId)) {
          this.#abandonNodeForLeaseLoss(taskId, node, attempt, outcome, nodeStarted.eventId);
          return;
        }
        const payload: Record<string, unknown> = {
          node_id: node.node_id,
          key: node.key,
          status,
          attempt,
        };
        if (outcome.text.length > 0) payload.result = outcome.text;
        if (!outcome.ok && outcome.error !== undefined) payload.error = outcome.error;
        if (outcome.stopReason !== undefined) payload.stop_reason = outcome.stopReason;
        this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeFinished, payload, nodeStarted.eventId);

        if (outcome.ok) {
          this.#tasks.setNodeFinished(node.node_id, "completed", { result: outcome.text });
          return;
        }
        this.#tasks.setNodeFinished(node.node_id, "failed", { error: outcome.error });
        // retriable 且未用尽尝试 → 继续循环重试；否则保持 failed 由主循环收敛任务状态
      }
    } finally {
      // 资源锁释放：节点到达终态（completed/failed/pending_review）一律释放（M2-T4）
      if (lockKeys.length > 0 && this.#locks !== null) {
        this.#locks.releaseAll(taskId, node.node_id);
      }
      // worktree 清理：已合并/失败 → 清掉（目录 + 分支）；冲突挂起 → 保留（调解证据）
      if (worktree !== null && !keepWorktreeForReview && this.#worktrees !== null) {
        try {
          await this.#worktrees.cleanup(worktree);
        } catch (err) {
          console.error("[morrow] worktree cleanup failed:", err);
        }
      }
    }
  }

  /**
   * worktree 变更 → 提交到 worktree 分支 → 合回主区（按仓库路径互斥串行化）。
   * 空变更即合并验证失败（diff 非空断言）；verify 命令由 mergeToBase 在主区执行。
   */
  async #mergeNodeWorktree(
    taskId: string,
    node: TaskNodeRecord,
    worktree: WorktreeRecord,
    verify: string | undefined,
    nodeStartedEventId: string,
  ): Promise<NodeMergeResult> {
    void nodeStartedEventId; // 事件统一由 #runNode 按行→事件次序写；此处仅计算结果
    let committed: { commit: string | null; files: number };
    try {
      committed = await (this.#worktrees as WorktreeManager).commitChanges(
        worktree,
        `morrow: node ${node.key} (task ${taskId})`,
      );
    } catch (err) {
      return { kind: "failed", error: `worktree commit failed: ${errorMessage(err)}` };
    }
    if (committed.commit === null) {
      return {
        kind: "failed",
        error: "merge validation failed: worktree produced no changes (empty diff against baseline; code nodes must produce changes)",
      };
    }
    return this.#withRepoMutex(worktree.repoPath, async () => {
      const outcome = await (this.#worktrees as WorktreeManager).mergeToBase(
        worktree,
        verify === undefined ? {} : { verify },
      );
      if (outcome.ok) {
        return { kind: "merged", merged_commit: outcome.merged_commit, files: outcome.files, validated_by: outcome.validated_by };
      }
      if (outcome.kind === "conflict") {
        return { kind: "conflict", files: outcome.files ?? [] };
      }
      return { kind: "failed", error: `merge ${outcome.kind}: ${outcome.error ?? "unknown"}` };
    });
  }

  /** 主区合并互斥：同一仓库的合并串行化（前驱失败不阻塞后续；进程内口径） */
  #withRepoMutex<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#repoMerges.get(repoPath) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.#repoMerges.set(repoPath, run.then(() => undefined, () => undefined));
    return run;
  }

  // --- 执行租约（M3-T4 / Issue #33，FR-DEP-4）----------------------------------

  /**
   * 申请执行租约；失败时记 task.lease_denied（payload 带持有者/到期/token/来源）并
   * 返回失败结果——任务保持 planned/waiting_input，不执行，也不标 failed。
   *
   * 跨设备事前互斥（M3 同步接线修复 / Issue #34）：注入 LeaseCoordinator 时
   *   1. acquire 前向全部已配对 peer 增量拉取（只 pull），重放远端租约；远端持有
   *      未过期租约 → 直接拒绝，不写本地租约行；
   *   2. 本地 acquire 成功后落 task.lease_acquired，再强制二次拉取——若两端都持有
   *      未过期租约（近同时 acquire）→ 立即释放本地租约、冻结 needs_reconcile，
   *      不启动心跳、不执行节点。
   */
  async #acquireLease(
    taskId: string,
    causeEventId: string | null,
  ): Promise<{ ok: true } | { ok: false; heldBy: string; expiresAt: string }> {
    if (this.#leases === null) return { ok: true };
    if (this.#leaseLost.has(taskId) || this.#detached.has(taskId)) {
      return { ok: false, heldBy: "<detached>", expiresAt: new Date(0).toISOString() };
    }
    const existing = this.#leaseHandles.get(taskId);

    // 1) 事前检查：已持有（幂等路径）不再拉取；否则拉取并重放远端租约。
    if (existing === undefined && this.#leaseCoordinator !== null) {
      const gate = await this.#leaseCoordinator.beforeAcquire(taskId);
      // 跨副本 fencing 观察值（M3 修复批 / #33）：取号越过它，validate 拒绝旧 token。
      this.#observeLeaseTokens(taskId, gate.observed);
      if (!gate.ok && gate.holder !== null) {
        this.#appendTaskEvent(
          taskId,
          TASK_EVENT_TYPES.taskLeaseDenied,
          {
            replica_id: this.#replicaId,
            holder_replica_id: gate.holder.holder_replica_id,
            fencing_token: gate.holder.fencing_token,
            expires_at: gate.holder.expires_at,
            source: "remote_lease",
            remote_peer_replica_id: gate.holder.source_replica_id,
            remote_lease_event_id: gate.holder.event_id,
            pull_errors: gate.pull.errors,
          },
          causeEventId,
        );
        return {
          ok: false,
          heldBy: gate.holder.holder_replica_id,
          expiresAt: gate.holder.expires_at,
        };
      }
    }

    const outcome = this.#leases.acquire(taskId, this.#replicaId, this.#leaseTtlMs);
    if ("heldBy" in outcome) {
      this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskLeaseDenied, {
        replica_id: this.#replicaId,
        holder_replica_id: outcome.heldBy,
        expires_at: outcome.expires_at,
        fencing_token: outcome.fencing_token,
        source: "local_lease_table",
      }, causeEventId);
      return { ok: false, heldBy: outcome.heldBy, expiresAt: outcome.expires_at };
    }
    if (existing !== undefined && existing.token === outcome.token) {
      // 幂等 acquire（同一 holder 未过期）：沿用既有心跳，不重复起计时器/不重复落事件
      return { ok: true };
    }
    if (existing !== undefined) this.#clearLeaseTimer(taskId);

    // 2) 本地持有已生效：落租约生命周期事件（随同步传播，供对端事前判断）。
    this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskLeaseAcquired, {
      replica_id: this.#replicaId,
      holder_replica_id: this.#replicaId,
      fencing_token: outcome.token,
      expires_at: outcome.expires_at,
      acquired_at: outcome.acquired_at,
    }, causeEventId);

    // 3) 二次采样：近同时 acquire 的对方事件可能刚到。双持有 → 释放并冻结，不执行。
    if (this.#leaseCoordinator !== null) {
      const verify = await this.#leaseCoordinator.afterAcquire(taskId);
      this.#observeLeaseTokens(taskId, verify.observed);
      if (!verify.ok && verify.dual_hold) {
        this.#leases.release(taskId, this.#replicaId, outcome.token);
        this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskLeaseReleased, {
          replica_id: this.#replicaId,
          holder_replica_id: this.#replicaId,
          fencing_token: outcome.token,
          reason: "dual_hold_reconcile",
        }, causeEventId);
        if (verify.evidence !== null) {
          this.#tasks.flagNeedsReconcile(taskId, verify.evidence, causeEventId);
        }
        return {
          ok: false,
          heldBy: verify.holder?.holder_replica_id ?? "<dual_hold>",
          expiresAt: verify.holder?.expires_at ?? outcome.expires_at,
        };
      }
    }

    this.#leaseHandles.set(taskId, { token: outcome.token, timer: null });
    this.#startLeaseHeartbeat(taskId, outcome.token);
    return { ok: true };
  }

  /** 把租约视图观察到的跨副本最大 token 写入 LeaseStore（幂等取 max） */
  #observeLeaseTokens(taskId: string, observed: { granted: number; reserved: number }): void {
    if (this.#leases === null) return;
    if (observed.granted > 0) this.#leases.observeGrantedToken(taskId, observed.granted);
    if (observed.reserved > 0) this.#leases.observeReservedToken(taskId, observed.reserved);
  }

  /** 心跳续租（默认 ttl/3）；renew 失败 = token 已被抢占/过期 → 中止并记 task.lease_lost。 */
  #startLeaseHeartbeat(taskId: string, token: number): void {
    if (this.#leaseHeartbeatMs <= 0) return;
    const timer = setInterval(() => {
      const handle = this.#leaseHandles.get(taskId);
      if (handle === undefined || handle.token !== token) return;
      if (this.#detached.has(taskId) || this.#leaseLost.has(taskId)) return;
      if (this.#leases === null) return;
      if (!this.#leases.renew(taskId, this.#replicaId, token)) {
        this.#handleLeaseLost(taskId, token, "renew_failed");
        return;
      }
      // 续租事件让远端看到新的 expires_at；否则对端只能看到 acquire 时的 TTL，
      // 会把仍在续租的持有者误判为过期（事前互斥的数据源必须含心跳）。
      const current = this.#leases.current(taskId);
      if (current !== null) {
        this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskLeaseRenewed, {
          replica_id: this.#replicaId,
          holder_replica_id: this.#replicaId,
          fencing_token: token,
          expires_at: current.expires_at,
        }, null);
      }
    }, this.#leaseHeartbeatMs);
    if (typeof timer.unref === "function") timer.unref();
    const handle = this.#leaseHandles.get(taskId);
    if (handle !== undefined) handle.timer = timer;
  }

  /**
   * 租约丢失：记 task.lease_lost（含 token/原因）并中止该任务在跑节点。本进程此后
   * 不再驱动或提交该任务；节点行由 #runNode 置 pending_review（半写证据保留）。
   */
  #handleLeaseLost(taskId: string, token: number, reason: string): void {
    if (this.#leaseLost.has(taskId)) return;
    this.#leaseLost.add(taskId);
    this.#clearLeaseTimer(taskId);
    this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskLeaseLost, {
      replica_id: this.#replicaId,
      fencing_token: token,
      reason,
    }, null);
    this.#abortTask(taskId);
  }

  /** 副作用提交前校验：token 仍有效则 true；失效 → 按租约丢失处理并返回 false。 */
  #assertLeaseValid(taskId: string): boolean {
    if (this.#leases === null) return true;
    if (this.#leaseLost.has(taskId) || this.#detached.has(taskId)) return false;
    const handle = this.#leaseHandles.get(taskId);
    if (handle === undefined) return false;
    if (!this.#leases.validate(taskId, handle.token)) {
      this.#handleLeaseLost(taskId, handle.token, "fencing_token_invalid");
      return false;
    }
    return true;
  }

  /** 租约丢失后节点落 pending_review：保留已产出的文本供 Owner 核对，不提交结果。 */
  #abandonNodeForLeaseLoss(
    taskId: string,
    node: TaskNodeRecord,
    attempt: number,
    outcome: NodeOutcome,
    nodeStartedEventId: string,
  ): void {
    const message = "execution lease lost (fencing token is stale); node run aborted before commit";
    this.#tasks.setNodeState(node.node_id, {
      status: "pending_review",
      result: outcome.text.length > 0 ? outcome.text : null,
      error: message,
    });
    this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeFinished, {
      node_id: node.node_id,
      key: node.key,
      status: "pending_review",
      attempt,
      ...(outcome.text.length > 0 ? { result: outcome.text } : {}),
      error: message,
    }, nodeStartedEventId);
  }

  /** 释放本副本持有的租约（幂等；token 计数保留在行上） */
  #releaseLease(taskId: string): void {
    const handle = this.#leaseHandles.get(taskId);
    if (handle === undefined) return;
    this.#clearLeaseTimer(taskId);
    if (this.#leases !== null) {
      try {
        if (this.#leases.release(taskId, this.#replicaId, handle.token)) {
          // 释放也要随同步传播：否则对端会把本机残留的 acquire 事件当成仍持有。
          this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskLeaseReleased, {
            replica_id: this.#replicaId,
            holder_replica_id: this.#replicaId,
            fencing_token: handle.token,
            reason: "released",
          }, null);
        }
      } catch (err) {
        // 关闭竞态（库已 finalize）不影响进程退出；崩溃/正常退出后的租约由 TTL 兜底
        if (!this.#disposed) console.error("[morrow] lease release failed:", err);
      }
    }
    this.#leaseHandles.delete(taskId);
  }

  /** 任务终结/待裁决时释放租约；paused/waiting_input/running 保留（本副本续驱） */
  #releaseLeaseIfFinished(taskId: string): void {
    let task: ReturnType<TaskService["getTask"]>;
    try {
      task = this.#tasks.getTask(taskId);
    } catch {
      // 优雅退出竞态：任务库已关闭，直接释放并让 TTL 兜底
      this.#releaseLease(taskId);
      return;
    }
    if (task === null || TERMINAL_TASK_STATUSES.has(task.status)) {
      this.#releaseLease(taskId);
    }
  }

  #clearLeaseTimer(taskId: string): void {
    const handle = this.#leaseHandles.get(taskId);
    if (handle?.timer !== null && handle?.timer !== undefined) clearInterval(handle.timer);
    if (handle !== undefined) handle.timer = null;
  }

  /** 中止某任务全部在跑 AgentRuntime（租约丢失/执行权转移） */
  #abortTask(taskId: string): void {
    const runtimes = this.#activeByTask.get(taskId);
    if (runtimes === undefined) return;
    for (const runtime of [...runtimes]) runtime.abort();
  }

  /** 等待某任务在跑节点收尾（上限 timeoutMs；超时返回而非抛错） */
  async #waitTaskIdle(taskId: string, timeoutMs: number): Promise<void> {
    const runtimes = [...(this.#activeByTask.get(taskId) ?? [])];
    if (runtimes.length === 0) return;
    await Promise.race([
      Promise.allSettled(runtimes.map((runtime) => runtime.waitForIdle())),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  #trackActive(taskId: string, runtime: AgentRuntime): void {
    this.#active.add(runtime);
    const set = this.#activeByTask.get(taskId) ?? new Set<AgentRuntime>();
    set.add(runtime);
    this.#activeByTask.set(taskId, set);
  }

  #untrackActive(taskId: string, runtime: AgentRuntime): void {
    this.#active.delete(runtime);
    const set = this.#activeByTask.get(taskId);
    if (set === undefined) return;
    set.delete(runtime);
    if (set.size === 0) this.#activeByTask.delete(taskId);
  }

  /**
   * 执行权转移（POST /v1/tasks/:id/transfer-execution，FR-DEP-4）。
   *
   * 顺序：校验当前持有者 = 本副本 → 标记 detached（本进程不再驱动）→ 中止在跑节点 →
   * 落 reason=execution_transfer 的 checkpoint（目标副本恢复基准）→ release 租约 →
   * task.execution_transferred 事件。目标副本随后 acquire 得到 token+1；不可转移
   * 终端态（completed/failed/cancelled/needs_reconcile）任务。
   *
   * 边界：本端点只释放本副本的执行权，不代替目标设备 acquire（跨设备由目标设备收到
   * 转移事件后自行调用 /v1/tasks/:id/resume 前的 acquire 路径）；若任务未在本进程
   * 驱动（planned/paused/waiting_input），不中止任何运行时，仅释放并留痕。
   */
  async transferExecution(taskId: string, targetReplicaId: string): Promise<TransferExecutionResult> {
    const task = this.#tasks.getTask(taskId);
    if (task === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    if (typeof targetReplicaId !== "string" || targetReplicaId.trim().length === 0) {
      throw new TaskError("invalid_revision", "target_replica_id must be a non-empty string");
    }
    const target = targetReplicaId.trim();
    if (target === this.#replicaId) {
      throw new TaskError(
        "invalid_transition",
        "cannot transfer execution to the current holder replica; target must be another device",
      );
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is ${task.status}; execution cannot be transferred`,
        { from: task.status },
      );
    }
    if (this.#leases === null) {
      throw new TaskError("invalid_transition", "execution leases are not configured for this runtime");
    }
    const current = this.#leases.current(taskId);
    if (current === null || !current.active || current.holder_replica_id !== this.#replicaId) {
      throw new TaskError(
        "lease_not_held",
        `task ${taskId} execution lease is not held by replica ${this.#replicaId}`,
        { holder_replica_id: current?.holder_replica_id ?? null, fencing_token: current?.fencing_token ?? null },
      );
    }
    const token = current.fencing_token;
    const hadInflight = this.#driving.has(taskId) || (this.#activeByTask.get(taskId)?.size ?? 0) > 0;

    this.#detached.add(taskId);
    let checkpointId: string | undefined;
    if (hadInflight) {
      this.#abortTask(taskId);
      await this.#waitTaskIdle(taskId, TRANSFER_SETTLE_TIMEOUT_MS);
      try {
        const checkpoint = await this.#checkpoints.createCheckpoint(taskId, "execution_transfer");
        checkpointId = checkpoint.checkpoint_id;
      } catch (err) {
        // checkpoint 失败不阻断转移（账本事件仍是恢复证据），但必须在事件里留痕
        console.error("[morrow] checkpoint before execution transfer failed:", err);
      }
    }
    const released = this.#leases.release(taskId, this.#replicaId, token);
    if (!released) {
      this.#detached.delete(taskId);
      throw new TaskError(
        "lease_not_held",
        `execution lease for task ${taskId} changed while transferring`,
      );
    }
    this.#clearLeaseTimer(taskId);
    this.#leaseHandles.delete(taskId);
    const event = this.#tasks.recordExecutionTransferred(taskId, {
      from_replica_id: this.#replicaId,
      to_replica_id: target,
      fencing_token: token,
      next_fencing_token: token + 1,
      had_inflight_execution: hadInflight,
      ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    });
    // 转移声明的下一个号即刻成为本机校验下限：若本进程还残留旧 token 的提交路径，
    // validate 会拒绝（跨副本单调，M3 修复批 / #33）。
    this.#leases.observeGrantedToken(taskId, token);
    this.#leases.observeReservedToken(taskId, token + 1);
    return {
      task: this.#tasks.getTask(taskId) ?? task,
      lease: this.#leases.current(taskId),
      transferEventId: event.eventId,
      sequence: event.sequence,
    };
  }

  /** 派发期失败（资源配置错误等非尝试性失败）：直接落 failed 留痕，不进尝试循环 */
  #failNodeAtDispatch(taskId: string, node: TaskNodeRecord, startedEventId: string, message: string): void {
    this.#tasks.setNodeFinished(node.node_id, "failed", { error: message });
    this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeFinished, {
      node_id: node.node_id,
      key: node.key,
      status: "failed",
      error: message,
    }, startedEventId);
  }

  /** 单次尝试：取运行时（工厂抛错即失败）→ 驱动 Agent Loop → 产出结果 */
  async #attemptNode(
    taskId: string,
    node: TaskNodeRecord,
    attempt: number,
    nodeStartedEventId: string,
    worktree: WorktreeRecord | null,
  ): Promise<NodeOutcome> {
    const input: TaskNodeExecInput = {
      taskId,
      nodeId: node.node_id,
      key: node.key,
      title: node.title,
      goal: node.goal ?? node.title,
      ...(node.agent_role === undefined ? {} : { agentRole: node.agent_role }),
      ...(node.model === undefined ? {} : { model: node.model }),
      attempt,
      ...(node.resources === undefined ? {} : { resources: node.resources }),
      // 代码节点的工作区（M2-T4）：工具装配层据此把 sandboxed 调用的 workspace
      // 指向 worktree（SandboxToolPackage.workspaceDir 同一契约）
      ...(worktree === null ? {} : {
        workspace: {
          dir: worktree.dir,
          repoPath: worktree.repoPath,
          branch: worktree.branch,
          base: worktree.base,
        },
      }),
    };
    let runtime: AgentRuntime;
    try {
      if (this.#factory === null) {
        throw new Error("no node agent factory configured (taskNodeFactory missing)");
      }
      runtime = await this.#factory(input);
    } catch (err) {
      return { ok: false, text: "", error: errorMessage(err) };
    }
    return this.#driveRuntime(taskId, node, attempt, runtime, nodeStartedEventId);
  }

  /** Agent Loop 驱动（复用 sessions.ts 的窄事件翻译模式，事件挂 task_id） */
  async #driveRuntime(
    taskId: string,
    node: TaskNodeRecord,
    attempt: number,
    runtime: AgentRuntime,
    nodeStartedEventId: string,
  ): Promise<NodeOutcome> {
    this.#trackActive(taskId, runtime);
    // 累积值收在 holder 对象里：闭包内赋值 + await 后读取，避免 TS CFA 过窄收窄
    const run: { text: string; error: string | null; stopReason: string | null } = {
      text: "",
      error: null,
      stopReason: null,
    };
    const toolStarted = new Map<string, string>();
    const appendAgentError = (message: string): void => {
      run.error = message;
      this.#appendTaskEvent(taskId, SESSION_EVENT_TYPES.agentError, {
        message,
        node_id: node.node_id,
        key: node.key,
        attempt,
      }, nodeStartedEventId);
    };
    const unsubscribe = runtime.subscribe((event: MorrowAgentEvent) => {
      switch (event.type) {
        case "text_delta": {
          run.text += event.delta;
          break;
        }
        case "tool_start": {
          const started = this.#appendTaskEvent(taskId, SESSION_EVENT_TYPES.toolStarted, {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            args: event.args ?? null,
            node_id: node.node_id,
            key: node.key,
            attempt,
          }, nodeStartedEventId);
          toolStarted.set(event.toolCallId, started.eventId);
          break;
        }
        case "tool_end": {
          const payload: Record<string, unknown> = {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            text: event.text,
            is_error: event.isError,
            node_id: node.node_id,
            key: node.key,
            attempt,
          };
          if (event.durationMs !== undefined) payload.duration_ms = event.durationMs;
          this.#appendTaskEvent(taskId, SESSION_EVENT_TYPES.toolFinished, payload, toolStarted.get(event.toolCallId) ?? nodeStartedEventId);
          break;
        }
        case "error": {
          appendAgentError(event.message);
          break;
        }
        case "agent_end": {
          run.stopReason = event.stopReason;
          break;
        }
      }
    });
    try {
      await runtime.prompt(node.goal ?? node.title);
    } catch (err) {
      // 契约上 prompt 只在误用/中止时 reject；防御性兜底落 agent.error 留痕
      if (run.error === null) {
        appendAgentError(errorMessage(err));
      }
    } finally {
      unsubscribe();
      this.#untrackActive(taskId, runtime);
      runtime.dispose();
    }

    const aborted = run.stopReason === "aborted";
    const ok = run.error === null && !aborted && run.stopReason !== "error";
    const error = ok
      ? undefined
      : run.error ?? (aborted ? "agent loop aborted" : "agent loop ended with stop_reason error");
    return {
      ok,
      text: run.text,
      ...(error === undefined ? {} : { error }),
      ...(run.stopReason === null ? {} : { stopReason: run.stopReason }),
    };
  }

  #appendTaskEvent(
    taskId: string,
    eventType: string,
    payload: Record<string, unknown>,
    causationId: string | null,
  ): { eventId: string; sequence: number } {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType,
      taskId,
      payload,
      causationId,
    });
    const { sequence } = this.#ledger.append(envelope);
    return { eventId: envelope.event_id, sequence };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
