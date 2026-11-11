/**
 * 任务域 API 合约类型（M1-T4 / Issue #16，PRD §4.3 FR-TASK-1/2/6、§3 术语）。
 *
 * 与 api-contracts.ts 同一演进规则：字段只加不减、不改名、不收窄已有类型。
 * runtime 是唯一生产方，desktop（任务工作台，后续票）是消费方，两侧都从这里 import。
 */

/**
 * 任务状态机（决策稿 §6、PRD §4.6 FR-DEP-4）。
 * 合法迁移表由 runtime 侧持有；终端态 failed/completed/cancelled 不可再迁移。
 *
 * needs_reconcile（M3-T4 / Issue #33）：双端各自独立执行过同一任务（或各自推进过
 * task_version）时的冻结态——不自动合并、不假装某一边成功；由 Owner 显式裁决为
 * completed 或 failed 后离开该状态（见 runtime 的 reconcile 端点）。
 */
export type TaskStatus =
  | "created"
  | "planned"
  | "running"
  | "paused"
  | "waiting_input"
  | "failed"
  | "completed"
  | "cancelled"
  | "needs_reconcile";

/**
 * 节点执行状态（DAG 投影；pending = 依赖未满足，调度器就绪判定见 runtime scheduler）。
 * pending_review（M1-T5 / Issue #17）：副作用不可自动重发的节点恢复后的人工核对态——
 * 不可逆/未知分类的节点被回卷（或中断于半写状态）时不自动重执行，等 Owner 核对；
 * 调度器不派发该状态，含此类节点的任务在无可跑节点时转 waiting_input。
 */
export type TaskNodeStatus = "pending" | "running" | "completed" | "failed" | "pending_review";

/**
 * 节点责任方（M1-T6 / Issue #18）：缺省（字段省略）= 调度器自动执行；
 * "owner" = 已被 Owner 接管（takeover），调度器跳过派发，等 Owner 提交结果或交还。
 */
export type TaskNodeActor = "owner";

/**
 * 副作用分类（GLOSSARY: SideEffect；FR-TASK-6）。
 * M1-T4 只随节点记录字段，真实投递与人工核对/补偿在 M4（SideEffectOutbox）。
 */
export type SideEffectClass = "reversible" | "compensatable" | "irreversible" | "delivery_unknown";

/**
 * 代码任务的仓库资源声明（M2-T4 / Issue #25，FR-TASK-8「Git Worktree 隔离」）：
 * 节点执行前在 path 仓库上建独立 worktree（独立目录 + 独立分支），节点 Agent 的工作
 * 目录 = worktree；节点成功后变更合回主区（合并前冲突检测，冲突 → pending_review）。
 */
export interface NodeGitRepoResource {
  /** 仓库主区路径（worktree 的基线仓库） */
  path: string;
  /**
   * 基线分支（diff/合并基准与 worktree 分支的起点；缺省 = 仓库当前 HEAD）。
   * 注意是「分支名」而不是目标分支切换：调度器不搬动主区分支，只在基线上建 worktree。
   */
  branch?: string;
  /**
   * 合并验证命令（可选）：合并完成后在主区目录执行（sh -c），非零退出 → 合并验证
   * 失败（回滚合并、节点按失败留痕）。未声明时以「合并 diff 非空」做最低验证。
   */
  verify?: string;
}

/**
 * 节点资源声明（M2-T4 / Issue #25，FR-TASK-8）：
 * - git_repo：代码任务 → Git Worktree 工作区隔离（FR-TASK-8 前半）；
 * - lock：互斥资源 key 列表 → 同 key 节点串行化（非代码任务的资源锁，FR-TASK-8 后半）。
 * 两种资源可同时声明（代码任务也可以再要一把锁）。
 */
export interface NodeResources {
  git_repo?: NodeGitRepoResource;
  /** 互斥资源 key（调度器派发前全拿或全不拿，持锁到节点终态释放） */
  lock?: string[];
}

