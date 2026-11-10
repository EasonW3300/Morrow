import type { OutboundMessage } from "@morrow/protocol";
import {
  OutboxChannelError,
  type OutboxChannelAdapter,
  type OutboxSendOutcome,
  type OutboxSendRequest,
} from "../outbox/service.ts";
import type { ChannelRegistry } from "./registry.ts";

/**
 * Outbox → ChannelAdapter 桥（M4-T7 / Issue #44 接线；M4 规格「Outbox 投递器」接缝）。
 *
 * 所有渠道外发（通知、后续主动消息）统一经这里落到适配器：
 *   OutboxSendRequest → OutboundMessage → adapter.send → 回执映射
 * 映射规则：
 * - 适配器回执带 error → 平台明确拒收（failed，可退避重试）；
 * - delivery_unknown → 结果未知（抛 network 语义，Outbox 不自动重发）；
 * - 未注册渠道 / 未捕获异常 → network（保守：可能已发出，转人工核对）。
 *
 * 适配器只做协议转换；本桥不做业务判断（文案、权限、去重已在通知/Outbox 层完成）。
 */
export function createChannelOutboxAdapter(registry: ChannelRegistry): OutboxChannelAdapter {
  return {
    async send(request: OutboxSendRequest): Promise<OutboxSendOutcome> {
      const adapter = registry.getAdapter(request.channel_id);
      if (adapter === null) {
        return { kind: "failed", error: `channel_not_registered: ${request.channel_id}` };
      }
      const text = typeof request.payload.text === "string" ? request.payload.text : "";
      const outbound: OutboundMessage = {
        channel: request.channel_id,
        account: request.account_id,
        native_conversation_id: request.target.id,
        text,
        idempotency_key: request.idempotency_key,
      };
      try {
        const receipt = await adapter.send(outbound);
        if (receipt.delivery_unknown === true) {
          throw new OutboxChannelError("network", receipt.error ?? "channel adapter reported delivery_unknown");
        }
        if (typeof receipt.error === "string" && receipt.error.length > 0) {
          return { kind: "failed", error: receipt.error };
        }
        return {
          kind: "sent",
          receipt: {
            ...(receipt.remote_message_id === undefined ? {} : { platform_message_id: receipt.remote_message_id }),
            ...(receipt.delivered_at === undefined ? {} : { sent_at: receipt.delivered_at }),
            raw: { channel: receipt.channel },
          },
        };
      } catch (err) {
        if (err instanceof OutboxChannelError) throw err;
        throw new OutboxChannelError("network", err instanceof Error ? err.message : String(err));
      }
    },
  };
}
