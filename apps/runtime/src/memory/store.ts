import { join } from "node:path";
import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { uuidv7 } from "../uuid-v7.ts";

/**
 * 记忆存储（票 M1-T1 / Issue #13；GLOSSARY MemorySource/MemoryCandidate/MemoryFact，
 * PRD §4.1 FR-MEM-2/7、§6.4）。与事件账本同库（events.sqlite，WAL）——记忆表可变，
 * events 表的 append-only 触发器只锁 events，互不影响（同 DeviceRegistry 模式）。
 *
 * 表结构一次到位（本票只写 sources + candidates，facts/revisions 留 T2 巩固写）：
 *   memory_sources       记忆来源（回链账本 event_id，事实必须可回链到来源）
 *   memory_candidates    候选记忆（带来源/观察时间/发生时间/置信度/敏感等级/版本）
 *   memory_facts         长期记忆（有版本与有效期）
 *   memory_fact_sources  事实↔来源 多对多（巩固聚合多条来源）
 *   memory_revisions     事实版本历史（FR-MEM-5：自动更新留历史）
 *   memory_fts           FTS5 全文索引（content 列 + entry_id/entry_kind UNINDEXED，
 *                        候选与事实统一索引，检索面覆盖两者）
 *
 * FTS5 与中文：node:sqlite 的 unicode61 分词把连续 CJK 视为单个 token，写入与查询
 * 前统一做「CJK 字符间插空格」的确定性归一化，短语查询即可命中任意连续中文子串
 * （零依赖、零 native 分词；Node 22.16+ / 24 内建 SQLite 才启用 FTS5，见 README）。
 */

export interface MemorySourceRow {
  source_id: string;
  kind: string;
  event_id: string;
  session_id: string | null;
  created_at: string;
}

export interface MemoryCandidateRow {
  candidate_id: string;
  content: string;
  kind: MemoryEntryKind;
  sensitivity: SensitivityLevel;
  confidence: number;
  source_id: string;
  observed_at: string;
  occurred_at: string;
  version: number;
  status: string;
  created_at: string;
}

export interface CreateCandidateInput {
  content: string;
  kind: MemoryEntryKind;
  confidence: number;
  /** 敏感等级；缺省 private（GLOSSARY：新记忆仅 Owner 会话可读） */
  sensitivity?: SensitivityLevel;
  /** 发生时间（来源事件时间）；缺省写入时刻 */
  occurredAt?: string;
  source: {
    /** 证据形态，M1-T1 恒为 "message"（任务事件等来源是后续票的扩展点） */
    kind: string;
    /** 回链的账本事件 id（如 message.user 的 event_id） */
    eventId: string;
    sessionId?: string | null;
  };
}

/** 检索命中（GET /v1/memory/facts 的条目；PRD §6.4 frontmatter 字段对齐） */
export interface MemorySearchHit {
  /** memory_candidates.candidate_id（T2 起含 memory_facts.fact_id） */
  id: string;
  /** 条目所处阶段：候选（未巩固）或事实 */
  stage: "candidate" | "fact";
  /** 条目类型（PRD §6.4 `type`）：fact | preference | profile | procedural */
  type: MemoryEntryKind;
  content: string;
  sensitivity: SensitivityLevel;
  /** 候选带置信度；事实无（省略） */
  confidence?: number;
  version: number;
  /** 来源回链：账本 event_id 列表（PRD §6.4 `sources`） */
  sources: string[];
  created_at: string;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS memory_sources (
  source_id  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_sources_event_idx ON memory_sources (event_id);

CREATE TABLE IF NOT EXISTS memory_candidates (
  candidate_id TEXT PRIMARY KEY,
  content      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'profile', 'procedural')),
  sensitivity  TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity IN ('public', 'private', 'locked')),
  confidence   REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_id    TEXT NOT NULL REFERENCES memory_sources (source_id),
  observed_at  TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consolidated', 'dismissed')),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_candidates_status_idx ON memory_candidates (status, created_at);

