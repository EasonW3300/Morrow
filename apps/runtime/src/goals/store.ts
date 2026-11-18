/**
 * Thread Goal 的持久化与生命周期（票 M7-C-T4 / Issue #78）。
 *
 * 与任务/渠道/提案同库（`events.sqlite`，独立连接，WAL）：`thread_goals` 是**可变投影**
 * （状态会迁移、用量会累加），审计历史仍在账本（`goal.*` 事件）。
 *
 * 为什么 Goal 要落表而 Plan/Best 状态不落：Plan/Best 是"这一次工作怎么进行的"，
 * 重启即失效是合理的；Goal 是"我要它跨重启继续做这件事"——不落表就没意义了。
 */

import { join } from "node:path";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import type { GoalStatus } from "./state.ts";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS thread_goals (
  goal_id          TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  objective        TEXT NOT NULL,
  status           TEXT NOT NULL,
  token_limit      INTEGER,
  time_limit_ms    INTEGER,
  tokens           INTEGER NOT NULL DEFAULT 0,
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  elapsed_ms       INTEGER NOT NULL DEFAULT 0,
  runs             INTEGER NOT NULL DEFAULT 0,
  blocked_streak   INTEGER NOT NULL DEFAULT 0,
  blocked_signature TEXT,
  last_error       TEXT,
  best_slug        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_goals_session ON thread_goals (session_id, status);
`;

/** 一条 Goal 的完整记录 */
export interface GoalRecord {
  goal_id: string;
  session_id: string;
  /** 用户的原话（Best 模式下是那个想法） */
  objective: string;
  status: GoalStatus;
  token_limit: number | null;
  time_limit_ms: number | null;
  tokens: number;
  tokens_estimated: boolean;
  elapsed_ms: number;
  runs: number;
  /** 连续同一阻塞的次数（C5 用来判 blocked） */
  blocked_streak: number;
  /** 上一次失败的错误签名（归一化后） */
  blocked_signature: string | null;
  last_error: string | null;
  /** Best 模式用：关联的 slug（规格文件名/分支名） */
  best_slug: string | null;
  created_at: string;
  updated_at: string;
}

interface GoalRow {
  goal_id: string;
  session_id: string;
  objective: string;
  status: string;
  token_limit: number | null;
  time_limit_ms: number | null;
  tokens: number;
  tokens_estimated: number;
  elapsed_ms: number;
  runs: number;
  blocked_streak: number;
  blocked_signature: string | null;
  last_error: string | null;
  best_slug: string | null;
  created_at: string;
  updated_at: string;
}

function project(row: GoalRow): GoalRecord {
  return {
    goal_id: row.goal_id,
    session_id: row.session_id,
    objective: row.objective,
    status: row.status as GoalStatus,
    token_limit: row.token_limit,
    time_limit_ms: row.time_limit_ms,
    tokens: row.tokens,
    tokens_estimated: row.tokens_estimated === 1,
    elapsed_ms: row.elapsed_ms,
    runs: row.runs,
    blocked_streak: row.blocked_streak,
    blocked_signature: row.blocked_signature,
    last_error: row.last_error,
    best_slug: row.best_slug,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 未完成状态集合（"每会话至多一个"的判定口径） */
export const OPEN_GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
];

export class GoalStore {
  readonly #db: SqliteDatabase;
  readonly #ownsConnection: boolean;

  constructor(options: { dataDir?: string; db?: SqliteDatabase } = {}) {
    if (options.db !== undefined) {
      this.#db = options.db;
      this.#ownsConnection = false;
    } else {
      if (options.dataDir === undefined) throw new Error("GoalStore requires dataDir or db");
      this.#db = openSqlite(join(options.dataDir, DB_FILE_NAME));
      this.#ownsConnection = true;
    }
    this.#db.exec(CREATE_SQL);
  }

  get(goalId: string): GoalRecord | null {
    const row = this.#db.prepare("SELECT * FROM thread_goals WHERE goal_id = ?").get(goalId) as
      | GoalRow
      | undefined;
    return row === undefined ? null : project(row);
  }

  list(options: { sessionId?: string; status?: GoalStatus } = {}): GoalRecord[] {
    if (options.sessionId !== undefined && options.status !== undefined) {
      return (
        this.#db
          .prepare("SELECT * FROM thread_goals WHERE session_id = ? AND status = ? ORDER BY created_at DESC")
          .all(options.sessionId, options.status) as GoalRow[]
      ).map(project);
    }
    if (options.sessionId !== undefined) {
      return (
        this.#db
          .prepare("SELECT * FROM thread_goals WHERE session_id = ? ORDER BY created_at DESC")
          .all(options.sessionId) as GoalRow[]
      ).map(project);
    }
    if (options.status !== undefined) {
      return (
        this.#db.prepare("SELECT * FROM thread_goals WHERE status = ? ORDER BY created_at DESC").all(options.status) as GoalRow[]
      ).map(project);
    }
    return (this.#db.prepare("SELECT * FROM thread_goals ORDER BY created_at DESC").all() as GoalRow[]).map(project);
  }

  /** 该会话当前未完成的 goal（至多一个；有多个时取最新的——防御旧数据） */
  openForSession(sessionId: string): GoalRecord | null {
    const placeholders = OPEN_GOAL_STATUSES.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT * FROM thread_goals WHERE session_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
      )
      .all(sessionId, ...OPEN_GOAL_STATUSES) as GoalRow[];
    return rows.length === 0 ? null : project(rows[0]);
  }

  /** 所有可被续跑的 goal（active 且会话仍开着——会话状态由服务层再判） */
  activeGoals(): GoalRecord[] {
    return this.list({ status: "active" });
  }

  insert(record: GoalRecord): void {
    this.#db
      .prepare(
        `INSERT INTO thread_goals (
          goal_id, session_id, objective, status, token_limit, time_limit_ms,
          tokens, tokens_estimated, elapsed_ms, runs, blocked_streak, blocked_signature,
          last_error, best_slug, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.goal_id,
        record.session_id,
        record.objective,
        record.status,
        record.token_limit,
        record.time_limit_ms,
        record.tokens,
        record.tokens_estimated ? 1 : 0,
        record.elapsed_ms,
        record.runs,
        record.blocked_streak,
        record.blocked_signature,
        record.last_error,
        record.best_slug,
        record.created_at,
        record.updated_at,
      );
  }

  update(
    goalId: string,
    patch: {
      status?: GoalStatus;
      tokens?: number;
      tokens_estimated?: boolean;
      elapsed_ms?: number;
      runs?: number;
      blocked_streak?: number;
      blocked_signature?: string | null;
      last_error?: string | null;
      token_limit?: number | null;
      best_slug?: string | null;
    },
    now: string,
  ): GoalRecord | null {
    const existing = this.get(goalId);
    if (existing === null) return null;
    this.#db
      .prepare(
        `UPDATE thread_goals SET
          status = ?, tokens = ?, tokens_estimated = ?, elapsed_ms = ?, runs = ?,
          blocked_streak = ?, blocked_signature = ?, last_error = ?, token_limit = ?,
          best_slug = ?, updated_at = ?
         WHERE goal_id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.tokens ?? existing.tokens,
        (patch.tokens_estimated ?? existing.tokens_estimated) ? 1 : 0,
        patch.elapsed_ms ?? existing.elapsed_ms,
        patch.runs ?? existing.runs,
        patch.blocked_streak ?? existing.blocked_streak,
        patch.blocked_signature === undefined ? existing.blocked_signature : patch.blocked_signature,
        patch.last_error === undefined ? existing.last_error : patch.last_error,
        patch.token_limit === undefined ? existing.token_limit : patch.token_limit,
        patch.best_slug === undefined ? existing.best_slug : patch.best_slug,
        now,
        goalId,
      );
    return this.get(goalId);
  }

  close(): void {
    if (this.#ownsConnection) this.#db.close();
  }
}
