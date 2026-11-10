import { join } from "node:path";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { DB_FILE_NAME } from "../ledger.ts";
import { ensureLeaseTable } from "./migrations.ts";

/**
 * LeaseStore（M3-T4 / Issue #33，FR-DEP-4「执行权单点化」）。
 *
 * 语义（全部由注入时钟判定，测试零 sleep）：
 * - acquire：首次 token=1；同一 holder 未过期重复 acquire 幂等返回同 token；他人
 *   持有且未过期 → `{ heldBy }`（调用方据此不执行并说明持有者）；租约过期（含已
 *   release）可抢占，token 严格 +1，旧 token 从此 validate=false；
 * - renew：只延长 expires_at/heartbeat_at，不换 token；过期后 renew 返回 false；
 * - release：holder+token 匹配才成功；holder 置 NULL、expires_at 提前到当前时刻，
 *   token 计数保留（下一位持有者 token+1）；
 * - validate：token 匹配且当前有效（holder 非空、未过期）。
 *
 * 原子性：acquire 在 BEGIN IMMEDIATE 事务内完成「读当前行 → 判定 → 写入」，SQLite
 * 写事务串行化使跨连接的两副本同时抢租约只有一个成功（另一个读到新 holder）。
 * 连接与任务投影同库（events.sqlite，WAL + busy_timeout）。
 */

/** 租约当前投影（current 返回；active 由注入时钟判定） */
export interface ExecutionLeaseRecord {
  task_id: string;
  holder_replica_id: string | null;
  fencing_token: number;
  expires_at: string;
  acquired_at: string;
  heartbeat_at: string;
  active: boolean;
}

/**
 * acquire 结果：
 * - `{ token, expires_at, ... }` = 成功（token 是本次 fencing token）；
 * - `{ heldBy, expires_at, fencing_token }` = 失败（有效持有者是 heldBy）。
 */
export type LeaseAcquireOutcome =
  | { token: number; expires_at: string; acquired_at: string; heartbeat_at: string }
  | { heldBy: string; expires_at: string; fencing_token: number };

export interface LeaseStoreOptions {
  /** 直接注入打开的库（与任务投影同库时复用连接）；与 dataDir 二选一 */
  db?: SqliteDatabase;
  /** 任务表同库目录（events.sqlite；独立连接，WAL + busy_timeout 支撑多连接） */
  dataDir?: string;
  /** 注入时钟（测试拨快过期；缺省系统时间） */
  now?: () => Date;
}

interface LeaseRow {
  task_id: string;
  holder_replica_id: string | null;
  fencing_token: number;
  expires_at: string;
  acquired_at: string;
  heartbeat_at: string;
}

export class LeaseStore {
  readonly #db: SqliteDatabase;
  readonly #ownsDb: boolean;
  readonly #now: () => Date;
  #closed = false;

  #getStmt;
  #insertStmt;
  #updateGrantStmt;
  #updateRenewStmt;
  #updateReleaseStmt;
  #listStmt;

