import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalJson,
  computeIntegrityHash,
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@morrow/protocol";
import { openSqlite, type SqliteDatabase } from "./db.ts";

/**
 * 事件账本 v1（PRD §6.3）：append-only 事件存储。
 *
 * - 只追加：库表级触发器拒绝 UPDATE/DELETE（唯一允许的写路径是 INSERT）；
 *   本类也不暴露任何修改/删除方法。纠错一律新事件 + causation_id 补偿。
 * - 写入前双重校验：protocol JSON Schema（运行时守门员）+ integrity_hash 复算比对。
 * - 完整性校验：verifyIntegrity 重算已存事件的 hash（默认全量，可抽样）。
 *   integrity_hash 是防篡改证据（无签名密钥，改数据+重算 hash 不可检出——那是 M+ 签名/审计的事）。
 */

export const DB_FILE_NAME = "events.sqlite";

export type LedgerErrorCode = "invalid_envelope" | "hash_mismatch" | "duplicate_event_id";

export class LedgerError extends Error {
  code: LedgerErrorCode;
  details?: unknown;

  constructor(code: LedgerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.details = details;
  }
}

export interface LedgerListOptions {
  /** 按副本 uuid 过滤 */
  replicaId?: string;
  /** 页大小；账本层钳制到 [1,200]（HTTP 层负责对非法入参返回 400） */
  limit?: number;
  offset?: number;
}

export interface LedgerPage {
  events: EventEnvelope[];
  total: number;
  limit: number;
  offset: number;
}

export interface IntegrityMismatch {
  sequence: number;
  event_id: string;
}

export interface IntegrityReport {
  ok: boolean;
  checked: number;
  total: number;
  mismatches: IntegrityMismatch[];
}

export interface VerifyIntegrityOptions {
  /** (0,1]，默认 1 全量；<1 时按 seq 取模均匀抽样（确定性） */
  sampleRate?: number;
}

const ajv = new Ajv2020({ allErrors: true });
const validateEnvelope = ajv.compile<EventEnvelope>(eventEnvelopeSchema);

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,
  replica_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  envelope    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_replica_idx ON events (replica_id, seq);
CREATE TRIGGER IF NOT EXISTS events_append_only_update
  BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(FAIL, 'events table is append-only');
END;
CREATE TRIGGER IF NOT EXISTS events_append_only_delete
  BEFORE DELETE ON events
BEGIN
  SELECT RAISE(FAIL, 'events table is append-only');
