import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * SQLite 薄 facade（选型研究结论：morrow-research/NOTES-bun.md §6）。
 *
 * 绑定定 node:sqlite（DatabaseSync）：零 native 依赖、Node ≥22.5 内建、Bun 1.4.4
 * 完全兼容（bun build --compile 后 node:sqlite 走兼容层），better-sqlite3 / bun:sqlite
 * 均不进依赖树。收敛在一个文件里，将来换驱动只动这里。
 *
 * 注意：Node 22.13 以下运行需要 --experimental-sqlite 标志（22.13+ 已默认开启）。
 */

/** facade 支持的绑定参数形态（node:sqlite 原生支持的 JSON 侧子集） */
export type SqliteParam = null | number | bigint | string;

export interface SqliteStatement {
  run(...params: SqliteParam[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqliteParam[]): unknown;
  all(...params: SqliteParam[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** 打开（或创建）数据库，启用 WAL、busy_timeout 与 FULL 同步（账本 durability 优先） */
export function openSqlite(path: string): SqliteDatabase {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const stmt: StatementSync = db.prepare(sql);
      return {
        run(...params: SqliteParam[]) {
          return stmt.run(...params);
        },
        get(...params: SqliteParam[]) {
          return stmt.get(...params);
        },
        all(...params: SqliteParam[]) {
          return stmt.all(...params);
        },
      };
    },
    close(): void {
      db.close(); // 干净关闭触发 WAL checkpoint，数据落主库文件
    },
  };
}
