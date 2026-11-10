import { join } from "node:path";
import type { SyncCursorRecord } from "@morrow/protocol";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { DB_FILE_NAME } from "../ledger.ts";
import { ensureSyncTables } from "./migrations.ts";

/**
 * 同步游标存储（M3-T1 / Issue #30）。每对 peer 一行，两个方向各用独立列
 * （M3 code-review A2）：
 *   - inbound：`last_pulled_remote_sequence`——已从 peer 拉取/接收并导入的最高
 *     **peer** sequence（pullFromPeer 与 receivePush 共用）；
 *   - outbound：`last_acked_local_sequence`——已获 peer 确认的最高 **本地**
 *     sequence（只由 pushToPeer 推进）。
 * 对外投影仍用 `last_pulled_sequence` / `last_acked_sequence` 字段名（API 兼容），
 * 但语义已分离：收到 push 只推进 inbound，绝不影响下一轮反向 push 的起点。
 *
 * 游标只前进不后退（advance 单调取 max），缺口检测失败时不调用 advance。
 * M3 修复批（Issue #35）：last_synced_at——每次**成功**的 pull/push（含空批成功、
 * 游标无需推进的重复同步）都刷新；updated_at 只在游标实际前进时变化。
 */
export class SyncCursorStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #getStmt;
  #listStmt;
  #advancePulledRemoteStmt;
  #advanceAckedLocalStmt;
  #markSyncedStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureSyncTables(db);
    this.#getStmt = db.prepare(
      `SELECT peer_replica_id,
              last_pulled_remote_sequence AS last_pulled_sequence,
              last_acked_local_sequence   AS last_acked_sequence,
              last_synced_at, updated_at
         FROM sync_cursors WHERE peer_replica_id = ?`,
    );
    this.#listStmt = db.prepare(
      `SELECT peer_replica_id,
              last_pulled_remote_sequence AS last_pulled_sequence,
              last_acked_local_sequence   AS last_acked_sequence,
              last_synced_at, updated_at
         FROM sync_cursors ORDER BY peer_replica_id`,
    );
    this.#advancePulledRemoteStmt = db.prepare(
      `INSERT INTO sync_cursors (peer_replica_id, last_pulled_remote_sequence, last_acked_local_sequence, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(peer_replica_id) DO UPDATE SET
         last_pulled_remote_sequence = excluded.last_pulled_remote_sequence,
         updated_at = excluded.updated_at`,
    );
    this.#advanceAckedLocalStmt = db.prepare(
      `INSERT INTO sync_cursors (peer_replica_id, last_pulled_remote_sequence, last_acked_local_sequence, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(peer_replica_id) DO UPDATE SET
         last_acked_local_sequence = excluded.last_acked_local_sequence,
         updated_at = excluded.updated_at`,
    );
    this.#markSyncedStmt = db.prepare(
      `INSERT INTO sync_cursors (peer_replica_id, last_pulled_remote_sequence, last_acked_local_sequence, last_synced_at, updated_at)
       VALUES (?, 0, 0, ?, ?)
       ON CONFLICT(peer_replica_id) DO UPDATE SET
         last_synced_at = excluded.last_synced_at,
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
          last_synced_at: string | null;
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
        last_synced_at: null,
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
      last_synced_at: string | null;
      updated_at: string;
    }>;
    return rows.map(normalizeRow);
  }

  /** inbound 推进（只前进）；sequence <= 当前值时 no-op */
  advancePulledRemote(peerReplicaId: string, sequence: number, now: Date = new Date()): void {
    this.#assertOpen();
    if (!Number.isInteger(sequence) || sequence <= 0) return;
    const current = this.getOrZero(peerReplicaId).last_pulled_sequence;
    if (sequence <= current) return;
    this.#advancePulledRemoteStmt.run(peerReplicaId, sequence, now.toISOString());
  }

  /** outbound 已确认推进（只前进）；sequence <= 当前值时 no-op */
  advanceAckedLocal(peerReplicaId: string, sequence: number, now: Date = new Date()): void {
    this.#assertOpen();
    if (!Number.isInteger(sequence) || sequence <= 0) return;
    const current = this.getOrZero(peerReplicaId).last_acked_sequence;
    if (sequence <= current) return;
    this.#advanceAckedLocalStmt.run(peerReplicaId, sequence, now.toISOString());
  }

  /**
   * 标记该 peer 最近一次成功同步（M3 修复批 / Issue #35）：每次成功 pull / push /
   * 接收 push 后调用，即使没有新事件也刷新——「最后同步」表达会话成功，而非游标推进。
   * 首次同步即创建游标行（其余字段为 0）。
   */
  markSynced(peerReplicaId: string, now: Date = new Date()): void {
    this.#assertOpen();
    const iso = now.toISOString();
    this.#markSyncedStmt.run(peerReplicaId, iso, iso);
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
  last_synced_at: string | null;
  updated_at: string;
}): SyncCursorRecord {
  return {
    peer_replica_id: row.peer_replica_id,
    last_pulled_sequence: Number(row.last_pulled_sequence),
    last_acked_sequence: Number(row.last_acked_sequence),
    last_synced_at: row.last_synced_at !== null && row.last_synced_at.length > 0 ? row.last_synced_at : null,
    updated_at: row.updated_at.length > 0 ? row.updated_at : null,
  };
}
