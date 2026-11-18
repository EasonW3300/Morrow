/**
 * Thread Goal 的六态状态机与双预算（票 M7-C-T4 / Issue #78，FR-C6..C8）。
 *
 * ## 为什么状态机要严格
 *
 * Goal 是"跨轮次长跑意图"。如果状态迁移宽松（比如允许从 `complete` 回到 `active`，
 * 或让 `blocked` 直接跳 `complete`），Owner 就永远无法确定"它现在到底在干什么"——
 * 而 Goal 的全部价值就在于"我放着不管也知道它在做什么"。所以：**非法迁移一律拒绝**，
 * 并把当前态与目标态一起报出来。
 *
 * ## 预算两维，语义不同
 *
 * - **token**：自行累加 usage（缺失时估算，见 C1）。它衡量"花了多少钱"。
 * - **时间**：wall-clock，**暂停时不累计**。它衡量"占了我多久"。
 *
 * 任一超限 → `budget_limited` 并停止续跑。两者分开是因为它们回答不同问题：
 * "预算烧完了"与"跑太久了"需要的动作不一样。
 *
 * ## 六态与合法迁移
 *
 * ```
 *            ┌─────────── pause ───────────┐
 *            ▼                             │
 *   active ──────── resume ──────────────► paused
 *     │  │                                   │
 *     │  └── 3 轮同阻塞 ──► blocked ──resume──┘
 *     │  └── 429/配额 ────► usage_limited ──resume──┘
 *     │  └── 超预算 ──────► budget_limited ──resume（需提高预算）──┘
 *     └── 完成 ──────────► complete（终态）
 * ```
 *
 * `complete` 是**终态**：不可迁出。要重新开始就建新 goal——"复活一个已完成的目标"
 * 会让"完成"这个状态失去意义。
 */

/** 六个状态（FR-C6） */
export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";

/** 用一句话解释每个状态（UI 直接展示；写在这里保证措辞一致） */
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻塞",
  usage_limited: "上游配额受限",
  budget_limited: "预算已用尽",
  complete: "已完成",
};

/** 状态是否表示"还没结束但当前没在跑"（续跑器据此判断要不要恢复） */
export function isTerminal(status: GoalStatus): boolean {
  return status === "complete";
}

/**
 * 合法迁移表。
 *
 * 刻意**写成显式表**而不是一堆 if：表能被穷举测试逐格验证，if 链只能测到
 * 作者想到的路径。
 */
const ALLOWED_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ["paused", "blocked", "usage_limited", "budget_limited", "complete"],
  paused: ["active", "complete"],
  blocked: ["active", "complete"],
  usage_limited: ["active", "complete"],
  budget_limited: ["active", "complete"],
  complete: [], // 终态
};

export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return true; // 幂等：同态"迁移"是合法的 no-op
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** 迁移被拒时返回可读原因（含当前态与目标态） */
export class GoalTransitionError extends Error {
  readonly code = "invalid_transition";
  readonly from: GoalStatus;
  readonly to: GoalStatus;
  constructor(from: GoalStatus, to: GoalStatus) {
    super(
      `goal cannot transition from "${from}" (${GOAL_STATUS_LABELS[from]}) to "${to}" (${GOAL_STATUS_LABELS[to]})`,
    );
    this.name = "GoalTransitionError";
    // 显式赋值而非参数属性：node --experimental-strip-types 的 strip-only 模式
    // 不支持 TS parameter property（会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。
    this.from = from;
    this.to = to;
  }
}

// --- 预算 ---------------------------------------------------------------------------

/** 双预算（任一缺省 = 该维度不设限） */
export interface GoalBudget {
  /** token 上限；null = 不限制 */
  token_limit: number | null;
  /** 时间上限（毫秒）；null = 不限制 */
  time_limit_ms: number | null;
}

/** 累计用量（token 与时间分开记） */
export interface GoalUsage {
  tokens: number;
  /** token 数是否含估算（只要有一段估算就为 true） */
  tokens_estimated: boolean;
  /** 累计运行毫秒（暂停期间不计） */
  elapsed_ms: number;
  /** 已跑轮次 */
  runs: number;
}

export const EMPTY_GOAL_USAGE: GoalUsage = {
  tokens: 0,
  tokens_estimated: false,
  elapsed_ms: 0,
  runs: 0,
};

export type BudgetVerdict =
  | { exceeded: false }
  | { exceeded: true; reason: "tokens" | "time"; detail: string };

/**
 * 预算判定。
 *
 * 边界口径：**达到即算用尽**（`>=` 而不是 `>`）。理由是预算的含义是"最多花这么多"，
 * 花到上限就该停，不该再多跑一轮才停。
 */
