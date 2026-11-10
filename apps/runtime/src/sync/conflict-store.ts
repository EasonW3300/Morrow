import { join } from "node:path";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { DB_FILE_NAME } from "../ledger.ts";
import { ensureSyncTables } from "./migrations.ts";

/**
 * 跨设备冲突元数据（票 M3-T3 / Issue #32，PRD §4.2「冲突合并」/ FR-DEP-5）。
 *
 * 冲突本体只有一个队列：M1 的 memory_conflicts（T2 的裁决端点就是唯一出口）。
 * 本表只补同步维度的事实——来源副本、local/remote/base 三方版本、远端事件 id，
 * 供 GET /v1/sync/conflicts 汇总；resolve 后标记 resolved_at。绝不另建第二队列，
 * 否则 Owner 要在两处裁决同一条冲突。
 */

export interface SyncConflictMeta {
  conflict_id: string;
  fact_id: string;
  local_replica_id: string;
  remote_replica_id: string;
  local_version: number;
  remote_version: number;
  base_version: number | null;
  reason: string;
  remote_event_id: string;
  created_at: string;
  resolved_at: string | null;
}

export class SyncConflictStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertStmt;
  #getStmt;
  #listStmt;
  #markResolvedStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureSyncTables(db);
    this.#insertStmt = db.prepare(
      `INSERT INTO sync_conflict_meta
         (conflict_id, fact_id, local_replica_id, remote_replica_id, local_version, remote_version,
          base_version, reason, remote_event_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(conflict_id) DO NOTHING`,
    );
    this.#getStmt = db.prepare(
      `SELECT conflict_id, fact_id, local_replica_id, remote_replica_id, local_version, remote_version,
              base_version, reason, remote_event_id, created_at, resolved_at
       FROM sync_conflict_meta WHERE conflict_id = ?`,
    );
    this.#listStmt = db.prepare(
      `SELECT conflict_id, fact_id, local_replica_id, remote_replica_id, local_version, remote_version,
              base_version, reason, remote_event_id, created_at, resolved_at
       FROM sync_conflict_meta ORDER BY created_at, conflict_id`,
    );
    this.#markResolvedStmt = db.prepare(
      "UPDATE sync_conflict_meta SET resolved_at = ? WHERE conflict_id = ? AND resolved_at IS NULL",
    );
  }

  static open(dataDir: string): SyncConflictStore {
    return new SyncConflictStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  record(meta: Omit<SyncConflictMeta, "resolved_at">): SyncConflictMeta {
    this.#assertOpen();
    this.#insertStmt.run(
      meta.conflict_id,
      meta.fact_id,
      meta.local_replica_id,
      meta.remote_replica_id,
      meta.local_version,
      meta.remote_version,
      meta.base_version,
      meta.reason,
      meta.remote_event_id,
      meta.created_at,
    );
    return this.get(meta.conflict_id) ?? { ...meta, resolved_at: null };
  }

  get(conflictId: string): SyncConflictMeta | null {
    this.#assertOpen();
    const row = this.#getStmt.get(conflictId) as unknown as SyncConflictMeta | undefined;
    return row ?? null;
  }

  list(): SyncConflictMeta[] {
    this.#assertOpen();
    return this.#listStmt.all() as unknown as SyncConflictMeta[];
  }

  markResolved(conflictId: string, resolvedAt = new Date().toISOString()): boolean {
    this.#assertOpen();
    const result = this.#markResolvedStmt.run(resolvedAt, conflictId);
    return Number(result.changes) === 1;
  }

  /** 该远端事件是否已经作为冲突处理过（幂等：重复导入不重复建冲突） */
  hasRemoteEvent(eventId: string): boolean {
    this.#assertOpen();
    const rows = this.#listStmt.all() as unknown as SyncConflictMeta[];
    return rows.some((row) => row.remote_event_id === eventId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("sync conflict store is closed");
  }
}
