// 通知规则与路由的领域测试（M4-T7 / Issue #44，PRD §4.8 FR-NOT-1/2，AC-13）：
// 规则 key 合并 upsert、四类事件路由、去重窗口、免打扰跨天延迟、渠道经 Outbox、
// 私有内容按接收者裁剪。全部注入时钟与内存适配器桩：零网络、零 sleep。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventLedger } from "../src/ledger.ts";
import { OutboxService, type OutboxChannelAdapter, type OutboxSendRequest } from "../src/outbox/service.ts";
import { NotificationService, NOTIFICATION_EVENT_TYPES } from "../src/notifications/service.ts";
import { makeEvent, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const TASK = "01936b9d-8f7a-7abc-9f2e-0000000000aa";

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

function clock(startIso = "2026-01-01T00:00:00.000Z"): Clock {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function harness(
  c: Clock,
  overrides: Partial<ConstructorParameters<typeof NotificationService>[0]> = {},
): { service: NotificationService; ledger: EventLedger; dir: string } {
  const dir = tmpDir("morrow-notifications-");
  const ledger = EventLedger.open(dir);
  const service = new NotificationService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    now: () => c.now(),
    ...overrides,
  });
  return { service, ledger, dir };
}

function dispose(service: NotificationService, ledger: EventLedger, dir: string): void {
  service.close();
  ledger.close();
  removeDir(dir);
}

test("通知规则按 (event_type, target) 做 key 合并 upsert，并留审计事件", () => {
  const c = clock();
  const { service, ledger, dir } = harness(c);
  try {
    const created = service.upsertRules([
      { event_type: "completed", target: "desktop", enabled: true },
      {
        event_type: "waiting_input",
        target: "channel:echo",
        enabled: true,
        quiet_hours: { start: "22:00", end: "08:00" },
      },
    ]);
    assert.equal(created.length, 2);
    assert.equal(service.listRules().length, 2);

    // 只提交一条：其余规则不被删除（key 合并语义）
    service.upsertRules([
      { event_type: "completed", target: "desktop", enabled: false },
    ]);
    const rules = service.listRules();
    assert.equal(rules.length, 2, "未提交的规则保持不变");
    const desktop = rules.find((r) => r.target === "desktop");
    assert.equal(desktop?.enabled, false);
    assert.deepEqual(rules.find((r) => r.target === "channel:echo")?.quiet_hours, { start: "22:00", end: "08:00" });

    const audit = ledger.scan({ eventType: NOTIFICATION_EVENT_TYPES.ruleUpserted });
    assert.equal(audit.length, 2, "每次 PUT 记一条规则变更审计事件");
    assert.equal(audit[0]?.envelope.actor_id, "owner");
    assert.equal((audit[0]?.envelope.payload as { rules: unknown[] }).rules.length, 2);
  } finally {
    dispose(service, ledger, dir);
  }
});

test("规则校验：未知事件类型 / 非法目标 / 非法免打扰时段一律拒绝", () => {
  const c = clock();
  const { service, ledger, dir } = harness(c);
  try {
    assert.throws(
      () => service.upsertRules([{ event_type: "cancelled" as never, target: "desktop", enabled: true }]),
      /event_type/,
    );
    assert.throws(
      () => service.upsertRules([{ event_type: "completed", target: "email:owner", enabled: true }]),
      /target/,
    );
    assert.throws(
      () =>
        service.upsertRules([
          {
            event_type: "completed",
            target: "desktop",
            enabled: true,
            quiet_hours: { start: "25:00", end: "08:00" },
          },
        ]),
      /quiet_hours/,
    );
    assert.equal(service.listRules().length, 0);
  } finally {
    dispose(service, ledger, dir);
  }
});

function taskEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
  overrides: { taskId?: string } = {},
) {
  return makeEvent({
    event_type: eventType,
    task_id: overrides.taskId ?? TASK,
    payload,
  });
}

test("迁移幂等：重开同 dataDir 不丢规则/投递行（CREATE IF NOT EXISTS）", () => {
  const c = clock();
  const dir = tmpDir("morrow-notifications-");
  const ledger = EventLedger.open(dir);
  try {
    const first = new NotificationService({ dataDir: dir, ledger, replicaId: REPLICA, now: () => c.now() });
    first.upsertRules([{ event_type: "completed", target: "desktop", enabled: true }]);
    first.handleEnvelope(taskEvent("task.completed", {}));
    assert.equal(first.history().total, 1);
    first.close();

    const second = new NotificationService({ dataDir: dir, ledger, replicaId: REPLICA, now: () => c.now() });
    try {
      assert.equal(second.listRules().length, 1, "重开迁移不重建/清空规则表");
      assert.equal(second.history().total, 1, "投递投影跨重启保留");
    } finally {
      second.close();
    }
  } finally {
    ledger.close();
    removeDir(dir);
  }
});

