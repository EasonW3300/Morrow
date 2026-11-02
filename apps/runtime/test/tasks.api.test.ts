// Task HTTP API seam 测试（票 M1-T4 / Issue #16，PRD §6.2 任务族端点）：
// POST/GET /v1/tasks、GET /v1/tasks/:id、GET /v1/tasks/:id/events。
// FakePi 注入（规划 + 节点执行），零网络；POST 规划后后台自动调度，测试轮询终态断言
// （curl 演示路径与票面验收一致：创建 → 详情 → 事件分页）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope, TaskDetail, TaskSummary } from "@morrow/protocol";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

/** A→B 串行 + C 并行（与服务层测试同一脚本化 DAG） */
const MIXED_PLAN = planJson([
  { key: "a", title: "节点A", goal: "do a", depends_on: [], agent_role: "researcher", retriable: true, side_effect: "irreversible" },
  { key: "b", title: "节点B", goal: "do b", depends_on: ["a"], retriable: false },
  { key: "c", title: "节点C", goal: "do c", depends_on: [], retriable: true },
]);

interface LedgerPageBody {
  events: EventEnvelope[];
  total: number;
  limit: number;
  offset: number;
}

interface ApiError {
  error: { code: string; message: string };
}

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

/** 起 runtime：注入 FakePi 规划器与节点工厂（plan 缺省 = 默认工厂路径，测 503） */
async function openRuntime(opts: {
  plan?: string;
  nodeScripts?: Record<string, FakeStep[]>;
  tools?: MorrowTool[];
} = {}): Promise<Harness> {
  const dir = tmpDir("morrow-tasks-api-");
  const nodeScripts = opts.nodeScripts;
  const runtime = await startRuntime(testConfig(dir), {
    ...(opts.plan === undefined
      ? {}
      : {
          taskPlannerFactory: async () => createFakePi({ script: planScript(opts.plan as string) }),
          taskNodeAgentFactory: async (node) =>
            createFakePi({ script: nodeScripts?.[node.key] ?? [{ kind: "text", deltas: [node.goal] }] }),
        }),
  });
  return { base: `http://127.0.0.1:${runtime.port}`, dir, close: () => runtime.close() };
}

/** 轮询直到异步条件成立（后台调度是 fire-and-forget，终态只能轮询观测） */
async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function createTask(h: Harness, body: Record<string, unknown>, contentType = "application/json"): Promise<Response> {
  return fetch(`${h.base}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

// --- 全链路（创建 → 规划 → 后台调度执行 → 完成） --------------------------------

test("POST /v1/tasks plans then auto-schedules; detail shows the finished DAG, events paginate", async () => {
  const h = await openRuntime({
    plan: MIXED_PLAN,
    nodeScripts: {
      a: [{ kind: "tool", toolName: "noop" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
      c: [{ kind: "text", deltas: ["c-ok"] }],
    },
    tools: [
      {
        name: "noop",
        description: "noop",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "done" }),
      },
    ],
  });
  try {
    const res = await createTask(h, { goal: "整理周报并归档" });
    assert.equal(res.status, 201);
    const created = await json<TaskDetail>(res);
    assert.match(created.task_id, /^[0-9a-f-]{36}$/);
    assert.equal(created.status, "planned", "响应是规划完成快照（执行在后台）");
    assert.equal(created.task_version, 1);
    assert.equal(created.nodes.length, 3);
    assert.equal(created.nodes[0].side_effect, "irreversible", "副作用分类字段随节点返回");
    assert.equal(created.nodes[1].side_effect, "delivery_unknown", "规划器缺省 → 保守未知分类");

    // 后台调度：轮询到终态（累计值收在 holder 对象里：闭包内赋值 + await 后读取）
    const observed: { detail: TaskDetail | null } = { detail: null };
    await waitFor("task to complete", async () => {
      const r = await fetch(`${h.base}/v1/tasks/${created.task_id}`);
      observed.detail = await json<TaskDetail>(r);
      const status = observed.detail?.status;
      return status === "completed" || status === "failed";
    });
    const final = observed.detail as TaskDetail | null;
    assert.equal(final?.status, "completed");
    assert.deepEqual(
      final?.nodes.map((n) => [n.key, n.status, n.result]),
      [
        ["a", "completed", "a-ok"],
        ["b", "completed", "b-ok"],
        ["c", "completed", "c-ok"],
      ],
    );
    assert.ok(final?.nodes.every((n) => typeof n.side_effect === "string"), "终态详情仍带副作用分类");

    // 事件分页：全量对照 + 窗口语义 + 非法入参
    const allRes = await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=200`);
    assert.equal(allRes.status, 200);
    const all = await json<LedgerPageBody>(allRes);
    assert.ok(all.total >= 6, "created/planned/started/node_started/node_finished/completed 至少 6 条");
    assert.equal(all.total, all.events.length);
    for (const e of all.events) assert.equal(e.task_id, created.task_id, "全部事件 task_id 关联");
    const typeSet = new Set(all.events.map((e) => e.event_type));
    for (const t of ["task.created", "task.planned", "task.started", "task.node_started", "task.node_finished", "task.completed"]) {
      assert.ok(typeSet.has(t), `事件族缺 ${t}`);
    }

    const p1 = await json<LedgerPageBody>(await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=2&offset=0`));
    const p2 = await json<LedgerPageBody>(await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=2&offset=2`));
    assert.equal(p1.total, all.total);
    assert.equal(p1.events.length, 2);
    assert.equal(p2.events[0].event_id, all.events[2].event_id);
    assert.equal((await json<LedgerPageBody>(await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=2&offset=999`))).events.length, 0);
    assert.equal((await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=0`)).status, 400);
    assert.equal((await fetch(`${h.base}/v1/tasks/${created.task_id}/events?limit=201`)).status, 400);
    assert.equal((await fetch(`${h.base}/v1/tasks/${created.task_id}/events?offset=-1`)).status, 400);

    // 列表
    const list = await json<{ tasks: TaskSummary[] }>(await fetch(`${h.base}/v1/tasks`));
    const entry = list.tasks.find((t) => t.task_id === created.task_id);
    assert.ok(entry, "列表包含该任务");
    assert.equal(entry?.status, "completed");
    assert.equal(entry?.goal, "整理周报并归档");
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

