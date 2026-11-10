// A2 修复批（Issue #37）：Outbox 自动投递循环。
// enqueue 后不手动 dispatch，一个 drain 周期内行变 sent 且平台适配器收到一次；
// outboxDrainIntervalMs=0 关闭定时器（测试手动 dispatch 的确定性路径）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelCapabilities, ChannelSendReceipt, OutboundMessage } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { createInMemorySecretStore } from "../src/keyring.ts";
import { startRuntime } from "../src/runtime.ts";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterHealth,
} from "../src/channels/types.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "unsupported",
  group_proactive: "unsupported",
  attachments: "unsupported",
  edit: "unsupported",
};

/** 计数适配器：只记录 send 调用，验证 Outbox 定时器真的把行投递出去 */
class CountingAdapter implements ChannelAdapter {
  readonly channelId = "drain-test";
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

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test("Outbox 定时 drain：enqueue 后一个周期内自动 sent，平台适配器收到一次", async (t) => {
  const dir = tmpDir("morrow-outbox-drain-");
  const adapter = new CountingAdapter();
  const runtime = await startRuntime(testConfig(dir), {
    secretStore: createInMemorySecretStore(),
    channelAdapters: [
      {
        adapter,
        account: {
          account_id: "drain-default",
          channel_id: "drain-test",
          native_account_id: "drain-native",
        },
      },
    ],
    outboxDrainIntervalMs: 20,
    notificationDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });

  const queued = runtime.outbox.enqueue({
    idempotencyKey: "drain:auto:1",
    channelId: "drain-test",
    accountId: "drain-default",
    target: { kind: "conversation", id: "conv-1" },
    payload: { text: "auto drain" },
  });
  assert.equal(queued.message.status, "pending");

  await waitFor("outbox auto dispatch", () => runtime.outbox.get(queued.id)?.status === "sent");
  assert.equal(adapter.outbound.length, 1);
  assert.equal(adapter.outbound[0]?.native_conversation_id, "conv-1");
  assert.equal(adapter.outbound[0]?.text, "auto drain");
});

test("outboxDrainIntervalMs=0：关闭自动投递，行保持 pending 直到手动 dispatchOnce", async (t) => {
  const dir = tmpDir("morrow-outbox-drain-off-");
  const adapter = new CountingAdapter();
  const runtime = await startRuntime(testConfig(dir), {
    secretStore: createInMemorySecretStore(),
    channelAdapters: [
      {
        adapter,
        account: {
          account_id: "drain-default",
          channel_id: "drain-test",
          native_account_id: "drain-native",
        },
      },
    ],
    outboxDrainIntervalMs: 0,
    notificationDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });

  const queued = runtime.outbox.enqueue({
    idempotencyKey: "drain:off:1",
    channelId: "drain-test",
    accountId: "drain-default",
    target: { kind: "conversation", id: "conv-2" },
    payload: { text: "manual" },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(adapter.outbound.length, 0);
  assert.equal(runtime.outbox.get(queued.id)?.status, "pending");

  const summary = await runtime.outbox.dispatchOnce();
  assert.equal(summary.sent, 1);
  assert.equal(adapter.outbound.length, 1);
});