/** DAG 节点（GET /v1/tasks/:id 的 nodes 元素；depends_on 以规划器 key 表示，task 内唯一） */
export interface TaskNodeRecord {
  node_id: string;
  /** 规划器输出的稳定短标识（task 内唯一；depends_on 引用它） */
  key: string;
  title: string;
  /** 执行该节点时给 Agent Loop 的指令；缺省用 title */
  goal?: string;
  /** 依赖节点的 key 列表（拓扑序由调度器判定） */
  depends_on: string[];
  /** 责任 agent 角色（GLOSSARY: Task 的责任 agent；M1 仅记录） */
  agent_role?: string;
  /** 建议模型（M1-T6 起执行时按该字段解析 Provider；未命中注册 Provider 回退默认） */
  model?: string;
  /** 可重试性：true 时调度器失败后自动重试一次 */
  retriable: boolean;
  side_effect: SideEffectClass;
  /**
   * 资源声明（M2-T4 / Issue #25，FR-TASK-8）：git_repo → worktree 隔离；
   * lock → 互斥串行化。规划器声明，调度器消费；缺省（字段省略）= 无资源约束。
   */
  resources?: NodeResources;
  status: TaskNodeStatus;
  /** 责任方（M1-T6）：省略 = 调度器；"owner" = 已被 Owner 接管 */
  actor?: TaskNodeActor;
  /** 已尝试次数（含重试） */
  attempts: number;
  result?: string;
  error?: string;
}

/** 任务列表条目（GET /v1/tasks） */
export interface TaskSummary {
  task_id: string;
  goal: string;
  status: TaskStatus;
  /** 任务版本：规划修订（FR-TASK-3 修改未完成节点）时递增；初版恒 1 */
  task_version: number;
  /** 创建来源会话（M1-T6：POST /v1/tasks 携带 session_id 时记录，Chat 任务卡片据此关联）；缺省无来源 */
  session_id?: string;
  created_at: string;
  updated_at: string;
}

/** 任务详情（GET /v1/tasks/:id、POST /v1/tasks 响应）：DAG + 状态 + 版本 */
export interface TaskDetail extends TaskSummary {
  nodes: TaskNodeRecord[];
  /** 规划失败/执行失败的人类可读原因（status=failed 时存在） */
  error?: string;
}

// --- 执行租约（M3-T4 / Issue #33，FR-DEP-4「执行权单点化」）--------------------
//
// 租约表 execution_leases 的只读投影。fencing_token 单调递增（首次=1，抢占/转移
// 后继续 +1）；active 由 runtime 注入时钟判定（holder 非空且 expires_at 未到）。
// holder_replica_id = null 表示已 release（token 计数保留，下一位持有者 token+1）。

/** 执行租约投影（GET /v1/tasks/:id/execution 的 lease 字段） */
export interface ExecutionLease {
  task_id: string;
  holder_replica_id: string | null;
  fencing_token: number;
  expires_at: string;
  acquired_at: string;
  heartbeat_at: string;
  /** 当前是否被有效持有（holder 非空且未过期） */
  active: boolean;
}

/** 双端独立执行的一侧证据（用于 needs_reconcile 报告，不自动合并） */
export interface ReconcileEvidenceSource {
  replica_id: string;
  /** 产出证据的事件类型（task.started / task.node_started / task.revised …） */
  sources: string[];
  event_count: number;
  first_sequence: number;
  last_sequence: number;
  /** 该副本推进过的 task_version（task.revised 事件 payload） */
  task_versions: number[];
}

/** 执行权转移记录（task.execution_transferred 事件的投影） */
export interface ExecutionTransferRecord {
  from_replica_id: string;
  to_replica_id: string;
  sequence: number;
  fencing_token?: number;
}

/**
 * 双端独立执行证据（needs_reconcile 的判定依据）。replicas 为观察到的执行方全集，
 * independent_replicas 为排除「经显式执行权转移授权」后的独立执行方；后者 ≥2 即
 * 判定为双端独立执行（或双端各自推进过 task_version）。
 */
export interface ExecutionReconcileEvidence {
  task_id: string;
  replicas: string[];
  independent_replicas: string[];
  sources: ReconcileEvidenceSource[];
  transfers: ExecutionTransferRecord[];
  /** 人类可读判定原因（dual_execution / task_version_diverged） */
  reasons: string[];
}

/** GET /v1/tasks/:id/execution 响应 */
export interface TaskExecutionState {
  task_id: string;
  status: TaskStatus;
  lease: ExecutionLease | null;
  needs_reconcile: boolean;
  evidence: ExecutionReconcileEvidence | null;
}

/** POST /v1/tasks/:id/transfer-execution 请求体 */
export interface TransferExecutionRequest {
  target_replica_id: string;
}

/** POST /v1/tasks/:id/transfer-execution 响应 */
export interface TransferExecutionResponse {
  task: TaskSummary;
  lease: ExecutionLease | null;
  transfer_event_id: string;
  sequence: number;
}
