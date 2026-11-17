/**
 * Thread Goal 服务（票 M7-C-T4 / Issue #78，FR-C6..C9）。
 *
 * 四条不可让的约束：
 *
 * 1. **显式创建 + 需确认**：只有 HTTP 端点能建 goal（模型侧没有 `create_goal` 工具），
 *    且要确认 objective 与预算。一道"确认"挡住"一句话就开了个烧钱的循环"。
 * 2. **每会话至多一个未完成**：重复创建 409。多个 goal 会互相抢预算，也让"它现在在
 *    做什么"无法回答。
 * 3. **非法迁移一律拒绝**（由 state.ts 的迁移表判定），报当前态与目标态。
 * 4. **预算达到即停**：任一维达到上限 → `budget_limited` + 审计，不再续跑。
 *
 * 事件族：`goal.created` / `goal.updated` / `goal.budget_exceeded` /
 * `goal.usage_limited` / `goal.completed`。
 */

import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { uuidv7 } from "../uuid-v7.ts";
import {
  GoalTransitionError,
  addGoalUsage,
  canTransition,
  checkBudget,
  normalizeBudget,
  type GoalStatus,
} from "./state.ts";
import { GoalStore, type GoalRecord } from "./store.ts";

export const GOAL_EVENT_TYPES = {
  created: "goal.created",
  updated: "goal.updated",
  budgetExceeded: "goal.budget_exceeded",
  usageLimited: "goal.usage_limited",
  completed: "goal.completed",
} as const;

export class GoalError extends Error {
  readonly code:
    | "invalid_input"
    | "goal_already_open"
    | "not_found"
    | "invalid_transition"
    | "session_not_executable"
    | "ephemeral_session"
    | "planner_unavailable";
  constructor(code: GoalError["code"], message: string) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

export interface GoalServiceDeps {
  store: GoalStore;
  ledger: EventLedger;
  replicaId: string;
  /** 会话可执行（存在、未关闭、未删除） */
  isSessionExecutable(sessionId: string): boolean;
  /** 会话类型（临时会话禁用 Goal） */
  sessionKind(sessionId: string): "normal" | "ephemeral" | null;
  /** 会话累计用量（C1 的 usageOf；每次运行后由调用方推进） */
  sessionUsage(sessionId: string): { total: number; estimated: boolean };
  now?: () => Date;
}

export class GoalService {
  readonly #deps: GoalServiceDeps;
  readonly #now: () => Date;

  constructor(deps: GoalServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * 创建 goal。
   *
   * `confirm !== true` → 拒绝。这不是形式主义：goal 会自动续跑并烧预算，创建它的
   * 动作必须有明确的人工意图（FR-C7「create_goal 仅显式发起」）。
   */
  create(input: {
    sessionId: string;
    objective: string;
    tokenLimit?: unknown;
    timeLimitMs?: unknown;
    confirm?: boolean;
    /** Best 模式内部创建时带上 slug */
    bestSlug?: string;
  }): GoalRecord {
    if (input.confirm !== true) {
      throw new GoalError(
        "invalid_input",
        "creating a goal requires confirm=true (goals auto-resume and consume budget)",
      );
    }
    if (typeof input.objective !== "string" || input.objective.trim().length === 0) {
      throw new GoalError("invalid_input", "objective must be a non-empty string");
    }
    if (!this.#deps.isSessionExecutable(input.sessionId)) {
      throw new GoalError("session_not_executable", `session ${input.sessionId} is not executable`);
    }
    if (this.#deps.sessionKind(input.sessionId) === "ephemeral") {
      throw new GoalError(
        "ephemeral_session",
        "goals are disabled in ephemeral sessions (ephemeral sessions are one-off and do not accumulate)",
      );
    }
    const open = this.#deps.store.openForSession(input.sessionId);
    if (open !== null) {
      throw new GoalError(
        "goal_already_open",
        `session ${input.sessionId} already has an open goal (${open.goal_id}, status ${open.status}); complete or pause it first`,
      );
    }

    const now = this.#now().toISOString();
    const budget = normalizeBudget({ token_limit: input.tokenLimit, time_limit_ms: input.timeLimitMs });
    const record: GoalRecord = {
      goal_id: uuidv7(),
      session_id: input.sessionId,
      objective: input.objective.trim(),
      status: "active",
      token_limit: budget.token_limit,
      time_limit_ms: budget.time_limit_ms,
      tokens: 0,
      tokens_estimated: false,
      elapsed_ms: 0,
      runs: 0,
      blocked_streak: 0,
      blocked_signature: null,
      last_error: null,
      best_slug: input.bestSlug ?? null,
      created_at: now,
      updated_at: now,
    };
    this.#deps.store.insert(record);
    this.#append(GOAL_EVENT_TYPES.created, record.session_id, {
      goal_id: record.goal_id,
      objective: record.objective,
      token_limit: record.token_limit,
      time_limit_ms: record.time_limit_ms,
      ...(record.best_slug === null ? {} : { best_slug: record.best_slug }),
    });
    return record;
  }

