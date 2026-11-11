import { join } from "node:path";
import type { OutboxMessageRecord, OutboxReceipt, OutboxStatus, OutboxTarget } from "@morrow/protocol";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { DB_FILE_NAME } from "../ledger.ts";
import { ensureOutboxTables } from "./migrations.ts";

/**
 * OutboxStore（M4-T2 / Issue #39）：`outbox` 表的全部读写。
 *
 * 只做持久化，不做投递决策——状态机迁移由 OutboxService 编排。所有时间由调用方
 * 传入（服务注入时钟），测试零 sleep。
 *
 * 关键不变量：
 * 1. idempotency_key UNIQUE；enqueue 冲突返回既有行（deduped=true），不重复入队；
 * 2. markAttempt 在**发送请求之前**提交 attempts+1 与 last_attempt_at——崩溃后
 *    「是否可能已发出」只能从落盘值判断（以请求是否已发出为界）；
 * 3. 任何状态更新都带 updated_at；delivery_unknown 只能经 escalateToReview 离开，
 *    不会被 dispatch 的待发查询选中（查询只取 pending / failed）。
 */

export interface OutboxStoreOptions {
  /** 直接注入打开的库（与账本同库时复用连接）；与 dataDir 二选一 */
  db?: SqliteDatabase;
  /** 与事件账本同目录（events.sqlite；独立连接，WAL + busy_timeout） */
  dataDir?: string;
}

export interface EnqueueRowInput {
  id: string;
  idempotencyKey: string;
  channelId: string;
  accountId: string;
  target: OutboxTarget;
  payload: Record<string, unknown>;
  causationId: string | null;
  taskId: string | null;
  fencingToken: number | null;
  now: string;
}

export interface OutboxListOptions {
  status?: OutboxStatus;
  limit: number;
  offset: number;
}

export interface OutboxListResult {
  messages: OutboxMessageRecord[];
  total: number;
}

