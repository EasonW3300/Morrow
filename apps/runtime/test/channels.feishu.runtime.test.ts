// 飞书适配器经 startRuntime 的生产接线（M4-T3 / Issue #40）：
// channelAdapters 注入 → 账号登记 → 入站回复自动入 Outbox → dispatchOnce 经飞书
// reply API 发到 ChannelTestServer；GET /v1/channels 的 capabilities/health 如实呈现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { ChannelHealth, ChannelSummary } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { ChannelTestServer } from "../src/channels/testing/channel-test-server.ts";
import { FeishuChannelAdapter, type FeishuConfig } from "../src/channels/adapters/feishu/index.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CONFIG: FeishuConfig = {
  appId: "cli_test_app",
  appSecret: "test_app_secret",
  verificationToken: "test_verification_token",
  encryptKey: "test_encrypt_key",
  botOpenId: "ou_bot",
};

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

test("startRuntime: 飞书适配器清单/健康可查；入站回复经 Outbox 投递到平台桩并留审计", async (t) => {
  const dir = tmpDir("morrow-feishu-runtime-");
  const server = new ChannelTestServer({
    appId: CONFIG.appId,
    appSecret: CONFIG.appSecret,
    verificationToken: CONFIG.verificationToken,
    encryptKey: CONFIG.encryptKey,
    botOpenId: CONFIG.botOpenId,
  });
  await server.start();
  const adapter = new FeishuChannelAdapter({
    accountId: "feishu-default",
    config: CONFIG,
    baseUrl: server.baseUrl,
    requestTimeoutMs: 500,
    eventPollTimeoutMs: 20,
    eventReconnectDelayMs: 5,
  });
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: async () =>
      createFakePi({ script: [{ kind: "text", deltas: ["runtime ", "reply"] }] }),
    channelAdapters: [
      {
        adapter,
        account: {
          account_id: "feishu-default",
          channel_id: "feishu",
          native_account_id: CONFIG.appId,
          display_name: "Morrow Feishu bot",
          owner_native_ids: ["ou_owner"],
        },
      },
    ],
    outboxBackoffBaseMs: 100,
    // 本测试手动 dispatchOnce 断言单步状态；关闭自动定时投递（A2 语义另测）
    outboxDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close();
    await server.stop();
    removeDir(dir);
  });

  const base = `http://127.0.0.1:${runtime.port}`;
  const list = await json<{ channels: ChannelSummary[] }>(await fetch(`${base}/v1/channels`));
  const feishu = list.channels.find((channel) => channel.channel_id === "feishu");
  assert.ok(feishu !== undefined);
  assert.equal(feishu.state, "running");
  assert.equal(feishu.account, "feishu-default");
  assert.equal(feishu.enabled, true);
  assert.equal(feishu.experimental, false);
  assert.deepEqual(feishu.capabilities, {
    direct_message: "supported",
    group_mention: "supported",
    group_proactive: "limited",
    attachments: "limited",
    edit: "unsupported",
  });

  const health = await json<ChannelHealth>(await fetch(`${base}/v1/channels/feishu/health`));
  assert.equal(health.state, "running");
  assert.equal(health.healthy, true);
  assert.equal(health.connection, "connected");
  assert.match(health.token_expires_at ?? "", /Z$/);
  assert.equal(health.last_error, null);

  server.pushMessage({ messageId: "om_runtime_1", chatId: "oc_dm_1", text: "runtime hello" });
  await waitFor("outbox queued", () => runtime.outbox.list({}).total === 1);
  const summary = await runtime.outbox.dispatchOnce();
  assert.equal(summary.sent, 1);
  assert.equal(server.replies.length, 1);
  const body = server.replies[0].body as Record<string, unknown>;
  assert.deepEqual(JSON.parse(String(body.content)), { text: "runtime reply" });

  const outboundTypes = runtime.ledger
    .list({ limit: 200 })
    .events.map((event) => event.event_type)
    .filter((type) => type.startsWith("outbound."));
  assert.deepEqual(outboundTypes, ["outbound.queued", "outbound.sent"]);
});
