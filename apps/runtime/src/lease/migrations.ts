import type { SqliteDatabase } from "../db.ts";

/**
 * 执行租约表（M3-T4 / Issue #33，FR-DEP-4「执行权单点化」）。
 *
 * task_id 单行 = 一个 Run 的全局执行权。fencing_token 单调递增（首次 1，抢占/转移
 * 后严格 +1），旧 token 自此失效；holder_replica_id = NULL 表示已 release（token
 * 计数保留，下一位持有者继续 +1）；expires_at 是持有者必须心跳续租的截止点。
 *
 * 与任务投影/账本同库（events.sqlite）：租约是可变的协调态，不是审计历史——审计
 * 由 task.lease_denied / task.lease_lost / task.execution_transferred 事件承担。
 * 表 DDL 幂等（CREATE IF NOT EXISTS），旧库无需回填。
 */
export const EXECUTION_LEASES_SQL = `
CREATE TABLE IF NOT EXISTS execution_leases (
  task_id           TEXT PRIMARY KEY,
  holder_replica_id TEXT,
  fencing_token     INTEGER NOT NULL,
  expires_at        TEXT NOT NULL,
  acquired_at       TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL
);
`;

/** 幂等建表（CREATE IF NOT EXISTS）；由 LeaseStore 调用 */
export function ensureLeaseTable(db: SqliteDatabase): void {
  db.exec(EXECUTION_LEASES_SQL);
}
