// 故障注入测试套件（票 M1-T5 / Issue #17，AC-07 前置：20 个注入点 ≥19 恢复成功）。
//
// 两层注入：
// - 进程级：以真实进程 spawn test/fixtures/task-child-runtime.ts（FakePi 注入、零网络），
//   在执行/暂停/恢复的任意时刻 kill -9，重启同 dataDir 验证恢复与一致性；
// - 进程内：直接操纵投影行 / 账本代理 / 并发调用，注入半写与损坏状态。
//
// 注入点清单（R = 恢复成功断言；G = 诚实拒绝/守卫断言）：
//   [P1]  R kill -9 于节点执行中（reversible）→ 重启 resume 重放，恰好一次完成
//   [P2]  R kill -9 于节点执行中（delivery_unknown）→ resume 置 pending_review，不重发
//   [P3]  R kill -9 于节点执行中（compensatable）→ resume 重放 + 登记待补偿
//   [P4]  R kill -9 于节点执行中（irreversible）→ resume 置 pending_review，不重发
//   [P5]  R kill -9 于 pause 等边界窗口 → 重启无 checkpoint，stale-running resume 收敛
//   [P6]  R kill -9 于 pause 完成后 → checkpoint 持久，resume 从它恢复
//   [P7]  R kill -9 于 DAG 中段（前序已完成）→ 前序不重跑，后续重放，输出引用保留
//   [P8]  R kill -9 于 resume 驱动中 → 二次重启后完成，attempts 诚实累计
//   [P9]  R kill -9 于并行兄弟执行中 → 恢复后全员一致、无节点丢失
//   [P10] G kill -9 于规划中 → 孤儿 created 任务被诚实拒绝（状态一致，账本完好）
//   [P11] R kill -9 后以显式 restore 回到中断前 checkpoint → 分类回卷
//   [P12] R 连续两次 kill -9 → 最终完成；终态后账本完整性校验通过
//   [I13] R checkpoint 事件写入中断 → 行补偿删除、无孤儿；resume 收敛
//   [I14] R 半写 + attempts 膨胀（重试中途崩溃）→ 重放在现值上递增
//   [I15] R 反向半写（结果落行、事件未落）→ 保留完成态，不虚构事件
//   [I16] G restore 引用他任务 checkpoint → 404 语义，无副作用
//   [I17] R 暂停任务全部节点已完成（边界竞态角落）→ resume 立即收敛 completed
//   [I18] G 并发双 resume → 恰一个受理
//   [I19] G 并发双 pause → 恰一个受理
//   [I20] R waiting_input 重复 resume 幂等（pending_review 保持，不再派发）
//   [I21] R restore 到最新 checkpoint（无变化回卷）→ task.restored 留痕且不重放
//   [I22] G 未知任务建 checkpoint → task_not_found
//   [I23] R checkpoint 行丢失（行级故障）→ resume 按活状态收敛
//   [I24] R 节点 failed 而任务 running（收尾前崩溃）→ resume 干净收敛 task.failed
//   [I25] R pending_review 经人工核对放行（Owner 决策 seam）→ resume 完成
//
// 可重复执行：全部注入经临时目录 + 显式脚本，无跨测试共享状态。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope, TaskDetail } from "@morrow/protocol";
import { openSqlite } from "../src/db.ts";
import { EventLedger } from "../src/ledger.ts";
import { CheckpointError, CheckpointService, type CheckpointRecord } from "../src/checkpoint.ts";
import { TaskScheduler, type NodeAgentFactory } from "../src/scheduler.ts";
import { TaskError, TaskService } from "../src/tasks.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const FIXTURE = fileURLToPath(new URL("./fixtures/task-child-runtime.ts", import.meta.url));
const NODE_FLAGS = ["--experimental-sqlite", "--experimental-strip-types"];

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

// --- 进程级注入（kill -9 真实进程）------------------------------------------------

interface Child {
  child: ChildProcess;
  base: string;
  port: number;
}

interface ChildEnv {
  plan: string;
  plannerScript?: FakeStep[];
  nodeScripts?: Record<string, FakeStep[]>;
  slowMs?: number;
}

async function startChild(t: { after(fn: () => unknown): void }, dir: string, env: ChildEnv): Promise<Child> {
  const child = spawn(process.execPath, [...NODE_FLAGS, FIXTURE], {
    env: {
      ...process.env,
      MORROW_DATA_DIR: dir,
      MORROW_PORT: "0",
      MORROW_REPLICA_ID: REPLICA,
      MORROW_TEST_PLAN: env.plan,
      ...(env.plannerScript === undefined ? {} : { MORROW_TEST_PLANNER_SCRIPT: JSON.stringify(env.plannerScript) }),
      ...(env.nodeScripts === undefined ? {} : { MORROW_TEST_NODE_SCRIPTS: JSON.stringify(env.nodeScripts) }),
      ...(env.slowMs === undefined ? {} : { MORROW_TEST_SLOW_MS: String(env.slowMs) }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  const ready = new Promise<{ port: number }>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { ready?: boolean; port?: number };
          if (parsed.ready === true && typeof parsed.port === "number") resolve({ port: parsed.port });
        } catch {
          // 非 JSON 行忽略
        }
      }
    });
    child.once("exit", (code) => reject(new Error(`child exited before ready (code ${code})`)));
    child.once("error", reject);
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const { port } = await ready;
  return { child, base: `http://127.0.0.1:${port}`, port };
}

