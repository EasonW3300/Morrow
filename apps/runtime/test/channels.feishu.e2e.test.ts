// 飞书端到端协议闭环（M4-T3 / Issue #40，AC-09 协议层）：
// 事件长连接 → 签名/解密 → T1 统一入站路由 → 会话 → 回复入 Outbox →
// dispatchOnce 经飞书适配器 reply API → ChannelTestServer 收到 → outbound.* 审计可查。
// 以及签名失败留痕、429 退避不重复、token 过期刷新、超时→delivery_unknown。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import { EventLedger } from "../src/ledger.ts";
import { SessionManager } from "../src/sessions.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { ChannelTestServer } from "../src/channels/testing/channel-test-server.ts";
import { FeishuChannelAdapter, type FeishuConfig } from "../src/channels/adapters/feishu/index.ts";
import { ChannelOutboxAdapter, createChannelOutboundSink } from "../src/channels/outbox.ts";
import { OutboxService, OUTBOX_EVENT_TYPES } from "../src/outbox/service.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CONFIG: FeishuConfig = {
  appId: "cli_test_app",
  appSecret: "test_app_secret",
  verificationToken: "test_verification_token",
  encryptKey: "test_encrypt_key",
  botOpenId: "ou_bot",
};

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

function clock(startIso = "2026-11-10T00:00:00.000Z"): Clock {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

interface Harness {
  dir: string;
  clock: Clock;
  ledger: EventLedger;
  sessions: SessionManager;
  server: ChannelTestServer;
  adapter: FeishuChannelAdapter;
  registry: ChannelRegistry;
  outbox: OutboxService;
  dispose(): Promise<void>;
}

async function setup(
  options: {
    server?: ConstructorParameters<typeof ChannelTestServer>[0];
    adapter?: Partial<ConstructorParameters<typeof FeishuChannelAdapter>[0]>;
    outboxSendTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const dir = tmpDir("morrow-feishu-e2e-");
  const c = clock();
  const ledger = EventLedger.open(dir);
  const sessions = new SessionManager({
    ledger,
    replicaId: REPLICA,
    factory: async () =>
      createFakePi({ script: [{ kind: "text", deltas: ["assistant ", "reply"] }] }),
  });
  const server = new ChannelTestServer({
    appId: CONFIG.appId,
    appSecret: CONFIG.appSecret,
    verificationToken: CONFIG.verificationToken,
    encryptKey: CONFIG.encryptKey,
    botOpenId: CONFIG.botOpenId,
    now: c.now,
    ...options.server,
  });
  await server.start();

  const outbox = new OutboxService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    now: c.now,
    backoffBaseMs: 1_000,
    backoffMaxMs: 4_000,
    ...(options.outboxSendTimeoutMs === undefined ? {} : { sendTimeoutMs: options.outboxSendTimeoutMs }),
  });
  const registry = new ChannelRegistry({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    sessions,
    enableEcho: false,
    outboundSink: createChannelOutboundSink(outbox),
    now: c.now,
  });
  const adapter = new FeishuChannelAdapter({
    accountId: "feishu-default",
    config: CONFIG,
    baseUrl: server.baseUrl,
    now: c.now,
    requestTimeoutMs: 150,
    eventPollTimeoutMs: 20,
    eventReconnectDelayMs: 5,
    ...options.adapter,
  });
  registry.registerAdapter(adapter);
  registry.registerAccount({
    account_id: "feishu-default",
    channel_id: "feishu",
    native_account_id: CONFIG.appId,
    display_name: "Morrow Feishu bot",
    owner_native_ids: ["ou_owner"],
  });
  outbox.setAdapter(new ChannelOutboxAdapter({ adapterFor: (channelId) => registry.getAdapter(channelId) }));
  await registry.start();

  return {
    dir,
    clock: c,
    ledger,
    sessions,
    server,
    adapter,
    registry,
    outbox,
    async dispose() {
      await registry.stop();
      registry.close();
      outbox.close();
      await sessions.dispose();
      ledger.close();
      await server.stop();
      removeDir(dir);
    },
  };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test("端到端：飞书事件 → 入站路由 → 会话 → Outbox → reply API → 审计可查", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  h.server.pushMessage({ messageId: "om_in_1", chatId: "oc_dm_1", text: "你好，帮我记一下" });

  await waitFor("channel.inbound_received", () => h.ledger.scan({ eventType: "channel.inbound_received" }).length === 1);
  await waitFor("outbox queued", () => h.outbox.list({}).total === 1);

  const queued = h.outbox.list({}).messages[0];
  assert.equal(queued.status, "pending");
  assert.equal(queued.channel_id, "feishu");
  assert.equal(queued.account_id, "feishu-default");
  assert.deepEqual(queued.target, { kind: "conversation", id: "oc_dm_1" });
  assert.equal(queued.payload.text, "assistant reply");
  assert.equal(queued.payload.reply_to_native_message_id, "om_in_1");
  assert.equal(queued.idempotency_key, "channel:feishu:om_in_1:assistant");

  const summary = await h.outbox.dispatchOnce();
  assert.equal(summary.sent, 1);
  assert.equal(summary.attempted, 1);

  assert.equal(h.server.replies.length, 1);
  assert.equal(h.server.replies[0].native_message_id, "om_in_1");
  const replyBody = h.server.replies[0].body as Record<string, unknown>;
  assert.deepEqual(JSON.parse(String(replyBody.content)), { text: "assistant reply" });

  const sent = h.outbox.get(queued.id);
  assert.equal(sent?.status, "sent");
  assert.match(sent?.receipt?.platform_message_id ?? "", /^om_reply_/);

  // 审计链：inbound → outbound.queued → outbound.sent
  const eventTypes = h.ledger.list({ limit: 200 }).events.map((event) => event.event_type);
  assert.ok(eventTypes.includes("channel.inbound_received"));
  const outboundEvents = eventTypes.filter((type) => type.startsWith("outbound."));
  assert.deepEqual(outboundEvents, [OUTBOX_EVENT_TYPES.queued, OUTBOX_EVENT_TYPES.sent]);
  const sentEvent = h.ledger
    .list({ limit: 200 })
    .events.find((event) => event.event_type === OUTBOX_EVENT_TYPES.sent);
  assert.equal(sentEvent?.idempotency_key, "channel:feishu:om_in_1:assistant");
  assert.equal(sentEvent?.receipt?.channel, "feishu");

  // 原始平台记录 + 会话回复都在
  const received = h.ledger.scan({ eventType: "channel.inbound_received" })[0];
  const conversationId = String(received.envelope.payload.conversation_id);
  const records = h.registry.listMessages(conversationId);
  assert.equal(records.filter((record) => record.direction === "inbound").length, 1);
  assert.equal(records.filter((record) => record.direction === "outbound").length, 1);
  const history = h.sessions.history(String(received.envelope.session_id));
  assert.deepEqual(
    history.messages.map((message) => [message.role, message.text]),
    [
      ["user", "你好，帮我记一下"],
      ["assistant", "assistant reply"],
    ],
  );

  // 再 dispatch 不会重复发送
  const again = await h.outbox.dispatchOnce();
  assert.equal(again.attempted, 0);
  assert.equal(h.server.replies.length, 1);
});

