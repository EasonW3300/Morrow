// Checkpoint 域 seam 测试（票 M1-T5 / Issue #17，PRD §4.3 FR-TASK-5/6、§6 恢复语义）：
// CheckpointService（快照字段集/存储/事件）+ planReconcile（副作用分类恢复决策表）。
// 账本是唯一事实源：事件断言走 svc.taskEvents；快照断言走 CheckpointService 读路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { TaskDetail } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import {
  CheckpointError,
  CheckpointService,
  CHECKPOINT_SNAPSHOT_SCHEMA,
  planReconcile,
  type CheckpointSnapshot,
} from "../src/checkpoint.ts";
import { TaskService } from "../src/tasks.ts";
import { openSqlite } from "../src/db.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

/** A(irreversible)→B(delivery_unknown) 串行 + C(reversible) 并行 */
const MIXED_PLAN = planJson([
  { key: "a", title: "节点A", goal: "do a", depends_on: [], retriable: true, side_effect: "irreversible", model: "model-a" },
  { key: "b", title: "节点B", goal: "do b", depends_on: ["a"], retriable: false },
  { key: "c", title: "节点C", goal: "do c", depends_on: [], retriable: true, side_effect: "reversible" },
]);

interface Harness {
  svc: TaskService;
  checkpoints: CheckpointService;
  dir: string;
  close(): void;
}

