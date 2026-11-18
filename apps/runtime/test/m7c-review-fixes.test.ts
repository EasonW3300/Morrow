// M7-C code-review 修复批的回归测试。
//
// 三个真缺陷：
//   1. Plan 的只读白名单列了 6 个**都不存在**的工具名 → Plan 下工具集为空，
//      「只读研究」什么都做不了（FR-C1 只做到禁写、没做到能研究）；
//   2. Best 中止后承载 goal 仍 active → 续跑器继续拉起一个已放弃的目标；
//   3. Plan 退出后待回答问题残留 → 下次进 Plan 看到已作废的问题。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePi } from "@morrow/pi-adapter";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { builtinCapabilityManifests } from "../src/capabilities/builtin.ts";
import { PLAN_MODE_READONLY_CAPABILITIES } from "../src/plan/mode.ts";
import { UNBOUNDED_GOAL_RUN_LIMIT, hitUnboundedRunLimit } from "../src/goals/resume.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

test("修复 1：Plan 只读白名单不含空壳名字（每个都有实现）", () => {
  const existing = new Set(builtinCapabilityManifests().map((manifest) => manifest.name));
  for (const name of PLAN_MODE_READONLY_CAPABILITIES) {
    assert.equal(existing.has(name), true, `"${name}" 没有实现，会让 Plan 工具集为空`);
  }
  // 至少有一个真实的只读工具可用
  assert.ok(PLAN_MODE_READONLY_CAPABILITIES.includes("memory.search"));
});

test("修复 1b：memory.write 仍不在只读白名单里（边界没被放宽）", () => {
  assert.equal(PLAN_MODE_READONLY_CAPABILITIES.includes("memory.write"), false);
});

test("修复 4：无预算时的轮次兜底常量与判定", () => {
  assert.equal(UNBOUNDED_GOAL_RUN_LIMIT, 100);
  assert.equal(hitUnboundedRunLimit({ runs: 100, token_limit: null, time_limit_ms: null }), true);
  assert.equal(hitUnboundedRunLimit({ runs: 99, token_limit: null, time_limit_ms: null }), false);
});

interface Harness {
  handle: RuntimeHandle;
  port: number;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const dir = tmpDir("morrow-m7c-review-");
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

async function createSession(port: number): Promise<string> {
  return (await json<{ session_id: string }>(await post(port, "/v1/sessions", {}))).session_id;
}

test("修复 2：Best 中止后承载 goal 转为 complete（不再被续跑器拉起）", async () => {
  const h = await startHarness();
  try {
    const sessionId = await createSession(h.port);
    const started = await post(h.port, "/v1/best", { session_id: sessionId, idea: "会被中止的想法" });
    const run = (await json<{ run: { best_id: string; goal_id: string } }>(started)).run;

    // 中止前 goal 是 active
    const before = await json<{ goal: { status: string } }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/goals/${run.goal_id}`),
    );
    assert.equal(before.goal.status, "active");

    const aborted = await post(h.port, `/v1/best/${run.best_id}/abort`, { reason: "不做了" });
    assert.equal(aborted.status, 200);

    // 中止后 goal 必须停（否则续跑器会继续拉起一个已放弃的目标）
    const after = await json<{ goal: { status: string } }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/goals/${run.goal_id}`),
    );
    assert.equal(after.goal.status, "complete", `中止后 goal 应完成；实际 ${after.goal.status}`);

    // 也确保续跑器不会选它
    assert.deepEqual(h.handle.goalDriver.tick().started, []);
  } finally {
    await h.close();
  }
});

test("修复 3：Plan 退出后待回答问题被清掉（下次进来不看到作废的问题）", async () => {
  const h = await startHarness();
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    await post(h.port, `/v1/sessions/${sessionId}/plan/question`, {
      question: "这个问题的上下文马上就会失效",
      recommendation: "是",
      question_id: "q_stale",
    });
    // 确认确实登记了
    const pending = await json<{ pending: { question_id: string } | null }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/plan/question`),
    );
    assert.equal(pending.pending?.question_id, "q_stale");

    await post(h.port, `/v1/sessions/${sessionId}/plan/exit`);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);

    const after = await json<{ pending: unknown | null }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/plan/question`),
    );
    assert.equal(after.pending, null, "退出时该清掉待回答问题");
  } finally {
    await h.close();
  }
});
