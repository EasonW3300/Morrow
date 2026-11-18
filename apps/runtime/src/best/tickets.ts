/**
 * Best 的拆票与实现门（票 M7-C-T7 / Issue #81，FR-C14/C15/C16）。
 *
 * ## 本票最要紧的一条
 *
 * **实现前确认门在完全权限下也必须拦得住**（FR-C14 / 规格决策 #40）。
 *
 * 实现方式不是"在某处检查一下执行模式"，而是把门**写死在 Best 的阶段迁移里**：
 * `tickets → implement` 这个转换只有一个入口，且要求 `implementApproved === true`。
 * 没有任何权限开关参与判定——所以不存在"完全权限绕过"的代码路径。测试会同时用
 * 两种执行模式各跑一遍，断言未确认时**无分支、无 DAG、无写操作**。
 *
 * ## 拆票不设门
 *
 * 规格确认后自动拆票（决策 #37）。产出两种形态：
 *   - 已配置 `gh` → GitHub issues；
 *   - 未配置 → 本地一票一文件（含 index 列依赖图）。
 *
 * 一票一文件是刻意的：便于将来迁移到 issues，也便于单独引用某张票。
 */

import type { BestStage } from "./stage.ts";

/** 一张票（垂直切片） */
export interface TicketSpec {
  /** 票标题（简短、动词开头） */
  title: string;
  /** 这一票端到端交付什么（用户视角，不是分层实现清单） */
  what_to_build: string;
  /** 验收标准 */
  criteria: string[];
  /** 阻塞它的其他票（按 title 引用；空数组 = 可立即开始） */
  blocked_by: string[];
}

/** 拆票结果 */
export interface TicketPlan {
  tickets: TicketSpec[];
  /** 依赖图是否有环（有环则拒绝落地） */
  hasCycle: boolean;
  /** 环的具体路径（有环时给出，便于修） */
  cyclePath: string[] | null;
}

/**
 * 校验拆票结果。
 *
 * 三条硬规则：
 *   1. 每票必须有 title / what_to_build / 至少一条验收；
 *   2. `blocked_by` 只能引用**存在的**票（否则依赖图是假的）；
 *   3. 依赖图**不得有环**（有环的票永远没人能开始）。
 */
