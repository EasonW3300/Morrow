// Consolidator 契约测试（票 M1-T2 / Issue #14）：默认确定性巩固器的决策矩阵。
// 纯函数 seam：输入 = 待巩固候选批次 + 现存事实视图，输出 = 巩固动作列表，
// 每条候选恰好一个动作、顺序与输入一致（写路径在 MemoryService，不在本 seam）。
//
// 冲突规则口径（PRD §4.1 FR-MEM-5 / GLOSSARY Sensitivity Level）：
//   同主题判定   = kind 相同 且 显著词元交集非空（ASCII 词 ≥2 字符 + CJK 单字去停用字）
//   印证         = 归一化内容与既有事实相同 → 只挂来源，不改写（locked 也允许印证）
//   locked 冲突  = 既有事实 locked 且内容不同 → 上报（永不自动改写）
//   敏感冲突     = 候选与既有事实敏感等级不同 → 上报（可见性分级不静默变更）
//   偏好更新     = 同主题 preference 且无上述情形 → 自动更新（版本链留历史）
//   重大事实冲突 = 同主题 fact/profile/procedural 且内容不同 → 上报待确认
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntryKind } from "@morrow/protocol";
import {
  DefaultConsolidator,
  type ConsolidationAction,
  type ConsolidationCandidateView,
  type ConsolidationFactView,
} from "../src/memory/consolidator.ts";

function candidate(overrides: Partial<ConsolidationCandidateView> = {}): ConsolidationCandidateView {
  return {
    candidateId: "cand-1",
    content: "我喜欢用 Rust 写脚本",
    kind: "preference",
    sensitivity: "private",
    confidence: 0.8,
    sourceId: "src-1",
    ...overrides,
  };
}

function fact(overrides: Partial<ConsolidationFactView> = {}): ConsolidationFactView {
  return {
    factId: "fact-1",
    content: "我喜欢用 TypeScript 写脚本",
    kind: "preference",
    sensitivity: "private",
    version: 1,
    ...overrides,
  };
}

function run(candidates: ConsolidationCandidateView[], facts: ConsolidationFactView[]): ConsolidationAction[] {
  return new DefaultConsolidator().consolidate({ candidates, facts });
}

function escalateOf(actions: ConsolidationAction[]): Extract<ConsolidationAction, { action: "escalate" }> {
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "escalate");
  return actions[0] as Extract<ConsolidationAction, { action: "escalate" }>;
}

test("无匹配事实（不同 kind / 无词元交集）→ create_fact", () => {
  // kind 不同：偏好候选不匹配画像事实
  const kindMismatch = run([candidate()], [fact({ kind: "profile", content: "我住在上海" })]);
  assert.deepEqual(kindMismatch, [
    { action: "create_fact", candidateId: "cand-1", content: "我喜欢用 Rust 写脚本", kind: "preference", sensitivity: "private" },
  ]);

  // 词元无交集：同 kind 但主题无关
  const noOverlap = run([candidate({ content: "我喜欢深夜工作" })], [fact({ content: "我住在海南岛" })]);
  assert.deepEqual(noOverlap, [
    { action: "create_fact", candidateId: "cand-1", content: "我喜欢深夜工作", kind: "preference", sensitivity: "private" },
  ]);
});

test("空事实表 → create_fact；多条候选逐条独立决策、顺序保持", () => {
  const actions = run(
    [
      candidate({ candidateId: "cand-a", content: "我住在上海" }),
      candidate({ candidateId: "cand-b", content: "我喜欢用 Rust 写脚本" }),
    ],
    [],
  );
  assert.deepEqual(
    actions.map((a) => a.action),
    ["create_fact", "create_fact"],
  );
  assert.equal((actions[0] as Extract<ConsolidationAction, { action: "create_fact" }>).content, "我住在上海");
  assert.equal((actions[1] as Extract<ConsolidationAction, { action: "create_fact" }>).candidateId, "cand-b");
});

test("同主题同内容（归一化后）→ corroborate，不改写既有事实", () => {
  const actions = run(
    [candidate({ content: "我 喜欢用  TypeScript 写脚本 " })],
    [fact({ content: "我喜欢用 typescript 写脚本" })],
  );
  assert.deepEqual(actions, [{ action: "corroborate", factId: "fact-1", candidateId: "cand-1" }]);
});