CREATE TABLE IF NOT EXISTS memory_facts (
  fact_id     TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'profile', 'procedural')),
  sensitivity TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity IN ('public', 'private', 'locked')),
  version     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  valid_from  TEXT NOT NULL,
  valid_until TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_fact_sources (
  fact_id   TEXT NOT NULL REFERENCES memory_facts (fact_id),
  source_id TEXT NOT NULL REFERENCES memory_sources (source_id),
  PRIMARY KEY (fact_id, source_id)
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  fact_id     TEXT NOT NULL REFERENCES memory_facts (fact_id),
  version     INTEGER NOT NULL CHECK (version >= 1),
  content     TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity IN ('public', 'private', 'locked')),
  reason      TEXT,
  source_id   TEXT REFERENCES memory_sources (source_id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_revisions_fact_idx ON memory_revisions (fact_id, version);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  entry_id UNINDEXED,
  entry_kind UNINDEXED
);
`;

/** CJK 表意文字 + 假名 + 谚文（unicode61 之下需要拆字的区段） */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * FTS 归一化：CJK 字符两侧插空格（"我喜欢用TypeScript" → "我 喜 欢 用 TypeScript"），
 * 使 unicode61 把每个 CJK 字符成词；查询侧同归一化后作短语查询即得子串匹配。
 */
export function normalizeForFts(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (i > 0 && (CJK_RE.test(chars[i]) || CJK_RE.test(chars[i - 1]))) out.push(" ");
    out.push(chars[i]);
  }
  return out.join("");
}

/** 用户查询 → FTS5 短语查询（引号转义防注入 FTS 语法） */
export function buildFtsQuery(q: string): string {
  return `"${normalizeForFts(q.trim()).replace(/"/g, '""')}"`;
}

interface FtsRow {
  entry_id: string;
  entry_kind: string;
}