test("四类事件按规则路由到桌面；未启用规则不发；node_finished 仅 completed 算 milestone", () => {
  const c = clock("2026-01-01T09:00:00.000Z");
  const { service, ledger, dir } = harness(c, {
    taskLookup: () => ({
      task_id: TASK,
      goal: "Ship the release",
      status: "completed",
      nodes: [],
    }),
  });
  try {
    service.upsertRules([
      { event_type: "completed", target: "desktop", enabled: true },
      { event_type: "failed", target: "desktop", enabled: true },
      { event_type: "waiting_input", target: "desktop", enabled: true },
      { event_type: "milestone", target: "desktop", enabled: true },
    ]);

    service.handleEnvelope(taskEvent("task.completed", {}));
    service.handleEnvelope(taskEvent("task.failed", { message: "builder crashed" }));
    service.handleEnvelope(taskEvent("task.waiting_input", { message: "need the API key" }));
    service.handleEnvelope(taskEvent("task.node_finished", { status: "completed", key: "build", result: "ok" }));
    // 失败/待审的节点完成不是里程碑
    service.handleEnvelope(taskEvent("task.node_finished", { status: "failed", key: "test", error: "red" }));
    service.handleEnvelope(taskEvent("task.node_finished", { status: "pending_review", key: "merge" }));

    const pending = service.pendingDesktop();
    assert.equal(pending.length, 4, "四类事件各产生一条桌面通知，非里程碑节点完成不发");
    assert.deepEqual(
      pending.map((n) => n.event_type).sort(),
      ["completed", "failed", "milestone", "waiting_input"],
    );
    const completed = pending.find((n) => n.event_type === "completed");
    assert.match(completed?.title ?? "", /Ship the release/);
    assert.match(pending.find((n) => n.event_type === "failed")?.body ?? "", /builder crashed/);
    assert.match(pending.find((n) => n.event_type === "waiting_input")?.body ?? "", /need the API key/);
    assert.match(pending.find((n) => n.event_type === "milestone")?.body ?? "", /build/);

    // 关闭规则后同类事件不再产生新通知（窗口推进到下一个去重桶）
    service.upsertRules([{ event_type: "failed", target: "desktop", enabled: false }]);
    c.advance(11 * 60_000);
    service.handleEnvelope(taskEvent("task.failed", { message: "again" }));
    assert.equal(service.pendingDesktop().length, 4, "enabled=false 的事件不发");

    // 无关事件（task.started）不触发通知
    c.advance(11 * 60_000);
    service.handleEnvelope(taskEvent("task.started", {}));
    assert.equal(service.pendingDesktop().length, 4);
  } finally {
    dispose(service, ledger, dir);
  }
});

test("去重：同 task_id + event_type 在窗口内只发一次；窗口可配、跨窗口再发", () => {
  const c = clock("2026-01-01T09:00:00.000Z");
  const { service, ledger, dir } = harness(c, { dedupeWindowMs: 60_000 });
  try {
    service.upsertRules([{ event_type: "completed", target: "desktop", enabled: true }]);

    service.handleEnvelope(taskEvent("task.completed", {}));
    service.handleEnvelope(taskEvent("task.completed", {})); // 同窗口重复
    c.advance(30_000);
    service.handleEnvelope(taskEvent("task.completed", {})); // 仍在 60s 窗口桶内
    assert.equal(service.pendingDesktop().length, 1, "窗口内同任务同类事件只投递一次");

    const suppressed = ledger.scan({ eventType: NOTIFICATION_EVENT_TYPES.suppressed });
    assert.equal(suppressed.length, 2, "重复事件各记一条 suppressed 审计");
    assert.equal((suppressed[0]?.envelope.payload as { reason: string }).reason, "dedupe_window");

    // 不同任务不受影响
    service.handleEnvelope(taskEvent("task.completed", {}, { taskId: "01936b9d-8f7a-7abc-9f2e-0000000000bb" }));
    assert.equal(service.pendingDesktop().length, 2);

    // 跨出窗口桶后同任务再次通知
    c.advance(31_000);
    service.handleEnvelope(taskEvent("task.completed", {}));
    assert.equal(service.pendingDesktop().length, 3);

    // 不同事件类型各自独立
    c.advance(60_000);
    service.upsertRules([{ event_type: "failed", target: "desktop", enabled: true }]);
    service.handleEnvelope(taskEvent("task.failed", {}));
    assert.equal(service.pendingDesktop().length, 4);
    assert.equal(ledger.scan({ eventType: NOTIFICATION_EVENT_TYPES.dispatched }).length, 4);
  } finally {
    dispose(service, ledger, dir);
  }
});

