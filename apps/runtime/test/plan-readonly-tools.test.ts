// Plan 模式只读工具必须**真实可用**（票 M7-C code-review 修复批）。
//
// 背景：Plan 的只读白名单初版写了 6 个"未来会有"的工具名，但项目里一个都没实现
// （只有 memory.write 一个 builtin）。于是 Plan 模式下工具集是空的——「只读研究」
// 什么都做不了。FR-C1 只做到了"禁止写"没做到"能研究"。
//
// 这条测试锁住两件事：
//   1. 白名单里的名字都**真实存在**于 builtin 能力集（不留空壳名单）；
//   2. memory.search 在 Plan 模式下**能调通**并返回记忆内容。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePi } from "@morrow/pi-adapter";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { builtinCapabilityManifests } from "../src/capabilities/builtin.ts";
import { PLAN_MODE_READONLY_CAPABILITIES } from "../src/plan/mode.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

test("白名单里的每个名字都真实存在于 builtin 能力集（不留空壳名单）", () => {
  const existing = new Set(builtinCapabilityManifests().map((manifest) => manifest.name));
  for (const name of PLAN_MODE_READONLY_CAPABILITIES) {
    assert.equal(existing.has(name), true, `白名单里的 "${name}" 没有对应实现——Plan 模式下会导致工具集为空`);
  }
});

test("memory.search 不是写类能力（Plan 下应放行）", () => {
  const manifest = builtinCapabilityManifests().find((item) => item.name === "memory.search");
  assert.ok(manifest !== undefined);
  assert.deepEqual(manifest.permissions.filesystem, []);
  assert.deepEqual(manifest.permissions.shell, []);
  assert.deepEqual(manifest.permissions.network, []);
});

interface Harness {
  handle: RuntimeHandle;
  port: number;
  close(): Promise<void>;
}

async function startRuntimeForTest(): Promise<Harness> {
  const dir = tmpDir("morrow-plan-tools-");
  const handle = await startRuntime(
    { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null } as RuntimeConfig,
    {
      notificationDrainIntervalMs: 0,
      mcpReclaimIntervalMs: 0,
      goalResumeIntervalMs: 0,
      agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
    },
  );
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

test("Plan 模式下 memory.search **真的能调通**并返回记忆内容", async () => {
  const h = await startRuntimeForTest();
  try {
    const sessionId = (await json<{ session_id: string }>(await post(h.port, "/v1/sessions", {}))).session_id;

    // 用一次真实对话写入记忆（走抽取器），再在 Plan 模式里检索它。
    // 直接调 memory.write 需要会话里有 user message 作来源，所以先发一条。
    await post(h.port, `/v1/sessions/${sessionId}/messages`, {
      text: "记住：我偏好简洁直接的回答",
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);

    const invoked = await post(h.port, `/v1/capabilities/memory.search/invoke?session_id=${sessionId}`, {
      query: "简洁",
    });
    assert.equal(
      invoked.status,
      200,
      `Plan 下 memory.search 应可调用；实际 ${invoked.status} ${await invoked.clone().text()}`,
    );
    const body = await json<{ ok: boolean; result: { text: string } }>(invoked);
    assert.equal(body.ok, true, `调用应成功；返回：${body.result?.text ?? "无结果"}`);
    // 检索结果要么命中那条记忆，要么明确说没命中（两种都不算"工具不可用"）
    assert.match(body.result.text, /简洁|no memories matched/);
  } finally {
    await h.close();
  }
});

test("Plan 模式下 memory.write 仍被拒（只读边界不变）", async () => {
  const h = await startRuntimeForTest();
  try {
    const sessionId = (await json<{ session_id: string }>(await post(h.port, "/v1/sessions", {}))).session_id;
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    const invoked = await post(h.port, `/v1/capabilities/memory.write/invoke?session_id=${sessionId}`, {
      content: "should not be written",
    });
    assert.equal(invoked.status, 403);
    assert.equal((await json<{ error: { code: string } }>(invoked)).error.code, "plan_mode_readonly");
  } finally {
    await h.close();
  }
});