async function kill9(c: Child): Promise<void> {
  await new Promise<void>((resolve) => {
    c.child.once("exit", () => resolve());
    c.child.kill("SIGKILL");
  });
}

async function stopChild(c: Child): Promise<void> {
  await new Promise<void>((resolve) => {
    c.child.once("exit", () => resolve());
    c.child.kill("SIGTERM");
  });
}

type ApiTask = TaskDetail & { error?: string };

async function getJson<T>(base: string, path: string): Promise<T> {
  return (await (await fetch(`${base}${path}`)).json()) as T;
}

async function postTask(base: string, goal: string): Promise<TaskDetail> {
  const res = await fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  return (await res.json()) as TaskDetail;
}

async function postAction(base: string, path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForHttp(what: string, cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cond()) return;
    } catch {
      // 子进程重启窗口期连接拒绝属预期
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const nodeStatus = (base: string, taskId: string, key: string) => async () => {
  const detail = await getJson<ApiTask>(base, `/v1/tasks/${taskId}`);
  return detail.nodes.find((n) => n.key === key)?.status;
};
const taskStatus = (base: string, taskId: string) => async () => (await getJson<ApiTask>(base, `/v1/tasks/${taskId}`)).status;

async function taskEvents(base: string, taskId: string): Promise<EventEnvelope[]> {
  const page = await getJson<{ events: EventEnvelope[] }>(base, `/v1/tasks/${taskId}/events?limit=200`);
  return page.events;
}

async function checkpointList(base: string, taskId: string): Promise<CheckpointRecord[]> {
  return (await getJson<{ checkpoints: CheckpointRecord[] }>(base, `/v1/tasks/${taskId}/checkpoints`)).checkpoints;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 进程级注入点的公共骨架：建任务 → 等条件 → kill -9 → 重启（脚本可换） */
async function killAt(
  t: { after(fn: () => unknown): void },
  dir: string,
  env1: ChildEnv,
  create: (base: string) => Promise<{ task_id: string }>,
  killWhen: (base: string, taskId: string) => Promise<void>,
): Promise<string> {
  const first = await startChild(t, dir, env1);
  const created = await create(first.base);
  await killWhen(first.base, created.task_id);
  await kill9(first);
  return created.task_id;
}

test("[P1] kill -9 mid-node (reversible): resume replays exactly once and completes", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p1-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]);
  const taskId = await killAt(
    t,
    dir,
    { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-v1"] }] } },
    (base) => postTask(base, "P1"),
    async (base, id) => waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running"),
  );
  const second = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "text", deltas: ["a-replayed"] }] } });
  // kill 后任务冻结在 running（stale）；checkpoint 不存在（无 pause）
  assert.equal(await taskStatus(second.base, taskId)(), "running");
  assert.deepEqual(await checkpointList(second.base, taskId), []);
  const resumeRes = await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  assert.equal(resumeRes.status, 202);
  await waitForHttp("task completes", async () => (await taskStatus(second.base, taskId)()) === "completed");
  const detail = await getJson<ApiTask>(second.base, `/v1/tasks/${taskId}`);
  assert.equal(detail.nodes[0].result, "a-replayed");
  assert.equal(detail.nodes[0].attempts, 2, "半写 attempt + 重放 attempt");
  const events = await taskEvents(second.base, taskId);
  const finished = events.filter((e) => e.event_type === "task.node_finished" && e.payload.status === "completed");
  assert.equal(finished.length, 1, "恰好一次完成（不双跑）");
  assert.deepEqual(finished[0].payload.attempt, 2);
});

test("[P2] kill -9 mid-node (delivery_unknown): resume flags pending_review, never resends", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p2-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a", side_effect: "delivery_unknown" }]);
  const taskId = await killAt(
    t,
    dir,
    { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-v1"] }] } },
    (base) => postTask(base, "P2"),
    async (base, id) => waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running"),
  );
  const second = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "text", deltas: ["MUST NOT RUN"] }] } });
  const resumeRes = await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  assert.equal(resumeRes.status, 202);
  await waitForHttp("task parks at waiting_input", async () => (await taskStatus(second.base, taskId)()) === "waiting_input");
  const detail = await getJson<ApiTask>(second.base, `/v1/tasks/${taskId}`);
  assert.equal(detail.nodes[0].status, "pending_review");
  const events = await taskEvents(second.base, taskId);
  assert.equal(events.filter((e) => e.event_type === "task.node_started").length, 1, "半写之外零派发（不重发未知副作用）");
  assert.equal(events.filter((e) => e.event_type === "task.completed").length, 0, "人工核对未完成前任务不得 completed");
});

test("[P3] kill -9 mid-node (compensatable): resume replays and records pending compensation", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p3-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a", side_effect: "compensatable" }]);
  const taskId = await killAt(
    t,
    dir,
    { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-v1"] }] } },
    (base) => postTask(base, "P3"),
    async (base, id) => waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running"),
  );
  const second = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "text", deltas: ["a-replayed"] }] } });
  await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  await waitForHttp("task completes", async () => (await taskStatus(second.base, taskId)()) === "completed");
  const events = await taskEvents(second.base, taskId);
  const restored = events.find((e) => e.event_type === "task.restored");
  assert.ok(restored, "task.restored 落账本");
  const compensations = restored?.payload.pending_compensations as Array<{ key: string }>;
  assert.deepEqual(compensations.map((c) => c.key), ["a"], "回卷重放前登记待补偿动作（M1 只记录）");
});

