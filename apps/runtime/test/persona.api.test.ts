// Persona 控制面（票 M7-A-T1 / Issue #58）HTTP 主接缝测试：
// - GET /v1/persona 缺省返回默认人设；
// - PUT 校验通过写 persona.updated（actor=owner，payload=全量 Persona）并可回读；
// - PUT 非法输入 400 invalid_persona 且不落事件；
// - 会话 system prompt 实际注入（FakePi 捕获工厂收到的 extras.systemPrompt，断言字段与顺序）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type AgentRuntime } from "@morrow/pi-adapter";
import { DEFAULT_PERSONA, type Persona } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import type { ResolvedProvider } from "../src/providers.ts";
import type { AgentRuntimeExtras } from "../src/sessions.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const CUSTOM_PERSONA: Persona = {
  name: "小墨",
  tone: "温和但直接",
  responsibilities: ["个人助理", "开发助手"],
  prohibitions: ["不要编造事实"],
  extra: "回答先给结论。",
};

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function getPersona(port: number): Promise<Persona> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/persona`);
  assert.equal(res.status, 200);
  return (await json<{ persona: Persona }>(res)).persona;
}

async function putPersona(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/persona`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function capturingFactory(observed: Array<{ systemPrompt?: string }>): (
  sessionId: string,
  provider: ResolvedProvider | null,
  extras?: AgentRuntimeExtras,
) => Promise<AgentRuntime> {
  return async (_sessionId, _provider, extras) => {
    observed.push({ ...(extras?.systemPrompt === undefined ? {} : { systemPrompt: extras.systemPrompt }) });
    return createFakePi({
      script: [{ kind: "text", deltas: ["好的"] }],
      ...(extras?.systemPrompt === undefined ? {} : { systemPrompt: extras.systemPrompt }),
    });
  };
}

async function createSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 201);
  return (await json<{ session_id: string }>(res)).session_id;
}

async function sendMessage(port: number, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
}

async function withRuntime(
  observed: Array<{ systemPrompt?: string }>,
  fn: (runtime: RuntimeHandle) => Promise<void>,
): Promise<void> {
  const dir = tmpDir("morrow-persona-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: capturingFactory(observed),
  });
  try {
    await fn(runtime);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
}

test("GET /v1/persona 首次（无事件）返回默认人设", async () => {
  await withRuntime([], async (runtime) => {
    assert.deepEqual(await getPersona(runtime.port), DEFAULT_PERSONA);
  });
});

test("PUT /v1/persona 校验通过：写 persona.updated 事件（actor=owner，全量 payload）并可回读", async () => {
  await withRuntime([], async (runtime) => {
    const res = await putPersona(runtime.port, CUSTOM_PERSONA);
    assert.equal(res.status, 200);
    const body = await json<{ persona: Persona; event_id: string; sequence: number; occurred_at: string }>(res);
    assert.deepEqual(body.persona, CUSTOM_PERSONA);
    assert.ok(typeof body.event_id === "string" && body.event_id.length > 0);
    assert.ok(typeof body.sequence === "number");

    assert.deepEqual(await getPersona(runtime.port), CUSTOM_PERSONA);

    const events = runtime.ledger.scan({ eventType: "persona.updated" });
    assert.equal(events.length, 1);
    assert.equal(events[0].envelope.actor_id, "owner");
    assert.deepEqual(events[0].envelope.payload, CUSTOM_PERSONA);
  });
});

test("PUT /v1/persona 非法输入 400 invalid_persona，且不写事件、不改当前值", async () => {
  await withRuntime([], async (runtime) => {
    const cases: unknown[] = [
      { ...CUSTOM_PERSONA, name: "   " },
      { ...CUSTOM_PERSONA, name: "x".repeat(41) },
      { ...CUSTOM_PERSONA, tone: 42 },
      { ...CUSTOM_PERSONA, responsibilities: "个人助理" },
      { ...CUSTOM_PERSONA, prohibitions: ["  "] },
      { ...CUSTOM_PERSONA, extra: "x".repeat(2001) },
    ];
    for (const body of cases) {
      const res = await putPersona(runtime.port, body);
      assert.equal(res.status, 400, `应拒绝：${JSON.stringify(body)}`);
      const err = await json<{ error: { code: string } }>(res);
      assert.equal(err.error.code, "invalid_persona");
    }
    assert.equal(runtime.ledger.scan({ eventType: "persona.updated" }).length, 0);
    assert.deepEqual(await getPersona(runtime.port), DEFAULT_PERSONA);
  });
});

test("会话 system prompt 注入当前 Persona：字段齐全且顺序为 名字→语气→职责→禁止→其他", async () => {
  const observed: Array<{ systemPrompt?: string }> = [];
  await withRuntime(observed, async (runtime) => {
    const put = await putPersona(runtime.port, CUSTOM_PERSONA);
    assert.equal(put.status, 200);

    const sessionId = await createSession(runtime.port);
    await sendMessage(runtime.port, sessionId, "你好");
    await waitFor("agent runtime created", () => observed.length === 1);

    const prompt = observed[0].systemPrompt;
    assert.ok(prompt !== undefined, "工厂应收到 extras.systemPrompt");
    assert.ok(prompt.includes("名字：小墨"));
    assert.ok(prompt.includes("语气：温和但直接"));
    assert.ok(prompt.includes("- 个人助理"));
    assert.ok(prompt.includes("禁止行为："));
    assert.ok(prompt.includes("- 不要编造事实"));
    assert.ok(prompt.includes("其他设定："));
    assert.ok(prompt.includes("回答先给结论。"));

    const order = ["名字：", "语气：", "职责：", "禁止行为：", "其他设定："].map((mark) => prompt.indexOf(mark));
    assert.ok(order.every((index) => index >= 0), "段落齐全");
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i] > order[i - 1], "拼装顺序必须固定");
    }
  });
});

test("未修改 Persona 时会话 system prompt 使用默认人设", async () => {
  const observed: Array<{ systemPrompt?: string }> = [];
  await withRuntime(observed, async (runtime) => {
    const sessionId = await createSession(runtime.port);
    await sendMessage(runtime.port, sessionId, "你好");
    await waitFor("agent runtime created", () => observed.length === 1);
    const prompt = observed[0].systemPrompt;
    assert.ok(prompt !== undefined);
    assert.ok(prompt.includes("名字：Morrow"));
    assert.ok(prompt.includes("语气：简洁直接"));
    assert.ok(prompt.includes("- 个人助理与开发助手"));
  });
});
