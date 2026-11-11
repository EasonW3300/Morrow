// ChannelTestServer 自测（M4-T3 / Issue #40）：共享协议桩的端点、故障注入与断言接口。
// 零真实网络：只访问 127.0.0.1 随机端口的本地进程。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelTestServer } from "../src/channels/testing/channel-test-server.ts";
import { verifyFeishuEvent } from "../src/channels/adapters/feishu/events.ts";

const CONFIG = {
  appId: "cli_test_app",
  appSecret: "test_app_secret",
  verificationToken: "test_verification_token",
  encryptKey: "test_encrypt_key",
  botOpenId: "ou_bot",
};

async function openServer(overrides: Partial<ConstructorParameters<typeof ChannelTestServer>[0]> = {}) {
  const server = new ChannelTestServer({ ...CONFIG, ...overrides });
  await server.start();
  return server;
}

async function token(server: ChannelTestServer): Promise<string> {
  const res = await fetch(`${server.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: CONFIG.appId, app_secret: CONFIG.appSecret }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tenant_access_token: string; expire: number };
  return body.tenant_access_token;
}

test("ChannelTestServer: token/reply 端点、请求计数与最后请求断言", async (t) => {
  const server = await openServer();
  t.after(() => server.stop());

  const accessToken = await token(server);
  assert.equal(server.count("token"), 1);

  const reply = await fetch(`${server.baseUrl}/open-apis/im/v1/messages/om_in_1/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text: "pong" }) }),
  });
  assert.equal(reply.status, 200);
  const replyBody = (await reply.json()) as { code: number; data: { message_id: string } };
  assert.equal(replyBody.code, 0);
  assert.match(replyBody.data.message_id, /^om_reply_/);

  assert.equal(server.count("reply"), 1);
  assert.equal(server.replies.length, 1);
  assert.equal(server.replies[0].native_message_id, "om_in_1");
  assert.deepEqual(server.replies[0].body, {
    msg_type: "text",
    content: JSON.stringify({ text: "pong" }),
  });
  const last = server.lastRequest("reply");
  assert.ok(last !== null);
  assert.equal(last.headers.authorization, `Bearer ${accessToken}`);
  assert.equal(server.count(), 2);

  // 未授权的发送被拒
  const unauthorized = await fetch(`${server.baseUrl}/open-apis/im/v1/messages/om_in_1/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: "{}" }),
  });
  assert.equal(unauthorized.status, 401);
});

test("ChannelTestServer: 429 注入带 Retry-After；token 失效与刷新失败可切换", async (t) => {
  const server = await openServer({ rateLimit: { remaining: 1, retryAfterSeconds: 2 } });
  t.after(() => server.stop());

  const accessToken = await token(server);
  const headers = { "content-type": "application/json", authorization: `Bearer ${accessToken}` };
  const first = await fetch(`${server.baseUrl}/open-apis/im/v1/messages/om_1/reply`, {
    method: "POST",
    headers,
    body: JSON.stringify({ msg_type: "text", content: "{}" }),
  });
  assert.equal(first.status, 429);
  assert.equal(first.headers.get("retry-after"), "2");
  assert.equal(server.replies.length, 0);

  const second = await fetch(`${server.baseUrl}/open-apis/im/v1/messages/om_1/reply`, {
    method: "POST",
    headers,
    body: JSON.stringify({ msg_type: "text", content: "{}" }),
  });
  assert.equal(second.status, 200);

  // 已签发的 token 可作废（模拟过期）；刷新后恢复；rejectAll 模拟"刷新后仍失败"
  server.expireAccessToken();
  const expired = await fetch(`${server.baseUrl}/open-apis/im/v1/messages/om_2/reply`, {
    method: "POST",
    headers,
    body: JSON.stringify({ msg_type: "text", content: "{}" }),
  });
  assert.equal(expired.status, 401);
  const fresh = await token(server);
  const refreshed = await fetch(`${server.baseUrl}/open-apis/im/v1/messages/om_2/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${fresh}` },
    body: JSON.stringify({ msg_type: "text", content: "{}" }),
  });
  assert.equal(refreshed.status, 200);

  server.rejectAllSendTokens = true;
  const rejected = await fetch(`${server.baseUrl}/open-apis/im/v1/messages/om_3/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${fresh}` },
    body: JSON.stringify({ msg_type: "text", content: "{}" }),
  });
  assert.equal(rejected.status, 401);
});

test("ChannelTestServer: 主动消息被拒注入与 hang（客户端超时）模式", async (t) => {
  const server = await openServer({ rejectProactive: true });
  t.after(() => server.stop());

  const accessToken = await token(server);
  const proactive = await fetch(`${server.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ receive_id: "oc_group_1", msg_type: "text", content: "{}" }),
  });
  assert.equal(proactive.status, 400);
  const body = (await proactive.json()) as { code: number };
  assert.equal(body.code, 230001);
  assert.equal(server.count("proactive"), 1);
  assert.equal(server.proactiveMessages.length, 0);

  server.replyMode = "hang";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    fetch(`${server.baseUrl}/open-apis/im/v1/messages/om_hang/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ msg_type: "text", content: "{}" }),
      signal: controller.signal,
    }),
  );
  clearTimeout(timer);
  assert.equal(server.count("reply"), 1);
});

test("ChannelTestServer: 事件帧可签名/加密，签名失败注入可被 verifyFeishuEvent 识别", async (t) => {
  const server = await openServer();
  t.after(() => server.stop());

  const event = server.buildMessageEvent({
    messageId: "om_event_1",
    chatId: "oc_group_1",
    chatType: "group",
    senderOpenId: "ou_owner",
    text: "hello",
    mentionBot: true,
    createTime: "1762500000000",
  });
  const frame = server.buildEventFrame(event);
  assert.notEqual(frame.headers["x-lark-signature"], undefined);
  const verified = verifyFeishuEvent(frame, CONFIG);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal((verified.event.header as Record<string, unknown>).event_type, "im.message.receive_v1");

  server.signatureMode = "invalid";
  const bad = server.buildEventFrame(event);
  const rejected = verifyFeishuEvent(bad, CONFIG);
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.code, "signature_invalid");

  server.signatureMode = "missing";
  const missing = server.buildEventFrame(event);
  const missingResult = verifyFeishuEvent(missing, CONFIG);
  assert.equal(missingResult.ok, false);
  if (missingResult.ok) return;
  assert.equal(missingResult.code, "signature_missing");
});

test("ChannelTestServer: 事件长轮询推送、重复投递与自定义路由", async (t) => {
  const server = await openServer({ duplicateEvents: false });
  t.after(() => server.stop());

  const waitForStream = async (cursor = "0"): Promise<{ events: unknown[]; cursor: string }> => {
    const res = await fetch(
      `${server.baseUrl}/open-apis/event/v1/stream?cursor=${cursor}&timeout_ms=2000`,
    );
    assert.equal(res.status, 200);
    return (await res.json()) as { events: unknown[]; cursor: string };
  };

  const pending = waitForStream();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.pushMessage({ text: "push me" }), 1);
  const page = await pending;
  assert.equal(page.events.length, 1);
  assert.equal(page.cursor, "1");

  server.duplicateEvents = true;
  const duplicate = waitForStream(page.cursor);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.pushMessage({ text: "twice" }), 2);
  const duplicated = await duplicate;
  assert.equal(duplicated.events.length, 2);

  server.route("POST", /^\/custom\/echo$/, (ctx) => {
    ctx.respond(201, { seen: ctx.request.body }, { "x-test": "1" });
  }, "custom");
  const custom = await fetch(`${server.baseUrl}/custom/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(custom.status, 201);
  assert.equal(custom.headers.get("x-test"), "1");
  assert.equal(server.count("custom"), 1);
  assert.deepEqual(server.lastRequest("custom")?.body, { ok: true });
});
