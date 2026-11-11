// 人工介入服务层 seam 测试（票 M1-T6 / Issue #18，PRD §4.3 FR-TASK-3、§5.2 流程 2）：
// reviseTask（未完成节点修改集 → task_version+1、下游依赖重算、task.revised 审计事件、
// failed 终端态回卷）与 takeover/complete/release（节点 actor=owner 审计事件族）。
// 账本是唯一事实源：事件断言全部走 svc.taskEvents（按 task_id 过滤的账本读路径）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { EventEnvelope, TaskNodeRecord } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { TaskScheduler, type NodeAgentFactory } from "../src/scheduler.ts";
import { CheckpointService } from "../src/checkpoint.ts";
import { TaskError, TaskService } from "../src/tasks.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

/** A→B 串行 + C 与 A 并行的脚本化 DAG（与 tasks.test.ts 同一形状） */
const MIXED_PLAN = planJson([
  { key: "a", title: "节点A", goal: "do a", depends_on: [], retriable: true },
  { key: "b", title: "节点B", goal: "do b", depends_on: ["a"], retriable: false },
  { key: "c", title: "节点C", goal: "do c", depends_on: [], retriable: true },
]);

/** B 同时依赖 A 与 C 的 DAG（下游重算用：移除 C 后 B 的依赖被重算） */
const DIAMOND_PLAN = planJson([
  { key: "a", title: "A", goal: "do a", depends_on: [] },
  { key: "c", title: "C", goal: "do c", depends_on: [] },
  { key: "b", title: "B", goal: "do b", depends_on: ["a", "c"] },
]);

interface Harness {
  svc: TaskService;
  checkpoints: CheckpointService;
  dir: string;
  close(): void;
}

function openService(plannerOutput: string): Harness {
  const dir = tmpDir("morrow-interv-");
  const ledger = EventLedger.open(dir);
  const svc = new TaskService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    factory: async () => createFakePi({ script: planScript(plannerOutput) }),
  });
  const checkpoints = new CheckpointService({ tasks: svc, dataDir: dir, ledger, replicaId: REPLICA });
  return { svc, checkpoints, dir, close: () => { svc.close(); checkpoints.close(); ledger.close(); removeDir(dir); } };
}

function nodeFactory(scripts: Record<string, FakeStep[]>): NodeAgentFactory {
  return async (node) => createFakePi({ script: scripts[node.key] ?? [] });
}

function makeScheduler(h: Harness, factory: NodeAgentFactory | null): TaskScheduler {
  return new TaskScheduler({
    tasks: h.svc,
    ledger: h.svc.ledger,
    replicaId: REPLICA,
    nodeAgentFactory: factory,
    checkpoints: h.checkpoints,
  });
}

function types(events: EventEnvelope[]): string[] {
  return events.map((e) => e.event_type);
}

/** 轮询直到同步条件成立（调度是异步 fire-and-forget，终态只能轮询观测） */
function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return Promise.resolve();
    // 同步睡眠让出事件循环（node:test 单线程；调度推进依赖微任务/定时器）
    return new Promise((resolve) => setTimeout(resolve, 25)).then(() => waitFor(what, cond, timeoutMs));
  }
  return Promise.reject(new Error(`timeout waiting for ${what}`));
}

function nodeOf(detail: { nodes: TaskNodeRecord[] }, key: string): TaskNodeRecord {
  const node = detail.nodes.find((n) => n.key === key);
  assert.ok(node !== undefined, `node ${key} exists`);
  return node;
}

// --- revise：版本 +1 / 修改集 / 审计事件 -----------------------------------------

test("reviseTask updates an unfinished node: task_version+1, fields applied, task.revised event actor=owner with summary", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await h.svc.createTask("整理周报");
    const result = h.svc.reviseTask(detail.task_id, {
      update: [{ key: "b", goal: "do b2", model: "provider-b" }],
    });
    assert.equal(result.task.status, "planned", "planned 任务 revise 后保持 planned");
    assert.equal(result.task.task_version, 2);
    const b = nodeOf(result.task, "b");
    assert.equal(b.goal, "do b2");
    assert.equal(b.model, "provider-b");
    assert.deepEqual(b.depends_on, ["a"], "未声明的字段不受影响");
    assert.deepEqual(result.revision.updated_keys, ["b"]);
    assert.deepEqual(result.revision.added_keys, []);
    assert.deepEqual(result.revision.removed_keys, []);

    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    const revised = events.at(-1);
    assert.equal(revised?.event_type, "task.revised");
    assert.equal(revised?.actor_id, "owner", "介入操作审计：actor 是 owner");
    assert.equal(revised?.payload.task_version, 2);
    assert.deepEqual(revised?.payload.summary, { updated_keys: ["b"], added_keys: [], removed_keys: [] });
    const changes = revised?.payload.changes as { update: unknown[]; add: unknown[]; remove: string[] };
    assert.equal(changes.update.length, 1, "修改内容摘要随事件留痕");
    assert.equal(changes.update[0] && (changes.update[0] as { key: string }).key, "b");
  } finally {
    h.close();
  }
});

