// Task 视图纯逻辑测试（票 M1-T6 / Issue #18，FR-TASK-4 可视化分层）：
// 状态呈现映射、DAG 层级分组（依赖可视化从简）、diff 识别（只读展示）、
// 事件流归约（工具 I/O 配对）、事件分页窗口、修订表单校验。
// node:test + 零网络；React 只做装配（与 health-ui / connectivity-ui 同一分工）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskNodeRecord, TaskStatus } from "@morrow/protocol/browser";
import type { TaskEventEnvelope } from "./api.ts";
import {
  dagLayers,
  describeReconcileEvidence,
  eventPageState,
  looksLikeDiff,
  NEEDS_RECONCILE_MESSAGE,
  projectTaskEvents,
  reconcileControls,
  taskEventsRefreshMode,
  taskIsTerminal,
  taskNeedsReconcile,
  taskNodeStatusLabel,
  taskStatusLabel,
  taskStatusTone,
  validateReviseForm,
} from "./task-ui.ts";

function node(partial: Partial<TaskNodeRecord> & { key: string }): TaskNodeRecord {
  return {
    node_id: `id-${partial.key}`,
    title: `节点${partial.key}`,
    depends_on: [],
    retriable: true,
    side_effect: "delivery_unknown",
    status: "pending",
    attempts: 0,
    ...partial,
  };
}

function envelope(eventType: string, payload: Record<string, unknown>, sequence: number): { sequence: number; envelope: TaskEventEnvelope } {
  return {
    sequence,
    envelope: { event_id: `e${sequence}`, event_type: eventType, occurred_at: "2026-11-02T00:00:00Z", payload },
  };
}

// --- 状态呈现映射 ----------------------------------------------------------------

test("status labels cover all task and node statuses with distinct tones", () => {
  const statuses: TaskStatus[] = ["created", "planned", "running", "paused", "waiting_input", "failed", "completed", "cancelled"];
  for (const status of statuses) {
    assert.ok(taskStatusLabel(status).length > 0, `${status} 有标签`);
    assert.ok(taskStatusTone(status).length > 0, `${status} 有色调`);
  }
  assert.equal(taskStatusLabel("running"), "运行中");
  assert.equal(taskStatusLabel("waiting_input"), "等待输入");
  assert.equal(taskStatusTone("failed"), "error");
  assert.equal(taskStatusTone("completed"), "ok");
  assert.equal(taskStatusTone("running"), "run");
  // 节点状态含 M1-T5 的人工核对态
  assert.equal(taskNodeStatusLabel("pending_review"), "待人工核对");
  assert.equal(taskNodeStatusLabel("pending"), "待执行");
});

// --- DAG 层级分组 ----------------------------------------------------------------

test("dagLayers groups nodes by dependency level (层级缩进可视化)", () => {
  const nodes = [
    node({ key: "a" }),
    node({ key: "b", depends_on: ["a"] }),
    node({ key: "c", depends_on: ["a"] }),
    node({ key: "d", depends_on: ["b", "c"] }),
  ];
  const layers = dagLayers(nodes);
  assert.deepEqual(
    layers.layers.map((layer) => layer.map((n) => n.key).sort()),
    [["a"], ["b", "c"], ["d"]],
    "层级：a → (b, c) → d",
  );
  assert.deepEqual(layers.cyclicKeys, []);
});

test("dagLayers flags cycles instead of looping (防御：账本口径之外的手改 DAG)", () => {
  const nodes = [node({ key: "a", depends_on: ["b"] }), node({ key: "b", depends_on: ["a"] })];
  const layers = dagLayers(nodes);
  assert.deepEqual(layers.layers, [], "无入度为零的节点时没有可分层项");
  assert.deepEqual([...layers.cyclicKeys].sort(), ["a", "b"], "环内节点被标记");
});

// --- Diff 识别 ------------------------------------------------------------------

test("looksLikeDiff recognizes unified diff shapes and rejects ordinary text", () => {
  assert.ok(looksLikeDiff("diff --git a/app.ts b/app.ts\n@@ -1,2 +1,2 @@\n-old\n+new"));
  assert.ok(looksLikeDiff("--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-x\n+y"));
  assert.ok(looksLikeDiff("@@ -12,3 +12,4 @@\n context\n-removed\n+added"));
  assert.equal(looksLikeDiff("这是普通的执行结果文本，不是 diff。"), false);
  assert.equal(looksLikeDiff(""), false);
});

// --- 事件流归约（工具 I/O 配对） --------------------------------------------------

