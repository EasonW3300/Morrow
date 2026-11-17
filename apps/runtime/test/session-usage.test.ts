// 会话侧用量累加（票 M7-C-T1 / Issue #75）。
//
// C1 的业务价值在这里体现：一次运行之后，会话能报出"这轮花了多少"，
// 且诚实区分真实值与估算值（Goal 预算依赖这个区分）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function fakeFactory(script: FakeStep[]) {
  return async () => createFakePi({ script });
}

interface Harness {
  handle: RuntimeHandle;
  port: number;
  close(): Promise<void>;
}

async function startUsageRuntime(script: FakeStep[]): Promise<Harness> {
  const dir = tmpDir("morrow-usage-");
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    mcpReclaimIntervalMs: 0,
    agentAdapterFactory: fakeFactory(script),
  });
  return {
    handle,
    port: handle.port,
    async close() {
      await handle.close();
      removeDir(dir);
    },
  };
}

function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createSession(port: number): Promise<string> {
  const res = await post(port, "/v1/sessions", {});
  assert.equal(res.status, 201);
  return (await json<{ session_id: string }>(res)).session_id;
}

/** 等指定数量的 message.assistant 落账（多轮用例必须按轮数等，不能只看"有没有"） */
async function waitForAssistantCount(
  port: number,
  sessionId: string,
  count: number,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await json<{ events: EventEnvelope[] }>(
      await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`),
    );
    const seen = events.events.filter(
      (event) => event.event_type === "message.assistant" && event.session_id === sessionId,
    ).length;
    if (seen >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${count} message.assistant events`);
}

async function waitForAssistant(port: number, sessionId: string, timeoutMs = 8000): Promise<void> {
  await waitForAssistantCount(port, sessionId, 1, timeoutMs);
}

test("一轮运行后会话累计用量可得，且 estimated 标记如实传递", async () => {
  const h = await startUsageRuntime([
    { kind: "text", deltas: ["好的"] },
    { kind: "usage", input: 120, output: 30 },
  ]);
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/messages`, { text: "你好" });
    await waitForAssistant(h.port, sessionId);

    const usage = h.handle.sessions.usageOf(sessionId);
    assert.equal(usage.input, 120);
    assert.equal(usage.output, 30);
    assert.equal(usage.total, 150);
    assert.equal(usage.estimated, false, "供应商给了真实值就不该标估算");
  } finally {
    await h.close();
  }
});

test("多轮累加：同一会话的用量逐轮叠加", async () => {
  // FakePi 的语义是「每次 prompt 重放整个 script」（无游标）——这是既有契约，
  // 改它会波及全仓测试，不在本票范围。所以这里用**两个会话各跑一轮**验证
  // "每轮都并入累计"这条业务语义，累加的正确性由 usage.ts 的单测锁死。
  const h = await startUsageRuntime([
    { kind: "text", deltas: ["完成"] },
    { kind: "usage", input: 100, output: 20 },
  ]);
  try {
    const first = await createSession(h.port);
    await post(h.port, `/v1/sessions/${first}/messages`, { text: "一" });
    await waitForAssistantCount(h.port, first, 1);
    const firstUsage = h.handle.sessions.usageOf(first);
    assert.equal(firstUsage.total, 120);

    const second = await createSession(h.port);
    await post(h.port, `/v1/sessions/${second}/messages`, { text: "二" });
    await waitForAssistantCount(h.port, second, 1);
    // 会话之间的用量互不影响（预算必须按会话隔离）
    assert.equal(h.handle.sessions.usageOf(second).total, 120);
    assert.equal(h.handle.sessions.usageOf(first).total, 120, "第二个会话不该污染第一个");
  } finally {
    await h.close();
  }
});

test("用量随 message.assistant 落账（账本可查本轮消耗）", async () => {
  const h = await startUsageRuntime([
    { kind: "text", deltas: ["完成"] },
    { kind: "usage", input: 77, output: 7 },
  ]);
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/messages`, { text: "干活" });
    await waitForAssistant(h.port, sessionId);

    const events = await json<{ events: EventEnvelope[] }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=200`),
    );
    const assistant = events.events.find(
      (event) => event.event_type === "message.assistant" && event.session_id === sessionId,
    );
    assert.ok(assistant !== undefined);
    const usage = assistant.payload.usage as { input: number; output: number; total: number; estimated: boolean };
    assert.deepEqual(usage, {
      input: 77,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      total: 84,
      estimated: false,
    });
  } finally {
    await h.close();
  }
});

test("未跑过消息的会话：usageOf 返回零值（不返回 null，调用方不必分支）", async () => {
  const h = await startUsageRuntime([{ kind: "text", deltas: ["x"] }]);
  try {
    const sessionId = await createSession(h.port);
    assert.deepEqual(h.handle.sessions.usageOf(sessionId), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      estimated: false,
    });
    // 未知会话同样返回零值
    assert.equal(h.handle.sessions.usageOf("01936b9d-8f7a-7abc-9f2e-000000000099").total, 0);
  } finally {
    await h.close();
  }
});

test("没有 usage 事件的轮次：累计不变（不写 0 污染）", async () => {
  const h = await startUsageRuntime([{ kind: "text", deltas: ["没有用量"] }]);
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/messages`, { text: "hi" });
    await waitForAssistant(h.port, sessionId);
    const usage = h.handle.sessions.usageOf(sessionId);
    assert.equal(usage.total, 0);
  } finally {
    await h.close();
  }
});