function openHarness(plan: string): Harness {
  const dir = tmpDir("morrow-checkpoint-");
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

async function plannedTask(h: Harness, goal = "整理周报并归档"): Promise<TaskDetail> {
  return h.svc.createTask(goal);
}

// --- 快照字段集（FR-TASK-5） ------------------------------------------------------

test("createCheckpoint captures the full FR-TASK-5 field set for a planned task", async () => {
  const h = openHarness(MIXED_PLAN);
  try {
    const detail = await plannedTask(h);
    const record = await h.checkpoints.createCheckpoint(detail.task_id, "pause");

    assert.match(record.checkpoint_id, /^[0-9a-f-]{36}$/);
    assert.equal(record.task_id, detail.task_id);
    assert.equal(record.task_version, 1);
    assert.equal(record.reason, "pause");
    assert.match(record.created_at, /Z$/);

    const s = record.snapshot;
    assert.equal(s.schema, CHECKPOINT_SNAPSHOT_SCHEMA);
    // Task Graph 快照（节点/边/状态/task_version）
    assert.deepEqual(
      { task_id: s.task.task_id, goal: s.task.goal, status: s.task.status, task_version: s.task.task_version },
      { task_id: detail.task_id, goal: "整理周报并归档", status: "planned", task_version: 1 },
    );
    assert.equal(s.graph.nodes.length, 3);
    const a = s.graph.nodes.find((n) => n.key === "a");
    assert.ok(a);
    assert.equal(a.node_id, detail.nodes.find((n) => n.key === "a")?.node_id);
    assert.equal(a.side_effect, "irreversible");
    assert.equal(a.status, "pending");
    assert.equal(a.attempts, 0);
    assert.equal(a.model, "model-a");
    assert.equal(a.result, null);
    assert.deepEqual(s.graph.edges, [{ from: "a", to: "b" }]);

    // Run 状态与推进位置
    assert.equal(s.run.status, "planned");
    assert.equal(s.run.run_root_event_id, null, "未开跑：无 run 根事件");
    assert.ok(s.run.event_cursor >= 2, "event_cursor 至少覆盖 created+planned");
    assert.deepEqual(s.run.output_refs, {}, "无已完成节点 → 无输出引用");

    // 文件快照/工作区引用：M1 无工作区 → null + 说明
    assert.equal(s.workspace, null);
    assert.ok(typeof s.workspace_note === "string" && s.workspace_note.length > 0);

    // 执行配置（模型/工具版本）
    assert.equal(s.execution.runtime_version, null, "未注入 executionInfo → null");
    assert.equal(s.execution.provider, null);
    assert.deepEqual(s.execution.node_models, { a: "model-a" });
    assert.deepEqual(s.execution.tool_versions, {});

    // 相关会话 id（M1 无 Task↔Session 关联 → 空表占位）
    assert.deepEqual(s.session_ids, []);

    // 待处理副作用清单（按副作用分类）
    const pending = new Map(s.pending_side_effects.map((p) => [p.key, p]));
    assert.equal(pending.size, 3);
    assert.equal(pending.get("a")?.side_effect, "irreversible");
    assert.equal(pending.get("a")?.state, "not_delivered", "未执行节点：副作用未发生");
    assert.equal(pending.get("b")?.state, "not_delivered");
    assert.equal(pending.get("c")?.side_effect, "reversible");
    assert.equal(pending.get("c")?.state, "not_delivered");
  } finally {
    h.close();
  }
});

test("createCheckpoint appends task.checkpoint_created to the ledger with task_id and lean payload", async () => {
  const h = openHarness(MIXED_PLAN);
  try {
    const detail = await plannedTask(h);
    const record = await h.checkpoints.createCheckpoint(detail.task_id, "pause");
    const events = h.svc.taskEvents(detail.task_id)?.events ?? [];
    const last = events[events.length - 1];
    assert.equal(last.event_type, "task.checkpoint_created");
    assert.equal(last.task_id, detail.task_id);
    assert.equal(last.actor_id, "agent:runtime");
    assert.equal(last.payload.checkpoint_id, record.checkpoint_id);
    assert.equal(last.payload.reason, "pause");
    assert.equal(last.payload.task_version, 1);
    const nodeStats = last.payload.node_stats as Record<string, number>;
    assert.equal(nodeStats.total, 3);
    assert.equal(nodeStats.pending, 3);
    assert.ok(typeof last.payload.event_cursor === "number");
  } finally {
    h.close();
  }
});

test("checkpoint listing returns newest first and latest resolves the newest", async () => {
  const h = openHarness(MIXED_PLAN);
  try {
    const detail = await plannedTask(h);
    const one = await h.checkpoints.createCheckpoint(detail.task_id, "pause");
    const two = await h.checkpoints.createCheckpoint(detail.task_id, "pause");
    const list = h.checkpoints.listCheckpoints(detail.task_id);
    assert.deepEqual(list.map((c) => c.checkpoint_id), [two.checkpoint_id, one.checkpoint_id]);
    assert.equal(h.checkpoints.latestCheckpoint(detail.task_id)?.checkpoint_id, two.checkpoint_id);
    assert.equal(h.checkpoints.getCheckpoint(one.checkpoint_id)?.task_id, detail.task_id);
    // 未知任务/未知 id
    assert.deepEqual(h.checkpoints.listCheckpoints("01936b9d-8f7a-7abc-9f2e-000000000000"), []);
    assert.equal(h.checkpoints.latestCheckpoint("01936b9d-8f7a-7abc-9f2e-000000000000"), null);
    assert.equal(h.checkpoints.getCheckpoint("01936b9d-8f7a-7abc-9f2e-000000000000"), null);
  } finally {
    h.close();
  }
});

test("checkpoint listing is deterministic for same-millisecond checkpoints (insertion order, not id order)", () => {
  // 回归（M3-T1 合并后实测 flaky）：曾按 created_at/checkpoint_id 排序——同毫秒下
  // UUIDv7 的随机位决定顺序，代码时序一变就翻转。权威排序键必须是插入序 seq。
  const dir = tmpDir("morrow-checkpoint-seq-");
  const db = openSqlite(`${dir}/checkpoints.sqlite`);
  try {
    const store = new CheckpointStore(db);
    const frozen = "2026-11-10T00:00:00.000Z";
    // 故意让先插入者的 id 字典序更大，验证排序不依赖 id
    store.insert({
      checkpoint_id: "01936b9d-8f7a-7fff-9f2e-000000000001",
      task_id: "t-1",
      task_version: 1,
      reason: "pause",
      snapshot: {} as never,
      created_at: frozen,
    });
    store.insert({
      checkpoint_id: "01936b9d-8f7a-7000-9f2e-000000000002",
      task_id: "t-1",
      task_version: 1,
      reason: "pause",
      snapshot: {} as never,
      created_at: frozen,
    });
    assert.deepEqual(
      store.listForTask("t-1").map((c) => c.checkpoint_id),
      ["01936b9d-8f7a-7000-9f2e-000000000002", "01936b9d-8f7a-7fff-9f2e-000000000001"],
    );
    assert.equal(store.latestForTask("t-1")?.checkpoint_id, "01936b9d-8f7a-7000-9f2e-000000000002");
  } finally {
    db.close();
    removeDir(dir);
  }
});

test("checkpoint write interrupted after the row lands is compensated: no orphan row, error surfaced", async () => {
  const h = openHarness(MIXED_PLAN);
  try {
    const detail = await plannedTask(h);
    // 注入：第 N 次 ledger.append 抛错（行已写、事件写不进 → 服务必须补偿删除行）
    const ledger = h.svc.ledger;
    let failNext = false;
    const realAppend = ledger.append.bind(ledger);
    // 显式委托桩（EventLedger 方法有私有品牌检查，不能用 Object.create 代理）
    const proxyLedger = {
      append: (envelope: Parameters<EventLedger["append"]>[0]) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected ledger failure (checkpoint 写入中断)");
        }
        return realAppend(envelope);
      },
      scan: (selector?: Parameters<EventLedger["scan"]>[0]) => ledger.scan(selector),
      list: (options?: Parameters<EventLedger["list"]>[0]) => ledger.list(options),
      count: () => ledger.count(),
    } as unknown as EventLedger;
    const injected = new CheckpointService({ tasks: h.svc, dataDir: h.dir, ledger: proxyLedger, replicaId: REPLICA });
    try {
      failNext = true;
      await assert.rejects(() => injected.createCheckpoint(detail.task_id, "pause"), /injected ledger failure/);
      assert.deepEqual(h.checkpoints.listCheckpoints(detail.task_id), [], "中断的 checkpoint 不得留下孤儿行");
    } finally {
      injected.close();
    }
    // 重试路径完好：同一任务随后可正常建 checkpoint
    const record = await h.checkpoints.createCheckpoint(detail.task_id, "pause");
    assert.equal(h.checkpoints.listCheckpoints(detail.task_id).length, 1);
    assert.equal(record.snapshot.task.task_id, detail.task_id);
  } finally {
    h.close();
  }
});

