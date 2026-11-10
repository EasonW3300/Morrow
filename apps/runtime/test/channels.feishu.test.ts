// 飞书 Bot 适配器协议契约测试（M4-T3 / Issue #40）：
// 配置来自 SecretStore；事件长连接 → 签名/解密 → 入站归一化；reply/主动消息 API；
// token 缓存/过期刷新/刷新后仍失败降级；429/权限/超时错误分类。零真实网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySecretStore } from "../src/keyring.ts";
import { ChannelTestServer, signFeishuEvent } from "../src/channels/testing/channel-test-server.ts";
import {
  FeishuChannelAdapter,
  FeishuConfigError,
  loadFeishuConfig,
  FEISHU_SECRET_SERVICE,
} from "../src/channels/adapters/feishu/index.ts";
import { ChannelSendError, isParseError } from "../src/channels/types.ts";
import type { FeishuConfig } from "../src/channels/adapters/feishu/index.ts";
import type { InboundMessage } from "@morrow/protocol";

const CONFIG: FeishuConfig = {
  appId: "cli_test_app",
  appSecret: "test_app_secret",
  verificationToken: "test_verification_token",
  encryptKey: "test_encrypt_key",
  botOpenId: "ou_bot",
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
  adapter: FeishuChannelAdapter;
  inbound: unknown[];
  rejected: Array<{ code: string; message: string }>;
  dispose(): Promise<void>;
}

async function setup(
  options: {
    server?: ConstructorParameters<typeof ChannelTestServer>[0];
    adapter?: Partial<ConstructorParameters<typeof FeishuChannelAdapter>[0]>;
    start?: boolean;
  } = {},
): Promise<Harness> {
  const server = new ChannelTestServer({
    appId: CONFIG.appId,
    appSecret: CONFIG.appSecret,
    verificationToken: CONFIG.verificationToken,
    encryptKey: CONFIG.encryptKey,
    botOpenId: CONFIG.botOpenId,
    ...options.server,
  });
  await server.start();
  const inbound: unknown[] = [];
  const rejected: Array<{ code: string; message: string }> = [];
  const adapter = new FeishuChannelAdapter({
    accountId: "feishu-default",
    config: CONFIG,
    baseUrl: server.baseUrl,
    requestTimeoutMs: 200,
    eventPollTimeoutMs: 20,
    eventReconnectDelayMs: 5,
    ...options.adapter,
  });
  if (options.start !== false) {
    await adapter.start({
      accountId: "feishu-default",
      onInbound: (raw) => inbound.push(raw),
      onInboundRejected: (event) => rejected.push({ code: event.code, message: event.message }),
    });
  }
  return {
    server,
    adapter,
    inbound,
    rejected,
    async dispose() {
      await adapter.stop();
      await server.stop();
    },
  };
}

function replyOutbound(overrides: Record<string, unknown> = {}) {
  return {
    channel: "feishu",
    account: "feishu-default",
    native_conversation_id: "oc_group_1",
    text: "agent reply",
    reply_to_native_message_id: "om_in_1",
    idempotency_key: "channel:feishu:om_in_1:assistant",
    ...overrides,
  };
}

test("loadFeishuConfig: 从 SecretStore 的 channel:feishu:* 读取，缺字段一次列全", async () => {
  const store = createInMemorySecretStore();
  await store.setSecret(FEISHU_SECRET_SERVICE, "app_id", "cli_x");
  await store.setSecret(FEISHU_SECRET_SERVICE, "app_secret", "secret_x");
  await store.setSecret(FEISHU_SECRET_SERVICE, "verification_token", "verify_x");
  await store.setSecret(FEISHU_SECRET_SERVICE, "encrypt_key", "encrypt_x");
  await store.setSecret(FEISHU_SECRET_SERVICE, "bot_open_id", "ou_bot_x");

  assert.deepEqual(await loadFeishuConfig(store), {
    appId: "cli_x",
    appSecret: "secret_x",
    verificationToken: "verify_x",
    encryptKey: "encrypt_x",
    botOpenId: "ou_bot_x",
  });

  const empty = createInMemorySecretStore();
  await empty.setSecret(FEISHU_SECRET_SERVICE, "app_id", "cli_x");
  await assert.rejects(
    () => loadFeishuConfig(empty),
    (err: unknown) =>
      err instanceof FeishuConfigError &&
      err.missing.join(",") === "app_secret,verification_token,encrypt_key",
  );
});

