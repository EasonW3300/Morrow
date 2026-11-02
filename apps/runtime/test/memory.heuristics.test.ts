// 高价值记忆启发式（票 M1-T1 / Issue #13，FR-MEM-2）：确定性规则纯函数 seam。
// 规则清单与优先级：explicit-remember > preference-statement > fact-statement；
// 无命中（闲聊）返回 null。T2 后台抽取复用本模块。
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectHighValue } from "../src/memory/heuristics.ts";

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
