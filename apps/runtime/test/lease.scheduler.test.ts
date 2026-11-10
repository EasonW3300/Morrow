// 调度器执行租约集成测试（M3-T4 / Issue #33，FR-DEP-4）：
// planned→running 前 acquire（失败保持 planned + task.lease_denied）；执行期心跳；
// 租约丢失中止节点并记 task.lease_lost；双端独立执行 → needs_reconcile（不合并）；
// 执行权转移（release）后目标副本 acquire token+1。全部租约时间用注入时钟，不 sleep。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import { join } from "node:path";
import type { EventEnvelope, TaskDetail } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { TaskScheduler, type NodeAgentFactory } from "../src/scheduler.ts";
import { CheckpointService } from "../src/checkpoint.ts";
import { TaskError, TaskService } from "../src/tasks.ts";
import { LockTable } from "../src/locks.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { LeaseStore } from "../src/lease/store.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import { openSqlite } from "../src/db.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
const TTL = 1_000;

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

const SINGLE_PLAN = planJson([
  { key: "a", title: "A", goal: "do a", depends_on: [], retriable: false, side_effect: "reversible" },
]);

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

function fakeClock(startIso = "2026-01-01T00:00:00.000Z"): Clock {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

interface Harness {
  svc: TaskService;
  checkpoints: CheckpointService;
  leases: LeaseStore;
  dir: string;
  clock: Clock;
  close(): void;
}

function openHarness(c: Clock): Harness {
  const dir = tmpDir("morrow-lease-sched-");
  const ledger = EventLedger.open(dir);
  // 规划器与节点执行共用 FakePi（零网络）；节点脚本由各测试的工厂注入
  const svc = new TaskService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    factory: async () => createFakePi({ script: [{ kind: "text", deltas: [SINGLE_PLAN] }] }),
  });
  const checkpoints = new CheckpointService({ tasks: svc, dataDir: dir, ledger, replicaId: REPLICA });
  const leases = new LeaseStore({ dataDir: dir, now: () => c.now() });
  const locks = new LockTable({ db: openSqlite(join(dir, "events.sqlite")) });
  const worktrees = new WorktreeManager({ root: join(dir, "worktrees") });
  return {
    svc,
    checkpoints,
    leases,
    dir,
    clock: c,
    close: () => {
      leases.close();
      svc.close();
      locks.close();
      checkpoints.close();
      ledger.close();
      removeDir(dir);
    },
  };
}

function makeScheduler(h: Harness, factory: NodeAgentFactory | null, extra: { heartbeatMs?: number } = {}): TaskScheduler {
  return new TaskScheduler({
    tasks: h.svc,
    ledger: h.svc.ledger,
    replicaId: REPLICA,
    nodeAgentFactory: factory,
    checkpoints: h.checkpoints,
    leases: h.leases,
    leaseTtlMs: TTL,
    ...(extra.heartbeatMs === undefined ? {} : { leaseHeartbeatMs: extra.heartbeatMs }),
  });
}

function nodeFactory(scripts: Record<string, FakeStep[]>): NodeAgentFactory {
  return async (node) => createFakePi({ script: scripts[node.key] ?? [] });
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function types(events: EventEnvelope[]): string[] {
  return events.map((e) => e.event_type);
}

test("租约被他人持有时 schedule 不执行：任务保持 planned + task.lease_denied 带持有者", async () => {
  const c = fakeClock();
  const h = openHarness(c);
  try {
    const task = await h.svc.createTask("lease denied");
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["should not run"] }] }));
    // 另一副本先持有租约
    const held = new LeaseStore({ dataDir: h.dir, now: () => c.now() });
    try {
      const acquired = held.acquire(task.task_id, REPLICA_B, TTL);
      assert.ok("token" in acquired);
    } finally {
      held.close();
    }

    await scheduler.schedule(task.task_id);

    const fresh = h.svc.getTask(task.task_id) as TaskDetail;
    assert.equal(fresh.status, "planned", "未拿到租约不得进入 running");
    const events = h.svc.taskEvents(task.task_id)?.events ?? [];
    assert.ok(types(events).includes("task.lease_denied"), "记录拒绝事件");
    const denied = events.find((e) => e.event_type === "task.lease_denied");
    assert.equal(denied?.payload.holder_replica_id, REPLICA_B);
    assert.equal(fresh.nodes[0].status, "pending", "节点未执行");
  } finally {
    h.close();
  }
});

test("schedule 成功 acquire：token=1；任务完成后租约释放（active=false，token 保留）", async () => {
  const c = fakeClock();
  const h = openHarness(c);
  try {
    const task = await h.svc.createTask("lease acquire");
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["done"] }] }));
    await scheduler.schedule(task.task_id);

    const fresh = h.svc.getTask(task.task_id) as TaskDetail;
    assert.equal(fresh.status, "completed");
    const lease = h.leases.current(task.task_id);
    assert.equal(lease?.fencing_token, 1);
    assert.equal(lease?.holder_replica_id, null, "任务终结后释放租约");
    assert.equal(lease?.active, false);

    // 另一副本可立即接管（token 继续 +1）
    const next = h.leases.acquire(task.task_id, REPLICA_B, TTL);
    assert.ok("token" in next);
    assert.equal(next.token, 2);
  } finally {
    h.close();
  }
});

