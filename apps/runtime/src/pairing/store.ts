import { join } from "node:path";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";

/**
 * 配对码持久化（M3-T2 / Issue #31）。
 *
 * 选型：**落库**（与 devices/events 同库 events.sqlite，SQLite WAL），而非纯内存。
 * 理由：
 * 1. 单次使用必须跨进程/重启原子——落库用一条条件 UPDATE
 *    (`WHERE used_at IS NULL AND expires_at > now`) 拿 changes 判定，天然防并发双花；
 *    内存 Map 在 runtime 重启后失效，且多进程（未来 sidecar 重启）无法共享。
 * 2. 过期/复用需要可区分的失败原因（过期 vs 已用 vs 不存在），行还在才能如实回答。
 * 3. 配对码只存 SHA-256 摘要（`hashPairingCode`），明文仅出现在 POST 响应一次，落库
 *    不引入「6 位码明文进数据库」的新暴露面。
 *
 * 存活期：过期/已用行保留 24h 供诊断，插入新码时顺带清理更老的行。
 */

export interface PairingCodeRow {
  code_hash: string;
  issuer_replica_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_replica_id: string | null;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash           TEXT PRIMARY KEY,
  issuer_replica_id   TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  used_at             TEXT,
  used_by_replica_id  TEXT
);
CREATE INDEX IF NOT EXISTS pairing_codes_expires_idx ON pairing_codes (expires_at);
`;

const RETENTION_MS = 24 * 60 * 60 * 1000;

export type ConsumeResult =
  | { status: "consumed" }
  | { status: "used"; row: PairingCodeRow }
  | { status: "expired"; row: PairingCodeRow }
  | { status: "unknown" };

export class PairingStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertStmt;
  #consumeStmt;
  #getStmt;
  #purgeStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);
    this.#insertStmt = db.prepare(
      `INSERT INTO pairing_codes (code_hash, issuer_replica_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    );
    this.#consumeStmt = db.prepare(
      `UPDATE pairing_codes SET used_at = ?, used_by_replica_id = ?
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    );
    this.#getStmt = db.prepare(
      "SELECT code_hash, issuer_replica_id, created_at, expires_at, used_at, used_by_replica_id FROM pairing_codes WHERE code_hash = ?",
    );
    this.#purgeStmt = db.prepare("DELETE FROM pairing_codes WHERE expires_at < ?");
  }

  static open(dataDir: string): PairingStore {
    return new PairingStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  insert(input: {
    codeHash: string;
    issuerReplicaId: string;
    createdAt: string;
    expiresAt: string;
  }): void {
    // 清理 24h 前的过期行（同一连接内一次 DELETE；不影响未过期/未使用码）。
    const cutoff = new Date(new Date(input.createdAt).getTime() - RETENTION_MS).toISOString();
    this.#purgeStmt.run(cutoff);
    this.#insertStmt.run(input.codeHash, input.issuerReplicaId, input.createdAt, input.expiresAt);
  }

  /**
   * 原子消费：仅当码未用且未过期时置 used。
   * 未消费成功时读回行以区分 expired / used / unknown。
   */
  consume(codeHash: string, now: Date, usedByReplicaId: string): ConsumeResult {
    const nowIso = now.toISOString();
    const result = this.#consumeStmt.run(nowIso, usedByReplicaId, codeHash, nowIso);
    if (Number(result.changes) === 1) return { status: "consumed" };
    const row = this.#getStmt.get(codeHash) as PairingCodeRow | undefined;
    if (row === undefined) return { status: "unknown" };
    if (row.used_at !== null) return { status: "used", row };
    return { status: "expired", row };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
