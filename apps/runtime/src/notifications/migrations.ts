import type { SqliteDatabase } from "../db.ts";

/**
 * 通知表结构（M4-T7 / Issue #44，PRD §4.8 FR-NOT-1/2）。
 *
 * 与账本/任务投影同库（events.sqlite，WAL）：规则与投递行是**可变工作态**，通知类审计
 * 事件才进 append-only 账本。DDL 全部幂等（CREATE IF NOT EXISTS），旧库启动自动补表。
 *
 *   notification_rules        (event_type, target) 唯一；quiet_hours 为 JSON 或 NULL
 *   notification_dedup        (task|event|target) 唯一；window_start = 最近一次投递起点（滑动窗口）
 *   notification_deliveries   每次命中的投递投影（桌面待拉取 / 渠道 queued + outbox_id）
 */
export const NOTIFICATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS notification_rules (
  rule_id      TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL CHECK (event_type IN ('completed', 'failed', 'waiting_input', 'milestone')),
  target       TEXT NOT NULL CHECK (target = 'desktop' OR target LIKE 'channel:%'),
  quiet_hours  TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (event_type, target)
);

CREATE TABLE IF NOT EXISTS notification_dedup (
  dedupe_key      TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  window_start    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  notification_id TEXT PRIMARY KEY,
  task_id         TEXT,
  event_type      TEXT NOT NULL,
  target          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('desktop', 'channel')),
  channel_id      TEXT,
  status          TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  outbox_id       TEXT,
  dedupe_key      TEXT NOT NULL,
  deliver_after   TEXT,
  detail          TEXT,
  created_at      TEXT NOT NULL,
  delivered_at    TEXT
);

CREATE INDEX IF NOT EXISTS notification_rules_event_idx ON notification_rules (event_type, enabled);
CREATE INDEX IF NOT EXISTS notification_deliveries_created_idx ON notification_deliveries (created_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_status_idx ON notification_deliveries (status, kind, created_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_task_idx ON notification_deliveries (task_id);
`;

export function ensureNotificationTables(db: SqliteDatabase): void {
  db.exec(NOTIFICATION_TABLES_SQL);
}
