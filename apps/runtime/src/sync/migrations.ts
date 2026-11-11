import type { SqliteDatabase } from "../db.ts";

/**
 * 同步域表结构（M3-T1 / Issue #30，PRD §4.6 FR-DEP-3）——与账本同库（events.sqlite）。
 *
 * sync_cursors 是可变投影表（每对 peer 一行），events 表的 append-only 触发器只锁
 * events，互不影响（同 DeviceRegistry / MemoryStore 模式）。
 *
 * 游标口径（M3 code-review A2：两个方向**各用独立列**，不再混用同一字段）：
 *   last_pulled_remote_sequence  本副本从 peer 拉取/接收并导入的最高 **peer** 账本
 *                                sequence（inbound；pull 与 receivePush 共用）；
 *   last_acked_local_sequence    本副本推给 peer 且已获确认的最高 **本地** sequence
 *                                （outbound；只由 pushToPeer 推进）。
 * 旧列 last_pulled_sequence / last_acked_sequence 保留作迁移审计：旧口径把「对端已
 * 确认我多少」与「我已拉到对端多少」混在 last_acked_sequence 一列，收到 push 后会
 * 从错误的序号起反向推送。迁移只把同义的 last_pulled_sequence 回填到 inbound 列；
 * outbound 列从 0 起（重复推送幂等、漏推才是缺陷，故不信任混杂值）。
 * 迁移幂等：CREATE IF NOT EXISTS + pragma 逐列补列（旧库演进只加列）。
 */
export const SYNC_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sync_cursors (
  peer_replica_id      TEXT PRIMARY KEY,
  last_pulled_sequence INTEGER NOT NULL DEFAULT 0,
  last_acked_sequence  INTEGER NOT NULL DEFAULT 0,
  last_pulled_remote_sequence INTEGER NOT NULL DEFAULT 0,
  last_acked_local_sequence   INTEGER NOT NULL DEFAULT 0,
  last_synced_at       TEXT,
  updated_at           TEXT NOT NULL
);

-- 删除集合（票 M3-T3 / Issue #32，FR-DEP-5 / FR-MEM-8）：kind=fact 是事实 tombstone
-- （version 记录删除时的事实版本），kind=event 是该事实相关事件 id 的删除集合——
-- 导入时命中即跳过，离线副本不得复活已删数据。
CREATE TABLE IF NOT EXISTS sync_tombstones (
  kind       TEXT NOT NULL CHECK (kind IN ('event', 'fact')),
  target_id  TEXT NOT NULL,
  replica_id TEXT,
  version    INTEGER,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (kind, target_id)
);
CREATE INDEX IF NOT EXISTS sync_tombstones_kind_idx ON sync_tombstones (kind, deleted_at);

-- 跨设备冲突元数据（票 M3-T3）：冲突本体仍在 M1 memory_conflicts 队列，这里只补
-- 来源副本与三方版本号，供 GET /v1/sync/conflicts 汇总与 resolve 后标记。
CREATE TABLE IF NOT EXISTS sync_conflict_meta (
  conflict_id       TEXT PRIMARY KEY,
  fact_id           TEXT NOT NULL,
  local_replica_id  TEXT NOT NULL,
  remote_replica_id TEXT NOT NULL,
  local_version     INTEGER NOT NULL,
  remote_version    INTEGER NOT NULL,
  base_version      INTEGER,
  reason            TEXT NOT NULL,
  remote_event_id   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  resolved_at       TEXT
);
CREATE INDEX IF NOT EXISTS sync_conflict_meta_status_idx ON sync_conflict_meta (resolved_at, created_at);
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
  {
    // M3 修复批（Issue #30 code-review A2）：inbound 游标（pull / 接收 push 共用）。
    column: "last_pulled_remote_sequence",
    ddl: "ALTER TABLE sync_cursors ADD COLUMN last_pulled_remote_sequence INTEGER NOT NULL DEFAULT 0",
  },
  {
    // M3 修复批（Issue #30 code-review A2）：outbound 游标（本副本已获 peer 确认的
    // 本地 sequence）。与 inbound 列彻底分离，收到 push 不再污染反向推送起点。
    column: "last_acked_local_sequence",
    ddl: "ALTER TABLE sync_cursors ADD COLUMN last_acked_local_sequence INTEGER NOT NULL DEFAULT 0",
  },
  {
    // M3 修复批（Issue #35）：最近一次成功同步时间。旧库补列即可，既有行为 null
    // （「从未成功同步」——与真实情况一致，不伪造时间）。
    column: "last_synced_at",
    ddl: "ALTER TABLE sync_cursors ADD COLUMN last_synced_at TEXT",
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
  // 旧库回填（幂等）：旧 last_pulled_sequence 与 inbound 列同义，直接搬运；outbound
  // 列有意不搬运混杂的 last_acked_sequence（见文件头）。仅在该列刚从无到有时回填，
  // 避免每次打开都把用户已推进的 0 覆盖回旧值。
  if (!existing.has("last_pulled_remote_sequence")) {
    db.exec(
      `UPDATE sync_cursors
          SET last_pulled_remote_sequence = last_pulled_sequence
        WHERE last_pulled_sequence > 0`,
    );
  }
}