export class MemoryStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertSourceStmt;
  #insertCandidateStmt;
  #insertFtsStmt;
  #ftsScanStmt;
  #candidateByIdStmt;
  #sourceByIdStmt;
  #factByIdStmt;
  #factSourcesStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);
    this.#insertSourceStmt = db.prepare(
      "INSERT INTO memory_sources (source_id, kind, event_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.#insertCandidateStmt = db.prepare(
      `INSERT INTO memory_candidates
         (candidate_id, content, kind, sensitivity, confidence, source_id, observed_at, occurred_at, version, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?)`,
    );
    this.#insertFtsStmt = db.prepare(
      "INSERT INTO memory_fts (content, entry_id, entry_kind) VALUES (?, ?, ?)",
    );
    this.#ftsScanStmt = db.prepare(
      "SELECT entry_id, entry_kind FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT 50",
    );
    this.#candidateByIdStmt = db.prepare(
      `SELECT candidate_id, content, kind, sensitivity, confidence, source_id, observed_at, occurred_at, version, status, created_at
       FROM memory_candidates WHERE candidate_id = ?`,
    );
    this.#sourceByIdStmt = db.prepare(
      "SELECT source_id, kind, event_id, session_id, created_at FROM memory_sources WHERE source_id = ?",
    );
    this.#factByIdStmt = db.prepare(
      `SELECT fact_id, content, kind, sensitivity, version, valid_from, valid_until, created_at, updated_at
       FROM memory_facts WHERE fact_id = ?`,
    );
    this.#factSourcesStmt = db.prepare(
      `SELECT ms.event_id FROM memory_fact_sources fs
       JOIN memory_sources ms ON ms.source_id = fs.source_id
       WHERE fs.fact_id = ? ORDER BY ms.created_at`,
    );
  }

  /** 打开（必要时创建）数据目录下与账本同库的记忆表 */
  static open(dataDir: string): MemoryStore {
    try {
      return new MemoryStore(openSqlite(join(dataDir, DB_FILE_NAME)));
    } catch (err) {
      if (err instanceof Error && err.message.includes("no such module: fts5")) {
        throw new Error(
          "Node 内建 SQLite 缺少 FTS5 模块（记忆检索硬依赖）：请用 Node 22.16+ / 24 运行（当前进程 " +
            process.version +
            "）。详见 apps/runtime/README.md「记忆管线」。",
        );
      }
      throw err;
    }
  }

  /**
   * 写入一条候选记忆：来源行 + 候选行 + FTS 索引在同一事务内落库。
   * 账本事件（memory.candidate_created）由 MemoryService 在此之后记账——
   * 行先于事件：检索面与账本审计以「事件成功」为准收尾，行是可重建投影。
   */
  createCandidate(input: CreateCandidateInput): { source: MemorySourceRow; candidate: MemoryCandidateRow } {
    this.#assertOpen();
    const now = new Date().toISOString();
    const source: MemorySourceRow = {
      source_id: uuidv7(),
      kind: input.source.kind,
      event_id: input.source.eventId,
      session_id: input.source.sessionId ?? null,
      created_at: now,
    };
    const occurredAt = input.occurredAt ?? now;
    const sensitivity = input.sensitivity ?? "private";
    const candidate: MemoryCandidateRow = {
      candidate_id: uuidv7(),
      content: input.content,
      kind: input.kind,
      sensitivity,
      confidence: input.confidence,
      source_id: source.source_id,
      observed_at: now,
      occurred_at: occurredAt,
      version: 1,
      status: "pending",
      created_at: now,
    };

    this.#exec("BEGIN");
    try {
      this.#insertSourceStmt.run(
        source.source_id,
        source.kind,
        source.event_id,
        source.session_id,
        source.created_at,
      );
      this.#insertCandidateStmt.run(
        candidate.candidate_id,
        candidate.content,
        candidate.kind,
        candidate.sensitivity,
        candidate.confidence,
        candidate.source_id,
        candidate.observed_at,
        candidate.occurred_at,
        candidate.created_at,
      );
      // 候选与事实统一进 FTS（entry_kind 区分）；T2 巩固写入 facts 时复用同一索引
      this.#insertFtsStmt.run(normalizeForFts(candidate.content), candidate.candidate_id, "candidate");
      this.#exec("COMMIT");
    } catch (err) {
      this.#exec("ROLLBACK");
      throw err;
    }
    return { source, candidate };
  }

  /**
   * FTS5 关键词检索：候选与事实统一索引（本票只有候选有数据），按相关度（rank）
   * 返回、上限 50；命中条目回链全部来源事件 id。
   */
  search(q: string): MemorySearchHit[] {
    this.#assertOpen();
    const query = buildFtsQuery(q);
    const rows = this.#ftsScanStmt.all(query) as unknown as FtsRow[];
    const hits: MemorySearchHit[] = [];
    for (const row of rows) {
      if (row.entry_kind === "candidate") {
        const hit = this.#candidateHit(row.entry_id);
        if (hit !== null) hits.push(hit);
      } else if (row.entry_kind === "fact") {
        const hit = this.#factHit(row.entry_id);
        if (hit !== null) hits.push(hit);
      }
    }
    return hits;
  }

  #candidateHit(candidateId: string): MemorySearchHit | null {
    const row = this.#candidateByIdStmt.get(candidateId) as unknown as
      | (MemoryCandidateRow & { source_id: string })
      | undefined;
    if (row === undefined) return null;
    const source = this.#sourceByIdStmt.get(row.source_id) as unknown as MemorySourceRow | undefined;
    return {
      id: row.candidate_id,
      stage: "candidate",
      type: row.kind,
      content: row.content,
      sensitivity: row.sensitivity,
      confidence: row.confidence,
      version: row.version,
      sources: source === undefined ? [] : [source.event_id],
      created_at: row.created_at,
    };
  }

  #factHit(factId: string): MemorySearchHit | null {
    const row = this.#factByIdStmt.get(factId) as unknown as
      | {
          fact_id: string;
          content: string;
          kind: MemoryEntryKind;
          sensitivity: SensitivityLevel;
          version: number;
          created_at: string;
        }
      | undefined;
    if (row === undefined) return null;
    const sourceRows = this.#factSourcesStmt.all(factId) as unknown as Array<{ event_id: string }>;
    return {
      id: row.fact_id,
      stage: "fact",
      type: row.kind,
      content: row.content,
      sensitivity: row.sensitivity,
      version: row.version,
      sources: sourceRows.map((s) => s.event_id),
      created_at: row.created_at,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("memory store is closed");
  }

  #exec(sql: string): void {
    this.#db.exec(sql);
  }
}
