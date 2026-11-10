// QQ 端到端协议闭环（M4-T4 / Issue #41，AC-09/AC-10 协议层）：
// 事件 → Ed25519 签名 → T1 统一入站路由 → 会话 → 回复入 Outbox →
// dispatchOnce 经 QQ 群/私聊消息 API → 协议桩收到 → outbound.* 审计可查。
// 另覆盖：签名失败留痕、主动消息被拒（不重试 + 审计）、超时 → delivery_unknown。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import { EventLedger } from "../src/ledger.ts";
import { SessionManager } from "../src/sessions.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { ChannelTestServer } from "../src/channels/testing/channel-test-server.ts";
import { registerQqTestStub, type QqTestStub, type QqTestStubOptions } from "../src/channels/testing/qq-stub.ts";
import { QqChannelAdapter, type QqConfig } from "../src/channels/adapters/qq/index.ts";
import { ChannelOutboxAdapter, createChannelOutboundSink } from "../src/channels/outbox.ts";
import { OutboxService, OUTBOX_EVENT_TYPES } from "../src/outbox/service.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CONFIG: QqConfig = {
  appId: "qq_test_app",
  appSecret: "qq_test_secret",
  botSecret: "qq_bot_secret",
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
  stub: QqTestStub;
  adapter: QqChannelAdapter;
  registry: ChannelRegistry;
  outbox: OutboxService;
  dispose(): Promise<void>;
}

async function setup(
  options: {
    stub?: QqTestStubOptions;
    adapter?: Partial<ConstructorParameters<typeof QqChannelAdapter>[0]>;
    outboxSendTimeoutMs?: number;
    allowGroups?: boolean;
  } = {},
): Promise<Harness> {
  const dir = tmpDir("morrow-qq-e2e-");
  const c = clock();
  const ledger = EventLedger.open(dir);
  const sessions = new SessionManager({
    ledger,
    replicaId: REPLICA,
    factory: async () =>
      createFakePi({ script: [{ kind: "text", deltas: ["assistant ", "reply"] }] }),
  });
  const server = new ChannelTestServer({ now: c.now });
  await server.start();
  const stub = registerQqTestStub(server, {
    appId: CONFIG.appId,
    appSecret: CONFIG.appSecret,
    botSecret: CONFIG.botSecret,
    now: c.now,
    ...options.stub,
  });

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
  const adapter = new QqChannelAdapter({
    accountId: "qq-default",
    config: CONFIG,
    apiBaseUrl: server.baseUrl,
    tokenEndpoint: `${server.baseUrl}/app/getAppAccessToken`,
    now: c.now,
    requestTimeoutMs: 150,
    eventPollTimeoutMs: 20,
    eventReconnectDelayMs: 5,
    ...options.adapter,
  });
  registry.registerAdapter(adapter);
  registry.registerAccount({
    account_id: "qq-default",
    channel_id: "qq",
    native_account_id: CONFIG.appId,
    display_name: "Morrow QQ bot",
    owner_native_ids: ["qq_owner"],
  });
  if (options.allowGroups !== false) {
    registry.allowConversation({
      account_id: "qq-default",
      native_conversation_id: "qq_group_1",
      mode: "mention_only",
    });
  }
  outbox.setAdapter(new ChannelOutboxAdapter({ adapterFor: (channelId) => registry.getAdapter(channelId) }));
  await registry.start();

  return {
    dir,
    clock: c,
    ledger,
    sessions,
    server,
    stub,
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

test("端到端（群 @）：QQ 事件 → 入站路由 → 会话 → Outbox → 群消息 API → 审计", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  h.stub.pushMessage({
    type: "group",
    messageId: "qq_in_1",
    conversationId: "qq_group_1",
    senderId: "qq_owner",
    text: "群里帮我记一下",
  });

  await waitFor("channel.inbound_received", () => h.ledger.scan({ eventType: "channel.inbound_received" }).length === 1);
  await waitFor("outbox queued", () => h.outbox.list({}).total === 1);

  const queued = h.outbox.list({}).messages[0];
  assert.equal(queued.status, "pending");
  assert.equal(queued.channel_id, "qq");
  assert.equal(queued.account_id, "qq-default");
  assert.deepEqual(queued.target, { kind: "conversation", id: "qq_group_1" });
  assert.equal(queued.payload.text, "assistant reply");
  assert.equal(queued.payload.reply_to_native_message_id, "qq_in_1");
  assert.equal(queued.idempotency_key, "channel:qq:qq_in_1:assistant");

  const summary = await h.outbox.dispatchOnce();
  assert.equal(summary.sent, 1);
  assert.equal(summary.attempted, 1);

  assert.equal(h.stub.groupMessages.length, 1);
  const sentRecord = h.stub.groupMessages[0];
  assert.equal(sentRecord.conversation_id, "qq_group_1");
  assert.equal(sentRecord.msg_id, "qq_in_1", "被动回复必须引用原消息");
  assert.equal(sentRecord.msg_seq, 1);
  assert.equal(sentRecord.proactive, false);
  const body = sentRecord.body as Record<string, unknown>;
  assert.equal(body.content, "assistant reply");
  assert.equal(body.msg_type, 0);

  const sent = h.outbox.get(queued.id);
  assert.equal(sent?.status, "sent");
  assert.match(sent?.receipt?.platform_message_id ?? "", /^qq_group_msg_/);

  // 审计链：inbound → outbound.queued → outbound.sent
  const eventTypes = h.ledger.list({ limit: 200 }).events.map((event) => event.event_type);
  assert.ok(eventTypes.includes("channel.inbound_received"));
  const outboundEvents = eventTypes.filter((type) => type.startsWith("outbound."));
  assert.deepEqual(outboundEvents, [OUTBOX_EVENT_TYPES.queued, OUTBOX_EVENT_TYPES.sent]);
  const sentEvent = h.ledger
    .list({ limit: 200 })
    .events.find((event) => event.event_type === OUTBOX_EVENT_TYPES.sent);
  assert.equal(sentEvent?.idempotency_key, "channel:qq:qq_in_1:assistant");
  assert.equal(sentEvent?.receipt?.channel, "qq");

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
      ["user", "群里帮我记一下"],
      ["assistant", "assistant reply"],
    ],
  );

  // 再 dispatch 不会重复发送
  const again = await h.outbox.dispatchOnce();
  assert.equal(again.attempted, 0);
  assert.equal(h.stub.groupMessages.length, 1);
});

