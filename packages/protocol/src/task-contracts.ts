/**
 * 任务域 API 合约类型（M1-T4 / Issue #16，PRD §4.3 FR-TASK-1/2/6、§3 术语）。
 *
 * 与 api-contracts.ts 同一演进规则：字段只加不减、不改名、不收窄已有类型。
 * runtime 是唯一生产方，desktop（任务工作台，后续票）是消费方，两侧都从这里 import。
 */

/**
 * 任务状态机（决策稿 §6；本票实现除 needs_reconcile 外全部）。
 * 合法迁移表由 runtime 侧持有；终端态 failed/completed/cancelled 不可再迁移。
 */
export type TaskStatus =
  | "created"
  | "planned"
  | "running"
  | "paused"
  | "waiting_input"
  | "failed"
  | "completed"
  | "cancelled";

/** 节点执行状态（DAG 投影；pending = 依赖未满足，调度器就绪判定见 runtime scheduler） */
export type TaskNodeStatus = "pending" | "running" | "completed" | "failed";

/**
 * 副作用分类（GLOSSARY: SideEffect；FR-TASK-6）。
 * M1-T4 只随节点记录字段，真实投递与人工核对/补偿在 M4（SideEffectOutbox）。
 */
export type SideEffectClass = "reversible" | "compensatable" | "irreversible" | "delivery_unknown";

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
  /** 建议模型（M1 仅记录；节点执行用会话默认 Provider） */
  model?: string;
  /** 可重试性：true 时调度器失败后自动重试一次 */
  retriable: boolean;
  side_effect: SideEffectClass;
  status: TaskNodeStatus;
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
  created_at: string;
  updated_at: string;
}

/** 任务详情（GET /v1/tasks/:id、POST /v1/tasks 响应）：DAG + 状态 + 版本 */
export interface TaskDetail extends TaskSummary {
  nodes: TaskNodeRecord[];
  /** 规划失败/执行失败的人类可读原因（status=failed 时存在） */
  error?: string;
}