test("reviseTask adds and removes nodes and recomputes downstream deps of the removed node", async () => {
  const h = openService(DIAMOND_PLAN);
  try {
    const detail = await h.svc.createTask("下游重算");
    const result = h.svc.reviseTask(detail.task_id, {
      add: [{ key: "d", title: "新增D", goal: "do d", depends_on: ["b"] }],
      remove: ["c"],
    });
    assert.equal(result.task.task_version, 2);
    assert.deepEqual(result.task.nodes.map((n) => n.key), ["a", "b", "d"], "c 被移除，d 被新增");
    const b = nodeOf(result.task, "b");
    assert.deepEqual(b.depends_on, ["a"], "下游依赖重算：被移除的 c 从 b 的依赖里剥离");
    const d = nodeOf(result.task, "d");
    assert.deepEqual(d.depends_on, ["b"]);
    assert.equal(d.status, "pending");
    assert.equal(d.retriable, true, "新增节点缺省 retriable=true（与规划缺省一致）");
    assert.equal(d.side_effect, "delivery_unknown");

    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    const revised = events.at(-1);
    assert.equal(revised?.event_type, "task.revised");
    assert.deepEqual(revised?.payload.summary, {
      updated_keys: [],
      added_keys: ["d"],
      removed_keys: ["c"],
    });
  } finally {
    h.close();
  }
});

test("reviseTask on a failed task rolls the task back to planned (终端态回卷的正道)", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await h.svc.createTask("失败后修订");
    h.svc.transition(detail.task_id, "running");
    h.svc.transition(detail.task_id, "failed", { error: "boom" });
    const result = h.svc.reviseTask(detail.task_id, {
      update: [{ key: "b", goal: "do b fixed" }],
    });
    assert.equal(result.task.status, "planned", "failed → planned 是 revise 专属回卷");
    assert.equal(result.task.task_version, 2);
    assert.equal(result.revision.status_rolled_back, true);

    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    assert.deepEqual(types(events).slice(-2), ["task.revised", "task.planned"]);
    assert.equal(events.at(-1)?.payload.reason, "revised_after_failure");
    assert.equal(events.at(-2)?.actor_id, "owner");
  } finally {
    h.close();
  }
});

// --- revise：守卫 ----------------------------------------------------------------

test("reviseTask rejects completed-node modification and removal (已完成节点不可改)", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await h.svc.createTask("守卫");
    const a = nodeOf(detail, "a");
    h.svc.setNodeFinished(a.node_id, "completed", { result: "a-ok" });
    assert.throws(
      () => h.svc.reviseTask(detail.task_id, { update: [{ key: "a", goal: "x" }] }),
      (err: TaskError) => err instanceof TaskError && err.code === "immutable_node",
    );
    assert.throws(
      () => h.svc.reviseTask(detail.task_id, { remove: ["a"] }),
      (err: TaskError) => err instanceof TaskError && err.code === "immutable_node",
    );
    assert.equal(h.svc.getTask(detail.task_id)?.task_version, 1, "被拒绝的修订不 bump 版本");
  } finally {
    h.close();
  }
});