test("[P4] kill -9 mid-node (irreversible): resume flags pending_review, never resends", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p4-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a", side_effect: "irreversible" }]);
  const taskId = await killAt(
    t,
    dir,
    { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-v1"] }] } },
    (base) => postTask(base, "P4"),
    async (base, id) => waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running"),
  );
  const second = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "text", deltas: ["MUST NOT RUN"] }] } });
  await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  await waitForHttp("waiting_input", async () => (await taskStatus(second.base, taskId)()) === "waiting_input");
  const detail = await getJson<ApiTask>(second.base, `/v1/tasks/${taskId}`);
  assert.equal(detail.nodes[0].status, "pending_review");
  const events = await taskEvents(second.base, taskId);
  assert.equal(events.filter((e) => e.event_type === "task.node_started").length, 1);
});

test("[P5] kill -9 during the pause boundary wait: no checkpoint, stale-running resume converges", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p5-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]);
  const taskId = await killAt(
    t,
    dir,
    { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-v1"] }] } },
    (base) => postTask(base, "P5"),
    async (base, id) => {
      await waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running");
      const pausing = postAction(base, `/v1/tasks/${id}/pause`); // 在途：等边界（不会到达）
      await sleep(150); // 让 pause 被受理
      void pausing.catch(() => undefined);
    },
  );
  const second = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "text", deltas: ["a-replayed"] }] } });
  assert.deepEqual(await checkpointList(second.base, taskId), [], "边界未到达：checkpoint 未写");
  assert.equal(await taskStatus(second.base, taskId)(), "running", "task.paused 迁移同样未发生");
  await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  await waitForHttp("task completes", async () => (await taskStatus(second.base, taskId)()) === "completed");
  assert.equal((await getJson<ApiTask>(second.base, `/v1/tasks/${taskId}`)).nodes[0].result, "a-replayed");
});

test("[P6] kill -9 after pause completed: checkpoint is durable and resume restores from it", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p6-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]);
  let checkpointId = "";
  const taskId = await killAt(
    t,
    dir,
    { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-v1"] }] }, slowMs: 700 },
    (base) => postTask(base, "P6"),
    async (base, id) => {
      await waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running");
      const pauseRes = await postAction(base, `/v1/tasks/${id}/pause`);
      assert.equal(pauseRes.status, 200);
      const body = (await pauseRes.json()) as { checkpoint: CheckpointRecord };
      checkpointId = body.checkpoint.checkpoint_id;
    },
  );
  const second = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "text", deltas: ["a-replayed"] }] } });
  const list = await checkpointList(second.base, taskId);
  assert.equal(list.length, 1, "checkpoint 跨 kill -9 持久");
  assert.equal(list[0].checkpoint_id, checkpointId);
  const resumeRes = await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  assert.equal(resumeRes.status, 202);
  await waitForHttp("task completes", async () => (await taskStatus(second.base, taskId)()) === "completed");
  const detail = await getJson<ApiTask>(second.base, `/v1/tasks/${taskId}`);
  // 安全点已把 a 的成果入账（C1 记 completed）→ resume 不重做已完成的节点
  assert.equal(detail.nodes[0].result, "a-v1");
  assert.equal(detail.nodes[0].attempts, 1);
  const events = await taskEvents(second.base, taskId);
  assert.equal(events.filter((e) => e.event_type === "task.node_finished" && e.payload.status === "completed").length, 1, "不重跑已完成节点");
  const restored = events.find((e) => e.event_type === "task.restored");
  assert.equal(restored?.payload.checkpoint_id, checkpointId, "resume 挂在最新 checkpoint 上");
});

test("[P7] kill -9 mid-DAG with a completed predecessor: predecessor not re-run, output refs survive", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p7-");
  t.after(() => removeDir(dir));
  const plan = planJson([
    { key: "a", title: "A", goal: "do a", depends_on: [], side_effect: "reversible" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
  ]);
  const taskId = await killAt(
    t,
    dir,
    {
      plan,
      nodeScripts: {
        a: [{ kind: "text", deltas: ["a-v1"] }],
        b: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["b-v1"] }],
      },
    },
    (base) => postTask(base, "P7"),
    async (base, id) => {
      await waitForHttp("a completed", async () => (await nodeStatus(base, id, "a")()) === "completed");
      await waitForHttp("b running", async () => (await nodeStatus(base, id, "b")()) === "running");
    },
  );
  const second = await startChild(t, dir, {
    plan,
    nodeScripts: { a: [{ kind: "text", deltas: ["A MUST NOT RUN"] }], b: [{ kind: "text", deltas: ["b-v2"] }] },
  });
  await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  await waitForHttp("task completes", async () => (await taskStatus(second.base, taskId)()) === "completed");
  const detail = await getJson<ApiTask>(second.base, `/v1/tasks/${taskId}`);
  assert.deepEqual(detail.nodes.map((n) => [n.key, n.status, n.result, n.attempts]), [
    ["a", "completed", "a-v1", 1],
    ["b", "completed", "b-v2", 2],
  ]);
  const events = await taskEvents(second.base, taskId);
  const aFinished = events.filter((e) => e.event_type === "task.node_finished" && e.payload.key === "a" && e.payload.status === "completed");
  assert.equal(aFinished.length, 1, "已完成前序不重跑");
  // 恢复后再暂停一次：新 checkpoint 的输出引用指向 kill 前的账本事件（账本即事实源）
  // （completed 终态不可 pause；此处经事件断言：a 的 node_finished 事件 id 在重启后不变）
  assert.ok(events.some((e) => e.event_type === "task.node_finished" && e.payload.result === "a-v1"));
});