test("端到端（私聊）：C2C 事件 → 入站 → Outbox → 单聊消息 API", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  h.stub.pushMessage({
    type: "direct",
    messageId: "qq_dm_1",
    senderId: "qq_owner",
    text: "私聊你好",
  });

  await waitFor("outbox queued", () => h.outbox.list({}).total === 1);
  const summary = await h.outbox.dispatchOnce();
  assert.equal(summary.sent, 1);

  assert.equal(h.stub.c2cMessages.length, 1);
  assert.equal(h.stub.groupMessages.length, 0);
  const record = h.stub.c2cMessages[0];
  assert.equal(record.conversation_id, "qq_owner");
  assert.equal(record.msg_id, "qq_dm_1");

  const request = h.server.lastRequest("custom");
  assert.equal(request?.path, "/v2/users/qq_owner/messages");
  assert.equal(request?.headers.authorization, "QQBot qq-token-1");
});

test("签名失败：事件被拒并落 channel.inbound_rejected（reason=event_rejected）", async (t) => {
  const h = await setup({ stub: { botSecret: CONFIG.botSecret } });
  t.after(() => h.dispose());

  h.stub.signatureMode = "invalid";
  h.stub.pushMessage({ type: "group", messageId: "qq_bad_1", text: "forged" });
  await waitFor("inbound_rejected", () => h.ledger.scan({ eventType: "channel.inbound_rejected" }).length === 1);
  const rejection = h.ledger.scan({ eventType: "channel.inbound_rejected" })[0];
  assert.equal(rejection.envelope.payload.reason, "event_rejected");
  assert.equal(rejection.envelope.payload.error_code, "signature_invalid");
  assert.equal(h.ledger.scan({ eventType: "channel.inbound_received" }).length, 0);
  assert.equal(h.sessions.listSessions().length, 0);
  assert.equal(h.outbox.list({}).total, 0);
});