test("免打扰：跨天时段 22:00-08:00 内延迟，到点后放行（注入时钟、零 sleep）", () => {
  const c = clock("2026-01-01T23:00:00.000Z");
  const { service, ledger, dir } = harness(c);
  try {
    service.upsertRules([
      {
        event_type: "completed",
        target: "desktop",
        enabled: true,
        quiet_hours: { start: "22:00", end: "08:00" },
      },
    ]);

    service.handleEnvelope(taskEvent("task.completed", {}));
    assert.equal(service.pendingDesktop().length, 0, "静默时段内桌面不推送");

    const history = service.history();
    assert.equal(history.total, 1);
    const delayed = history.notifications[0]!;
    assert.equal(delayed.status, "delayed");
    assert.equal(delayed.deliver_after, "2026-01-02T08:00:00.000Z", "跨天时段延迟到次日 08:00");
    assert.equal(ledger.scan({ eventType: NOTIFICATION_EVENT_TYPES.delayed }).length, 1);

    c.advance(8 * 60 * 60_000 + 59 * 60_000); // 07:59
    assert.equal(service.pendingDesktop().length, 0, "结束前仍不投递");

    c.advance(60_000); // 08:00（结束时刻不含在静默时段内）
    const pending = service.pendingDesktop();
    assert.equal(pending.length, 1, "跨过结束时刻后放行");
    assert.equal(pending[0]!.status, "pending");
    assert.equal(service.history().notifications[0]!.status, "pending");
    assert.equal(ledger.scan({ eventType: NOTIFICATION_EVENT_TYPES.dispatched }).length, 1);
  } finally {
    dispose(service, ledger, dir);
  }
});

test("免打扰：同日时段 12:00-14:00 延迟到当日 14:00；边界语义 start 含 / end 不含", () => {
  const c = clock("2026-01-01T13:00:00.000Z");
  const { service, ledger, dir } = harness(c);
  try {
    service.upsertRules([
      {
        event_type: "waiting_input",
        target: "desktop",
        enabled: true,
        quiet_hours: { start: "12:00", end: "14:00" },
      },
      { event_type: "completed", target: "desktop", enabled: true, quiet_hours: { start: "12:00", end: "14:00" } },
    ]);

    service.handleEnvelope(taskEvent("task.waiting_input", { message: "approve?" }));
    const row = service.history().notifications[0]!;
    assert.equal(row.status, "delayed");
    assert.equal(row.deliver_after, "2026-01-01T14:00:00.000Z", "同日时段延迟到当日结束时刻");

    c.advance(60 * 60_000); // 14:00，恰好结束：不静默 → 立即投递
    service.handleEnvelope(taskEvent("task.completed", {}));
    const completed = service.history().notifications.find((n) => n.event_type === "completed")!;
    assert.equal(completed.status, "pending", "end 时刻已放开，直接投递");

    assert.equal(service.pendingDesktop().length, 2, "延迟行在读取待拉取时被放行");
  } finally {
    dispose(service, ledger, dir);
  }
});

/** 计数的渠道适配器桩：记录 Outbox 实际发出的请求（平台侧观察点） */
class CountingAdapter implements OutboxChannelAdapter {
  readonly requests: OutboxSendRequest[] = [];
  async send(request: OutboxSendRequest) {
    this.requests.push(request);
    return { kind: "sent" as const, receipt: { platform_message_id: `om_${request.idempotency_key}` } };
  }
}