interface OutboxRow {
  id: string;
  idempotency_key: string;
  channel_id: string;
  account_id: string;
  target_kind: string;
  target_id: string;
  payload: string;
  status: string;
  attempts: number | bigint;
  last_error: string | null;
  receipt: string | null;
  causation_id: string | null;
  task_id: string | null;
  fencing_token: number | bigint | null;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export class OutboxStore {
  readonly #db: SqliteDatabase;
  readonly #ownsDb: boolean;
  #closed = false;

  #insertStmt;
  #byIdStmt;
  #fencingTokenStmt;
  #byKeyStmt;
  #countAllStmt;
  #pageAllStmt;
  #countStatusStmt;
  #pageStatusStmt;
  #dueStmt;
  #inFlightStmt;
  #byStatusStmt;
  #markAttemptStmt;
  #markSentStmt;
  #markFailedStmt;
  #markUnknownStmt;
  #escalateStmt;
  #deferStmt;
  #resetStmt;

  constructor(options: OutboxStoreOptions) {
    if (options.db !== undefined) {
      this.#db = options.db;
      this.#ownsDb = false;
    } else {
      if (options.dataDir === undefined) {
        throw new Error("OutboxStore requires either dataDir or db");
      }
      this.#db = openSqlite(join(options.dataDir, DB_FILE_NAME));
      this.#ownsDb = true;
    }
    ensureOutboxTables(this.#db);

    this.#insertStmt = this.#db.prepare(
      `INSERT INTO outbox
        (id, idempotency_key, channel_id, account_id, target_kind, target_id, payload, status,
         attempts, last_error, receipt, causation_id, task_id, fencing_token,
         last_attempt_at, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
    );
    this.#byIdStmt = this.#db.prepare("SELECT * FROM outbox WHERE id = ?");
    this.#fencingTokenStmt = this.#db.prepare("SELECT fencing_token FROM outbox WHERE id = ?");
    this.#byKeyStmt = this.#db.prepare("SELECT * FROM outbox WHERE idempotency_key = ?");
    this.#countAllStmt = this.#db.prepare("SELECT COUNT(*) AS n FROM outbox");
    this.#pageAllStmt = this.#db.prepare(
      "SELECT * FROM outbox ORDER BY created_at, id LIMIT ? OFFSET ?",
    );
    this.#countStatusStmt = this.#db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = ?");
    this.#pageStatusStmt = this.#db.prepare(
      "SELECT * FROM outbox WHERE status = ? ORDER BY created_at, id LIMIT ? OFFSET ?",
    );
    // 待投递：pending（含崩溃后未标记 attempt 的）与到期的 failed（指数退避重试）。
    // delivery_unknown / needs_review / sent 永不入选——未知状态不自动重发。
    this.#dueStmt = this.#db.prepare(
      `SELECT * FROM outbox
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at, id
       LIMIT ?`,
    );
    this.#inFlightStmt = this.#db.prepare(
      "SELECT * FROM outbox WHERE status = 'pending' AND last_attempt_at IS NOT NULL ORDER BY created_at, id",
    );
    this.#byStatusStmt = this.#db.prepare("SELECT * FROM outbox WHERE status = ? ORDER BY created_at, id");
    this.#markAttemptStmt = this.#db.prepare(
      `UPDATE outbox
       SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'failed')`,
    );
    this.#markSentStmt = this.#db.prepare(
      `UPDATE outbox
       SET status = 'sent', receipt = ?, last_error = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
    this.#markFailedStmt = this.#db.prepare(
      `UPDATE outbox
       SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.#markUnknownStmt = this.#db.prepare(
      `UPDATE outbox
       SET status = 'delivery_unknown', last_error = ?, next_attempt_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
    this.#escalateStmt = this.#db.prepare(
      `UPDATE outbox
       SET status = 'needs_review', last_error = ?, next_attempt_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'delivery_unknown'`,
    );
    this.#deferStmt = this.#db.prepare(
      "UPDATE outbox SET last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
    );
    this.#resetStmt = this.#db.prepare(
      `UPDATE outbox
       SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
  }

  /** 入队；幂等键冲突返回既有行（deduped=true），不覆盖原内容。 */
  enqueue(input: EnqueueRowInput): { deduped: boolean; message: OutboxMessageRecord } {
    this.#assertOpen();
    try {
      this.#insertStmt.run(
        input.id,
        input.idempotencyKey,
        input.channelId,
        input.accountId,
        input.target.kind,
        input.target.id,
        JSON.stringify(input.payload),
        input.causationId,
        input.taskId,
        input.fencingToken,
        input.now,
        input.now,
      );
      return { deduped: false, message: this.get(input.id)! };
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: outbox.idempotency_key")) {
        const existing = this.#byKeyStmt.get(input.idempotencyKey) as OutboxRow | undefined;
        if (existing !== undefined) {
          return { deduped: true, message: toRecord(existing) };
        }
      }
      throw err;
    }
  }

  get(id: string): OutboxMessageRecord | null {
    this.#assertOpen();
    const row = this.#byIdStmt.get(id) as OutboxRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /** 行上记录的 fencing token（投递前租约校验用；未携带为 null）。 */
  fencingToken(id: string): number | null {
    this.#assertOpen();
    const row = this.#fencingTokenStmt.get(id) as { fencing_token: number | bigint | null } | undefined;
    if (row === undefined || row.fencing_token === null) return null;
    return Number(row.fencing_token);
  }

  list(options: OutboxListOptions): OutboxListResult {
    this.#assertOpen();
    const rows = (
      options.status === undefined
        ? this.#pageAllStmt.all(options.limit, options.offset)
        : this.#pageStatusStmt.all(options.status, options.limit, options.offset)
    ) as OutboxRow[];
    const countRow = (
      options.status === undefined ? this.#countAllStmt.get() : this.#countStatusStmt.get(options.status)
    ) as { n: number | bigint };
    return { messages: rows.map(toRecord), total: Number(countRow.n) };
  }

  /** 到期待投递行（pending 或退避到期的 failed），按入队顺序。 */
  due(nowIso: string, limit: number): OutboxMessageRecord[] {
    this.#assertOpen();
    return (this.#dueStmt.all(nowIso, limit) as OutboxRow[]).map(toRecord);
  }

  /** 崩溃恢复候选：status=pending 但已发起过请求（last_attempt_at 非空）。 */
  inFlight(): OutboxMessageRecord[] {
    this.#assertOpen();
    return (this.#inFlightStmt.all() as OutboxRow[]).map(toRecord);
  }

  byStatus(status: OutboxStatus): OutboxMessageRecord[] {
    this.#assertOpen();
    return (this.#byStatusStmt.all(status) as OutboxRow[]).map(toRecord);
  }

  /** 请求发起前调用：attempts+1、last_attempt_at 落库（先于网络调用）。 */
  markAttempt(id: string, nowIso: string): void {
    this.#assertOpen();
    this.#markAttemptStmt.run(nowIso, nowIso, id);
  }

  markSent(id: string, receipt: OutboxReceipt, nowIso: string): void {
    this.#assertOpen();
    this.#markSentStmt.run(JSON.stringify(receipt), nowIso, id);
  }

  /** 明确失败：status=failed（可退避重试）或 needs_review（重试上限耗尽）。 */
  markFailed(
    id: string,
    error: string,
    nextAttemptAt: string | null,
    nowIso: string,
    status: "failed" | "needs_review" = "failed",
  ): void {
    this.#assertOpen();
    this.#markFailedStmt.run(status, error, nextAttemptAt, nowIso, id);
  }

  /** 回执未知：进入 delivery_unknown（不会被 due 选中），随后由服务转 needs_review。 */
  markDeliveryUnknown(id: string, reason: string, nowIso: string): void {
    this.#assertOpen();
    this.#markUnknownStmt.run(reason, nowIso, id);
  }

  /** delivery_unknown → needs_review；返回是否真的发生了迁移（幂等）。 */
  escalateToReview(id: string, reason: string, nowIso: string): boolean {
    this.#assertOpen();
    const result = this.#escalateStmt.run(reason, nowIso, id);
    return Number(result.changes) > 0;
  }

  /** 不发起投递、只推迟（如租约 fencing 拒绝）：状态不变，写退避时间与原因。 */
  defer(id: string, error: string, nextAttemptAt: string, nowIso: string): void {
    this.#assertOpen();
    this.#deferStmt.run(error, nextAttemptAt, nowIso, id);
  }

  /** 人工显式重试：重置为 pending（attempts 归零，历史留在 outbound.retried 事件）。 */
  resetForRetry(id: string, nowIso: string): void {
    this.#assertOpen();
    this.#resetStmt.run(nowIso, id);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsDb) this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("outbox store is closed");
  }
}

function toRecord(row: OutboxRow): OutboxMessageRecord {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    channel_id: row.channel_id,
    account_id: row.account_id,
    target: { kind: row.target_kind as OutboxTarget["kind"], id: row.target_id },
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status as OutboxStatus,
    attempts: Number(row.attempts),
    last_error: row.last_error,
    receipt: row.receipt === null ? null : (JSON.parse(row.receipt) as OutboxReceipt),
    causation_id: row.causation_id,
    task_id: row.task_id,
    last_attempt_at: row.last_attempt_at,
    next_attempt_at: row.next_attempt_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
