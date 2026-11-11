// TaskService / TaskScheduler seam 测试（票 M1-T4 / Issue #16，PRD §4.3 FR-TASK-1/2/6）：
// 规划经 PiAdapter 接口注入（FakePi 脚本化规划输出，无网络），调度器执行节点 = 一次 Agent Loop。
// 账本是唯一事实源：事件断言全部走 svc.taskEvents（按 task_id 过滤的账本读路径）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope, TaskStatus } from "@morrow/protocol";
import { join } from "node:path";
import { EventLedger } from "../src/ledger.ts";
import { TaskScheduler, type NodeAgentFactory } from "../src/scheduler.ts";
import { CheckpointService } from "../src/checkpoint.ts";
import { TaskError, TaskService } from "../src/tasks.ts";
import { LockTable } from "../src/locks.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { openSqlite } from "../src/db.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

// --- 夹具 ---------------------------------------------------------------------

/** 规划器 FakePi 脚本：text 增量拼出规划 JSON（生产走真实 LLM，测试脚本化） */
function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

/** A→B 串行 + C 与 A 并行的脚本化 DAG（a 携带 M2-T4 资源声明样例，与规划提示词同步） */
const MIXED_PLAN = planJson([
  { key: "a", title: "节点A", goal: "do a", depends_on: [], agent_role: "researcher", retriable: true, side_effect: "irreversible", resources: { lock: ["report:weekly"] } },
  { key: "b", title: "节点B", goal: "do b", depends_on: ["a"], retriable: false },
  { key: "c", title: "节点C", goal: "do c", depends_on: [], retriable: true },
]);

interface Harness {
  svc: TaskService;
  checkpoints: CheckpointService;
  worktrees: WorktreeManager;
  locks: LockTable;
  dir: string;
  close(): void;
}

function openService(plannerOutput: string): Harness {
  const dir = tmpDir("morrow-tasks-");
  const ledger = EventLedger.open(dir);
  const svc = new TaskService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    factory: async () => createFakePi({ script: planScript(plannerOutput) }),
  });
  const checkpoints = new CheckpointService({ tasks: svc, dataDir: dir, ledger, replicaId: REPLICA });
  // M2-T4 生产接线同构：锁表（同库独立连接）+ worktree 管理器（本文件场景无 git 声明）
  const locks = new LockTable({ db: openSqlite(join(dir, "events.sqlite")) });
  const worktrees = new WorktreeManager({ root: join(dir, "worktrees") });
  return {
    svc,
    checkpoints,
    worktrees,
    locks,
    dir,
    close: () => { svc.close(); locks.close(); checkpoints.close(); ledger.close(); removeDir(dir); },
  };
}

function openIdleService(): Harness {
  const dir = tmpDir("morrow-tasks-idle-");
  const ledger = EventLedger.open(dir);
  const svc = new TaskService({ dataDir: dir, ledger, replicaId: REPLICA, factory: null });
  const checkpoints = new CheckpointService({ tasks: svc, dataDir: dir, ledger, replicaId: REPLICA });
  const locks = new LockTable({ db: openSqlite(join(dir, "events.sqlite")) });
  const worktrees = new WorktreeManager({ root: join(dir, "worktrees") });
  return {
    svc,
    checkpoints,
    worktrees,
    locks,
    dir,
    close: () => { svc.close(); locks.close(); checkpoints.close(); ledger.close(); removeDir(dir); },
  };
}

function nodeFactory(scripts: Record<string, FakeStep[]>, tools: MorrowTool[] = []): NodeAgentFactory {
  return async (node) => createFakePi({ script: scripts[node.key] ?? [], tools });
}

