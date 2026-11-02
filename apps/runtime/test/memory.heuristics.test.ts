// 高价值记忆启发式（票 M1-T1 / Issue #13，FR-MEM-2）：确定性规则纯函数 seam。
// 规则清单与优先级：explicit-remember > preference-statement > fact-statement；
// 无命中（闲聊）返回 null。T2 后台抽取复用本模块。
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAllHighValue, detectHighValue } from "../src/memory/heuristics.ts";
import { HeuristicExtractor } from "../src/memory/extraction.ts";

test("显式『记住 X』：提取关键词之后的内容（中文，剥离前导标点）", () => {
  const hit = detectHighValue("记住我家猫叫小白");
  assert.ok(hit !== null);
  assert.equal(hit.rule, "explicit-remember");
  assert.equal(hit.kind, "fact");
  assert.equal(hit.content, "我家猫叫小白");
  assert.ok(hit.confidence > 0 && hit.confidence <= 1);
});

test("显式『请记住：…』：前缀敬语与冒号不进内容", () => {
  const hit = detectHighValue("请记住：明早 9 点开站会");
  assert.ok(hit !== null);
  assert.equal(hit.rule, "explicit-remember");
  assert.equal(hit.content, "明早 9 点开站会");
});

test("显式英文 remember that：提取其后内容", () => {
  const hit = detectHighValue("remember that I have a dentist appointment on Friday");
  assert.ok(hit !== null);
  assert.equal(hit.rule, "explicit-remember");
  assert.equal(hit.content, "I have a dentist appointment on Friday");
});

test("偏好陈述（中文）：『我喜欢/我偏好/我习惯』整句入候选", () => {
  for (const text of ["我喜欢用 TypeScript 写脚本", "我偏好深色主题", "我习惯每天晨会前散步"]) {
    const hit = detectHighValue(text);
    assert.ok(hit !== null, `应命中偏好规则: ${text}`);
    assert.equal(hit.rule, "preference-statement");
    assert.equal(hit.kind, "preference");
    assert.equal(hit.content, text);
  }
});

test("偏好陈述（英文）", () => {
  const hit = detectHighValue("I prefer window seats on trains");
  assert.ok(hit !== null);
  assert.equal(hit.rule, "preference-statement");
  assert.equal(hit.kind, "preference");
});

test("多句文本：偏好只取命中句，不把闲聊句带进内容", () => {
  const hit = detectHighValue("今天有点累。我偏好早上跑步。明天再聊。");
  assert.ok(hit !== null);
  assert.equal(hit.rule, "preference-statement");
  assert.equal(hit.content, "我偏好早上跑步");
});

test("事实陈述：『我是/我在/我叫/My … is』→ profile", () => {
  for (const [text, kind] of [
    ["我是后端工程师", "profile"],
    ["我住在杭州", "profile"],
    ["My favorite editor is Neovim", "profile"],
  ] as const) {
    const hit = detectHighValue(text);
    assert.ok(hit !== null, `应命中事实规则: ${text}`);
    assert.equal(hit.rule, "fact-statement");
    assert.equal(hit.kind, kind);
  }
});

test("规则优先级：『记住我喜欢深色主题』按 explicit-remember 处理", () => {
  const hit = detectHighValue("记住我喜欢深色主题");
  assert.ok(hit !== null);
  assert.equal(hit.rule, "explicit-remember");
  assert.equal(hit.content, "我喜欢深色主题");
});

test("闲聊不命中：问候/请求/提问返回 null", () => {
  for (const text of [
    "今天天气怎么样？",
    "帮我写一个排序脚本",
    "你好呀",
    "把这段代码跑一下",
    "I forgot my keys yesterday",
    "",
  ]) {
    assert.equal(detectHighValue(text), null, `不应命中: ${text}`);
  }
});

test("『记住』后无内容：不产生空候选", () => {
  assert.equal(detectHighValue("记住"), null);
  assert.equal(detectHighValue("记住。"), null);
});

// --- 票 M1-T2 / Issue #14：后台抽取（detectAllHighValue 多句全量 + HeuristicExtractor）---

