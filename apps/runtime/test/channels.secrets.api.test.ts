// 渠道凭据配置端点（M4-T8 / Issue #45）：
// GET/PUT /v1/channels/:id/secrets 只返回 configured 投影（绝不回显密文），
// 必填字段不可清空、未知字段拒绝；无凭据概念的渠道（echo/微信）明确 400。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { ChannelCapabilities, ChannelSecretsView } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { createInMemorySecretStore } from "../src/keyring.ts";
import { startRuntime } from "../src/runtime.ts";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterHealth,
} from "../src/channels/types.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  group_proactive: "limited",
  attachments: "limited",
  edit: "unsupported",
};

/** 最小稳定适配器（只验证凭据端点，不触网）：channelId 用 feishu 以命中凭据规格 */
class StubConfigurableAdapter implements ChannelAdapter {
  readonly channelId = "feishu";

  async start(_context: ChannelAdapterContext): Promise<void> {}
  async stop(): Promise<void> {}
  send(): never {
    throw new Error("not used");
  }
  health(): ChannelAdapterHealth {
    return { healthy: true, connection: "connected", token_expires_at: null, last_error: null };
  }
  parseInbound(): never {
    throw new Error("not used");
  }
  capabilities(): ChannelCapabilities {
    return { ...CAPABILITIES };
  }
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
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

test("渠道凭据端点：投影只报 configured、写入不回显、必填/未知字段拒绝", async (t) => {
  const dir = tmpDir("morrow-channel-secrets-");
  const runtime = await startRuntime(testConfig(dir), {
    // 隔离：不碰真实 OS 凭据库（默认 detectSecretStore 会写 macOS 钥匙串）
    secretStore: createInMemorySecretStore(),
    agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
    channelAdapters: [
      {
        adapter: new StubConfigurableAdapter(),
        account: {
          account_id: "feishu-default",
          channel_id: "feishu",
          native_account_id: "cli_fixture",
          display_name: "Fixture Feishu bot",
          owner_native_ids: ["ou_owner"],
        },
      },
    ],
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });
  const base = `http://127.0.0.1:${runtime.port}`;

  const initialRes = await fetch(`${base}/v1/channels/feishu/secrets`);
  assert.equal(initialRes.status, 200);
  const initial = await json<ChannelSecretsView>(initialRes);
  assert.equal(initial.channel_id, "feishu");
  assert.equal(initial.secret_service, "channel:feishu");
  assert.deepEqual(
    initial.fields.map((field) => [field.field, field.configured, field.required]),
    [
      ["app_id", false, true],
      ["app_secret", false, true],
      ["verification_token", false, true],
      ["encrypt_key", false, true],
      ["bot_open_id", false, false],
    ],
  );

  const secret = "super-secret-app-value";
  const put = await putJson(base, "/v1/channels/feishu/secrets", {
    secrets: {
      app_id: "cli_fixture_app",
      app_secret: secret,
      verification_token: "verify-token",
      encrypt_key: "encrypt-key",
    },
  });
  assert.equal(put.status, 200);
  assert.ok(!JSON.stringify(put.body).includes(secret), "响应不得包含密文");
  const after = put.body as unknown as ChannelSecretsView;
  assert.deepEqual(
    after.fields.map((field) => [field.field, field.configured]),
    [
      ["app_id", true],
      ["app_secret", true],
      ["verification_token", true],
      ["encrypt_key", true],
      ["bot_open_id", false],
    ],
  );

  const unknown = await putJson(base, "/v1/channels/feishu/secrets", { secrets: { nope: "x" } });
  assert.equal(unknown.status, 400);
  assert.equal((unknown.body.error as { code: string }).code, "invalid_body");

  const clearRequired = await putJson(base, "/v1/channels/feishu/secrets", { secrets: { app_id: "" } });
  assert.equal(clearRequired.status, 400);

  // echo 已注册但无凭据概念 → 400；未知渠道 → 404
  const echo = await putJson(base, "/v1/channels/echo/secrets", { secrets: { app_id: "x" } });
  assert.equal(echo.status, 404);
  const wechat = await fetch(`${base}/v1/channels/wechat/secrets`);
  assert.equal(wechat.status, 404);
});

test("渠道凭据端点：echo 适配器注册后明确 400 channel_not_configurable", async (t) => {
  const dir = tmpDir("morrow-channel-secrets-echo-");
  const runtime = await startRuntime(testConfig(dir), {
    secretStore: createInMemorySecretStore(),
    agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
    enableEchoChannel: true,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });
  const base = `http://127.0.0.1:${runtime.port}`;
  const res = await fetch(`${base}/v1/channels/echo/secrets`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "channel_not_configurable");
});