function makeScheduler(h: Harness, factory: NodeAgentFactory | null, concurrency?: number): TaskScheduler {
  return new TaskScheduler({
    tasks: h.svc,
    ledger: h.svc.ledger,
    replicaId: REPLICA,
    nodeAgentFactory: factory,
    checkpoints: h.checkpoints,
    worktrees: h.worktrees,
    locks: h.locks,
    ...(concurrency === undefined ? {} : { concurrency }),
  });
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function types(events: EventEnvelope[]): string[] {
  return events.map((e) => e.event_type);
}

async function plannedTask(h: Harness, goal = "整理周报并归档"): Promise<ReturnType<Harness["svc"]["createTask"]>> {
  return h.svc.createTask(goal);
}

// --- 规划（POST /v1/tasks 的服务层语义）----------------------------------------

test("createTask plans a scripted DAG and records task.created/task.planned with full projection", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await plannedTask(h);
    assert.equal(detail.status, "planned");
    assert.equal(detail.task_version, 1);
    assert.equal(detail.nodes.length, 3);
    const [a, b, c] = detail.nodes;
    assert.deepEqual(a.depends_on, []);
    assert.deepEqual(b.depends_on, ["a"]);
    assert.deepEqual(c.depends_on, []);
    assert.equal(a.agent_role, "researcher");
    assert.equal(a.retriable, true);
    assert.equal(a.side_effect, "irreversible");
    assert.equal(b.retriable, false);
    assert.equal(b.side_effect, "delivery_unknown"); // 规划器缺省 → 保守未知分类
    assert.deepEqual(a.resources, { lock: ["report:weekly"] }, "资源声明 round-trip（M2-T4）");
    for (const node of detail.nodes) assert.equal(node.status, "pending");

    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    assert.deepEqual(types(events).slice(0, 2), ["task.created", "task.planned"]);
    const created = events[0];
    const planned = events[1];
    assert.equal(created.actor_id, "owner");
    assert.deepEqual(created.payload, { goal: "整理周报并归档" });
    assert.equal(planned.actor_id, "agent:runtime");
    assert.equal(planned.causation_id, created.event_id);
    const plannedNodes = planned.payload.nodes as Array<{ key: string; depends_on: string[]; retriable: boolean; side_effect: string }>;
    assert.equal(plannedNodes.length, 3);
    assert.equal(plannedNodes[1].depends_on[0], "a");
    assert.equal(plannedNodes[1].side_effect, "delivery_unknown");
  } finally {
    h.close();
  }
});

test("invalid planner output fails the task with task.planning_failed + task.failed", async () => {
  const h = openService("这不是 JSON");
  try {
    const detail = await h.svc.createTask("目标");
    assert.equal(detail.status, "failed");
    assert.equal(detail.nodes.length, 0);
    assert.match(detail.error ?? "", /JSON|plan/i);

    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    assert.deepEqual(types(events), ["task.created", "task.planning_failed", "task.failed"]);
    const planningFailed = events[1];
    assert.equal(planningFailed.causation_id, events[0].event_id);
    assert.match(String(planningFailed.payload.message), /JSON/);
    const failed = events[2];
    assert.equal(failed.payload.reason, "planning_failed");
    assert.equal(failed.causation_id, events[0].event_id);
  } finally {
    h.close();
  }
});

test("planner output with unknown dependency or a cycle fails plan validation", async () => {
  const unknownDep = openService(planJson([
    { key: "a", title: "A", depends_on: ["ghost"] },
  ]));
  try {
    const detail = await unknownDep.svc.createTask("目标");
    assert.equal(detail.status, "failed");
    assert.match(detail.error ?? "", /ghost/);
  } finally {
    unknownDep.close();
  }
  const cycle = openService(planJson([
    { key: "a", title: "A", depends_on: ["b"] },
    { key: "b", title: "B", depends_on: ["a"] },
  ]));
  try {
    const detail = await cycle.svc.createTask("目标");
    assert.equal(detail.status, "failed");
    assert.match(detail.error ?? "", /cycle|环/i);
  } finally {
    cycle.close();
  }
});

test("planner output wrapped in a markdown code fence is still parsed", async () => {
  const h = openService("```json\n" + planJson([{ key: "only", title: "唯一节点" }]) + "\n```");
  try {
    const detail = await h.svc.createTask("目标");
    assert.equal(detail.status, "planned");
    assert.equal(detail.nodes.length, 1);
  } finally {
    h.close();
  }
});

test("createTask without a planner factory throws planner_unavailable (HTTP 503 预检依据)", async () => {
  const h = openIdleService();
  try {
    assert.equal(h.svc.plannerAvailable, false);
    await assert.rejects(
      () => h.svc.createTask("目标"),
      (err: TaskError) => err instanceof TaskError && err.code === "planner_unavailable",
    );
  } finally {
    h.close();
  }
});