test("parseInbound: 群消息 → InboundMessage（mention/时间/附件引用），私聊 kind=direct", async (t) => {
  const h = await setup({ start: false });
  t.after(() => h.dispose());

  const groupEvent = h.server.buildMessageEvent({
    messageId: "om_group_1",
    chatId: "oc_group_1",
    chatType: "group",
    senderOpenId: "ou_owner",
    text: "@_user_1 帮我查下天气",
    mentionBot: true,
    createTime: "1762500000000",
  });
  const parsed = h.adapter.parseInbound(groupEvent);
  assert.equal(isParseError(parsed), false);
  const inbound = parsed as InboundMessage;
  assert.equal(inbound.channel, "feishu");
  assert.equal(inbound.account, "feishu-default");
  assert.equal(inbound.native_message_id, "om_group_1");
  assert.equal(inbound.native_conversation_id, "oc_group_1");
  assert.equal(inbound.conversation_kind, "group");
  assert.deepEqual(inbound.sender, { native_id: "ou_owner" });
  assert.equal(inbound.mention.agent, true);
  assert.deepEqual(inbound.mention.native_ids, ["ou_bot"]);
  assert.equal(inbound.text, "帮我查下天气");
  assert.equal(inbound.timestamp, new Date(1762500000000).toISOString());
  assert.equal(inbound.permission_context, null);

  const imageEvent = h.server.buildMessageEvent({
    messageId: "om_img_1",
    chatId: "oc_dm_1",
    chatType: "p2p",
    senderOpenId: "ou_owner",
    text: "",
    attachments: [{ kind: "image", nativeId: "img_key_1" }],
  });
  const imageInbound = h.adapter.parseInbound(imageEvent) as InboundMessage;
  assert.equal(imageInbound.conversation_kind, "direct");
  assert.equal(imageInbound.mention.agent, false);
  assert.deepEqual(imageInbound.attachments, [{ native_id: "img_key_1", kind: "image" }]);
  assert.equal(imageInbound.text, "");

  const fileEvent = h.server.buildMessageEvent({
    messageId: "om_file_1",
    chatId: "oc_dm_1",
    chatType: "p2p",
    senderOpenId: "ou_owner",
    attachments: [{ kind: "file", nativeId: "file_key_1", name: "report.pdf" }],
  });
  const fileInbound = h.adapter.parseInbound(fileEvent) as InboundMessage;
  assert.deepEqual(fileInbound.attachments, [
    { native_id: "file_key_1", kind: "file", name: "report.pdf" },
  ]);
});

test("事件长连接：加密帧经签名/解密后交给 onInbound；签名失败经 onInboundRejected 留痕", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  assert.equal(h.inbound.length, 0);
  h.server.pushMessage({ messageId: "om_in_1", text: "hello", chatId: "oc_dm_1" });
  await waitFor("inbound event", () => h.inbound.length === 1);
  const delivered = h.inbound[0] as Record<string, unknown>;
  const header = delivered.header as Record<string, unknown>;
  assert.equal(header.event_type, "im.message.receive_v1");
  assert.equal(h.rejected.length, 0);

  h.server.signatureMode = "invalid";
  h.server.pushMessage({ messageId: "om_in_2", text: "tampered" });
  await waitFor("rejected event", () => h.rejected.length === 1);
  assert.equal(h.rejected[0].code, "signature_invalid");
  assert.equal(h.inbound.length, 1, "签名失败的事件绝不进入会话链路");
});

test("解密失败 / Verification Token 不匹配：拒绝并留痕", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "nonce-decrypt";
  const badBody = JSON.stringify({ encrypt: "bm90LWEtY2lwaGVy" });
  const badFrame = {
    body: badBody,
    headers: {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signFeishuEvent(timestamp, nonce, CONFIG.encryptKey, badBody),
    },
  };
  const decrypt = h.adapter.handleFrame(badFrame);
  assert.equal(decrypt.ok, false);
  if (decrypt.ok) return;
  assert.equal(decrypt.code, "decrypt_failed");

  const event = h.server.buildMessageEvent({
    messageId: "om_wrong_token",
    chatId: "oc_dm_1",
    chatType: "p2p",
    senderOpenId: "ou_owner",
    text: "wrong token",
  });
  (event.header as Record<string, unknown>).token = "not_the_configured_token";
  const mismatched = h.adapter.handleFrame(h.server.buildEventFrame(event));
  assert.equal(mismatched.ok, false);
  if (mismatched.ok) return;
  assert.equal(mismatched.code, "token_mismatch");

  assert.deepEqual(
    h.rejected.map((entry) => entry.code),
    ["decrypt_failed", "token_mismatch"],
  );
  assert.equal(h.inbound.length, 0, "坏载荷绝不进入 onInbound");
});

