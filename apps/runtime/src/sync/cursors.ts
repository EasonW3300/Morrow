import { join } from "node:path";
import type { SyncCursorRecord } from "@morrow/protocol";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { DB_FILE_NAME } from "../ledger.ts";
import { ensureSyncTables } from "./migrations.ts";

/**
 * 同步游标存储（M3-T1 / Issue #30）。每对 peer 一行，记录两个方向独立的进度：
 * 拉取方向（last_pulled_sequence）与 push 方向已确认（last_acked_sequence）。
 * 游标只前进不后退（advance 单调取 max），缺口检测失败时不调用 advance。
 */
export class SyncCursorStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #getStmt;
  #listStmt;
  #advancePulledStmt;
  #advanceAckedStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureSyncTables(db);
    this.#getStmt = db.prepare(
      "SELECT peer_replica_id, last_pulled_sequence, last_acked_sequence, updated_at FROM sync_cursors WHERE peer_replica_id = ?",
    );
    this.#listStmt = db.prepare(
      "SELECT peer_replica_id, last_pulled_sequence, last_acked_sequence, updated_at FROM sync_cursors ORDER BY peer_replica_id",
    );
    this.#advancePulledStmt = db.prepare(
      `INSERT INTO sync_cursors (peer_replica_id, last_pulled_sequence, last_acked_sequence, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(peer_replica_id) DO UPDATE SET
         last_pulled_sequence = excluded.last_pulled_sequence,
         updated_at = excluded.updated_at`,
    );
    this.#advanceAckedStmt = db.prepare(
      `INSERT INTO sync_cursors (peer_replica_id, last_pulled_sequence, last_acked_sequence, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(peer_replica_id) DO UPDATE SET
         last_acked_sequence = excluded.last_acked_sequence,
         updated_at = excluded.updated_at`,
    );
  }

  /** 打开（必要时创建）与账本同库的游标表 */
  static open(dataDir: string): SyncCursorStore {
    return new SyncCursorStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  /** 已存在的 peer 游标；未同步过返回 null */
  get(peerReplicaId: string): SyncCursorRecord | null {
    this.#assertOpen();
    const row = this.#getStmt.get(peerReplicaId) as
      | {
          peer_replica_id: string;
          last_pulled_sequence: number | bigint;
          last_acked_sequence: number | bigint;
          updated_at: string;
        }
      | undefined;
    return row === undefined ? null : normalizeRow(row);
  }

  /** 未同步过的 peer 视为 (0, 0)，updated_at 为 null（不写空行） */
  getOrZero(peerReplicaId: string): SyncCursorRecord {
    return (
      this.get(peerReplicaId) ?? {
        peer_replica_id: peerReplicaId,
        last_pulled_sequence: 0,
        last_acked_sequence: 0,
        updated_at: null,
      }
    );
  }

  list(): SyncCursorRecord[] {
    this.#assertOpen();
    const rows = this.#listStmt.all() as Array<{
      peer_replica_id: string;
      last_pulled_sequence: number | bigint;
      last_acked_sequence: number | bigint;
      updated_at: string;
    }>;
    return rows.map(normalizeRow);
  }

  /** 拉取方向推进（只前进）；sequence <= 当前值时 no-op */
  advancePulled(peerReplicaId: string, sequence: number, now: Date = new Date()): void {
    this.#assertOpen();
    if (!Number.isInteger(sequence) || sequence <= 0) return;
    const current = this.getOrZero(peerReplicaId).last_pulled_sequence;
    if (sequence <= current) return;
    this.#advancePulledStmt.run(peerReplicaId, sequence, now.toISOString());
  }

  /** push 方向已确认推进（只前进）；sequence <= 当前值时 no-op */
  advanceAcked(peerReplicaId: string, sequence: number, now: Date = new Date()): void {
    this.#assertOpen();
    if (!Number.isInteger(sequence) || sequence <= 0) return;
    const current = this.getOrZero(peerReplicaId).last_acked_sequence;
    if (sequence <= current) return;
    this.#advanceAckedStmt.run(peerReplicaId, sequence, now.toISOString());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("sync cursor store is closed");
  }
}

function normalizeRow(row: {
  peer_replica_id: string;
  last_pulled_sequence: number | bigint;
  last_acked_sequence: number | bigint;
  updated_at: string;
}): SyncCursorRecord {
  return {
    peer_replica_id: row.peer_replica_id,
    last_pulled_sequence: Number(row.last_pulled_sequence),
    last_acked_sequence: Number(row.last_acked_sequence),
    updated_at: row.updated_at.length > 0 ? row.updated_at : null,
  };
}
