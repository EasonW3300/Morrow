// 渠道控制面 API 测试（M4-T1 / Issue #38）：
// GET /v1/channels（清单 + capabilities + state）、GET /v1/channels/:id/health，
// 以及 echo 参考适配器经 startRuntime 接线的全链路（注入 → 归一化 → 会话 → send 回调）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { ChannelHealth, ChannelSummary } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { createInMemorySecretStore } from "../src/keyring.ts";
import { startRuntime } from "../src/runtime.ts";
import { EchoChannelAdapter } from "../src/channels/echo.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function fakeFactory() {
  return async () =>
    createFakePi({
      script: [{ kind: "text", deltas: ["desktop ", "agent reply"] }],
    });
}

test("GET /v1/channels lists adapters with capabilities and state; health is queryable", async (t) => {
  const dir = tmpDir("morrow-channels-api-");
  const runtime = await startRuntime(testConfig(dir), {
    // 隔离：空的内存凭据库 → 不触发 A1 自动装配（宿主 Keychain 可能已有真实渠道凭据）
    secretStore: createInMemorySecretStore(),
    agentAdapterFactory: fakeFactory(),
    enableEchoChannel: true,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });

  const list = await json<{ channels: ChannelSummary[] }>(
    await fetch(`http://127.0.0.1:${runtime.port}/v1/channels`),
  );
  assert.equal(list.channels.length, 1);
  const echo = list.channels[0];
  assert.equal(echo.channel_id, "echo");
  assert.equal(echo.account, "echo-default");
  assert.equal(echo.state, "running");
  assert.equal(echo.enabled, true);
  assert.equal(echo.experimental, true);
  assert.equal(echo.capabilities.direct_message, "supported");
  assert.equal(echo.capabilities.group_proactive, "unsupported");

  const healthRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/channels/echo/health`);
  assert.equal(healthRes.status, 200);
  const health = await json<ChannelHealth>(healthRes);
  assert.equal(health.channel_id, "echo");
  assert.equal(health.state, "running");
  assert.equal(health.healthy, true);
  assert.match(health.checked_at, /Z$/);

  const missing = await fetch(`http://127.0.0.1:${runtime.port}/v1/channels/nope/health`);
  assert.equal(missing.status, 404);
  const error = await json<{ error: { code: string } }>(missing);
  assert.equal(error.error.code, "unknown_channel");
});

test("echo adapter wired through runtime: injected inbound produces a session turn and a send callback", async (t) => {
  const dir = tmpDir("morrow-channels-api-");
  const runtime = await startRuntime(testConfig(dir), {
    // 隔离：空的内存凭据库 → 不触发 A1 自动装配（宿主 Keychain 可能已有真实渠道凭据）
    secretStore: createInMemorySecretStore(),
    agentAdapterFactory: fakeFactory(),
    enableEchoChannel: true,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });

  const adapter = runtime.channels.getAdapter("echo");
  assert.ok(adapter instanceof EchoChannelAdapter);
  adapter.inject({
    message_id: "native-1",
    conversation_id: "dm-1",
    sender: { id: "owner", name: "Owner" },
    text: "hello",
    timestamp: "2026-11-10T10:00:00.000Z",
  });

  await waitFor("echo send callback", () => adapter.sent.length === 1);
  assert.equal(adapter.sent[0].text, "desktop agent reply");
  assert.equal(adapter.sent[0].native_conversation_id, "dm-1");

  const sessions = runtime.sessions.listSessions();
  assert.equal(sessions.length, 1);
  const history = runtime.sessions.history(sessions[0].session_id);
  assert.deepEqual(
    history.messages.map((message) => [message.role, message.text]),
    [
      ["user", "hello"],
      ["assistant", "desktop agent reply"],
    ],
  );

  const received = runtime.ledger.scan({ eventType: "channel.inbound_received" });
  assert.equal(received.length, 1);
  assert.equal(received[0].envelope.session_id, sessions[0].session_id);
});

test("MORROW_CHANNEL_ECHO=1 enables the reference adapter without explicit injection", async (t) => {
  const dir = tmpDir("morrow-channels-api-env-");
  const previous = process.env.MORROW_CHANNEL_ECHO;
  process.env.MORROW_CHANNEL_ECHO = "1";
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory() });
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.MORROW_CHANNEL_ECHO;
    else process.env.MORROW_CHANNEL_ECHO = previous;
    removeDir(dir);
  });

  const list = await json<{ channels: ChannelSummary[] }>(
    await fetch(`http://127.0.0.1:${runtime.port}/v1/channels`),
  );
  assert.equal(list.channels.some((channel) => channel.channel_id === "echo"), true);
});
