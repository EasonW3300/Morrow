// 执行租约 HTTP 端点测试（M3-T4 / Issue #33，PRD §6.2 / FR-DEP-4）：
// GET /v1/tasks/:id/execution、POST /v1/tasks/:id/transfer-execution、
// POST /v1/tasks/:id/reconcile[/detect]。FakePi 注入（零网络）；节点 hang 用于在
// 「执行中」观察租约，转移端点 release 后目标副本 acquire token+1。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { ExecutionLease, TaskDetail } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

const SINGLE_PLAN = planJson([
  { key: "a", title: "A", goal: "do a", depends_on: [], retriable: false, side_effect: "reversible" },
]);

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

interface Harness {
  runtime: RuntimeHandle;
  base: string;
  dir: string;
  close(): Promise<void>;
}

async function openRuntime(script: FakeStep[]): Promise<Harness> {
  const dir = tmpDir("morrow-lease-api-");
  const runtime = await startRuntime(testConfig(dir), {
    leaseTtlMs: 5_000,
    leaseHeartbeatMs: 50,
    taskPlannerFactory: async () =>
      createFakePi({ script: [{ kind: "text", deltas: [SINGLE_PLAN] }] }),
    taskNodeAgentFactory: async () => createFakePi({ script }),
  });
  return { runtime, base: `http://127.0.0.1:${runtime.port}`, dir, close: () => runtime.close() };
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function createTask(h: Harness): Promise<TaskDetail> {
  const res = await fetch(`${h.base}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "lease api" }),
  });
  assert.equal(res.status, 201);
  return json<TaskDetail>(res);
}

interface ExecutionBody {
  task_id: string;
  status: string;
  lease: ExecutionLease | null;
  needs_reconcile: boolean;
  evidence: { replicas: string[] } | null;
}

async function getExecution(h: Harness, taskId: string): Promise<ExecutionBody> {
  const res = await fetch(`${h.base}/v1/tasks/${taskId}/execution`);
  assert.equal(res.status, 200);
  return json<ExecutionBody>(res);
}

test("执行中 GET /execution 显示租约；transfer-execution 释放后目标副本 acquire token+1", async () => {
  const h = await openRuntime([{ kind: "hang" }]);
  try {
    const created = await createTask(h);
    await waitFor("lease active", async () => {
      const body = await getExecution(h, created.task_id);
      return body.lease?.active === true;
    });
    const before = await getExecution(h, created.task_id);
    assert.equal(before.lease?.holder_replica_id, REPLICA);
    assert.equal(before.lease?.fencing_token, 1);

    const res = await fetch(`${h.base}/v1/tasks/${created.task_id}/transfer-execution`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_replica_id: REPLICA_B }),
    });
    assert.equal(res.status, 200);
    const body = (await json(res)) as { task: TaskDetail; lease: ExecutionLease; transfer_event_id: string };
    assert.equal(body.task.task_id, created.task_id);
    assert.equal(body.lease.holder_replica_id, null);
    assert.equal(body.lease.active, false);
    assert.equal(body.lease.fencing_token, 1);
    assert.match(body.transfer_event_id, /^[0-9a-f-]{36}$/);

    const next = h.runtime.leases.acquire(created.task_id, REPLICA_B, 5_000);
    assert.ok("token" in next, "目标副本随后 acquire 成功");
    assert.equal(next.token, 2);
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

test("transfer-execution 参数/守卫：未知任务 404、空目标 400、自身 409", async () => {
  const h = await openRuntime([{ kind: "hang" }]);
  try {
    const missing = await fetch(`${h.base}/v1/tasks/01936b9d-8f7a-7abc-9f2e-000000009999/transfer-execution`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_replica_id: REPLICA_B }),
    });
    assert.equal(missing.status, 404);

    const created = await createTask(h);
    await waitFor("lease active", async () => (await getExecution(h, created.task_id)).lease?.active === true);

    const empty = await fetch(`${h.base}/v1/tasks/${created.task_id}/transfer-execution`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_replica_id: "" }),
    });
    assert.equal(empty.status, 400);

    const self = await fetch(`${h.base}/v1/tasks/${created.task_id}/transfer-execution`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_replica_id: REPLICA }),
    });
    assert.equal(self.status, 409);
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

test("双端独立执行（同步入账本）→ reconcile/detect 冻结，POST /reconcile 由 Owner 显式裁决", async () => {
  const h = await openRuntime([{ kind: "text", deltas: ["done"] }]);
  try {
    const created = await createTask(h);
    await waitFor("task completed", async () => {
      const res = await fetch(`${h.base}/v1/tasks/${created.task_id}`);
      const detail = await json<TaskDetail>(res);
      return detail.status === "completed";
    });

    // 模拟同步进本账本的异地独立执行（B 也 started 过）
    h.runtime.ledger.append(buildEventEnvelope({
      replicaId: REPLICA_B,
      actorId: "agent:runtime",
      eventType: "task.started",
      taskId: created.task_id,
      payload: {},
    }));

    const detect = await fetch(`${h.base}/v1/tasks/${created.task_id}/reconcile/detect`, { method: "POST" });
    assert.equal(detect.status, 200);
    const detected = (await json(detect)) as { detected: boolean; task: TaskDetail; evidence: { replicas: string[] } };
    assert.equal(detected.detected, true);
    assert.equal(detected.task.status, "needs_reconcile");
    assert.deepEqual(detected.evidence.replicas, [REPLICA, REPLICA_B].sort());

    const state = await getExecution(h, created.task_id);
    assert.equal(state.needs_reconcile, true);
    assert.equal(state.lease?.active ?? false, false, "冲突任务没有有效执行租约");

    const wrong = await fetch(`${h.base}/v1/tasks/${created.task_id}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "cancelled" }),
    });
    assert.equal(wrong.status, 400);

    const resolve = await fetch(`${h.base}/v1/tasks/${created.task_id}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "failed", note: "both sides sent the email; owner verified" }),
    });
    assert.equal(resolve.status, 200);
    const resolved = (await json(resolve)) as { task: TaskDetail; reconciliation: { resolution: string } };
    assert.equal(resolved.task.status, "failed");
    assert.equal(resolved.reconciliation.resolution, "failed");
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});