test("projectTaskEvents pairs tool.started/finished and summarizes lifecycle events", () => {
  const items = projectTaskEvents([
    envelope("task.started", {}, 1),
    envelope("task.node_started", { key: "a", title: "节点A", attempt: 1 }, 2),
    envelope("tool.started", { tool_call_id: "t1", tool_name: "edit_file", args: { path: "x.ts" } }, 3),
    envelope("tool.finished", { tool_call_id: "t1", tool_name: "edit_file", text: "written", is_error: false, duration_ms: 42 }, 4),
    envelope("task.node_finished", { key: "a", status: "completed", result: "a-ok" }, 5),
    envelope("task.revised", { summary: { updated_keys: ["b"], added_keys: [], removed_keys: [] } }, 6),
  ]);
  // tool.finished 就地补全 started（一次工具调用一项，与 Chat 投影同口径）→ 6 事件 5 项
  assert.equal(items.length, 5);
  const tool = items[2];
  assert.equal(tool.kind, "tool");
  if (tool.kind === "tool") {
    assert.equal(tool.toolName, "edit_file");
    assert.equal(tool.argsText, JSON.stringify({ path: "x.ts" }));
    assert.equal(tool.resultText, "written");
    assert.equal(tool.finished, true);
    assert.equal(tool.isError, false);
  }
  const revised = items[4];
  assert.equal(revised.kind, "lifecycle");
  if (revised.kind === "lifecycle") {
    assert.ok(revised.summary.includes("b"), "修订摘要进入事件行摘要");
  }
});

test("projectTaskEvents keeps an orphan tool.finished self-contained (重放起点截断防御)", () => {
  const items = projectTaskEvents([
    envelope("tool.finished", { tool_call_id: "t9", tool_name: "noop", text: "res", is_error: true }, 1),
  ]);
  const tool = items[0];
  assert.equal(tool.kind, "tool");
  if (tool.kind === "tool") {
    assert.equal(tool.finished, true);
    assert.equal(tool.isError, true);
    assert.equal(tool.resultText, "res");
  }
});

// --- 事件分页窗口 ----------------------------------------------------------------

test("eventPageState describes the window at a given offset (最新页优先)", () => {
  // 初次加载（offset=null）：取最后一页
  assert.deepEqual(eventPageState(120, 50, null), { offset: 70, hasOlder: true, hasNewer: false });
  // 无事件
  assert.deepEqual(eventPageState(0, 50, null), { offset: 0, hasOlder: false, hasNewer: false });
  // 中间窗口：两侧都可翻（组件以 offset±limit 并钳位为目标页）
  assert.deepEqual(eventPageState(120, 50, 20), { offset: 20, hasOlder: true, hasNewer: true });
  // 最早一页：只能向新翻
  assert.deepEqual(eventPageState(120, 50, 0), { offset: 0, hasOlder: false, hasNewer: true });
  // 最新一页：只能向旧翻
  assert.deepEqual(eventPageState(120, 50, 70), { offset: 70, hasOlder: true, hasNewer: false });
  // 不足一页的总量
  assert.deepEqual(eventPageState(10, 50, null), { offset: 0, hasOlder: false, hasNewer: false });
});

// --- 修订表单校验 ----------------------------------------------------------------

test("validateReviseForm builds the API body from form fields and rejects invalid input", () => {
  const nodes = [
    node({ key: "a", status: "completed", result: "done" }),
    node({ key: "b", goal: "old goal" }),
  ];

  // 空表单 → 无修改
  const empty = validateReviseForm({ updates: [], removeKeys: [], additions: [] }, nodes);
  assert.equal(empty.ok, false);
  assert.equal(empty.body, null);
  assert.ok(empty.errors.length > 0);

  // 合法：改 goal + 新增 + 移除未完成节点（c 存在时）
  const withC = [...nodes, node({ key: "c" })];
  const ok = validateReviseForm(
    {
      updates: [{ key: "b", goal: "new goal", model: "p-b" }],
      removeKeys: ["c"],
      additions: [{ key: "d", title: "新节点", goal: "do d", dependsOn: "b" }],
    },
    withC,
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body?.update, [{ key: "b", goal: "new goal", model: "p-b" }]);
  assert.deepEqual(ok.body?.remove, ["c"]);
  assert.deepEqual(ok.body?.add, [{ key: "d", title: "新节点", goal: "do d", depends_on: ["b"] }]);

  // 已完成节点不可移除/修改（服务端 immutable_node 的前端同口径）
  const touchingCompleted = validateReviseForm(
    { updates: [], removeKeys: ["a"], additions: [] },
    withC,
  );
  assert.equal(touchingCompleted.ok, false);

  // 新增 key 非法 / 重复 / 缺 title / 依赖不可解析 / 自依赖
  const badAdd = validateReviseForm(
    { updates: [], removeKeys: [], additions: [{ key: "BAD KEY", title: "x", dependsOn: "" }] },
    nodes,
  );
  assert.equal(badAdd.ok, false);
  const dupKey = validateReviseForm(
    { updates: [], removeKeys: [], additions: [{ key: "b", title: "x", dependsOn: "" }] },
    nodes,
  );
  assert.equal(dupKey.ok, false);
  const ghostDep = validateReviseForm(
    { updates: [], removeKeys: [], additions: [{ key: "d", title: "x", dependsOn: "ghost" }] },
    nodes,
  );
  assert.equal(ghostDep.ok, false);
  const selfDep = validateReviseForm(
    { updates: [], removeKeys: [], additions: [{ key: "d", title: "x", dependsOn: "d" }] },
    nodes,
  );
  assert.equal(selfDep.ok, false);

  // 成环：新增 d 依赖 b，同时把 b 的依赖……表单改不了 b 的依赖，成环只可能来自新增互相依赖
  const cycle = validateReviseForm(
    {
      updates: [],
      removeKeys: [],
      additions: [
        { key: "d", title: "D", dependsOn: "e" },
        { key: "e", title: "E", dependsOn: "d" },
      ],
    },
    nodes,
  );
  assert.equal(cycle.ok, false);
});

