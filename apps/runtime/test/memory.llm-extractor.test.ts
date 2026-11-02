// LLM 抽取器（M1 code-review / Issue #14 补齐，FR-MEM-3）：经 PiAdapter 一次 prompt 的
// 候选抽取 + 坏输出返空数组不抛（fire-and-forget 后台链路，绝不破坏会话主链路）。
// FakePi 注入（零网络）；与默认启发式并存，config 选择（默认启发式）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type AgentRuntime, type FakeStep } from "@morrow/pi-adapter";
import {
  LlmMemoryExtractor,
  LLM_EXTRACTOR_SYSTEM_PROMPT,
  parseLlmCandidates,
  type ExtractionInput,
} from "../src/memory/extraction.ts";

const INPUT: ExtractionInput = {
  sessionId: "01936b9d-8f7a-7abc-9f2e-000000000002",
  userEventId: "evt-x",
  occurredAt: "2026-11-02T08:00:00.000Z",
  userText: "我住在杭州，以后部署前都先跑一遍冒烟",
  recentUserTexts: ["上次聊了部署流程", "我住在杭州，以后部署前都先跑一遍冒烟"],
};

function scriptedFactory(steps: FakeStep[]): () => Promise<AgentRuntime> {
  return async () => createFakePi({ script: steps, systemPrompt: LLM_EXTRACTOR_SYSTEM_PROMPT });
}

test("LlmMemoryExtractor：FakePi 脚本输出 JSON 候选数组 → 逐条校验为候选（rule=llm-extractor）", async () => {
  const candidates = [
    { content: "用户住在杭州", kind: "profile", confidence: 0.9, sensitivity: "private" },
    { content: "部署前先跑冒烟", kind: "procedural", confidence: 0.85 },
    { content: "口径外的噪声条目没有 kind 字段，应被丢弃" },
  ];
  const extractor = new LlmMemoryExtractor(
    scriptedFactory([{ kind: "text", deltas: [JSON.stringify(candidates)] }]),
  );
  const result = await extractor.extract(INPUT);
  assert.deepEqual(
    result.map((c) => [c.content, c.kind, c.sensitivity]),
    [
      ["用户住在杭州", "profile", "private"],
      ["部署前先跑冒烟", "procedural", "private"],
    ],
  );
  assert.ok(result.every((c) => c.rule === "llm-extractor"));
  assert.ok(result.every((c) => c.confidence > 0 && c.confidence <= 1));
});

test("LlmMemoryExtractor：坏输出返空数组不抛——非 JSON / 围栏外散文 / 全非法条目 / 运行错误", async () => {
  // 完全不是 JSON（模型跑题输出散文）
  const prose = new LlmMemoryExtractor(
    scriptedFactory([{ kind: "text", deltas: ["这轮没有什么值得记的。"] }]),
  );
  assert.deepEqual(await prose.extract(INPUT), []);

  // 代码围栏里是坏 JSON → 剥围栏后解析失败，同样空数组
  const fencedBad = new LlmMemoryExtractor(
    scriptedFactory([{ kind: "text", deltas: ["```json\n[{content: 没引号\n```"] }]),
  );
  assert.deepEqual(await fencedBad.extract(INPUT), []);

  // JSON 数组但条目全部非法（缺 content / kind 枚举外 / confidence 非数）→ 逐条丢弃后为空
  const allInvalid = new LlmMemoryExtractor(
    scriptedFactory([{
      kind: "text",
      deltas: [JSON.stringify([{ note: "no content" }, { content: "x", kind: "diary" }, { content: "y", confidence: "high" }])],
    }]),
  );
  assert.deepEqual(await allInvalid.extract(INPUT), []);

  // 运行错误（error 事件）→ 空数组不抛
  const errored = new LlmMemoryExtractor(
    scriptedFactory([
      { kind: "error", message: "provider down" },
      { kind: "text", deltas: [] },
    ]),
  );
  assert.deepEqual(await errored.extract(INPUT), []);

  // 纯函数面：非数组 JSON（对象）与空串同为空
  assert.deepEqual(parseLlmCandidates('{"candidates": []}'), []);
  assert.deepEqual(parseLlmCandidates(""), []);
});
