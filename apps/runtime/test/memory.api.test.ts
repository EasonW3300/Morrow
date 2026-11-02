// 记忆垂直切片端到端测试（票 M1-T1 / Issue #13）：startRuntime 接线 +
// GET /v1/memory/facts。Agent Loop 经 PiAdapter 接口注入 FakePi（无网络）；
// 「告诉它一件事 → 检索到 → 回链到原始消息事件」是票面验收路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface MemoryFactsBody {
  q: string;
  facts: Array<{
    id: string;
    stage: string;
    type: string;
    content: string;
    sensitivity: string;
    confidence?: number;
    version: number;
    sources: string[];
    created_at: string;
  }>;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

/** 测试工厂：把 runtime 注入的 memory 工具透传给 FakePi（生产默认工厂透传给 PiAdapter） */
function fakeFactory(script: FakeStep[]) {
  return async (_sessionId: string, _provider: unknown, extras?: { tools?: MorrowTool[] }) =>
    createFakePi({ script, tools: extras?.tools ?? [] });
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function allEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

async function send(port: number, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
}

async function createSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
  return (await json<{ session_id: string }>(res)).session_id;
}

async function getFacts(port: number, q: string): Promise<{ status: number; body: MemoryFactsBody | ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/facts?q=${encodeURIComponent(q)}`);
  return { status: res.status, body: (await res.json()) as MemoryFactsBody | ApiError };
}

async function waitAssistant(port: number): Promise<void> {
  await waitFor("message.assistant", async () =>
    (await allEvents(port)).some((e) => e.event_type === "message.assistant"),
  );
}

/** 等本轮后台管线落定：memory.extracted 且 causation 指向最新 message.assistant
 *  （M1-T2：轮次收尾触发抽取→巩固，同一同步块内落账，看到 extracted 即整轮完成） */
async function waitTurnSettled(port: number): Promise<void> {
  await waitAssistant(port);
  const assistantId = (await allEvents(port))
    .filter((e) => e.event_type === "message.assistant")
    .at(-1)?.event_id;
  await waitFor("memory.extracted for this turn", async () =>
    (await allEvents(port)).some((e) => e.event_type === "memory.extracted" && e.causation_id === assistantId),
  );
}

test("端到端：显式『请记住 X』→ 候选 → FTS 检索 → 回链原始 message.user 事件；默认 private", async () => {
  const dir = tmpDir("morrow-mem-e2e-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["好的，已记住"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port);
    await send(runtime.port, sessionId, "请记住：我喜欢用 TypeScript 写脚本");
    // M1-T2：0.9 显式候选达巩固准入线，轮次收尾自动巩固成事实——等管线落定再断言
    await waitTurnSettled(runtime.port);

    // 账本里有 memory.candidate_created，causation 指向 message.user
    const events = await allEvents(runtime.port);
    const candidateEvents = events.filter((e) => e.event_type === "memory.candidate_created");
    assert.equal(candidateEvents.length, 1, "恰好一条候选事件");
    const candidateEvent = candidateEvents[0];
    assert.equal(candidateEvent.session_id, sessionId);
    const userEvent = events.find((e) => e.event_id === candidateEvent.causation_id);
    assert.ok(userEvent !== undefined, "causation 指向的原始事件在账本中");
    assert.equal(userEvent.event_type, "message.user");
    assert.equal(userEvent.session_id, sessionId);
    assert.match(String(userEvent.payload.text), /TypeScript/);
    assert.equal(candidateEvent.payload.sensitivity, "private", "新记忆默认 private");
    assert.equal(candidateEvent.payload.rule, "explicit-remember");

    // 检索命中并回链（M1-T2 巩固后：候选与事实统一索引，两条命中并存）
    const { status, body } = await getFacts(runtime.port, "TypeScript");
    assert.equal(status, 200);
    const facts = (body as MemoryFactsBody).facts;
    assert.equal(facts.length, 2);
    const factHit = facts.find((f) => f.stage === "fact");
    const candidateHit = facts.find((f) => f.stage === "candidate");
    assert.ok(factHit !== undefined && candidateHit !== undefined, "候选与事实同时命中");
    assert.equal(factHit.type, "fact");
    assert.equal(factHit.content, "我喜欢用 TypeScript 写脚本");
    assert.equal(factHit.sensitivity, "private");
    assert.deepEqual(factHit.sources, [userEvent.event_id], "事实 sources 回链原始事件 event_id");
    assert.equal(factHit.confidence, undefined, "事实无置信度（候选才有）");
    assert.equal(factHit.version, 1, "巩固后事实 v1");
    assert.equal(candidateHit.content, "我喜欢用 TypeScript 写脚本");
    assert.equal(typeof candidateHit.confidence, "number");
    assert.equal(candidateHit.version, 1);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("端到端：闲聊不产生候选，检索无结果，账本无记忆产出事件（仅抽取空运行留痕）", async () => {
  const dir = tmpDir("morrow-mem-chat-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["今天多云转晴"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port);
    await send(runtime.port, sessionId, "今天天气怎么样？");
    await waitTurnSettled(runtime.port);

    const { body } = await getFacts(runtime.port, "天气");
    assert.deepEqual((body as MemoryFactsBody).facts, []);
    const memoryEvents = (await allEvents(runtime.port)).filter((e) => e.event_type.startsWith("memory."));
    // M1-T2：抽取运行事件永远留痕（extracted_count=0 证明管线跑过且一无所获），
    // 其余 memory.* 事件（候选/巩固/事实/冲突）闲聊下一律不产生
    assert.deepEqual(
      memoryEvents.map((e) => [e.event_type, e.payload.extracted_count, e.payload.skipped_duplicates]),
      [["memory.extracted", 0, 0]],
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("端到端：memory.write 经 PiAdapter tools 通道被模型调用 → 候选 + 事件 + 检索", async () => {
  const dir = tmpDir("morrow-mem-tool-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([
      { kind: "tool", toolName: "memory.write", args: { content: "Owner 的时区是 Asia/Shanghai", sensitivity: "public" } },
      { kind: "text", deltas: ["已保存"] },
    ]),
  });
  try {
    const sessionId = await createSession(runtime.port);
    await send(runtime.port, sessionId, "我的时区是东八区，记一下");
    // M1-T2：工具写入的 0.9 候选在轮次收尾被自动巩固——等管线落定再断言
    await waitTurnSettled(runtime.port);

    // 工具确实经 tools 通道执行（tool.started / tool.finished 在账本）
    const events = await allEvents(runtime.port);
    const toolStart = events.find((e) => e.event_type === "tool.started");
    assert.ok(toolStart !== undefined, "memory.write 工具调用已入账本");
    assert.equal(toolStart.payload.tool_name, "memory.write");
    const toolEnd = events.find((e) => e.event_type === "tool.finished");
    assert.equal(toolEnd?.payload.is_error, false);

    const { body } = await getFacts(runtime.port, "Shanghai");
    const facts = (body as MemoryFactsBody).facts;
    const factHit = facts.find((f) => f.stage === "fact");
    assert.ok(factHit !== undefined, "工具写入候选经巩固成为事实");
    assert.equal(factHit.content, "Owner 的时区是 Asia/Shanghai");
    assert.equal(factHit.sensitivity, "public", "工具入参显式 sensitivity 透传");
    assert.equal(factHit.sources.length, 1);
    const sourceEvent = events.find((e) => e.event_id === factHit.sources[0]);
    assert.equal(sourceEvent?.event_type, "message.user");
    assert.equal(sourceEvent?.session_id, sessionId);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("GET /v1/memory/facts 入参校验：缺 q / 空 q → 400 invalid_query", async () => {
  const dir = tmpDir("morrow-mem-qsyntax-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([]),
  });
  try {
    const missing = await fetch(`http://127.0.0.1:${runtime.port}/v1/memory/facts`);
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as ApiError).error.code, "invalid_query");

    const blank = await fetch(`http://127.0.0.1:${runtime.port}/v1/memory/facts?q=%20%20`);
    assert.equal(blank.status, 400);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("重启幂等：同 dataDir 重开 runtime，迁移不抛错且既有记忆可检索", async () => {
  const dir = tmpDir("morrow-mem-restart-");
  let first: RuntimeHandle;
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["ok"] }]),
  });
  first = runtime;
  let sessionId: string;
  let sourceEventId: string;
  try {
    sessionId = await createSession(first.port);
    await send(first.port, sessionId, "记住仓库备用钥匙放在门框上");
    await waitTurnSettled(first.port);
    const events = await allEvents(first.port);
    sourceEventId = events.find((e) => e.event_type === "message.user")?.event_id ?? "";
  } finally {
    await first.close();
  }
  try {
    const reopened = await startRuntime(testConfig(dir), {
      agentAdapterFactory: fakeFactory([]),
    });
    const { body } = await getFacts(reopened.port, "钥匙");
    const facts = (body as MemoryFactsBody).facts;
    const factHit = facts.find((f) => f.stage === "fact");
    assert.ok(factHit !== undefined, "重启后 FTS 与数据仍在（事实可检索）");
    assert.deepEqual(factHit.sources, [sourceEventId]);
    await reopened.close();
  } finally {
    removeDir(dir);
  }
});
