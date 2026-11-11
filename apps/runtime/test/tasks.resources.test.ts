// 节点资源声明（票 M2-T4 / Issue #25，PRD §4.3 FR-TASK-8）：DAG 节点 schema 增 resources
// （只加演进）：git_repo（代码任务 → worktree 隔离）与 lock（非代码任务互斥）。
// 规划输出经 ajv schema + 语义校验；落表后投影 round-trip；修订不触碰 resources（保留原值）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import { EventLedger } from "../src/ledger.ts";
import { TaskService, validatePlannedDag } from "../src/tasks.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

function openService(plannerOutput: string): { svc: TaskService; dir: string; close(): void } {
  const dir = tmpDir("morrow-tasks-res-");
  const ledger = EventLedger.open(dir);
  const svc = new TaskService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    factory: async () => createFakePi({ script: planScript(plannerOutput) }),
  });
  return { svc, dir, close: () => { svc.close(); ledger.close(); removeDir(dir); } };
}

// --- 规划校验 ------------------------------------------------------------------

test("validatePlannedDag accepts resource declarations and normalizes them", () => {
  const dag = validatePlannedDag(planJson([
    {
      key: "code", title: "改代码", goal: "edit",
      resources: { git_repo: { path: "/repo/demo", branch: "main" } },
    },
    { key: "audit", title: "审计", resources: { lock: ["ledger:2026-11", "ledger:2026-11"] } },
  ]));
  assert.deepEqual(dag.nodes[0].resources, { git_repo: { path: "/repo/demo", branch: "main" } });
  // lock 去重保序
  assert.deepEqual(dag.nodes[1].resources, { lock: ["ledger:2026-11"] });
  // 未声明 → 字段省略（缺省无资源约束，M1 节点行为不变）
  const bare = validatePlannedDag(planJson([{ key: "only", title: "Only" }]));
  assert.equal(bare.nodes[0].resources, undefined);
});

test("validatePlannedDag rejects malformed resource declarations", () => {
  const cases: Array<[unknown, RegExp]> = [
    // git_repo 缺 path
    [{ key: "a", title: "A", resources: { git_repo: {} } }, /plan schema|resources/],
    // git_repo 空 path
    [{ key: "a", title: "A", resources: { git_repo: { path: "" } } }, /plan schema|resources/],
    // git_repo 未知字段（fail-closed）
    [{ key: "a", title: "A", resources: { git_repo: { path: "/r", depth: 2 } } }, /plan schema|resources/],
    // 未知资源种类
    [{ key: "a", title: "A", resources: { gpu: true } }, /plan schema|resources/],
    // lock 空 key
    [{ key: "a", title: "A", resources: { lock: [""] } }, /plan schema|resources/],
    // lock 非字符串
    [{ key: "a", title: "A", resources: { lock: [7] } }, /plan schema|resources/],
  ];
  for (const [nodes, match] of cases) {
    assert.throws(
      () => validatePlannedDag(planJson([nodes])),
      (err: unknown) => err instanceof Error && match.test(err.message),
      `应拒绝 ${JSON.stringify(nodes)}`,
    );
  }
});

// --- 持久化与投影 ----------------------------------------------------------------

test("createTask persists node resources; projection and task.planned payload round-trip them", async () => {
  const h = openService(planJson([
    {
      key: "code", title: "改代码", goal: "edit the repo",
      resources: { git_repo: { path: "/repo/demo" }, lock: ["repo:demo"] },
    },
    { key: "report", title: "写报告", resources: { lock: ["ledger:q4"] } },
  ]));
  try {
    const detail = await h.svc.createTask("改代码并写报告");
    assert.equal(detail.status, "planned");
    const code = detail.nodes.find((n) => n.key === "code");
    const report = detail.nodes.find((n) => n.key === "report");
    assert.deepEqual(code?.resources, { git_repo: { path: "/repo/demo" }, lock: ["repo:demo"] });
    assert.deepEqual(report?.resources, { lock: ["ledger:q4"] });
    assert.equal(detail.nodes.find((n) => n.key === "code")?.status, "pending");

    // task.planned 事件 payload 携带全量投影（含 resources）
    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    const planned = events.find((e) => e.event_type === "task.planned");
    const plannedNodes = (planned?.payload.nodes ?? []) as Array<{ key: string; resources?: unknown }>;
    assert.deepEqual(plannedNodes.find((n) => n.key === "code")?.resources, {
      git_repo: { path: "/repo/demo" },
      lock: ["repo:demo"],
    });
    assert.deepEqual(plannedNodes.find((n) => n.key === "report")?.resources, { lock: ["ledger:q4"] });
  } finally {
    h.close();
  }
});

test("revision resets node status but preserves its resource declaration", async () => {
  const h = openService(planJson([
    { key: "code", title: "改代码", retriable: false, resources: { git_repo: { path: "/repo/demo" } } },
  ]));
  try {
    const detail = await h.svc.createTask("目标");
    const taskId = detail.task_id;
    // 跑失败 → revise 重置 pending
    const eventsBefore = h.svc.taskEvents(taskId)?.events.length ?? 0;
    void eventsBefore;
    const revised = h.svc.reviseTask(taskId, { update: [{ key: "code", title: "改代码 v2" }] });
    const node = revised.task.nodes.find((n) => n.key === "code");
    assert.equal(node?.status, "pending");
    assert.deepEqual(node?.resources, { git_repo: { path: "/repo/demo" } }, "修订保留 resources");
  } finally {
    h.close();
  }
});