// --- 状态机 --------------------------------------------------------------------

test("state machine: legal transitions append one event each; illegal ones rejected without ledger writes", async () => {
  const h = openService(planJson([{ key: "a", title: "A" }]));
  try {
    const detail = await plannedTask(h);
    const taskId = detail.task_id;
    const countEvents = (): number => h.svc.taskEvents(taskId)?.events.length ?? 0;

    const legal: Array<[TaskStatus, TaskStatus, string]> = [
      ["planned", "running", "task.started"],
      ["running", "paused", "task.paused"],
      ["paused", "running", "task.resumed"], // 恢复不是再次 started
      ["running", "waiting_input", "task.waiting_input"],
      ["waiting_input", "running", "task.resumed"],
      ["running", "completed", "task.completed"],
    ];
    let from: TaskStatus = "planned";
    for (const [, to, eventType] of legal) {
      const result = h.svc.transition(taskId, to);
      assert.equal(result.eventId.length, 36);
      const events = h.svc.taskEvents(taskId)?.events ?? [];
      assert.equal(events[events.length - 1].event_type, eventType, `${from} → ${to}`);
      from = to;
    }

    // 终端态拒绝一切迁移
    const before = countEvents();
    for (const to of ["running", "planned", "paused", "failed", "cancelled"] as TaskStatus[]) {
      assert.throws(
        () => h.svc.transition(taskId, to),
        (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
        `completed → ${to} 必须被拒绝`,
      );
    }
    assert.equal(countEvents(), before, "非法迁移不得落任何事件");

    // failed 是终端态（在自己的 harness 里建 failed 任务，再对其断言迁移拒绝）
    const failedH = openService("bad json");
    try {
      const failedTask = await failedH.svc.createTask("x");
      assert.equal(failedTask.status, "failed");
      assert.throws(
        () => failedH.svc.transition(failedTask.task_id, "planned"),
        (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
      );
    } finally {
      failedH.close();
    }

    // 未运行中的中间态也有非法迁移：planned → paused / completed
    const detail2 = await plannedTask(h, "第二个任务");
    assert.throws(
      () => h.svc.transition(detail2.task_id, "paused"),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );
    assert.throws(
      () => h.svc.transition(detail2.task_id, "completed"),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );
    // 未知任务
    assert.throws(
      () => h.svc.transition("01936b9d-8f7a-7abc-9f2e-000000000000", "running"),
      (err: TaskError) => err instanceof TaskError && err.code === "not_found",
    );
  } finally {
    h.close();
  }
});

// --- 调度器 --------------------------------------------------------------------

test("scheduler runs serial deps in order and independent nodes in parallel; full task.* chain with causation", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await plannedTask(h);
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "tool", toolName: "noop" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
      c: [{ kind: "text", deltas: ["c-ok"] }],
    }, [{
      name: "noop", description: "noop", parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "done" }),
    }]));
    await scheduler.schedule(detail.task_id);

    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    assert.deepEqual(final?.nodes.map((n) => [n.key, n.status, n.result]), [
      ["a", "completed", "a-ok"],
      ["b", "completed", "b-ok"],
      ["c", "completed", "c-ok"],
    ]);

    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const seqOf = (predicate: (e: EventEnvelope) => boolean): number => {
      const idx = events.findIndex(predicate);
      assert.ok(idx >= 0, "event not found");
      return idx;
    };
    const ns = (key: string): number => seqOf((e) => e.event_type === "task.node_started" && e.payload.key === key);
    const nf = (key: string): number => seqOf((e) => e.event_type === "task.node_finished" && e.payload.key === key && e.payload.status === "completed");

    // 并行证明：C 的启动早于 A 的完成（同批调度）；串行证明：B 的启动晚于 A 的完成
    assert.ok(ns("c") < nf("a"), "C 应与 A 并行（C.node_started 先于 A.node_finished）");
    assert.ok(ns("b") > nf("a"), "B 应等 A 完成后才开始（依赖序）");

    // 全链事件族与 causation 链
    const created = events[0];
    assert.equal(created.event_type, "task.created");
    const plannedE = events[1];
    const startedE = events[2];
    assert.equal(plannedE.event_type, "task.planned");
    assert.equal(startedE.event_type, "task.started");
    assert.equal(plannedE.causation_id, created.event_id);
    assert.equal(startedE.causation_id, plannedE.event_id);
    const nsA = events[ns("a")];
    assert.equal(nsA.causation_id, startedE.event_id);
    assert.equal(nsA.payload.attempt, 1);

    const toolStartIdx = seqOf((e) => e.event_type === "tool.started");
    const toolFinishIdx = seqOf((e) => e.event_type === "tool.finished");
    const toolStart = events[toolStartIdx];
    assert.equal(toolStart.causation_id, nsA.event_id, "工具事件 causation 链到节点");
    assert.equal(toolStart.task_id, detail.task_id);
    assert.equal(events[toolFinishIdx].causation_id, toolStart.event_id);

    const nfA = events[nf("a")];
    assert.equal(nfA.causation_id, nsA.event_id);
    assert.equal(nfA.payload.status, "completed");
    assert.equal(nfA.payload.result, "a-ok");

    const last = events[events.length - 1];
    assert.equal(last.event_type, "task.completed");
    assert.equal(last.causation_id, startedE.event_id);
    for (const e of events) assert.equal(e.task_id, detail.task_id, "全部事件 task_id 关联");
    for (const e of events.slice(1)) assert.equal(e.actor_id, "agent:runtime");
  } finally {
    h.close();
  }
});

