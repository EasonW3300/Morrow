// Generator 接口与默认实现测试（票 M2-T3 / Issue #24，FR-CAP-2）：
// PiCapabilityGenerator 经 AgentRuntime 接缝（FakePi 脚本化，零网络）把需求描述变成
// {manifest + ts 源码 + 四类测试用例} 的原始输出。失败一律结构化返回，绝不抛。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import {
  CAPABILITY_FACTORY_SYSTEM_PROMPT,
  PiCapabilityGenerator,
  type CapabilityGeneratorContext,
} from "../src/capabilities/factory/generator.ts";

const GRANTS = {
  filesystem: ["workspace://output/**"],
  network: ["api.github.com:443"],
  shell: ["read"],
  channels: ["desktop"],
  credentials: ["cred-github"],
};

function ctx(overrides: Partial<CapabilityGeneratorContext> = {}): CapabilityGeneratorContext {
  return {
    description: "slugify text for URLs",
    grants: GRANTS,
    existing: [{ name: "memory.write", description: null }],
    memoryHits: [],
    ...overrides,
  };
}

/** FakePi 脚本工厂：把给定文本按 text_delta 步骤发射（模拟模型流式输出） */
function scriptFor(text: string, chunk = 40): FakeStep[] {
  const deltas: string[] = [];
  for (let i = 0; i < text.length; i += chunk) deltas.push(text.slice(i, i + chunk));
  return [{ kind: "text", deltas }];
}

const PLAN_JSON = JSON.stringify({
  name: "text-slugify",
  version: "1.0.0",
  description: "Slugify free text into a URL-safe slug",
  permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output_schema: { type: "object", properties: { slug: { type: "string" } } },
  sandbox: { type: "container", network: "none", filesystem: "none" },
  dependencies: {},
  source: "export async function run(input: { text: string }): Promise<{ slug: string }> { return { slug: input.text.trim().toLowerCase() }; }",
  test_cases: [
    { case_id: "pos-basic", kind: "positive", input: { text: "Hello" }, expect: { outcome: "success", result: { slug: "hello" } } },
    { case_id: "neg-empty", kind: "negative", input: { text: "" }, expect: { outcome: "failure", errorContains: "empty" } },
    { case_id: "esc-1", kind: "privilege-escalation", input: { text: "x", path: "/etc/passwd" }, expect: { outcome: "failure" } },
    { case_id: "fault-1", kind: "fault", input: { text: 42 }, expect: { outcome: "failure" } },
  ],
});

test("合法计划：text_delta 拼接 → 剥 code fence → 结构化输出（不抛）", async () => {
  const fenced = "```json\n" + PLAN_JSON + "\n```";
  const gen = new PiCapabilityGenerator({
    runtimeFactory: async (prompt) => createFakePi({ script: scriptFor(fenced) }),
  });
  const result = await gen.generate(ctx());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.output.name, "text-slugify");
  assert.equal(result.output.test_cases.length, 4);
  assert.match(result.raw, /text-slugify/);
});

test("prompt 组装：携带需求描述、grant 面、现有能力与记忆命中（检索上下文注入）", async () => {
  let seenPrompt = "";
  const gen = new PiCapabilityGenerator({
    runtimeFactory: async (prompt) => {
      seenPrompt = prompt;
      return createFakePi({ script: scriptFor(PLAN_JSON) });
    },
  });
  await gen.generate(
    ctx({
      description: "convert docx to markdown",
      existing: [{ name: "memory.write", description: null }, { name: "docx-to-markdown", description: "Convert Word docx into markdown" }],
      memoryHits: [{ content: "上次用 pandoc 转过 docx", entry_kind: "fact" }],
    }),
  );
  assert.match(seenPrompt, /convert docx to markdown/);
  assert.match(seenPrompt, /api\.github\.com:443/);
  assert.match(seenPrompt, /docx-to-markdown/);
  assert.match(seenPrompt, /pandoc/);
  // 系统提示词进 runtimeFactory 的调用约定：factory 自带默认提示词常量
  assert.match(CAPABILITY_FACTORY_SYSTEM_PROMPT, /JSON/);
  assert.match(CAPABILITY_FACTORY_SYSTEM_PROMPT, /privilege-escalation/);
});

test("坏输出：空文本 / 无 JSON → no_output（携带原始输出尾段，不抛）", async () => {
  const empty = await new PiCapabilityGenerator({
    runtimeFactory: async () => createFakePi({ script: [{ kind: "text", deltas: [] }] }),
  }).generate(ctx());
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "no_output");

  const junk = await new PiCapabilityGenerator({
    runtimeFactory: async () => createFakePi({ script: scriptFor("I cannot help with that.") }),
  }).generate(ctx());
  assert.equal(junk.ok, false);
  if (!junk.ok) {
    assert.equal(junk.code, "no_output");
    assert.match(junk.detail, /JSON/);
    assert.match(junk.raw ?? "", /cannot help/);
  }
});

test("坏输出：JSON 截断（语法错）→ no_output 而非崩溃", async () => {
  const truncated = PLAN_JSON.slice(0, Math.floor(PLAN_JSON.length / 2));
  const result = await new PiCapabilityGenerator({
    runtimeFactory: async () => createFakePi({ script: scriptFor(truncated) }),
  }).generate(ctx());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "no_output");
});

test("运行错误：FakePi error 步骤 → runtime_error（agent_end 仍收尾）", async () => {
  const result = await new PiCapabilityGenerator({
    runtimeFactory: async () => createFakePi({ script: [{ kind: "error", message: "provider down" }] }),
  }).generate(ctx());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "runtime_error");
    assert.match(result.detail, /provider down/);
  }
});

test("工厂故障：runtimeFactory 抛错（无 Provider 等）→ runtime_error，不向调用方抛", async () => {
  const result = await new PiCapabilityGenerator({
    runtimeFactory: async () => {
      throw new Error("no model provider configured");
    },
  }).generate(ctx());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "runtime_error");
    assert.match(result.detail, /no model provider configured/);
  }
});

test("JSON 提取：混在散文里的完整 JSON 对象也能定位（首个平衡大括号）", async () => {
  const noisy = "Here is the plan you asked for:\n" + PLAN_JSON + "\nHope this helps!";
  const result = await new PiCapabilityGenerator({
    runtimeFactory: async () => createFakePi({ script: scriptFor(noisy) }),
  }).generate(ctx());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.output.name, "text-slugify");
});
