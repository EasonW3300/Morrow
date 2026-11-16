// `/` 命令面板纯逻辑测试（票 M7-B-T5 / Issue #69）。
// 覆盖：过滤（前缀优先/模糊兜底/空态）、来源分组、键盘索引边界（含首尾循环）、
// 命令分派、未实现命令的提示文案、面板状态机。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMANDS,
  groupSkillsBySource,
  matchScore,
  moveIndex,
  paletteReducer,
  parseAction,
  pendingMessage,
  queryOf,
  shouldOpenPalette,
  sourceLabel,
  visibleEntries,
  initialPaletteState,
  type PaletteSkill,
} from "./command-palette.ts";

const SKILLS: PaletteSkill[] = [
  { name: "brand-guidelines", description: "品牌规范", source: "package" },
  { name: "memory-write", description: "写入候选记忆", source: "builtin" },
  { name: "github-search", description: "搜索仓库", source: "mcp" },
  { name: "docx-to-markdown", description: "文档转换", source: "package" },
];

// --- 触发条件 -----------------------------------------------------------------------

test("只在输入以 / 开头时打开面板；路径与除法不误触", () => {
  assert.equal(shouldOpenPalette("/"), true);
  assert.equal(shouldOpenPalette("/mem"), true);
  assert.equal(shouldOpenPalette("看下 /usr/local/bin"), false, "聊天里提到路径不该弹面板");
  assert.equal(shouldOpenPalette("3/4 是多少"), false);
  assert.equal(shouldOpenPalette(""), false);
});

test("queryOf 去掉前导斜杠；非斜杠输入原样返回", () => {
  assert.equal(queryOf("/mem"), "mem");
  assert.equal(queryOf("/"), "");
  assert.equal(queryOf("plain"), "plain");
});

// --- 匹配打分 -----------------------------------------------------------------------

test("matchScore：前缀 0 < 词内 1 < 子序列 2；不命中 null；空查询 0", () => {
  assert.equal(matchScore("memory", "mem"), 0, "前缀优先");
  assert.equal(matchScore("open-memory", "mem"), 1, "词内出现");
  assert.equal(matchScore("memory", "mmry"), 2, "子序列兜底");
  assert.equal(matchScore("memory", "zzz"), null, "不命中");
  assert.equal(matchScore("memory", ""), 0, "空查询全命中");
  assert.equal(matchScore("MEMORY", "mem"), 0, "大小写不敏感");
});

// --- 过滤与排序 ---------------------------------------------------------------------

test("空查询：命令全部在前，技能按来源顺序（内置→包→MCP）", () => {
  const entries = visibleEntries("", SKILLS);
  const commands = entries.filter((e) => e.kind === "command");
  assert.equal(commands.length, COMMANDS.length);
  assert.equal(entries[0].kind, "command", "命令在最前");
  const skills = entries.filter((e) => e.kind === "skill");
  assert.deepEqual(
    skills.map((s) => s.id),
    ["memory-write", "brand-guidelines", "docx-to-markdown", "github-search"],
    "技能按内置→包→MCP 分组，组内保持原序",
  );
});

test("前缀命中排在词内命中之前", () => {
  const skills: PaletteSkill[] = [
    { name: "open-memory", description: "", source: "builtin" },
    { name: "memory-write", description: "", source: "builtin" },
  ];
  const entries = visibleEntries("mem", skills).filter((e) => e.kind === "skill");
  assert.deepEqual(entries.map((e) => e.id), ["memory-write", "open-memory"]);
});

test("子序列能匹配（mmry → memory），但只在没有更好命中时排在后面", () => {
  const skills: PaletteSkill[] = [{ name: "memory-write", description: "", source: "builtin" }];
  const bySubsequence = visibleEntries("mmrw", skills).filter((e) => e.kind === "skill");
  assert.deepEqual(bySubsequence.map((e) => e.id), ["memory-write"]);
});

test("无匹配返回空数组（UI 据此显示空态）", () => {
  assert.deepEqual(visibleEntries("zzzzz", SKILLS), []);
});

test("过滤只看名字不看描述（避免无法解释的命中）", () => {
  const skills: PaletteSkill[] = [{ name: "alpha", description: "beta gamma", source: "builtin" }];
  assert.deepEqual(visibleEntries("beta", skills), []);
});

// --- 分组与来源标签 -----------------------------------------------------------------

test("groupSkillsBySource：按内置→包→MCP 分组，空组不返回", () => {
  const groups = groupSkillsBySource(SKILLS);
  assert.deepEqual(groups.map((g) => g.source), ["builtin", "package", "mcp"]);
  assert.equal(groups[0].label, "内置");
  assert.equal(groups[1].skills.length, 2);
  assert.deepEqual(groupSkillsBySource([]), []);
});

test("sourceLabel 三种来源各有中文标签", () => {
  assert.equal(sourceLabel("builtin"), "内置");
  assert.equal(sourceLabel("package"), "技能包");
  assert.equal(sourceLabel("mcp"), "MCP");
});

// --- 键盘索引边界 -------------------------------------------------------------------