test("scheduler honors the concurrency limit (default 2; never exceeds it; parallelism is real)", async () => {
  const h = openService(planJson([
    { key: "n1", title: "N1" },
    { key: "n2", title: "N2" },
    { key: "n3", title: "N3" },
  ]));
  try {
    const detail = await plannedTask(h);
    let active = 0;
    let maxActive = 0;
    let releaseAll: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseAll = resolve; });
    const gateTool: MorrowTool = {
      name: "gate", description: "gate", parameters: { type: "object", properties: {} },
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return { text: "ok" };
      },
    };
    const scheduler = makeScheduler(h, nodeFactory({
      n1: [{ kind: "tool", toolName: "gate" }],
      n2: [{ kind: "tool", toolName: "gate" }],
      n3: [{ kind: "tool", toolName: "gate" }],
    }, [gateTool]));
    const running = scheduler.schedule(detail.task_id);
    await waitFor("two nodes to run concurrently", () => active === 2);
    assert.ok(maxActive <= 2, `并发不得超过上限 2（观测 ${maxActive}）`);
    releaseAll();
    await running;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "completed");
    assert.equal(maxActive, 2, "默认上限 2 下应真实并行 2 个节点");
  } finally {
    h.close();
  }
});

test("scheduler with concurrency 1 runs strictly serially", async () => {
  const h = openService(planJson([
    { key: "n1", title: "N1" },
    { key: "n2", title: "N2" },
    { key: "n3", title: "N3" },
  ]));
  try {
    const detail = await plannedTask(h);
    let active = 0;
    let maxActive = 0;
    const slowTool: MorrowTool = {
      name: "slow", description: "slow", parameters: { type: "object", properties: {} },
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return { text: "ok" };
      },
    };
    const scheduler = makeScheduler(h, nodeFactory({
      n1: [{ kind: "tool", toolName: "slow" }],
      n2: [{ kind: "tool", toolName: "slow" }],
      n3: [{ kind: "tool", toolName: "slow" }],
    }, [slowTool]), 1);
    await scheduler.schedule(detail.task_id);
    assert.equal(h.svc.getTask(detail.task_id)?.status, "completed");
    assert.equal(maxActive, 1);
  } finally {
    h.close();
  }
});

