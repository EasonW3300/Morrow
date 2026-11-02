/**
 * 工厂请求存储（票 M2-T3 / Issue #24）：capability_factory_requests 单表持久化层。
 * 行是权威状态（CapabilityStore 同款口径：行先于事件落库）；factory_* 账本事件是
 * 审计投影。与账本同库（DB_FILE_NAME），M2 量级单副本。
 */

import { join } from "node:path";
import { DB_FILE_NAME } from "../../ledger.ts";
import { openSqlite, type SqliteDatabase, type SqliteStatement } from "../../db.ts";

export interface FactoryRequestRow {
  request_id: string;
  description: string;
  status: string;
  stage: string;
  /** 检索阶段摘要 JSON：{reused, matches, memory_hits, considered} */
  retrieved_json: string | null;
  /** ValidatedPlan JSON（manifest + description + dependencies + source + testCases） */
  plan_json: string | null;
  /** VerifyReport JSON */
  report_json: string | null;
  /** FactoryRequestError JSON */
  error_json: string | null;
  capability_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertFactoryRequestInput {
  request_id: string;
  description: string;
  status: string;
  stage: string;
  created_at: string;
  updated_at: string;
}

export interface UpdateFactoryRequestInput {
  status?: string;
  stage?: string;
  retrieved_json?: string | null;
  plan_json?: string | null;
  report_json?: string | null;
  error_json?: string | null;
  capability_name?: string | null;
  updated_at: string;
}

export class CapabilityFactoryStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertStmt: SqliteStatement;
  #getStmt: SqliteStatement;
  #updateStmt: SqliteStatement;
  #confirmedPlansStmt: SqliteStatement;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS capability_factory_requests (
        request_id      TEXT PRIMARY KEY,
        description     TEXT NOT NULL,
        status          TEXT NOT NULL,
        stage           TEXT NOT NULL,
        retrieved_json  TEXT,
        plan_json       TEXT,
        report_json     TEXT,
        error_json      TEXT,
        capability_name TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS capability_factory_requests_status_idx
        ON capability_factory_requests (status);
    `);
    this.#insertStmt = db.prepare(
      `INSERT INTO capability_factory_requests (request_id, description, status, stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.#getStmt = db.prepare(
      `SELECT request_id, description, status, stage, retrieved_json, plan_json, report_json, error_json, capability_name, created_at, updated_at
       FROM capability_factory_requests WHERE request_id = ?`,
    );
    this.#updateStmt = db.prepare(
      `UPDATE capability_factory_requests SET
         status = COALESCE(?, status),
         stage = COALESCE(?, stage),
         retrieved_json = CASE WHEN ? THEN ? ELSE retrieved_json END,
         plan_json = CASE WHEN ? THEN ? ELSE plan_json END,
         report_json = CASE WHEN ? THEN ? ELSE report_json END,
         error_json = CASE WHEN ? THEN ? ELSE error_json END,
         capability_name = CASE WHEN ? THEN ? ELSE capability_name END,
         updated_at = ?
       WHERE request_id = ?`,
    );
    this.#confirmedPlansStmt = db.prepare(
      `SELECT plan_json FROM capability_factory_requests WHERE status = 'confirmed' ORDER BY updated_at DESC LIMIT 500`,
    );
  }

  static open(dataDir: string): CapabilityFactoryStore {
    return new CapabilityFactoryStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  insert(input: InsertFactoryRequestInput): void {
    this.#assertOpen();
    this.#insertStmt.run(input.request_id, input.description, input.status, input.stage, input.created_at, input.updated_at);
  }

  get(requestId: string): FactoryRequestRow | null {
    this.#assertOpen();
    const row = this.#getStmt.get(requestId) as FactoryRequestRow | undefined;
    return row ?? null;
  }

  update(requestId: string, fields: UpdateFactoryRequestInput): void {
    this.#assertOpen();
    this.#updateStmt.run(
      fields.status ?? null,
      fields.stage ?? null,
      fields.retrieved_json !== undefined ? 1 : 0,
      fields.retrieved_json ?? null,
      fields.plan_json !== undefined ? 1 : 0,
      fields.plan_json ?? null,
      fields.report_json !== undefined ? 1 : 0,
      fields.report_json ?? null,
      fields.error_json !== undefined ? 1 : 0,
      fields.error_json ?? null,
      fields.capability_name !== undefined ? 1 : 0,
      fields.capability_name ?? null,
      fields.updated_at,
      requestId,
    );
  }

  /** 已确认请求的能力描述索引（FR-CAP-1 检索源；proposed 未注册不入索引） */
  listConfirmedDescriptions(): Array<{ name: string; description: string | null }> {
    this.#assertOpen();
    const out: Array<{ name: string; description: string | null }> = [];
    for (const row of this.#confirmedPlansStmt.all() as Array<{ plan_json: string }>) {
      try {
        const plan = JSON.parse(row.plan_json) as { manifest?: { name?: string }; description?: string };
        if (typeof plan.manifest?.name === "string") {
          out.push({ name: plan.manifest.name, description: typeof plan.description === "string" ? plan.description : null });
        }
      } catch {
        // 计划 JSON 损坏不阻断检索
      }
    }
    return out;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("capability factory store is closed");
  }
}
