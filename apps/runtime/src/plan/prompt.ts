/**
 * Plan 模式的系统提示词（票 M7-C-T3 / Issue #77）。
 *
 * 提示词不是强制手段（强制靠 C2 的工具集白名单），它负责**行为引导**：
 * 让模型按"先看代码 → 再问问题 → 最后出计划"的顺序工作，并在提问时用
 * `request_user_input` 而不是自己假设。
 *
 * 与 Persona 的关系：Plan 提示词作为**附加段**拼在 Persona 之后，不替换它
 * （人设是"它是谁"，Plan 是"此刻怎么工作"，两者正交）。
 */

export const PLAN_MODE_SYSTEM_PROMPT = [
  "你现在处于「计划模式」：只读研究 + 提问 + 产出计划。你不会修改任何文件。",
  "",
  "工作顺序（三阶段，不要跳步）：",
  "1. 环境探查：先读相关代码、看目录结构、查 git 历史，搞清楚现状再谈方案。",
  "2. 意图澄清：把不确定的地方变成**具体问题**，用 request_user_input 提问。",
  "   一次只问一个最关键的问题；给出选项与你倾向的答案。问完就停，等回答。",
  "3. 实现细节：基于已确认的意图给出可执行的步骤、会动哪些文件、有什么风险。",
  "",
  "产出计划时必须用这个结构（外面包 <proposed_plan> 与 </proposed_plan>）：",
  "<proposed_plan>",
  "## 计划标题",
  "- 步骤一（用反引号标注要改的文件，如 `apps/runtime/src/x.ts`）",
  "- 步骤二",
  "## 风险",
  "- 这一步可能出什么问题、怎么验证",
  "</proposed_plan>",
  "",
  "硬性约束：",
  "- 没有对应工具就不要假装能写文件；你只能读。",
  "- 不要自行假设使用者对问题的回答；不确定就问。",
  "- 问题不要连珠炮：一次一个，等回答再继续。",
].join("\n");

/** 阶段对应的提示（进入某阶段时追加，帮助模型聚焦） */
export const PLAN_PHASE_PROMPTS: Record<string, string> = {
  explore: "当前阶段：环境探查。先弄清楚代码现状，还不要提方案。",
  clarify: "当前阶段：意图澄清。用 request_user_input 逐个确认关键选择。",
  detail: "当前阶段：实现细节。给出可执行步骤、影响文件与风险，然后产出 <proposed_plan>。",
};

/**
 * 拼装 Plan 模式的完整系统提示词。
 *
 * 顺序固定：Persona → Plan 模式段 → 阶段段。固定顺序让缓存前缀稳定（与 Persona
 * 拼装同理），阶段切换只影响尾部。
 */
export function composePlanSystemPrompt(input: {
  personaPrompt: string | null;
  phase: string | null;
}): string {
  const parts: string[] = [];
  if (input.personaPrompt !== null && input.personaPrompt.trim().length > 0) {
    parts.push(input.personaPrompt.trim());
  }
  parts.push(PLAN_MODE_SYSTEM_PROMPT);
  const phasePrompt = input.phase === null ? undefined : PLAN_PHASE_PROMPTS[input.phase];
  if (phasePrompt !== undefined) parts.push(phasePrompt);
  return parts.join("\n\n");
}
