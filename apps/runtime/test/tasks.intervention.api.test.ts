// 人工介入端点 HTTP seam 测试（票 M1-T6 / Issue #18，PRD §6.2 任务介入族、§5.2 流程 2）：
// POST /v1/tasks/:id/revise、POST /v1/tasks/:id/nodes/:nodeId/{takeover,complete,release}。
// FakePi/慢工具注入（零网络）：慢工具让 pause 请求在途时节点自行收尾，得到
// 「部分节点已完成、任务 paused」的确定性状态——AC-12 的 暂停→修改→恢复 走全链路。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope, TaskDetail, TaskSummary } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import type { CheckpointRecord } from "../src/checkpoint.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

const SERIAL_PLAN = planJson([
  { key: "a", title: "A", goal: "do a", depends_on: [], side_effect: "reversible" },
  { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
]);

function testConfig(dir: string): RuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    replicaId: REPLICA,
    provider: null,
  };
}

interface Harness {
  base: string;
  dir: string;
  close(): Promise<void>;
}

/** 慢工具：固定时长执行——pause 请求在途时节点自行收尾（免手动放行的 loopback 竞态） */
function slowTool(ms: number): MorrowTool {
  return {
    name: "slow",
    description: "slow",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === "function") timer.unref();
      });
      return { text: "slow-done" };
    },
  };
}

async function openRuntime(opts: {
  plan?: string;
  nodeScripts?: Record<string, FakeStep[]>;
  tools?: MorrowTool[];
  sessionAgent?: boolean;
} = {}): Promise<Harness> {
  const dir = tmpDir("morrow-interv-api-");
  const nodeScripts = opts.nodeScripts;
  const tools = opts.tools;
  const runtime = await startRuntime(testConfig(dir), {
    ...(opts.plan === undefined
      ? {}
      : {
          taskPlannerFactory: async () => createFakePi({ script: planScript(opts.plan as string) }),
          taskNodeAgentFactory: async (node) =>
            createFakePi({ script: nodeScripts?.[node.key] ?? [{ kind: "text", deltas: [node.goal] }], tools }),
        }),
    ...(opts.sessionAgent === undefined
      ? {}
      : {
          agentAdapterFactory: async () =>
            createFakePi({ script: [{ kind: "text", deltas: ["会话回声"] }] }),
        }),
  });
  return { base: `http://127.0.0.1:${runtime.port}`, dir, close: () => runtime.close() };
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function getTask(h: Harness, taskId: string): Promise<TaskDetail> {
  return json<TaskDetail>(await fetch(`${h.base}/v1/tasks/${taskId}`));
}

async function post(h: Harness, path: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

interface ApiError {
  error: { code: string; message: string };
}

interface LedgerPageBody {
  events: EventEnvelope[];
  total: number;
}

/**
 * pause 的确定性窗口：a 在慢工具里跑时受理 pause（#pausing 即时停派发）→ 等安全点
 * （a 自然收尾）→ paused。结果 = a 已完成、b（依赖 a）仍 pending 的 paused 任务。
 */
async function pausedTaskWithCompletedA(h: Harness): Promise<TaskDetail> {
  const created = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "演示介入" }));
  await waitFor("node a running", async () => {
    const detail = await getTask(h, created.task_id);
    return detail.nodes.find((n) => n.key === "a")?.status === "running";
  });
  const paused = await post(h, `/v1/tasks/${created.task_id}/pause`);
  assert.equal(paused.status, 200, `pause 应成功: ${JSON.stringify(await paused.text())}`);
  return getTask(h, created.task_id);
}

// --- revise 端点（暂停 → 修改 → 恢复 全链路） ------------------------------------