test("同主题偏好且敏感等级一致 → update_fact 自动更新（FR-MEM-5 低风险路径）", () => {
  const actions = run([candidate({ content: "我现在偏好用 Go 写脚本" })], [fact()]);
  assert.deepEqual(actions, [
    { action: "update_fact", factId: "fact-1", candidateId: "cand-1", content: "我现在偏好用 Go 写脚本", sensitivity: "private", reason: "preference_update" },
  ]);
});

test("同主题非偏好（fact/profile/procedural）内容不同 → escalate fact_conflict", () => {
  for (const kind of ["fact", "profile", "procedural"] as MemoryEntryKind[]) {
    const escalate = escalateOf(run(
      [candidate({ kind, content: "我住在上海浦东" })],
      [fact({ kind, content: "我住在北京朝阳" })],
    ));
    assert.deepEqual(
      { factId: escalate.factId, candidateId: escalate.candidateId, reason: escalate.reason },
      { factId: "fact-1", candidateId: "cand-1", reason: "fact_conflict" },
      `kind=${kind}`,
    );
    assert.equal(escalate.existingContent, "我住在北京朝阳");
    assert.equal(escalate.incomingContent, "我住在上海浦东");
  }
});

test("locked 事实内容不同 → escalate locked（连偏好也不自动改写，GLOSSARY：禁止一切自动改写）", () => {
  const escalate = escalateOf(run(
    [candidate({ content: "我现在偏好用 Go 写脚本" })],
    [fact({ sensitivity: "locked" })],
  ));
  assert.deepEqual(
    { factId: escalate.factId, reason: escalate.reason },
    { factId: "fact-1", reason: "locked" },
  );
  assert.equal(escalate.existingContent, "我喜欢用 TypeScript 写脚本");
  assert.equal(escalate.incomingContent, "我现在偏好用 Go 写脚本");
});

test("locked 事实内容相同 → 仍可 corroborate（印证不是改写）", () => {
  const actions = run([candidate({ content: "我喜欢用 TypeScript 写脚本" })], [fact({ sensitivity: "locked" })]);
  assert.deepEqual(actions, [{ action: "corroborate", factId: "fact-1", candidateId: "cand-1" }]);
});

test("敏感等级不同 → escalate sensitivity_change（可见性分级不静默变更，含放宽方向）", () => {
  // 候选更敏感：public 事实 vs private 候选
  const escalateUp = escalateOf(run([candidate()], [fact({ sensitivity: "public" })]));
  assert.equal(escalateUp.reason, "sensitivity_change");

  // 候选放宽：private 事实 vs public 候选——静默放宽可见性同样危险，同样上报
  const escalateDown = escalateOf(run([candidate({ sensitivity: "public" })], [fact()]));
  assert.equal(escalateDown.reason, "sensitivity_change");
});

test("多条事实匹配时选词元交集最大者（确定性最优匹配）", () => {
  const escalate = escalateOf(run(
    [candidate({ content: "我住在上海浦东新区", kind: "profile" })],
    [
      fact({ factId: "fact-old", content: "我住在静安寺", kind: "profile", version: 3 }),
      fact({ factId: "fact-new", content: "我住在上海虹桥", kind: "profile" }),
    ],
  ));
  // "住/上/海/浦/东/新/区" 与 "住/上/海/虹/桥" 交集 3 > 与 "住/静/安/寺" 交集 1
  assert.equal(escalate.factId, "fact-new");
  assert.equal(escalate.reason, "fact_conflict");
});

test("候选自带 locked 敏感等级的全新主题不受影响（locked 只约束既有事实的改写）", () => {
  const actions = run(
    [candidate({ content: "保险箱密码在书房第三格", kind: "fact", sensitivity: "locked" })],
    [],
  );
  assert.deepEqual(actions, [
    { action: "create_fact", candidateId: "cand-1", content: "保险箱密码在书房第三格", kind: "fact", sensitivity: "locked" },
  ]);
});
