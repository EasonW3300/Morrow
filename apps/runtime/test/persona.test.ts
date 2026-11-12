// Persona 拼装与校验单测（票 M7-A-T1 / Issue #58，ADR-0009）。
//
// 锁定的行为：
// - 默认人设（名字 Morrow / 语气简洁直接 / 职责个人助理与开发助手）；
// - 拼装顺序固定为 名字 → 语气 → 职责 → 禁止 → 其他（改顺序即红——缓存前缀稳定性
//   依赖这个顺序，顺序不可配置）；
// - PUT 校验边界（name 非空且 ≤40 字符；其余字段有上限）；
// - 记忆抽取器提示词前置人设段落，缺省（null）退回现有文案；
// - 任务规划器提示词不受 Persona 影响（规划器要求严格 JSON 输出，不注入人设）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createFakePi } from "@morrow/pi-adapter";
import { PLANNER_SYSTEM_PROMPT } from "../src/tasks.ts";
import {
  DEFAULT_PERSONA,
  PERSONA_LIMITS,
  composePersonaPrompt,
  parsePersona,
  type Persona,
} from "../src/persona.ts";
import {
  LLM_EXTRACTOR_SYSTEM_PROMPT,
  LlmMemoryExtractor,
  composeExtractorSystemPrompt,
} from "../src/memory/extraction.ts";

const FULL_PERSONA: Persona = {
  name: "小墨",
  tone: "温和但直接",
  responsibilities: ["个人助理", "开发助手"],
  prohibitions: ["不要编造事实", "不要泄露密钥"],
  extra: "回答时先给结论。",
};

test("默认人设：名字 Morrow、语气简洁直接、职责个人助理与开发助手、禁止与其他为空", () => {
  assert.deepEqual(DEFAULT_PERSONA, {
    name: "Morrow",
    tone: "简洁直接",
    responsibilities: ["个人助理与开发助手"],
    prohibitions: [],
    extra: "",
  });
});

test("拼装顺序固定：名字 → 语气 → 职责 → 禁止 → 其他（改顺序即红）", () => {
  const prompt = composePersonaPrompt(FULL_PERSONA);
  const marks = ["名字：小墨", "语气：温和但直接", "职责：", "禁止行为：", "其他设定："];
  const indices = marks.map((mark) => prompt.indexOf(mark));
  for (let i = 0; i < indices.length; i += 1) {
    assert.ok(indices[i] >= 0, `缺少段落：${marks[i]}`);
    if (i > 0) assert.ok(indices[i] > indices[i - 1], `顺序错误：${marks[i]} 必须在 ${marks[i - 1]} 之后`);
  }
  // 列表项内容也按输入顺序出现
  assert.ok(prompt.indexOf("- 个人助理") < prompt.indexOf("- 开发助手"));
  assert.ok(prompt.indexOf("- 不要编造事实") < prompt.indexOf("- 不要泄露密钥"));
});

test("空的可选段落被省略，但已有段落仍保持固定顺序", () => {
  const prompt = composePersonaPrompt({ ...DEFAULT_PERSONA, prohibitions: [], extra: "" });
  assert.ok(prompt.includes("名字：Morrow"));
  assert.ok(prompt.includes("语气：简洁直接"));
  assert.ok(prompt.includes("职责："));
  assert.ok(!prompt.includes("禁止行为："));
  assert.ok(!prompt.includes("其他设定："));
});

