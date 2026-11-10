// 任务投影随同步重建 + AC-05 可见值 + preference 版本稳定（M3 修复批 / #32 #36）。
//
// 双实例真 HTTP 回环：两个独立 Runtime（独立 dataDir / replica_id / SQLite 账本 /
// 各自 HTTP 端口），互相注入 HttpSyncTransport（真实 fetch 到 /v1/sync/{pull,push}）。
// 覆盖：A 建任务执行到一半 → sync 到 B（可见、状态/节点正确、不自动执行）；启动补建；
// 冲突期间本地 v2 保持可见（AC-05 20 样本）；重复同步 preference 版本不膨胀。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { EventEnvelope, MemoryEntryKind, SensitivityLevel, TaskDetail, TaskSummary } from "@morrow/protocol";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { RuntimeConfig } from "../src/config.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import { DB_FILE_NAME } from "../src/ledger.ts";
import { startRuntime, type RuntimeHandle, type RuntimeOptions } from "../src/runtime.ts";
import { openSqlite } from "../src/db.ts";
import { HttpSyncTransport } from "../src/sync/http-transport.ts";
import { uuidv7 } from "../src/uuid-v7.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

interface Pair {
  a: RuntimeHandle;
  b: RuntimeHandle;
  dirA: string;
  dirB: string;
  baseA: string;
  baseB: string;
}

function config(dir: string, replicaId: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId, provider: null };
}

async function startPair(options: {
  a?: RuntimeOptions;
  b?: RuntimeOptions;
} = {}): Promise<Pair> {
  const dirA = tmpDir("morrow-sync-task-a-");
  const dirB = tmpDir("morrow-sync-task-b-");
  const bases = new Map<string, string>();
  const transportFor = (self: string): HttpSyncTransport =>
    new HttpSyncTransport({
      selfReplicaId: self,
      baseUrlForPeer: (peerId) => bases.get(peerId) ?? "http://127.0.0.1:1",
    });
  const a = await startRuntime(config(dirA, REPLICA_A), {
    ...options.a,
    syncTransport: transportFor(REPLICA_A),
  });
  const b = await startRuntime(config(dirB, REPLICA_B), {
    ...options.b,
    syncTransport: transportFor(REPLICA_B),
  });
  bases.set(REPLICA_A, `http://127.0.0.1:${a.port}`);
  bases.set(REPLICA_B, `http://127.0.0.1:${b.port}`);
  return {
    a,
    b,
    dirA,
    dirB,
    baseA: `http://127.0.0.1:${a.port}`,
    baseB: `http://127.0.0.1:${b.port}`,
  };
}

async function closePair(pair: Pair): Promise<void> {
  await pair.a.close().catch(() => undefined);
  await pair.b.close().catch(() => undefined);
  removeDir(pair.dirA);
  removeDir(pair.dirB);
}

async function pullAll(target: RuntimeHandle, peerReplicaId: string): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    const batch = await target.sync.pullFromPeer(peerReplicaId);
    if (!batch.has_more) return;
  }
  throw new Error("pull did not terminate");
}

