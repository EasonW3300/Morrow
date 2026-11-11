// Checkpoint × 调度器 seam 测试（票 M1-T5 / Issue #17）：
// pause（安全点=停派发+等在跑节点到边界）、resume/restore（reconcile → 续跑）、
// 半写状态恢复（kill 中断的进程内等价物：node_started 已落/结果未落）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope, TaskDetail } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { openSqlite } from "../src/db.ts";
import { CheckpointService } from "../src/checkpoint.ts";
import { TaskScheduler, type NodeAgentFactory } from "../src/scheduler.ts";
import { CheckpointError } from "../src/checkpoint.ts";
import { TaskError, TaskService } from "../src/tasks.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

interface Harness {
  svc: TaskService;
  checkpoints: CheckpointService;
  dir: string;
  close(): void;
}

function openHarness(plan: string): Harness {
  const dir = tmpDir("morrow-ckpt-sched-");
  const ledger = EventLedger.open(dir);
  const svc = new TaskService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    factory: async () => createFakePi({ script: planScript(plan) }),
  });
  const checkpoints = new CheckpointService({ tasks: svc, dataDir: dir, ledger, replicaId: REPLICA });
  return {
    svc,
    checkpoints,
    dir,
    close: () => {
      svc.close();
      checkpoints.close();
      ledger.close();
      removeDir(dir);
    },
  };
}

function makeScheduler(
  h: Harness,
  factory: NodeAgentFactory | null,
  concurrency?: number,
): TaskScheduler {
  return new TaskScheduler({
    tasks: h.svc,
    ledger: h.svc.ledger,
    replicaId: REPLICA,
    nodeAgentFactory: factory,
    checkpoints: h.checkpoints,
    ...(concurrency === undefined ? {} : { concurrency }),
  });
}

function nodeFactory(scripts: Record<string, FakeStep[]>, tools: MorrowTool[] = []): NodeAgentFactory {
  return async (node) => createFakePi({ script: scripts[node.key] ?? [], tools });
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function types(events: EventEnvelope[]): string[] {
  return events.map((e) => e.event_type);
}

/** 栅栏工具：execute 挂起直到测试放行（模拟外部副作用进行中）；名字必须唯一（FakePi 按名注册） */
function latchTool(name = "latch") {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tool = {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      await gate;
      return { text: "latched" };
    },
  };
  return { tool, release: () => release() };
}

async function plannedTask(h: Harness, goal = "整理周报并归档"): Promise<TaskDetail> {
  return h.svc.createTask(goal);
}

// --- pause：安全点暂停 ----------------------------------------------------------------

test("pause stops dispatch at the boundary, records task.paused + full checkpoint", async () => {
  const h = openHarness(planJson([
    { key: "a", title: "A", goal: "do a", depends_on: [], side_effect: "irreversible", model: "model-a" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
  ]));
  try {
    const detail = await plannedTask(h);
    const latch = latchTool();
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "latch" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
    }, [latch.tool]));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("node a to be running (latched)", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");

    // pause 先等 a 到边界；测试放行栅栏后 pause 落定，b（未派发）保持 pending
    const pausePromise = scheduler.pause(detail.task_id);
    latch.release();
    const { task, checkpoint } = await pausePromise;

    assert.equal(task.status, "paused");
    assert.equal(checkpoint.reason, "pause");
    const s = checkpoint.snapshot;
    assert.equal(s.run.status, "paused");
    const snapA = s.graph.nodes.find((n) => n.key === "a");
    const snapB = s.graph.nodes.find((n) => n.key === "b");
    assert.equal(snapA?.status, "completed", "在跑节点 a 收尾后记 completed");
    assert.equal(snapB?.status, "pending", "未派发节点 b 保持 pending");
    assert.ok(s.run.output_refs.a?.length === 36, "已完成节点有账本输出引用");
    assert.equal(s.run.run_root_event_id?.length, 36, "run 根事件（task.started）已记录");
    assert.deepEqual(s.pending_side_effects.map((p) => [p.key, p.state]), [
      ["a", "delivered_unverified"],
      ["b", "not_delivered"],
    ]);

    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    assert.ok(types(events).includes("task.paused"));
    assert.ok(types(events).includes("task.checkpoint_created"));
    // 安全点证明：b 没有在暂停窗口内被派发（a 已启动属预期）
    const bStarted = events.filter((e) => e.event_type === "task.node_started" && e.payload.key === "b");
    assert.equal(bStarted.length, 0, "暂停前 b 未启动");
    const bRow = h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "b");
    assert.equal(bRow?.status, "pending");
  } finally {
    h.close();
  }
});

