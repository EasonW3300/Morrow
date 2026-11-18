/**
 * `<proposed_plan>` 解析与阶段判定（票 M7-C-T3 / Issue #77，FR-C2/C3/C4）。
 *
 * 纯逻辑，无 I/O：这是 Plan 模式最容易被做"歪"的地方（宽松解析会把模型随口说的一段
 * 话当成计划），所以单独成模块并穷举边界。
 *
 * 解析口径刻意**严格**：
 *   - 必须成对出现 `<proposed_plan>` 与 `</proposed_plan>`；
 *   - 块内必须是 Markdown，且**至少**有一个 `##` 级标题 + 一个列表项（步骤或影响文件）；
 *   - 解析失败返回结构化的失败原因（UI 要能告诉 Owner "缺了什么"），而不是抛错。
 *
 * 宽松解析的诱惑是"让用户少一次重试"，代价是**一份不像计划的文本被当成计划去实现**。
 * 这个取舍已经写进规格：解析失败不弹窗，提示"计划格式不完整，继续规划"。
 */

/** 计划块的结构化结果 */
export interface ParsedPlan {
  /** 计划标题（第一个 `##` 或 `#` 标题；缺省用 "Plan"） */
  title: string;
  /** 步骤列表（`- ` / `* ` / `1. ` 开头的行） */
  steps: string[];
  /** 影响文件（从步骤文本里抽出的反引号路径；没有则为空数组） */
  affectedFiles: string[];
  /** 风险段落（`## 风险` / `## Risks` 段落的正文；没有则 null） */
  risks: string | null;
  /** 原始 Markdown（保留以便「清空上下文后实现」注入） */
  raw: string;
}

export type PlanParseResult =
  | { ok: true; plan: ParsedPlan }
  | { ok: false; reason: "missing_block" | "empty_block" | "no_steps" | "no_heading"; detail: string };

/** 计划块标记（常量便于测试与 UI 引用） */
export const PLAN_BLOCK_OPEN = "<proposed_plan>";
export const PLAN_BLOCK_CLOSE = "</proposed_plan>";

/**
 * 从助手文本里抽取计划块。
 *
 * 只取**第一个**完整块：模型偶尔会产出两遍（流式中断后重试），取第一份是稳定的。
 */
export function parseProposedPlan(text: string): PlanParseResult {
  const openIndex = text.indexOf(PLAN_BLOCK_OPEN);
  if (openIndex < 0) {
    return {
      ok: false,
      reason: "missing_block",
      detail: `assistant output does not contain ${PLAN_BLOCK_OPEN}; keep planning until a plan block is produced`,
    };
  }
  const closeIndex = text.indexOf(PLAN_BLOCK_CLOSE, openIndex + PLAN_BLOCK_OPEN.length);
  if (closeIndex < 0) {
    return {
      ok: false,
      reason: "missing_block",
      detail: `${PLAN_BLOCK_OPEN} was opened but never closed with ${PLAN_BLOCK_CLOSE}`,
    };
  }
  const raw = text.slice(openIndex + PLAN_BLOCK_OPEN.length, closeIndex).trim();
  if (raw.length === 0) {
    return { ok: false, reason: "empty_block", detail: "the plan block is empty" };
  }

  const lines = raw.split("\n");
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line.trim()));
  if (heading === undefined) {
    return {
      ok: false,
      reason: "no_heading",
      detail: "the plan block has no heading (expected a line starting with # or ##)",
    };
  }
  const title = heading.replace(/^#{1,3}\s+/, "").trim() || "Plan";

  // 步骤**只取第一个标题之后、下一个标题之前**的列表项：
  // 否则「## 风险」段落里的列表会被误算成步骤，影响文件抽取也会混入风险项的路径。
  const steps = collectStepLines(lines);

  if (steps.length === 0) {
    return {
      ok: false,
      reason: "no_steps",
      detail: "the plan block has no steps (expected at least one bullet or numbered item)",
    };
  }

  return {
    ok: true,
    plan: {
      title,
      steps,
      affectedFiles: extractAffectedFiles(steps),
      risks: extractRisks(raw),
      raw,
    },
  };
}

