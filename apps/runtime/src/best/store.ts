/**
 * Best 模式的持久化与生命周期（票 M7-C-T6 / Issue #80）。
 *
 * 落表（`best_runs`）而非内存：Best 会建分支、写文件、跑很久——重启后"我有一份
 * 半成品规格和一轮访谈记录"必须能找回来。这与 Plan（一次性只读研究，重启即弃）
 * 不同。
 *
 * 承载方式：每个 Best run 关联一个 Thread Goal（objective = 想法原文），预算与状态
 * 全部复用 C4/C5。这样 Best 不需要自己的一套"长跑"机制。
 */

import { join } from "node:path";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import type { BestStage, BestStatus, InterviewQuestion } from "./stage.ts";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS best_runs (
  best_id        TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  goal_id        TEXT,
  idea           TEXT NOT NULL,
  stage          TEXT NOT NULL,
  status         TEXT NOT NULL,
  slug           TEXT,
  interview_json TEXT NOT NULL DEFAULT '[]',
  spec_markdown  TEXT,
  spec_path      TEXT,
  tickets_json   TEXT NOT NULL DEFAULT '[]',
  branch         TEXT,
  workspace_path TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
`;

/** 访谈记录条目 */
export interface InterviewExchange {
  question: InterviewQuestion;
  answer: string;
  asked_at: string;
  answered_at: string;
}

/** 一条 Best 运行 */
export interface BestRunRecord {
  best_id: string;
  session_id: string;
  /** 承载它的 Thread Goal（id） */
  goal_id: string | null;
  /** 用户给的那个想法（原话） */
  idea: string;
  stage: BestStage;
  status: BestStatus;
  /** 规格文件名与分支名用的 slug */
  slug: string | null;
  interview: InterviewExchange[];
  /** 规格 Markdown（成稿后） */
  spec_markdown: string | null;
  /** 规格文件落盘路径（相对工作区） */
  spec_path: string | null;
  /** 拆出的票（C7 用） */
  tickets: Array<{ title: string; what_to_build: string; blocked_by: string[]; criteria: string[] }>;
  /** 实现分支（C7 用） */
  branch: string | null;
  workspace_path: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface BestRow {
  best_id: string;
  session_id: string;
  goal_id: string | null;
  idea: string;
  stage: string;
  status: string;
  slug: string | null;
  interview_json: string;
  spec_markdown: string | null;
  spec_path: string | null;
  tickets_json: string;
  branch: string | null;
  workspace_path: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function project(row: BestRow): BestRunRecord {
  return {
    best_id: row.best_id,
    session_id: row.session_id,
    goal_id: row.goal_id,
    idea: row.idea,
    stage: row.stage as BestStage,
    status: row.status as BestStatus,
    slug: row.slug,
    interview: JSON.parse(row.interview_json) as InterviewExchange[],
    spec_markdown: row.spec_markdown,
    spec_path: row.spec_path,
    tickets: JSON.parse(row.tickets_json) as BestRunRecord["tickets"],
    branch: row.branch,
    workspace_path: row.workspace_path,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class BestStore {
  readonly #db: SqliteDatabase;
  readonly #ownsConnection: boolean;

  constructor(options: { dataDir?: string; db?: SqliteDatabase } = {}) {
    if (options.db !== undefined) {
      this.#db = options.db;
      this.#ownsConnection = false;
    } else {
      if (options.dataDir === undefined) throw new Error("BestStore requires dataDir or db");
      this.#db = openSqlite(join(options.dataDir, DB_FILE_NAME));
      this.#ownsConnection = true;
    }
    this.#db.exec(CREATE_SQL);
  }

  get(bestId: string): BestRunRecord | null {
    const row = this.#db.prepare("SELECT * FROM best_runs WHERE best_id = ?").get(bestId) as BestRow | undefined;
    return row === undefined ? null : project(row);
  }

  /** 会话上仍在跑的 Best（running / awaiting_gate） */
  activeForSession(sessionId: string): BestRunRecord | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM best_runs WHERE session_id = ? AND status IN ('running','awaiting_gate') ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId) as BestRow | undefined;
    return row === undefined ? null : project(row);
  }

  list(options: { sessionId?: string } = {}): BestRunRecord[] {
    const rows =
      options.sessionId === undefined
        ? (this.#db.prepare("SELECT * FROM best_runs ORDER BY created_at DESC").all() as BestRow[])
        : (this.#db.prepare("SELECT * FROM best_runs WHERE session_id = ? ORDER BY created_at DESC").all(options.sessionId) as BestRow[]);
    return rows.map(project);
  }

  insert(record: BestRunRecord): void {
    this.#db
      .prepare(
        `INSERT INTO best_runs (
          best_id, session_id, goal_id, idea, stage, status, slug, interview_json,
          spec_markdown, spec_path, tickets_json, branch, workspace_path, last_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.best_id,
        record.session_id,
        record.goal_id,
        record.idea,
        record.stage,
        record.status,
        record.slug,
        JSON.stringify(record.interview),
        record.spec_markdown,
        record.spec_path,
        JSON.stringify(record.tickets),
        record.branch,
        record.workspace_path,
        record.last_error,
        record.created_at,
        record.updated_at,
      );
  }

  update(bestId: string, patch: Partial<Omit<BestRunRecord, "best_id" | "created_at">>, now: string): BestRunRecord | null {
    const existing = this.get(bestId);
    if (existing === null) return null;
    const merged = { ...existing, ...patch, updated_at: now };
    this.#db
      .prepare(
        `UPDATE best_runs SET
          goal_id = ?, stage = ?, status = ?, slug = ?, interview_json = ?, spec_markdown = ?,
          spec_path = ?, tickets_json = ?, branch = ?, workspace_path = ?, last_error = ?, updated_at = ?
         WHERE best_id = ?`,
      )
      .run(
        merged.goal_id,
        merged.stage,
        merged.status,
        merged.slug,
        JSON.stringify(merged.interview),
        merged.spec_markdown,
        merged.spec_path,
        JSON.stringify(merged.tickets),
        merged.branch,
        merged.workspace_path,
        merged.last_error,
        now,
        bestId,
      );
    return this.get(bestId);
  }

  close(): void {
    if (this.#ownsConnection) this.#db.close();
  }
}
