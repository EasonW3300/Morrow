import { join } from "node:path";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { DB_FILE_NAME } from "../ledger.ts";
import { ensureLeaseTable } from "./migrations.ts";

/**
 * LeaseStore（M3-T4 / Issue #33，FR-DEP-4「执行权单点化」）。
 *
 * 语义（全部由注入时钟判定，测试零 sleep）：
 * - acquire：token = max(本地行当前 token, 账本观察到的 granted 最大 token) + 1；
 *   首次无观察值时为 1。同一 holder 未过期重复 acquire 幂等返回同 token；他人
 *   持有且未过期 → `{ heldBy }`（调用方据此不执行并说明持有者）；租约过期（含已
 *   release）可抢占，token 严格 +1，旧 token 从此 validate=false；
 * - renew：只延长 expires_at/heartbeat_at，不换 token；过期后 renew 返回 false；
 * - release：holder+token 匹配才成功；holder 置 NULL、expires_at 提前到当前时刻，
 *   token 计数保留（下一位持有者 token+1）；
 * - validate：token 匹配且当前有效（holder 非空、未过期），且 token 不低于账本
 *   观察到的跨副本最大 token（旧设备的旧 token 不能在新设备接管后继续提交）。
 *
 * 跨副本计数：execution_fencing_tokens 保存从账本重放出的 granted/reserved 最大值
 * （reserved = task.execution_transferred 的 next_fencing_token）。租约表本身是副本
 * 私有态，只靠它会让每个副本各自从 1 起号；观察值由 LeaseCoordinator/调度器在
 * acquire 前与转移时写入。
 *
 * 原子性：acquire 在 BEGIN IMMEDIATE 事务内完成「读当前行 → 判定 → 写入」，SQLite
 * 写事务串行化使跨连接的两副本同时抢租约只有一个成功（另一个读到新 holder）。
 * 连接与任务投影同库（events.sqlite，WAL + busy_timeout）。
 */