test("retriable node retries once after a failed attempt; task still completes", async () => {
  const h = openService(planJson([{ key: "flaky", title: "Flaky", retriable: true }]));
  try {
    const detail = await plannedTask(h);
    let calls = 0;
    const scheduler = makeScheduler(h, async () => {
      calls += 1;
      return createFakePi({
        script: calls === 1
          ? [{ kind: "error", message: "boom" }]
          : [{ kind: "text", deltas: ["recovered"] }],
      });
    });
    await scheduler.schedule(detail.task_id);

    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    const flaky = final?.nodes[0];
    assert.equal(flaky?.attempts, 2);
    assert.equal(flaky?.status, "completed");
    assert.equal(flaky?.result, "recovered");

    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const nodeStarted = events.filter((e) => e.event_type === "task.node_started");
    const nodeFinished = events.filter((e) => e.event_type === "task.node_finished");
    assert.equal(nodeStarted.length, 2);
    assert.deepEqual(nodeStarted.map((e) => e.payload.attempt), [1, 2]);
    assert.deepEqual(nodeFinished.map((e) => e.payload.status), ["failed", "completed"]);
    assert.equal(nodeFinished[0].payload.error, "boom");
    assert.equal(calls, 2);
  } finally {
    h.close();
  }
});

test("non-retriable node failure fails the whole task with the failing node identified", async () => {
  const h = openService(planJson([
    { key: "doomed", title: "Doomed", retriable: false },
    { key: "after", title: "After", depends_on: ["doomed"] },
  ]));
  try {
    const detail = await plannedTask(h);
    const scheduler = makeScheduler(h, nodeFactory({
      doomed: [{ kind: "error", message: "hard failure" }],
      after: [{ kind: "text", deltas: ["never"] }],
    }));
    await scheduler.schedule(detail.task_id);

    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "failed");
    assert.equal(final?.nodes.find((n) => n.key === "doomed")?.status, "failed");
    assert.equal(final?.nodes.find((n) => n.key === "after")?.status, "pending");

    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const last = events[events.length - 1];
    assert.equal(last.event_type, "task.failed");
    assert.equal(last.payload.reason, "node_failed");
    assert.equal(last.payload.node_id, final?.nodes.find((n) => n.key === "doomed")?.node_id);
    assert.match(String(last.payload.message), /hard failure/);
  } finally {
    h.close();
  }
});

test("scheduler rejects scheduling a task that is not in planned state", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await plannedTask(h);
    const scheduler = makeScheduler(h, nodeFactory({}));
    await scheduler.schedule(detail.task_id); // 第一次：planned → running → completed
    await assert.rejects(
      () => scheduler.schedule(detail.task_id),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );
  } finally {
    h.close();
  }
});

test("listTasks returns every task with summary fields", async () => {
  const h = openService(MIXED_PLAN);
  try {
    await plannedTask(h, "任务一");
    const failed = await openService("bad json");
    try {
      await failed.svc.createTask("任务二");
      const list = h.svc.listTasks();
      assert.equal(list.length, 1);
      assert.equal(list[0].goal, "任务一");
      assert.equal(list[0].status, "planned");
      assert.equal(list[0].task_version, 1);
      assert.match(list[0].created_at, /Z$/);
    } finally {
      failed.close();
    }
  } finally {
    h.close();
  }
});

test("taskEvents paginates by task and returns null for unknown tasks", async () => {
  const h = openService(planJson([{ key: "a", title: "A" }]));
  try {
    const detail = await plannedTask(h);
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["done"] }] }));
    await scheduler.schedule(detail.task_id);

    const all = h.svc.taskEvents(detail.task_id, { limit: 200 });
    assert.ok(all);
    assert.equal(all.total, all.events.length);
    assert.ok(all.total >= 6); // created/planned/started/node_started/node_finished/completed

    const page1 = h.svc.taskEvents(detail.task_id, { limit: 2, offset: 0 });
    assert.equal(page1?.events.length, 2);
    assert.equal(page1?.total, all.total);
    const page2 = h.svc.taskEvents(detail.task_id, { limit: 2, offset: 2 });
    assert.deepEqual(page2?.events[0].event_id, all.events[2].event_id);
    const beyond = h.svc.taskEvents(detail.task_id, { limit: 2, offset: all.total + 10 });
    assert.equal(beyond?.events.length, 0);

    assert.equal(h.svc.taskEvents("01936b9d-8f7a-7abc-9f2e-000000000000"), null);
  } finally {
    h.close();
  }
});
