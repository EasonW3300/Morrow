/**
 * Goal 的空闲续跑决策（票 M7-C-T5 / Issue #79，FR-C10）。
 *
 * ## 为什么这里只做"决策"不做"运行"
 *
 * 续跑需要发起一轮会话运行。如果续跑器自己建 agent runtime、自己拼 prompt，
 * 就变成了**第二条运行路径**——与 SessionManager 的那条并行。两条路径迟早会
 * 在事件记账、用量累加、工具装配上分叉（M7-B 的 MCP "注册了但不可调"就是这种
 * 分叉的后果）。
 *
 * 所以这里只回答"现在该不该为这个 goal 续跑"，由宿主拿这个决策去调**会话自己的**
 * 发送消息路径。决策是纯函数，可穷举测试；运行是既有能力，不重复实现。
 *
 * ## 续跑条件（全部满足才续）
 *
 * 1. goal 状态是 `active`；
 * 2. 会话仍可执行（未关闭/未删除）；
 * 3. 会话当前**空闲**（没有正在跑的轮次）；
 * 4. 距上次活动超过静默阈值；
 * 5. **会话不在 Plan 模式**（FR-C10 的硬要求：只读模式不该偷偷烧预算）。
 */

import type { GoalRecord } from "./store.ts";

/** 续跑决策 */
export type ResumeDecision =
  | { resume: true; reason: "idle_active_goal"; goal_id: string; session_id: string }
  | { resume: false; reason: ResumeBlockedReason; goal_id: string; session_id: string };

export type ResumeBlockedReason =
  | "not_active"
  | "unbounded_run_limit"
  | "session_not_executable"
  | "session_busy"
  | "not_idle_long_enough"
  | "plan_mode_active";

/** 续跑输入（全部由宿主提供，便于注入时钟与状态） */
export interface ResumeInput {
  goal: GoalRecord;
  /** 会话仍可执行 */
  sessionExecutable: boolean;
  /** 会话当前是否有轮次在跑 */
  sessionBusy: boolean;
  /** 会话是否处于 Plan 模式 */
  planModeActive: boolean;
  /** 距上次活动多少毫秒 */
  idleMs: number;
  /** 静默阈值（默认 30s：太短会在 Owner 刚看完一轮就自跑） */
  idleThresholdMs: number;
}

/** 默认静默阈值（30 秒） */
export const DEFAULT_RESUME_IDLE_MS = 30_000;

/**
 * 无预算时的轮次硬上限（100 轮）。
 *
 * 这个兜底是 code-review 抓到的真实风险：`token_limit` 与 `time_limit_ms` 都可以
 * 为 null（"不设限"是合法的），但**自动续跑 + 无任何上限 = 永不停止**。每 30s 一轮，
 * 没人看着就会一直烧。
 *
 * 100 轮远高于任何正常目标（一个 goal 通常几轮到十几轮），所以它只会拦住
 * "忘了设预算且它跑飞了"这种情况。到上限按 `budget_limited` 处理并说明原因。
 */
export const UNBOUNDED_GOAL_RUN_LIMIT = 100;

/** 是否已到无预算轮次上限 */
export function hitUnboundedRunLimit(goal: { runs: number; token_limit: number | null; time_limit_ms: number | null }): boolean {
  if (goal.token_limit !== null || goal.time_limit_ms !== null) return false;
  return goal.runs >= UNBOUNDED_GOAL_RUN_LIMIT;
}

/**
 * 判定是否续跑。
 *
 * 顺序刻意从"最不可协商"到"最可协商"：先看状态与可执行性（硬条件），再看忙闲
 * （时序条件），最后看静默时长（启发式）。这样报出的 reason 总是最根本的那个原因。
 */
export function decideResume(input: ResumeInput): ResumeDecision {
  const base = { goal_id: input.goal.goal_id, session_id: input.goal.session_id };
  if (input.goal.status !== "active") {
    return { resume: false, reason: "not_active", ...base };
  }
  if (!input.sessionExecutable) {
    return { resume: false, reason: "session_not_executable", ...base };
  }
  // Plan 模式检查放在"忙闲"之前：即使会话空闲，只读模式下也绝不自跑（FR-C10）
  if (input.planModeActive) {
    return { resume: false, reason: "plan_mode_active", ...base };
  }
  if (input.sessionBusy) {
    return { resume: false, reason: "session_busy", ...base };
  }
  if (hitUnboundedRunLimit(input.goal)) {
    // 无预算且有上限保护：到 100 轮就停（避免"忘了设预算"变成永不停止）
    return { resume: false, reason: "unbounded_run_limit", ...base };
  }
  if (input.idleMs < input.idleThresholdMs) {
    return { resume: false, reason: "not_idle_long_enough", ...base };
  }
  return { resume: true, reason: "idle_active_goal", ...base };
}

/** 一轮运行结束后应做什么（错误分类的唯一出口） */
export type RunOutcomeAction =
  /** 继续 active */
  | { action: "stay_active" }
  /** 转 usage_limited（上游配额） */
  | { action: "usage_limited"; detail: string }
  /** 转 blocked（同一阻塞达阈值） */
  | { action: "blocked"; detail: string }
  /** 转 budget_limited（超预算） */
  | { action: "budget_limited"; detail: string }
  /** 转 complete（模型自报完成） */
  | { action: "complete"; reason: string };

/**
 * 分类一轮运行的结果。
 *
 * 优先级：预算 > 配额 > 阻塞。理由：
 * - 预算超了就不该再跑，哪怕错误是配额（两者都停，但预算的处置更明确）；
 * - 配额错误会让后续所有轮次都失败，所以它压过"阻塞计数"（否则会慢慢数到 3 轮
 *   才发现是配额问题，白烧两轮）。
 */
export function classifyRunOutcome(input: {
  error: string | null;
  /** 供应商状态码（有则用） */
  status?: number;
  budgetExceeded: boolean;
  budgetDetail: string;
  blockedThresholdReached: boolean;
  blockedDetail: string;
  /** 模型/调用方声明完成 */
  completed?: boolean;
}): RunOutcomeAction {
  if (input.budgetExceeded) return { action: "budget_limited", detail: input.budgetDetail };
  if (input.completed === true) return { action: "complete", reason: "goal marked complete by the run" };
  if (input.error !== null) {
    if (looksLikeUsageLimitMessage(input)) {
      return {
        action: "usage_limited",
        detail: `upstream usage limit: ${input.error.slice(0, 400)}`,
      };
    }
    if (input.blockedThresholdReached) {
      return { action: "blocked", detail: input.blockedDetail };
    }
  }
  return { action: "stay_active" };
}

function looksLikeUsageLimitMessage(input: { error: string | null; status?: number }): boolean {
  if (input.status === 429) return true;
  const message = (input.error ?? "").toLowerCase();
  return (
    /\b429\b/.test(message) ||
    /rate\s*limit/.test(message) ||
    /quota/.test(message) ||
    /too many requests/.test(message)
  );
}

/**
 * 续跑的提示词。
 *
 * 极短且明确：告诉模型"这是一个挂着的目标的下一轮"，并把 objective 原样带上。
 * 刻意**不**注入历史对话（历史在会话里，模型自己能看到）——重复注入会让
 * 上下文快速膨胀，而续跑本来就可能是几十轮。
 */
export function resumePrompt(goal: GoalRecord): string {
  return [
    `继续推进这个目标（第 ${goal.runs + 1} 轮）：`,
    goal.objective,
    "",
    `已完成 ${goal.runs} 轮。如果目标已经达成，请明确说明"目标已完成"；如果卡住了，说明卡在哪里。`,
  ].join("\n");
}