test("pause rejects non-running tasks without writing anything", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A" }]));
  try {
    const detail = await plannedTask(h);
    const scheduler = makeScheduler(h, nodeFactory({}));
    await assert.rejects(
      () => scheduler.pause(detail.task_id),
      (err: unknown) => err instanceof TaskError && err.code === "invalid_transition",
    );
    assert.equal(h.checkpoints.listCheckpoints(detail.task_id).length, 0);
    assert.equal(h.svc.taskEvents(detail.task_id)?.events.length, 2, "created+planned，无新事件");
  } finally {
    h.close();
  }
});

// --- resume：从 checkpoint 续跑 -------------------------------------------------------

test("resume replays only pending work; completed nodes keep results and are not re-run", async () => {
  const h = openHarness(planJson([
    { key: "a", title: "A", goal: "do a", depends_on: [], side_effect: "irreversible" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
  ]));
  try {
    const detail = await plannedTask(h);
    const latch = latchTool();
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "latch" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
    }, [latch.tool]));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("node a latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");
    const pausing = scheduler.pause(detail.task_id);
    latch.release();
    await pausing;

    const { task, drive } = await scheduler.resume(detail.task_id);
    assert.equal(task.status, "running");
    await drive;

    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    assert.deepEqual(final?.nodes.map((n) => [n.key, n.status, n.result, n.attempts]), [
      ["a", "completed", "a-ok", 1],
      ["b", "completed", "b-ok", 1],
    ]);
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const aFinished = events.filter(
      (e) => e.event_type === "task.node_finished" && e.payload.key === "a" && e.payload.status === "completed",
    );
    assert.equal(aFinished.length, 1, "已完成的 a 不重放（单次 node_finished）");
    assert.ok(types(events).includes("task.resumed"), "恢复记 task.resumed");
    assert.ok(types(events).includes("task.restored"), "恢复经 reconcile 记 task.restored");
  } finally {
    h.close();
  }
});

test("resume recovers a stale running task after a crash equivalent (half-write: started without finish)", async () => {
  // 进程内模拟 kill -9：原 harness 的调度器「消失」（不 await schedule），新实例接管
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]));
  try {
    const detail = await plannedTask(h);
    const latch = latchTool();
    const zombieScheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "latch" }, { kind: "text", deltas: ["never"] }],
    }, [latch.tool]));
    void zombieScheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("node a latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");
    // 半写状态断言：node_started 已落账本，节点无结果
    const before = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    assert.ok(before.some((e) => e.event_type === "task.node_started"));
    assert.equal(h.svc.getTask(detail.task_id)?.nodes[0].result, undefined);

    // 「重启」：新调度器实例接管（新连接同库）
    const revived = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["replayed"] }] }));
    const { task, drive } = await revived.resume(detail.task_id);
    assert.equal(task.status, "running");
    await drive;

    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    assert.equal(final?.nodes[0].result, "replayed");
    assert.equal(final?.nodes[0].attempts, 2, "重放在原 attempts 上递增（半写的那次算第 1 次）");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const aFinished = events.filter(
      (e) => e.event_type === "task.node_finished" && e.payload.status === "completed",
    );
    assert.equal(aFinished.length, 1, "半写 attempt 不产生完成的 node_finished；重放恰好一次");
    assert.deepEqual(aFinished[0].payload.attempt, 2);
    const resumed = events.find((e) => e.event_type === "task.resumed");
    assert.equal(resumed?.payload.reason, "recovered_after_interruption", "stale-running 恢复不带迁移，仅恢复标记");
  } finally {
    h.close();
  }
});

