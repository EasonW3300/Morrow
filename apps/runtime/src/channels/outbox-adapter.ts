import type { OutboxChannelAdapter } from "../outbox/service.ts";
import type { ChannelRegistry } from "./registry.ts";
import { ChannelOutboxAdapter } from "./outbox.ts";

/**
 * Outbox → ChannelAdapter 桥的注册表入口（M4-T7 / Issue #44 接线；M4 规格「Outbox
 * 投递器」接缝；M4-T3 / Issue #40 起统一到 `ChannelOutboxAdapter` 实现）。
 *
 * 通知/主动消息与入站回复共用同一条投递路径：
 *   OutboxSendRequest → OutboundMessage（保留 reply_to_native_message_id / 附件）
 *   → adapter.send → 回执映射。
 * 错误语义见 `channels/outbox.ts`：explicit → failed；network/timeout →
 * delivery_unknown（不自动重发）；未注册渠道 → 明确 failed。
 */
export function createChannelOutboxAdapter(registry: ChannelRegistry): OutboxChannelAdapter {
  return new ChannelOutboxAdapter({ adapterFor: (channelId) => registry.getAdapter(channelId) });
}
