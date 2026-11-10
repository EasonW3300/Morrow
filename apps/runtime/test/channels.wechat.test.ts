// 微信个人号实验适配器（M4-T5 / Issue #42）：
// 出厂 disabled → 显式 confirm_risk 启用 + channel.experimental_enabled 审计；
// LocalBridge 可注入接缝（M4 仅 StubLocalBridge）；白名单会话收发；health 报告
// 桥接进程/登录态/窗口句柄/最近错误；禁用后立即停止收发（stop 幂等）。
// 风险声明（API risk_notice + environment）可被 UI 消费；真实微信联调未做。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { ChannelHealth, ChannelSummary } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { EventLedger } from "../src/ledger.ts";
import { SessionManager } from "../src/sessions.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import {
  StubLocalBridge,
  WeChatChannelAdapter,
  WECHAT_ENVIRONMENT,
  WECHAT_RISK_NOTICE,
  type LocalBridgeInboundMessage,
} from "../src/channels/adapters/wechat/index.ts";
import { ChannelSendError } from "../src/channels/types.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function inboundMessage(overrides: Partial<LocalBridgeInboundMessage> = {}): LocalBridgeInboundMessage {
  return {
    message_id: "wx-in-1",
    conversation_id: "wx-dm-1",
    conversation_kind: "direct",
    sender: { id: "wx_owner", name: "Owner" },
    text: "hello",
    timestamp: "2026-11-10T10:00:00.000Z",
    ...overrides,
  };
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function putJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 直接驱动适配器：先确认风险启用，再 start 注入白名单判定。 */
async function adapterHarness(options: { allowed?: string[] } = {}): Promise<{
  bridge: StubLocalBridge;
  adapter: WeChatChannelAdapter;
  inbound: unknown[];
  rejected: Array<{ code: string; message: string; reason?: string }>;
  dispose(): Promise<void>;
}> {
  const bridge = new StubLocalBridge();
  const adapter = new WeChatChannelAdapter({ accountId: "wechat-default", bridge });
  const inbound: unknown[] = [];
  const rejected: Array<{ code: string; message: string; reason?: string }> = [];
  const allowed = new Set(options.allowed ?? ["wx-dm-1"]);
  await adapter.enable({ confirmRisk: true });
  await adapter.start({
    accountId: "wechat-default",
    onInbound: (raw) => inbound.push(raw),
    onInboundRejected: (event) =>
      rejected.push({
        code: event.code,
        message: event.message,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      }),
    isConversationAllowed: (nativeConversationId) => allowed.has(nativeConversationId),
  });
  return {
    bridge,
    adapter,
    inbound,
    rejected,
    async dispose() {
      await adapter.stop();
      await adapter.disable();
    },
  };
}

test("微信适配器出厂 disabled：未确认 risk 的 enable 被拒，start/send 拒绝", async () => {
  const bridge = new StubLocalBridge();
  const adapter = new WeChatChannelAdapter({ bridge });

  assert.equal(adapter.channelId, "wechat");
  assert.equal(adapter.experimental, true);
  assert.equal(adapter.isEnabled(), false);

  await assert.rejects(
    async () => {
      await adapter.enable({ confirmRisk: false });
    },
    /confirm_risk|风险/,
  );
  await assert.rejects(
    () => adapter.start({ accountId: "wechat-default", onInbound: () => {} }),
    /disabled|confirm_risk/,
  );
  assert.equal(bridge.connectCalls, 0, "未启用时绝不连接本地桥");

  const health = await adapter.health();
  assert.equal(health.healthy, false);
  assert.match(health.detail ?? "", /disabled|确认风险/);
  assert.equal(health.experimental, true);
  assert.equal(health.environment?.os, "Windows");
  assert.equal(health.risk_notice, WECHAT_RISK_NOTICE);
});