export function validateTickets(input: unknown): { ok: true; plan: TicketPlan } | { ok: false; problems: string[] } {
  if (!Array.isArray(input)) return { ok: false, problems: ["tickets must be an array"] };
  const problems: string[] = [];
  const tickets: TicketSpec[] = [];
  for (const [index, raw] of input.entries()) {
    if (typeof raw !== "object" || raw === null) {
      problems.push(`ticket #${index + 1} must be an object`);
      continue;
    }
    const record = raw as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (title.length === 0) problems.push(`ticket #${index + 1} needs a title`);
    const whatToBuild = typeof record.what_to_build === "string" ? record.what_to_build.trim() : "";
    if (whatToBuild.length === 0) problems.push(`ticket "${title || index + 1}" needs what_to_build`);
    const criteria = Array.isArray(record.criteria)
      ? record.criteria.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (criteria.length === 0) problems.push(`ticket "${title || index + 1}" needs at least one acceptance criterion`);
    const blockedBy = Array.isArray(record.blocked_by)
      ? record.blocked_by.filter((item): item is string => typeof item === "string")
      : [];
    tickets.push({ title, what_to_build: whatToBuild, criteria, blocked_by: blockedBy });
  }
  if (problems.length === 0) {
    // 引用完整性
    const titles = new Set(tickets.map((ticket) => ticket.title));
    for (const ticket of tickets) {
      for (const blocker of ticket.blocked_by) {
        if (!titles.has(blocker)) {
          problems.push(`ticket "${ticket.title}" is blocked by unknown ticket "${blocker}"`);
        }
      }
    }
    // 环检测
    if (problems.length === 0) {
      const cycle = findCycle(tickets);
      if (cycle !== null) {
        return { ok: false, problems: [`dependency cycle detected: ${cycle.join(" → ")}`] };
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, plan: { tickets, hasCycle: false, cyclePath: null } };
}

/** 找依赖环（DFS 三色标记；返回环路径或 null） */
export function findCycle(tickets: readonly TicketSpec[]): string[] | null {
  const byTitle = new Map(tickets.map((ticket) => [ticket.title, ticket]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (title: string): string[] | null => {
    const state = color.get(title) ?? WHITE;
    if (state === BLACK) return null;
    if (state === GRAY) {
      // 找到环：从栈里截出环
      const start = stack.indexOf(title);
      return [...stack.slice(start), title];
    }
    color.set(title, GRAY);
    stack.push(title);
    const ticket = byTitle.get(title);
    if (ticket !== undefined) {
      for (const blocker of ticket.blocked_by) {
        const found = visit(blocker);
        if (found !== null) return found;
      }
    }
    stack.pop();
    color.set(title, BLACK);
    return null;
  };

  for (const ticket of tickets) {
    const found = visit(ticket.title);
    if (found !== null) return found;
  }
  return null;
}

/** 按依赖顺序排列（拓扑序：阻塞者在前） */
export function orderTickets(tickets: readonly TicketSpec[]): TicketSpec[] {
  const byTitle = new Map(tickets.map((ticket) => [ticket.title, ticket]));
  const done = new Set<string>();
  const out: TicketSpec[] = [];
  while (out.length < tickets.length) {
    let progressed = false;
    for (const ticket of tickets) {
      if (done.has(ticket.title)) continue;
      if (ticket.blocked_by.every((blocker) => done.has(blocker) || !byTitle.has(blocker))) {
        out.push(ticket);
        done.add(ticket.title);
        progressed = true;
      }
    }
    if (!progressed) break; // 有环（validateTickets 已经拦过）
  }
  return out;
}

// --- 票产物 -------------------------------------------------------------------------

/** 一张票的 Markdown（一票一文件） */
export function ticketMarkdown(input: { index: number; ticket: TicketSpec; specSlug: string }): string {
  const lines = [
    `# ${String(input.index).padStart(2, "0")}: ${input.ticket.title}`,
    "",
    "**What to build:** " + input.ticket.what_to_build,
    "",
    "**Blocked by:** " +
      (input.ticket.blocked_by.length === 0 ? "None (can start immediately)" : input.ticket.blocked_by.join(", ")),
    "",
    `**Spec:** \`docs/specs/${input.specSlug}.md\``,
    "",
    "## Acceptance criteria",
    "",
    ...input.ticket.criteria.map((criterion) => `- [ ] ${criterion}`),
    "",
  ];
  return lines.join("\n");
}

/** index.md：依赖图 + 开工顺序（本地形态的总览） */
export function ticketIndexMarkdown(input: { specSlug: string; tickets: readonly TicketSpec[] }): string {
  const ordered = orderTickets(input.tickets);
  const lines = [
    `# ${input.specSlug} — Tickets`,
    "",
    `规格：\`docs/specs/${input.specSlug}.md\``,
    "",
    "## 依赖图",
    "",
    "```",
    ...ordered.map((ticket) =>
      ticket.blocked_by.length === 0
        ? `${ticket.title}  (可立即开始)`
        : `${ticket.title}  ← ${ticket.blocked_by.join(", ")}`,
    ),
    "```",
    "",
    "## 开工顺序（拓扑序）",
    "",
    ...ordered.map((ticket, index) => `${index + 1}. ${ticket.title}`),
    "",
  ];
  return lines.join("\n");
}

/** 票文件相对路径（`docs/specs/<slug>/issues/NN-slug.md`） */
export function ticketFilePath(input: { specSlug: string; index: number; title: string }): string {
  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `ticket-${input.index}`;
  return `docs/specs/${input.specSlug}/issues/${String(input.index).padStart(2, "0")}-${slug}.md`;
}

/** 规格文件相对路径 */
export function specFilePath(specSlug: string): string {
  return `docs/specs/${specSlug}.md`;
}

/** 实现分支名（`feat/<slug>`） */
export function implementBranch(specSlug: string): string {
  return `feat/${specSlug}`;
}

// --- 实现门 -------------------------------------------------------------------------

/**
 * 实现门的状态。
 *
 * 关键设计：`approved` 是**唯一**能进 implement 的条件，且它不是从执行模式推导的。
 * 把"谁能进门"收敛到一个布尔值，好处是审计里能明确记录"谁在什么时候批准的"。
 */
export interface ImplementGateState {
  stage: BestStage;
  /** 是否已通过实现前确认 */
  implementApproved: boolean;
  /** 批准时间（审计用） */
  approvedAt: string | null;
}

/** 门的判定：能不能进 implement */
export function canEnterImplement(state: ImplementGateState): { ok: true } | { ok: false; reason: string } {
  if (state.stage !== "tickets") {
    return { ok: false, reason: `implement can only be entered from the tickets stage (current: ${state.stage})` };
  }
  if (!state.implementApproved) {
    return {
      ok: false,
      reason:
        "the implement gate has not been approved; this gate cannot be skipped (not even in full-permission mode)",
    };
  }
  return { ok: true };
}

/**
 * 门的提示文案。
 *
 * 明确写出"完全权限也不能跳过"——这是 Owner 需要知道的保证，不是内部细节。
 */
export const IMPLEMENT_GATE_NOTICE = [
  "即将开始实现：会在你的工作区创建分支、提交代码、展开任务 DAG。",
  "这一步需要你确认。**即使会话处于「完全权限」模式，这个确认也不能跳过。**",
  "提交只留在本地分支，不会推送；推送与开 PR 需要你之后单独点按钮。",
].join("\n");
