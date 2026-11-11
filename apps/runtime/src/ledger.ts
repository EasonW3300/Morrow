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

export type LedgerErrorCode = "invalid_envelope" | "hash_mismatch" | "duplicate_event_id" | "ledger_closed";

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
  /** 按信封 task_id 过滤（M1-T4 / Issue #16：专列 + 索引） */
  taskId?: string;
  /** 页大小；账本层钳制到 [1,200]（HTTP 层负责对非法入参返回 400） */
  limit?: number;
  offset?: number;
}

/** 账本条目：信封原文 + 写入序号（SSE id、投影排序用） */
export interface LedgerEntry {
  sequence: number;
  envelope: EventEnvelope;
}

/** scan 的选择器；多个条件同时给定时取交集 */
export interface LedgerScanSelector {
  /** 按信封 session_id 过滤（M0 无专列，JSON 扫描；量级：单副本会话事件） */
  sessionId?: string;
  /** 按信封 task_id 过滤（M1-T4：专列 + 索引，见 CREATE_SQL 下方说明） */
  taskId?: string;
  /** 按 event_type 过滤（有专列，走索引） */
  eventType?: string;
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

/**
 * task_id 专列（M1-T4 / Issue #16）：任务事件查询（GET /v1/tasks/:id/events）从
 * M0 的 JSON 全扫升级为 `WHERE task_id = ?` 走索引（events_task_idx）。
 * 迁移只做 ALTER ADD COLUMN——不做回填：task 事件族随本票才出现，既有事件
 * （runtime 与 session 前缀族）一律无 task_id，回填没有可写的数据。
 */
const TASK_ID_MIGRATION_SQL = `
ALTER TABLE events ADD COLUMN task_id TEXT;
CREATE INDEX IF NOT EXISTS events_task_idx ON events (task_id, seq);
`;

export class EventLedger {
  readonly #db: SqliteDatabase;
  #closed = false;
  /** 进程内 append 订阅者（M4-T7 通知路由；不参与持久化） */
  readonly #listeners = new Set<(entry: LedgerEntry) => void>();

