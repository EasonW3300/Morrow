/**
 * `/` 命令面板纯逻辑（票 M7-B-T5 / Issue #69）。
 *
 * 只做可测的展示与导航判定：命令注册表、过滤（前缀优先 + 模糊兜底）、按来源分组、
 * 键盘索引推进（含首尾循环）、命令分派。React 只负责装配与 I/O
 * （node:test 直接跑本模块，无 DOM 依赖）。
 *
 * 设计取舍：
 * - `/plan` `/goal` `/best` 属于 M7-C，本阶段**未实现**——但必须给出"即将支持"的提示，
 *   不能静默无反应（用户按了回车却没任何反馈，会以为是 bug）。
 * - 技能区按来源分组（内置 / 包 / MCP）：来源是"我允许了什么"的第一手信息，
 *   混在一个列表里就看不出来了。
 */

/** 面板条目来源（用于分组与徽标） */
export type PaletteSource = "builtin" | "package" | "mcp";

/** 命令区条目 */
export interface PaletteCommand {
  /** 不含前导 `/`，如 `plan` */
  name: string;
  description: string;
  /** M7-C 才实现的命令：本阶段只提示"即将支持" */
  pending?: boolean;
  /** `/skill <name>` 这类需要参数的命令 */
  takesArgument?: boolean;
}

/** 技能区条目（内置 Skill / 已装技能包 / MCP 工具） */
export interface PaletteSkill {
  name: string;
  description: string;
  source: PaletteSource;
}

/** 面板条目的统一投影（渲染与键盘导航共用） */
export interface PaletteEntry {
  kind: "command" | "skill";
  /** 命令为 `plan`（无斜杠）；技能为原技能名 */
  id: string;
  /** 显示文本：命令为 `/plan`，技能为技能名 */
  label: string;
  description: string;
  source: PaletteSource | "command";
  pending: boolean;
}

/** 命令注册表（顺序即默认展示顺序） */
export const COMMANDS: readonly PaletteCommand[] = [
  { name: "plan", description: "进入只读规划模式（M7-C）", pending: true },
  { name: "goal", description: "创建或查看线程目标（M7-C）", pending: true },
  { name: "best", description: "自动走完访谈→规格→拆票→实现（M7-C）", pending: true },
  { name: "clear", description: "清空当前会话上下文（不影响记忆）" },
  { name: "memory", description: "打开记忆页" },
  { name: "skill", description: "显式调用一个已装技能", takesArgument: true },
];

const SOURCE_LABEL: Record<PaletteSource, string> = {
  builtin: "内置",
  package: "技能包",
  mcp: "MCP",
};

export function sourceLabel(source: PaletteSource): string {
  return SOURCE_LABEL[source];
}

/** 技能区的分组顺序：内置 → 包 → MCP（稳定，不随输入乱序） */
const SOURCE_ORDER: readonly PaletteSource[] = ["builtin", "package", "mcp"];

/**
 * 输入文本是否应当打开面板。
 *
 * 只在**输入内容以 `/` 开头**时触发：聊天里正常提到路径（`/usr/local/bin`）
 * 或除法（`a/b`）都不该弹面板。
 */
export function shouldOpenPalette(draft: string): boolean {
  return draft.startsWith("/");
}

/** 从完整输入里取查询词（去掉前导 `/`）；`/skill foo` 的查询词是 `skill foo` */
export function queryOf(draft: string): string {
  return draft.startsWith("/") ? draft.slice(1) : draft;
}

/**
 * 匹配打分：前缀命中 > 词内命中 > 子序列命中；不命中返回 null。
 *
 * 分数越小越靠前。空查询视为全命中（分数 0），保持注册表原序。
 */
export function matchScore(haystack: string, query: string): number | null {
  if (query.length === 0) return 0;
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  if (h.startsWith(q)) return 0; // 前缀优先
  const idx = h.indexOf(q);
  if (idx >= 0) return 1; // 词内出现
  // 子序列兜底：`mmry` → `memory`
  let qi = 0;
  for (let i = 0; i < h.length && qi < q.length; i += 1) {
    if (h[i] === q[qi]) qi += 1;
  }
  return qi === q.length ? 2 : null;
}

/** 命令 → 面板条目 */
function commandEntry(command: PaletteCommand): PaletteEntry {
  return {
    kind: "command",
    id: command.name,
    label: `/${command.name}`,
    description: command.description,
    source: "command",
    pending: command.pending === true,
  };
}

/** 技能 → 面板条目 */
function skillEntry(skill: PaletteSkill): PaletteEntry {
  return {
    kind: "skill",
    id: skill.name,
    label: skill.name,
    description: skill.description,
    source: skill.source,
    pending: false,
  };
}

/**
 * 计算当前应展示的条目（已过滤 + 已排序）。
 *
 * 排序规则：先按匹配分数（前缀优先），同分保持原始顺序（命令在前、技能按来源分组）。
 * 空查询时命令全部展示、技能全部展示。
 */
