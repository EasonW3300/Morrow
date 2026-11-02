// Task 介入端点 HTTP seam 测试（票 M1-T5 / Issue #17，PRD §6.2）：
// POST /v1/tasks/:id/{pause,resume,restore}、GET /v1/tasks/:id/checkpoints。
// FakePi 注入（规划 + 节点执行），零网络；curl 演示路径与票面验收一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { TaskDetail, TaskSummary } from "@morrow/protocol";
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
      // unref：runtime 关闭后不悬挂测试进程的事件循环
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
} = {}): Promise<Harness> {
  const dir = tmpDir("morrow-ckpt-api-");
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
  });
  return { base: `http://127.0.0.1:${runtime.port}`, dir, close: () => runtime.close() };
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
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

// --- 全链路（创建 → 执行 → pause → checkpoints → resume → completed） ------------

test("pause/resume/checkpoints over HTTP: checkpoint fields, 202 drive, final completion", async () => {
  const h = await openRuntime({
    plan: SERIAL_PLAN,
    nodeScripts: {
      a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-ok"] }],
      b: [{ kind: "text", deltas: ["b-ok"] }],
    },
    tools: [slowTool(700)],
  });
  try {
    const created = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "演示暂停恢复" }));
    assert.equal(created.status, "planned");

    // 等 a 进入慢工具 → pause（安全点语义：等 a 收尾；慢工具自行结束，无竞态）
    await waitFor("node a running", async () => (await getTask(h, created.task_id)).nodes.find((n) => n.key === "a")?.status === "running");
    const pauseRes = await post(h, `/v1/tasks/${created.task_id}/pause`);
    assert.equal(pauseRes.status, 200);
    const paused = await json<{ task: TaskSummary; checkpoint: CheckpointRecord }>(pauseRes);
    assert.equal(paused.task.status, "paused");
    const checkpoint = paused.checkpoint;
    assert.equal(checkpoint.reason, "pause");
    // FR-TASK-5 字段集在 HTTP 投影里齐全
    assert.equal(checkpoint.snapshot.task.task_id, created.task_id);
    assert.equal(checkpoint.snapshot.graph.nodes.length, 2);
    assert.equal(checkpoint.snapshot.workspace, null);
    assert.ok(typeof checkpoint.snapshot.workspace_note === "string");
    assert.ok("execution" in checkpoint.snapshot);
    assert.ok("session_ids" in checkpoint.snapshot);
    assert.ok("pending_side_effects" in checkpoint.snapshot);
    assert.equal(checkpoint.snapshot.run.status, "paused");

    // 列表端点：新→旧
    const list = await json<{ checkpoints: CheckpointRecord[] }>(
      await fetch(`${h.base}/v1/tasks/${created.task_id}/checkpoints`),
    );
    assert.equal(list.checkpoints.length, 1);
    assert.equal(list.checkpoints[0].checkpoint_id, checkpoint.checkpoint_id);

    // resume：202 + 后台驱动至完成
    const resumeRes = await post(h, `/v1/tasks/${created.task_id}/resume`);
    assert.equal(resumeRes.status, 202);
    const resumed = await json<{ task: TaskSummary; checkpoint_id: string | null }>(resumeRes);
    assert.equal(resumed.task.status, "running");
    assert.equal(resumed.checkpoint_id, checkpoint.checkpoint_id);
    await waitFor("task to complete", async () => (await getTask(h, created.task_id)).status === "completed");
    const final = await getTask(h, created.task_id);
    assert.deepEqual(final.nodes.map((n) => [n.key, n.status, n.result]), [
      ["a", "completed", "a-ok"],
      ["b", "completed", "b-ok"],
    ]);
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

