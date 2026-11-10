// QQ 官方 Bot 适配器协议契约测试（M4-T4 / Issue #41）：
// 配置来自 SecretStore；事件 Ed25519 签名校验 → 入站归一化（群 @ / 私聊）；
// 群/私聊消息 API、token 缓存/过期刷新/刷新后仍失败降级；429/权限/主动消息拒绝/超时
// 错误分类；capabilities 如实声明主动消息受限。零真实网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySecretStore } from "../src/keyring.ts";
import { ChannelTestServer } from "../src/channels/testing/channel-test-server.ts";
import { registerQqTestStub, type QqTestStub, type QqTestStubOptions } from "../src/channels/testing/qq-stub.ts";
import {
  QqChannelAdapter,
  QqConfigError,
  QQ_SECRET_SERVICE,
  answerQqValidation,
  loadQqConfig,
  verifyEd25519,
  verifyQqEvent,
  type QqConfig,
} from "../src/channels/adapters/qq/index.ts";
import { ChannelSendError, isParseError } from "../src/channels/types.ts";
import type { InboundMessage } from "@morrow/protocol";

const CONFIG: QqConfig = {
  appId: "qq_test_app",
  appSecret: "qq_test_secret",
  botSecret: "qq_bot_secret",
};

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
}

interface Harness {
  server: ChannelTestServer;
  stub: QqTestStub;
  adapter: QqChannelAdapter;
  inbound: unknown[];
  rejected: Array<{ code: string; message: string }>;
  dispose(): Promise<void>;
}

async function setup(
  options: {
    stub?: QqTestStubOptions;
    adapter?: Partial<ConstructorParameters<typeof QqChannelAdapter>[0]>;
    start?: boolean;
  } = {},
): Promise<Harness> {
  const server = new ChannelTestServer();
  await server.start();
  const stub = registerQqTestStub(server, {
    appId: CONFIG.appId,
    appSecret: CONFIG.appSecret,
    botSecret: CONFIG.botSecret,
    ...options.stub,
  });
  const inbound: unknown[] = [];
  const rejected: Array<{ code: string; message: string }> = [];
  const adapter = new QqChannelAdapter({
    accountId: "qq-default",
    config: CONFIG,
    apiBaseUrl: server.baseUrl,
    tokenEndpoint: `${server.baseUrl}/app/getAppAccessToken`,
    requestTimeoutMs: 200,
    eventPollTimeoutMs: 20,
    eventReconnectDelayMs: 5,
    ...options.adapter,
  });
  if (options.start !== false) {
    await adapter.start({
      accountId: "qq-default",
      onInbound: (raw) => inbound.push(raw),
      onInboundRejected: (event) => rejected.push({ code: event.code, message: event.message }),
    });
  }
  return {
    server,
    stub,
    adapter,
    inbound,
    rejected,
    async dispose() {
      await adapter.stop();
      await server.stop();
    },
  };
}

function groupOutbound(overrides: Record<string, unknown> = {}) {
  return {
    channel: "qq",
    account: "qq-default",
    native_conversation_id: "qq_group_1",
    text: "agent reply",
    idempotency_key: "channel:qq:qq_in_1:assistant",
    ...overrides,
  };
}

test("loadQqConfig: 从 SecretStore 的 channel:qq:* 读取，缺字段一次列全", async () => {
  const store = createInMemorySecretStore();
  await store.setSecret(QQ_SECRET_SERVICE, "app_id", "qq_app");
  await store.setSecret(QQ_SECRET_SERVICE, "app_secret", "qq_secret");
  await store.setSecret(QQ_SECRET_SERVICE, "bot_secret", "qq_bot");
  await store.setSecret(QQ_SECRET_SERVICE, "token_endpoint", "https://internal.example/token");

  assert.deepEqual(await loadQqConfig(store), {
    appId: "qq_app",
    appSecret: "qq_secret",
    botSecret: "qq_bot",
    tokenEndpoint: "https://internal.example/token",
  });

  const empty = createInMemorySecretStore();
  await empty.setSecret(QQ_SECRET_SERVICE, "app_id", "qq_app");
  await assert.rejects(
    () => loadQqConfig(empty),
    (err: unknown) => err instanceof QqConfigError && err.missing.join(",") === "app_secret",
  );
  await assert.rejects(
    () => loadQqConfig(empty, { requireBotSecret: true }),
    (err: unknown) => err instanceof QqConfigError && err.missing.join(",") === "app_secret,bot_secret",
  );
});