test("reviseTask rejects unknown/duplicate keys, bad deps, cycles and empty change sets", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await h.svc.createTask("非法修订");
    const taskId = detail.task_id;
    const invalid = (revision: object, code = "invalid_revision"): void => {
      assert.throws(
        () => h.svc.reviseTask(taskId, revision as never),
        (err: TaskError) => err instanceof TaskError && err.code === code,
        JSON.stringify(revision),
      );
    };
    invalid({}); // 空修改集
    invalid({ update: [{ key: "nope", goal: "x" }] }); // 未知 key
    invalid({ remove: ["nope"] });
    invalid({ add: [{ key: "b", title: "重复 key" }] }); // 与既有 key 冲突
    invalid({ update: [{ key: "b", goal: "x" }], remove: ["b"] }); // 同一 key 双重修改
    invalid({ update: [{ key: "b", depends_on: ["ghost"] }] }); // 依赖未知节点
    invalid({ update: [{ key: "a", depends_on: ["b"] }] }); // a→b→a 成环
    invalid({ add: [{ key: "d", title: "D", depends_on: ["d"] }] }); // 自依赖
    invalid({ update: [{ key: "b", goal: "" }] }); // 空 goal
    invalid({ add: [{ key: "BAD KEY", title: "D" }] }); // key 模式
    assert.equal(h.svc.getTask(taskId)?.task_version, 1, "全部拒绝：版本不动");
  } finally {
    h.close();
  }
});

test("reviseTask is gated by task status: running and terminal states reject, with terminal 409 semantics", async () => {
  const h = openService(MIXED_PLAN);
  try {
    // running 拒绝（PRD §5.2 流程 2：先暂停再修改）
    const running = await h.svc.createTask("运行中");
    h.svc.transition(running.task_id, "running");
    assert.throws(
      () => h.svc.reviseTask(running.task_id, { update: [{ key: "b", goal: "x" }] }),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );
    // completed / cancelled 终端态拒绝
    const done = await h.svc.createTask("已完成");
    h.svc.transition(done.task_id, "running");
    h.svc.transition(done.task_id, "completed");
    assert.throws(
      () => h.svc.reviseTask(done.task_id, { update: [{ key: "b", goal: "x" }] }),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );
    const cancelled = await h.svc.createTask("已取消");
    h.svc.transition(cancelled.task_id, "cancelled");
    assert.throws(
      () => h.svc.reviseTask(cancelled.task_id, { update: [{ key: "b", goal: "x" }] }),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );
    // planned / paused / waiting_input 允许（paused 路径走 HTTP e2e）
    const planned = await h.svc.createTask("待运行");
    const result = h.svc.reviseTask(planned.task_id, { update: [{ key: "b", goal: "x" }] });
    assert.equal(result.task.status, "planned");
    h.svc.transition(planned.task_id, "running");
    h.svc.transition(planned.task_id, "waiting_input");
    const result2 = h.svc.reviseTask(planned.task_id, { update: [{ key: "b", goal: "y" }] });
    assert.equal(result2.task.status, "waiting_input", "waiting_input 修订后保持原状态");
    assert.equal(result2.task.task_version, 3, "第二次修订在 v2 之上再 +1");
  } finally {
    h.close();
  }
});

// --- takeover / complete / release：节点 actor=owner ------------------------------

test("takeover marks a pending node actor=owner with an audit event; completing it records the owner result", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await h.svc.createTask("接管");
    const b = nodeOf(detail, "b");
    const taken = h.svc.takeoverNode(detail.task_id, b.node_id);
    assert.equal(nodeOf(taken, "b").actor, "owner");
    assert.equal(nodeOf(taken, "b").status, "pending");

    let events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    const takenOver = events.at(-1);
    assert.equal(takenOver?.event_type, "task.node_taken_over");
    assert.equal(takenOver?.actor_id, "owner");
    assert.equal(takenOver?.payload.node_id, b.node_id);
    assert.equal(takenOver?.payload.key, "b");

    // 重复接管拒绝
    assert.throws(
      () => h.svc.takeoverNode(detail.task_id, b.node_id),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );

    const completed = h.svc.completeNode(detail.task_id, b.node_id, "owner 手工完成的结果");
    const bAfter = nodeOf(completed, "b");
    assert.equal(bAfter.status, "completed");
    assert.equal(bAfter.result, "owner 手工完成的结果");
    assert.equal(bAfter.actor, "owner", "完成留痕：actor 仍是 owner");
    events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    const finished = events.at(-1);
    assert.equal(finished?.event_type, "task.node_completed_by_owner");
    assert.equal(finished?.actor_id, "owner");
    assert.equal(finished?.payload.result, "owner 手工完成的结果");
  } finally {
    h.close();
  }
});

