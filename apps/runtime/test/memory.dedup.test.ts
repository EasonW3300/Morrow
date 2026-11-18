// 记忆候选去重（Issue #56）。
//
// 票面证据：一句「记住：我偏好用 TypeScript 写脚本工具，不喜欢 Python。」产出两条
// 语义重复的记忆——memory.write 工具写 kind=fact（近原文）、抽取器写 kind=preference
// （改写），两个机制叠加导致长期记忆里同一偏好存两份。
//
// 两层都要测：入口去重（不产第二条候选）与巩固同主题（跨 kind 也能认出来）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DUPLICATE_LENGTH_RATIO,
  DUPLICATE_SIMILARITY_THRESHOLD,
  findDuplicateContent,
  isLikelyDuplicateContent,
  jaccardSimilarity,
  memoryTokens,
  normalizeMemoryContent,
} from "../src/memory/dedup.ts";
import { DefaultConsolidator, type ConsolidationCandidateView, type ConsolidationFactView } from "../src/memory/consolidator.ts";

// --- 规范化与特征 ---------------------------------------------------------------

test("规范化：去空白/标点、转小写，保留 CJK 与字母数字", () => {
  assert.equal(normalizeMemoryContent("  我偏好 TypeScript。 "), "我偏好typescript");
  assert.equal(normalizeMemoryContent("a, b; c!"), "abc");
});

test("特征集：CJK 用二元组，ASCII 用整词", () => {
  const tokens = memoryTokens("我偏好TypeScript");
  assert.ok([...tokens].some((token) => token.startsWith("w:typescript")));
  assert.ok([...tokens].some((token) => token === "c:我偏"));
  assert.ok([...tokens].some((token) => token === "c:偏好"));
});

test("Jaccard：相同集合为 1，无交集为 0，空集为 0", () => {
  const a = new Set(["x", "y"]);
  assert.equal(jaccardSimilarity(a, new Set(["x", "y"])), 1);
  assert.equal(jaccardSimilarity(a, new Set(["z"])), 0);
  assert.equal(jaccardSimilarity(new Set(), a), 0);
});

// --- 重复判定（票面真实例子）----------------------------------------------------

test("**票面例子**：原文与改写版被判为重复", () => {
  // 证据里的两条：candidate 与 candidate（改写）
  const original = "我偏好用 TypeScript 写脚本工具，不喜欢 Python";
  const rewritten = "Owner 偏好用 TypeScript 写脚本工具，不喜欢 Python。";
  assert.equal(isLikelyDuplicateContent(original, rewritten), true);
});

test("不加主语/加标点的轻微改写也算重复", () => {
  assert.equal(
    isLikelyDuplicateContent("Owner 偏好简洁直接的回答", "我偏好简洁直接的回答。"),
    true,
  );
});

test("**语义不同的陈述不算重复**（宁严勿松）", () => {
  // 共享"我喜欢"，但对象不同——不能合并
  assert.equal(isLikelyDuplicateContent("我喜欢 TypeScript", "我喜欢 Rust"), false);
  assert.equal(isLikelyDuplicateContent("我的生日是 3 月 5 日", "我的时区是东京"), false);
  // 完全无关
  assert.equal(isLikelyDuplicateContent("项目用 pnpm 管理", "周末去爬山"), false);
});

test("**包含关系不算重复**（长度比闸门）", () => {
  const short = "我喜欢 TypeScript";
  const long = "我喜欢 TypeScript 但不喜欢它的类型体操，更偏好简单的写法";
  assert.equal(isLikelyDuplicateContent(short, long), false, "信息量不同，不该合并");
});

test("空内容不判重复（避免把空串当万能匹配）", () => {
  assert.equal(isLikelyDuplicateContent("", ""), false);
  assert.equal(isLikelyDuplicateContent("  。 ", "任何内容"), false);
});

test("阈值是显式的、可断言的（调它要改测试）", () => {
  assert.equal(DUPLICATE_SIMILARITY_THRESHOLD, 0.7);
  assert.equal(DUPLICATE_LENGTH_RATIO, 0.5);
});

test("findDuplicateContent：在一组里找出重复的那条", () => {
  const existing = ["项目用 pnpm 管理", "我偏好用 TypeScript 写脚本工具，不喜欢 Python"];
  assert.equal(
    findDuplicateContent("Owner 偏好用 TypeScript 写脚本工具，不喜欢 Python。", existing),
    "我偏好用 TypeScript 写脚本工具，不喜欢 Python",
  );
  assert.equal(findDuplicateContent("周末去爬山", existing), null);
});