test("白名单会话：允许的会话进入 onInbound，非白名单会话拒绝且拒绝发送", async (t) => {
  const h = await adapterHarness();
  t.after(() => h.dispose());

  h.bridge.emit(inboundMessage({ message_id: "wx-in-1" }));
  assert.equal(h.inbound.length, 1);
  const parsed = h.adapter.parseInbound(h.inbound[0]);
  assert.notEqual((parsed as { ok?: boolean }).ok, false);
  const inbound = parsed as {
    channel: string;
    account: string;
    native_conversation_id: string;
    conversation_kind: string;
    permission_context: null;
  };
  assert.equal(inbound.channel, "wechat");
  assert.equal(inbound.account, "wechat-default");
  assert.equal(inbound.native_conversation_id, "wx-dm-1");
  assert.equal(inbound.conversation_kind, "direct");
  assert.equal(inbound.permission_context, null);

  h.bridge.emit(inboundMessage({ message_id: "wx-in-2", conversation_id: "wx-dm-2" }));
  assert.equal(h.inbound.length, 1, "非白名单会话不进入会话链路");
  assert.equal(h.rejected.length, 1);
  assert.equal(h.rejected[0].code, "conversation_not_allowed");
  assert.equal(h.rejected[0].reason, "conversation_not_allowed");

  await assert.rejects(
    () =>
      h.adapter.send({
        channel: "wechat",
        account: "wechat-default",
        native_conversation_id: "wx-dm-2",
        text: "should not leave",
      }),
    (err: unknown) => err instanceof ChannelSendError && err.code === "conversation_not_allowed",
  );

  const receipt = await h.adapter.send({
    channel: "wechat",
    account: "wechat-default",
    native_conversation_id: "wx-dm-1",
    text: "agent reply",
    reply_to_native_message_id: "wx-in-1",
  });
  assert.equal(receipt.channel, "wechat");
  assert.equal(h.bridge.sent.length, 1);
  assert.equal(h.bridge.sent[0].conversation_id, "wx-dm-1");
  assert.equal(h.bridge.sent[0].reply_to_message_id, "wx-in-1");
});

test("health 报告桥接进程/登录态/窗口句柄/最近错误，并暴露环境与风险文案", async (t) => {
  const h = await adapterHarness();
  t.after(() => h.dispose());

  let health = await h.adapter.health();
  assert.equal(health.healthy, true);
  assert.equal(health.connection, "connected");
  assert.equal(health.experimental, true);
  assert.deepEqual(health.environment, WECHAT_ENVIRONMENT);
  assert.equal(health.environment?.os, "Windows");
  assert.match(health.environment?.client ?? "", /微信/);
  assert.equal(health.risk_notice, WECHAT_RISK_NOTICE);
  assert.match(health.risk_notice ?? "", /不稳定/);
  assert.match(health.risk_notice ?? "", /条款/);
  assert.match(health.risk_notice ?? "", /风险自担/);
  assert.match(health.risk_notice ?? "", /默认关闭/);
  assert.deepEqual(health.bridge, {
    process: "running",
    login: "logged_in",
    window: "available",
    last_error: null,
  });

  h.bridge.setStatus({
    process: "error",
    login: "logged_out",
    window: "unavailable",
    last_error: "bridge crashed",
  });
  health = await h.adapter.health();
  assert.equal(health.healthy, false);
  assert.equal(health.connection, "degraded");
  assert.equal(health.last_error, "bridge crashed");
  assert.equal(health.bridge?.process, "error");
  assert.equal(health.bridge?.login, "logged_out");
  assert.equal(health.bridge?.window, "unavailable");
});

test("禁用后立即停止收发；stop 幂等", async (t) => {
  const h = await adapterHarness();
  t.after(() => h.dispose());

  h.bridge.emit(inboundMessage({ message_id: "wx-before" }));
  assert.equal(h.inbound.length, 1);
  assert.equal(h.bridge.connected, true);

  await h.adapter.disable();
  assert.equal(h.bridge.connected, false);
  assert.equal(h.adapter.isEnabled(), false);

  h.bridge.emit(inboundMessage({ message_id: "wx-after" }));
  assert.equal(h.inbound.length, 1, "禁用后桥接消息不再进入适配器");
  await assert.rejects(
    () =>
      h.adapter.send({
        channel: "wechat",
        account: "wechat-default",
        native_conversation_id: "wx-dm-1",
        text: "after disable",
      }),
    /not running|disabled/,
  );

  // stop 幂等：重复调用不抛错
  await h.adapter.stop();
  await h.adapter.stop();
});