END;
`;

export class EventLedger {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertStmt;
  #countAllStmt;
  #pageAllStmt;
  #countByReplicaStmt;
  #pageByReplicaStmt;
  #seqRangeAllStmt;
  #sampleStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);
    this.#insertStmt = db.prepare(
      "INSERT INTO events (event_id, replica_id, event_type, occurred_at, envelope) VALUES (?, ?, ?, ?, ?)",
    );
    this.#countAllStmt = db.prepare("SELECT COUNT(*) AS n FROM events");
    this.#pageAllStmt = db.prepare("SELECT envelope FROM events ORDER BY seq LIMIT ? OFFSET ?");
    this.#countByReplicaStmt = db.prepare("SELECT COUNT(*) AS n FROM events WHERE replica_id = ?");
    this.#pageByReplicaStmt = db.prepare(
      "SELECT envelope FROM events WHERE replica_id = ? ORDER BY seq LIMIT ? OFFSET ?",
    );
    this.#seqRangeAllStmt = db.prepare("SELECT seq, envelope FROM events ORDER BY seq");
    this.#sampleStmt = db.prepare(
      "SELECT seq, envelope FROM events WHERE (seq % ?) = 0 ORDER BY seq",
    );
  }

  /** 打开（必要时创建）数据目录下的账本文件 */
  static open(dataDir: string): EventLedger {
    mkdirSync(dataDir, { recursive: true });
    return new EventLedger(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  /**
   * 追加一个事件。schema 非法 → invalid_envelope；hash 与内容不符 → hash_mismatch；
   * event_id 已存在 → duplicate_event_id（同步层的幂等去重由调用方先查）。
   */
  append(envelope: EventEnvelope): { sequence: number } {
    this.#assertOpen();
    if (!validateEnvelope(envelope)) {
      throw new LedgerError(
        "invalid_envelope",
        "envelope rejected by protocol schema v1",
        validateEnvelope.errors ?? [],
      );
    }
    const expected = computeIntegrityHash(envelope);
    if (envelope.integrity_hash !== expected) {
      throw new LedgerError(
        "hash_mismatch",
        `integrity_hash mismatch: declared ${envelope.integrity_hash}, content hashes to ${expected}`,
      );
    }
    try {
      const result = this.#insertStmt.run(
        envelope.event_id,
        envelope.replica_id,
        envelope.event_type,
        envelope.occurred_at,
        canonicalJson(envelope),
      );
      return { sequence: Number(result.lastInsertRowid) };
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: events.event_id")) {
        throw new LedgerError("duplicate_event_id", `event_id ${envelope.event_id} already exists`);
      }
      throw err;
    }
  }

  /** 分页查询，按写入顺序（seq 升序）返回信封原文 */
  list(options: LedgerListOptions = {}): LedgerPage {
    this.#assertOpen();
    const limit = clampInt(options.limit, 1, 200, 50);
    const offset = clampInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const replicaId = options.replicaId;
    const rows = (
      replicaId === undefined
        ? this.#pageAllStmt.all(limit, offset)
        : this.#pageByReplicaStmt.all(replicaId, limit, offset)
    ) as Array<{ envelope: string }>;
    const countRow = (
      replicaId === undefined ? this.#countAllStmt.get() : this.#countByReplicaStmt.get(replicaId)
    ) as { n: number | bigint };
    return {
      events: rows.map((row) => JSON.parse(row.envelope) as EventEnvelope),
      total: Number(countRow.n),
      limit,
      offset,
    };
  }

  /** 当前事件总数 */
  count(): number {
    this.#assertOpen();
    const row = this.#countAllStmt.get() as { n: number | bigint };
    return Number(row.n);
  }

  /**
   * 完整性校验：重算已存事件的 integrity_hash 并与落盘值比对。
   * sampleRate < 1 时按 seq 取模确定性抽样（seq 有稀疏空洞时比例近似）。
   */
  verifyIntegrity(options: VerifyIntegrityOptions = {}): IntegrityReport {
    this.#assertOpen();
    const total = this.count();
    const sampleRate = options.sampleRate ?? 1;
    if (total === 0) {
      return { ok: true, checked: 0, total: 0, mismatches: [] };
    }
    if (!(sampleRate > 0 && sampleRate <= 1)) {
      throw new RangeError(`sampleRate must be in (0, 1], got ${sampleRate}`);
    }
    const step = Math.max(1, Math.round(1 / sampleRate));
    const rows = (
      step === 1
        ? this.#seqRangeAllStmt.all()
        : this.#sampleStmt.all(step)
    ) as Array<{ seq: number | bigint; envelope: string }>;

    const mismatches: IntegrityMismatch[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.envelope);
      } catch {
        mismatches.push({ sequence: Number(row.seq), event_id: `<unreadable envelope at seq ${row.seq}>` });
        continue;
      }
      const event = parsed as EventEnvelope;
      const expected = computeIntegrityHash(event);
      if (event.integrity_hash !== expected) {
        mismatches.push({ sequence: Number(row.seq), event_id: event.event_id });
      }
    }
    return { ok: mismatches.length === 0, checked: rows.length, total, mismatches };
  }

  /** 关闭并 checkpoint（优雅退出的落盘点）；幂等 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new LedgerError("invalid_envelope", "ledger is closed");
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