/** 账本观察到的跨副本 fencing 最大 token（0 = 未观察） */
export interface ObservedFencingTokens {
  /** 实际发放过（acquire/renew/release 携带的 fencing_token）的最大值 */
  granted: number;
  /** task.execution_transferred 声明的 next_fencing_token 最大值 */
  reserved: number;
}

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
  #getObservedStmt;
  #observeGrantedStmt;
  #observeReservedStmt;

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
    this.#getObservedStmt = this.#db.prepare(
      "SELECT granted_token, reserved_token FROM execution_fencing_tokens WHERE task_id = ?",
    );
    this.#observeGrantedStmt = this.#db.prepare(
      `INSERT INTO execution_fencing_tokens (task_id, granted_token, reserved_token) VALUES (?, ?, 0)
       ON CONFLICT(task_id) DO UPDATE SET granted_token = MAX(granted_token, excluded.granted_token)`,
    );
    this.#observeReservedStmt = this.#db.prepare(
      `INSERT INTO execution_fencing_tokens (task_id, granted_token, reserved_token) VALUES (?, 0, ?)
       ON CONFLICT(task_id) DO UPDATE SET reserved_token = MAX(reserved_token, excluded.reserved_token)`,
    );
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

    // 任何调用路径（调度器 / 库形态 / 脚本）都必须先看到同步来的租约事件，否则取号会
    // 从 1 重新开始、转移预留的 token 被无视（跨副本旧 token 仍可提交）。
    this.#refreshObservationFromLedger(taskId);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#getStmt.get(taskId) as LeaseRow | undefined;
      // 跨副本计数：本机行可能从 1 起，但账本里别的副本已发过更大的号/转移预留了
      // 下一个号——取号必须越过它，否则转移后旧设备的旧 token 仍可提交。
      // 转移预留的号是「目标副本应当拿到的下一个号」：取 max(本地/远端已发放)+1 后，
      // 若预留值更大则直接采用预留值（不浪费号，也不产生低于校验下限的 token）。
      const observed = this.#observed(taskId);
      const nextToken = (localToken: number): number =>
        Math.max(localToken + 1, observed.granted + 1, observed.reserved);
      let outcome: LeaseAcquireOutcome;
      if (existing === undefined) {
        const token = nextToken(0);
        this.#insertStmt.run(taskId, replicaId, token, expiresIso, nowIso, nowIso);
        outcome = { token, expires_at: expiresIso, acquired_at: nowIso, heartbeat_at: nowIso };
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
          // 首次 / 过期抢占 / release 后重新持有：token 越过本地行与远端观察值
          const token = nextToken(existing.fencing_token);
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

  /**
   * 副作用提交前的 fencing 校验：token 匹配且租约当前有效，且不低于跨副本观察到的
   * 最大 token（granted 或转移预留）。后者保证旧设备持有的旧 token 在新设备接管后
   * 立即失效——即使本机租约行还残留着旧的 holder/token。
   */
  validate(taskId: string, token: number): boolean {
    this.#assertOpen();
    this.#refreshObservationFromLedger(taskId);
    const observed = this.#observed(taskId);
    const floor = Math.max(observed.granted, observed.reserved);
    if (token < floor) return false;
    const existing = this.#getStmt.get(taskId) as LeaseRow | undefined;
    if (existing === undefined) return false;
    if (existing.holder_replica_id === null) return false;
    if (existing.fencing_token !== token) return false;
    return this.#now().getTime() < Date.parse(existing.expires_at);
  }

  /**
   * 记录账本中观察到的「实际发放过」的最大 fencing token（幂等取 max）。
   * 由同步租约协调器在 pull 后调用；本机自身 acquire 也会推进本地行，无需调用。
   */
  observeGrantedToken(taskId: string, token: number): void {
    this.#assertOpen();
    if (!Number.isInteger(token) || token <= 0) return;
    this.#observeGrantedStmt.run(taskId, token);
  }

  /**
   * 从同库 events 表重放该任务的租约事件，刷新 granted/reserved 观察值。
   *
   * 为什么放在 store 内而不是只靠调度器喂：库形态（测试/演示/运维脚本）与调度器走同一个
   * acquire——安全属性必须在 store 层成立，而不是"某条调用路径成立"。事件按 task_id
   * 过滤（专列 + 索引），单任务事件量有界。
   */
  #refreshObservationFromLedger(taskId: string): void {
    if (this.#closed) return;
    let rows: Array<{ envelope: string }>;
    try {
      rows = this.#db
        .prepare("SELECT envelope FROM events WHERE task_id = ? ORDER BY seq")
        .all(taskId) as unknown as Array<{ envelope: string }>;
    } catch {
      return; // events 表尚不存在（独立库）：无观察值，按本地取号
    }
    for (const row of rows) {
      let envelope: { event_type?: string; payload?: Record<string, unknown> };
      try {
        envelope = JSON.parse(row.envelope) as typeof envelope;
      } catch {
        continue;
      }
      if (envelope.event_type === "task.lease_acquired") {
        const token = Number(envelope.payload?.fencing_token ?? envelope.payload?.token);
        if (Number.isInteger(token)) this.observeGrantedToken(taskId, token);
      } else if (envelope.event_type === "task.execution_transferred") {
        const reserved = Number(envelope.payload?.next_fencing_token);
        if (Number.isInteger(reserved)) this.observeReservedToken(taskId, reserved);
      }
    }
  }

  /**
   * 记录 task.execution_transferred 声明的 next_fencing_token（幂等取 max）。
   * 转移方/接收方都应记录：接收方 acquire 越过它取号，转移方用旧 token 提交会被
   * validate 拒绝。
   */
  observeReservedToken(taskId: string, token: number): void {
    this.#assertOpen();
    if (!Number.isInteger(token) || token <= 0) return;
    this.#observeReservedStmt.run(taskId, token);
  }

  /** 当前观察值（0 = 未观察；诊断/测试用） */
  fencingObservation(taskId: string): ObservedFencingTokens {
    this.#assertOpen();
    return this.#observed(taskId);
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

  #observed(taskId: string): ObservedFencingTokens {
    const row = this.#getObservedStmt.get(taskId) as
      | { granted_token: number | bigint; reserved_token: number | bigint }
      | undefined;
    if (row === undefined) return { granted: 0, reserved: 0 };
    return { granted: Number(row.granted_token), reserved: Number(row.reserved_token) };
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