/**
 * 从步骤文本里抽取反引号包裹的路径。
 *
 * 只认"看起来像路径"的反引号内容（含 `/` 或已知扩展名）：把 `npm test` 这类
 * 命令也当文件会让"影响文件"列表充满噪音。
 */
export function extractAffectedFiles(steps: readonly string[]): string[] {
  const out = new Set<string>();
  for (const step of steps) {
    for (const match of step.matchAll(/`([^`]+)`/g)) {
      const candidate = match[1].trim();
      if (candidate.length === 0) continue;
      if (!looksLikePath(candidate)) continue;
      out.add(candidate);
    }
  }
  return [...out];
}

/**
 * 抽取第一个标题段落里的列表项作为步骤。
 *
 * 只取**第一段**（第一个标题到下一个标题之间）：计划的结构是「标题 → 步骤 →
 * 可选的其他段落」。把所有段落的列表都算成步骤会让"步骤数"失去意义，也会让
 * 风险段里的文件路径混进"影响文件"。
 */
function collectStepLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inFirstSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,3}\s+\S/.test(line)) {
      if (inFirstSection) break; // 第二段开始，停止收集
      inFirstSection = true;
      continue;
    }
    if (!inFirstSection) continue;
    if (!/^(?:[-*]|\d+\.)\s+\S/.test(line)) continue;
    out.push(line.replace(/^(?:[-*]|\d+\.)\s+/, "").trim());
  }
  return out.filter((line) => line.length > 0);
}

function looksLikePath(value: string): boolean {
  if (value.includes(" ")) return false; // 命令通常带空格；路径一般没有
  if (value.includes("/")) return true;
  return /\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|sql|go|rs|py|sh|css|html)$/i.test(value);
}

/** 抽取风险段落（`## 风险` / `## Risks` / `## 风险与取舍`） */
export function extractRisks(raw: string): string | null {
  const lines = raw.split("\n");
  const startIndex = lines.findIndex((line) => /^#{2,3}\s*(风险|Risks?|风险与取舍)/i.test(line.trim()));
  if (startIndex < 0) return null;
  const collected: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,3}\s+\S/.test(line.trim())) break; // 下一个标题开始
    collected.push(line);
  }
  const body = collected.join("\n").trim();
  return body.length === 0 ? null : body;
}

/** Plan 三个阶段（与 plan/mode.ts 的 PLAN_PHASES 同值；此处独立导出便于解析层测试） */
export const PLAN_PHASE_ORDER = ["explore", "clarify", "detail"] as const;
export type PlanPhase = (typeof PLAN_PHASE_ORDER)[number];

/**
 * 阶段是否只能前进（不允许从 detail 退回 explore）。
 *
 * 允许停留在当前阶段（可重复），允许前进一格或多格（模型可能一次问完），
 * **不允许后退**——退回会让"已经聊清楚的细节"被重新覆盖成早期假设。
 */
export function canAdvancePhase(from: PlanPhase, to: PlanPhase): boolean {
  return PLAN_PHASE_ORDER.indexOf(to) >= PLAN_PHASE_ORDER.indexOf(from);
}

/** 计划解析成功后 Owner 的三种选择（FR-C3） */
export type PlanDecision = "implement" | "implement_clean" | "continue";

export const PLAN_DECISIONS: readonly PlanDecision[] = ["implement", "implement_clean", "continue"];

export function isPlanDecision(value: unknown): value is PlanDecision {
  return value === "implement" || value === "implement_clean" || value === "continue";
}

/**
 * 「清空上下文后实现」的注入提示词。
 *
 * 关键：**只注入计划全文**，不注入探索阶段的对话历史。探索过程里的错误猜测、
 * 反复试错都会污染实现阶段的上下文；计划本身就是探索的结论。
 */
export function cleanImplementPrompt(plan: ParsedPlan, workspacePath: string | null): string {
  const workspaceLine =
    workspacePath === null ? "（本会话未绑定工作区，不要修改任何文件）" : `工作区：${workspacePath}`;
  return [
    "你已获批准按下面的计划实施。这是新的上下文，之前探索阶段的对话不在其中。",
    workspaceLine,
    "",
    "计划：",
    plan.raw,
    "",
    "要求：先按步骤逐项落实；每完成一步说明改了什么；遇到与计划不符的实际情况时停下来说明，不要自行改计划。",
  ].join("\n");
}