// --- needs_reconcile（票 M3-T6 / Issue #35：双端独立执行的 Owner 裁决）----------------

test("needs_reconcile 状态有专属标签/警示色调，且判定函数只认该状态", () => {
  assert.equal(taskStatusLabel("needs_reconcile"), "待人工裁决");
  assert.equal(taskStatusTone("needs_reconcile"), "warn");
  assert.equal(taskNeedsReconcile("needs_reconcile"), true);
  for (const status of ["created", "planned", "running", "paused", "waiting_input", "failed", "completed", "cancelled"] as TaskStatus[]) {
    assert.equal(taskNeedsReconcile(status), false, `${status} 不应触发裁决入口`);
  }
});

test("裁决说明文案明确「两设备独立执行过此任务，需你裁决」", () => {
  assert.equal(NEEDS_RECONCILE_MESSAGE, "两设备独立执行过此任务，需你裁决");
});

test("reconcileControls：待裁决且空闲时两个裁决按钮可用，附注记输入", () => {
  const controls = reconcileControls("needs_reconcile", false);
  assert.equal(controls.visible, true);
  assert.equal(controls.canSubmit, true);
  assert.equal(controls.noteEnabled, true);
  assert.equal(controls.hint, null);
  assert.deepEqual(
    controls.options.map((o) => [o.resolution, o.disabled]),
    [
      ["completed", false],
      ["failed", false],
    ],
  );
  assert.match(controls.options[0].label, /已完成/);
  assert.match(controls.options[1].label, /失败/);
  // 明确「不自动合并一侧结果」的语义提示
  assert.match(controls.options[0].hint, /不自动合并/);
});

test("reconcileControls：提交中禁用两个按钮（防重复裁决）", () => {
  const controls = reconcileControls("needs_reconcile", true);
  assert.equal(controls.canSubmit, false);
  assert.ok(controls.options.every((o) => o.disabled));
});

test("reconcileControls：非待裁决状态不显示入口，hint 说明当前状态", () => {
  const controls = reconcileControls("completed", false);
  assert.equal(controls.visible, false);
  assert.equal(controls.canSubmit, false);
  assert.ok(controls.options.every((o) => o.disabled));
  assert.match(controls.hint ?? "", /已完成/);
  assert.match(controls.hint ?? "", /无需裁决/);
});

test("describeReconcileEvidence：复述双端执行证据（副本短 id + 原因中文），无证据返回 null", () => {
  const text = describeReconcileEvidence({
    task_id: "t1",
    replicas: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    independent_replicas: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    sources: [],
    transfers: [],
    reasons: ["dual_execution"],
  });
  assert.ok(text !== null);
  assert.match(text, /11111111/);
  assert.match(text, /22222222/);
  assert.match(text, /各自独立执行/);
  assert.equal(describeReconcileEvidence(null), null);
});

// --- 走查修复（M6-T2 / Issue #53）------------------------------------------------

test("taskIsTerminal：completed/failed/cancelled 隐藏节点介入入口", () => {
  assert.equal(taskIsTerminal("completed"), true);
  assert.equal(taskIsTerminal("failed"), true);
  assert.equal(taskIsTerminal("cancelled"), true);
  assert.equal(taskIsTerminal("running"), false);
  assert.equal(taskIsTerminal("paused"), false);
  assert.equal(taskIsTerminal("waiting_input"), false);
  assert.equal(taskIsTerminal("needs_reconcile"), false);
});

test("taskEventsRefreshMode：仅运行中自动轮询，其余靠动作刷新/手动刷新", () => {
  assert.equal(taskEventsRefreshMode("running"), "poll");
  for (const status of ["planned", "paused", "waiting_input", "completed", "failed", "needs_reconcile"] as TaskStatus[]) {
    assert.equal(taskEventsRefreshMode(status), "manual");
  }
});
