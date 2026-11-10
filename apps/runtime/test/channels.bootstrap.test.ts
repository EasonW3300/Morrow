// A1 修复批（Issue #37）：生产入口按 SecretStore 已配置凭据自动装配渠道适配器。
// 覆盖：飞书+QQ 自动注册、未配置渠道不出现、缺省 disabled 不进入运行态、
// 显式 enable 后 health 正确、启用状态跨重启持久化；微信标记凭据 → 实验适配器
// 出厂 disabled + confirm_risk、注入本地桥后启用可运行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { ChannelHealth, ChannelSummary } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { createInMemorySecretStore, type SecretStore } from "../src/keyring.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { ChannelTestServer } from "../src/channels/testing/channel-test-server.ts";
import { registerQqTestStub } from "../src/channels/testing/qq-stub.ts";
import { StubLocalBridge } from "../src/channels/adapters/wechat/stub-bridge.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const FEISHU_APP_ID = "cli_bootstrap_app";
const QQ_APP_ID = "qq_bootstrap_app";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

async function seedFeishuSecrets(store: SecretStore): Promise<void> {
  await store.setSecret("channel:feishu", "app_id", FEISHU_APP_ID);
  await store.setSecret("channel:feishu", "app_secret", "bootstrap_app_secret");
  await store.setSecret("channel:feishu", "verification_token", "bootstrap_verification_token");
  await store.setSecret("channel:feishu", "encrypt_key", "bootstrap_encrypt_key");
  await store.setSecret("channel:feishu", "bot_open_id", "ou_bot");
}

async function seedQqSecrets(store: SecretStore): Promise<void> {
  await store.setSecret("channel:qq", "app_id", QQ_APP_ID);
  await store.setSecret("channel:qq", "app_secret", "qq_bootstrap_secret");
  await store.setSecret("channel:qq", "bot_secret", "qq_bootstrap_bot_secret");
}

async function listChannels(base: string): Promise<ChannelSummary[]> {
  const body = await json<{ channels: ChannelSummary[] }>(await fetch(`${base}/v1/channels`));
  return body.channels;
}

async function health(base: string, channelId: string): Promise<ChannelHealth> {
  return json<ChannelHealth>(await fetch(`${base}/v1/channels/${channelId}/health`));
}

async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("startRuntime 自动装配飞书+QQ：未配置不出现，缺省 disabled 不启动，enable 后健康且跨重启保持", async (t) => {
  const dir = tmpDir("morrow-channel-bootstrap-");
  const secretStore = createInMemorySecretStore();
  await seedFeishuSecrets(secretStore);
  await seedQqSecrets(secretStore);
  const server = new ChannelTestServer({
    appId: FEISHU_APP_ID,
    appSecret: "bootstrap_app_secret",
    verificationToken: "bootstrap_verification_token",
    encryptKey: "bootstrap_encrypt_key",
    botOpenId: "ou_bot",
  });
  await server.start();
  const stub = registerQqTestStub(server, {
    appId: QQ_APP_ID,
    appSecret: "qq_bootstrap_secret",
    botSecret: "qq_bootstrap_bot_secret",
  });

  const bootstrap = {
    feishu: {
      baseUrl: server.baseUrl,
      requestTimeoutMs: 500,
      eventPollTimeoutMs: 20,
      eventReconnectDelayMs: 5,
    },
    qq: {
      apiBaseUrl: server.baseUrl,
      tokenEndpoint: `${server.baseUrl}/app/getAppAccessToken`,
      requestTimeoutMs: 500,
      eventPollTimeoutMs: 20,
      eventReconnectDelayMs: 5,
    },
    ownerNativeIds: { feishu: ["ou_owner"], qq: ["qq_owner"] },
  };

  let runtime = await startRuntime(testConfig(dir), {
    secretStore,
    channelBootstrap: bootstrap,
    agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
    notificationDrainIntervalMs: 0,
    outboxDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await server.stop();
    removeDir(dir);
  });

  const base = `http://127.0.0.1:${runtime.port}`;
  const initial = await listChannels(base);
  const initialIds = initial.map((channel) => channel.channel_id).sort();
  assert.deepEqual(initialIds, ["feishu", "qq"], "只出现已配置凭据的渠道（echo/微信不隐式出现）");
  for (const channel of initial) {
    assert.equal(channel.state, "stopped", `${channel.channel_id} 缺省未启用`);
    assert.equal(channel.enabled, false);
    assert.ok((channel.account ?? "").length > 0, `${channel.channel_id} 账号已登记`);
  }

  const disabledHealth = await health(base, "feishu");
  assert.equal(disabledHealth.state, "stopped");
  assert.equal(disabledHealth.healthy, false);
  assert.match(disabledHealth.detail ?? "", /disabled/);

  // 稳定适配器显式启用（A1：managed 渠道持久化 + start）
  const enableFeishu = await postJson(base, "/v1/channels/feishu/enable", {});
  assert.equal(enableFeishu.status, 200);
  const enableQq = await postJson(base, "/v1/channels/qq/enable", {});
  assert.equal(enableQq.status, 200);

  const running = await listChannels(base);
  for (const channel of running) {
    assert.equal(channel.state, "running", `${channel.channel_id} 启用后运行`);
    assert.equal(channel.enabled, true);
  }
  const feishuHealth = await health(base, "feishu");
  assert.equal(feishuHealth.state, "running");
  assert.equal(feishuHealth.healthy, true);
  assert.equal(feishuHealth.connection, "connected");
  const qqHealth = await health(base, "qq");
  assert.equal(qqHealth.state, "running");
  assert.equal(qqHealth.healthy, true);
  assert.equal(qqHealth.connection, "connected");
  assert.equal(stub.appId, QQ_APP_ID);

  // 启用状态持久化：同一 dataDir 重启后读取既有状态并直接运行
  await runtime.close();
  runtime = await startRuntime(testConfig(dir), {
    secretStore,
    channelBootstrap: bootstrap,
    agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
    notificationDrainIntervalMs: 0,
    outboxDrainIntervalMs: 0,
  });
  const restarted = await listChannels(`http://127.0.0.1:${runtime.port}`);
  assert.deepEqual(
    restarted.map((channel) => [channel.channel_id, channel.state, channel.enabled]).sort(),
    [
      ["feishu", "running", true],
      ["qq", "running", true],
    ],
  );
});