test("detectAllHighValue：多句全量扫描——每句至多一条、全部命中返回", () => {
  const matches = detectAllHighValue("今天有点累。我偏好早上跑步。我住在杭州。明天再聊。");
  assert.deepEqual(
    matches.map((m) => [m.rule, m.content]),
    [
      ["preference-statement", "我偏好早上跑步"],
      ["fact-statement", "我住在杭州"],
    ],
  );
  assert.deepEqual(matches.map((m) => m.confidence), [0.8, 0.7], "各规则固有的确定性置信度");
});

test("detectAllHighValue：单句命中与 T1 detectHighValue 一致（首条 = 即时写入路径）", () => {
  const all = detectAllHighValue("请记住：明早 9 点开站会");
  assert.equal(all.length, 1);
  assert.equal(all[0].rule, "explicit-remember");
  assert.equal(all[0].content, "明早 9 点开站会");
  assert.equal(all[0].kind, "fact");
});

test("detectAllHighValue：闲聊与空文本返回空数组（不产生候选）", () => {
  assert.deepEqual(detectAllHighValue("今天天气怎么样？"), []);
  assert.deepEqual(detectAllHighValue(""), []);
  assert.deepEqual(detectAllHighValue("   \n  "), []);
});

test("HeuristicExtractor（默认抽取器）：输出即候选形态，sensitivity 恒 private，rule 透传", () => {
  const extractor = new HeuristicExtractor();
  const candidates = extractor.extract({
    sessionId: "sess-x",
    userEventId: "evt-x",
    occurredAt: "2026-11-01T08:00:00.000Z",
    userText: "我喜欢用 Rust 写脚本。我住在上海。",
    recentUserTexts: ["我喜欢用 Rust 写脚本。我住在上海。"],
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => [c.kind, c.rule, c.sensitivity]),
    [
      ["preference", "preference-statement", "private"],
      ["profile", "fact-statement", "private"],
    ],
  );
  assert.ok(candidates.every((c) => c.confidence > 0 && c.confidence <= 1));
});

// --- M1 code-review / Issue #14 补齐：procedure-statement（第 4 规则，procedural 0.7）---

test("程序性陈述（中文）：『以后/下次/每次都/记得先』→ procedural 0.7", () => {
  for (const text of [
    "以后提交前都先跑一遍测试",
    "下次开会带上演示环境",
    "每次都先同步再动手写代码",
    "记得先拉最新分支再改",
  ]) {
    const hit = detectHighValue(text);
    assert.ok(hit !== null, `应命中程序性规则: ${text}`);
    assert.equal(hit.rule, "procedure-statement");
    assert.equal(hit.kind, "procedural");
    assert.equal(hit.confidence, 0.7);
    assert.equal(hit.content, text);
  }
});

test("程序性陈述（英文）：always / next time / from now on", () => {
  for (const text of [
    "Always run the linter before committing",
    "Next time deploy to staging first",
    "From now on we pair-review every PR",
  ]) {
    const hit = detectHighValue(text);
    assert.ok(hit !== null, `应命中程序性规则: ${text}`);
    assert.equal(hit.rule, "procedure-statement");
    assert.equal(hit.kind, "procedural");
    assert.equal(hit.confidence, 0.7);
  }
});

test("规则优先级：『记住以后……』按 explicit-remember 处理（程序性排最后）", () => {
  const hit = detectHighValue("记住以后每天站会前看板");
  assert.ok(hit !== null);
  assert.equal(hit.rule, "explicit-remember");
  assert.equal(hit.content, "以后每天站会前看板");
});

test("detectAllHighValue：程序性句与偏好句并存（各句各取，多句全量）", () => {
  const matches = detectAllHighValue("我偏好深色主题。以后改配置前先备份。");
  assert.deepEqual(
    matches.map((m) => [m.rule, m.kind, m.confidence]),
    [
      ["preference-statement", "preference", 0.8],
      ["procedure-statement", "procedural", 0.7],
    ],
  );
});