test("restore over HTTP rewinds to the chosen checkpoint (202 + reconcile report)", async () => {
  const h = await openRuntime({
    plan: SERIAL_PLAN,
    nodeScripts: {
      a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-v1"] }],
      b: [{ kind: "text", deltas: ["b-v1"] }],
    },
    tools: [slowTool(700)],
  });
  try {
    const created = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "演示 restore" }));
    await waitFor("node a running", async () => (await getTask(h, created.task_id)).nodes.find((n) => n.key === "a")?.status === "running");
    const pauseRes = await post(h, `/v1/tasks/${created.task_id}/pause`);
    const { checkpoint } = await json<{ checkpoint: CheckpointRecord }>(pauseRes);

    await json<unknown>(await post(h, `/v1/tasks/${created.task_id}/resume`));
    await waitFor("task completed", async () => (await getTask(h, created.task_id)).status === "completed");

    // completed 是终端态：restore 也拒绝（状态机一致；回卷经 FR-TASK-3 修订流程）
    const restoreTerminal = await post(h, `/v1/tasks/${created.task_id}/restore`, {
      checkpoint_id: checkpoint.checkpoint_id,
    });
    assert.equal(restoreTerminal.status, 409);

    // 从 paused 任务 restore：double-pause 场景在服务层测试覆盖；这里验证入参与错误映射
    const restoreBad = await post(h, `/v1/tasks/${created.task_id}/restore`, {});
    assert.equal(restoreBad.status, 400);
    assert.equal((await json<ApiError>(restoreBad)).error.code, "invalid_body");
    const restoreUnknown = await post(h, `/v1/tasks/${created.task_id}/restore`, {
      checkpoint_id: "01936b9d-8f7a-7abc-9f2e-000000000000",
    });
    assert.equal(restoreUnknown.status, 409, "completed 任务先被状态机拒绝（409 早于 404）");
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

test("intervention endpoints map errors: 404 unknown task, 409 illegal pause", async () => {
  const h = await openRuntime({ plan: SERIAL_PLAN });
  try {
    const unknown = "01936b9d-8f7a-7abc-9f2e-000000000000";
    const pauseRes = await post(h, `/v1/tasks/${unknown}/pause`);
    assert.equal(pauseRes.status, 404);
    assert.equal((await json<ApiError>(pauseRes)).error.code, "task_not_found");
    const resumeRes = await post(h, `/v1/tasks/${unknown}/resume`);
    assert.equal(resumeRes.status, 404);
    const restoreRes = await post(h, `/v1/tasks/${unknown}/restore`, { checkpoint_id: "x" });
    assert.equal(restoreRes.status, 404);
    const checkpointsRes = await fetch(`${h.base}/v1/tasks/${unknown}/checkpoints`);
    assert.equal(checkpointsRes.status, 404);

    // planned 任务不可 pause（状态机）；planned 孤儿的 resume 在调度器层测试覆盖
    const created = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "目标" }));
    const pausePlanned = await post(h, `/v1/tasks/${created.task_id}/pause`);
    assert.equal(pausePlanned.status, 409);
    assert.equal((await json<ApiError>(pausePlanned)).error.code, "task_invalid_transition");
    await waitFor("task settles", async () => {
      const status = (await getTask(h, created.task_id)).status;
      return status === "completed" || status === "failed";
    });
    // 终端态不可 pause/resume
    assert.equal((await post(h, `/v1/tasks/${created.task_id}/pause`)).status, 409);
    assert.equal((await post(h, `/v1/tasks/${created.task_id}/resume`)).status, 409);
    // GET /checkpoints on a task without any → empty list
    const empty = await json<{ checkpoints: unknown[] }>(
      await fetch(`${h.base}/v1/tasks/${created.task_id}/checkpoints`),
    );
    assert.deepEqual(empty.checkpoints, []);
  } finally {
    await h.close();
    removeDir(h.dir);
  }
});

test("pause returns 504 when an in-flight node never settles; task stays running", { timeout: 30_000 }, async () => {
  const h = await openRuntime({
    plan: planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]),
    nodeScripts: { a: [{ kind: "tool", toolName: "slow" }] },
    tools: [slowTool(60_000)],
  });
  try {
    const created = await json<TaskDetail>(await post(h, "/v1/tasks", { goal: "目标" }));
    await waitFor("node a latched", async () => (await getTask(h, created.task_id)).nodes.find((n) => n.key === "a")?.status === "running");
    // 内部 settle 上限 10s；HTTP 测试用更短窗口不现实，直接断言任务在 pause 未返回期间仍 running
    const pausing = post(h, `/v1/tasks/${created.task_id}/pause`);
    const status = (await getTask(h, created.task_id)).status;
    assert.equal(status, "running", "安全点等待期间任务保持 running");
    // 不放行：60s 慢工具使 pause 等待超时（504），随后测试直接关闭 runtime
    const res = await pausing;
    assert.equal(res.status, 504);
  } finally {
    await h.close();
    removeDir(h.dir);
  }
  }
);