test("[P8] kill -9 during a resume drive: second restart completes with honest attempt history", { timeout: 60000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p8-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]);
  const taskId = await killAt(
    t,
    dir,
    { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["never"] }] } },
    (base) => postTask(base, "P8"),
    async (base, id) => waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running"),
  );
  const second = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["never"] }] } });
  const resumeRes = await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  assert.equal(resumeRes.status, 202);
  await waitForHttp("a running again", async () => (await nodeStatus(second.base, taskId, "a")()) === "running");
  await kill9(second);
  const third = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "text", deltas: ["finally"] }] } });
  await postAction(third.base, `/v1/tasks/${taskId}/resume`);
  await waitForHttp("task completes", async () => (await taskStatus(third.base, taskId)()) === "completed");
  const detail = await getJson<ApiTask>(third.base, `/v1/tasks/${taskId}`);
  assert.equal(detail.nodes[0].attempts, 3, "两次中断 + 一次成功，attempt 诚实累计");
  assert.equal(detail.nodes[0].result, "finally");
  const events = await taskEvents(third.base, taskId);
  assert.equal(events.filter((e) => e.event_type === "task.node_started").length, 3);
  assert.equal(events.filter((e) => e.event_type === "task.node_finished" && e.payload.status === "completed").length, 1);
});

test("[P9] kill -9 with parallel siblings: recovery loses no node and stays consistent", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p9-");
  t.after(() => removeDir(dir));
  const plan = planJson([
    { key: "n1", title: "N1", goal: "n1", side_effect: "reversible" },
    { key: "n2", title: "N2", goal: "n2", side_effect: "reversible" },
    { key: "n3", title: "N3", goal: "n3", side_effect: "reversible" },
  ]);
  const taskId = await killAt(
    t,
    dir,
    {
      plan,
      nodeScripts: {
        n1: [{ kind: "text", deltas: ["n1-ok"] }],
        n2: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["never"] }],
        n3: [{ kind: "text", deltas: ["n3-ok"] }],
      },
    },
    (base) => postTask(base, "P9"),
    async (base, id) => {
      // 默认并发 2：n1/n2 先派发；等 n1 完成后 kill（n2 半写、n3 未派发）
      await waitForHttp("n1 completed", async () => (await nodeStatus(base, id, "n1")()) === "completed");
      await waitForHttp("n2 running", async () => (await nodeStatus(base, id, "n2")()) === "running");
    },
  );
  const second = await startChild(t, dir, {
    plan,
    nodeScripts: {
      n1: [{ kind: "text", deltas: ["N1 MUST NOT RUN"] }],
      n2: [{ kind: "text", deltas: ["n2-replayed"] }],
      n3: [{ kind: "text", deltas: ["n3-ok"] }],
    },
  });
  await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  await waitForHttp("task completes", async () => (await taskStatus(second.base, taskId)()) === "completed");
  const detail = await getJson<ApiTask>(second.base, `/v1/tasks/${taskId}`);
  assert.deepEqual(detail.nodes.map((n) => [n.key, n.status, n.result]), [
    ["n1", "completed", "n1-ok"],
    ["n2", "completed", "n2-replayed"],
    ["n3", "completed", "n3-ok"],
  ]);
  const events = await taskEvents(second.base, taskId);
  for (const key of ["n1", "n2", "n3"]) {
    const count = events.filter((e) => e.event_type === "task.node_finished" && e.payload.key === key && e.payload.status === "completed").length;
    assert.equal(count, 1, `${key} 恰好一次完成`);
  }
});

test("[P10] kill -9 mid-planning: orphan created task is honestly rejected, ledger intact (guard)", { timeout: 45000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p10-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a" }]);
  const first = await startChild(t, dir, {
    plan,
    plannerScript: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: [plan] }],
  });
  // 创建在途（规划挂着）：任务行已插（status=created）
  const creating = postTask(first.base, "P10").catch(() => null);
  await waitForHttp("created orphan appears", async () => {
    const list = await getJson<{ tasks: Array<{ task_id: string; status: string }> }>(first.base, "/v1/tasks");
    return list.tasks.some((x) => x.status === "created");
  });
  await kill9(first);
  void (await creating);
  const second = await startChild(t, dir, { plan });
  const list = await getJson<{ tasks: Array<{ task_id: string; status: string }> }>(second.base, "/v1/tasks");
  const orphan = list.tasks.find((x) => x.status === "created");
  assert.ok(orphan, "created 孤儿在重启后可见");
  const resumeRes = await postAction(second.base, `/v1/tasks/${orphan?.task_id}/resume`);
  assert.equal(resumeRes.status, 409, "created 无计划不可恢复（诚实拒绝）");
  const detail = await getJson<ApiTask>(second.base, `/v1/tasks/${orphan?.task_id}`);
  assert.equal(detail.status, "created", "拒绝后状态不变");
  const ledger = EventLedger.open(dir);
  try {
    const report = ledger.verifyIntegrity();
    assert.equal(report.ok, true, "账本完整性无损");
  } finally {
    ledger.close();
  }
});

