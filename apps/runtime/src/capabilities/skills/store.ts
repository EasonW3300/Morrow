import { join } from "node:path";
import { DB_FILE_NAME } from "../../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../../db.ts";

/**
 * Skill 存储（票 M2-T5 / Issue #26）：skills / skill_cases 两表的纯持久化层。
 * 行是权威状态，skill.* 账本事件是审计投影（行先于事件落库，CapabilityStore 同款口径）。
 * 与账本同库（events.sqlite）。
 *
 *   skills       Skill 定义与提案状态（name 唯一；steps 为声明式组合 JSON——只引用
 *                capability id + 参数映射，不生成新代码，GLOSSARY Skill 口径）
 *   skill_cases  能力调用成功/失败案例（来源 tool.finished 账本事件；source_event 唯一
 *                ——账本重放/重启回填幂等）
 */

export interface SkillRow {
  skill_id: string;
  name: string;
  title: string;
  description: string;
  /** 声明式组合 canonical JSON：[{capability_id, arg_mapping}] */
  steps_json: string;
  /** proposed | approved | rejected */
  status: string;
  /** auto（案例晋升）| manual（Owner/Agent 显式提案） */
  origin: string;
  /** 源数据 JSON：composition_key、success_count、missing_capabilities、reason */
  source_json: string;
  created_at: string;
  updated_at: string;
}

export interface SkillCaseRow {
  case_id: string;
  capability: string;
  outcome: string;
  source_event: string;
  session_id: string | null;
  occurred_at: string;
}

export interface InsertSkillInput {
  skill_id: string;
  name: string;
  title: string;
  description: string;
  steps_json: string;
  status: string;
  origin: string;
  source_json: string;
  created_at: string;
  updated_at: string;
}

export interface InsertCaseInput {
  case_id: string;
  capability: string;
  outcome: string;
  source_event: string;
  session_id: string | null;
  occurred_at: string;
}

export class SkillStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertSkillStmt;
  #getSkillStmt;
  #getSkillByNameStmt;
  #listSkillsStmt;
  #updateSkillStatusStmt;
  #updateSkillSourceStmt;
  #insertCaseStmt;
  #listCasesStmt;
  #listCasesByCapabilityStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        skill_id    TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        steps_json  TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
        origin      TEXT NOT NULL CHECK (origin IN ('auto', 'manual')),
        source_json TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_cases (
        case_id      TEXT PRIMARY KEY,
        capability   TEXT NOT NULL,
        outcome      TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        source_event TEXT NOT NULL UNIQUE,
        session_id   TEXT,
        occurred_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skill_cases_capability_idx ON skill_cases (capability, occurred_at);
    `);
    this.#insertSkillStmt = db.prepare(
      `INSERT INTO skills (skill_id, name, title, description, steps_json, status, origin, source_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#getSkillStmt = db.prepare(
      `SELECT skill_id, name, title, description, steps_json, status, origin, source_json, created_at, updated_at
       FROM skills WHERE skill_id = ?`,
    );
    this.#getSkillByNameStmt = db.prepare(
      `SELECT skill_id, name, title, description, steps_json, status, origin, source_json, created_at, updated_at
       FROM skills WHERE name = ?`,
    );
    this.#listSkillsStmt = db.prepare(
      `SELECT skill_id, name, title, description, steps_json, status, origin, source_json, created_at, updated_at
       FROM skills ORDER BY created_at, name`,
    );
    this.#updateSkillStatusStmt = db.prepare("UPDATE skills SET status = ?, updated_at = ? WHERE skill_id = ?");
    this.#updateSkillSourceStmt = db.prepare("UPDATE skills SET source_json = ?, updated_at = ? WHERE skill_id = ?");
    this.#insertCaseStmt = db.prepare(
      `INSERT INTO skill_cases (case_id, capability, outcome, source_event, session_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_event) DO NOTHING`,
    );
    this.#listCasesStmt = db.prepare(
      `SELECT case_id, capability, outcome, source_event, session_id, occurred_at
       FROM skill_cases ORDER BY rowid`,
    );
    this.#listCasesByCapabilityStmt = db.prepare(
      `SELECT case_id, capability, outcome, source_event, session_id, occurred_at
       FROM skill_cases WHERE capability = ? ORDER BY rowid`,
    );
  }

  static open(dataDir: string): SkillStore {
    return new SkillStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  insertSkill(input: InsertSkillInput): void {
    this.#assertOpen();
    this.#insertSkillStmt.run(
      input.skill_id,
      input.name,
      input.title,
      input.description,
      input.steps_json,
      input.status,
      input.origin,
      input.source_json,
      input.created_at,
      input.updated_at,
    );
  }

  getSkill(skillId: string): SkillRow | null {
    this.#assertOpen();
    const row = this.#getSkillStmt.get(skillId) as unknown as SkillRow | undefined;
    return row ?? null;
  }

  getSkillByName(name: string): SkillRow | null {
    this.#assertOpen();
    const row = this.#getSkillByNameStmt.get(name) as unknown as SkillRow | undefined;
    return row ?? null;
  }

  listSkills(): SkillRow[] {
    this.#assertOpen();
    return this.#listSkillsStmt.all() as unknown as SkillRow[];
  }

  setSkillStatus(skillId: string, status: string, updatedAt: string): void {
    this.#assertOpen();
    this.#updateSkillStatusStmt.run(status, updatedAt, skillId);
  }

  setSkillSource(skillId: string, sourceJson: string, updatedAt: string): void {
    this.#assertOpen();
    this.#updateSkillSourceStmt.run(sourceJson, updatedAt, skillId);
  }

  /** 写案例；source_event 已存在时无操作（返回 false——账本重放幂等） */
  insertCase(input: InsertCaseInput): boolean {
    this.#assertOpen();
    const result = this.#insertCaseStmt.run(
      input.case_id,
      input.capability,
      input.outcome,
      input.source_event,
      input.session_id,
      input.occurred_at,
    );
    return Number(result.changes) > 0;
  }

  listCases(filter: { capability?: string } = {}): SkillCaseRow[] {
    this.#assertOpen();
    if (filter.capability !== undefined) {
      return this.#listCasesByCapabilityStmt.all(filter.capability) as unknown as SkillCaseRow[];
    }
    return this.#listCasesStmt.all() as unknown as SkillCaseRow[];
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("skill store is closed");
  }
}