test("POST revise: pause → revise (version+1, downstream recomputed, checkpoint) → resume completes with new goal", async () => {
  const h = await openRuntime({
    plan: SERIAL_PLAN,
    nodeScripts: {
      a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
    },
    tools: [slowTool(500)],
  });
  try {
    const paused = await pausedTaskWithCompletedA(h);
    const b = paused.nodes.find((n) => n.key === "b") as NonNullable<(typeof paused.nodes)[number]>;
    assert.equal(paused.status, "paused");
    assert.equal(paused.task_version, 1);
    assert.equal(b.status, "pending");

    // 已完成节点拒改（immutable_node → 409），版本不动
    const a = paused.nodes.find((n) => n.key === "a") as NonNullable<(typeof paused.nodes)[number]>;
    const badA = await post(h, `/v1/tasks/${paused.task_id}/revise`, {
      update: [{ key: "a", goal: "x" }],
    });
    assert.equal(badA.status, 409);
    assert.equal(((await json<ApiError>(badA)).error).code, "task_immutable_node");
    const badRemove = await post(h, `/v1/tasks/${paused.task_id}/revise`, { remove: ["a"] });
    assert.equal(badRemove.status, 409);

    // 合法修订：改 b 的 goal/model + 新增节点 + 空修改集拒绝
    const badEmpty = await post(h, `/v1/tasks/${paused.task_id}/revise`, {});
    assert.equal(badEmpty.status, 400);
    assert.equal(((await json<ApiError>(badEmpty)).error).code, "task_invalid_revision");

    const revised = await post(h, `/v1/tasks/${paused.task_id}/revise`, {
      update: [{ key: "b", goal: "do b revised", model: "demo-model" }],
      add: [{ key: "c", title: "C", goal: "do c", depends_on: ["b"] }],
    });
    assert.equal(revised.status, 200);
    const revisedBody = await json<{ task: TaskDetail; revision: Record<string, unknown>; checkpoint: CheckpointRecord }>(revised);
    assert.equal(revisedBody.task.task_version, 2);
    const bAfter = revisedBody.task.nodes.find((n) => n.key === "b") as NonNullable<(typeof revisedBody.task.nodes)[number]>;
    assert.equal(bAfter.goal, "do b revised");
    assert.equal(bAfter.model, "demo-model");
    const cAfter = revisedBody.task.nodes.find((n) => n.key === "c") as NonNullable<(typeof revisedBody.task.nodes)[number]>;
    assert.deepEqual(cAfter.depends_on, ["b"]);
    assert.equal(revisedBody.checkpoint.reason, "revise", "修订后自动落新 checkpoint");
    assert.equal(revisedBody.checkpoint.task_version, 2);

    // 审计事件：task.revised actor=owner
    const events = await json<LedgerPageBody>(
      await fetch(`${h.base}/v1/tasks/${paused.task_id}/events?limit=200`),
    );
    const revisedEvent = events.events.filter((e) => e.event_type === "task.revised").at(-1);
    assert.ok(revisedEvent !== undefined);
    assert.equal(revisedEvent.actor_id, "owner");
    assert.deepEqual(revisedEvent.payload.summary, {
      updated_keys: ["b"],
      added_keys: ["c"],
      removed_keys: [],
    });

    // 恢复 → 新 DAG 跑完（b 用修订后的 goal 执行）
    const resume = await post(h, `/v1/tasks/${paused.task_id}/resume`);
    assert.equal(resume.status, 202);
    await waitFor("task to complete", async () => {
      const detail = await getTask(h, paused.task_id);
      return detail.status === "completed" || detail.status === "failed";
    });
    const final = await getTask(h, paused.task_id);
    assert.equal(final.status, "completed");
    assert.equal(final.nodes.find((n) => n.key === "a")?.result, "a-ok", "已完成节点不受修订影响");
    assert.ok(final.nodes.every((n) => n.status === "completed"));
    assert.ok(final.nodes.some((n) => n.key === "c"), "新增节点随恢复执行");
  } finally {
    await h.close();
  }
});