test("send: reply API 引用原消息；tenant_access_token 缓存复用", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  // start 已预热 token（1 次）
  assert.equal(h.server.count("token"), 1);
  const receipt = await h.adapter.send(replyOutbound());
  assert.equal(receipt.channel, "feishu");
  assert.match(receipt.remote_message_id ?? "", /^om_reply_/);
  assert.ok(receipt.delivered_at);

  const reply = h.server.lastRequest("reply");
  assert.ok(reply !== null);
  assert.equal(reply.path, "/open-apis/im/v1/messages/om_in_1/reply");
  const body = reply.body as Record<string, unknown>;
  assert.equal(body.msg_type, "text");
  assert.deepEqual(JSON.parse(String(body.content)), { text: "agent reply" });

  await h.adapter.send(replyOutbound({ reply_to_native_message_id: "om_in_2" }));
  assert.equal(h.server.count("token"), 1, "token 未过期时复用缓存");
  assert.equal(h.server.replies.length, 2);
});

test("token 过期：自动刷新一次后重试成功；刷新后仍被拒 → 健康降级", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  h.server.expireAccessToken();
  const receipt = await h.adapter.send(replyOutbound());
  assert.match(receipt.remote_message_id ?? "", /^om_reply_/);
  assert.equal(h.server.count("token"), 2, "过期后强制刷新一次");
  assert.equal(h.server.count("reply"), 2, "首次 401 + 刷新后重试");
  assert.equal(h.server.replies.length, 1, "平台只确认一次回复");
  assert.equal((await h.adapter.health()).healthy, true);

  h.server.rejectAllSendTokens = true;
  await assert.rejects(
    () => h.adapter.send(replyOutbound({ reply_to_native_message_id: "om_in_3" })),
    (err: unknown) => err instanceof ChannelSendError && err.kind === "explicit",
  );
  const health = await h.adapter.health();
  assert.equal(health.healthy, false);
  assert.equal(health.connection, "degraded");
  assert.match(health.last_error ?? "", /token/i);
});

test("429 限流：显式可重试错误（带 Retry-After），不当作未知送达；重试后成功", async (t) => {
  const h = await setup({ server: { rateLimit: { remaining: 1, retryAfterSeconds: 2 } } });
  t.after(() => h.dispose());

  await assert.rejects(
    () => h.adapter.send(replyOutbound()),
    (err: unknown) =>
      err instanceof ChannelSendError &&
      err.kind === "explicit" &&
      err.code === "rate_limited" &&
      err.retry_after_seconds === 2,
  );
  assert.equal(h.server.replies.length, 0);
  assert.equal(h.server.count("reply"), 1);

  const receipt = await h.adapter.send(replyOutbound());
  assert.match(receipt.remote_message_id ?? "", /^om_reply_/);
  assert.equal(h.server.count("reply"), 2);
  assert.equal(h.server.replies.length, 1);
});

test("主动消息：平台拒绝 → proactive_limited；capabilities 如实声明 limited", async (t) => {
  const h = await setup({ server: { rejectProactive: true } });
  t.after(() => h.dispose());

  const caps = h.adapter.capabilities();
  assert.equal(caps.direct_message, "supported");
  assert.equal(caps.group_mention, "supported");
  assert.equal(caps.group_proactive, "limited");
  assert.equal(caps.attachments, "limited");
  assert.equal(caps.edit, "unsupported");

  await assert.rejects(
    () => h.adapter.send(replyOutbound({ reply_to_native_message_id: undefined })),
    (err: unknown) =>
      err instanceof ChannelSendError && err.kind === "explicit" && err.code === "proactive_limited",
  );
  assert.equal(h.server.count("proactive"), 1);
  assert.equal(h.server.proactiveMessages.length, 0);
});

test("权限不足/超时：403 显式失败；超时标记 delivery-unknown 语义", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  h.server.replyMode = "forbidden";
  await assert.rejects(
    () => h.adapter.send(replyOutbound()),
    (err: unknown) =>
      err instanceof ChannelSendError && err.kind === "explicit" && err.code === "permission_denied",
  );

  h.server.replyMode = "hang";
  await assert.rejects(
    () => h.adapter.send(replyOutbound({ reply_to_native_message_id: "om_in_timeout" })),
    (err: unknown) => err instanceof ChannelSendError && err.kind === "timeout",
  );
  assert.equal(h.server.count("reply"), 2);
});
