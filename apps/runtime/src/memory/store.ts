import { join } from "node:path";
import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { uuidv7 } from "../uuid-v7.ts";
import type { ConflictReason } from "./consolidator.ts";

/**
 * 记忆存储（票 M1-T1 / Issue #13；巩固写路径 M1-T2 / Issue #14 激活。
 * GLOSSARY MemorySource/MemoryCandidate/MemoryFact/MemoryRevision，PRD §4.1 FR-MEM-2/4/5/7、
 * §6.4）。与事件账本同库（events.sqlite，WAL）——记忆表可变，events 表的 append-only
 * 触发器只锁 events，互不影响（同 DeviceRegistry 模式）。
 *
 * 表结构：
 *   memory_sources       记忆来源（回链账本 event_id，事实必须可回链到来源）
 *   memory_candidates    候选记忆（带来源/观察时间/发生时间/置信度/敏感等级/版本/status；
 *                        status：pending → consolidated | dismissed | conflicted，
 *                        conflicted = 冲突待确认（T2 起），裁决经 memory_conflicts）
 *   memory_facts         长期记忆（有版本与有效期；T2 巩固写）
 *   memory_fact_sources  事实↔来源 多对多（巩固聚合多条来源）
 *   memory_revisions     事实版本历史（FR-MEM-5：自动更新留历史；T2 巩固写）
 *   memory_conflicts     冲突待确认队列（T2：重大事实/locked/敏感等级冲突，FR-MEM-5）
 *   memory_fts           FTS5 全文索引（content 列 + entry_id/entry_kind UNINDEXED，
 *                        候选与事实统一索引，检索面覆盖两者）
 *
 * 迁移：T1 旧库的 memory_candidates status CHECK 无 'conflicted'，重开时整表重建
 * （SQLite 不能 ALTER CHECK；重建发生在任何表引用候选之前/之外——memory_conflicts
 * 在迁移后才建，且外键无强制执行，重命名不会波及引用方）。
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
  /** 记忆作用域（票 M7-A-T3）：owner（缺省，长期记忆池）/ session:<id>（临时会话） */
  scope: string;
  /** 逻辑清理时间（临时会话 24h 到期；非空 = 退出检索与巩固面，行保留） */
  expired_at: string | null;
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
  /**
   * 记忆作用域（票 M7-A-T3）：缺省 owner（长期记忆池）；
   * 临时会话写入 session:<session_id>（只读全局 + 本会话，默认不外溢）。
   */
  scope?: string;
  source: {
    /** 证据形态，M1-T1 恒为 "message"（任务事件等来源是后续票的扩展点） */
    kind: string;
    /** 回链的账本事件 id（如 message.user 的 event_id） */
    eventId: string;
    sessionId?: string | null;
  };
}

/** 候选生命周期（T2 起 conflicted = 冲突待确认，裁决走 memory_conflicts） */
export type CandidateStatus = "pending" | "consolidated" | "dismissed" | "conflicted";

/**
 * 冲突上报原因（FR-MEM-5：重大事实 / locked / 敏感等级）。
 * 单一真相源在 consolidator.ts（冲突判定矩阵的产出语义）；此处 re-export 供存储行类型
 * 与既有引用面沿用（M1 code-review：删除本文件重复定义，防双处漂移）。
 */
export type { ConflictReason };

/** 冲突裁决（Owner 三选一：采纳新值 / 保留旧值 / 合并） */
export type ConflictResolution = "keep_new" | "keep_old" | "merge";

/**
 * 长期事实（GLOSSARY: MemoryFact；版本链头部）。deleted_at 非空 = 删除标记（票 M1-T3）：
 * 软删不物理删——行与 memory_revisions/memory_fact_sources 保留作回链审计，
 * 事实从 listFacts（巩固匹配面/投影面）与 FTS（检索面）退出，删除经 memory.fact_deleted
 * tombstone 事件传播（M3 同步的单机前置）。
 */
export interface MemoryFactRow {
  fact_id: string;
  content: string;
  kind: MemoryEntryKind;
  sensitivity: SensitivityLevel;
  version: number;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** 记忆作用域（票 M7-A-T3）：owner / session:<id>；提升后变 owner */
  scope: string;
  /** 逻辑清理时间（临时会话 24h 到期）；非空 = 退出检索与投影面，行保留 */
  expired_at: string | null;
}

/** 事实版本历史条目（GLOSSARY: MemoryRevision；FR-MEM-5 自动更新留历史） */
export interface MemoryRevisionRow {
  revision_id: string;
  fact_id: string;
  version: number;
  content: string;
  sensitivity: SensitivityLevel;
  reason: string | null;
  source_id: string | null;
  created_at: string;
}

/**
 * 记忆投影快照（票 M3-T3 / Issue #32）：facts / revisions / sources / fact_sources
 * 的事件重放结果。MemoryStore 负责在一个事务里把这份快照落成可检索的投影
 * （replaceMemoryProjection），重放规则在 memory/rebuild.ts（纯函数，可单测）。
 */
export interface MemoryProjectionSnapshot {
  facts: MemoryFactRow[];
  revisions: MemoryRevisionRow[];
  sources: MemorySourceRow[];
  factSources: Array<{ fact_id: string; source_id: string }>;
}

/** 冲突待确认条目（FR-MEM-5：不静默覆盖，等 Owner 裁决） */
export interface MemoryConflictRow {
  conflict_id: string;
  candidate_id: string;
  fact_id: string;
  reason: ConflictReason;
  existing_content: string;
  incoming_content: string;
  existing_sensitivity: SensitivityLevel;
  incoming_sensitivity: SensitivityLevel;
  /** 冲突候选的来源（裁决产生修订时回链） */
  source_id: string;
  status: "open" | "resolved";
  resolution: ConflictResolution | null;
  /** merge 裁决时 Owner 提供的合并文本（keep_new 的采纳值见 incoming_content） */
  resolved_content: string | null;
  created_at: string;
  resolved_at: string | null;
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
  /** 条目作用域（票 M7-A-T3）：owner / session:<id>——UI 据此标「临时」/禁用提升 */
  scope: string;
  created_at: string;
}

