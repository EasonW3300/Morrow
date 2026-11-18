/**
 * 阶段 C 的 UI 纯逻辑（票 M7-C-T8 / Issue #82 补齐）。
 *
 * 抽成纯模块的理由与 M7-A/M7-B 一致：这些判定是"用户看到的承诺"，必须能被
 * node:test 直接锁住。尤其三条不能撒谎：
 *
 *   1. **Plan 模式是只读**——不能显示成"稍后在写"；
 *   2. **完全权限不能跳实现门**——文案必须明说，否则 Owner 会以为切到完全权限就没人拦；
 *   3. **Goal 的 token 可能是估算**——UI 必须标出来，不然 Owner 会对预算产生错误信任。
 */

// --- Plan ---------------------------------------------------------------------------

export type PlanPhase = "explore" | "clarify" | "detail";

export const PLAN_PHASE_LABELS: Record<PlanPhase, string> = {
  explore: "环境探查",
  clarify: "意图澄清",
  detail: "实现细节",
};

/** Plan 模式徽标（Plan 下必须一眼可见"只读"） */
export function planBadge(active: boolean, phase: string | null): { tone: string; label: string } | null {
  if (!active) return null;
  const phaseLabel = phase !== null && phase in PLAN_PHASE_LABELS ? PLAN_PHASE_LABELS[phase as PlanPhase] : "";
  return {
    tone: "run",
    label: phaseLabel.length === 0 ? "计划模式 · 只读" : `计划模式 · ${phaseLabel}`,
  };
}

/** Plan 模式的常驻说明（必须写清"写工具根本不在工具集里"） */
export const PLAN_READONLY_NOTE =
  "计划模式只读：读文件、搜代码、看 git 历史这类工具可用；写工具不会出现在工具集里，" +
  "即使模型尝试调用也会被拒并留审计。";

/** 计划解析失败时的提示（不弹窗，让 Owner 继续规划） */
export function planParseFailureHint(reason: string, detail: string): string {
  return `计划格式不完整（${reason}）：${detail}。继续规划，补齐标题与步骤后再提交。`;
}

/** 三种实现选择的文案（FR-C3） */
export interface PlanChoiceOption {
  decision: "implement" | "implement_clean" | "continue";
  label: string;
  detail: string;
}

export const PLAN_CHOICES: readonly PlanChoiceOption[] = [
  {
    decision: "implement",
    label: "实现这份计划",
    detail: "在当前会话继续，保留探索阶段的上下文。",
  },
  {
    decision: "implement_clean",
    label: "清空上下文后实现",
    detail: "新开一个上下文，只带计划全文（省 token，也避免探索时的错误猜测干扰实现）。",
  },
  {
    decision: "continue",
    label: "继续规划",
    detail: "计划还不满意，接着聊。",
  },
];

// --- Goal ---------------------------------------------------------------------------

export interface GoalUsageView {
  tokens: number;
  tokens_estimated: boolean;
  elapsed_ms: number;
  runs: number;
  token_progress: number | null;
  time_progress: number | null;
}

/** Goal 的用量摘要（估算必须显式标注） */
export function goalUsageSummary(usage: GoalUsageView): string {
  const parts: string[] = [];
  const tokenText = usage.tokens_estimated ? `${usage.tokens} tokens（估算）` : `${usage.tokens} tokens`;
  parts.push(tokenText);
  parts.push(`${Math.round(usage.elapsed_ms / 1000)}s`);
  parts.push(`${usage.runs} 轮`);
  if (usage.token_progress !== null) parts.push(`token 预算已用 ${Math.round(usage.token_progress * 100)}%`);
  if (usage.time_progress !== null) parts.push(`时间预算已用 ${Math.round(usage.time_progress * 100)}%`);
  return parts.join(" · ");
}

/** 状态徽标（六态各有 tone；blocked/usage_limited/budget_limited 必须可区分） */
export function goalStatusBadge(status: string): { tone: string; label: string } {
  switch (status) {
    case "active":
      return { tone: "run", label: "进行中" };
    case "paused":
      return { tone: "muted", label: "已暂停" };
    case "blocked":
      return { tone: "warn", label: "受阻塞" };
    case "usage_limited":
      return { tone: "warn", label: "上游配额受限" };
    case "budget_limited":
      return { tone: "error", label: "预算已用尽" };
    case "complete":
      return { tone: "ok", label: "已完成" };
    default:
      return { tone: "dim", label: status };
  }
}

/**
 * 三种"停下来"的状态给出的下一步建议（这是 Owner 最需要的：
 * "它停了，我该做什么"）。
 */