test("[P11] kill -9 then explicit restore to the pre-interruption checkpoint (class-gated rewind)", { timeout: 60000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p11-");
  t.after(() => removeDir(dir));
  const plan = planJson([
    { key: "a", title: "A", goal: "do a", depends_on: [], side_effect: "reversible" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
  ]);
  let checkpointId = "";
  const taskId = await killAt(
    t,
    dir,
    {
      plan,
      nodeScripts: {
        a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-v1"] }],
        b: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["never"] }],
      },
      slowMs: 700,
    },
    (base) => postTask(base, "P11"),
    async (base, id) => {
      await waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running");
      const pauseRes = await postAction(base, `/v1/tasks/${id}/pause`);
      assert.equal(pauseRes.status, 200);
      checkpointId = ((await pauseRes.json()) as { checkpoint: CheckpointRecord }).checkpoint.checkpoint_id;
      // b 在 C1 时未派发（安全点语义）
      const snap = (await checkpointList(base, id)).find((c) => c.checkpoint_id === checkpointId);
      assert.equal(snap?.snapshot.graph.nodes.find((n) => n.key === "b")?.status, "pending");
      // resume 后 b 挂在慢工具上 → kill
      await postAction(base, `/v1/tasks/${id}/resume`);
      await waitForHttp("b running", async () => (await nodeStatus(base, id, "b")()) === "running");
    },
  );
  const second = await startChild(t, dir, {
    plan,
    nodeScripts: { a: [{ kind: "text", deltas: ["A MUST NOT RUN"] }, { kind: "text", deltas: ["x"] }], b: [{ kind: "text", deltas: ["b-restored"] }] },
  });
  const restoreRes = await postAction(second.base, `/v1/tasks/${taskId}/restore`, { checkpoint_id: checkpointId });
  assert.equal(restoreRes.status, 202);
  const body = (await restoreRes.json()) as { reconcile: { replay_keys: string[] } };
  assert.deepEqual(body.reconcile.replay_keys, ["b"], "C1 后才完成的可逆节点回卷重放");
  await waitForHttp("task completes", async () => (await taskStatus(second.base, taskId)()) === "completed");
  const detail = await getJson<ApiTask>(second.base, `/v1/tasks/${taskId}`);
  assert.deepEqual(detail.nodes.map((n) => [n.key, n.result, n.attempts]), [
    ["a", "a-v1", 1],
    ["b", "b-restored", 2],
  ]);
});

test("[P12] two consecutive kill -9: final resume completes; ledger integrity verified (coda)", { timeout: 60000 }, async (t) => {
  const dir = tmpDir("morrow-fault-p12-");
  t.after(() => removeDir(dir));
  const plan = planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]);
  const taskId = await killAt(
    t,
    dir,
    { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["never"] }] } },
    (base) => postTask(base, "P12"),
    async (base, id) => waitForHttp("a running", async () => (await nodeStatus(base, id, "a")()) === "running"),
  );
  const second = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["never"] }] } });
  await postAction(second.base, `/v1/tasks/${taskId}/resume`);
  await waitForHttp("a running again", async () => (await nodeStatus(second.base, taskId, "a")()) === "running");
  await kill9(second);
  const third = await startChild(t, dir, { plan, nodeScripts: { a: [{ kind: "text", deltas: ["survived"] }] } });
  await postAction(third.base, `/v1/tasks/${taskId}/resume`);
  await waitForHttp("task completes", async () => (await taskStatus(third.base, taskId)()) === "completed");
  const detail = await getJson<ApiTask>(third.base, `/v1/tasks/${taskId}`);
  assert.equal(detail.nodes[0].result, "survived");
  assert.equal(detail.nodes[0].attempts, 3);
  await stopChild(third);
  const ledger = EventLedger.open(dir);
  try {
    const report = ledger.verifyIntegrity();
    assert.equal(report.ok, true, `账本完整性无损（checked ${report.checked}）`);
    const types = ledger.scan({ taskId }).map((e) => e.envelope.event_type);
    assert.equal(types.filter((x) => x === "task.completed").length, 1, "恰好一次完成迁移");
  } finally {
    ledger.close();
  }
});

// --- 进程内注入（半写/损坏状态直接构造；kill -9 的确定性等价物）---------------------

function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

interface Harness {
  svc: TaskService;
  checkpoints: CheckpointService;
  dir: string;
  close(): void;
}

function openHarness(plan: string): Harness {
  const dir = tmpDir("morrow-fault-inproc-");
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

function makeScheduler(h: Harness, factory: NodeAgentFactory | null): TaskScheduler {
  return new TaskScheduler({
    tasks: h.svc,
    ledger: h.svc.ledger,
    replicaId: REPLICA,
    nodeAgentFactory: factory,
    checkpoints: h.checkpoints,
  });
}

function nodeFactory(scripts: Record<string, FakeStep[]>): NodeAgentFactory {
  return async (node) => createFakePi({ script: scripts[node.key] ?? [] });
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

function latchTool(name: string): { tool: MorrowTool; release(): void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    tool: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await gate;
        return { text: "latched" };
      },
    },
    release: () => release(),
  };
}