  constructor(options: LeaseStoreOptions) {
    if (options.db !== undefined) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      if (options.dataDir === undefined) {
        throw new Error("LeaseStore requires either dataDir or db");
      }
      this.#db = openSqlite(join(options.dataDir, DB_FILE_NAME));
      this.#ownsDb = true;
    }
    this.#now = options.now ?? (() => new Date());
    ensureLeaseTable(this.#db);
    this.#getStmt = this.#db.prepare("SELECT * FROM execution_leases WHERE task_id = ?");
    this.#insertStmt = this.#db.prepare(
      "INSERT INTO execution_leases (task_id, holder_replica_id, fencing_token, expires_at, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#updateGrantStmt = this.#db.prepare(
      "UPDATE execution_leases SET holder_replica_id = ?, fencing_token = ?, expires_at = ?, acquired_at = ?, heartbeat_at = ? WHERE task_id = ?",
    );
    this.#updateRenewStmt = this.#db.prepare(
      "UPDATE execution_leases SET expires_at = ?, heartbeat_at = ? WHERE task_id = ?",
    );
    this.#updateReleaseStmt = this.#db.prepare(
      "UPDATE execution_leases SET holder_replica_id = NULL, expires_at = ?, heartbeat_at = ? WHERE task_id = ?",
    );
    this.#listStmt = this.#db.prepare("SELECT * FROM execution_leases ORDER BY acquired_at, task_id");
  }

  /**
   * 申请执行租约。成功返回 token；失败返回当前有效持有者（调用方不执行）。
   * 同一 holder 未过期重复调用幂等（同 token、同到期时间）。
   */
  acquire(taskId: string, replicaId: string, ttlMs: number): LeaseAcquireOutcome {
    this.#assertOpen();
    assertTtl(ttlMs);
    assertNonEmpty("taskId", taskId);
    assertNonEmpty("replicaId", replicaId);
    const now = this.#now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const expiresIso = new Date(nowMs + ttlMs).toISOString();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#getStmt.get(taskId) as LeaseRow | undefined;
      let outcome: LeaseAcquireOutcome;
      if (existing === undefined) {
        this.#insertStmt.run(taskId, replicaId, 1, expiresIso, nowIso, nowIso);
        outcome = { token: 1, expires_at: expiresIso, acquired_at: nowIso, heartbeat_at: nowIso };
      } else {
        const heldBy = existing.holder_replica_id;
        const active = heldBy !== null && nowMs < Date.parse(existing.expires_at);
        if (active && heldBy === replicaId) {
          // 幂等：同一 holder 未过期，不续期也不换 token（续期走 renew）
          outcome = {
            token: existing.fencing_token,
            expires_at: existing.expires_at,
            acquired_at: existing.acquired_at,
            heartbeat_at: existing.heartbeat_at,
          };
        } else if (active && heldBy !== null) {
          outcome = { heldBy, expires_at: existing.expires_at, fencing_token: existing.fencing_token };
        } else {
          // 首次 / 过期抢占 / release 后重新持有：token 严格 +1
          const token = existing.fencing_token + 1;
          this.#updateGrantStmt.run(replicaId, token, expiresIso, nowIso, nowIso, taskId);
          outcome = { token, expires_at: expiresIso, acquired_at: nowIso, heartbeat_at: nowIso };
        }
      }
      this.#db.exec("COMMIT");
      return outcome;
    } catch (err) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // 回滚失败不掩盖原始错误
      }
      throw err;
    }
  }

  /**
   * 心跳续租：只延长 expires_at/heartbeat_at，不换 token。holder/token 不匹配或
   * 已过期 → false（调用方按「租约已丢失」处理）。
   */
  renew(taskId: string, replicaId: string, token: number): boolean {
    this.#assertOpen();
    const now = this.#now();
    const nowMs = now.getTime();
    const existing = this.#getStmt.get(taskId) as LeaseRow | undefined;
    if (existing === undefined) return false;
    if (existing.holder_replica_id !== replicaId) return false;
    if (existing.fencing_token !== token) return false;
    const expiryMs = Date.parse(existing.expires_at);
    if (nowMs >= expiryMs) return false;
    // 沿用本次租约的授予时长（expires_at - heartbeat_at 即最近一次授予的 TTL）
    const ttlMs = Math.max(1, expiryMs - Date.parse(existing.heartbeat_at));
    const nextExpiry = new Date(nowMs + ttlMs).toISOString();
    this.#updateRenewStmt.run(nextExpiry, now.toISOString(), taskId);
    return true;
  }

  /** 释放执行权（holder+token 匹配才成功）；token 计数保留，下一位持有者 +1。 */
  release(taskId: string, replicaId: string, token: number): boolean {
    this.#assertOpen();
    const existing = this.#getStmt.get(taskId) as LeaseRow | undefined;
    if (existing === undefined) return false;
    if (existing.holder_replica_id !== replicaId) return false;
    if (existing.fencing_token !== token) return false;
    const nowIso = this.#now().toISOString();
    this.#updateReleaseStmt.run(nowIso, nowIso, taskId);
    return true;
  }

  /** 副作用提交前的 fencing 校验：token 匹配且租约当前有效。 */
  validate(taskId: string, token: number): boolean {
    this.#assertOpen();
    const existing = this.#getStmt.get(taskId) as LeaseRow | undefined;
    if (existing === undefined) return false;
    if (existing.holder_replica_id === null) return false;
    if (existing.fencing_token !== token) return false;
    return this.#now().getTime() < Date.parse(existing.expires_at);
  }

  /** 当前租约（含释放后的行；无行 → null）；active 由注入时钟判定。 */
  current(taskId: string): ExecutionLeaseRecord | null {
    this.#assertOpen();
    const row = this.#getStmt.get(taskId) as LeaseRow | undefined;
    if (row === undefined) return null;
    return this.#project(row, this.#now().getTime());
  }

  /** 全部租约行（运维/查询用；active 同样按注入时钟判定） */
  list(): ExecutionLeaseRecord[] {
    this.#assertOpen();
    const nowMs = this.#now().getTime();
    return (this.#listStmt.all() as unknown as LeaseRow[]).map((row) => this.#project(row, nowMs));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsDb) this.#db.close();
  }

  #project(row: LeaseRow, nowMs: number): ExecutionLeaseRecord {
    return {
      task_id: row.task_id,
      holder_replica_id: row.holder_replica_id,
      fencing_token: row.fencing_token,
      expires_at: row.expires_at,
      acquired_at: row.acquired_at,
      heartbeat_at: row.heartbeat_at,
      active: row.holder_replica_id !== null && nowMs < Date.parse(row.expires_at),
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("LeaseStore is closed");
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`ttlMs must be a positive integer, got ${String(ttlMs)}`);
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