test("POST revise on running and terminal tasks → 409; revise on failed task reaches validation", async () => {
  const h = await openRuntime({
    plan: SERIAL_PLAN,
    nodeScripts: {
      a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
    },
    tools: [slowTool(500)],
  });
  try {
    // running 拒绝（slow 工具让任务保持 running 足够久）
    const created = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "运行中修订" }));
    const running = await post(h, `/v1/tasks/${created.task_id}/revise`, {
      update: [{ key: "b", goal: "x" }],
    });
    assert.equal(running.status, 409);
    assert.equal(((await json<ApiError>(running)).error).code, "task_invalid_transition");

    // completed 拒绝（终端态 409）
    const completed = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "等完成" }));
    await waitFor("task completes", async () => {
      const detail = await getTask(h, completed.task_id);
      return detail.status === "completed";
    });
    const reviseDone = await post(h, `/v1/tasks/${completed.task_id}/revise`, {
      update: [{ key: "b", goal: "x" }],
    });
    assert.equal(reviseDone.status, 409);

    // failed 任务过状态门（failed 无节点 → 修改集校验失败 400，而非终端态 409）
    const badPlanner = await openRuntime({ plan: "not json" });
    try {
      const failedTask = await json<TaskDetail>(await post(badPlanner, "/v1/tasks", { goal: "坏规划" }));
      assert.equal(failedTask.status, "failed");
      const reviseFailed = await post(badPlanner, `/v1/tasks/${failedTask.task_id}/revise`, {
        update: [{ key: "b", goal: "x" }],
      });
      assert.equal(reviseFailed.status, 400);
    } finally {
      await badPlanner.close();
    }
  } finally {
    await h.close();
  }
});

// --- takeover / complete / release 端点 ------------------------------------------