export function visibleEntries(query: string, skills: readonly PaletteSkill[]): PaletteEntry[] {
  const trimmed = query.trim();
  const commands = COMMANDS.map(commandEntry);
  const skillEntries = SOURCE_ORDER.flatMap((source) =>
    skills.filter((skill) => skill.source === source).map(skillEntry),
  );

  const scored: Array<{ entry: PaletteEntry; score: number; order: number }> = [];
  const consider = (entry: PaletteEntry, order: number) => {
    // 命令按名字匹配，技能按名字匹配（描述不参与，避免"说不出为什么它出现了"）
    const score = matchScore(entry.id, trimmed);
    if (score === null) return;
    scored.push({ entry, score, order });
  };
  commands.forEach((entry, index) => consider(entry, index));
  skillEntries.forEach((entry, index) => consider(entry, commands.length + index));

  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.order - b.order));
  return scored.map((item) => item.entry);
}

/** 技能区按来源分组（渲染分层用，保持 SOURCE_ORDER 顺序，空组不返回） */
export function groupSkillsBySource(
  skills: readonly PaletteSkill[],
): Array<{ source: PaletteSource; label: string; skills: PaletteSkill[] }> {
  return SOURCE_ORDER.map((source) => ({
    source,
    label: SOURCE_LABEL[source],
    skills: skills.filter((skill) => skill.source === source),
  })).filter((group) => group.skills.length > 0);
}

/**
 * 键盘上下移动，**首尾循环**：`offset` 为 ±1。
 *
 * 面板只有几项，来回循环比"到顶就停住"更省一次方向键；索引始终落在 [0, length)。
 * 空列表返回 -1（调用方据此禁用确认）。
 */
export function moveIndex(current: number, offset: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return offset > 0 ? 0 : length - 1;
  return (current + offset + length) % length;
}

/** 命令执行意图（由调用方转换成真实动作） */
export type PaletteAction =
  | { kind: "pending"; command: string; message: string }
  | { kind: "clear-session" }
  | { kind: "open-memory" }
  | { kind: "invoke-skill"; name: string }
  | { kind: "run-command"; command: string };

/** 未实现命令的提示文案（统一口径，便于测试断言与后续替换） */
export function pendingMessage(command: string): string {
  const readable = command === "plan" ? "Plan 模式" : command === "goal" ? "Goal 模式" : "Best 模式";
  return `${readable}即将支持（M7-C），当前版本尚未实现。`;
}

/**
 * 把输入文本解析为动作。
 *
 * - `/clear` → 清会话上下文；`/memory` → 打开记忆页
 * - `/skill <name>` → 调用技能（缺参数返回 error）
 * - `/plan` `/goal` `/best` → pending 提示（**不是静默无反应**）
 * - 其他命令名 → run-command（留给调用方处理未知命令）
 * - 非 `/` 开头 → null（不是命令，按普通消息发送）
 */
export function parseAction(
  draft: string,
): PaletteAction | { kind: "error"; message: string } | null {
  if (!draft.startsWith("/")) return null;
  const parts = draft.slice(1).trim().split(/\s+/);
  const name = (parts[0] ?? "").toLowerCase();
  if (name.length === 0) return null; // 只输了 `/`：面板还开着，不发消息

  const command = COMMANDS.find((item) => item.name === name);
  if (command === undefined) {
    return { kind: "error", message: `未知命令：/${name}（输入 / 查看可用命令）` };
  }
  if (command.pending === true) {
    return { kind: "pending", command: name, message: pendingMessage(name) };
  }
  if (command.takesArgument === true) {
    const argument = parts.slice(1).join(" ").trim();
    if (argument.length === 0) {
      return { kind: "error", message: `/${name} 需要一个技能名，例如 /${name} my-skill` };
    }
    return { kind: "invoke-skill", name: argument };
  }
  if (name === "clear") return { kind: "clear-session" };
  if (name === "memory") return { kind: "open-memory" };
  return { kind: "run-command", command: name };
}

/** 面板状态（渲染用） */
export interface PaletteState {
  open: boolean;
  query: string;
  index: number;
}

export const initialPaletteState: PaletteState = { open: false, query: "", index: 0 };

export type PaletteEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "input"; draft: string }
  | { type: "move"; offset: number; length: number }
  | { type: "confirm"; length: number };

/**
 * 面板状态机（纯函数）：
 * - `input` 时按 draft 是否以 `/` 开头决定开关，并重置索引（查询变了旧索引无意义）
 * - `move` 用 moveIndex（含首尾循环）
 * - `confirm` 在空列表时不动（返回 close，避免"回车无事发生"的错觉）
 */
export function paletteReducer(state: PaletteState, event: PaletteEvent): PaletteState {
  switch (event.type) {
    case "open":
      return { open: true, query: "", index: 0 };
    case "close":
      return { ...initialPaletteState };
    case "input": {
      if (!shouldOpenPalette(event.draft)) return { ...initialPaletteState };
      return { open: true, query: queryOf(event.draft), index: 0 };
    }
    case "move":
      return state.open ? { ...state, index: moveIndex(state.index, event.offset, event.length) } : state;
    case "confirm":
      if (!state.open) return state;
      // 空列表时 Enter 不做事（面板保持打开，用户可继续改查询）
      if (event.length <= 0) return state;
      return { ...initialPaletteState };
    default:
      return state;
  }
}