test("resume flags a stale running irreversible-class node as pending_review and parks the task at waiting_input", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", side_effect: "delivery_unknown" }]));
  try {
    const detail = await plannedTask(h);
    const latch = latchTool();
    const zombie = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "latch" }, { kind: "text", deltas: ["never"] }],
    }, [latch.tool]));
    void zombie.schedule(detail.task_id).catch(() => undefined);
    await waitFor("node a latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");

    const revived = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["MUST NOT RUN"] }] }));
    const { drive } = await revived.resume(detail.task_id);
    await drive;

    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "waiting_input", "无可跑节点且有人工核对项 → waiting_input");
    const a = final?.nodes[0];
    assert.equal(a?.status, "pending_review", "未知分类半写节点 → 人工核对，不自动重发");
    assert.equal(a?.result, undefined);
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const started = events.filter((e) => e.event_type === "task.node_started");
    assert.equal(started.length, 1, "半写之外不得再派发");
    const waiting = events.find((e) => e.event_type === "task.waiting_input");
    assert.equal(waiting?.payload.reason, "reconciliation_required");
    assert.deepEqual(waiting?.payload.keys, ["a"]);
  } finally {
    h.close();
  }
});

test("resume rejects an actively running task (same process) and terminal states", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a" }]));
  try {
    const detail = await plannedTask(h);
    const latch = latchTool();
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "latch" }, { kind: "text", deltas: ["ok"] }],
    }, [latch.tool]));
    const running = scheduler.schedule(detail.task_id);
    await waitFor("node a latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");
    await assert.rejects(
      () => scheduler.resume(detail.task_id),
      (err: unknown) => err instanceof TaskError && err.code === "invalid_transition",
    );
    latch.release();
    await running;
    await assert.rejects(
      () => scheduler.resume(detail.task_id),
      (err: unknown) => err instanceof TaskError && err.code === "invalid_transition",
      "completed 是终端态",
    );
  } finally {
    h.close();
  }
});

test("resume drives a planned orphan task (crash before scheduling)", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a" }]));
  try {
    const detail = await plannedTask(h);
    assert.equal(detail.status, "planned", "规划完成但从未调度（等价于调度前崩溃）");
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["ok"] }] }));
    const { task, drive } = await scheduler.resume(detail.task_id);
    assert.equal(task.status, "running");
    await drive;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "completed");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    assert.ok(types(events).includes("task.started"), "planned→running 记 task.started（非 resumed）");
    assert.ok(types(events).includes("task.restored"));
  } finally {
    h.close();
  }
});

// --- restore：指定 checkpoint 恢复 ----------------------------------------------------

test("restore rewinds a node completed after the checkpoint: reversible replays, delivery_unknown is flagged", async () => {
  const h = openHarness(planJson([
    { key: "a", title: "A", goal: "do a", side_effect: "reversible" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "delivery_unknown" },
  ]));
  try {
    const detail = await plannedTask(h);
    const latchA = latchTool("latchA");
    const latchB = latchTool("latchB");
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "latchA" }, { kind: "text", deltas: ["a-v1"] }],
      b: [{ kind: "text", deltas: ["b-v1"] }],
    }, [latchA.tool, latchB.tool]));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("node a latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");
    // 暂停 #1：等 a 到边界（b 未派发）→ checkpoint C1（a completed / b pending）
    const pausing1 = scheduler.pause(detail.task_id);
    latchA.release();
    const { checkpoint: c1 } = await pausing1;
    assert.equal(c1.snapshot.graph.nodes.find((n) => n.key === "b")?.status, "pending");

    // resume 跑 b（挂起在栅栏）→ 暂停 #2 收尾 → 任务回到 paused（可 restore）
    const resume1 = await scheduler.resume(detail.task_id);
    void resume1.drive.catch(() => undefined);
    await waitFor("node b latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "b")?.status === "running");
    const pausing2 = scheduler.pause(detail.task_id);
    latchB.release();
    await pausing2;

    // restore C1：b 在 C1 之后才完成 → 回卷决策按分类（delivery_unknown → 人工核对）
    const { report, drive } = await scheduler.restore(detail.task_id, c1.checkpoint_id);
    await drive;
    assert.deepEqual(report.replay_keys, [], "a 在 C1 时已完成 → keep");
    assert.deepEqual(report.pending_review_keys, ["b"], "b 在 C1 后才完成 → 不自动重发");

    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "waiting_input");
    const b = final?.nodes.find((n) => n.key === "b");
    assert.equal(b?.status, "pending_review");
    assert.equal(b?.result, "b-v1", "pending_review 保留原结果供核对");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const bStarted = events.filter((e) => e.event_type === "task.node_started" && e.payload.key === "b");
    assert.equal(bStarted.length, 1, "b 不被重发（仅恢复前那一次启动）");
    assert.ok(types(events).includes("task.restored"));
  } finally {
    h.close();
  }
});