test("[I13] checkpoint event write interrupted during pause: row compensated, resume converges", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]));
  try {
    const detail = await h.svc.createTask("I13");
    // 注入：checkpoint_created 事件写入失败一次（行已落）；同一调度器驱动+暂停
    const ledger = h.svc.ledger;
    const realAppend = ledger.append.bind(ledger);
    let failNext = false;
    const proxy = {
      append: (envelope: Parameters<EventLedger["append"]>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected: checkpoint event write interrupted");
        }
        return realAppend(envelope);
      },
      scan: (selector?: Parameters<EventLedger["scan"]>[0]) => ledger.scan(selector),
      list: (options?: Parameters<EventLedger["list"]>[0]) => ledger.list(options),
      count: () => ledger.count(),
    } as unknown as EventLedger;
    const flaky = new CheckpointService({ tasks: h.svc, dataDir: h.dir, ledger: proxy, replicaId: REPLICA });
    const latch = latchTool("latchA");
    const scheduler = new TaskScheduler({
      tasks: h.svc,
      ledger: h.svc.ledger,
      replicaId: REPLICA,
      nodeAgentFactory: async (node) => createFakePi({
        script: [{ kind: "tool", toolName: "latchA" }],
        tools: [latch.tool],
      }),
      checkpoints: flaky,
    });
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("a latched", () => h.svc.getTask(detail.task_id)?.nodes[0].status === "running");
    failNext = true;
    const pausing = scheduler.pause(detail.task_id); // 受理并等待边界
    latch.release();
    await assert.rejects(() => pausing, /injected: checkpoint event write interrupted/);
    flaky.close();
    // 补偿：无孤儿行；任务已 paused（迁移先于 checkpoint 落库）
    assert.deepEqual(h.checkpoints.listCheckpoints(detail.task_id), []);
    assert.equal(h.svc.getTask(detail.task_id)?.status, "paused");
    // 恢复路径完好：resume（无 checkpoint）按活状态收敛——a 已在边界收尾（completed）
    const revived = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["MUST NOT RUN"] }] }));
    const { drive } = await revived.resume(detail.task_id);
    await drive;
    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    assert.equal(final?.nodes[0].status, "completed", "边界已收尾的节点不重做");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    assert.equal(events.filter((e) => e.event_type === "task.node_started").length, 1, "零重放");
  } finally {
    h.close();
  }
});

test("[I14] half-write with inflated attempts (crash mid-retry): resume replays monotonically", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]));
  try {
    const detail = await h.svc.createTask("I14");
    const latch = latchTool("latchA");
    const zombie = new TaskScheduler({
      tasks: h.svc,
      ledger: h.svc.ledger,
      replicaId: REPLICA,
      nodeAgentFactory: async () => createFakePi({
        script: [{ kind: "tool", toolName: "latchA" }],
        tools: [latch.tool],
      }),
      checkpoints: h.checkpoints,
    });
    void zombie.schedule(detail.task_id).catch(() => undefined);
    await waitFor("a running", () => h.svc.getTask(detail.task_id)?.nodes[0].status === "running");
    // 注入：重试中途崩溃的投影（attempts 膨胀、无任何完成事件）
    h.svc.setNodeRunning(detail.nodes[0].node_id, 5);
    const revived = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["replayed"] }] }));
    const { drive } = await revived.resume(detail.task_id);
    await drive;
    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    assert.equal(final?.nodes[0].attempts, 6, "在膨胀值上单调递增");
    assert.equal(final?.nodes[0].result, "replayed");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const finished = events.filter((e) => e.event_type === "task.node_finished" && e.payload.status === "completed");
    assert.deepEqual(finished[0].payload.attempt, 6);
  } finally {
    h.close();
  }
});

test("[I15] inverse half-write (result landed in row, event lost): keep completed, fabricate nothing", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]));
  try {
    const detail = await h.svc.createTask("I15");
    // 注入：节点行 completed 但账本无任何节点事件
    h.svc.setNodeRunning(detail.nodes[0].node_id, 1);
    h.svc.setNodeFinished(detail.nodes[0].node_id, "completed", { result: "ghost-result" });
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["MUST NOT RUN"] }] }));
    const { report, drive } = await scheduler.resume(detail.task_id);
    assert.deepEqual(report.replay_keys, [], "行是投影真相：不回卷、不重放");
    await drive;
    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    assert.equal(final?.nodes[0].result, "ghost-result");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    assert.equal(events.filter((e) => e.event_type === "task.node_started").length, 0, "不虚构执行事件");
  } finally {
    h.close();
  }
});

test("[I16] restore with a foreign task's checkpoint is rejected without side effects (guard)", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a" }]));
  try {
    const one = await h.svc.createTask("I16-a");
    const two = await h.svc.createTask("I16-b");
    const cp = await h.checkpoints.createCheckpoint(one.task_id, "pause");
    const scheduler = makeScheduler(h, nodeFactory({}));
    await assert.rejects(
      () => scheduler.restore(two.task_id, cp.checkpoint_id),
      (err: unknown) => err instanceof CheckpointError && err.code === "checkpoint_not_found",
    );
    assert.equal(h.svc.taskEvents(two.task_id)?.events.length, 2, "被拒 restore 不落事件");
  } finally {
    h.close();
  }
});

