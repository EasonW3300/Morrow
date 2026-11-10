// 任务投影重放单测（M3 修复批 / #32 #36）：task.* 事件 → tasks/task_nodes/task_edges。
// 覆盖状态/版本/节点结果/attempts/resources/actor/依赖、修订快照、补充上下文、
// needs_reconcile 裁决，以及重建幂等（重复重建同结果）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope, TaskDetail } from "@morrow/protocol";
import { buildEventEnvelope } from "../src/envelope.ts";
import { EventLedger } from "../src/ledger.ts";
import { TaskService } from "../src/tasks.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const TASK_ID = "01936b9d-8f7a-7abc-9f2e-000000000099";
const NODE_A = "01936b9d-8f7a-7abc-9f2e-0000000000a1";
const NODE_B = "01936b9d-8f7a-7abc-9f2e-0000000000b2";

function taskEvent(
  eventType: string,
  payload: Record<string, unknown>,
  occurredAt: string,
): EventEnvelope {
  const envelope = buildEventEnvelope({
    replicaId: REPLICA,
    actorId: eventType.includes("taken_over") || eventType.includes("revised") ? "owner" : "agent:runtime",
    eventType,
    taskId: TASK_ID,
    payload,
  });
  // occurred_at 由工厂取当前时间；重放断言只依赖相对顺序与显式 payload 字段
  void occurredAt;
  return envelope;
}

function nodeA(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: NODE_A,
    key: "a",
    title: "A",
    goal: "do a",
    depends_on: [],
    retriable: true,
    side_effect: "reversible",
    resources: { git_repo: { path: "/tmp/morrow-repo" } },
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

function nodeB(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: NODE_B,
    key: "b",
    title: "B",
    goal: "do b",
    depends_on: ["a"],
    retriable: false,
    side_effect: "irreversible",
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

test("任务投影重放：状态/版本/节点结果/attempts/resources/actor/依赖与裁决结果", () => {
  const dir = tmpDir("morrow-task-rebuild-");
  const ledger = EventLedger.open(dir);
  const tasks = new TaskService({ dataDir: dir, ledger, replicaId: REPLICA, factory: null });
  try {
    const events: EventEnvelope[] = [
      taskEvent("task.created", { goal: "重建任务", session_id: "01936b9d-8f7a-7abc-9f2e-000000000010" }, "t0"),
      taskEvent("task.planned", { task_version: 1, edge_count: 0, nodes: [nodeA()] }, "t1"),
      taskEvent("task.started", { reason: "scheduled" }, "t2"),
      taskEvent("task.node_started", { node_id: NODE_A, key: "a", title: "A", goal: "do a", attempt: 1 }, "t3"),
      // 租约丢失 → pending_review（保留已产出文本 + 错误说明）
      taskEvent(
        "task.node_finished",
        { node_id: NODE_A, key: "a", status: "pending_review", attempt: 1, result: "partial-a", error: "execution lease lost" },
        "t4",
      ),
      // 修订（全量 DAG 投影）：a 重置 pending 并改 goal，新增 b 依赖 a
      taskEvent(
        "task.revised",
        {
          task_version: 2,
          summary: { updated_keys: ["a"], added_keys: ["b"], removed_keys: [] },
          changes: { update: [{ key: "a" }], add: [{ key: "b" }], remove: [] },
          nodes: [nodeA({ goal: "do a (revised)", status: "pending", attempts: 1 }), nodeB()],
        },
        "t5",
      ),
      taskEvent(
        "task.context_supplied",
        { target: "node", node_id: NODE_A, key: "a", context: "补充上下文" },
        "t6",
      ),
      taskEvent("task.node_taken_over", { node_id: NODE_B, key: "b", title: "B" }, "t7"),
      // 双端独立执行 → needs_reconcile → Owner 裁决 completed
      taskEvent("task.needs_reconcile", { reason: "dual_execution_detected", from_status: "running", evidence: {} }, "t8"),
      taskEvent("task.reconciled", { resolution: "completed", note: "owner decided" }, "t9"),
      taskEvent("task.completed", { reason: "owner_reconcile", resolution: "completed" }, "t10"),
    ];
    for (const envelope of events) ledger.append(envelope);

    // 空表 → 从账本重建
    const first = tasks.rebuildProjection();
    assert.equal(first.tasks, 1);
    assert.equal(first.nodes, 2);
    assert.equal(first.edges, 1);
    assert.equal(first.replayedEvents, events.length);

    const detail = tasks.getTask(TASK_ID);
    assert.ok(detail !== null);
    assert.equal(detail.status, "completed");
    assert.equal(detail.task_version, 2);
    assert.equal(detail.session_id, "01936b9d-8f7a-7abc-9f2e-000000000010");
    assert.equal(detail.error, undefined);

    const a = detail.nodes.find((node) => node.key === "a");
    assert.ok(a !== undefined);
    assert.equal(a.status, "pending");
    assert.equal(a.result, undefined, "修订重置后的节点结果已清空");
    assert.equal(a.attempts, 1, "attempts 随账本保留");
    assert.equal(a.goal, "do a (revised)\n\n[Owner 补充] 补充上下文", "补充上下文按目标追加");
    assert.deepEqual(a.resources, { git_repo: { path: "/tmp/morrow-repo" } }, "resources 重建");
    assert.equal(a.side_effect, "reversible");

    const b = detail.nodes.find((node) => node.key === "b");
    assert.ok(b !== undefined);
    assert.equal(b.actor, "owner", "owner 接管标记重建");
    assert.deepEqual(b.depends_on, ["a"], "依赖边重建");
    assert.equal(b.side_effect, "irreversible");
    assert.equal(b.retriable, false);

    // 幂等：重建两次得到同一投影（行集与详情一致）
    const snapshot = JSON.stringify(detail);
    const second = tasks.rebuildProjection();
    assert.deepEqual(second, first, "重复重建结果计数一致");
    assert.equal(JSON.stringify(tasks.getTask(TASK_ID)), snapshot, "重复重建详情一致");

    // 事件晚到（同步增量）后再重建：状态推进可见
    ledger.append(taskEvent("task.failed", { reason: "late", message: "late failure" }, "t11"));
    tasks.rebuildProjection();
    const failed = tasks.getTask(TASK_ID) as TaskDetail;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "late failure", "失败原因（旧账本回退 payload.message）可重建");
  } finally {
    tasks.close();
    ledger.close();
    removeDir(dir);
  }
});
