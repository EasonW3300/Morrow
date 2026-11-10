// A3 修复批（Issue #37）：通知的渠道目标解析。
// 未配置默认通知会话 → 保存渠道规则 400 notify_target_required（不是运行时静默失败）；
// 配置后通知经 Outbox 投递到该 native conversation（平台桩收到）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelCapabilities,
  ChannelSendReceipt,
  NotificationRule,
  OutboundMessage,
} from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { createInMemorySecretStore } from "../src/keyring.ts";
import { startRuntime } from "../src/runtime.ts";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterHealth,
} from "../src/channels/types.ts";
import { makeEvent, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const TASK = "01936b9d-8f7a-7abc-9f2e-0000000000aa";

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  group_proactive: "limited",
  attachments: "unsupported",
  edit: "unsupported",
};

class RecordingAdapter implements ChannelAdapter {
  readonly channelId = "feishu";
  readonly outbound: OutboundMessage[] = [];

  async start(_context: ChannelAdapterContext): Promise<void> {}
  async stop(): Promise<void> {}
  send(outbound: OutboundMessage): ChannelSendReceipt {
    this.outbound.push(outbound);
    return { channel: this.channelId, remote_message_id: `om-${this.outbound.length}` };
  }
  health(): ChannelAdapterHealth {
    return { healthy: true };
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

async function requestJson(
  base: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("渠道通知目标：未配置规则保存 400；配置后经 Outbox 发到指定会话", async (t) => {
  const dir = tmpDir("morrow-notify-target-");
  const adapter = new RecordingAdapter();
  const runtime = await startRuntime(testConfig(dir), {
    secretStore: createInMemorySecretStore(),
    channelAdapters: [
      {
        adapter,
        account: {
          account_id: "feishu-default",
          channel_id: "feishu",
          native_account_id: "cli_fixture",
          display_name: "Fixture Feishu",
        },
      },
    ],
    notificationDrainIntervalMs: 0,
    outboxDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });
  const base = `http://127.0.0.1:${runtime.port}`;

  // 1) 未配置默认通知会话 → 规则保存即 400（notify_target_required）
  const missing = await requestJson(base, "/v1/notifications/rules", "PUT", {
    rules: [{ event_type: "completed", target: "channel:feishu", enabled: true }],
  });
  assert.equal(missing.status, 400);
  assert.equal((missing.body.error as { code: string }).code, "notify_target_required");
  const rulesAfterMissing = await requestJson(base, "/v1/notifications/rules", "GET");
  assert.equal((rulesAfterMissing.body.rules as NotificationRule[]).length, 0);

  // 2) 未存在/未白名单的会话 → 拒绝写入
  const unknownConversation = await requestJson(base, "/v1/channels/feishu/notify-target", "PUT", {
    native_conversation_id: "oc_not_seen",
  });
  assert.equal(unknownConversation.status, 400);
  assert.equal((unknownConversation.body.error as { code: string }).code, "conversation_not_found");

  // 3) 白名单会话（群）可被指定为默认通知会话
  const allow = await requestJson(base, "/v1/channels/feishu/allowlist", "PUT", {
    allowlist: [{ native_conversation_id: "oc_notify_group", mode: "proactive_limited" }],
  });
  assert.equal(allow.status, 200);
  const configured = await requestJson(base, "/v1/channels/feishu/notify-target", "PUT", {
    native_conversation_id: "oc_notify_group",
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.native_conversation_id, "oc_notify_group");
  const fetched = await requestJson(base, "/v1/channels/feishu/notify-target", "GET");
  assert.equal(fetched.body.native_conversation_id, "oc_notify_group");
  assert.equal(runtime.ledger.scan({ eventType: "channel.notify_target_updated" }).length, 1);

  // 4) 配置后规则保存成功，通知经 Outbox 投递到该会话
  const saved = await requestJson(base, "/v1/notifications/rules", "PUT", {
    rules: [{ event_type: "completed", target: "channel:feishu", enabled: true }],
  });
  assert.equal(saved.status, 200);

  runtime.ledger.append(
    makeEvent({
      replica_id: REPLICA,
      event_type: "task.completed",
      task_id: TASK,
      occurred_at: new Date().toISOString(),
      payload: { goal: "A3 notify target" },
    }),
  );

  const sent = await runtime.notifications.dispatchQueued();
  assert.equal(sent, 1);
  assert.equal(adapter.outbound.length, 1);
  assert.equal(adapter.outbound[0]?.native_conversation_id, "oc_notify_group");
  assert.match(adapter.outbound[0]?.text ?? "", /A3 notify target/);

  const outbox = runtime.outbox.list({ status: "sent" });
  assert.equal(outbox.messages.length, 1);
  assert.deepEqual(outbox.messages[0]?.target, { kind: "conversation", id: "oc_notify_group" });
});