test("restore replays a rewound reversible node exactly once more", async () => {
  const h = openHarness(planJson([
    { key: "a", title: "A", goal: "do a", side_effect: "reversible" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
  ]));
  try {
    const detail = await plannedTask(h);
    const latchA = latchTool("latchA");
    const latchB = latchTool("latchB");
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "latchA" }, { kind: "text", deltas: ["a-v1"] }],
      b: [{ kind: "text", deltas: ["b-v1"] }],
    }, [latchA.tool, latchB.tool]));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("node a latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");
    const pausing1 = scheduler.pause(detail.task_id);
    latchA.release();
    const { checkpoint: c1 } = await pausing1;

    const resume1 = await scheduler.resume(detail.task_id);
    void resume1.drive.catch(() => undefined);
    await waitFor("node b latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "b")?.status === "running");
    const pausing2 = scheduler.pause(detail.task_id);
    latchB.release();
    await pausing2;

    // restore C1：b（reversible）在 C1 后才完成 → 回卷为 pending 重放
    const { report, task, drive } = await scheduler.restore(detail.task_id, c1.checkpoint_id);
    assert.deepEqual(report.replay_keys, ["b"]);
    assert.equal(task.status, "running");
    await drive;

    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    assert.equal(final?.nodes.find((n) => n.key === "b")?.attempts, 2, "重放 attempt 递增");
    assert.equal(final?.nodes.find((n) => n.key === "b")?.result, "b-v1");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const bFinished = events.filter(
      (e) => e.event_type === "task.node_finished" && e.payload.key === "b" && e.payload.status === "completed",
    );
    assert.equal(bFinished.length, 2, "恰好重放一次（原一次 + 恢复后一次）");
    assert.deepEqual(bFinished[1].payload.attempt, 2);
  } finally {
    h.close();
  }
});

test("restore rejects unknown checkpoints, foreign checkpoints, and version mismatches without side effects", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a" }]));
  try {
    const detail = await plannedTask(h);
    const latch = latchTool();
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "latch" }, { kind: "text", deltas: ["ok"] }],
    }, [latch.tool]));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("node a latched", () =>
      h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");
    const pausing = scheduler.pause(detail.task_id);
    latch.release();
    const { checkpoint } = await pausing;

    // 未知 id
    await assert.rejects(
      () => scheduler.restore(detail.task_id, "01936b9d-8f7a-7abc-9f2e-000000000000"),
      (err: unknown) => err instanceof CheckpointError && err.code === "checkpoint_not_found",
    );
    // 版本不匹配：测试直接推进任务投影的 task_version（FR-TASK-3 修订尚未实现）
    const raw = openSqlite(`${h.dir}/events.sqlite`);
    raw.exec(`UPDATE tasks SET task_version = 2 WHERE task_id = '${detail.task_id}'`);
    raw.close();
    const eventsBefore = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events.length ?? 0;
    await assert.rejects(
      () => scheduler.restore(detail.task_id, checkpoint.checkpoint_id),
      (err: unknown) => err instanceof CheckpointError && err.code === "checkpoint_version_mismatch",
    );
    const eventsAfter = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events.length ?? 0;
    assert.equal(eventsAfter, eventsBefore, "被拒绝的 restore 不落任何事件");
    // 版本回正后恢复仍可正常 resume（状态未被破坏；版本守卫对 resume 同样生效）
    const raw2 = openSqlite(`${h.dir}/events.sqlite`);
    raw2.exec(`UPDATE tasks SET task_version = 1 WHERE task_id = '${detail.task_id}'`);
    raw2.close();
    const { drive } = await scheduler.resume(detail.task_id);
    await drive;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "completed");
  } finally {
    h.close();
  }
});