// --- planReconcile（恢复决策表：副作用分类 → 动作，FR-TASK-6/§6） ------------------

function detailWith(nodes: Array<Partial<TaskDetail["nodes"][number]> & { key: string }>): TaskDetail {
  return {
    task_id: "01936b9d-8f7a-7abc-9f2e-000000000001",
    goal: "g",
    status: "paused",
    task_version: 1,
    created_at: "2026-11-02T00:00:00.000Z",
    updated_at: "2026-11-02T00:00:00.000Z",
    nodes: nodes.map((n) => ({
      node_id: `nid-${n.key}`,
      key: n.key,
      title: n.key,
      depends_on: n.depends_on ?? [],
      retriable: n.retriable ?? true,
      side_effect: n.side_effect ?? "delivery_unknown",
      status: n.status ?? "pending",
      attempts: n.attempts ?? 0,
      ...(n.result === undefined ? {} : { result: n.result }),
      ...(n.error === undefined ? {} : { error: n.error }),
    })),
  };
}

function snapshotWith(nodes: Array<{ key: string; status: string }>): CheckpointSnapshot {
  return {
    schema: CHECKPOINT_SNAPSHOT_SCHEMA,
    task: { task_id: "t", goal: "g", status: "paused", task_version: 1 },
    graph: {
      nodes: nodes.map((n) => ({
        node_id: `nid-${n.key}`,
        key: n.key,
        title: n.key,
        goal: null,
        depends_on: [],
        agent_role: null,
        model: null,
        retriable: true,
        side_effect: "delivery_unknown",
        resources: null,
        status: n.status as CheckpointSnapshot["graph"]["nodes"][number]["status"],
        attempts: 1,
        result: null,
        error: null,
      })),
      edges: [],
    },
    run: { status: "paused", run_root_event_id: null, event_cursor: 5, output_refs: {} },
    workspace: null,
    workspace_note: "n/a",
    execution: { runtime_version: null, provider: null, node_models: {}, tool_versions: {} },
    session_ids: [],
    pending_side_effects: [],
  };
}

const actionOf = (report: ReturnType<typeof planReconcile>, key: string) =>
  report.actions.find((a) => a.key === key);