// --- 规划失败路径（坏输出 → task.failed 留痕，资源仍 201 返回） ------------------

test("POST /v1/tasks with a bad planner output returns the persisted failed task", async () => {
  const h = await openRuntime({ plan: "这不是 JSON" });
  try {
    const res = await createTask(h, { goal: "目标" });
    assert.equal(res.status, 201, "任务资源已创建并留痕（status=failed），不是 5xx");
    const detail = await json<TaskDetail>(res);
    assert.equal(detail.status, "failed");
    assert.match(detail.error ?? "", /JSON|plan/i);
    assert.equal(detail.nodes.length, 0);

    const events = await json<LedgerPageBody>(await fetch(`${h.base}/v1/tasks/${detail.task_id}/events`));
    assert.deepEqual(
      events.events.map((e) => e.event_type),
      ["task.created", "task.planning_failed", "task.failed"],
    );
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

// --- 预检与入参校验 -------------------------------------------------------------

test("POST /v1/tasks returns 503 planner_unavailable when no provider is configured (default factory path)", async () => {
  const h = await openRuntime(); // 不注入工厂 → 默认工厂路径，无 Provider
  try {
    const res = await createTask(h, { goal: "目标" });
    assert.equal(res.status, 503);
    const body = await json<ApiError>(res);
    assert.equal(body.error.code, "planner_unavailable");
    assert.ok(body.error.message.length > 0);
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

test("POST /v1/tasks validates the body: 400 on missing/empty goal, 415 on non-JSON content-type", async () => {
  const h = await openRuntime({ plan: planJson([{ key: "a", title: "A" }]) });
  try {
    for (const body of [{}, { goal: "" }, { goal: "   " }, { goal: 42 }]) {
      const res = await createTask(h, body);
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} 应 400`);
      const err = await json<ApiError>(res);
      assert.equal(err.error.code, "invalid_body");
    }
    const res415 = await fetch(`${h.base}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ goal: "目标" }),
    });
    assert.equal(res415.status, 415);
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

test("task endpoints 404 on unknown ids and 405 on mismatched methods", async () => {
  const h = await openRuntime({ plan: planJson([{ key: "a", title: "A" }]) });
  try {
    const unknown = "01936b9d-8f7a-7abc-9f2e-000000000000";
    const resDetail = await fetch(`${h.base}/v1/tasks/${unknown}`);
    assert.equal(resDetail.status, 404);
    assert.equal((await json<ApiError>(resDetail)).error.code, "task_not_found");
    const resEvents = await fetch(`${h.base}/v1/tasks/${unknown}/events`);
    assert.equal(resEvents.status, 404);

    const resDelete = await fetch(`${h.base}/v1/tasks/${unknown}`, { method: "DELETE" });
    assert.equal(resDelete.status, 405, "任务族无变更方法（账本 append-only 一致的取向）");
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});