test("parseInbound: 群 @ 消息 → InboundMessage（mention/时间/附件），私聊 kind=direct", async (t) => {
  const h = await setup({ start: false });
  t.after(() => h.dispose());

  const groupEvent = h.stub.buildMessageEvent({
    type: "group",
    messageId: "qq_group_in_1",
    conversationId: "qq_group_1",
    senderId: "qq_owner",
    text: "帮我查下天气",
    timestamp: "2026-11-10T00:00:00.000Z",
  });
  const parsed = h.adapter.parseInbound(groupEvent);
  assert.equal(isParseError(parsed), false);
  const inbound = parsed as InboundMessage;
  assert.equal(inbound.channel, "qq");
  assert.equal(inbound.account, "qq-default");
  assert.equal(inbound.native_message_id, "qq_group_in_1");
  assert.equal(inbound.native_conversation_id, "qq_group_1");
  assert.equal(inbound.conversation_kind, "group");
  assert.deepEqual(inbound.sender, { native_id: "qq_owner" });
  assert.equal(inbound.mention.agent, true);
  assert.deepEqual(inbound.mention.native_ids, [CONFIG.appId]);
  assert.equal(inbound.text, "帮我查下天气");
  assert.equal(inbound.timestamp, "2026-11-10T00:00:00.000Z");
  assert.equal(inbound.permission_context, null);

  const imageEvent = h.stub.buildMessageEvent({
    type: "direct",
    messageId: "qq_dm_img_1",
    senderId: "qq_owner",
    text: "",
    attachments: [{ url: "https://cdn.example/img.png", contentType: "image/png", filename: "x.png", size: 128 }],
  });
  const imageInbound = h.adapter.parseInbound(imageEvent) as InboundMessage;
  assert.equal(imageInbound.conversation_kind, "direct");
  assert.equal(imageInbound.mention.agent, false);
  assert.deepEqual(imageInbound.attachments, [
    {
      native_id: "https://cdn.example/img.png",
      url: "https://cdn.example/img.png",
      kind: "image",
      name: "x.png",
      mime_type: "image/png",
      size_bytes: 128,
    },
  ]);
  assert.equal(imageInbound.text, "");

  assert.deepEqual(h.adapter.parseInbound({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: {} }), {
    ok: false,
    code: "invalid_inbound",
    message: "event.d.id must be a non-empty string",
  });
});

test("事件签名：Ed25519 有效帧进入 onInbound；坏签名/缺头/过期时间被拒并留痕", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  assert.equal(h.inbound.length, 0);
  h.stub.pushMessage({ type: "group", messageId: "qq_in_ok", text: "hello" });
  await waitFor("inbound event", () => h.inbound.length === 1);
  const delivered = h.inbound[0] as Record<string, unknown>;
  assert.equal(delivered.t, "GROUP_AT_MESSAGE_CREATE");
  assert.equal(h.rejected.length, 0);

  h.stub.signatureMode = "invalid";
  h.stub.pushMessage({ type: "group", messageId: "qq_in_bad", text: "tampered" });
  await waitFor("rejected event", () => h.rejected.length === 1);
  assert.equal(h.rejected[0].code, "signature_invalid");
  assert.equal(h.inbound.length, 1, "签名失败的事件绝不进入会话链路");

  h.stub.signatureMode = "missing";
  h.stub.pushMessage({ type: "direct", messageId: "qq_in_missing", text: "no signature" });
  await waitFor("missing signature", () => h.rejected.length === 2);
  assert.equal(h.rejected[1].code, "signature_missing");
  assert.equal(h.inbound.length, 1);

  const event = h.stub.buildMessageEvent({ messageId: "qq_stale" });
  h.stub.signatureMode = "valid";
  const frame = h.stub.buildEventFrame(event);
  const stale = verifyQqEvent(
    { body: frame.body, headers: { ...frame.headers, "x-signature-timestamp": "0" } },
    CONFIG,
  );
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.code, "timestamp_stale");
});