test("微信标记凭据 → 实验适配器出厂 disabled；注入本地桥后 confirm_risk 方可启用", async (t) => {
  const dir = tmpDir("morrow-channel-bootstrap-wechat-");
  const secretStore = createInMemorySecretStore();
  await secretStore.setSecret("channel:wechat", "bridge_command", "stub-bridge");
  const bridge = new StubLocalBridge();
  const runtime = await startRuntime(testConfig(dir), {
    secretStore,
    channelBootstrap: { wechat: { bridge } },
    agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
    notificationDrainIntervalMs: 0,
    outboxDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });
  const base = `http://127.0.0.1:${runtime.port}`;

  const listed = await listChannels(base);
  const wechat = listed.find((channel) => channel.channel_id === "wechat");
  assert.ok(wechat !== undefined);
  assert.equal(wechat.experimental, true);
  assert.equal(wechat.enabled, false);
  assert.equal(wechat.state, "stopped");
  assert.equal(wechat.environment?.os, "Windows");
  assert.match(wechat.risk_notice ?? "", /风险自担|默认关闭/);

  const refused = await postJson(base, "/v1/channels/wechat/enable", {});
  assert.equal(refused.status, 409);
  assert.equal(bridge.connected, false);

  const enabled = await postJson(base, "/v1/channels/wechat/enable", { confirm_risk: true });
  assert.equal(enabled.status, 200);
  assert.equal(bridge.connected, true);
  const after = await listChannels(base);
  assert.equal(after.find((channel) => channel.channel_id === "wechat")?.state, "running");
});

test("缺字段的渠道配置降级为 error 状态，不阻断 Runtime 启动", async (t) => {
  const dir = tmpDir("morrow-channel-bootstrap-broken-");
  const secretStore = createInMemorySecretStore();
  // 只有 app_id，缺 app_secret/verification_token/encrypt_key
  await secretStore.setSecret("channel:feishu", "app_id", "cli_broken");
  const runtime: RuntimeHandle = await startRuntime(testConfig(dir), {
    secretStore,
    agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
    notificationDrainIntervalMs: 0,
    outboxDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });
  const base = `http://127.0.0.1:${runtime.port}`;
  const feishu = (await listChannels(base)).find((channel) => channel.channel_id === "feishu");
  assert.ok(feishu !== undefined, "配置残缺的渠道仍可诊断");
  // 手动 enable 触发 start → 占位适配器抛错 → registry 隔离为 error
  const enable = await postJson(base, "/v1/channels/feishu/enable", {});
  assert.equal(enable.status, 200);
  const errorHealth = await health(base, "feishu");
  assert.equal(errorHealth.state, "error");
  assert.equal(errorHealth.healthy, false);
  assert.match(errorHealth.detail ?? "", /app_secret|verification_token|encrypt_key|missing/);
  // Runtime 本身仍健康
  const res = await fetch(`${base}/v1/health`);
  assert.equal(res.status, 200);
});