/**
 * 候选表 DDL（唯一真相源：新库建表与旧库迁移共用，status 含 'conflicted'）。
 * 单独成常量是因为 SQLite 不能 ALTER CHECK——T1 旧库迁移要按同一 DDL 重建（见下）。
 */
const MEMORY_CANDIDATES_DDL = `
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
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consolidated', 'dismissed', 'conflicted')),
  scope        TEXT NOT NULL DEFAULT 'owner',
  expired_at   TEXT,
  created_at   TEXT NOT NULL
);
`;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS memory_sources (
  source_id  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_sources_event_idx ON memory_sources (event_id);

${MEMORY_CANDIDATES_DDL}

CREATE TABLE IF NOT EXISTS memory_facts (
  fact_id     TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'profile', 'procedural')),
  sensitivity TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity IN ('public', 'private', 'locked')),
  version     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  valid_from  TEXT NOT NULL,
  valid_until TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  scope       TEXT NOT NULL DEFAULT 'owner',
  expired_at  TEXT
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

/**
 * 冲突队列表（票 M1-T2 / FR-MEM-5）+ 候选 status 索引。在候选表迁移**之后**执行：
 * 旧库迁移走 RENAME→建新→拷贝→DROP，若此时已有表引用候选表，RENAME 会连带改写
 * 引用方的外键子句——冲突表在迁移后才存在，引用安全；status 索引随候选表 DROP 而
 * 丢失，在这里统一补建（IF NOT EXISTS 对新库幂等）。
 */
const CONFLICTS_CREATE_SQL = `
CREATE TABLE IF NOT EXISTS memory_conflicts (
  conflict_id          TEXT PRIMARY KEY,
  candidate_id         TEXT NOT NULL REFERENCES memory_candidates (candidate_id),
  fact_id              TEXT NOT NULL REFERENCES memory_facts (fact_id),
  reason               TEXT NOT NULL CHECK (reason IN ('fact_conflict', 'locked', 'sensitivity_change')),
  existing_content     TEXT NOT NULL,
  incoming_content     TEXT NOT NULL,
  existing_sensitivity TEXT NOT NULL CHECK (existing_sensitivity IN ('public', 'private', 'locked')),
  incoming_sensitivity TEXT NOT NULL CHECK (incoming_sensitivity IN ('public', 'private', 'locked')),
  source_id            TEXT NOT NULL REFERENCES memory_sources (source_id),
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution           TEXT CHECK (resolution IN ('keep_new', 'keep_old', 'merge')),
  resolved_content     TEXT,
  created_at           TEXT NOT NULL,
  resolved_at          TEXT
);
CREATE INDEX IF NOT EXISTS memory_conflicts_status_idx ON memory_conflicts (status, created_at);
CREATE INDEX IF NOT EXISTS memory_candidates_status_idx ON memory_candidates (status, created_at);
`;

/**
 * T1 旧库迁移（票 M1-T2）：status CHECK 增加 'conflicted'。SQLite 不支持 ALTER
 * CHECK，标准做法是整表重建：RENAME → 按新 DDL 建表 → 拷贝 → DROP 旧表。
 * 触发条件以 sqlite_master.sql 内容判定（确定性；新库/已迁移库直接跳过）。
 */
const CANDIDATES_MIGRATION_SQL = `
ALTER TABLE memory_candidates RENAME TO memory_candidates_legacy;
${MEMORY_CANDIDATES_DDL}
INSERT INTO memory_candidates
  (candidate_id, content, kind, sensitivity, confidence, source_id, observed_at, occurred_at, version, status, created_at)
SELECT candidate_id, content, kind, sensitivity, confidence, source_id, observed_at, occurred_at, version, status, created_at
  FROM memory_candidates_legacy;
DROP TABLE memory_candidates_legacy;
`;

function migrateCandidateStatuses(db: SqliteDatabase): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_candidates'")
    .get() as { sql: string } | undefined;
  if (row === undefined || row.sql.includes("'conflicted'")) return;
  db.exec(CANDIDATES_MIGRATION_SQL);
}

/**
 * 事实表删除标记列迁移（票 M1-T3）：deleted_at 非空 = 软删。新库由 CREATE_SQL 直接带列；
 * 既有库走 ALTER ADD COLUMN（SQLite 允许，NULL 缺省，不触碰既有行）——与账本 task_id
 * 专列同一迁移模式（PRAGMA table_info 判定，幂等可重复执行）。
 */
function migrateFactDeletedAt(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(memory_facts)").all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "deleted_at")) return;
  db.exec("ALTER TABLE memory_facts ADD COLUMN deleted_at TEXT");
}

/**
 * 记忆作用域列迁移（票 M7-A-T3 / Issue #60）：memory_candidates / memory_facts 增
 * scope（缺省 owner）。候选表若在 T1 旧库重建路径已按新 DDL 建出，这里跳过；
 * 事实表/已迁移候选表走 ALTER ADD COLUMN（SQLite 允许带缺省值的 NOT NULL，不触碰既有行）。
 */
function migrateScopeColumns(db: SqliteDatabase): void {
  for (const table of ["memory_candidates", "memory_facts"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === "scope")) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN scope TEXT NOT NULL DEFAULT 'owner'`);
  }
}

/** 逻辑清理列（临时会话 24h 到期）：非空 = 退出检索/巩固/投影面，行与账本保留 */
function migrateExpiredAtColumns(db: SqliteDatabase): void {
  for (const table of ["memory_candidates", "memory_facts"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === "expired_at")) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN expired_at TEXT`);
  }
}

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

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return 200;
  return Math.min(limit, 200);
}