test("moveIndex：首项再上循环到末项，末项再下回到首项", () => {
  assert.equal(moveIndex(0, -1, 3), 2, "首项上移 → 末项");
  assert.equal(moveIndex(2, 1, 3), 0, "末项下移 → 首项");
  assert.equal(moveIndex(1, 1, 3), 2);
  assert.equal(moveIndex(1, -1, 3), 0);
});

test("moveIndex：空列表返回 -1；当前索引非法时按方向落到端点", () => {
  assert.equal(moveIndex(0, 1, 0), -1);
  assert.equal(moveIndex(-1, 1, 3), 0, "未选中时下移取首项");
  assert.equal(moveIndex(-1, -1, 3), 2, "未选中时上移取末项");
});

test("moveIndex：单项列表上下都是自己", () => {
  assert.equal(moveIndex(0, 1, 1), 0);
  assert.equal(moveIndex(0, -1, 1), 0);
});

// --- 命令分派 -----------------------------------------------------------------------

test("parseAction：非 / 开头返回 null（按普通消息发送）", () => {
  assert.equal(parseAction("你好"), null);
  assert.equal(parseAction(""), null);
});

test("parseAction：只输 / 不发消息（面板还开着）", () => {
  assert.equal(parseAction("/"), null);
  assert.equal(parseAction("/   "), null);
});

test("parseAction：/plan /goal /best 未实现 → pending 提示而非静默", () => {
  for (const name of ["plan", "goal", "best"]) {
    const action = parseAction(`/${name}`);
    assert.ok(action !== null);
    assert.equal(action.kind, "pending", `/${name} 应返回 pending`);
    if (action.kind === "pending") {
      assert.ok(action.message.includes("即将支持"), "提示必须说明即将支持");
      assert.ok(action.message.includes("M7-C"), "提示应指出所属阶段");
    }
  }
});

test("pendingMessage 三种模式各有可读文案", () => {
  assert.ok(pendingMessage("plan").includes("Plan 模式"));
  assert.ok(pendingMessage("goal").includes("Goal 模式"));
  assert.ok(pendingMessage("best").includes("Best 模式"));
  assert.equal(pendingMessage("unknown"), pendingMessage("best"), "未知命令归入 Best 文案（兜底）");
});

test("parseAction：/clear 与 /memory 分派到各自动作", () => {
  assert.deepEqual(parseAction("/clear"), { kind: "clear-session" });
  assert.deepEqual(parseAction("/memory"), { kind: "open-memory" });
  assert.deepEqual(parseAction("/CLEAR"), { kind: "clear-session" }, "大小写不敏感");
});

test("parseAction：/skill 缺参数返回可读错误，带参数返回调用意图", () => {
  const missing = parseAction("/skill");
  assert.ok(missing !== null);
  assert.equal(missing.kind, "error");
  if (missing.kind === "error") assert.ok(missing.message.includes("/skill"));

  assert.deepEqual(parseAction("/skill brand-guidelines"), {
    kind: "invoke-skill",
    name: "brand-guidelines",
  });
  // 技能名不含空格；多余空白归一为单个空格（`split(/\s+/)` 的既有行为，明确锁定）
  assert.deepEqual(parseAction("/skill   spaced   name "), {
    kind: "invoke-skill",
    name: "spaced name",
  }, "参数多余空白归一");
});

test("parseAction：未知命令返回错误提示（不静默忽略）", () => {
  const action = parseAction("/nope");
  assert.ok(action !== null);
  assert.equal(action.kind, "error");
  if (action.kind === "error") {
    assert.ok(action.message.includes("/nope"));
    assert.ok(action.message.includes("输入 / 查看可用命令"), "错误里给下一步");
  }
});

// --- 状态机 -------------------------------------------------------------------------

test("状态机：input 以 / 开头则打开并重置索引；否则关闭", () => {
  const opened = paletteReducer(initialPaletteState, { type: "input", draft: "/mem" });
  assert.equal(opened.open, true);
  assert.equal(opened.query, "mem");
  assert.equal(opened.index, 0);

  const moved = paletteReducer({ open: true, query: "mem", index: 2 }, { type: "input", draft: "/memx" });
  assert.equal(moved.index, 0, "查询变化后索引重置");

  const closed = paletteReducer(opened, { type: "input", draft: "普通消息" });
  assert.equal(closed.open, false);
});

test("状态机：move 在关闭时不动作；confirm 在空列表时不关闭面板", () => {
  const closed = initialPaletteState;
  assert.deepEqual(paletteReducer(closed, { type: "move", offset: 1, length: 3 }), closed);

  const open = { open: true, query: "zzz", index: 0 };
  assert.deepEqual(paletteReducer(open, { type: "confirm", length: 0 }), open, "空列表回车不关闭，可继续改查询");

  const confirmed = paletteReducer(open, { type: "confirm", length: 3 });
  assert.equal(confirmed.open, false, "有选中项时确认即关闭");
});

test("状态机：close 与 open 事件幂等", () => {
  const opened = paletteReducer(initialPaletteState, { type: "open" });
  assert.deepEqual(opened, { open: true, query: "", index: 0 });
  assert.deepEqual(paletteReducer(opened, { type: "close" }), initialPaletteState);
  assert.deepEqual(paletteReducer(initialPaletteState, { type: "close" }), initialPaletteState);
});