  get(goalId: string): GoalRecord | null {
    return this.#deps.store.get(goalId);
  }

  list(options: { sessionId?: string; status?: GoalStatus } = {}): GoalRecord[] {
    return this.#deps.store.list(options);
  }

  /** 该会话当前未完成的 goal */
  openForSession(sessionId: string): GoalRecord | null {
    return this.#deps.store.openForSession(sessionId);
  }

  /** 暂停 */
  pause(goalId: string): GoalRecord {
    return this.#transition(goalId, "paused");
  }

  /**
   * 恢复。
   *
   * `budget_limited` 的恢复允许**同时提高预算**——否则恢复后立刻又超限，
   * 这个状态就成了死胡同。
   */
  resume(goalId: string, options: { tokenLimit?: unknown } = {}): GoalRecord {
    const existing = this.#deps.store.get(goalId);
    if (existing === null) throw new GoalError("not_found", `goal ${goalId} does not exist`);
    const patch: { token_limit?: number | null } = {};
    if (options.tokenLimit !== undefined) {
      const normalized = normalizeBudget({ token_limit: options.tokenLimit });
      patch.token_limit = normalized.token_limit;
    }
    if (Object.keys(patch).length > 0) {
      this.#deps.store.update(goalId, patch, this.#now().toISOString());
    }
    return this.#transition(goalId, "active");
  }

  /** 完成（终态） */
  complete(goalId: string, options: { reason?: string } = {}): GoalRecord {
    const updated = this.#transition(goalId, "complete");
    this.#append(GOAL_EVENT_TYPES.completed, updated.session_id, {
      goal_id: goalId,
      runs: updated.runs,
      tokens: updated.tokens,
      tokens_estimated: updated.tokens_estimated,
      elapsed_ms: updated.elapsed_ms,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    return updated;
  }

