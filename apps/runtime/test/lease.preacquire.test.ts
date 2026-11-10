// 跨设备事前互斥（M3 同步接线修复 / Issue #34）：
//   - A 持租约 → B acquire 前拉取到 A 的 task.lease_acquired，拒绝并记 task.lease_denied；
//   - 近同时 acquire（双持有）→ 立即 needs_reconcile，不执行节点；
//   - 同任务拉取节流（500ms 复用）生效。
// 全部双实例真 HTTP 回环 + 内存 SecretStore；同步传输来自 runtime 启动接线。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { EventEnvelope, SyncEnvelope, TaskDetail } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { createInMemorySecretStore, type SecretStore } from "../src/keyring.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import { DeviceSyncTransport } from "../src/sync/device-transport.ts";
import type { SyncPushReceipt, SyncTransport, SyncTransportPullResult } from "../src/sync/transport.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

const SINGLE_PLAN = JSON.stringify({
  nodes: [{ key: "a", title: "A", goal: "do a", depends_on: [], retriable: false, side_effect: "reversible" }],
});

function config(dir: string, replicaId: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId, provider: null };
}

interface Pair {
  a: RuntimeHandle;
  b: RuntimeHandle;
  secretsA: SecretStore;
  secretsB: SecretStore;
  dirA: string;
  dirB: string;
}

async function bootPair(options: {
  leaseNow?: () => Date;
  executed?: { count: number };
} = {}): Promise<Pair> {
  const dirA = tmpDir("morrow-lease-gate-a-");
  const dirB = tmpDir("morrow-lease-gate-b-");
  const secretsA = createInMemorySecretStore();
  const secretsB = createInMemorySecretStore();
  const planner = async () => createFakePi({ script: [{ kind: "text", deltas: [SINGLE_PLAN] }] });
  const nodeAgent = async () => {
    if (options.executed !== undefined) options.executed.count += 1;
    return createFakePi({ script: [{ kind: "text", deltas: ["should not run"] }] });
  };
  const shared = {
    taskPlannerFactory: planner,
    taskNodeAgentFactory: nodeAgent,
    ...(options.leaseNow === undefined ? {} : { leaseNow: options.leaseNow }),
  };
  let a: RuntimeHandle | undefined;
  let b: RuntimeHandle | undefined;
  try {
    a = await startRuntime(config(dirA, REPLICA_A), { ...shared, secretStore: secretsA });
    b = await startRuntime(config(dirB, REPLICA_B), { ...shared, secretStore: secretsB });
    return { a, b, secretsA, secretsB, dirA, dirB };
  } catch (err) {
    await b?.close().catch(() => undefined);
    await a?.close().catch(() => undefined);
    removeDir(dirA);
    removeDir(dirB);
    throw err;
  }
}

async function pairViaJoin(pair: Pair): Promise<void> {
  const baseA = `http://127.0.0.1:${pair.a.port}`;
  const baseB = `http://127.0.0.1:${pair.b.port}`;
  const codeRes = await fetch(`${baseA}/v1/pairing/codes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(codeRes.status, 201);
  const { code } = (await codeRes.json()) as { code: string };
  const joinRes = await fetch(`${baseB}/v1/pairing/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ base_url: baseA, code, device_label: "B" }),
  });
  assert.equal(joinRes.status, 200);
}

async function closePair(pair: Pair): Promise<void> {
  await pair.b.close();
  await pair.a.close();
  removeDir(pair.dirA);
  removeDir(pair.dirB);
}

/** 在 A 账本落一条真实持有形态的 task.lease_acquired（并写入 A 的租约表） */
function acquireOnA(a: RuntimeHandle, taskId: string, ttlMs = 30_000): { token: number; expires_at: string } {
  const outcome = a.leases.acquire(taskId, REPLICA_A, ttlMs);
  assert.ok("token" in outcome);
  a.ledger.append(
    buildEventEnvelope({
      replicaId: REPLICA_A,
      actorId: "agent:runtime",
      eventType: "task.lease_acquired",
      taskId,
      payload: {
        replica_id: REPLICA_A,
        holder_replica_id: REPLICA_A,
        fencing_token: outcome.token,
        expires_at: outcome.expires_at,
        acquired_at: outcome.acquired_at,
      },
    }),
  );
  return { token: outcome.token, expires_at: outcome.expires_at };
}

function eventsOf(runtime: RuntimeHandle, taskId: string): EventEnvelope[] {
  return runtime.ledger.scan({ taskId }).map((entry) => entry.envelope);
}

