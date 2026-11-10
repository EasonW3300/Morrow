import type { SqliteDatabase } from "../db.ts";

/**
 * 同步域表结构（M3-T1 / Issue #30，PRD §4.6 FR-DEP-3）——与账本同库（events.sqlite）。
 *
 * sync_cursors 是可变投影表（每对 peer 一行），events 表的 append-only 触发器只锁
 * events，互不影响（同 DeviceRegistry / MemoryStore 模式）。
 *
 * 游标口径（两个方向相互独立，均以「来源账本的 sequence」为坐标）：
 *   last_pulled_sequence  本副本从 peer 拉取并导入的最高 peer 账本 sequence；
 *   last_acked_sequence   本副本与 peer 之间 push 方向已确认的最高来源 sequence——
 *                         发送方存自己的本地 sequence，接收方存 peer 推送的 sequence。
 * 迁移幂等：CREATE IF NOT EXISTS + pragma 逐列补列（旧库演进只加列）。
 */
export const SYNC_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sync_cursors (
  peer_replica_id      TEXT PRIMARY KEY,
  last_pulled_sequence INTEGER NOT NULL DEFAULT 0,
  last_acked_sequence  INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL
);
`;

const SYNC_CURSOR_COLUMNS: Array<{ column: string; ddl: string }> = [
  {
    column: "last_pulled_sequence",
    ddl: "ALTER TABLE sync_cursors ADD COLUMN last_pulled_sequence INTEGER NOT NULL DEFAULT 0",
  },
  {
    column: "last_acked_sequence",
    ddl: "ALTER TABLE sync_cursors ADD COLUMN last_acked_sequence INTEGER NOT NULL DEFAULT 0",
  },
  {
    column: "updated_at",
    ddl: "ALTER TABLE sync_cursors ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
  },
];

/** 幂等建表/补列；打开游标库时调用 */
export function ensureSyncTables(db: SqliteDatabase): void {
  db.exec(SYNC_TABLES_SQL);
  const columns = db.prepare("SELECT name FROM pragma_table_info('sync_cursors')").all() as unknown as Array<{
    name: string;
  }>;
  const existing = new Set(columns.map((column) => column.name));
  for (const migration of SYNC_CURSOR_COLUMNS) {
    if (!existing.has(migration.column)) db.exec(migration.ddl);
  }
}
