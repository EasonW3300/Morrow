/**
 * Goal 续跑驱动器（票 M7-C-T5 / Issue #79，FR-C10/C8/C9/C11）。
 *
 * 只做三件事：**周期性问"谁该跑"→ 让会话自己跑一轮 → 把结果分类写回 goal**。
 * 不自己建 agent、不自己拼上下文——那是会话的职责（理由见 resume.ts 文件头）。
 *
 * ## 为什么结果分类要在这里
 *
 * 一轮运行结束后有三类结局（继续 / 配额受限 / 阻塞 / 超预算 / 完成），它们来自
 * 不同信号：预算来自 goal 的用量、配额来自供应商错误、阻塞来自连续失败计数。
 * 把这些判断集中在一处（`classifyRunOutcome`），比散落在会话事件处理里更容易
 * 穷举测试。
 */

import type { GoalService } from "./service.ts";
import type { GoalRecord } from "./store.ts";
import {
  DEFAULT_RESUME_IDLE_MS,
  UNBOUNDED_GOAL_RUN_LIMIT,
  classifyRunOutcome,
  decideResume,
  hitUnboundedRunLimit,
  resumePrompt,
  type ResumeDecision,
} from "./resume.ts";
import { advanceBlockedStreak, looksLikeUsageLimit } from "./state.ts";

export interface GoalDriverDeps {
  goals: GoalService;
  /** 会话是否仍可执行 */
  isSessionExecutable(sessionId: string): boolean;
  /** 会话是否在跑（有进行中的轮次） */
  isSessionBusy(sessionId: string): boolean;
  /** 会话是否处于 Plan 模式（只读模式不续跑） */
  isPlanModeActive(sessionId: string): boolean;
  /** 向会话投递一条用户消息（走会话自己的发送路径） */
  sendMessage(sessionId: string, text: string): void;
  /** 上次活动时间（毫秒时间戳；用于静默阈值判定） */
  lastActivityAt(sessionId: string): number;
  /** 时钟注入（测试零 sleep） */
  now?: () => number;
  idleThresholdMs?: number;
}

/** 一轮续跑的结果（诊断与测试用） */
export interface ResumeTickResult {
  decisions: ResumeDecision[];
  /** 实际发起的轮次（goal_id 列表） */
  started: string[];
}

export class GoalDriver {
  readonly #deps: GoalDriverDeps;
  readonly #now: () => number;
  readonly #idleThresholdMs: number;
  /** 每次续跑前的失败计数（goal_id → {streak, signature}） */
  readonly #streaks = new Map<string, { streak: number; signature: string | null }>();

  constructor(deps: GoalDriverDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_RESUME_IDLE_MS;
  }

  /**
   * 一轮扫描：对每个 active goal 做决策，该跑的跑。
   *
   * 返回决策与已发起的 goal（测试据此断言"Plan 下不续跑"这类行为，不必等到
   * 真的跑完一轮）。
   */
  tick(): ResumeTickResult {
    const decisions: ResumeDecision[] = [];
    const started: string[] = [];
    for (const goal of this.#deps.goals.list({ status: "active" })) {
      const decision = decideResume({
        goal,
        sessionExecutable: this.#deps.isSessionExecutable(goal.session_id),
        sessionBusy: this.#deps.isSessionBusy(goal.session_id),
        planModeActive: this.#deps.isPlanModeActive(goal.session_id),
        idleMs: this.#now() - this.#deps.lastActivityAt(goal.session_id),
        idleThresholdMs: this.#idleThresholdMs,
      });
      decisions.push(decision);
      if (!decision.resume) continue;
      this.#deps.sendMessage(goal.session_id, resumePrompt(goal));
      started.push(goal.goal_id);
    }
    return { decisions, started };
  }

  /**
   * 记录一轮运行的结果（由宿主在 `message.assistant` 落账后调用）。
   *
   * 这是状态机的"输入侧"：所有 goal 状态迁移都由这里驱动，而不是由会话事件处理
   * 直接改状态——单一入口保证分类逻辑只有一份。
   */
  recordRun(input: {
    goalId: string;
    error: string | null;
    /** 供应商状态码（有则传） */
    status?: number;
    elapsedMs: number;
    /** 模型声明目标已完成 */
    completed?: boolean;
  }): { goal: GoalRecord | null; action: ReturnType<typeof classifyRunOutcome>["action"] } {
    const existing = this.#deps.goals.get(input.goalId);
    if (existing === null) return { goal: null, action: "stay_active" };

    // 1) 推进阻塞计数（先算，后面分类要用）
    const streakResult = advanceBlockedStreak(
      this.#streaks.get(input.goalId) ?? { streak: 0, signature: null },
      input.error,
    );
    this.#streaks.set(input.goalId, { streak: streakResult.streak, signature: streakResult.signature });

    // 2) 记用量并判预算（recordRun 内部会写 tokens/elapsed 并判超限）
    const recorded = this.#deps.goals.recordRun({
      goalId: input.goalId,
      error: input.error,
      elapsedMs: input.elapsedMs,
    });

    // 3a) 无预算的轮次上限（code-review 补的兜底）：到 100 轮推成 budget_limited，
    // 而不是"不再续跑但状态还是 active"——后者会让 Owner 以为它还在跑。
    if (hitUnboundedRunLimit(recorded.goal)) {
      const limited = this.#safe(
        () =>
          this.#deps.goals.markBudgetLimited(
            input.goalId,
            `reached the ${UNBOUNDED_GOAL_RUN_LIMIT}-run safety limit with no budget set; set a token or time budget to continue`,
          ),
        recorded.goal,
      );
      return { goal: limited, action: "budget_limited" };
    }

    // 3b) 分类并迁移
    const action = classifyRunOutcome({
      error: input.error,
      ...(input.status === undefined ? {} : { status: input.status }),
      budgetExceeded: recorded.budget.exceeded,
      budgetDetail: recorded.budget.exceeded ? recorded.budget.detail : "",
      blockedThresholdReached: streakResult.thresholdReached,
      blockedDetail: `<blocked after ${streakResult.streak} identical failures> ${input.error ?? ""}`.slice(0, 400),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    });

    let goal: GoalRecord | null = recorded.goal;
    if (action.action === "usage_limited") {
      goal = this.#safe(() => this.#deps.goals.markUsageLimited(input.goalId, action.detail), recorded.goal);
    } else if (action.action === "blocked") {
      goal = this.#safe(() => this.#deps.goals.markBlocked(input.goalId, action.detail), recorded.goal);
    } else if (action.action === "complete") {
      goal = this.#safe(() => this.#deps.goals.complete(input.goalId, { reason: action.reason }), recorded.goal);
    }
    // budget_limited 已由 GoalService.recordRun 内部迁移（它先于分类完成）

    // 成功一轮 → 清零阻塞计数（下一次失败从 1 开始数）
    if (input.error === null) this.#streaks.delete(input.goalId);

    return { goal, action: action.action };
  }

  /** 决策辅助：会话是否该被这个 goal 阻塞（供 UI 显示"目标在等待"） */
  pendingGoalOf(sessionId: string): GoalRecord | null {
    return this.#deps.goals.openForSession(sessionId);
  }

  /** 迁移失败不抛（例如状态已不是 active）：返回原记录，避免打断宿主的事件处理 */
  #safe(transition: () => GoalRecord, fallback: GoalRecord): GoalRecord {
    try {
      return transition();
    } catch {
      return fallback;
    }
  }
}

/** 判定一个错误是否属于"上游配额"（导出给宿主在别处复用，保证口径一致） */
export const isUsageLimitError = looksLikeUsageLimit;
