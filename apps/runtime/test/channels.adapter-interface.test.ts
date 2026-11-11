// Issue #50：ChannelAdapter 只保留协议转换；生命周期（ConfigurableChannel）与
// 实验性（ExperimentalChannel）语义改为接口存在性判定。本测试锁定两个类型守卫的
// 判定口径（不改变既有适配器行为，仅新增覆盖）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelCapabilities, OutboundMessage } from "@morrow/protocol";
import { WeChatChannelAdapter } from "../src/channels/adapters/wechat/adapter.ts";
import { StubLocalBridge } from "../src/channels/adapters/wechat/stub-bridge.ts";
import {
  ChannelSendError,
  isConfigurable,
  isExperimental,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelAdapterHealth,
  type ParseInboundResult,
} from "../src/channels/types.ts";

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  group_proactive: "unsupported",
  attachments: "unsupported",
  edit: "unsupported",
};

/** 最小协议适配器：不实现任何可选接口（飞书/QQ 官方 Bot 的形态） */
class ProtocolOnlyAdapter implements ChannelAdapter {
  readonly channelId = "protocol-only";
  start(_context: ChannelAdapterContext): void {}
  async stop(): Promise<void> {}
  send(_outbound: OutboundMessage): never {
    throw new ChannelSendError("explicit", "not implemented", { retryable: false });
  }
  health(): ChannelAdapterHealth {
    return { healthy: true };
  }
  parseInbound(_raw: unknown): ParseInboundResult {
    return { ok: false, code: "not_implemented", message: "not implemented" };
  }
  capabilities(): ChannelCapabilities {
    return { ...CAPABILITIES };
  }
}

test("isConfigurable：仅按 isConfigured 存在性判定（未配置占位形态）", () => {
  const plain = new ProtocolOnlyAdapter();
  assert.equal(isConfigurable(plain), false);

  const pending = Object.assign(new ProtocolOnlyAdapter(), {
    isConfigured: () => false,
    isEnabled: () => false,
  });
  assert.equal(isConfigurable(pending), true);
  assert.equal(pending.isConfigured(), false);
});

test("isExperimental：标记/环境/风险任一存在即视为实验适配器", () => {
  const plain = new ProtocolOnlyAdapter();
  assert.equal(isExperimental(plain), false);

  assert.equal(isExperimental(Object.assign(new ProtocolOnlyAdapter(), { experimental: true })), true);
  assert.equal(
    isExperimental(
      Object.assign(new ProtocolOnlyAdapter(), {
        environment: {
          os: "Windows",
          client: "wechat-latest",
          bridge: "local",
          real_integration: "not_done" as const,
        },
      }),
    ),
    true,
  );
  assert.equal(isExperimental(Object.assign(new ProtocolOnlyAdapter(), { riskNotice: "风险自担" })), true);
});

test("WeChat 适配器同时满足生命周期与实验性接口（出厂 disabled + 风险声明）", () => {
  const adapter = new WeChatChannelAdapter({ bridge: new StubLocalBridge(), enabled: false });
  assert.equal(isConfigurable(adapter), true);
  assert.equal(adapter.isConfigured(), true);
  assert.equal(adapter.isEnabled(), false);
  assert.equal(isExperimental(adapter), true);
  assert.equal(typeof adapter.riskNotice, "string");
  assert.equal(adapter.requiresConversationAllowlist, true);
});