/** 双向多轮（冲突/合并审计事件也要传播到两端） */
async function syncAll(pair: Pair, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await pullAll(pair.a, REPLICA_B);
    await pullAll(pair.b, REPLICA_A);
  }
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function getTask(base: string, taskId: string): Promise<{ status: number; body: TaskDetail }> {
  const response = await fetch(`${base}/v1/tasks/${taskId}`);
  return { status: response.status, body: (await json<TaskDetail>(response)) as TaskDetail };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const PLAN = JSON.stringify({
  nodes: [
    { key: "a", title: "A", goal: "do a", depends_on: [] },
    { key: "b", title: "B", goal: "do b", depends_on: ["a"] },
    { key: "c", title: "C", goal: "do c", depends_on: ["b"] },
  ],
});

// --- 任务投影随同步重建（执行到一半同步；不自动接管） ----------------------------

test("对端任务随同步重建：GET /v1/tasks 可见、详情状态/节点正确、执行器不自动接管", async () => {
  const gate = deferred();
  const holdTool: MorrowTool = {
    name: "hold",
    description: "block until the test releases it",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      await gate.promise;
      return { text: "released" };
    },
  };
  const release = () => gate.resolve();
  const pair = await startPair({
    a: {
      taskPlannerFactory: async () => createFakePi({ script: [{ kind: "text", deltas: [PLAN] }] }),
      taskNodeAgentFactory: async (node) =>
        createFakePi({
          script:
            node.key === "b"
              ? ([{ kind: "tool", toolName: "hold" }, { kind: "text", deltas: ["b-ok"] }] as FakeStep[])
              : ([{ kind: "text", deltas: [`${node.key}-ok`] }] as FakeStep[]),
          tools: [holdTool],
        }),
    },
  });
  try {
    const response = await fetch(`${pair.baseA}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "三节点串行任务" }),
    });
    assert.equal(response.status, 201);
    const created = (await json<TaskDetail>(response)) as TaskDetail;

    // 执行到一半：a 已完成、b 在跑（被 hold 工具挡住）、c 仍 pending
    await waitFor("A task halfway", async () => {
      const detail = await getTask(pair.baseA, created.task_id);
      return (
        detail.body.status === "running" &&
        detail.body.nodes.find((node) => node.key === "a")?.status === "completed" &&
        detail.body.nodes.find((node) => node.key === "b")?.status === "running"
      );
    });

    // 同步到 B（真实 HTTP）：导入批次结束时重建任务投影
    await pullAll(pair.b, REPLICA_A);

    const listResponse = await fetch(`${pair.baseB}/v1/tasks`);
    assert.equal(listResponse.status, 200);
    const listed = (await json<{ tasks: TaskSummary[] }>(listResponse)) as { tasks: TaskSummary[] };
    assert.deepEqual(listed.tasks.map((task) => task.task_id), [created.task_id], "对端任务出现在列表");
    assert.equal(listed.tasks[0].status, "running", "同步来的状态与来源一致");

    const onB = await getTask(pair.baseB, created.task_id);
    assert.notEqual(onB.status, 404, "GET /v1/tasks/:id 不再是 404");
    assert.equal(onB.body.status, "running");
    assert.equal(onB.body.task_version, 1);
    const nodeA = onB.body.nodes.find((node) => node.key === "a");
    const nodeB = onB.body.nodes.find((node) => node.key === "b");
    const nodeC = onB.body.nodes.find((node) => node.key === "c");
    assert.equal(nodeA?.status, "completed", "已完成节点随投影重建");
    assert.equal(nodeA?.result, "a-ok");
    assert.equal(nodeB?.status, "running", "在跑节点状态随投影重建");
    assert.equal(nodeB?.attempts, 1);
    assert.equal(nodeC?.status, "pending");
    assert.deepEqual(nodeC?.depends_on, ["b"], "依赖边随投影重建");

    // 执行器不得自动接管：B 账本没有 B 创作的 task.* 事件，也没有本地租约
    const bTaskEvents = pair.b.ledger.scan().filter((entry) => entry.envelope.event_type.startsWith("task."));
    assert.ok(bTaskEvents.length > 0);
    assert.equal(
      bTaskEvents.every((entry) => entry.envelope.replica_id === REPLICA_A),
      true,
      "同步来的任务不被 B 自动执行（无 B actor 的任务事件）",
    );
    assert.equal(pair.b.leases.current(created.task_id), null, "B 未取得执行租约");

    // 投影重建幂等：重复重建得到同一详情
    const beforeRebuild = await getTask(pair.baseB, created.task_id);
    const first = pair.b.taskRebuilder.rebuild();
    const second = pair.b.taskRebuilder.rebuild();
    assert.deepEqual(second, first, "重复重建的结果计数一致");
    const afterRebuild = await getTask(pair.baseB, created.task_id);
    assert.deepEqual(afterRebuild.body, beforeRebuild.body, "重建幂等：详情不变");

    // 放行后 A 完成；再同步一次，B 的投影随新事件推进到 completed
    release();
    await waitFor("A task completed", async () => {
      const detail = await getTask(pair.baseA, created.task_id);
      return detail.body.status === "completed";
    });
    await pullAll(pair.b, REPLICA_A);
    const finishedOnB = await getTask(pair.baseB, created.task_id);
    assert.equal(finishedOnB.body.status, "completed");
    assert.deepEqual(
      finishedOnB.body.nodes.map((node) => node.status),
      ["completed", "completed", "completed"],
    );
    assert.deepEqual(finishedOnB.body.nodes.map((node) => node.result), ["a-ok", "b-ok", "c-ok"]);
  } finally {
    release();
    await closePair(pair);
  }
});

// --- 启动补建：任务表为空但账本有 task.* 事件 -------------------------------------

test("启动补建：任务表为空且账本有任务事件时重放一次（不重新执行）", async () => {
  const plan = JSON.stringify({ nodes: [{ key: "solo", title: "Solo", goal: "do solo", depends_on: [] }] });
  const pair = await startPair({
    a: {
      taskPlannerFactory: async () => createFakePi({ script: [{ kind: "text", deltas: [plan] }] }),
      taskNodeAgentFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["solo-ok"] }] }),
    },
  });
  let reopened: RuntimeHandle | undefined;
  try {
    const response = await fetch(`${pair.baseA}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "启动补建任务" }),
    });
    assert.equal(response.status, 201);
    const created = (await json<TaskDetail>(response)) as TaskDetail;
    await waitFor("A task completed", async () => (await getTask(pair.baseA, created.task_id)).body.status === "completed");

    await pullAll(pair.b, REPLICA_A);
    const snapshot = (await getTask(pair.baseB, created.task_id)).body;
    assert.equal(snapshot.status, "completed");

    // 关闭 B、清空任务投影表（模拟「只拿到账本的新副本」），再以同一 dataDir 启动
    await pair.b.close();
    const sqlite = openSqlite(join(pair.dirB, DB_FILE_NAME));
    sqlite.exec("DELETE FROM task_edges; DELETE FROM task_nodes; DELETE FROM tasks;");
    sqlite.close();

    reopened = await startRuntime(config(pair.dirB, REPLICA_B), {});
    const listResponse = await fetch(`http://127.0.0.1:${reopened.port}/v1/tasks`);
    const listed = (await json<{ tasks: TaskSummary[] }>(listResponse)) as { tasks: TaskSummary[] };
    assert.deepEqual(listed.tasks.map((task) => task.task_id), [created.task_id], "启动补建出任务列表");

    const detailResponse = await fetch(`http://127.0.0.1:${reopened.port}/v1/tasks/${created.task_id}`);
    assert.equal(detailResponse.status, 200);
    const restored = (await json<TaskDetail>(detailResponse)) as TaskDetail;
    assert.deepEqual(restored, snapshot, "启动补建结果与同步后的投影一致");

    // 补建不触发执行：B 仍没有任何任务事件/租约
    assert.equal(
      reopened.ledger
        .scan()
        .filter((entry) => entry.envelope.event_type.startsWith("task."))
        .every((entry) => entry.envelope.replica_id === REPLICA_A),
      true,
    );
    assert.equal(reopened.leases.current(created.task_id), null);
  } finally {
    await reopened?.close().catch(() => undefined);
    await pair.a.close().catch(() => undefined);
    removeDir(pair.dirA);
    removeDir(pair.dirB);
  }
});

