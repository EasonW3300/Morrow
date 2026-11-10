/**
 * 桌面通知消费端纯逻辑测试（Issue #47，PRD §4.8 FR-NOT-2）。
 *
 * 覆盖：轮询状态机（新 pending → 展示 + ack）、同一 id 不重复弹、ack 失败指数退避
 * （上限 3 次）、权限被拒降级（不 ack、保留 pending、面板文案、不重复请求）、
 * 「全部标记已读」逐条 ack、未读计数、任务 id 跳转解析、轮询间隔与时间/摘要投影。
 * 全部依赖注入：零网络、零真实计时。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NotificationRecord } from "@morrow/protocol/browser";
import {
  DEFAULT_POLL_INTERVAL_MS,
  NotificationPoller,
  canRequestPermissionAgain,
  eventTypeLabel,
  eventTypeTone,
  formatNotificationTime,
  notificationSummary,
  permissionNotice,
  resolvePermissionOverride,
  resolvePollIntervalMs,
  shouldRequestPermissionOnStartup,
  taskIdForNavigation,
  type NotificationLogFields,
} from "./notification-center.ts";

function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    notification_id: "n1",
    task_id: "01936b9d-8f7a-7abc-9f2e-0000000000aa",
    event_type: "completed",
    target: "desktop",
    kind: "desktop",
    channel_id: null,
    status: "pending",
    title: "任务完成：整理季度资料",
    body: "整理季度资料并归档\n节点 collect: ok",
    outbox_id: null,
    dedupe_key: "task|completed|desktop",
    deliver_after: null,
    detail: null,
    created_at: "2026-01-01T00:00:00.000Z",
    delivered_at: null,
    ...overrides,
  };
}

function recorder() {
  const warnings: Array<{ message: string; fields?: NotificationLogFields }> = [];
  return {
    warnings,
    logger: {
      warn(message: string, fields?: NotificationLogFields) {
        warnings.push({ message, fields });
      },
    },
  };
}

test("轮询：新 pending → 展示一次 → ack → 未读归零", async () => {
  const acked: string[] = [];
  const displayed: string[] = [];
  const changes: number[] = [];
  const poller = new NotificationPoller({
    fetchPending: async () => [record({ notification_id: "n1" }), record({ notification_id: "n2" })],
    ack: async (id) => {
      acked.push(id);
    },
    display: (item) => {
      displayed.push(item.notification_id);
      return true;
    },
    intervalMs: 0,
    onChange: (pending) => changes.push(pending.length),
  });

  const result = await poller.pollOnce();

  assert.deepEqual(displayed, ["n1", "n2"]);
  assert.deepEqual(acked, ["n1", "n2"]);
  assert.deepEqual(result, { fetched: 2, displayed: 2, acknowledged: 2, ackFailed: 0, skipped: false });
  assert.equal(poller.unreadCount, 0);
  assert.deepEqual(changes, [0]);
});

test("去重：同一 id 多轮 pending 只弹一次；ack 失败时后续轮次只重试 ack", async () => {
  const displayed: string[] = [];
  const ackCalls: string[] = [];
  const poller = new NotificationPoller({
    fetchPending: async () => [record({ notification_id: "dup" })],
    ack: async (id) => {
      ackCalls.push(id);
      throw new Error("runtime down");
    },
    display: (item) => {
      displayed.push(item.notification_id);
      return true;
    },
    intervalMs: 0,
    ackMaxAttempts: 1,
    logger: recorder().logger,
  });

  const first = await poller.pollOnce();
  const second = await poller.pollOnce();

  assert.deepEqual(displayed, ["dup"], "同一 id 只弹一次");
  assert.equal(first.displayed, 1);
  assert.equal(second.displayed, 0);
  assert.equal(ackCalls.length, 2, "每轮仍重试 ack（pending 未清）");
  assert.equal(poller.unreadCount, 1, "ack 失败保留未读");
  assert.equal(poller.pending[0]?.notification_id, "dup");
});

test("ack 失败：指数退避重试，上限 3 次后保留 pending 并留下可诊断日志（不含正文）", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const { warnings, logger } = recorder();
  const body = "这是一段不应出现在日志里的通知正文";
  const poller = new NotificationPoller({
    fetchPending: async () => [record({ notification_id: "n1", body })],
    ack: async () => {
      attempts += 1;
      throw new Error("ack 503");
    },
    intervalMs: 0,
    ackMaxAttempts: 3,
    ackBackoffBaseMs: 500,
    sleep: async (ms) => {
      delays.push(ms);
    },
    logger,
  });

  const result = await poller.pollOnce();

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000], "两次退避，第三次后放弃");
  assert.equal(result.ackFailed, 1);
  assert.equal(poller.unreadCount, 1);
  assert.ok(warnings.length >= 3, "每次失败都有日志");
  const serialized = JSON.stringify(warnings);
  assert.ok(!serialized.includes(body), "日志不得含正文全文");
  assert.ok(serialized.includes("bodyLength"), "日志应带长度而非内容");
  assert.ok(warnings.every((entry) => entry.fields?.notificationId === "n1"));
});

test("ack 前两次失败、第三次成功：不再弹第二次，pending 清空", async () => {
  let attempts = 0;
  let displayCount = 0;
  const poller = new NotificationPoller({
    fetchPending: async () => [record({ notification_id: "n1" })],
    ack: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary");
      return { ok: true };
    },
    display: () => {
      displayCount += 1;
      return true;
    },
    intervalMs: 0,
    ackMaxAttempts: 3,
    sleep: async () => {},
    logger: recorder().logger,
  });

  const result = await poller.pollOnce();

  assert.equal(attempts, 3);
  assert.equal(displayCount, 1);
  assert.equal(result.acknowledged, 1);
  assert.equal(poller.unreadCount, 0);
});

test("权限被拒降级：仅在应用内展示（display=false）→ 不 ack，pending 保留可读", async () => {
  const acked: string[] = [];
  const poller = new NotificationPoller({
    fetchPending: async () => [record({ notification_id: "n1" })],
    ack: async (id) => {
      acked.push(id);
    },
    display: () => false,
    intervalMs: 0,
  });

  const result = await poller.pollOnce();

  assert.equal(result.displayed, 0);
  assert.deepEqual(acked, [], "降级时不 ack，保持未读");
  assert.equal(poller.unreadCount, 1);
});

test("展示抛错（系统通知 API 不可用）同样降级：不 ack、有日志", async () => {
  const { warnings, logger } = recorder();
  const poller = new NotificationPoller({
    fetchPending: async () => [record({ notification_id: "n1" })],
    ack: async () => {
      assert.fail("展示失败时不应 ack");
    },
    display: () => {
      throw new Error("notification api unavailable");
    },
    intervalMs: 0,
    logger,
  });

  const result = await poller.pollOnce();

  assert.equal(result.displayed, 0);
  assert.equal(poller.unreadCount, 1);
  assert.equal(warnings[0]?.message, "notification display failed");
});

test("全部标记已读：逐条 ack，成功项移出未读；失败项保留", async () => {
  const acked: string[] = [];
  const poller = new NotificationPoller({
    fetchPending: async () => [
      record({ notification_id: "ok-1" }),
      record({ notification_id: "bad" }),
      record({ notification_id: "ok-2" }),
    ],
    ack: async (id) => {
      if (id === "bad") throw new Error("gone");
      acked.push(id);
    },
    display: () => false,
    intervalMs: 0,
    ackMaxAttempts: 1,
    sleep: async () => {},
    logger: recorder().logger,
  });

  await poller.pollOnce();
  assert.equal(poller.unreadCount, 3);

  const result = await poller.markAllRead();

  assert.deepEqual(acked, ["ok-1", "ok-2"]);
  assert.deepEqual(result, { acknowledged: 2, failed: 1 });
  assert.equal(poller.unreadCount, 1);
  assert.equal(poller.pending[0]?.notification_id, "bad");
});

test("未读计数口径 = pending 条数；拉取失败不清空已有未读", async () => {
  let fail = false;
  const poller = new NotificationPoller({
    fetchPending: async () => {
      if (fail) throw new Error("network");
      return [record({ notification_id: "n1" }), record({ notification_id: "n2" })];
    },
    ack: async () => {},
    display: () => false,
    intervalMs: 0,
    onError: () => {},
  });

  await poller.pollOnce();
  assert.equal(poller.unreadCount, 2);

  fail = true;
  const result = await poller.pollOnce();
  assert.equal(result.fetched, 0);
  assert.equal(poller.unreadCount, 2, "拉取失败保留上轮未读");
});

test("权限文案：denied 明确降级且可手动重新请求；granted 无提示；unavailable 浏览器降级", () => {
  const denied = permissionNotice("denied");
  assert.equal(denied?.tone, "warn");
  assert.match(denied?.detail ?? "", /应用内/);
  assert.equal(denied?.canRequest, true);

  assert.equal(permissionNotice("granted"), null);

  const unavailable = permissionNotice("unavailable");
  assert.equal(unavailable?.tone, "muted");
  assert.match(unavailable?.title ?? "", /不支持/);
  assert.equal(unavailable?.canRequest, false);
  assert.equal(canRequestPermissionAgain("unavailable"), false);
  assert.equal(canRequestPermissionAgain("denied"), true);
});

test("首次启动请求权限：只在 prompt 且未被拒过时自动请求（拒绝后不再弹）", () => {
  assert.equal(shouldRequestPermissionOnStartup("prompt", false), true);
  assert.equal(shouldRequestPermissionOnStartup("prompt", true), false, "本地拒绝标记阻止重复弹框");
  assert.equal(shouldRequestPermissionOnStartup("denied", false), false);
  assert.equal(shouldRequestPermissionOnStartup("granted", false), false);
  assert.equal(shouldRequestPermissionOnStartup("unavailable", false), false);
});

test("轮询间隔可配：默认 10s、查询参数优先、0 关闭、非法值回退默认", () => {
  assert.equal(resolvePollIntervalMs(""), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(resolvePollIntervalMs(""), 10_000);
  assert.equal(resolvePollIntervalMs("?notification_poll_ms=2500"), 2500);
  assert.equal(resolvePollIntervalMs("?notification_poll_ms=0"), 0, "0 = 测试/关闭");
  assert.equal(resolvePollIntervalMs("?notification_poll_ms=abc"), DEFAULT_POLL_INTERVAL_MS);
  assert.equal(resolvePollIntervalMs("", "3000"), 3000, "env 次之");
  assert.equal(resolvePollIntervalMs("?notification_poll_ms=1", "3000"), 1, "查询参数优先");
});

test("浏览器走查覆盖权限态：?notification_permission=denied", () => {
  assert.equal(resolvePermissionOverride("?notification_permission=denied"), "denied");
  assert.equal(resolvePermissionOverride("?notification_permission=granted"), "granted");
  assert.equal(resolvePermissionOverride("?notification_permission=bogus"), null);
  assert.equal(resolvePermissionOverride(""), null);
});

test("跳转任务 id 解析：非空才返回（不从正文臆造）", () => {
  assert.equal(taskIdForNavigation(record()), "01936b9d-8f7a-7abc-9f2e-0000000000aa");
  assert.equal(taskIdForNavigation(record({ task_id: null })), null);
  assert.equal(taskIdForNavigation(record({ task_id: "   " })), null);
  assert.equal(taskIdForNavigation(record({ task_id: " task-1 " })), "task-1");
});

test("事件类型标签与语气", () => {
  assert.equal(eventTypeLabel("completed"), "任务完成");
  assert.equal(eventTypeLabel("failed"), "任务失败");
  assert.equal(eventTypeLabel("waiting_input"), "等待输入");
  assert.equal(eventTypeLabel("milestone"), "里程碑");
  assert.equal(eventTypeLabel("unknown"), "unknown");
  assert.equal(eventTypeTone("completed"), "ok");
  assert.equal(eventTypeTone("failed"), "error");
  assert.equal(eventTypeTone("waiting_input"), "warn");
  assert.equal(eventTypeTone("milestone"), "muted");
});

test("正文摘要压平空白并截断", () => {
  assert.equal(notificationSummary("a\n\nb   c"), "a b c");
  assert.equal(notificationSummary("abcdef", 4), "abc…");
  assert.equal(notificationSummary("abc"), "abc");
});

test("时间展示：同日 HH:MM，跨日 MM-DD HH:MM（本地时区）", () => {
  const now = new Date(2026, 0, 2, 15, 30);
  const sameDay = new Date(2026, 0, 2, 9, 5).toISOString();
  const otherDay = new Date(2025, 11, 31, 23, 7).toISOString();
  assert.equal(formatNotificationTime(sameDay, now), "09:05");
  assert.equal(formatNotificationTime(otherDay, now), "12-31 23:07");
  assert.equal(formatNotificationTime("not-a-date", now), "not-a-date");
});

test("intervalMs=0 时不启动定时器；start/stop 幂等", async () => {
  const poller = new NotificationPoller({
    fetchPending: async () => [],
    ack: async () => {},
    intervalMs: 0,
  });
  poller.start();
  assert.equal(poller.running, false);
  poller.stop();
  assert.equal(poller.intervalMs, 0);
});