  #insertStmt;
  #countAllStmt;
  #pageAllStmt;
  #countByReplicaStmt;
  #pageByReplicaStmt;
  #seqRangeAllStmt;
  #byTypeStmt;
  #sampleStmt;
  #countByTaskStmt;
  #pageByTaskStmt;
  #byTaskStmt;
  #listSinceStmt;
  #hasEventStmt;
  #sequenceRangeStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);
    // task_id 专列迁移（M1-T4）：新库由 CREATE_SQL 之外的 ALTER 补列（幂等）；索引随迁移建。
    // 旧库（M0）同样走这条路径——ALTER 对已有库追加 NULL 列，不触碰既有行（append-only 触发器只锁 UPDATE/DELETE）。
    const columns = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "task_id")) {
      db.exec(TASK_ID_MIGRATION_SQL);
    } else {
      db.exec("CREATE INDEX IF NOT EXISTS events_task_idx ON events (task_id, seq)");
    }
    this.#insertStmt = db.prepare(
      "INSERT INTO events (event_id, replica_id, event_type, occurred_at, task_id, envelope) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#countAllStmt = db.prepare("SELECT COUNT(*) AS n FROM events");
    this.#pageAllStmt = db.prepare("SELECT envelope FROM events ORDER BY seq LIMIT ? OFFSET ?");
    this.#countByReplicaStmt = db.prepare("SELECT COUNT(*) AS n FROM events WHERE replica_id = ?");
    this.#pageByReplicaStmt = db.prepare(
      "SELECT envelope FROM events WHERE replica_id = ? ORDER BY seq LIMIT ? OFFSET ?",
    );
    this.#seqRangeAllStmt = db.prepare("SELECT seq, envelope FROM events ORDER BY seq");
    this.#byTypeStmt = db.prepare("SELECT seq, envelope FROM events WHERE event_type = ? ORDER BY seq");
    this.#sampleStmt = db.prepare(
      "SELECT seq, envelope FROM events WHERE (seq % ?) = 0 ORDER BY seq",
    );
    this.#countByTaskStmt = db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?");
    this.#pageByTaskStmt = db.prepare(
      "SELECT envelope FROM events WHERE task_id = ? ORDER BY seq LIMIT ? OFFSET ?",
    );
    this.#byTaskStmt = db.prepare("SELECT seq, envelope FROM events WHERE task_id = ? ORDER BY seq");
    // 同步增量导出（M3-T1 / Issue #30）：按写入序号游标取批，保持账本顺序。
    this.#listSinceStmt = db.prepare(
      "SELECT seq, envelope FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
    );
    this.#hasEventStmt = db.prepare("SELECT 1 AS hit FROM events WHERE event_id = ?");
    this.#sequenceRangeStmt = db.prepare("SELECT MIN(seq) AS min, MAX(seq) AS max, COUNT(*) AS n FROM events");
  }

  /** 打开（必要时创建）数据目录下的账本文件 */
  static open(dataDir: string): EventLedger {
    mkdirSync(dataDir, { recursive: true });
    return new EventLedger(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  /**
   * 进程内 append 订阅（M4-T7 通知路由的「订阅任务事件」接缝）。
   * 监听器在事件成功落库后同步收到；抛错被吞掉并记日志——通知是增强路径，
   * 不允许把账本写入变成依赖监听器的操作。返回退订函数。
   */
  subscribe(listener: (entry: LedgerEntry) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
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
        envelope.task_id ?? null,
        canonicalJson(envelope),
      );
      const sequence = Number(result.lastInsertRowid);
      if (this.#listeners.size > 0) {
        const entry: LedgerEntry = { sequence, envelope };
        for (const listener of this.#listeners) {
          try {
            listener(entry);
          } catch (err) {
            console.error("[morrow] ledger subscriber failed:", err);
          }
        }
      }
      return { sequence };
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: events.event_id")) {
        throw new LedgerError("duplicate_event_id", `event_id ${envelope.event_id} already exists`);
      }
      throw err;
    }
  }

  /**
   * 全量扫描（seq 升序）并按选择器过滤，返回带写入序号的信封条目。
   * 会话投影（会话列表/历史/SSE 重放）走 sessionId 分支（JSON 扫描）；task 事件
   * （任务详情/事件页）走 taskId 分支（task_id 专列 + 索引，M1-T4）。
   */
  scan(selector: LedgerScanSelector = {}): LedgerEntry[] {
    this.#assertOpen();
    const eventType = selector.eventType;
    if (selector.taskId !== undefined) {
      const rows = this.#byTaskStmt.all(selector.taskId) as Array<{ seq: number | bigint; envelope: string }>;
      const out: LedgerEntry[] = [];
      for (const row of rows) {
        const envelope = JSON.parse(row.envelope) as EventEnvelope;
        if (eventType !== undefined && envelope.event_type !== eventType) continue;
        out.push({ sequence: Number(row.seq), envelope });
      }
      return out;
    }
    if (selector.sessionId !== undefined) {
      const rows = this.#seqRangeAllStmt.all() as Array<{ seq: number | bigint; envelope: string }>;
      const out: LedgerEntry[] = [];
      for (const row of rows) {
        const envelope = JSON.parse(row.envelope) as EventEnvelope;
        if (envelope.session_id !== selector.sessionId) continue;
        if (eventType !== undefined && envelope.event_type !== eventType) continue;
        out.push({ sequence: Number(row.seq), envelope });
      }
      return out;
    }
    const rows = (
      eventType === undefined
        ? this.#seqRangeAllStmt.all()
        : this.#byTypeStmt.all(eventType)
    ) as Array<{ seq: number | bigint; envelope: string }>;
    return rows.map((row) => ({ sequence: Number(row.seq), envelope: JSON.parse(row.envelope) as EventEnvelope }));
  }

  /** 分页查询，按写入顺序（seq 升序）返回信封原文；replicaId / taskId 二选一过滤（同给以 taskId 优先） */
  list(options: LedgerListOptions = {}): LedgerPage {
    this.#assertOpen();
    const limit = clampInt(options.limit, 1, 200, 50);
    const offset = clampInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const replicaId = options.replicaId;
    const taskId = options.taskId;
    const rows = (
      taskId !== undefined
        ? this.#pageByTaskStmt.all(taskId, limit, offset)
        : replicaId === undefined
          ? this.#pageAllStmt.all(limit, offset)
          : this.#pageByReplicaStmt.all(replicaId, limit, offset)
    ) as Array<{ envelope: string }>;
    const countRow = (
      taskId !== undefined
        ? this.#countByTaskStmt.get(taskId)
        : replicaId === undefined
          ? this.#countAllStmt.get()
          : this.#countByReplicaStmt.get(replicaId)
    ) as { n: number | bigint };
    return {
      events: rows.map((row) => JSON.parse(row.envelope) as EventEnvelope),
      total: Number(countRow.n),
      limit,
      offset,
    };
  }

  /**
   * 增量导出（M3-T1 / Issue #30）：sequence 严格大于 sinceSeq 的条目，按 seq 升序。
   * limit 由调用方钳制（账本层兜底 [1,10000]）；同步批的 has_more 由调用方多取一条判定。
   */
  listSince(sequenceExclusive: number, limit = 1000): LedgerEntry[] {
    this.#assertOpen();
    const since = Number.isInteger(sequenceExclusive) && sequenceExclusive > 0 ? sequenceExclusive : 0;
    const safeLimit = clampInt(limit, 1, 10_000, 1000);
    const rows = this.#listSinceStmt.all(since, safeLimit) as Array<{ seq: number | bigint; envelope: string }>;
    return rows.map((row) => ({ sequence: Number(row.seq), envelope: JSON.parse(row.envelope) as EventEnvelope }));
  }

  /** event_id 是否已存在（同步导入的幂等预检；唯一约束仍是最终防线） */
  hasEvent(eventId: string): boolean {
    this.#assertOpen();
    return this.#hasEventStmt.get(eventId) !== undefined;
  }

  /** 账本 sequence 范围（GET /v1/sync/status 的投影；空账本 min/max 为 null） */
  sequenceRange(): { min: number | null; max: number | null; count: number } {
    this.#assertOpen();
    const row = this.#sequenceRangeStmt.get() as {
      min: number | bigint | null;
      max: number | bigint | null;
      n: number | bigint;
    };
    return {
      min: row.min === null ? null : Number(row.min),
      max: row.max === null ? null : Number(row.max),
      count: Number(row.n),
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
    // 诚实错误码："账本已关"不是信封非法（曾误用 invalid_envelope，M0 code-review / Issue #11）
    if (this.#closed) throw new LedgerError("ledger_closed", "ledger is closed");
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