// --- AC-05：20 样本冲突队列完整 + 本地 v2 保持可见 --------------------------------

interface Sample {
  name: string;
  kind: MemoryEntryKind;
  localSensitivity: SensitivityLevel;
  remoteSensitivity: SensitivityLevel;
  localContent: string;
  remoteContent: string;
  expect: "auto" | "locked" | "sensitivity_change" | "fact_conflict";
}

const SAMPLES: Sample[] = [
  { name: "pref-vim-emacs", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 偏好使用 vim 编辑器。", remoteContent: "Owner 偏好使用 emacs 编辑器。", expect: "auto" },
  { name: "pref-theme", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "I prefer the dark theme for the editor.", remoteContent: "I prefer the light theme for the editor.", expect: "auto" },
  { name: "pref-dark-light", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 喜欢深色主题。", remoteContent: "Owner 喜欢浅色主题。", expect: "auto" },
  { name: "pref-pnpm-npm", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 默认使用 pnpm 安装依赖。", remoteContent: "Owner 默认使用 npm 安装依赖。", expect: "auto" },
  { name: "pref-tabs-spaces", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner prefers tabs in TypeScript files.", remoteContent: "Owner prefers spaces in TypeScript files.", expect: "auto" },
  { name: "pref-font", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 的编辑器字体是 JetBrains Mono。", remoteContent: "Owner 的编辑器字体是 Fira Code。", expect: "auto" },
  { name: "fact-database", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "项目使用 PostgreSQL 作为主数据库。", remoteContent: "项目使用 MySQL 作为主数据库。", expect: "fact_conflict" },
  { name: "fact-ubuntu-debian", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "部署目标是 Ubuntu 24.04。", remoteContent: "部署目标是 Debian 12。", expect: "fact_conflict" },
  { name: "fact-port", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "服务监听端口 8787。", remoteContent: "服务监听端口 9000。", expect: "fact_conflict" },
  { name: "fact-sqlite", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "Morrow runtime 使用 node:sqlite。", remoteContent: "Morrow runtime 使用 better-sqlite3。", expect: "fact_conflict" },
  { name: "fact-city", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 住在杭州。", remoteContent: "Owner 住在上海。", expect: "fact_conflict" },
  { name: "fact-branch", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "发布分支是 integration/m0。", remoteContent: "发布分支是 main。", expect: "fact_conflict" },
  { name: "locked-passport", kind: "profile", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "Owner 的护照号是 E12345678。", remoteContent: "Owner 的护照号是 E87654321。", expect: "locked" },
  { name: "locked-birthday", kind: "profile", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "Owner 的生日是 1990-01-01。", remoteContent: "Owner 的生日是 1991-01-01。", expect: "locked" },
  { name: "locked-credential", kind: "fact", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "服务器根密码已托管在 1Password。", remoteContent: "服务器根密码已托管在 Bitwarden。", expect: "locked" },
  { name: "sens-address", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的家庭地址是杭州西湖区。", remoteContent: "Owner 的家庭地址是杭州滨江区。", expect: "sensitivity_change" },
  { name: "sens-phone", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的手机号是 13800000000。", remoteContent: "Owner 的手机号是 13900000000。", expect: "sensitivity_change" },
  { name: "sens-medical", kind: "fact", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的医疗记录保存在家庭医生处。", remoteContent: "Owner 的医疗记录保存在私人诊所。", expect: "sensitivity_change" },
  { name: "sens-apikey", kind: "fact", localSensitivity: "private", remoteSensitivity: "public", localContent: "客户的 API key 存放在 vault。", remoteContent: "客户的 API key 存放在环境变量。", expect: "sensitivity_change" },
  { name: "sens-bank", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的银行账户尾号 1234。", remoteContent: "Owner 的银行账户尾号 5678。", expect: "sensitivity_change" },
];

function factCreated(runtime: RuntimeHandle, replicaId: string, factId: string, sample: Sample): EventEnvelope {
  const envelope = buildEventEnvelope({
    replicaId,
    actorId: "owner",
    eventType: "memory.fact_created",
    payload: {
      fact_id: factId,
      version: 1,
      content: sample.localContent,
      kind: sample.kind,
      sensitivity: sample.localSensitivity,
      revision_id: uuidv7(),
      reason: "seed",
    },
  });
  runtime.ledger.append(envelope);
  return envelope;
}

function offlineUpdate(
  runtime: RuntimeHandle,
  replicaId: string,
  factId: string,
  sample: Sample,
  side: "A" | "B",
  version = 2,
): EventEnvelope {
  const envelope = buildEventEnvelope({
    replicaId,
    actorId: "owner",
    eventType: "memory.fact_updated",
    payload: {
      fact_id: factId,
      version,
      content: side === "A" ? sample.localContent : sample.remoteContent,
      kind: sample.kind,
      sensitivity: side === "A" ? sample.localSensitivity : sample.remoteSensitivity,
      revision_id: uuidv7(),
      reason: "offline_edit",
    },
  });
  runtime.ledger.append(envelope);
  return envelope;
}

test("AC-05 20 样本：冲突队列完整且两端各自的本地 v2 保持可见（不回落到基线 v1）", async () => {
  const pair = await startPair();
  try {
    const facts = SAMPLES.map((sample) => ({ sample, factId: uuidv7() }));
    for (const { sample, factId } of facts) factCreated(pair.a, REPLICA_A, factId, sample);
    pair.a.memoryRebuilder.rebuild();
    await pullAll(pair.b, REPLICA_A);
    for (const { sample, factId } of facts) {
      assert.equal(pair.b.memory.getFact(factId)?.version, 1, `基线同步到 B: ${sample.name}`);
    }

    // 双方离线写同一事实的 v2 竞争修订
    for (const { sample, factId } of facts) {
      offlineUpdate(pair.a, REPLICA_A, factId, sample, "A");
      offlineUpdate(pair.b, REPLICA_B, factId, sample, "B");
    }
    pair.a.memoryRebuilder.rebuild();
    pair.b.memoryRebuilder.rebuild();

    await syncAll(pair, 6);

    const conflictsA = pair.a.memory.listConflicts({ status: "open" });
    const conflictsB = pair.b.memory.listConflicts({ status: "open" });
    let reviewCount = 0;
    let localVisibleA = 0;
    let localVisibleB = 0;
    let merged = 0;
    for (const { sample, factId } of facts) {
      const factA = pair.a.memory.getFact(factId);
      const factB = pair.b.memory.getFact(factId);
      assert.ok(factA !== null && factB !== null, `${sample.name}: 事实存在`);
      if (sample.expect === "auto") {
        merged += 1;
        assert.equal(factA.version, 3, `${sample.name}: A 自动合并到 max+1`);
        assert.equal(factB.version, 3, `${sample.name}: B 自动合并到 max+1`);
        assert.equal(factA.content, factB.content, `${sample.name}: 两端收敛`);
        continue;
      }
      reviewCount += 1;
      assert.equal(conflictsA.find((conflict) => conflict.fact_id === factId)?.reason, sample.expect, `A 分类 ${sample.name}`);
      assert.equal(conflictsB.find((conflict) => conflict.fact_id === factId)?.reason, sample.expect, `B 分类 ${sample.name}`);
      // 关键断言（修复前 0/14）：待审核期间本地已合并的 v2 不得回落到基线 v1
      if (factA.version === 2 && factA.content === sample.localContent) localVisibleA += 1;
      if (factB.version === 2 && factB.content === sample.remoteContent) localVisibleB += 1;
    }

    assert.equal(merged, 6, "6 个 preference 自动合并");
    assert.equal(reviewCount, 14, "14 个待审核");
    assert.equal(conflictsA.length, 14, "A 冲突队列完整");
    assert.equal(conflictsB.length, 14, "B 冲突队列完整");
    assert.equal(localVisibleA, 14, "A 的本地 v2 全部保持可见（14/14）");
    assert.equal(localVisibleB, 14, "B 的本地 v2 全部保持可见（14/14）");
    assert.equal(pair.a.memoryRebuilder.check().ok, true, "A 投影与账本一致");
    assert.equal(pair.b.memoryRebuilder.check().ok, true, "B 投影与账本一致");

    // 冲突记录同时保留本地版本引用与远端事件引用
    const conflictEvent = pair.a.ledger
      .scan({ eventType: "sync.conflict" })
      .map((entry) => entry.envelope)
      .find((envelope) => {
        const factId = envelope.payload.fact_id;
        return facts.some(({ sample, factId: id }) => id === factId && sample.expect === "fact_conflict");
      });
    assert.ok(conflictEvent !== undefined);
    assert.equal(typeof conflictEvent.payload.local_event_id, "string");
    assert.equal(typeof conflictEvent.payload.local_revision_id, "string");
    assert.ok(Array.isArray(conflictEvent.payload.remote_event_ids));
    assert.ok((conflictEvent.payload.remote_event_ids as string[]).length > 0);
    assert.ok(
      (conflictEvent.payload.remote_event_ids as string[]).every(
        (eventId) => pair.a.ledger.hasEvent(eventId),
      ),
      "remote_event_ids 指向真实远端事件",
    );
  } finally {
    await closePair(pair);
  }
});

// --- 裁决后版本链与可见值符合裁决 -------------------------------------------------

test("冲突裁决 keep_new / keep_old / merge 后版本链正确且可见值符合裁决", async () => {
  const pair = await startPair();
  try {
    const samples: Sample[] = [
      {
        name: "keep-new",
        kind: "fact",
        localSensitivity: "private",
        remoteSensitivity: "private",
        localContent: "服务监听端口 8787。",
        remoteContent: "服务监听端口 9000。",
        expect: "fact_conflict",
      },
      {
        name: "keep-old",
        kind: "fact",
        localSensitivity: "private",
        remoteSensitivity: "private",
        localContent: "部署目标是 Ubuntu 24.04。",
        remoteContent: "部署目标是 Debian 12。",
        expect: "fact_conflict",
      },
      {
        name: "merge",
        kind: "fact",
        localSensitivity: "private",
        remoteSensitivity: "private",
        localContent: "发布分支是 integration/m0。",
        remoteContent: "发布分支是 main。",
        expect: "fact_conflict",
      },
    ];
    const facts = samples.map((sample) => ({ sample, factId: uuidv7() }));
    for (const { sample, factId } of facts) factCreated(pair.a, REPLICA_A, factId, sample);
    pair.a.memoryRebuilder.rebuild();
    await pullAll(pair.b, REPLICA_A);
    for (const { sample, factId } of facts) {
      offlineUpdate(pair.a, REPLICA_A, factId, sample, "A");
      offlineUpdate(pair.b, REPLICA_B, factId, sample, "B");
    }
    pair.a.memoryRebuilder.rebuild();
    pair.b.memoryRebuilder.rebuild();
    await syncAll(pair, 4);

    const conflictList = async (): Promise<Array<{ conflict_id: string; fact_id: string }>> => {
      const response = await fetch(`${pair.baseA}/v1/sync/conflicts?status=open`);
      const body = (await json<{ conflicts: Array<{ conflict_id: string; fact_id: string }> }>(response)) as {
        conflicts: Array<{ conflict_id: string; fact_id: string }>;
      };
      return body.conflicts;
    };
    const resolve = async (conflictId: string, body: Record<string, unknown>): Promise<void> => {
      const response = await fetch(`${pair.baseA}/v1/sync/conflicts/${conflictId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, `resolve ${JSON.stringify(body)}`);
    };

    const open = await conflictList();
    assert.equal(open.length, 3, "三个待审核冲突");
    const conflictOf = (name: string): string => {
      const factId = facts.find(({ sample }) => sample.name === name)?.factId as string;
      const conflict = open.find((candidate) => candidate.fact_id === factId);
      assert.ok(conflict !== undefined, `conflict for ${name}`);
      return conflict.conflict_id;
    };

    await resolve(conflictOf("keep-new"), { resolution: "keep_new" });
    await resolve(conflictOf("keep-old"), { resolution: "keep_old" });
    await resolve(conflictOf("merge"), { resolution: "merge", content: "发布分支是 integration/m0（Owner 合并）" });

    const byName = (name: string) => facts.find(({ sample }) => sample.name === name)?.factId as string;
    const keepNew = pair.a.memory.getFact(byName("keep-new"));
    assert.equal(keepNew?.version, 3, "keep_new：本地版本 +1");
    assert.equal(keepNew?.content, samples[0].remoteContent, "keep_new：可见值 = 远端（被采纳）");
    const keepNewRevisions = pair.a.memory.listRevisions(byName("keep-new"));
    assert.deepEqual(keepNewRevisions.map((revision) => revision.version), [2, 3]);
    assert.equal(keepNewRevisions[1].reason, "conflict_resolved");

    const keepOld = pair.a.memory.getFact(byName("keep-old"));
    assert.equal(keepOld?.version, 2, "keep_old：版本不变");
    assert.equal(keepOld?.content, samples[1].localContent, "keep_old：可见值 = 本地");

    const merged = pair.a.memory.getFact(byName("merge"));
    assert.equal(merged?.version, 3, "merge：本地版本 +1");
    assert.equal(merged?.content, "发布分支是 integration/m0（Owner 合并）");
    const mergedRevisions = pair.a.memory.listRevisions(byName("merge"));
    assert.equal(mergedRevisions.at(-1)?.reason, "conflict_merged");

    // 裁决事件传播到对端：keep_new / merge 收敛，keep_old 保持各自的本地值
    await syncAll(pair, 4);
    assert.equal(pair.b.memory.getFact(byName("keep-new"))?.content, samples[0].remoteContent);
    assert.equal(pair.b.memory.getFact(byName("keep-new"))?.version, 3);
    assert.equal(pair.b.memory.getFact(byName("merge"))?.content, "发布分支是 integration/m0（Owner 合并）");
    assert.equal(pair.b.memory.getFact(byName("keep-old"))?.version, 2);
    assert.equal(pair.b.memory.getFact(byName("keep-old"))?.content, samples[1].remoteContent);
    // 注：resolveConflict 的行时间戳与事件 occurred_at 分属两次取时（既有实现），
    // 可能有 1ms 差异；此处不断言 updated_at 的一致性，只断言版本链与可见值。
  } finally {
    await closePair(pair);
  }
});

// --- preference 版本稳定（重复同步/重复重放不膨胀） --------------------------------

test("preference 自动合并后重复同步 3 次与重复重放：版本稳定在 max+1", async () => {
  const pair = await startPair();
  try {
    const sample: Sample = {
      name: "pref-stability",
      kind: "preference",
      localSensitivity: "private",
      remoteSensitivity: "private",
      localContent: "Owner 偏好使用 vim 编辑器。",
      remoteContent: "Owner 偏好使用 emacs 编辑器。",
      expect: "auto",
    };
    const factId = uuidv7();
    factCreated(pair.a, REPLICA_A, factId, sample);
    // 基线内容只建 v1（localContent），A/B 各自写 v2 竞争内容
    pair.a.memoryRebuilder.rebuild();
    await pullAll(pair.b, REPLICA_A);
    offlineUpdate(pair.a, REPLICA_A, factId, sample, "A");
    offlineUpdate(pair.b, REPLICA_B, factId, sample, "B");
    pair.a.memoryRebuilder.rebuild();
    pair.b.memoryRebuilder.rebuild();

    await syncAll(pair, 3);
    const versionAfterMerge = pair.a.memory.getFact(factId)?.version;
    assert.equal(versionAfterMerge, 3, "重复合并结果为 max(local, remote)+1");

    // 重复同步 3 次：版本不膨胀
    await syncAll(pair, 3);
    assert.equal(pair.a.memory.getFact(factId)?.version, 3, "重复同步后 A 版本稳定");
    assert.equal(pair.b.memory.getFact(factId)?.version, 3, "重复同步后 B 版本稳定");

    // 重复重放（投影重建）3 次：版本不膨胀
    for (let i = 0; i < 3; i++) {
      pair.a.memoryRebuilder.rebuild();
      pair.b.memoryRebuilder.rebuild();
      assert.equal(pair.a.memory.getFact(factId)?.version, 3, "重复重放后 A 版本稳定");
      assert.equal(pair.b.memory.getFact(factId)?.version, 3, "重复重放后 B 版本稳定");
    }

    // 批次边界上的陈旧 v2 再次到达（新 event_id、旧版本）→ 不再二次合并
    const mergedBefore = pair.a.ledger.scan({ eventType: "sync.merged" }).length;
    const stale = offlineUpdate(pair.b, REPLICA_B, factId, sample, "B", 2);
    await pullAll(pair.a, REPLICA_B);
    assert.equal(pair.a.ledger.hasEvent(stale.event_id), true, "陈旧修订已到达账本（被幂等导入）");
    assert.equal(pair.a.memory.getFact(factId)?.version, 3, "陈旧 v2 不把版本推到 4");
    assert.equal(
      pair.a.ledger.scan({ eventType: "sync.merged" }).length,
      mergedBefore,
      "陈旧 v2 不触发第二次合并审计",
    );
    assert.equal(pair.a.memory.listConflicts({ status: "open" }).length, 0, "陈旧 v2 不制造冲突");
    assert.equal(pair.a.memoryRebuilder.check().ok, true);
  } finally {
    await closePair(pair);
  }
});