test("registry：未确认风险拒绝启用；确认后白名单收发 + 审计；禁用后停止", async (t) => {
  const dir = tmpDir("morrow-wechat-registry-");
  const ledger = EventLedger.open(dir);
  const sessions = new SessionManager({
    ledger,
    replicaId: REPLICA,
    factory: async () => createFakePi({ script: [{ kind: "text", deltas: ["assistant reply"] }] }),
  });
  const bridge = new StubLocalBridge();
  const adapter = new WeChatChannelAdapter({ accountId: "wechat-default", bridge });
  const registry = new ChannelRegistry({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    sessions,
    enableEcho: false,
  });
  registry.registerAdapter(adapter);
  registry.registerAccount({
    account_id: "wechat-default",
    channel_id: "wechat",
    native_account_id: "wx_owner",
    display_name: "Morrow WeChat",
    owner_native_ids: ["wx_owner"],
  });
  t.after(async () => {
    await registry.stop();
    registry.close();
    await sessions.dispose();
    ledger.close();
    removeDir(dir);
  });

  await registry.start();
  const initial = registry.list()[0];
  assert.equal(initial?.state, "stopped");
  assert.equal(initial?.enabled, false);
  assert.equal(initial?.experimental, true);
  assert.equal(initial?.environment?.os, "Windows");
  assert.equal(initial?.risk_notice, WECHAT_RISK_NOTICE);

  const refused = await registry.enableChannel("wechat", { confirmRisk: false });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.code, "risk_confirmation_required");
  assert.equal(adapter.isEnabled(), false);
  assert.equal(bridge.connected, false);
  assert.equal(ledger.scan({ eventType: "channel.experimental_enabled" }).length, 0);

  const enabled = await registry.enableChannel("wechat", { confirmRisk: true });
  assert.equal(enabled.ok, true);
  assert.equal(adapter.isEnabled(), true);
  assert.equal(bridge.connected, true);
  assert.equal(registry.list()[0]?.state, "running");
  assert.equal(registry.list()[0]?.enabled, true);

  const audit = ledger.scan({ eventType: "channel.experimental_enabled" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.envelope.payload.channel, "wechat");
  assert.equal(audit[0]?.envelope.payload.confirm_risk, true);
  assert.equal(audit[0]?.envelope.payload.experimental, true);

  registry.allowConversation({
    account_id: "wechat-default",
    native_conversation_id: "wx-dm-1",
    mode: "mention_only",
  });

  bridge.emit(inboundMessage({ message_id: "wx-reg-1", conversation_id: "wx-dm-1", text: "你好" }));
  await waitFor("assistant reply", () => bridge.sent.length === 1);
  assert.equal(bridge.sent[0]?.conversation_id, "wx-dm-1");
  assert.equal(bridge.sent[0]?.text, "assistant reply");
  assert.equal(sessions.listSessions().length, 1);

  bridge.emit(inboundMessage({ message_id: "wx-reg-2", conversation_id: "wx-dm-2", text: "不该响应" }));
  await waitFor("non-allowlisted rejection", () => ledger.scan({ eventType: "channel.inbound_rejected" }).length === 1);
  const rejection = ledger.scan({ eventType: "channel.inbound_rejected" })[0];
  assert.equal(rejection?.envelope.payload.reason, "conversation_not_allowed");
  assert.equal(bridge.sent.length, 1);
  assert.equal(sessions.listSessions().length, 1);

  const disabled = await registry.disableChannel("wechat");
  assert.equal(disabled.ok, true);
  assert.equal(bridge.connected, false);
  assert.equal(registry.list()[0]?.enabled, false);
  assert.equal(registry.list()[0]?.state, "stopped");

  bridge.emit(inboundMessage({ message_id: "wx-reg-3", conversation_id: "wx-dm-1", text: "禁用后" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ledger.scan({ eventType: "channel.inbound_received" }).length, 1);
  assert.equal(bridge.sent.length, 1);
});

test("enableChannel 对非实验适配器返回 not_experimental", async (t) => {
  const dir = tmpDir("morrow-wechat-non-experimental-");
  const ledger = EventLedger.open(dir);
  const sessions = new SessionManager({
    ledger,
    replicaId: REPLICA,
    factory: async () => createFakePi({ script: [{ kind: "text", deltas: ["noop"] }] }),
  });
  const registry = new ChannelRegistry({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    sessions,
    enableEcho: true,
  });
  t.after(async () => {
    await registry.stop();
    registry.close();
    await sessions.dispose();
    ledger.close();
    removeDir(dir);
  });

  const result = await registry.enableChannel("echo", { confirmRisk: true });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "not_experimental");
});

test("API：出厂 disabled、未确认 409、确认后白名单收发；实验标记与风险文案可见", async (t) => {
  const dir = tmpDir("morrow-wechat-runtime-");
  const bridge = new StubLocalBridge();
  const adapter = new WeChatChannelAdapter({ accountId: "wechat-default", bridge });
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: async () =>
      createFakePi({ script: [{ kind: "text", deltas: ["runtime ", "reply"] }] }),
    channelAdapters: [
      {
        adapter,
        account: {
          account_id: "wechat-default",
          channel_id: "wechat",
          native_account_id: "wx_owner",
          display_name: "Morrow WeChat",
          owner_native_ids: ["wx_owner"],
        },
      },
    ],
    outboxBackoffBaseMs: 100,
    outboxDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });
  const base = `http://127.0.0.1:${runtime.port}`;

  const list = await json<{ channels: ChannelSummary[] }>(await fetch(`${base}/v1/channels`));
  const wechat = list.channels.find((channel) => channel.channel_id === "wechat");
  assert.ok(wechat !== undefined);
  assert.equal(wechat.experimental, true);
  assert.equal(wechat.enabled, false);
  assert.equal(wechat.state, "stopped");
  assert.equal(wechat.environment?.os, "Windows");
  assert.equal(wechat.risk_notice, WECHAT_RISK_NOTICE);

  const healthRes = await fetch(`${base}/v1/channels/wechat/health`);
  assert.equal(healthRes.status, 200);
  const health = await json<ChannelHealth>(healthRes);
  assert.equal(health.experimental, true);
  assert.equal(health.state, "stopped");
  assert.equal(health.healthy, false);
  assert.equal(health.environment?.os, "Windows");
  assert.match(health.environment?.client ?? "", /微信/);
  assert.equal(health.risk_notice, WECHAT_RISK_NOTICE);
  assert.equal(health.bridge?.process, "stopped");

  const refused = await postJson(base, "/v1/channels/wechat/enable", {});
  assert.equal(refused.status, 409);
  const refusedError = refused.body.error as { code: string } | undefined;
  assert.equal(refusedError?.code, "risk_confirmation_required");
  assert.equal(refused.body.risk_notice, WECHAT_RISK_NOTICE);
  assert.equal(bridge.connected, false);

  const enabled = await postJson(base, "/v1/channels/wechat/enable", { confirm_risk: true });
  assert.equal(enabled.status, 200);
  assert.equal(bridge.connected, true);
  assert.equal(runtime.ledger.scan({ eventType: "channel.experimental_enabled" }).length, 1);

  const enabledList = await json<{ channels: ChannelSummary[] }>(await fetch(`${base}/v1/channels`));
  const enabledWechat = enabledList.channels.find((channel) => channel.channel_id === "wechat");
  assert.equal(enabledWechat?.enabled, true);
  assert.equal(enabledWechat?.state, "running");

  const allowlist = await putJson(base, "/v1/channels/wechat/allowlist", {
    allowlist: [{ native_conversation_id: "wx-dm-1", mode: "mention_only" }],
  });
  assert.equal(allowlist.status, 200);

  bridge.emit(
    inboundMessage({ message_id: "wx-runtime-1", conversation_id: "wx-dm-1", text: "你好" }),
  );
  await waitFor(
    "inbound received",
    () => runtime.ledger.scan({ eventType: "channel.inbound_received" }).length === 1,
  );
  await waitFor("outbox queued", () => runtime.outbox.list({}).total === 1);
  const dispatched = await runtime.outbox.dispatchOnce();
  assert.equal(dispatched.sent, 1);
  assert.equal(bridge.sent.length, 1);
  assert.equal(bridge.sent[0]?.conversation_id, "wx-dm-1");
  assert.equal(bridge.sent[0]?.text, "runtime reply");

  bridge.emit(
    inboundMessage({ message_id: "wx-runtime-2", conversation_id: "wx-dm-2", text: "不该响应" }),
  );
  await waitFor(
    "non-allowlisted rejection",
    () => runtime.ledger.scan({ eventType: "channel.inbound_rejected" }).length === 1,
  );
  const rejection = runtime.ledger.scan({ eventType: "channel.inbound_rejected" })[0];
  assert.equal(rejection?.envelope.payload.reason, "conversation_not_allowed");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runtime.ledger.scan({ eventType: "channel.inbound_received" }).length, 1);
  assert.equal(bridge.sent.length, 1);

  const disabled = await postJson(base, "/v1/channels/wechat/disable", {});
  assert.equal(disabled.status, 200);
  assert.equal(bridge.connected, false);
  const finalList = await json<{ channels: ChannelSummary[] }>(await fetch(`${base}/v1/channels`));
  assert.equal(finalList.channels.find((channel) => channel.channel_id === "wechat")?.enabled, false);

  bridge.emit(
    inboundMessage({ message_id: "wx-runtime-3", conversation_id: "wx-dm-1", text: "禁用后" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runtime.ledger.scan({ eventType: "channel.inbound_received" }).length, 1);
  assert.equal(bridge.sent.length, 1);

  const unknown = await postJson(base, "/v1/channels/nope/enable", { confirm_risk: true });
  assert.equal(unknown.status, 404);
});