test("parsePersona：缺省字段回落到默认值，字符串与数组去空白", () => {
  const parsed = parsePersona({
    name: "  墨墨  ",
    tone: "  冷静  ",
    responsibilities: ["  写代码  "],
    prohibitions: [],
    extra: "  备注  ",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.persona, {
    name: "墨墨",
    tone: "冷静",
    responsibilities: ["写代码"],
    prohibitions: [],
    extra: "备注",
  });

  const empty = parsePersona({});
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.deepEqual(empty.persona, DEFAULT_PERSONA);
});

test("parsePersona：name 非空且 ≤40 字符；其余字段类型与上限非法即拒绝", () => {
  const cases: Array<[string, unknown]> = [
    ["名字为空", { name: "   " }],
    ["名字超长", { name: "x".repeat(PERSONA_LIMITS.name + 1) }],
    ["名字非字符串", { name: 123 }],
    ["语气超长", { tone: "x".repeat(PERSONA_LIMITS.tone + 1) }],
    ["职责不是数组", { responsibilities: "个人助理" }],
    ["职责项为空", { responsibilities: ["  "] }],
    ["职责项超长", { responsibilities: ["x".repeat(PERSONA_LIMITS.responsibilityItem + 1)] }],
    ["职责项过多", { responsibilities: Array.from({ length: PERSONA_LIMITS.responsibilities + 1 }, () => "x") }],
    ["禁止项超长", { prohibitions: ["x".repeat(PERSONA_LIMITS.prohibitionItem + 1)] }],
    ["其他超长", { extra: "x".repeat(PERSONA_LIMITS.extra + 1) }],
    ["其他非字符串", { extra: 1 }],
  ];
  for (const [label, raw] of cases) {
    const parsed = parsePersona(raw);
    assert.equal(parsed.ok, false, `${label} 应被拒绝`);
    if (parsed.ok) continue;
    assert.equal(parsed.code, "invalid_persona", `${label} 错误码`);
    assert.ok(parsed.message.length > 0, `${label} 错误信息非空`);
  }
});

test("抽取器提示词：有 Persona 时前置人设段落（称谓随名字变化），缺省退回现有文案", () => {
  const withPersona = composeExtractorSystemPrompt(FULL_PERSONA);
  assert.ok(withPersona.startsWith("以下是当前助手的人设"));
  assert.ok(withPersona.includes("名字：小墨"));
  assert.ok(withPersona.indexOf("名字：小墨") < withPersona.indexOf(LLM_EXTRACTOR_SYSTEM_PROMPT));
  assert.ok(withPersona.endsWith(LLM_EXTRACTOR_SYSTEM_PROMPT));

  assert.equal(composeExtractorSystemPrompt(null), LLM_EXTRACTOR_SYSTEM_PROMPT);

  const renamed = composeExtractorSystemPrompt({ ...FULL_PERSONA, name: "阿墨" });
  assert.notEqual(renamed, withPersona);
  assert.ok(renamed.includes("名字：阿墨"));
});

test("任务规划器提示词不受 Persona 影响（不得注入人设）", () => {
  assert.ok(!PLANNER_SYSTEM_PROMPT.includes("名字："));
  assert.ok(!PLANNER_SYSTEM_PROMPT.includes("语气："));
  assert.ok(!PLANNER_SYSTEM_PROMPT.includes(composePersonaPrompt(FULL_PERSONA)));
});

test("LlmMemoryExtractor 工厂实际收到随 Persona 变化的 systemPrompt（称谓改变）", async () => {
  const seen: string[] = [];
  let current: Persona = FULL_PERSONA;
  const extractor = new LlmMemoryExtractor(
    async (systemPrompt) => {
      seen.push(systemPrompt);
      return createFakePi({ script: [{ kind: "text", deltas: ["[]"] }] });
    },
    { persona: () => current },
  );
  const input = {
    sessionId: "s-1",
    userEventId: "e-1",
    occurredAt: "2026-11-12T00:00:00.000Z",
    userText: "我偏好红茶",
    recentUserTexts: ["我偏好红茶"],
  };
  await extractor.extract(input);
  current = { ...FULL_PERSONA, name: "阿墨" };
  await extractor.extract(input);

  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes("名字：小墨"));
  assert.ok(seen[1].includes("名字：阿墨"));
  assert.notEqual(seen[0], seen[1]);
});