test("[I17] paused task whose nodes all completed (boundary race corner): resume converges at once", async () => {
  const h = openHarness(planJson([
    { key: "a", title: "A", goal: "do a", depends_on: [], side_effect: "reversible" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
  ]));
  try {
    const detail = await h.svc.createTask("I17");
    const latch = latchTool("latchB");
    const scheduler = makeScheduler(h, (node) => createFakePi({
      script: node.key === "a" ? [{ kind: "text", deltas: ["a-ok"] }] : [{ kind: "tool", toolName: "latchB" }],
      tools: [latch.tool],
    }));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("b latched", () => h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "b")?.status === "running");
    const pausing = scheduler.pause(detail.task_id);
    latch.release();
    const { checkpoint } = await pausing;
    assert.deepEqual(checkpoint.snapshot.graph.nodes.map((n) => [n.key, n.status]), [["a", "completed"], ["b", "completed"]]);
    const { drive } = await scheduler.resume(detail.task_id);
    await drive;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "completed", "全完成 → resume 立即收敛");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    assert.equal(events.filter((e) => e.event_type === "task.node_finished").length, 2, "无重复执行");
  } finally {
    h.close();
  }
});

test("[I18] concurrent double resume: exactly one is accepted (guard)", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a" }]));
  try {
    const detail = await h.svc.createTask("I18");
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["ok"] }] }));
    const [r1, r2] = await Promise.allSettled([scheduler.resume(detail.task_id), scheduler.resume(detail.task_id)]);
    const accepted = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].status === "rejected" && rejected[0].reason instanceof TaskError);
    await (accepted[0] as PromiseFulfilledResult<{ drive: Promise<void> }>).value.drive;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "completed");
  } finally {
    h.close();
  }
});

test("[I19] concurrent double pause: exactly one is accepted (guard)", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", side_effect: "reversible" }]));
  try {
    const detail = await h.svc.createTask("I19");
    const latch = latchTool("latchA");
    const scheduler = makeScheduler(h, (node) => createFakePi({
      script: [{ kind: "tool", toolName: "latchA" }],
      tools: [latch.tool],
    }));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("a latched", () => h.svc.getTask(detail.task_id)?.nodes[0].status === "running");
    const pausing1 = scheduler.pause(detail.task_id);
    const pausing2 = scheduler.pause(detail.task_id);
    latch.release(); // 两个 pause 都已受理并在等边界
    const [p1, p2] = await Promise.allSettled([pausing1, pausing2]);
    const rejected = [p1, p2].filter((r) => r.status === "rejected");
    const accepted = [p1, p2].filter((r) => r.status === "fulfilled");
    assert.equal(accepted.length, 1, "双 pause 恰一个受理");
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].status === "rejected" && rejected[0].reason instanceof TaskError);
    assert.equal(h.checkpoints.listCheckpoints(detail.task_id).length, 1, "只产生一个 checkpoint");
  } finally {
    h.close();
  }
});

test("[I20] repeated resume of a waiting_input task is idempotent (pending_review holds)", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", side_effect: "delivery_unknown" }]));
  try {
    const detail = await h.svc.createTask("I20");
    const latch = latchTool("latchA");
    const zombie = makeScheduler(h, (node) => createFakePi({
      script: [{ kind: "tool", toolName: "latchA" }],
      tools: [latch.tool],
    }));
    void zombie.schedule(detail.task_id).catch(() => undefined);
    await waitFor("a latched", () => h.svc.getTask(detail.task_id)?.nodes[0].status === "running");
    const revived = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["MUST NOT RUN"] }] }));
    const first = await revived.resume(detail.task_id);
    await first.drive;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "waiting_input");
    const again = await revived.resume(detail.task_id);
    await again.drive;
    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "waiting_input", "重复恢复幂等");
    assert.equal(final?.nodes[0].status, "pending_review");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    assert.equal(events.filter((e) => e.event_type === "task.node_started").length, 1, "依旧零重发");
  } finally {
    h.close();
  }
});

test("[I21] restore to the latest checkpoint with no drift: task.restored recorded, nothing replayed", async () => {
  const h = openHarness(planJson([
    { key: "a", title: "A", goal: "do a", depends_on: [], side_effect: "reversible" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
  ]));
  try {
    const detail = await h.svc.createTask("I21");
    const latchA = latchTool("latchA");
    const latchB = latchTool("latchB");
    const scheduler = makeScheduler(h, (node) => createFakePi({
      script: node.key === "a"
        ? [{ kind: "tool", toolName: "latchA" }, { kind: "text", deltas: ["a-v1"] }]
        : [{ kind: "tool", toolName: "latchB" }, { kind: "text", deltas: ["b-v1"] }],
      tools: [latchA.tool, latchB.tool],
    }));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("a latched", () => h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");
    const pausing1 = scheduler.pause(detail.task_id);
    latchA.release();
    const { checkpoint: c1 } = await pausing1;
    const resume1 = await scheduler.resume(detail.task_id);
    void resume1.drive.catch(() => undefined);
    await waitFor("b latched", () => h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "b")?.status === "running");
    const pausing2 = scheduler.pause(detail.task_id);
    latchB.release();
    const { checkpoint: c2 } = await pausing2;
    assert.equal(c2.checkpoint_id === c1.checkpoint_id, false);
    const before = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events.length ?? 0;
    const { report, drive } = await scheduler.restore(detail.task_id, c2.checkpoint_id);
    assert.deepEqual(report.replay_keys, [], "无漂移 → 不重放");
    await drive;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "completed");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    assert.ok(types(events).includes("task.restored"), "restore 留痕");
    const bFinished = events.filter((e) => e.event_type === "task.node_finished" && e.payload.key === "b" && e.payload.status === "completed");
    assert.equal(bFinished.length, 1, "不重放");
    assert.ok(events.length >= before, "事件只增不减");
  } finally {
    h.close();
  }
});