export function checkBudget(usage: GoalUsage, budget: GoalBudget): BudgetVerdict {
  if (budget.token_limit !== null && usage.tokens >= budget.token_limit) {
    const qualifier = usage.tokens_estimated ? "（含估算值，实际可能略有差异）" : "";
    return {
      exceeded: true,
      reason: "tokens",
      detail: `token budget used up: ${usage.tokens} / ${budget.token_limit}${qualifier}`,
    };
  }
  if (budget.time_limit_ms !== null && usage.elapsed_ms >= budget.time_limit_ms) {
    return {
      exceeded: true,
      reason: "time",
      detail: `time budget used up: ${Math.round(usage.elapsed_ms / 1000)}s / ${Math.round(budget.time_limit_ms / 1000)}s`,
    };
  }
  return { exceeded: false };
}

/** 预算规范化：负数/NaN 视为"未设置"（不静默当成 0——那会让 Goal 立刻超限） */
export function normalizeBudget(input: { token_limit?: unknown; time_limit_ms?: unknown }): GoalBudget {
  const read = (value: unknown): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
  };
  return {
    token_limit: read(input.token_limit),
    time_limit_ms: read(input.time_limit_ms),
  };
}

/** 累加一次运行的用量（tokens 与 elapsed 分开；estimation 标记会传播） */
export function addGoalUsage(
  base: GoalUsage,
  run: { tokens: number; estimated: boolean; elapsed_ms: number },
): GoalUsage {
  const safe = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);
  return {
    tokens: base.tokens + safe(run.tokens),
    tokens_estimated: base.tokens_estimated || run.estimated,
    elapsed_ms: base.elapsed_ms + safe(run.elapsed_ms),
    runs: base.runs + 1,
  };
}

// --- 阻塞判定 -----------------------------------------------------------------------

/** `blocked` 判定阈值：同一阻塞连续 3 轮（FR-C11） */
export const BLOCKED_STREAK_THRESHOLD = 3;

/**
 * 错误签名归一化。
 *
 * 目的：把"同一个阻塞"识别出来。做法是去掉数字、路径、UUID 这类易变片段后取
 * 稳定字符串。不做哈希（可读性更重要——审计里能直接看出卡在哪）。
 */
export function errorSignature(message: string): string {
  return message
    .toLowerCase()
    // 去掉 UUID 与长十六进制（时间戳/请求 id）
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/g, "<hex>")
    // 去掉"数字+单位"（耗时/大小：1234ms / 12s / 5MB）与裸数字（端口、行号）
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|kb|mb|gb|b)\b/gi, "<n>")
    .replace(/\b\d+\b/g, "<n>")
    // 去掉绝对路径（保留文件名）
    .replace(/(?:\/[\w.-]+)+\/([\w.-]+)/g, "<path>/$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 阻塞计数器的推进结果 */
export interface BlockedStreakResult {
  /** 新的连续次数 */
  streak: number;
  /** 新的签名（换了一个阻塞就从 1 重新数） */
  signature: string | null;
  /** 是否已达阈值（达到即应转 blocked） */
  thresholdReached: boolean;
}

/**
 * 推进阻塞计数。
 *
 * - 成功（`error === null`）→ 清零；
 * - 失败且签名与上次相同 → 计数 +1；
 * - 失败但签名变了 → 从 1 重新数（换了个问题说明上一个不是"卡死"）。
 */
export function advanceBlockedStreak(
  previous: { streak: number; signature: string | null },
  error: string | null,
): BlockedStreakResult {
  if (error === null) return { streak: 0, signature: null, thresholdReached: false };
  const signature = errorSignature(error);
  const streak = previous.signature === signature ? previous.streak + 1 : 1;
  return { streak, signature, thresholdReached: streak >= BLOCKED_STREAK_THRESHOLD };
}

// --- 配额错误识别 -------------------------------------------------------------------

/**
 * 是否像"上游配额/限流"错误（FR-C9）。
 *
 * 判定宽松是刻意的：把"配额用尽"误判成"普通失败"会让 Goal 在 429 上死循环重试；
 * 反过来把普通失败误判成配额受限，代价只是"Owner 需要手动恢复一次"——两者不对称，
 * 所以宁严? 不，这里选择**偏向识别为 usage_limited**。
 *
 * 已知局限（PRD §10 的开放项）：不同网关的错误码与文案不统一，所以同时看状态码
 * 与文案特征，并保留原始错误供 Owner 核对。
 */
export function looksLikeUsageLimit(input: { status?: number; message?: string }): boolean {
  if (input.status === 429) return true;
  const message = (input.message ?? "").toLowerCase();
  if (message.length === 0) return false;
  return (
    /\b429\b/.test(message) ||
    /rate\s*limit/.test(message) ||
    /quota/.test(message) ||
    /insufficient_quota/.test(message) ||
    /too many requests/.test(message) ||
    /exceeded .* (?:limit|quota)/.test(message)
  );
}