test("回调校验 op 13：返回 plain_token + Ed25519(event_ts + plain_token) 签名", () => {
  const event = { op: 13, d: { plain_token: "plain-token-1", event_ts: "1725442341" } };
  const answer = answerQqValidation(event, CONFIG.botSecret as string);
  assert.ok(answer !== null);
  if (answer === null) return;
  assert.equal(answer.plain_token, "plain-token-1");
  assert.match(answer.signature, /^[0-9a-f]{128}$/);
  assert.equal(
    verifyEd25519(CONFIG.botSecret as string, "1725442341plain-token-1", answer.signature),
    true,
  );
});

test("send: 群/私聊走各自 API，头部 QQBot token；被动回复带 msg_id + 递增 msg_seq", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  // start 已预热 token（1 次）
  assert.equal(h.stub.count("token"), 1);

  // 先经入站学习会话形态（生产路径：群消息事件 → group / C2C 事件 → direct）
  h.adapter.parseInbound(h.stub.buildMessageEvent({ type: "group", conversationId: "qq_group_1" }));
  h.adapter.parseInbound(h.stub.buildMessageEvent({ type: "direct", senderId: "qq_user_1" }));

  const groupReceipt = await h.adapter.send(
    groupOutbound({ reply_to_native_message_id: "qq_in_1" }),
  );
  assert.equal(groupReceipt.channel, "qq");
  assert.match(groupReceipt.remote_message_id ?? "", /^qq_group_msg_/);

  const groupRequest = h.server.lastRequest("custom");
  assert.ok(groupRequest !== null);
  assert.equal(groupRequest.path, "/v2/groups/qq_group_1/messages");
  assert.equal(groupRequest.headers.authorization, "QQBot qq-token-1");
  const groupBody = groupRequest.body as Record<string, unknown>;
  assert.equal(groupBody.content, "agent reply");
  assert.equal(groupBody.msg_type, 0);
  assert.equal(groupBody.msg_id, "qq_in_1");
  assert.equal(groupBody.msg_seq, 1);

  // 同一入站消息的第二次回复用递增 msg_seq（QQ 以 msg_id+msg_seq 判重）
  await h.adapter.send(groupOutbound({ reply_to_native_message_id: "qq_in_1", text: "second" }));
  assert.equal((h.server.lastRequest("custom")?.body as Record<string, unknown>).msg_seq, 2);

  const directReceipt = await h.adapter.send(
    groupOutbound({
      native_conversation_id: "qq_user_1",
      reply_to_native_message_id: "qq_dm_in_1",
    }),
  );
  assert.match(directReceipt.remote_message_id ?? "", /^qq_direct_msg_/);
  const directRequest = h.server.lastRequest("custom");
  assert.equal(directRequest?.path, "/v2/users/qq_user_1/messages");

  assert.equal(h.stub.count("group"), 2);
  assert.equal(h.stub.count("direct"), 1);
  assert.equal(h.stub.count("token"), 1, "token 未过期时复用缓存");
});

test("token 过期：自动刷新一次后重试成功；刷新后仍被拒 → 健康降级", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());
  h.adapter.parseInbound(h.stub.buildMessageEvent({ type: "group", conversationId: "qq_group_1" }));

  h.stub.expireAccessToken();
  const receipt = await h.adapter.send(groupOutbound({ reply_to_native_message_id: "qq_in_1" }));
  assert.match(receipt.remote_message_id ?? "", /^qq_group_msg_/);
  assert.equal(h.stub.count("token"), 2, "过期后强制刷新一次");
  assert.equal(h.stub.count("group"), 2, "首次 401 + 刷新后重试");
  assert.equal(h.stub.groupMessages.length, 1, "平台只确认一次回复");
  assert.equal((await h.adapter.health()).healthy, true);

  h.stub.rejectAllTokens = true;
  await assert.rejects(
    () => h.adapter.send(groupOutbound({ reply_to_native_message_id: "qq_in_2" })),
    (err: unknown) => err instanceof ChannelSendError && err.kind === "explicit",
  );
  const health = await h.adapter.health();
  assert.equal(health.healthy, false);
  assert.equal(health.connection, "degraded");
  assert.match(health.last_error ?? "", /token/i);
});