test("takeover/complete/release over HTTP: owner audit events, node actor flips, scheduler hands off", async () => {
  const h = await openRuntime({
    plan: SERIAL_PLAN,
    nodeScripts: {
      a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
    },
    tools: [slowTool(500)],
  });
  try {
    const created = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "接管演示" }));
    const b = () =>
      getTask(h, created.task_id).then(
        (d) => d.nodes.find((n) => n.key === "b") as NonNullable<(typeof d.nodes)[number]>,
      );
    await waitFor("node a running", async () => (await getTask(h, created.task_id)).nodes.find((n) => n.key === "a")?.status === "running");

    // running 节点不可接管（先暂停）；pending 节点（b）可接管
    const aId = (await getTask(h, created.task_id)).nodes.find((n) => n.key === "a")?.node_id as string;
    const badRunning = await post(h, `/v1/tasks/${created.task_id}/nodes/${aId}/takeover`);
    assert.equal(badRunning.status, 409);

    const bBefore = await b();
    const taken = await post(h, `/v1/tasks/${created.task_id}/nodes/${bBefore.node_id}/takeover`);
    assert.equal(taken.status, 200);
    assert.equal((await b()).actor, "owner");

    // 重复接管 409
    const again = await post(h, `/v1/tasks/${created.task_id}/nodes/${bBefore.node_id}/takeover`);
    assert.equal(again.status, 409);

    // release → actor 清空 + 审计
    const released = await post(h, `/v1/tasks/${created.task_id}/nodes/${bBefore.node_id}/release`);
    assert.equal(released.status, 200);
    assert.equal((await b()).actor, undefined);

    // 再接管 → owner 完成（提交结果）
    await post(h, `/v1/tasks/${created.task_id}/nodes/${bBefore.node_id}/takeover`);
    const done = await post(h, `/v1/tasks/${created.task_id}/nodes/${bBefore.node_id}/complete`, {
      result: "owner 手工结果",
    });
    assert.equal(done.status, 200);
    const bAfter = await b();
    assert.equal(bAfter.status, "completed");
    assert.equal(bAfter.result, "owner 手工结果");
    assert.equal(bAfter.actor, "owner");

    // 审计事件族（actor 全部 owner）
    const events = await json<LedgerPageBody>(
      await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=200`),
    );
    const auditTypes = ["task.node_taken_over", "task.node_released", "task.node_completed_by_owner"];
    for (const type of auditTypes) {
      const event = events.events.filter((e) => e.event_type === type).at(-1);
      assert.ok(event !== undefined, `${type} 已留痕`);
      assert.equal(event.actor_id, "owner");
    }

    // 未接管节点 complete → 409；任务照常跑到 completed
    const aNode = (await getTask(h, created.task_id)).nodes.find((n) => n.key === "a") as NonNullable<(typeof created.nodes)[number]>;
    const badComplete = await post(h, `/v1/tasks/${created.task_id}/nodes/${aNode.node_id}/complete`, { result: "x" });
    assert.equal(badComplete.status, 409);
    await waitFor("task completes", async () => (await getTask(h, created.task_id)).status === "completed");
  } finally {
    await h.close();
  }
});

test("takeover parks a running task in waiting_input (owner_intervention); release + auto-kick finishes it", async () => {
  const h = await openRuntime({
    plan: SERIAL_PLAN,
    nodeScripts: {
      a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
    },
    tools: [slowTool(600)],
  });
  try {
    const created = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "接管挂起" }));
    // a 在跑（slow 工具）；b 因依赖未就绪而 pending——窗口内接管 b（确定性）
    await waitFor("node a running", async () => (await getTask(h, created.task_id)).nodes.find((n) => n.key === "a")?.status === "running");
    const bNode = (await getTask(h, created.task_id)).nodes.find((n) => n.key === "b") as NonNullable<(typeof created.nodes)[number]>;
    const taken = await post(h, `/v1/tasks/${created.task_id}/nodes/${bNode.node_id}/takeover`);
    assert.equal(taken.status, 200, `接管应成功: ${taken.status}`);

    // a 收尾后调度器跳过 owner 节点 → waiting_input(owner_intervention)
    await waitFor("waiting_input", async () => (await getTask(h, created.task_id)).status === "waiting_input");
    const events = await json<LedgerPageBody>(
      await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=200`),
    );
    const waiting = events.events.filter((e) => e.event_type === "task.waiting_input").at(-1);
    assert.ok(waiting !== undefined);
    assert.equal(waiting.payload.reason, "owner_intervention");

    // release → HTTP 层自动 kick → 任务继续跑到 completed
    const released = await post(h, `/v1/tasks/${created.task_id}/nodes/${bNode.node_id}/release`);
    assert.equal(released.status, 200);
    await waitFor("task completes after release kick", async () => (await getTask(h, created.task_id)).status === "completed");
  } finally {
    await h.close();
  }
});

// --- session 关联（Chat 任务卡片地基） -------------------------------------------

test("POST /v1/tasks accepts session_id; GET /v1/tasks?session_id filters; unknown session 400", async () => {
  const h = await openRuntime({
    plan: SERIAL_PLAN,
    nodeScripts: {
      a: [{ kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
    },
    sessionAgent: true,
  });
  try {
    const session = await json<{ session_id: string }>(
      await post(h, "/v1/sessions", {}),
    );
    const bad = await post(h, "/v1/tasks", { goal: "x", session_id: "nope" });
    assert.equal(bad.status, 400);

    const created = await json<TaskDetail>(
      await post(h, "/v1/tasks", { goal: "会话内任务", session_id: session.session_id }),
    );
    assert.equal(created.session_id, session.session_id);
    const orphan = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "无来源任务" }));
    assert.equal(orphan.session_id, undefined);

    const list = await json<{ tasks: TaskSummary[] }>(
      await fetch(`${h.base}/v1/tasks?session_id=${session.session_id}`),
    );
    assert.deepEqual(list.tasks.map((t) => t.task_id), [created.task_id]);

    const createdEvent = await json<LedgerPageBody>(
      await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=10`),
    );
    const first = createdEvent.events[0];
    assert.equal(first.event_type, "task.created");
    assert.equal(first.payload.session_id, session.session_id, "来源会话随 task.created 留痕");
  } finally {
    await h.close();
  }
});