test("签名失败：事件被拒并落 channel.inbound_rejected（reason=event_rejected）", async (t) => {
  const h = await setup({ server: { signatureMode: "invalid" } });
  t.after(() => h.dispose());

  h.server.pushMessage({ messageId: "om_bad_1", text: "forged" });
  await waitFor("inbound_rejected", () => h.ledger.scan({ eventType: "channel.inbound_rejected" }).length === 1);
  const rejection = h.ledger.scan({ eventType: "channel.inbound_rejected" })[0];
  assert.equal(rejection.envelope.payload.reason, "event_rejected");
  assert.equal(rejection.envelope.payload.error_code, "signature_invalid");
  assert.equal(h.ledger.scan({ eventType: "channel.inbound_received" }).length, 0);
  assert.equal(h.sessions.listSessions().length, 0);
  assert.equal(h.outbox.list({}).total, 0);
});

test("429：Outbox 退避重试，平台最终只确认一次回复（不重复投递）", async (t) => {
  const h = await setup({ server: { rateLimit: { remaining: 1, retryAfterSeconds: 1 } } });
  t.after(() => h.dispose());

  h.server.pushMessage({ messageId: "om_429", text: "hello" });
  await waitFor("outbox queued", () => h.outbox.list({}).total === 1);

  const first = await h.outbox.dispatchOnce();
  assert.equal(first.failed, 1);
  const row = h.outbox.list({}).messages[0];
  assert.equal(row.status, "failed");
  assert.match(row.last_error ?? "", /rate_limited/);
  assert.equal(row.next_attempt_at, "2026-11-10T00:00:01.000Z");
  assert.equal(h.server.replies.length, 0);

  const tooEarly = await h.outbox.dispatchOnce();
  assert.equal(tooEarly.attempted, 0, "退避未到期不重复投递");

  h.clock.advance(1_000);
  const second = await h.outbox.dispatchOnce();
  assert.equal(second.sent, 1);
  assert.equal(h.server.replies.length, 1, "平台侧只有一次成功确认");
  assert.equal(h.server.count("reply"), 2, "429 一次 + 重试一次");
  assert.equal(h.outbox.get(row.id)?.status, "sent");
});

