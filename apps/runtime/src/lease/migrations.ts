import type { SqliteDatabase } from "../db.ts";

/**
 * 执行租约表（M3-T4 / Issue #33，FR-DEP-4「执行权单点化」）。
 *
 * 一个 Task 当前至多一个活跃执行租约（GLOSSARY：Run ≠ Task——同一任务可由多次
 * Run/节点执行推进，但执行权同一时刻只属于一个副本）。fencing_token 全局单调递增：
 * 首次 1，抢占/转移后严格 +1，旧 token 自此失效；holder_replica_id = NULL 表示已
 * release（token 计数保留，下一位持有者继续 +1）；expires_at 是持有者必须心跳续租
 * 的截止点。
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

-- 跨副本 fencing 观察值（M3 修复批）：每个 task 从账本事件观察到的最大 token。
-- granted  = 实际发放过（acquire/renew/release 的 fencing_token）的最大值；
-- reserved = task.execution_transferred 声明的 next_fencing_token 最大值。
-- 本机 acquire 以 max(本地行 token, granted) + 1 取号，validate 拒绝 < max(granted,
-- reserved) 的 token——否则各副本各自从 1 起号，转移后旧设备的旧 token 仍能提交。
CREATE TABLE IF NOT EXISTS execution_fencing_tokens (
  task_id        TEXT PRIMARY KEY,
  granted_token  INTEGER NOT NULL DEFAULT 0,
  reserved_token INTEGER NOT NULL DEFAULT 0
);
`;

/** 幂等建表（CREATE IF NOT EXISTS）；由 LeaseStore 调用 */
export function ensureLeaseTable(db: SqliteDatabase): void {
  db.exec(EXECUTION_LEASES_SQL);
}