test("[I22] checkpoint for an unknown task is rejected (guard)", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A" }]));
  try {
    await assert.rejects(
      () => h.checkpoints.createCheckpoint("01936b9d-8f7a-7abc-9f2e-000000000000", "pause"),
      (err: unknown) => err instanceof CheckpointError && err.code === "task_not_found",
    );
  } finally {
    h.close();
  }
});

test("[I23] checkpoint rows lost (row-level fault): resume reconciles from live state", async () => {
  const h = openHarness(planJson([
    { key: "a", title: "A", goal: "do a", depends_on: [], side_effect: "reversible" },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"], side_effect: "reversible" },
  ]));
  try {
    const detail = await h.svc.createTask("I23");
    const latch = latchTool("latchA");
    const scheduler = makeScheduler(h, (node) => createFakePi({
      script: node.key === "a"
        ? [{ kind: "tool", toolName: "latchA" }, { kind: "text", deltas: ["a-v1"] }]
        : [{ kind: "text", deltas: ["b-v2"] }],
      tools: [latch.tool],
    }));
    void scheduler.schedule(detail.task_id).catch(() => undefined);
    await waitFor("a latched", () => h.svc.getTask(detail.task_id)?.nodes.find((n) => n.key === "a")?.status === "running");
    const pausing = scheduler.pause(detail.task_id);
    latch.release();
    await pausing;
    assert.equal(h.checkpoints.listCheckpoints(detail.task_id).length, 1);
    // 注入：checkpoint 行整体丢失
    const raw = openSqlite(`${h.dir}/events.sqlite`);
    raw.exec("DELETE FROM task_checkpoints");
    raw.close();
    assert.deepEqual(h.checkpoints.listCheckpoints(detail.task_id), []);
    const { checkpoint_id, drive } = await scheduler.resume(detail.task_id);
    assert.equal(checkpoint_id, null, "无 checkpoint 也可恢复");
    await drive;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "completed");
    const bFinished = (h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [])
      .filter((e) => e.event_type === "task.node_finished" && e.payload.key === "b" && e.payload.status === "completed");
    assert.equal(bFinished.length, 1);
  } finally {
    h.close();
  }
});

test("[I24] node failed while task still running (crash before terminal transition): resume converges to failed", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", retriable: false }]));
  try {
    const detail = await h.svc.createTask("I24");
    // 注入：节点已失败落行，任务仍 running（收尾迁移前的崩溃窗口）
    h.svc.transition(detail.task_id, "running");
    h.svc.setNodeRunning(detail.nodes[0].node_id, 1);
    h.svc.setNodeFinished(detail.nodes[0].node_id, "failed", { error: "injected failure" });
    const scheduler = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["never"] }] }));
    const { drive } = await scheduler.resume(detail.task_id);
    await drive;
    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "failed", "干净收敛到 failed");
    const events = h.svc.taskEvents(detail.task_id, { limit: 200 })?.events ?? [];
    const failed = events.find((e) => e.event_type === "task.failed");
    assert.equal(failed?.payload.reason, "node_failed");
    assert.equal(failed?.payload.key, "a");
  } finally {
    h.close();
  }
});

test("[I25] pending_review released by owner reconciliation (library seam): resume completes", async () => {
  const h = openHarness(planJson([{ key: "a", title: "A", goal: "do a", side_effect: "delivery_unknown" }]));
  try {
    const detail = await h.svc.createTask("I25");
    const latch = latchTool("latchA");
    const zombie = makeScheduler(h, (node) => createFakePi({
      script: [{ kind: "tool", toolName: "latchA" }],
      tools: [latch.tool],
    }));
    void zombie.schedule(detail.task_id).catch(() => undefined);
    await waitFor("a latched", () => h.svc.getTask(detail.task_id)?.nodes[0].status === "running");
    const revived = makeScheduler(h, nodeFactory({ a: [{ kind: "text", deltas: ["approved"] }] }));
    const first = await revived.resume(detail.task_id);
    await first.drive;
    assert.equal(h.svc.getTask(detail.task_id)?.status, "waiting_input");
    // Owner 核对放行（M1 库形态 seam；审核 UI 是 FR-TASK-3）
    h.svc.setNodeState(detail.nodes[0].node_id, { status: "pending" });
    const second = await revived.resume(detail.task_id);
    await second.drive;
    const final = h.svc.getTask(detail.task_id);
    assert.equal(final?.status, "completed");
    assert.equal(final?.nodes[0].result, "approved");
    assert.equal(final?.nodes[0].attempts, 2);
  } finally {
    h.close();
  }
});
