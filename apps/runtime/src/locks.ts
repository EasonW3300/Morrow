/**
 * 资源锁表（票 M2-T4 / Issue #25，PRD §4.3 FR-TASK-8「非代码任务用资源锁/乐观并发」）。
 *
 * 锁粒度 = 节点 resources.lock 声明的资源 key（如 "db:users"、"ledger:2026-11"）；
 * 同 key 至多一个持有者（PRIMARY KEY(lock_key)）。调度器在派发节点前 acquire
 * （全拿或全不拿——避免两个节点各持一把互等对方的死锁），节点到达终态后 release
 * （按 (task_id, node_id) 粒度，释放该节点持有的全部锁）。
 *
 * acquire 的原子性口径：检查与写入之间没有 await（SQLite 同步驱动 + 调度器单线程
 * 派发），单进程内天然原子；跨进程并发由「执行租约（GLOSSARY）保证同一 Run 全局
 * 单点执行」排除，不在本表范围内。
 *
 * 崩溃残留：进程死亡不清行（与节点行一样是可变投影的半写状态），启动时由
 * sweepStale 清扫——新进程接管时刻不存在合法的旧持有者（租约语义），所以启动清扫
 * 的 keep 谓词恒为 false（全清）。
 */

import { join } from "node:path";
import { openSqlite, type SqliteDatabase, type SqliteStatement } from "./db.ts";
import { DB_FILE_NAME } from "./ledger.ts";
import { ensureLockTable } from "./task-migrations.ts";

export interface LockRow {
  lock_key: string;
  task_id: string;
  node_id: string;
  acquired_at: string;
}

export interface LockTableOptions {
  /** 直接注入打开的库（与任务投影同库时复用连接）；与 dataDir 二选一 */
  db?: SqliteDatabase;
  /** 任务表同库目录（events.sqlite；独立连接，WAL + busy_timeout 支撑多连接） */
  dataDir?: string;
}

export class LockTable {
  readonly #db: SqliteDatabase;
  readonly #ownsDb: boolean;
  #closed = false;

  #holderStmt;
  #insertStmt;
  #deleteByNodeStmt;
  #listStmt;

  constructor(options: LockTableOptions) {
    if (options.db !== undefined) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      if (options.dataDir === undefined) {
        throw new Error("LockTable requires either dataDir or db");
      }
      this.#db = openSqlite(join(options.dataDir, DB_FILE_NAME));
      this.#ownsDb = true;
    }
    ensureLockTable(this.#db);
    this.#holderStmt = this.#db.prepare("SELECT * FROM task_locks WHERE lock_key = ?");
    this.#insertStmt = this.#db.prepare(
      "INSERT INTO task_locks (lock_key, task_id, node_id, acquired_at) VALUES (?, ?, ?, ?)",
    );
    this.#deleteByNodeStmt = this.#db.prepare("DELETE FROM task_locks WHERE task_id = ? AND node_id = ?");
    this.#listStmt = this.#db.prepare("SELECT * FROM task_locks ORDER BY acquired_at, lock_key");
  }

  /** key 的当前持有者；无持有者 → null */
  holder(key: string): LockRow | null {
    return (this.#holderStmt.get(key) as LockRow | undefined) ?? null;
  }

  /**
   * 全拿或全不拿：keys 全部空闲才逐条 INSERT 并返回 true；任一被持有 → 不写任何行
   * 返回 false（派发方据此跳过该节点，等持有者释放后重试派发）。
   */
  acquireAll(keys: readonly string[], taskId: string, nodeId: string, now: string): boolean {
    if (keys.length === 0) return true;
    for (const key of keys) {
      if (this.holder(key) !== null) return false;
    }
    for (const key of keys) {
      this.#insertStmt.run(key, taskId, nodeId, now);
    }
    return true;
  }

  /** 释放某节点持有的全部锁（节点终态后调用；幂等） */
  releaseAll(taskId: string, nodeId: string): void {
    this.#deleteByNodeStmt.run(taskId, nodeId);
  }

  list(): LockRow[] {
    return this.#listStmt.all() as unknown as LockRow[];
  }

  /**
   * 残留清扫：keep(row)=false 的锁行删除（启动清扫传 () => false 全清——租约语义下
   * 新进程不存在合法旧持有者）。返回清除的行数。
   */
  sweepStale(keep: (row: LockRow) => boolean): number {
    let swept = 0;
    for (const row of this.list()) {
      if (keep(row)) continue;
      this.#db.prepare("DELETE FROM task_locks WHERE lock_key = ?").run(row.lock_key);
      swept += 1;
    }
    return swept;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsDb) this.#db.close();
  }
}
