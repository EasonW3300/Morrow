// builtin 迁移测试（票 M2-T1 / Issue #22）：memory.write 迁移为注册表治理。
// 行为不变由既有 memory.api.test.ts 全量保证（同一 FakePi 流程仍绿）；本文件验证
// 治理面：启动 ensure-registered 幂等（重启不重复审计）、会话注入改查注册表
// （disable 后新会话不再注入，enable 恢复）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { MEMORY_WRITE_TOOL_NAME } from "../src/memory/tool.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function apiConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

/** 测试工厂：透传 runtime 注入的会话工具给 FakePi，并记录每会话拿到的工具名 */
function capturingFactory(script: FakeStep[], captured: string[][]) {
  return async (_sessionId: string, _provider: unknown, extras?: { tools?: MorrowTool[] }) => {
    captured.push((extras?.tools ?? []).map((tool) => tool.name));
    return createFakePi({ script, tools: extras?.tools ?? [] });
  };
}

async function allEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

async function lifecyclePost(runtime: RuntimeHandle, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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

async function send(port: number, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test("启动 ensure-registered：memory.write 注册为 builtin（human/enabled）且幂等（重启不重复审计）", async (t) => {
  const dir = tmpDir("morrow-cap-builtin-");
  t.after(() => removeDir(dir));
  const first = await startRuntime(apiConfig(dir));
  try {
    const events = await allEvents(first.port);
    const registered = events.filter((e) => e.event_type === "capability.registered" && e.payload.name === MEMORY_WRITE_TOOL_NAME);
    assert.equal(registered.length, 1, "首启恰好一条 builtin 注册审计");
    assert.equal(registered[0].actor_id, "agent:runtime");
    assert.equal(registered[0].payload.builtin, true);
    assert.equal(registered[0].payload.author, "human");

    const detail = await json<{ record: { version: string; author: string; runtime: string; status: string } }>(
      await fetch(`http://127.0.0.1:${first.port}/v1/capabilities/${MEMORY_WRITE_TOOL_NAME}`),
    );
    assert.equal(detail.record.status, "enabled");
    assert.equal(detail.record.author, "human");
    assert.equal(detail.record.runtime, "typescript");
  } finally {
    await first.close();
  }

  // 同 dataDir 重启：ensure-registered 幂等——无新 registered 事件
  const second = await startRuntime(apiConfig(dir));
  try {
    const events = await allEvents(second.port);
    assert.equal(
      events.filter((e) => e.event_type === "capability.registered" && e.payload.name === MEMORY_WRITE_TOOL_NAME).length,
      1,
      "重启不重复注册",
    );
    assert.ok(events.some((e) => e.event_type === "runtime.started"), "第二次启动有自己的 started 事件");
  } finally {
    await second.close();
  }
});

test("会话工具注入改查注册表：disable 后新会话不再注入 memory.write，enable 后恢复", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-cap-inject-"));
  t.after(() => removeDir(dir));
  const captured: string[][] = [];
  const runtime = await startRuntime(apiConfig(dir), {
    agentAdapterFactory: capturingFactory([{ kind: "text", deltas: ["ok"] }], captured),
  });
  try {
    // 默认（enabled）：新会话注入 memory.write（与迁移前一致）
    const sessionId = await createSession(runtime.port);
    await send(runtime.port, sessionId, "hello");
    await waitFor("assistant turn", async () =>
      (await allEvents(runtime.port)).some((e) => e.event_type === "message.assistant"),
    );
    assert.deepEqual(captured.at(-1), [MEMORY_WRITE_TOOL_NAME], "迁移前行为不变：会话注入 memory.write");

    // disable：新会话不再注入
    const disable = await lifecyclePost(runtime, `/v1/capabilities/${MEMORY_WRITE_TOOL_NAME}/disable`);
    assert.equal(disable.status, 200);
    const sessionId2 = await createSession(runtime.port);
    await send(runtime.port, sessionId2, "hello again");
    await waitFor("second assistant turn", async () =>
      (await allEvents(runtime.port)).filter((e) => e.event_type === "message.assistant").length >= 2,
    );
    assert.deepEqual(captured.at(-1), [], "注册表治理生效：disabled 能力不注入");

    // re-enable：恢复注入
    const enable = await lifecyclePost(runtime, `/v1/capabilities/${MEMORY_WRITE_TOOL_NAME}/enable`);
    assert.equal(enable.status, 200);
    const sessionId3 = await createSession(runtime.port);
    await send(runtime.port, sessionId3, "third");
    await waitFor("third assistant turn", async () =>
      (await allEvents(runtime.port)).filter((e) => e.event_type === "message.assistant").length >= 3,
    );
    assert.deepEqual(captured.at(-1), [MEMORY_WRITE_TOOL_NAME], "enable 后恢复注入");
  } finally {
    await runtime.close();
  }
});
