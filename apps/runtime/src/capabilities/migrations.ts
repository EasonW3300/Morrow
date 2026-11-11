import type { SqliteDatabase } from "../db.ts";

/**
 * 能力域表结构定义与迁移（票 M2-T1 / Issue #22）。独立成文件（与 task-migrations.ts
 * 同款模式）：新库建表与既有库迁移共用同一 DDL 真相源。
 *
 * 与事件账本同库（events.sqlite，WAL）：capabilities / capability_versions /
 * capability_grants 是可变投影表，events 表的 append-only 触发器只锁 events，互不影响
 * （同 DeviceRegistry / MemoryStore 模式）。
 *
 *   capabilities         当前注册状态（name 为主键 = 能力稳定 id；manifest 全文随行）
 *   capability_versions  版本历史（(name, version) 不可变——rollback 的依据；同版本
 *                        内容不可变，演进必须升版本）
 *   capability_grants    Owner 的五维预授权（单行表 id=1；缺省 = 全空授权）
 */

export const CAPABILITY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS capabilities (
  name        TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  author      TEXT NOT NULL CHECK (author IN ('human', 'ai')),
  runtime     TEXT NOT NULL CHECK (runtime IN ('typescript', 'go')),
  status      TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  verified    INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT NOT NULL,
  manifest    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_versions (
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  author      TEXT NOT NULL CHECK (author IN ('human', 'ai')),
  verified    INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT NOT NULL,
  manifest    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

CREATE TABLE IF NOT EXISTS capability_grants (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  grants     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * 既有库补列（#22 修复批：verified 已验证标记）：CREATE TABLE IF NOT EXISTS 不改已有
 * 表，按 pragma 逐列检查补齐——新库建表后此校验为 no-op。
 */
const CAPABILITY_COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "capabilities", column: "verified", ddl: "ALTER TABLE capabilities ADD COLUMN verified INTEGER NOT NULL DEFAULT 0" },
  { table: "capability_versions", column: "verified", ddl: "ALTER TABLE capability_versions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0" },
];

/** 打开能力域表（幂等；新库建表、既有库补列）。迁移入口——后续表结构演进在此扩展。 */
export function ensureCapabilityTables(db: SqliteDatabase): void {
  db.exec(CAPABILITY_TABLES_SQL);
  for (const migration of CAPABILITY_COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === migration.column)) {
      db.exec(migration.ddl);
    }
  }
}
