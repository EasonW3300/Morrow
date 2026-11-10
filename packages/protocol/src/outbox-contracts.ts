/**
 * 外发副作用发件箱（M4-T2 / Issue #39，FR-TASK-7 / FR-CH-7）的 API 与投影形态。
 *
 * 语义（PRD §4.3 FR-TASK-6/7、§6 恢复语义）：
 * - 所有出站消息先落 `outbox` 再投递；`idempotency_key` 唯一——重复提交只返回既有行
 *   （deduped），绝不重复发送；
 * - `sent` = 平台回执确认；`failed` = 平台明确拒收/4xx（可退避重试）；
 * - `delivery_unknown` = 请求可能已到达平台但回执缺失（超时/网络中断/进程崩溃）——
 *   **不自动重发**，立即转 `needs_review` 等人工核对；
 * - `needs_review` = 需要 Owner 显式确认（可能已送达、可能重复）才能再动手。
 *
 * 本文件只是共享类型（protocol 只加不改）；表结构与状态迁移在 runtime 的 outbox 模块。
 */

/** Outbox 行状态机：pending → sent | failed → ...；delivery_unknown → needs_review */
export type OutboxStatus = "pending" | "sent" | "failed" | "delivery_unknown" | "needs_review";

/** 外发目标类别：平台会话（群/私聊）或单个用户 */
export type OutboxTargetKind = "conversation" | "user";

export interface OutboxTarget {
  kind: OutboxTargetKind;
  /** 平台侧会话 id / 用户 id（不做跨平台归一，原样透传适配器） */
  id: string;
}

/**
 * 渠道回执（outbox.receipt JSON）。`platform_message_id` 是平台侧消息 id；
 * `sent_at` 是平台确认送达时间（RFC 3339 UTC）；`raw` 保留适配器原始回执片段
 * （诊断用，不参与状态判定）。
 */
export interface OutboxReceipt {
  platform_message_id?: string;
  sent_at?: string;
  raw?: Record<string, unknown>;
}

/** 一行 outbox 的对外投影（GET /v1/outbox 与 enqueue/dispatch 返回值） */
export interface OutboxMessageRecord {
  id: string;
  idempotency_key: string;
  channel_id: string;
  account_id: string;
  target: OutboxTarget;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  /** 已发起的投递次数（含人工重试；每次发送请求前 +1，先于网络调用落库） */
  attempts: number;
  last_error: string | null;
  receipt: OutboxReceipt | null;
  causation_id: string | null;
  task_id: string | null;
  /** 最近一次投递请求发起时间（崩溃恢复判定口径：非空且 status=pending 视为可能已发出） */
  last_attempt_at: string | null;
  /** 下一次自动退避重试时间（仅 failed 行；null = 立即可取） */
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /v1/outbox 分页响应 */
export interface OutboxListPage {
  messages: OutboxMessageRecord[];
  total: number;
  limit: number;
  offset: number;
}