// --- 巩固器：跨 kind 的同主题 ---------------------------------------------------

function candidate(overrides: Partial<ConsolidationCandidateView> = {}): ConsolidationCandidateView {
  return {
    candidateId: "cand_2",
    content: "Owner 偏好用 TypeScript 写脚本工具，不喜欢 Python。",
    kind: "preference",
    sensitivity: "private",
    confidence: 0.95,
    sourceId: "source_2",
    scope: "owner",
    ...overrides,
  };
}

function fact(overrides: Partial<ConsolidationFactView> = {}): ConsolidationFactView {
  return {
    factId: "fact_1",
    content: "我偏好用 TypeScript 写脚本工具，不喜欢 Python",
    kind: "fact",
    sensitivity: "private",
    version: 1,
    ...overrides,
  };
}

test("**跨 kind 但内容重复 → corroborate**（不再各自 create_fact）", () => {
  const consolidator = new DefaultConsolidator();
  const actions = consolidator.consolidate({ candidates: [candidate()], facts: [fact()] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "corroborate", `实际 ${actions[0].action}`);
});

test("跨 kind 命中是 corroborate 而不是 update_fact（不改写既有 kind 语义）", () => {
  const consolidator = new DefaultConsolidator();
  // 候选是 preference、事实是 fact：若走 update_fact 会把事实"变成偏好"
  const actions = consolidator.consolidate({ candidates: [candidate()], facts: [fact()] });
  assert.notEqual(actions[0].action, "update_fact");
});

test("跨 kind 但内容**不**重复 → 仍各自 create_fact（不误合并）", () => {
  const consolidator = new DefaultConsolidator();
  const actions = consolidator.consolidate({
    candidates: [candidate({ content: "项目用 pnpm 管理依赖" })],
    facts: [fact({ content: "我的生日是 3 月 5 日" })],
  });
  assert.equal(actions[0].action, "create_fact");
});

test("同 kind 的既有行为不变：preference 命中 → update_fact", () => {
  const consolidator = new DefaultConsolidator();
  const actions = consolidator.consolidate({
    candidates: [candidate({ content: "我偏好用 TypeScript 写脚本工具" })],
    facts: [fact({ content: "我偏好用 Python 写脚本工具", kind: "preference" })],
  });
  assert.equal(actions[0].action, "update_fact");
});

test("同 kind 且内容相同 → corroborate（既有行为）", () => {
  const consolidator = new DefaultConsolidator();
  const actions = consolidator.consolidate({
    candidates: [candidate({ content: "项目用 pnpm", kind: "fact" })],
    facts: [fact({ content: "项目用 pnpm", kind: "fact" })],
  });
  assert.equal(actions[0].action, "corroborate");
});

test("locked 事实：内容重复 → corroborate（安全，不改写）；内容不同 → escalate locked", () => {
  const consolidator = new DefaultConsolidator();

  // 内容重复：corroborate 只补来源、不改写，对 locked 也是安全的
  const same = consolidator.consolidate({
    candidates: [candidate()],
    facts: [fact({ sensitivity: "locked" })],
  });
  assert.equal(same[0].action, "corroborate", "内容相同只补来源，不触碰 locked 内容");

  // 内容不同（语义确实是另一个偏好）：必须 escalate，绝不静默覆盖
  const different = consolidator.consolidate({
    candidates: [candidate({ content: "Owner 更偏好用 Rust 做系统编程语言" })],
    facts: [fact({ content: "我的生日是 3 月 5 日", sensitivity: "locked" })],
  });
  assert.equal(different[0].action, "create_fact", "语义无关时应新建，不是 escalate");

  // locked + 同 kind + 有交集但内容不同 → escalate locked（既有行为不变）
  const lockedConflict = consolidator.consolidate({
    candidates: [candidate({ content: "我偏好用 TypeScript 写脚本工具", kind: "preference" })],
    facts: [fact({ content: "我偏好用 Python 写脚本工具", kind: "preference", sensitivity: "locked" })],
  });
  assert.equal(lockedConflict[0].action, "escalate");
  if (lockedConflict[0].action === "escalate") assert.equal(lockedConflict[0].reason, "locked");
});
