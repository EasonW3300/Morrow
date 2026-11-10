import type { SqliteDatabase } from "../db.ts";

/**
 * Outbox 表结构（M4-T2 / Issue #39，FR-TASK-7 / FR-CH-7）。
 *
 * 与事件账本、任务投影同库（events.sqlite，WAL）：outbox 是**可变工作态**（状态/尝试次数/
 * 回执随投递推进），outbound.* 事件才是不可变审计事实源。append-only 触发器只锁 events 表。
 *
 * 列语义：
 * - idempotency_key UNIQUE：重复提交同一逻辑外发只入队一次（平台侧只发一次）；
 * - status：pending|sent|failed|delivery_unknown|needs_review（见 outbox-contracts.ts）；
 * - attempts：已发起的投递请求次数（发送前 +1，先于网络调用）；
 * - last_attempt_at：最近一次请求发起时间——崩溃恢复的判定口径：
 *   `status=pending AND last_attempt_at IS NOT NULL` = 请求可能已发出但无回执 →
 *   启动时转 delivery_unknown，绝不重发；
 * - next_attempt_at：failed 行的指数退避下次可取时间（NULL = 立即可取）；
 * - receipt：平台回执 JSON（platform_message_id/sent_at/raw）；
 * - causation_id / task_id：因果链与任务关联（跨副本同步按事件信封传播）。
 */
export const OUTBOX_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  channel_id      TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  target_kind     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  receipt         TEXT,
  causation_id    TEXT,
  task_id         TEXT,
  fencing_token   INTEGER,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox (status, created_at, id);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS outbox_task_idx ON outbox (task_id);
`;

/**
 * 幂等建表：CREATE IF NOT EXISTS。outbox 是 M4 新表，暂无旧库补列；未来演进遵循
 * task-migrations.ts 的 ensureColumn 模式（只加列不改名不删列）。
 */
export function ensureOutboxTables(db: SqliteDatabase): void {
  db.exec(OUTBOX_TABLES_SQL);
}