test("token 过期：Outbox 投递时自动刷新一次后成功", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  h.server.pushMessage({ messageId: "om_token", text: "hello" });
  await waitFor("outbox queued", () => h.outbox.list({}).total === 1);

  // 模拟进程长期运行后 token 在平台侧失效（本地缓存仍认为有效）
  h.server.expireAccessToken();
  const summary = await h.outbox.dispatchOnce();
  assert.equal(summary.sent, 1);
  assert.equal(h.server.count("token"), 2, "缓存 token 被拒后刷新一次");
  assert.equal(h.server.count("reply"), 2, "401 + 刷新后重试");
  assert.equal(h.server.replies.length, 1);
  assert.equal((await h.adapter.health()).healthy, true);
});

test("响应超时：Outbox → delivery_unknown → needs_review，不自动重发", async (t) => {
  const h = await setup({
    server: { replyMode: "hang" },
    adapter: { requestTimeoutMs: 50 },
    outboxSendTimeoutMs: 2_000,
  });
  t.after(() => h.dispose());

  h.server.pushMessage({ messageId: "om_timeout", text: "hello" });
  await waitFor("outbox queued", () => h.outbox.list({}).total === 1);

  const first = await h.outbox.dispatchOnce();
  assert.equal(first.delivery_unknown, 1);
  const row = h.outbox.list({}).messages[0];
  assert.equal(row.status, "needs_review");
  assert.match(row.last_error ?? "", /timeout/);
  assert.equal(h.server.count("reply"), 1, "平台侧恰好收到一次请求");

  h.clock.advance(10 * 60_000);
  const again = await h.outbox.dispatchOnce();
  assert.equal(again.attempted, 0, "未知状态永不自动重发");
  assert.equal(h.server.count("reply"), 1);

  const events = h.ledger.list({ limit: 200 }).events.filter((event) => event.event_type.startsWith("outbound."));
  assert.deepEqual(
    events.map((event) => event.event_type),
    [OUTBOX_EVENT_TYPES.queued, OUTBOX_EVENT_TYPES.deliveryUnknown, OUTBOX_EVENT_TYPES.reviewed],
  );
  assert.equal(events[1].delivery_unknown, true);
});

test("重复投递：同一平台事件两次只产生一轮会话与一次回复", async (t) => {
  const h = await setup({ server: { duplicateEvents: true } });
  t.after(() => h.dispose());

  h.server.pushMessage({ messageId: "om_dup", text: "once" });
  await waitFor("first outbox row", () => h.outbox.list({}).total === 1);
  // 等一下确认第二个重复帧也已被处理（重复消息被路由忽略）
  await waitFor("duplicate ignored", () =>
    h.ledger.scan({ eventType: "channel.inbound_received" }).length === 1,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(h.ledger.scan({ eventType: "channel.inbound_received" }).length, 1);
  assert.equal(h.outbox.list({}).total, 1);
  assert.equal(h.sessions.listSessions().length, 1);
  const sessionId = h.sessions.listSessions()[0].session_id;
  assert.equal(h.sessions.history(sessionId).messages.filter((message) => message.role === "user").length, 1);

  await h.outbox.dispatchOnce();
  assert.equal(h.server.replies.length, 1);
});