/**
 * 作用域可见性（票 M7-A-T3 / ADR-0010）：
 *   owner 查询只看 owner（长期记忆池，默认不外溢）；
 *   session:<id> 查询看 owner + 该会话（只读全局继续成立，不串其他会话）。
 */
function scopeVisible(entryScope: string, queryScope: string): boolean {
  if (queryScope === "owner") return entryScope === "owner";
  return entryScope === "owner" || entryScope === queryScope;
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
  #candidateBySourceStmt;
  #listCandidatesAllStmt;
  #listCandidatesByStatusStmt;
  #setCandidateStatusStmt;
  #insertFactStmt;
  #insertFactSourceStmt;
  #updateFactStmt;
  #insertRevisionStmt;
  #listFactsStmt;
  #listFactsByScopeStmt;
  #listAllFactsStmt;
  #revisionByVersionStmt;
  #listRevisionsStmt;
  #listAllRevisionsStmt;
  #deleteFactStmt;
  #deleteFtsEntryStmt;
  #promoteCandidateStmt;
  #promoteFactStmt;
  #candidateIdsByScopeStmt;
  #factIdsByScopeStmt;
  #expireCandidateStmt;
  #expireFactStmt;
  #insertConflictStmt;
  #getConflictStmt;
  #listConflictsAllStmt;
  #listConflictsByStatusStmt;
  #resolveConflictStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);
    // T1 旧库先重建候选表（此时没有任何表引用它，RENAME 无波及），再建冲突队列；
    // 事实表补 deleted_at 列（票 M1-T3 软删，幂等）
    migrateCandidateStatuses(db);
    migrateFactDeletedAt(db);
    migrateScopeColumns(db);
    migrateExpiredAtColumns(db);
    db.exec(CONFLICTS_CREATE_SQL);
    this.#insertSourceStmt = db.prepare(
      "INSERT INTO memory_sources (source_id, kind, event_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.#insertCandidateStmt = db.prepare(
      `INSERT INTO memory_candidates
         (candidate_id, content, kind, sensitivity, confidence, source_id, observed_at, occurred_at, version, status, scope, expired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, NULL, ?)`,
    );
    this.#insertFtsStmt = db.prepare(
      "INSERT INTO memory_fts (content, entry_id, entry_kind) VALUES (?, ?, ?)",
    );
    this.#ftsScanStmt = db.prepare(
      "SELECT entry_id, entry_kind FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT 50",
    );
    this.#candidateByIdStmt = db.prepare(
      `SELECT c.candidate_id, c.content, c.kind, c.sensitivity, c.confidence, c.source_id, c.observed_at, c.occurred_at, c.version, c.status, c.scope, c.expired_at, c.created_at, s.event_id AS source_event_id
       FROM memory_candidates c JOIN memory_sources s ON s.source_id = c.source_id
       WHERE c.candidate_id = ?`,
    );
    this.#sourceByIdStmt = db.prepare(
      "SELECT source_id, kind, event_id, session_id, created_at FROM memory_sources WHERE source_id = ?",
    );
    this.#factByIdStmt = db.prepare(
      `SELECT fact_id, content, kind, sensitivity, version, valid_from, valid_until, created_at, updated_at, deleted_at, scope, expired_at
       FROM memory_facts WHERE fact_id = ?`,
    );
    this.#factSourcesStmt = db.prepare(
      `SELECT ms.event_id FROM memory_fact_sources fs
       JOIN memory_sources ms ON ms.source_id = fs.source_id
       WHERE fs.fact_id = ? ORDER BY ms.created_at`,
    );
    this.#candidateBySourceStmt = db.prepare(
      `SELECT c.candidate_id FROM memory_candidates c
       JOIN memory_sources s ON s.source_id = c.source_id
       WHERE s.event_id = ? AND c.content = ? LIMIT 1`,
    );
    this.#listCandidatesAllStmt = db.prepare(
      `SELECT c.*, s.event_id AS source_event_id
       FROM memory_candidates c JOIN memory_sources s ON s.source_id = c.source_id
       WHERE c.expired_at IS NULL
       ORDER BY c.created_at, c.candidate_id LIMIT ? OFFSET ?`,
    );
    this.#listCandidatesByStatusStmt = db.prepare(
      `SELECT c.*, s.event_id AS source_event_id
       FROM memory_candidates c JOIN memory_sources s ON s.source_id = c.source_id
       WHERE c.status = ? AND c.expired_at IS NULL ORDER BY c.created_at, c.candidate_id LIMIT ? OFFSET ?`,
    );
    this.#setCandidateStatusStmt = db.prepare(
      "UPDATE memory_candidates SET status = ? WHERE candidate_id = ?",
    );
    this.#insertFactStmt = db.prepare(
      `INSERT INTO memory_facts (fact_id, content, kind, sensitivity, version, valid_from, valid_until, created_at, updated_at, scope, expired_at)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?)`,
    );
    this.#insertFactSourceStmt = db.prepare(
      "INSERT OR IGNORE INTO memory_fact_sources (fact_id, source_id) VALUES (?, ?)",
    );
    this.#updateFactStmt = db.prepare(
      "UPDATE memory_facts SET content = ?, sensitivity = ?, version = version + 1, updated_at = ? WHERE fact_id = ?",
    );
    this.#insertRevisionStmt = db.prepare(
      `INSERT INTO memory_revisions (revision_id, fact_id, version, content, sensitivity, reason, source_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#listFactsStmt = db.prepare(
      `SELECT fact_id, content, kind, sensitivity, version, valid_from, valid_until, created_at, updated_at, deleted_at, scope, expired_at
       FROM memory_facts WHERE valid_until IS NULL AND deleted_at IS NULL AND expired_at IS NULL ORDER BY created_at, fact_id`,
    );
    this.#listFactsByScopeStmt = db.prepare(
      `SELECT fact_id, content, kind, sensitivity, version, valid_from, valid_until, created_at, updated_at, deleted_at, scope, expired_at
       FROM memory_facts WHERE valid_until IS NULL AND deleted_at IS NULL AND expired_at IS NULL AND scope = ?
       ORDER BY created_at, fact_id`,
    );
    this.#listAllFactsStmt = db.prepare(
      `SELECT fact_id, content, kind, sensitivity, version, valid_from, valid_until, created_at, updated_at, deleted_at, scope, expired_at
       FROM memory_facts ORDER BY created_at, fact_id`,
    );
    this.#revisionByVersionStmt = db.prepare(
      `SELECT revision_id, fact_id, version, content, sensitivity, reason, source_id, created_at
       FROM memory_revisions WHERE fact_id = ? AND version = ?`,
    );
    this.#listRevisionsStmt = db.prepare(
      `SELECT revision_id, fact_id, version, content, sensitivity, reason, source_id, created_at
       FROM memory_revisions WHERE fact_id = ? ORDER BY version, revision_id`,
    );
    this.#listAllRevisionsStmt = db.prepare(
      `SELECT revision_id, fact_id, version, content, sensitivity, reason, source_id, created_at
       FROM memory_revisions ORDER BY fact_id, version, revision_id`,
    );
    this.#deleteFactStmt = db.prepare(
      "UPDATE memory_facts SET deleted_at = ? WHERE fact_id = ? AND deleted_at IS NULL",
    );
    this.#deleteFtsEntryStmt = db.prepare(
      "DELETE FROM memory_fts WHERE entry_id = ? AND entry_kind = ?",
    );
    // --- M7-A-T3：提升与临时会话逻辑清理 -------------------------------------
    this.#promoteCandidateStmt = db.prepare(
      "UPDATE memory_candidates SET scope = 'owner' WHERE candidate_id = ?",
    );
    this.#promoteFactStmt = db.prepare(
      "UPDATE memory_facts SET scope = 'owner' WHERE fact_id = ?",
    );
    this.#candidateIdsByScopeStmt = db.prepare(
      "SELECT candidate_id FROM memory_candidates WHERE scope = ? AND expired_at IS NULL",
    );
    this.#factIdsByScopeStmt = db.prepare(
      "SELECT fact_id FROM memory_facts WHERE scope = ? AND expired_at IS NULL",
    );
    this.#expireCandidateStmt = db.prepare(
      "UPDATE memory_candidates SET expired_at = ? WHERE candidate_id = ? AND expired_at IS NULL",
    );
    this.#expireFactStmt = db.prepare(
      "UPDATE memory_facts SET expired_at = ? WHERE fact_id = ? AND expired_at IS NULL",
    );
    this.#insertConflictStmt = db.prepare(
      `INSERT INTO memory_conflicts
         (conflict_id, candidate_id, fact_id, reason, existing_content, incoming_content,
          existing_sensitivity, incoming_sensitivity, source_id, status, resolution, resolved_content, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, NULL)`,
    );
    this.#getConflictStmt = db.prepare(
      `SELECT conflict_id, candidate_id, fact_id, reason, existing_content, incoming_content,
              existing_sensitivity, incoming_sensitivity, source_id, status, resolution, resolved_content, created_at, resolved_at
       FROM memory_conflicts WHERE conflict_id = ?`,
    );
    this.#listConflictsAllStmt = db.prepare(
      `SELECT conflict_id, candidate_id, fact_id, reason, existing_content, incoming_content,
              existing_sensitivity, incoming_sensitivity, source_id, status, resolution, resolved_content, created_at, resolved_at
       FROM memory_conflicts ORDER BY created_at, conflict_id LIMIT ? OFFSET ?`,
    );
    this.#listConflictsByStatusStmt = db.prepare(
      `SELECT conflict_id, candidate_id, fact_id, reason, existing_content, incoming_content,
              existing_sensitivity, incoming_sensitivity, source_id, status, resolution, resolved_content, created_at, resolved_at
       FROM memory_conflicts WHERE status = ? ORDER BY created_at, conflict_id LIMIT ? OFFSET ?`,
    );
    this.#resolveConflictStmt = db.prepare(
      "UPDATE memory_conflicts SET status = 'resolved', resolution = ?, resolved_content = ?, resolved_at = ? WHERE conflict_id = ? AND status = 'open'",
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
    const scope = input.scope ?? "owner";
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
      scope,
      expired_at: null,
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
        candidate.scope,
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

  // --- 巩固写路径（票 M1-T2 / Issue #14）---------------------------------------
  // 每个公开方法 = 一个逻辑记忆操作 = 一个事务（候选/事实/修订/冲突行同进退）；
  // memory.* 账本事件由 MemoryService 在行落定之后记账（行是可重建投影）。

  getCandidate(candidateId: string): (MemoryCandidateRow & { source_event_id: string }) | null {
    this.#assertOpen();
    const row = this.#candidateByIdStmt.get(candidateId) as unknown as
      | (MemoryCandidateRow & { source_event_id: string })
      | undefined;
    return row ?? null;
  }

  /** 来源行（来源 id → 账本 event_id 回链；巩固事件 causation 用） */
  getSource(sourceId: string): MemorySourceRow | null {
    this.#assertOpen();
    const row = this.#sourceByIdStmt.get(sourceId) as unknown as MemorySourceRow | undefined;
    return row ?? null;
  }

  /** 候选列表（含来源 event_id 回链）；status 过滤可选，created_at 升序（巩固顺序） */
  listCandidates(
    filter: { status?: CandidateStatus; limit?: number; offset?: number } = {},
  ): Array<MemoryCandidateRow & { source_event_id: string }> {
    this.#assertOpen();
    const limit = clampLimit(filter.limit);
    const offset = filter.offset === undefined ? 0 : Math.max(0, Math.floor(filter.offset));
    const rows = (
      filter.status === undefined
        ? this.#listCandidatesAllStmt.all(limit, offset)
        : this.#listCandidatesByStatusStmt.all(filter.status, limit, offset)
    ) as unknown as Array<MemoryCandidateRow & { source_event_id: string }>;
    return rows;
  }

  setCandidateStatus(candidateId: string, status: CandidateStatus): void {
    this.#assertOpen();
    this.#tx(() => {
      this.#setCandidateStatusInTx(candidateId, status);
    });
  }

  /** 抽取去重：同一来源事件 + 同一内容已写过候选（T1 即时写入路径先行时避免重复） */
  hasCandidateFromSource(sourceEventId: string, content: string): boolean {
    this.#assertOpen();
    return this.#candidateBySourceStmt.get(sourceEventId, content) !== undefined;
  }

  getFact(factId: string): MemoryFactRow | null {
    this.#assertOpen();
    const row = this.#factByIdStmt.get(factId) as unknown as MemoryFactRow | undefined;
    return row ?? null;
  }

  /** 现存有效事实（巩固器匹配视图 + 投影面）；created_at 升序（并列匹配的确定性 tie-break）。
   *  已删（deleted_at 非空）、已过期（valid_until 非空）与逻辑过期（expired_at 非空）事实
   *  都不在视图内——重投影不复活已删/已过期记忆。
   *  filter.scope（票 M7-A-T3）：精确作用域过滤（巩固匹配必须同作用域，避免临时写入
   *  改写长期事实）；缺省 = 全部作用域。 */
  listFacts(filter: { scope?: string } = {}): MemoryFactRow[] {
    this.#assertOpen();
    return (
      filter.scope === undefined
        ? this.#listFactsStmt.all()
        : this.#listFactsByScopeStmt.all(filter.scope)
    ) as unknown as MemoryFactRow[];
  }

  /** 全部事实行（含已删/已过期）：投影重建快照与一致性校验用 */
  listAllFacts(): MemoryFactRow[] {
    this.#assertOpen();
    return this.#listAllFactsStmt.all() as unknown as MemoryFactRow[];
  }

  /** 指定版本的修订（三方合并的基线查找）；不存在返回 null */
  getRevision(factId: string, version: number): MemoryRevisionRow | null {
    this.#assertOpen();
    const row = this.#revisionByVersionStmt.get(factId, version) as unknown as MemoryRevisionRow | undefined;
    return row ?? null;
  }

  /** 单事实版本历史（version 升序） */
  listRevisions(factId: string): MemoryRevisionRow[] {
    this.#assertOpen();
    return this.#listRevisionsStmt.all(factId) as unknown as MemoryRevisionRow[];
  }

  /** 全部修订行（投影重建一致性校验用） */
  listAllRevisions(): MemoryRevisionRow[] {
    this.#assertOpen();
    return this.#listAllRevisionsStmt.all() as unknown as MemoryRevisionRow[];
  }

  /**
   * 删除标记（票 M1-T3，FR-MEM-8 的单机前置）：软删——deleted_at 落值 + FTS 索引移除
   * （检索面立即退出），行/修订/来源多对多保留（回链审计）。单事务；重复删除或未知
   * 事实抛错（服务层先经 getFact 判定，此为竞态兜底）。tombstone 事件由 MemoryService
   * 在行落定之后记账（memory.fact_deleted）。
   */
  deleteFact(factId: string): { fact: MemoryFactRow; deleted_at: string } {
    this.#assertOpen();
    const now = new Date().toISOString();
    return this.#tx(() => {
      const fact = this.#getFactInTx(factId);
      const result = this.#deleteFactStmt.run(now, factId);
      if (Number(result.changes) !== 1) {
        throw new Error(`fact ${factId} is already deleted`);
      }
      this.#deleteFtsEntryStmt.run(factId, "fact");
      return { fact: this.#getFactInTx(factId), deleted_at: now };
    });
  }

  /** 事实的全部来源账本事件 id（投影 frontmatter `sources` 与 tombstone causation 用），按来源创建时间升序 */
  factSourceEventIds(factId: string): string[] {
    this.#assertOpen();
    const rows = this.#factSourcesStmt.all(factId) as unknown as Array<{ event_id: string }>;
    return rows.map((row) => row.event_id);
  }

  /** 巩固新建事实：事实 v1 + 来源多对多 + FTS + 候选转 consolidated（单事务）。
   *  作用域与逻辑过期状态继承自候选（票 M7-A-T3）——临时会话候选巩固出的事实仍在
   *  session:<id> 作用域；已过期候选不会因巩固复活到检索面。 */
  createFact(input: { content: string; kind: MemoryEntryKind; sensitivity: SensitivityLevel; candidateId: string; sourceId: string }): MemoryFactRow {
    this.#assertOpen();
    const now = new Date().toISOString();
    return this.#tx(() => {
      const candidate = this.#getCandidateInTx(input.candidateId);
      const fact: MemoryFactRow = {
        fact_id: uuidv7(),
        content: input.content,
        kind: input.kind,
        sensitivity: input.sensitivity,
        version: 1,
        valid_from: now,
        valid_until: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        scope: candidate?.scope ?? "owner",
        expired_at: candidate?.expired_at ?? null,
      };
      this.#insertFactStmt.run(
        fact.fact_id,
        fact.content,
        fact.kind,
        fact.sensitivity,
        fact.valid_from,
        fact.created_at,
        fact.updated_at,
        fact.scope,
        fact.expired_at,
      );
      this.#insertFactSourceStmt.run(fact.fact_id, input.sourceId);
      if (fact.expired_at === null) {
        this.#insertFtsStmt.run(normalizeForFts(fact.content), fact.fact_id, "fact");
      }
      this.#setCandidateStatusInTx(input.candidateId, "consolidated");
      return fact;
    });
  }

  /**
   * 巩固更新既有事实（版本链推进，FR-MEM-5 留历史）：事实 version+1 + MemoryRevision
   * 落行 + FTS 刷新 + 新证据补进来源多对多 + 候选转 consolidated（单事务）。
   */
  updateFact(input: {
    factId: string;
    content: string;
    sensitivity: SensitivityLevel;
    reason: string;
    candidateId: string;
    sourceId: string;
  }): { fact: MemoryFactRow; revision: MemoryRevisionRow } {
    this.#assertOpen();
    const now = new Date().toISOString();
    return this.#tx(() => {
      const result = this.#applyFactRevisionInTx(input.factId, input, now);
      this.#setCandidateStatusInTx(input.candidateId, "consolidated");
      return result;
    });
  }

  /** 印证（内容未变）：只补来源关系 + 候选转 consolidated；不推进版本、不落修订 */
  corroborateFact(input: { factId: string; candidateId: string; sourceId: string }): void {
    this.#assertOpen();
    this.#tx(() => {
      this.#insertFactSourceStmt.run(input.factId, input.sourceId);
      this.#setCandidateStatusInTx(input.candidateId, "consolidated");
    });
  }

  /**
   * 同步合并落版本（票 M3-T3 / Issue #32）：与巩固 updateFact 的唯一差别是**版本号由
   * 调用方显式给出**（三方合并结果 = max(本地, 远端) + 1）。版本必须严格前进——
   * 否则说明另一端已经推进过，拒绝写回（合并结果收敛靠这个单调性）。
   */
  applyFactRevision(input: {
    factId: string;
    version: number;
    content: string;
    sensitivity: SensitivityLevel;
    reason: string;
    candidateId: string;
    sourceId: string;
  }): { fact: MemoryFactRow; revision: MemoryRevisionRow } {
    this.#assertOpen();
    if (!Number.isInteger(input.version) || input.version < 2) {
      throw new Error(`merge version must be an integer >= 2, got ${input.version}`);
    }
    const now = new Date().toISOString();
    return this.#tx(() => {
      const current = this.#getFactInTx(input.factId);
      if (current.deleted_at !== null) throw new Error(`fact ${input.factId} is deleted`);
      if (input.version <= current.version) {
        throw new Error(`merge version ${input.version} must advance fact ${input.factId} (current ${current.version})`);
      }
      this.#db
        .prepare(
          "UPDATE memory_facts SET content = ?, sensitivity = ?, version = ?, updated_at = ? WHERE fact_id = ?",
        )
        .run(input.content, input.sensitivity, input.version, now, input.factId);
      const fact = this.#getFactInTx(input.factId);
      const revision: MemoryRevisionRow = {
        revision_id: uuidv7(),
        fact_id: input.factId,
        version: input.version,
        content: input.content,
        sensitivity: input.sensitivity,
        reason: input.reason,
        source_id: input.sourceId,
        created_at: now,
      };
      this.#insertRevisionStmt.run(
        revision.revision_id,
        revision.fact_id,
        revision.version,
        revision.content,
        revision.sensitivity,
        revision.reason,
        revision.source_id,
        revision.created_at,
      );
      this.#deleteFtsEntryStmt.run(input.factId, "fact");
      this.#insertFtsStmt.run(normalizeForFts(fact.content), input.factId, "fact");
      this.#insertFactSourceStmt.run(input.factId, input.sourceId);
      this.#setCandidateStatusInTx(input.candidateId, "consolidated");
      return { fact, revision };
    });
  }

  /**
   * 投影重建落库（票 M3-T3 / Issue #32）：用事件重放快照整体替换 facts / revisions /
   * fact_sources / 事实 FTS。单事务；候选与冲突队列表不动（它们是工作流状态，不是
   * 记忆可见视图）。外键在 node:sqlite 缺省未开启，先删后插不会波及冲突行的 fact_id。
   */
  replaceMemoryProjection(snapshot: MemoryProjectionSnapshot): void {
    this.#assertOpen();
    this.#tx(() => {
      // memory_conflicts 仍引用这些 fact_id（冲突未裁决时事实必须保持存在）。SQLite 的
      // 外键约束在 node:sqlite 下是开启的；先删后插同一主键需把校验推迟到 COMMIT。
      this.#db.exec("PRAGMA defer_foreign_keys = ON");
      this.#db.exec("DELETE FROM memory_fts WHERE entry_kind = 'fact'");
      this.#db.exec("DELETE FROM memory_fact_sources");
      this.#db.exec("DELETE FROM memory_revisions");
      this.#db.exec("DELETE FROM memory_facts");

      const insertSource = this.#db.prepare(
        `INSERT OR IGNORE INTO memory_sources (source_id, kind, event_id, session_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const source of snapshot.sources) {
        insertSource.run(source.source_id, source.kind, source.event_id, source.session_id, source.created_at);
      }
      const insertFact = this.#db.prepare(
        `INSERT INTO memory_facts
           (fact_id, content, kind, sensitivity, version, valid_from, valid_until, created_at, updated_at, deleted_at, scope, expired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const fact of snapshot.facts) {
        insertFact.run(
          fact.fact_id,
          fact.content,
          fact.kind,
          fact.sensitivity,
          fact.version,
          fact.valid_from,
          fact.valid_until,
          fact.created_at,
          fact.updated_at,
          fact.deleted_at,
          fact.scope,
          fact.expired_at,
        );
      }
      const insertRevision = this.#db.prepare(
        `INSERT INTO memory_revisions (revision_id, fact_id, version, content, sensitivity, reason, source_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const revision of snapshot.revisions) {
        insertRevision.run(
          revision.revision_id,
          revision.fact_id,
          revision.version,
          revision.content,
          revision.sensitivity,
          revision.reason,
          revision.source_id,
          revision.created_at,
        );
      }
      const insertFactSource = this.#db.prepare(
        "INSERT OR IGNORE INTO memory_fact_sources (fact_id, source_id) VALUES (?, ?)",
      );
      for (const link of snapshot.factSources) {
        insertFactSource.run(link.fact_id, link.source_id);
      }
      // 检索面与 listFacts 同口径：已删 / 已过期 / 逻辑过期事实不索引
      for (const fact of snapshot.facts) {
        if (fact.deleted_at !== null || fact.valid_until !== null || fact.expired_at !== null) continue;
        this.#insertFtsStmt.run(normalizeForFts(fact.content), fact.fact_id, "fact");
      }
    });
  }

  /** 冲突上报：冲突行落表 + 候选转 conflicted（退出巩固扫描面，进待确认队列） */
  escalateConflict(input: {
    candidateId: string;
    factId: string;
    reason: ConflictReason;
    existingContent: string;
    incomingContent: string;
    existingSensitivity: SensitivityLevel;
    incomingSensitivity: SensitivityLevel;
    sourceId: string;
  }): MemoryConflictRow {
    this.#assertOpen();
    const now = new Date().toISOString();
    return this.#tx(() => {
      const conflict: MemoryConflictRow = {
        conflict_id: uuidv7(),
        candidate_id: input.candidateId,
        fact_id: input.factId,
        reason: input.reason,
        existing_content: input.existingContent,
        incoming_content: input.incomingContent,
        existing_sensitivity: input.existingSensitivity,
        incoming_sensitivity: input.incomingSensitivity,
        source_id: input.sourceId,
        status: "open",
        resolution: null,
        resolved_content: null,
        created_at: now,
        resolved_at: null,
      };
      this.#insertConflictStmt.run(
        conflict.conflict_id,
        conflict.candidate_id,
        conflict.fact_id,
        conflict.reason,
        conflict.existing_content,
        conflict.incoming_content,
        conflict.existing_sensitivity,
        conflict.incoming_sensitivity,
        conflict.source_id,
        conflict.created_at,
      );
      this.#setCandidateStatusInTx(input.candidateId, "conflicted");
      return conflict;
    });
  }

  getConflict(conflictId: string): MemoryConflictRow | null {
    this.#assertOpen();
    const row = this.#getConflictStmt.get(conflictId) as unknown as MemoryConflictRow | undefined;
    return row ?? null;
  }

  /** 冲突列表；status 过滤可选（open = 待确认队列），created_at 升序 */
  listConflicts(
    filter: { status?: "open" | "resolved"; limit?: number; offset?: number } = {},
  ): MemoryConflictRow[] {
    this.#assertOpen();
    const limit = clampLimit(filter.limit);
    const offset = filter.offset === undefined ? 0 : Math.max(0, Math.floor(filter.offset));
    const rows = (
      filter.status === undefined
        ? this.#listConflictsAllStmt.all(limit, offset)
        : this.#listConflictsByStatusStmt.all(filter.status, limit, offset)
    ) as unknown as MemoryConflictRow[];
    return rows;
  }

  /**
   * 裁决落定（单事务）：冲突行关闭 + （keep_new/merge）事实版本+1 留修订 + 候选状态
   * 收尾（keep_new/merge → consolidated，keep_old → dismissed）。factUpdate 为 null
   * 即 keep_old——事实不动，裁决本身只留冲突行与账本事件。
   */
  resolveConflict(input: {
    conflictId: string;
    resolution: ConflictResolution;
    resolvedContent: string | null;
    factUpdate: { content: string; sensitivity: SensitivityLevel; reason: string; sourceId: string } | null;
    candidateStatus: "consolidated" | "dismissed";
  }): { conflict: MemoryConflictRow; fact: MemoryFactRow; revision: MemoryRevisionRow | null } {
    this.#assertOpen();
    const now = new Date().toISOString();
    return this.#tx(() => {
      const conflict = this.#getConflictInTx(input.conflictId);
      const result = this.#resolveConflictStmt.run(input.resolution, input.resolvedContent, now, input.conflictId);
      if (Number(result.changes) !== 1) {
        throw new Error(`conflict ${input.conflictId} is not open`);
      }
      let fact: MemoryFactRow;
      let revision: MemoryRevisionRow | null = null;
      if (input.factUpdate === null) {
        fact = this.#getFactInTx(conflict.fact_id);
      } else {
        const applied = this.#applyFactRevisionInTx(conflict.fact_id, input.factUpdate, now);
        fact = applied.fact;
        revision = applied.revision;
      }
      this.#setCandidateStatusInTx(conflict.candidate_id, input.candidateStatus);
      return { conflict: this.#getConflictInTx(input.conflictId), fact, revision };
    });
  }

  // --- 事务内共用步骤（公开方法各自包 BEGIN/COMMIT）---------------------------

  #applyFactRevisionInTx(
    factId: string,
    input: { content: string; sensitivity: SensitivityLevel; reason: string; sourceId: string },
    now: string,
  ): { fact: MemoryFactRow; revision: MemoryRevisionRow } {
    const current = this.#getFactInTx(factId);
    this.#updateFactStmt.run(input.content, input.sensitivity, now, factId);
    const fact = this.#getFactInTx(factId);
    if (fact.version !== current.version + 1) {
      throw new Error(`fact ${factId} version moved unexpectedly: ${current.version} -> ${fact.version}`);
    }
    const revision: MemoryRevisionRow = {
      revision_id: uuidv7(),
      fact_id: factId,
      version: fact.version,
      content: input.content,
      sensitivity: input.sensitivity,
      reason: input.reason,
      source_id: input.sourceId,
      created_at: now,
    };
    this.#insertRevisionStmt.run(
      revision.revision_id,
      revision.fact_id,
      revision.version,
      revision.content,
      revision.sensitivity,
      revision.reason,
      revision.source_id,
      revision.created_at,
    );
    // FTS 刷新：旧文本出、新文本进（检索面始终跟随版本链头部）；逻辑过期事实不重进索引
    this.#deleteFtsEntryStmt.run(factId, "fact");
    if (fact.expired_at === null) {
      this.#insertFtsStmt.run(normalizeForFts(fact.content), factId, "fact");
    }
    // 本次更新的证据（候选来源）补进事实来源多对多
    this.#insertFactSourceStmt.run(factId, input.sourceId);
    return { fact, revision };
  }

  #setCandidateStatusInTx(candidateId: string, status: CandidateStatus): void {
    this.#setCandidateStatusStmt.run(status, candidateId);
  }

  #getFactInTx(factId: string): MemoryFactRow {
    const row = this.#factByIdStmt.get(factId) as unknown as MemoryFactRow | undefined;
    if (row === undefined) throw new Error(`fact ${factId} does not exist`);
    return row;
  }

  #getCandidateInTx(candidateId: string): (MemoryCandidateRow & { source_event_id: string }) | null {
    return (this.#candidateByIdStmt.get(candidateId) as unknown as
      | (MemoryCandidateRow & { source_event_id: string })
      | undefined) ?? null;
  }

  #getConflictInTx(conflictId: string): MemoryConflictRow {
    const row = this.#getConflictStmt.get(conflictId) as unknown as MemoryConflictRow | undefined;
    if (row === undefined) throw new Error(`conflict ${conflictId} does not exist`);
    return row;
  }

  #tx<T>(fn: () => T): T {
    this.#exec("BEGIN");
    try {
      const out = fn();
      this.#exec("COMMIT");
      return out;
    } catch (err) {
      this.#exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * FTS5 关键词检索：候选与事实统一索引，按相关度（rank）返回、上限 50；命中条目
   * 回链全部来源事件 id。
   *
   * options.sensitivity 在**检索层**过滤（M4-T6 / Issue #43）：可信联系人记忆引用
   * 只允许 sensitivity=public，private/locked 不进入结果集（不是返回后再由 UI 筛）。
   *
   * options.scope（票 M7-A-T3 / ADR-0010）：作用域在检索层过滤——
   *   "owner"（缺省）只看长期记忆池（全局），临时会话写入不可见；
   *   "session:<id>" = 全局（owner）+ 该会话，兑现「临时会话只读全局」。
   * 逻辑过期（expired_at 非空）条目已在 #candidateHit/#factHit 出口剔除。
   */
  search(q: string, options: { sensitivity?: SensitivityLevel; scope?: string } = {}): MemorySearchHit[] {
    this.#assertOpen();
    const query = buildFtsQuery(q);
    const rows = this.#ftsScanStmt.all(query) as unknown as FtsRow[];
    const queryScope = options.scope ?? "owner";
    const hits: MemorySearchHit[] = [];
    for (const row of rows) {
      if (row.entry_kind === "candidate") {
        const hit = this.#candidateHit(row.entry_id);
        if (
          hit !== null &&
          scopeVisible(hit.scope, queryScope) &&
          (options.sensitivity === undefined || hit.sensitivity === options.sensitivity)
        ) {
          hits.push(hit);
        }
      } else if (row.entry_kind === "fact") {
        const hit = this.#factHit(row.entry_id);
        if (
          hit !== null &&
          scopeVisible(hit.scope, queryScope) &&
          (options.sensitivity === undefined || hit.sensitivity === options.sensitivity)
        ) {
          hits.push(hit);
        }
      }
    }
    return hits;
  }

  /**
   * 提升为长期记忆（票 M7-A-T3）：把候选或事实的 scope 改写为 owner（行内事务）。
   * 只做行变更，作用域合法性（必须 session:*）由服务层判定；未知 id 返回 null。
   */
  promoteToOwner(entryId: string): { stage: "candidate" | "fact"; from_scope: string } | null {
    this.#assertOpen();
    return this.#tx(() => {
      const candidate = this.#getCandidateInTx(entryId);
      if (candidate !== null) {
        this.#promoteCandidateStmt.run(entryId);
        return { stage: "candidate" as const, from_scope: candidate.scope };
      }
      const fact = this.getFact(entryId);
      if (fact !== null) {
        this.#promoteFactStmt.run(entryId);
        return { stage: "fact" as const, from_scope: fact.scope };
      }
      return null;
    });
  }

  /**
   * 临时会话 24h 到期的逻辑清理（票 M7-A-T3 / ADR-0010）：把该作用域的候选与事实
   * 标记 expired_at 并从 FTS 移除（检索面立即退出）；行与来源/修订/账本事件全部保留
   * （append-only 审计）。返回被清理的 id 清单（事实 id 供投影文件移除）。
   */
  expireScope(scope: string, expiredAt: string): { candidateIds: string[]; factIds: string[] } {
    this.#assertOpen();
    return this.#tx(() => {
      const candidateIds = (this.#candidateIdsByScopeStmt.all(scope) as unknown as Array<{ candidate_id: string }>).map(
        (row) => row.candidate_id,
      );
      const factIds = (this.#factIdsByScopeStmt.all(scope) as unknown as Array<{ fact_id: string }>).map((row) => row.fact_id);
      for (const candidateId of candidateIds) {
        this.#expireCandidateStmt.run(expiredAt, candidateId);
        this.#deleteFtsEntryStmt.run(candidateId, "candidate");
      }
      for (const factId of factIds) {
        this.#expireFactStmt.run(expiredAt, factId);
        this.#deleteFtsEntryStmt.run(factId, "fact");
      }
      return { candidateIds, factIds };
    });
  }

  #candidateHit(candidateId: string): MemorySearchHit | null {
    const row = this.#candidateByIdStmt.get(candidateId) as unknown as
      | (MemoryCandidateRow & { source_id: string })
      | undefined;
    if (row === undefined || row.expired_at !== null) return null;
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
      scope: row.scope,
      created_at: row.created_at,
    };
  }

  #factHit(factId: string): MemorySearchHit | null {
    const row = this.#factByIdStmt.get(factId) as unknown as MemoryFactRow | undefined;
    if (row === undefined || row.expired_at !== null) return null;
    const sourceRows = this.#factSourcesStmt.all(factId) as unknown as Array<{ event_id: string }>;
    return {
      id: row.fact_id,
      stage: "fact",
      type: row.kind,
      content: row.content,
      sensitivity: row.sensitivity,
      version: row.version,
      sources: sourceRows.map((s) => s.event_id),
      scope: row.scope,
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