test("planReconcile without a checkpoint: completed stays, stale running is gated by side-effect class", () => {
  const task = detailWith([
    { key: "done", status: "completed", result: "r" },
    { key: "mid_rev", status: "running", side_effect: "reversible" },
    { key: "mid_unk", status: "running", side_effect: "delivery_unknown" },
    { key: "rest", status: "pending" },
  ]);
  const report = planReconcile(task, null);
  assert.equal(actionOf(report, "done")?.action, "keep_completed");
  assert.equal(actionOf(report, "rest")?.action, "keep_pending");
  // 半写（running 无结果）：reversible → 重放；delivery_unknown → 人工核对
  assert.equal(actionOf(report, "mid_rev")?.action, "replay");
  assert.equal(actionOf(report, "mid_rev")?.to_status, "pending");
  assert.equal(actionOf(report, "mid_unk")?.action, "flag_pending_review");
  assert.equal(actionOf(report, "mid_unk")?.to_status, "pending_review");
  assert.deepEqual(report.pending_review_keys, ["mid_unk"]);
  assert.deepEqual(report.pending_compensations, []);
});

test("planReconcile rewinds nodes completed after the checkpoint, gated by side-effect class", () => {
  // checkpoint 时 a/b 未完成；现在 a/b 已完成 → 回卷决策按分类
  const cp = snapshotWith([
    { key: "a", status: "pending" },
    { key: "b", status: "pending" },
    { key: "c", status: "pending" },
  ]);
  const task = detailWith([
    { key: "a", status: "completed", side_effect: "reversible", result: "a-out" },
    { key: "b", status: "completed", side_effect: "compensatable", result: "b-out" },
    { key: "c", status: "completed", side_effect: "irreversible", result: "c-out" },
  ]);
  const report = planReconcile(task, cp);
  assert.equal(actionOf(report, "a")?.action, "replay", "checkpoint 后才完成的可逆节点 → 重放");
  assert.equal(actionOf(report, "a")?.to_status, "pending");
  assert.equal(actionOf(report, "b")?.action, "replay_with_compensation", "可补偿节点 → 重放并登记待补偿");
  assert.equal(actionOf(report, "c")?.action, "flag_pending_review", "不可逆且 checkpoint 后才完成（已送达）→ 不自动重发，人工核对");
  assert.equal(actionOf(report, "c")?.to_status, "pending_review");
  assert.deepEqual(report.pending_review_keys, ["c"]);
  assert.deepEqual(report.pending_compensations.map((c) => c.key), ["b"]);
});

test("planReconcile keeps nodes the checkpoint already recorded completed (no replay)", () => {
  const cp = snapshotWith([
    { key: "a", status: "completed" },
    { key: "b", status: "pending" },
  ]);
  const task = detailWith([
    { key: "a", status: "completed", side_effect: "irreversible", result: "a-out" },
    { key: "b", status: "pending" },
  ]);
  const report = planReconcile(task, cp);
  assert.equal(actionOf(report, "a")?.action, "keep_completed");
  assert.deepEqual(report.pending_review_keys, [], "无回卷 → 无人工核对");
  assert.deepEqual(report.pending_compensations, []);
  // checkpoint 之后新增 pending_review（此前已标记）→ 保持不动作
  const flagged = detailWith([
    { key: "a", status: "completed", side_effect: "irreversible" },
    { key: "z", status: "pending_review", side_effect: "delivery_unknown" },
  ]);
  const keep = planReconcile(flagged, cp);
  assert.equal(actionOf(keep, "z")?.action, "keep_pending_review");
  assert.equal(actionOf(keep, "z")?.to_status, "pending_review");
});

// --- CheckpointError ------------------------------------------------------------

test("restoreCheckpoint rejects unknown or foreign checkpoints with CheckpointError", async () => {
  const h = openHarness(MIXED_PLAN);
  try {
    const detail = await plannedTask(h);
    assert.throws(
      () => h.checkpoints.restoreCheckpoint(detail.task_id, "01936b9d-8f7a-7abc-9f2e-000000000000"),
      (err: unknown) => err instanceof CheckpointError && err.code === "checkpoint_not_found",
    );
  } finally {
    h.close();
  }
});