test("渠道目标经 Outbox 投递：先入队再发送，幂等键含 task+event+窗口，绝不直连适配器", async () => {
  const c = clock("2026-01-01T09:00:00.000Z");
  const adapter = new CountingAdapter();
  const dir = tmpDir("morrow-notifications-");
  const ledger = EventLedger.open(dir);
  const outbox = new OutboxService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    adapter,
    now: () => c.now(),
  });
  const service = new NotificationService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    outbox,
    now: () => c.now(),
    channelAccountId: (channelId) => (channelId === "echo" ? "echo-default" : null),
  });
  try {
    service.upsertRules([{ event_type: "completed", target: "channel:echo", enabled: true }]);
    service.handleEnvelope(taskEvent("task.completed", { goal: "ship it" }));

    const row = service.history().notifications[0]!;
    assert.equal(row.kind, "channel");
    assert.equal(row.status, "queued");
    assert.equal(row.channel_id, "echo");
    assert.ok(row.outbox_id, "通知行关联 Outbox id");

    const outboxRow = outbox.get(row.outbox_id!)!;
    assert.equal(outboxRow.status, "pending", "先落库：未 dispatch 前是 pending");
    assert.equal(outboxRow.channel_id, "echo");
    assert.equal(outboxRow.account_id, "echo-default");
    assert.equal(outboxRow.task_id, TASK);
    assert.equal(outboxRow.idempotency_key, `notification:${row.dedupe_key}`);
    assert.match(outboxRow.idempotency_key, new RegExp(`${TASK}\\|completed\\|channel:echo\\|`));
    assert.match(String(outboxRow.payload.text), /ship it/);
    assert.equal(adapter.requests.length, 0, "入队本身不触达平台适配器");

    const sent = await service.dispatchQueued();
    assert.equal(sent, 1);
    assert.equal(adapter.requests.length, 1, "经 Outbox 投递器发送一次");
    assert.equal(adapter.requests[0]!.channel_id, "echo");
    assert.equal(service.history().notifications[0]!.status, "sent");
    assert.equal(outbox.get(row.outbox_id!)!.status, "sent");

    // 同窗口重复事件不产生第二次平台请求
    service.handleEnvelope(taskEvent("task.completed", { goal: "ship it" }));
    await service.dispatchQueued();
    assert.equal(adapter.requests.length, 1);
  } finally {
    service.close();
    outbox.close();
    ledger.close();
    removeDir(dir);
  }
});

test("渠道不可用（无账号/无 Outbox）时通知落 failed，且不直接调用适配器", () => {
  const c = clock("2026-01-01T09:00:00.000Z");
  const { service, ledger, dir } = harness(c, {
    channelAccountId: () => null,
  });
  try {
    service.upsertRules([{ event_type: "failed", target: "channel:feishu", enabled: true }]);
    service.handleEnvelope(taskEvent("task.failed", { message: "boom" }));
    const row = service.history().notifications[0]!;
    assert.equal(row.status, "failed");
    assert.match(row.detail ?? "", /channel_unavailable|outbox_unavailable/);
  } finally {
    dispose(service, ledger, dir);
  }
});

test("内容裁剪：渠道接收者正文不含 private 记忆/文件路径/凭据，但通知照发；桌面保留全文", async () => {
  const c = clock("2026-01-01T09:00:00.000Z");
  const privateFact = "therapy notes say I panic before flights";
  const adapter = new CountingAdapter();
  const dir = tmpDir("morrow-notifications-");
  const ledger = EventLedger.open(dir);
  const outbox = new OutboxService({ dataDir: dir, ledger, replicaId: REPLICA, adapter, now: () => c.now() });
  const service = new NotificationService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    outbox,
    now: () => c.now(),
    privateMemoryContents: () => [privateFact],
    channelAccountId: () => "echo-default",
    taskLookup: () => ({
      task_id: TASK,
      goal: "Plan the trip",
      status: "completed",
      nodes: [
        {
          key: "itinerary",
          title: "Build itinerary",
          status: "completed",
          result: `${privateFact}; report saved at /Users/alice/private/trip.md; api_key=sk-live-ABC123456789`,
        },
      ],
    }),
  });
  try {
    service.upsertRules([
      { event_type: "completed", target: "channel:echo", enabled: true },
      { event_type: "completed", target: "desktop", enabled: true },
    ]);
    service.handleEnvelope(taskEvent("task.completed", {}));

    const channel = service.history().notifications.find((n) => n.kind === "channel")!;
    assert.equal(channel.status, "queued", "裁剪不等于整条不发");
    assert.ok(!channel.body.includes(privateFact), "private 记忆内容被裁剪");
    assert.ok(!channel.body.includes("/Users/alice"), "文件路径被裁剪");
    assert.ok(!channel.body.includes("sk-live-ABC123456789"), "凭据被裁剪");
    assert.match(channel.body, /\[已裁剪\]/);
    assert.match(channel.body, /Build itinerary/, "非敏感部分保留");

    const outboxRow = outbox.get(channel.outbox_id!)!;
    assert.ok(!String(outboxRow.payload.text).includes(privateFact), "外发载荷本身已裁剪");
    await service.dispatchQueued();
    assert.equal(adapter.requests.length, 1);
    assert.ok(!String(adapter.requests[0]!.payload.text).includes(privateFact), "平台侧收到的是裁剪后正文");
    assert.match(String(adapter.requests[0]!.payload.text), /\[已裁剪\]/);

    const desktop = service.history().notifications.find((n) => n.kind === "desktop")!;
    assert.ok(desktop.body.includes(privateFact), "本机 Owner 桌面通知保留完整内容");
    assert.ok(desktop.body.includes("/Users/alice/private/trip.md"));
  } finally {
    service.close();
    outbox.close();
    ledger.close();
    removeDir(dir);
  }
});
