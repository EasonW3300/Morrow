// 通知 HTTP 控制面测试（M4-T7 / Issue #44）：
// GET/PUT /v1/notifications/rules（key 合并 + 审计）、GET history（状态过滤）、
// GET pending（桌面待拉取）、POST ack（桌面确认），以及账本订阅 → 规则路由 →
// 渠道经 Outbox → echo 适配器的真实接线（无网络）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { NotificationHistoryPage, NotificationRecord, NotificationRule } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { EchoChannelAdapter } from "../src/channels/echo.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, makeEvent, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const TASK = "01936b9d-8f7a-7abc-9f2e-0000000000aa";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function appendTaskEvent(runtime: RuntimeHandle, eventType: string, payload: Record<string, unknown>): void {
  runtime.ledger.append(
    makeEvent({
      replica_id: REPLICA,
      event_type: eventType,
      task_id: TASK,
      occurred_at: new Date().toISOString(),
      payload,
    }),
  );
}

async function openRuntime(
  dir: string,
  options: Parameters<typeof startRuntime>[1] = {},
): Promise<{ runtime: RuntimeHandle; base: string }> {
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: async () =>
      createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
    enableEchoChannel: true,
    // 测试手动 drain，避免后台定时器把 queued 提前发出去（确定性）
    notificationDrainIntervalMs: 0,
    outboxDrainIntervalMs: 0,
    ...options,
  });
  return { runtime, base: `http://127.0.0.1:${runtime.port}` };
}

/** A3：渠道通知规则需要默认通知会话；echo 用一个白名单会话作为目标 */
function configureEchoNotifyTarget(runtime: RuntimeHandle): void {
  runtime.channels.allowConversation({
    account_id: "echo-default",
    native_conversation_id: "echo:notify",
    mode: "mention_only",
  });
  const result = runtime.channels.setNotifyTarget("echo", "echo:notify");
  assert.equal(result.ok, true);
}

test("规则 PUT 合并 + GET；非法规则 400；规则变更可审计", async (t) => {
  const dir = tmpDir("morrow-notifications-api-");
  const { runtime, base } = await openRuntime(dir);
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });
  configureEchoNotifyTarget(runtime);

  const put = await fetch(`${base}/v1/notifications/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rules: [
        { event_type: "completed", target: "desktop", enabled: true },
        {
          event_type: "waiting_input",
          target: "channel:echo",
          enabled: true,
          quiet_hours: { start: "22:00", end: "08:00" },
        },
      ],
    }),
  });
  assert.equal(put.status, 200);
  const putBody = await json<{ rules: NotificationRule[] }>(put);
  assert.equal(putBody.rules.length, 2);

  const merge = await fetch(`${base}/v1/notifications/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules: [{ event_type: "completed", target: "desktop", enabled: false }] }),
  });
  assert.equal(merge.status, 200);

  const list = await json<{ rules: NotificationRule[] }>(await fetch(`${base}/v1/notifications/rules`));
  assert.equal(list.rules.length, 2, "key 合并不删除未提交规则");
  assert.equal(list.rules.find((r) => r.target === "desktop")?.enabled, false);
  assert.deepEqual(list.rules.find((r) => r.target === "channel:echo")?.quiet_hours, {
    start: "22:00",
    end: "08:00",
  });

  const bad = await fetch(`${base}/v1/notifications/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules: [{ event_type: "cancelled", target: "desktop" }] }),
  });
  assert.equal(bad.status, 400);

  const audit = runtime.ledger.scan({ eventType: "notification.rule_upserted" });
  assert.equal(audit.length, 2);
});

test("账本订阅路由：桌面落 pending 可拉取，渠道经 Outbox → echo 发送；history/ack 状态闭合", async (t) => {
  const dir = tmpDir("morrow-notifications-api-");
  const { runtime, base } = await openRuntime(dir);
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });
  configureEchoNotifyTarget(runtime);

  const put = await fetch(`${base}/v1/notifications/rules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      rules: [
        { event_type: "completed", target: "desktop", enabled: true },
        { event_type: "completed", target: "channel:echo", enabled: true },
      ],
    }),
  });
  assert.equal(put.status, 200);

  appendTaskEvent(runtime, "task.completed", { goal: "Ship release 1.0" });

  const pending = await json<{ notifications: NotificationRecord[] }>(
    await fetch(`${base}/v1/notifications/pending`),
  );
  assert.equal(pending.notifications.length, 1, "桌面待拉取一条");
  assert.equal(pending.notifications[0]?.kind, "desktop");
  assert.match(pending.notifications[0]?.title ?? "", /Ship release 1\.0/);

  const history = await json<NotificationHistoryPage>(
    await fetch(`${base}/v1/notifications/history?limit=10`),
  );
  assert.equal(history.total, 2, "桌面 + 渠道各一条");
  const channel = history.notifications.find((n) => n.kind === "channel")!;
  assert.equal(channel.status, "queued");
  assert.ok(channel.outbox_id);

  const outboxPage = await json<{ messages: Array<{ id: string; channel_id: string; payload: { text: string } }> }>(
    await fetch(`${base}/v1/outbox?status=pending`),
  );
  assert.equal(outboxPage.messages.length, 1, "渠道通知在 Outbox 落库待发");
  assert.equal(outboxPage.messages[0]?.channel_id, "echo");

  const sent = await runtime.notifications.dispatchQueued();
  assert.equal(sent, 1);
  const echo = runtime.channels.getAdapter("echo") as EchoChannelAdapter;
  assert.equal(echo.sent.length, 1, "经 Outbox → channel adapter 真正发出");
  assert.match(echo.sent[0]?.text ?? "", /Ship release 1\.0/);
  assert.equal(echo.sent[0]?.idempotency_key, `notification:${channel.dedupe_key}`);

  const sentHistory = await json<NotificationHistoryPage>(
    await fetch(`${base}/v1/notifications/history?status=sent`),
  );
  assert.equal(sentHistory.notifications.length, 1);
  assert.equal(sentHistory.notifications[0]?.kind, "channel");

  const ack = await fetch(`${base}/v1/notifications/${pending.notifications[0]!.notification_id}/ack`, {
    method: "POST",
  });
  assert.equal(ack.status, 200);
  const acked = await json<{ notification: NotificationRecord }>(ack);
  assert.equal(acked.notification.status, "sent");
  assert.ok(acked.notification.delivered_at);

  // 重复 ack → 409（已不是 pending）
  const again = await fetch(`${base}/v1/notifications/${pending.notifications[0]!.notification_id}/ack`, {
    method: "POST",
  });
  assert.equal(again.status, 409);
  // 不存在 → 404
  assert.equal((await fetch(`${base}/v1/notifications/does-not-exist/ack`, { method: "POST" })).status, 404);
});

test("HISTORY 状态过滤分页参数校验；未配置规则的事件不产生通知", async (t) => {
  const dir = tmpDir("morrow-notifications-api-");
  const { runtime, base } = await openRuntime(dir);
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });

  appendTaskEvent(runtime, "task.failed", { message: "no rule" });
  const history = await json<NotificationHistoryPage>(await fetch(`${base}/v1/notifications/history`));
  assert.equal(history.total, 0, "默认 opt-in：没有规则不发通知");

  assert.equal((await fetch(`${base}/v1/notifications/history?status=bogus`)).status, 400);
  assert.equal((await fetch(`${base}/v1/notifications/history?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/v1/notifications/pending?limit=201`)).status, 400);
});