test("主动消息被拒：proactive_rejected → 审计 + 不自动重试（needs_review）", async (t) => {
  const h = await setup({ adapter: { conversationKinds: { qq_group_1: "group" } } });
  t.after(() => h.dispose());

  h.stub.rejectProactive = true;
  const row = h.outbox.enqueue({
    idempotencyKey: "qq:proactive:notify-1",
    channelId: "qq",
    accountId: "qq-default",
    target: { kind: "conversation", id: "qq_group_1" },
    payload: { text: "主动提醒（平台限制）" },
  });

  const first = await h.outbox.dispatchOnce();
  assert.equal(first.needs_review, 1);
  const record = h.outbox.get(row.id);
  assert.equal(record?.status, "needs_review");
  assert.match(record?.last_error ?? "", /proactive_rejected/);
  assert.equal(h.stub.groupMessages.length, 0);
  assert.equal(h.stub.count("group"), 1);
  assert.equal(h.stub.rejectedProactive.length, 1);
  assert.equal(h.stub.rejectedProactive[0].code, 304046);

  // 审计：queued → failed(will_retry=false) → reviewed(non_retryable_rejection)
  const events = h.ledger
    .list({ limit: 200 })
    .events.filter((event) => event.event_type.startsWith("outbound."));
  assert.deepEqual(
    events.map((event) => event.event_type),
    [OUTBOX_EVENT_TYPES.queued, OUTBOX_EVENT_TYPES.failed, OUTBOX_EVENT_TYPES.reviewed],
  );
  assert.equal(events[1].payload.will_retry, false);
  assert.equal(events[1].payload.retryable, false);
  assert.equal(events[2].payload.review_reason, "non_retryable_rejection");
  assert.match(String(events[1].payload.error), /proactive_rejected/);

  // 时间推进后也不会自动重发
  h.clock.advance(10 * 60_000);
  const again = await h.outbox.dispatchOnce();
  assert.equal(again.attempted, 0);
  assert.equal(h.stub.count("group"), 1);
});

test("响应超时：Outbox → delivery_unknown → needs_review，不自动重发", async (t) => {
  const h = await setup({
    stub: { botSecret: CONFIG.botSecret },
    adapter: { requestTimeoutMs: 50 },
    outboxSendTimeoutMs: 2_000,
  });
  t.after(() => h.dispose());

  h.stub.pushMessage({ type: "group", messageId: "qq_in_timeout", senderId: "qq_owner", text: "hello" });
  await waitFor("outbox queued", () => h.outbox.list({}).total === 1);
  h.stub.mode = "hang";

  const first = await h.outbox.dispatchOnce();
  assert.equal(first.delivery_unknown, 1);
  const row = h.outbox.list({}).messages[0];
  assert.equal(row.status, "needs_review");
  assert.match(row.last_error ?? "", /timeout/);
  assert.equal(h.stub.count("group"), 1, "平台侧恰好收到一次请求");

  h.clock.advance(10 * 60_000);
  const again = await h.outbox.dispatchOnce();
  assert.equal(again.attempted, 0, "未知状态永不自动重发");
  assert.equal(h.stub.count("group"), 1);

  const events = h.ledger
    .list({ limit: 200 })
    .events.filter((event) => event.event_type.startsWith("outbound."));
  assert.deepEqual(
    events.map((event) => event.event_type),
    [OUTBOX_EVENT_TYPES.queued, OUTBOX_EVENT_TYPES.deliveryUnknown, OUTBOX_EVENT_TYPES.reviewed],
  );
  assert.equal(events[1].delivery_unknown, true);
});