test("release hands a taken-over node back to the scheduler with an audit event", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await h.svc.createTask("交还");
    const c = nodeOf(detail, "c");
    h.svc.takeoverNode(detail.task_id, c.node_id);
    const released = h.svc.releaseNode(detail.task_id, c.node_id);
    const cAfter = nodeOf(released, "c");
    assert.equal(cAfter.actor, undefined, "交还后节点回到调度器（actor 清空）");
    assert.equal(cAfter.status, "pending");
    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    const releasedEvent = events.at(-1);
    assert.equal(releasedEvent?.event_type, "task.node_released");
    assert.equal(releasedEvent?.actor_id, "owner");
    // 未接管的节点不能 complete/release
    const a = nodeOf(released, "a");
    assert.throws(
      () => h.svc.completeNode(detail.task_id, a.node_id, "x"),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );
    assert.throws(
      () => h.svc.releaseNode(detail.task_id, a.node_id),
      (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
    );
  } finally {
    h.close();
  }
});

test("takeover/complete/release reject terminal tasks and non-takeoverable nodes", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const done = await h.svc.createTask("终端态");
    h.svc.transition(done.task_id, "running");
    h.svc.transition(done.task_id, "completed");
    const b = nodeOf(h.svc.getTask(done.task_id) as NonNullable<typeof done>, "b");
    for (const op of ["takeover", "complete", "release"] as const) {
      assert.throws(
        () => {
          if (op === "takeover") h.svc.takeoverNode(done.task_id, b.node_id);
          else if (op === "complete") h.svc.completeNode(done.task_id, b.node_id, "x");
          else h.svc.releaseNode(done.task_id, b.node_id);
        },
        (err: TaskError) => err instanceof TaskError && err.code === "invalid_transition",
        `terminal 任务拒绝 ${op}`,
      );
    }
    // 完成节点不可接管（immutable）
    const live = await h.svc.createTask("活任务");
    const a = nodeOf(live, "a");
    h.svc.setNodeFinished(a.node_id, "completed", { result: "x" });
    assert.throws(
      () => h.svc.takeoverNode(live.task_id, a.node_id),
      (err: TaskError) => err instanceof TaskError && err.code === "immutable_node",
    );
  } finally {
    h.close();
  }
});

// --- 调度器协作：owner 节点跳过派发 / waiting_input / kick ------------------------

test("scheduler skips owner-owned nodes and parks the task in waiting_input; owner completion + kick finishes it", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await h.svc.createTask("接管调度");
    const b = nodeOf(detail, "b");
    h.svc.takeoverNode(detail.task_id, b.node_id);
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
      c: [{ kind: "text", deltas: ["c-ok"] }],
    }));
    const done = scheduler.schedule(detail.task_id);
    await done;
    await waitFor("waiting_input (owner_intervention)", () =>
      h.svc.getTask(detail.task_id)?.status === "waiting_input",
    );
    const parked = h.svc.getTask(detail.task_id);
    assert.equal(parked?.status, "waiting_input");
    assert.deepEqual(nodeOf(parked as NonNullable<typeof parked>, "b").status, "pending", "owner 节点不被派发");
    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    const waiting = events.find((e) => e.event_type === "task.waiting_input");
    assert.equal(waiting?.payload.reason, "owner_intervention");

    // Owner 完成 + kick → 任务继续跑到 completed
    h.svc.completeNode(detail.task_id, b.node_id, "owner 补齐");
    await scheduler.kick(detail.task_id);
    await waitFor("completed", () => h.svc.getTask(detail.task_id)?.status === "completed");
    const final = h.svc.getTask(detail.task_id);
    assert.equal(nodeOf(final as NonNullable<typeof final>, "b").result, "owner 补齐", "owner 结果不被重跑覆盖");
  } finally {
    h.close();
  }
});

test("release + kick returns the node to the scheduler which executes it", async () => {
  const h = openService(MIXED_PLAN);
  try {
    const detail = await h.svc.createTask("交还调度");
    const c = nodeOf(detail, "c");
    h.svc.takeoverNode(detail.task_id, c.node_id);
    const scheduler = makeScheduler(h, nodeFactory({
      a: [{ kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
      c: [{ kind: "text", deltas: ["c-ok"] }],
    }));
    await scheduler.schedule(detail.task_id);
    await waitFor("waiting_input", () => h.svc.getTask(detail.task_id)?.status === "waiting_input");
    h.svc.releaseNode(detail.task_id, c.node_id);
    await scheduler.kick(detail.task_id);
    await waitFor("completed", () => h.svc.getTask(detail.task_id)?.status === "completed");
    const final = h.svc.getTask(detail.task_id);
    assert.equal(nodeOf(final as NonNullable<typeof final>, "c").result, "c-ok");
  } finally {
    h.close();
  }
});