  /**
   * 记录一轮运行的结果并做预算判定（C5 的续跑器每轮调用一次）。
   *
   * 顺序很重要：先累加用量，再判预算，再决定状态。反过来的话"这一轮刚好用尽"
   * 会漏判。`error` 非空时推进阻塞计数（C5 用它判 blocked）。
   */
  recordRun(input: {
    goalId: string;
    error: string | null;
    /** 本轮耗时毫秒（调用方测量） */
    elapsedMs: number;
  }): {
    goal: GoalRecord;
    budget: ReturnType<typeof checkBudget>;
    statusChanged: boolean;
  } {
    const existing = this.#deps.store.get(input.goalId);
    if (existing === null) throw new GoalError("not_found", `goal ${input.goalId} does not exist`);

    // 会话累计用量取**增量**：sessionUsage 是全量，这里用"上一次记录时的总量"作基线
    const sessionTotal = this.#deps.sessionUsage(existing.session_id);
    const deltaTokens = Math.max(0, sessionTotal.total - existing.tokens);
    const usage = addGoalUsage(
      {
        tokens: existing.tokens,
        tokens_estimated: existing.tokens_estimated,
        elapsed_ms: existing.elapsed_ms,
        runs: existing.runs,
      },
      {
        tokens: deltaTokens,
        estimated: sessionTotal.estimated,
        elapsed_ms: input.elapsedMs,
      },
    );

    const budget = checkBudget(usage, {
      token_limit: existing.token_limit,
      time_limit_ms: existing.time_limit_ms,
    });

    const now = this.#now().toISOString();
    let status: GoalStatus = existing.status;
    let statusChanged = false;
    if (budget.exceeded && status === "active") {
      status = "budget_limited";
      statusChanged = true;
    }

    const updated = this.#deps.store.update(
      input.goalId,
      {
        status,
        tokens: usage.tokens,
        tokens_estimated: usage.tokens_estimated,
        elapsed_ms: usage.elapsed_ms,
        runs: usage.runs,
        last_error: input.error,
      },
      now,
    );
    if (updated === null) throw new GoalError("not_found", `goal ${input.goalId} disappeared`);

    if (statusChanged) {
      this.#append(GOAL_EVENT_TYPES.budgetExceeded, updated.session_id, {
        goal_id: input.goalId,
        reason: budget.exceeded ? budget.reason : "unknown",
        tokens: usage.tokens,
        tokens_estimated: usage.tokens_estimated,
        elapsed_ms: usage.elapsed_ms,
        detail: budget.exceeded ? budget.detail : "",
      });
    }
    return { goal: updated, budget, statusChanged };
  }

  /** 上游配额受限（C5 在识别到 429/配额错误后调用） */
  markUsageLimited(goalId: string, detail: string): GoalRecord {
    const existing = this.#deps.store.get(goalId);
    if (existing === null) throw new GoalError("not_found", `goal ${goalId} does not exist`);
    const updated = this.#transition(goalId, "usage_limited");
    this.#append(GOAL_EVENT_TYPES.usageLimited, updated.session_id, {
      goal_id: goalId,
      detail,
    });
    return updated;
  }

  /** 阻塞（C5 在连续 3 轮同阻塞后调用） */
  markBlocked(goalId: string, detail: string): GoalRecord {
    const existing = this.#deps.store.get(goalId);
    if (existing === null) throw new GoalError("not_found", `goal ${goalId} does not exist`);
    return this.#transition(goalId, "blocked", detail);
  }

  /**
   * 统一迁移入口：查表 → 拒绝非法 → 落库 → 审计。
   *
   * 审计 payload 同时带 `from` 与 `to`：只记 `to` 的话，事后无法区分"pause 之后
   * resume"与"blocked 之后 resume"。
   */
  #transition(goalId: string, to: GoalStatus, detail?: string): GoalRecord {
    const existing = this.#deps.store.get(goalId);
    if (existing === null) throw new GoalError("not_found", `goal ${goalId} does not exist`);
    if (!canTransition(existing.status, to)) {
      const error = new GoalTransitionError(existing.status, to);
      throw new GoalError(error.code, error.message);
    }
    if (existing.status === to) return existing;
    const updated = this.#deps.store.update(goalId, { status: to }, this.#now().toISOString());
    if (updated === null) throw new GoalError("not_found", `goal ${goalId} disappeared`);
    this.#append(GOAL_EVENT_TYPES.updated, updated.session_id, {
      goal_id: goalId,
      from: existing.status,
      to,
      ...(detail === undefined ? {} : { detail }),
    });
    return updated;
  }

  #append(eventType: string, sessionId: string, payload: Record<string, unknown>): void {
    const envelope = buildEventEnvelope({
      replicaId: this.#deps.replicaId,
      actorId: "owner",
      eventType,
      sessionId,
      payload,
    });
    this.#deps.ledger.append(envelope);
  }
}