test("A 持租约时 B acquire 被拒：任务保持 planned + task.lease_denied 带持有者与来源（真 HTTP 回环）", { timeout: 30000 }, async () => {
  const executed = { count: 0 };
  const pair = await bootPair({ executed });
  try {
    await pairViaJoin(pair);
    const task = await pair.b.tasks.createTask("exclusive execution");
    assert.equal(task.status, "planned");

    // A 先持有（真租约表 + 随同步传播的租约事件）
    const held = acquireOnA(pair.a, task.task_id, 30_000);

    // B 走正常调度入口：acquire 前会拉取 A 的事件并重放远端租约
    await pair.b.scheduler.schedule(task.task_id);

    const detail = pair.b.tasks.getTask(task.task_id) as TaskDetail;
    assert.equal(detail.status, "planned", "被拒绝后任务保持 planned，不执行也不标 failed");
    assert.equal(executed.count, 0, "节点执行工厂未被调用");

    const events = eventsOf(pair.b, task.task_id);
    assert.ok(events.some((event) => event.event_type === "task.lease_acquired" && event.replica_id === REPLICA_A), "拉取到 A 的租约事件");
    assert.ok(!events.some((event) => event.event_type === "task.started"), "B 未开始执行");
    assert.ok(!events.some((event) => event.event_type === "task.lease_acquired" && event.replica_id === REPLICA_B), "B 未落本地 acquire 事件");

    const denied = events.find((event) => event.event_type === "task.lease_denied");
    assert.ok(denied, "记录 task.lease_denied");
    const payload = denied.payload as Record<string, unknown>;
    assert.equal(payload.holder_replica_id, REPLICA_A);
    assert.equal(payload.source, "remote_lease");
    assert.equal(payload.remote_peer_replica_id, REPLICA_A);
    assert.equal(payload.fencing_token, held.token);
    assert.equal(payload.expires_at, held.expires_at);
    assert.equal(typeof payload.remote_lease_event_id, "string");

    const localLease = pair.b.leases.current(task.task_id);
    assert.equal(localLease, null, "B 没有写本地租约行");
  } finally {
    await closePair(pair);
  }
});

test("近同时 acquire（双持有）→ 立即 needs_reconcile，释放本地租约且不执行", { timeout: 30000 }, async () => {
  const executed = { count: 0 };
  const pair = await bootPair({ executed });
  try {
    await pairViaJoin(pair);
    const task = await pair.b.tasks.createTask("race for execution");

    // 用真实 DeviceSyncTransport 包一层竞态注入：第一次 pull 返回「A 尚未持有」，
    // 随即 A acquire —— 模拟双方在对方的拉取窗口内同时 acquire（真 HTTP 仍走对端）。
    const real = new DeviceSyncTransport({
      selfReplicaId: REPLICA_B,
      devices: pair.b.devices,
      secretStore: pair.secretsB,
    });
    let pulls = 0;
    const racing: SyncTransport = {
      push: (peerId: string, envelopes: SyncEnvelope[]): Promise<SyncPushReceipt> => real.push(peerId, envelopes),
      pull: async (peerId: string, since: number, limit: number): Promise<SyncTransportPullResult> => {
        const result = await real.pull(peerId, since, limit);
        pulls += 1;
        if (pulls === 1) acquireOnA(pair.a, task.task_id, 30_000);
        return result;
      },
      status: (peerId: string) => real.status(peerId),
    };
    pair.b.sync.setTransport(racing);

    await pair.b.scheduler.schedule(task.task_id);

    const detail = pair.b.tasks.getTask(task.task_id) as TaskDetail;
    assert.equal(detail.status, "needs_reconcile", "双持有立即冻结，不执行");
    assert.equal(executed.count, 0);

    const events = eventsOf(pair.b, task.task_id);
    assert.ok(events.some((event) => event.event_type === "task.lease_acquired" && event.replica_id === REPLICA_B), "B 先落了自己的 acquire");
    assert.ok(events.some((event) => event.event_type === "task.lease_released" && event.replica_id === REPLICA_B), "检测到双持有后释放本地租约");
    assert.ok(!events.some((event) => event.event_type === "task.started"), "未开始执行");
    const reconcile = events.find((event) => event.event_type === "task.needs_reconcile");
    assert.ok(reconcile, "落 task.needs_reconcile");
    const payload = reconcile.payload as {
      reason?: string;
      evidence?: { reasons?: string[]; replicas?: string[] };
    };
    assert.equal(payload.reason, "dual_execution_detected");
    assert.ok(payload.evidence?.reasons?.includes("dual_lease_hold"));
    assert.deepEqual(payload.evidence?.replicas, [REPLICA_A, REPLICA_B].sort());

    const localLease = pair.b.leases.current(task.task_id);
    assert.ok(localLease !== null);
    assert.equal(localLease.holder_replica_id, null, "本地租约已释放（token 计数保留）");
    assert.equal(localLease.active, false);
  } finally {
    await closePair(pair);
  }
});

test("租约前拉取节流：同一任务 500ms 内复用上次结果，过期后重新拉取", { timeout: 30000 }, async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(nowMs);
  const pair = await bootPair({ leaseNow: clock });
  try {
    await pairViaJoin(pair);
    const real = new DeviceSyncTransport({
      selfReplicaId: REPLICA_B,
      devices: pair.b.devices,
      secretStore: pair.secretsB,
    });
    let pulls = 0;
    const counting: SyncTransport = {
      push: (peerId: string, envelopes: SyncEnvelope[]) => real.push(peerId, envelopes),
      pull: (peerId: string, since: number, limit: number) => {
        pulls += 1;
        return real.pull(peerId, since, limit);
      },
      status: (peerId: string) => real.status(peerId),
    };
    pair.b.sync.setTransport(counting);

    const taskId = "01936b9d-8f7a-7abc-9f2e-000000000001";
    const first = await pair.b.leaseCoordinator.beforeAcquire(taskId);
    assert.equal(first.ok, true);
    assert.equal(first.pull.peers.length, 1);
    assert.equal(pulls, 1);

    // 500ms 内复用（不新增网络请求）
    await pair.b.leaseCoordinator.beforeAcquire(taskId);
    assert.equal(pulls, 1, "同一任务窗口内复用上次拉取结果");

    nowMs += 600;
    await pair.b.leaseCoordinator.beforeAcquire(taskId);
    assert.equal(pulls, 2, "窗口过期后重新拉取");
  } finally {
    await closePair(pair);
  }
});