test("429 限流：显式可重试错误（带 Retry-After），不当作未知送达；重试后成功", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());
  h.adapter.parseInbound(h.stub.buildMessageEvent({ type: "group", conversationId: "qq_group_1" }));
  h.stub.rateLimit = { remaining: 1, retryAfterSeconds: 2 };

  await assert.rejects(
    () => h.adapter.send(groupOutbound({ reply_to_native_message_id: "qq_in_1" })),
    (err: unknown) =>
      err instanceof ChannelSendError &&
      err.kind === "explicit" &&
      err.code === "rate_limited" &&
      err.retryable === true &&
      err.retry_after_seconds === 2,
  );
  assert.equal(h.stub.groupMessages.length, 0);

  const receipt = await h.adapter.send(groupOutbound({ reply_to_native_message_id: "qq_in_1" }));
  assert.match(receipt.remote_message_id ?? "", /^qq_group_msg_/);
  assert.equal(h.stub.count("group"), 2);
  assert.equal(h.stub.groupMessages.length, 1);
});

test("主动消息：平台拒绝 → proactive_rejected（explicit 且不可重试）；capabilities 如实受限", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());
  h.adapter.parseInbound(h.stub.buildMessageEvent({ type: "group", conversationId: "qq_group_1" }));
  h.stub.rejectProactive = true;

  const caps = h.adapter.capabilities();
  assert.deepEqual(caps, {
    direct_message: "supported",
    group_mention: "supported",
    group_proactive: "limited",
    attachments: "limited",
    edit: "unsupported",
  });

  await assert.rejects(
    () => h.adapter.send(groupOutbound({ reply_to_native_message_id: undefined })),
    (err: unknown) =>
      err instanceof ChannelSendError &&
      err.kind === "explicit" &&
      err.code === "proactive_rejected" &&
      err.retryable === false,
  );
  assert.equal(h.stub.count("group"), 1);
  assert.equal(h.stub.groupMessages.length, 0);
  assert.equal(h.stub.rejectedProactive.length, 1);
  assert.equal(h.stub.rejectedProactive[0].code, 304046);
});

test("权限不足 / 超时 / 未知会话形态：分类正确且不猜测目标", async (t) => {
  const h = await setup({ adapter: { requestTimeoutMs: 50 } });
  t.after(() => h.dispose());
  h.adapter.parseInbound(h.stub.buildMessageEvent({ type: "group", conversationId: "qq_group_1" }));

  h.stub.mode = "forbidden";
  await assert.rejects(
    () => h.adapter.send(groupOutbound({ reply_to_native_message_id: "qq_in_1" })),
    (err: unknown) =>
      err instanceof ChannelSendError && err.kind === "explicit" && err.code === "permission_denied",
  );

  h.stub.mode = "hang";
  await assert.rejects(
    () => h.adapter.send(groupOutbound({ reply_to_native_message_id: "qq_in_timeout" })),
    (err: unknown) => err instanceof ChannelSendError && err.kind === "timeout",
  );

  h.stub.mode = "ok";
  await assert.rejects(
    () => h.adapter.send(groupOutbound({ native_conversation_id: "qq_never_seen" })),
    (err: unknown) =>
      err instanceof ChannelSendError &&
      err.kind === "explicit" &&
      err.code === "unknown_conversation" &&
      err.retryable === false,
  );
  assert.equal(h.server.count("custom"), 2, "未知形态不发出任何请求");
});

test("health：连接状态、token 到期时间与最近错误可诊断", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const healthy = await h.adapter.health();
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.connection, "connected");
  assert.match(healthy.token_expires_at ?? "", /Z$/);
  assert.equal(healthy.last_error, null);

  h.adapter.parseInbound(h.stub.buildMessageEvent({ type: "group", conversationId: "qq_group_1" }));
  h.stub.mode = "forbidden";
  await assert.rejects(() => h.adapter.send(groupOutbound({ reply_to_native_message_id: "qq_in_1" })));
  const unhealthy = await h.adapter.health();
  assert.equal(unhealthy.healthy, true, "单次显式失败不降级，仅记录最近错误");
  assert.match(unhealthy.last_error ?? "", /permission_denied/);
});