export function goalNextStep(status: string): string | null {
  switch (status) {
    case "blocked":
      return "同一个错误连续出现 3 轮。查看 last_error，修掉阻塞后点「恢复」。";
    case "usage_limited":
      return "上游配额/限流。换配额或稍后再点「恢复」——它不会再自动续跑。";
    case "budget_limited":
      return "预算用尽。提高 token 预算后点「恢复」即可继续（恢复时可同时改预算）。";
    case "paused":
      return "已暂停，不会被空闲续跑拉起。点「恢复」继续。";
    case "complete":
      return "目标已完成。要重新做就建一个新目标（已完成的目标不能复活）。";
    default:
      return null;
  }
}

/** 创建 Goal 的确认文案（预算与自动续跑必须写清） */
export function goalCreateNotice(input: { tokenLimit: number | null; timeLimitMs: number | null }): string {
  const budgetParts: string[] = [];
  budgetParts.push(input.tokenLimit === null ? "token 不限" : `token 上限 ${input.tokenLimit}`);
  budgetParts.push(
    input.timeLimitMs === null ? "时间不限" : `时间上限 ${Math.round(input.timeLimitMs / 60_000)} 分钟`,
  );
  return (
    "创建目标后它会在会话空闲时自动继续推进，并在预算用尽时自动停止。" +
    `当前预算：${budgetParts.join(" / ")}。` +
    "Plan 模式下不会自动续跑。"
  );
}

/** 创建按钮的禁用原因（null = 可点） */
export function goalCreateDisabledReason(input: {
  objective: string;
  confirmed: boolean;
  busy: boolean;
}): string | null {
  if (input.busy) return "正在创建…";
  if (input.objective.trim().length === 0) return "请填写目标（objective）";
  if (!input.confirmed) return "创建前请确认：目标会自动续跑并消耗预算";
  return null;
}

// --- Best ---------------------------------------------------------------------------

export type BestStage = "interview" | "spec" | "tickets" | "implement";

export const BEST_STAGE_LABELS: Record<BestStage, string> = {
  interview: "访谈",
  spec: "规格",
  tickets: "拆票",
  implement: "实现",
};

/** 四阶段进度条（UI 直接渲染） */
export function bestStageProgress(stage: BestStage): Array<{ stage: BestStage; label: string; current: boolean; done: boolean }> {
  const order: BestStage[] = ["interview", "spec", "tickets", "implement"];
  const currentIndex = order.indexOf(stage);
  return order.map((item, index) => ({
    stage: item,
    label: BEST_STAGE_LABELS[item],
    current: index === currentIndex,
    done: index < currentIndex,
  }));
}

/** 规格门文案（被拒时明说"停在规格，不用重新访谈"） */
export const SPEC_GATE_NOTICE =
  "请审阅规格。通过后会自动拆票（拆票不设确认门）；不通过则停在规格阶段，可编辑后重新提交，" +
  "不需要重新访谈。";

/**
 * **实现门文案**——必须明说完全权限也不能跳。
 *
 * 这是全阶段最容易被用户误解的一处：他刚把会话切成"完全权限"，如果这里不说清楚，
 * 他会以为实现会直接开跑。
 */
export const IMPLEMENT_GATE_UI_NOTICE =
  "即将开始实现：在你的工作区创建 feat/ 分支、提交代码、展开任务 DAG。" +
  "这一步需要你确认——**即使会话处于「完全权限」模式，这个确认也不能跳过。**" +
  "提交只留在本地分支，不会推送；推送与开 PR 需要之后单独点按钮。";

/** 实现门按钮的禁用原因（null = 可点） */
export function implementGateDisabledReason(input: {
  stage: string;
  approved: boolean;
  busy: boolean;
}): string | null {
  if (input.busy) return "处理中…";
  if (input.stage !== "tickets") return "先完成拆票，再确认实现";
  if (input.approved) return "已确认，正在实现";
  return null;
}

/** 产物清单（三类产物落位的展示） */
export function artifactsSummary(run: {
  spec_path: string | null;
  tickets: Array<{ title: string }>;
  branch: string | null;
  status: string;
}): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  if (run.spec_path !== null) out.push({ label: "规格", value: run.spec_path });
  if (run.tickets.length > 0) out.push({ label: "票", value: `${run.tickets.length} 张` });
  if (run.branch !== null) out.push({ label: "分支", value: run.branch });
  if (run.status === "aborted") out.push({ label: "状态", value: "已中止（遗留物未自动清理）" });
  return out;
}

/** 「推送并开 PR」的确认文案（不可撤销 + 对外可见） */
export function pushConfirmText(input: { branch: string }): string {
  return (
    `即将把 ${input.branch} 推送到远端并创建 PR。` +
    "这会对外可见且不易撤回，所以必须由你确认——自动化到此为止。"
  );
}