test("租约丢失（心跳失败）：中止在跑节点，记 task.lease_lost，节点 pending_review 不提交结果", async () => {
  const c = fakeClock();
  const h = openHarness(c);
  try {
    const task = await h.svc.createTask("lease lost");
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "hang" }] }), { heartbeatMs: 5 });
    void scheduler.schedule(task.task_id).catch(() => undefined);

    await waitFor("node running", () => {
      const detail = h.svc.getTask(task.task_id) as TaskDetail;
      return detail.nodes[0]?.status === "running";
    });

    // 租约过期后另一副本抢占（token+1）→ 本副本下次心跳 renew 失败
    c.advance(TTL + 1);
    const other = new LeaseStore({ dataDir: h.dir, now: () => c.now() });
    try {
      const takeover = other.acquire(task.task_id, REPLICA_B, TTL);
      assert.ok("token" in takeover);
      assert.equal(takeover.token, 2);
    } finally {
      other.close();
    }

    await waitFor("task.lease_lost", () =>
      (h.svc.taskEvents(task.task_id)?.events ?? []).some((e) => e.event_type === "task.lease_lost"));
    await waitFor("node pending_review", () => {
      const detail = h.svc.getTask(task.task_id) as TaskDetail;
      return detail.nodes[0]?.status === "pending_review";
    });
    const fresh = h.svc.getTask(task.task_id) as TaskDetail;
    assert.equal(fresh.status, "running", "本副本不擅自终结任务（执行权已被他人接管）");
    assert.match(fresh.nodes[0].error ?? "", /lease lost/);
    await scheduler.dispose();
  } finally {
    h.close();
  }
});

test("双端独立执行 → needs_reconcile（含两侧证据），Owner 显式裁决后离开该状态", async () => {
  const c = fakeClock();
  const h = openHarness(c);
  try {
    const task = await h.svc.createTask("dual execution");
    // 模拟同步进本账本的异地执行：A/B 各自 task.started（非合法转移）
    for (const replica of [REPLICA, REPLICA_B]) {
      h.svc.ledger.append(buildEventEnvelope({
        replicaId: replica,
        actorId: "agent:runtime",
        eventType: "task.started",
        taskId: task.task_id,
        payload: {},
      }));
    }
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["must not run"] }] }));
    await scheduler.schedule(task.task_id);

    const fresh = h.svc.getTask(task.task_id) as TaskDetail;
    assert.equal(fresh.status, "needs_reconcile");
    assert.equal(h.leases.current(task.task_id), null, "冲突任务不进入执行");
    const events = h.svc.taskEvents(task.task_id)?.events ?? [];
    const flagged = events.find((e) => e.event_type === "task.needs_reconcile");
    assert.ok(flagged !== undefined);
    const evidence = flagged.payload.evidence as {
      replicas: string[];
      independent_replicas: string[];
      reasons: string[];
    };
    assert.deepEqual(evidence.replicas, [REPLICA, REPLICA_B].sort());
    assert.ok(evidence.independent_replicas.includes(REPLICA));
    assert.ok(evidence.independent_replicas.includes(REPLICA_B));
    assert.ok(evidence.reasons.includes("dual_execution"));

    // Owner 显式裁决（不自动合并）：needs_reconcile → completed
    const resolved = h.svc.resolveNeedsReconcile(task.task_id, {
      resolution: "completed",
      note: "kept replica A output",
    });
    assert.equal(resolved.task.status, "completed");
    const after = h.svc.taskEvents(task.task_id)?.events ?? [];
    assert.ok(after.some((e) => e.event_type === "task.reconciled" && e.actor_id === "owner"));
    assert.ok(after.some((e) => e.event_type === "task.completed" && e.actor_id === "owner"));
  } finally {
    h.close();
  }
});

test("执行权转移：当前持有者 release + task.execution_transferred；目标副本随后 acquire token+1", async () => {
  const c = fakeClock();
  const h = openHarness(c);
  try {
    const task = await h.svc.createTask("transfer me");
    const acquired = h.leases.acquire(task.task_id, REPLICA, TTL);
    assert.ok("token" in acquired);
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["unused"] }] }));

    const transferred = await scheduler.transferExecution(task.task_id, REPLICA_B);
    assert.equal(transferred.task.status, "planned");
    assert.equal(transferred.lease?.holder_replica_id, null);
    assert.equal(transferred.lease?.active, false);
    const events = h.svc.taskEvents(task.task_id)?.events ?? [];
    const event = events.find((e) => e.event_type === "task.execution_transferred");
    assert.ok(event !== undefined);
    assert.equal(event.payload.from_replica_id, REPLICA);
    assert.equal(event.payload.to_replica_id, REPLICA_B);
    assert.equal(event.payload.next_fencing_token, 2);

    const next = h.leases.acquire(task.task_id, REPLICA_B, TTL);
    assert.ok("token" in next);
    assert.equal(next.token, 2);
  } finally {
    h.close();
  }
});

test("终端态任务不可转移执行权（409 语义）", async () => {
  const c = fakeClock();
  const h = openHarness(c);
  try {
    const task = await h.svc.createTask("terminal transfer");
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["done"] }] }));
    await scheduler.schedule(task.task_id);
    assert.equal((h.svc.getTask(task.task_id) as TaskDetail).status, "completed");
    // 重新持有租约也应被终端态守卫挡住（先释放后重新 acquire 只为构造持有者）
    await assert.rejects(
      () => scheduler.transferExecution(task.task_id, REPLICA_B),
      (err: unknown) => err instanceof TaskError && err.code === "invalid_transition",
    );
  } finally {
    h.close();
  }
});
