import type { ChannelSendReceipt, InboundAttachment, OutboundMessage } from "@morrow/protocol";
import {
  OutboxChannelError,
  type OutboxChannelAdapter,
  type OutboxSendOutcome,
  type OutboxSendRequest,
  type OutboxService,
} from "../outbox/service.ts";
import { uuidv7 } from "../uuid-v7.ts";
import { ChannelSendError, type ChannelAdapter } from "./types.ts";

/**
 * 渠道 ↔ Outbox 桥（M4-T3 / Issue #40，AC-09 协议层闭环）。
 *
 * 两个方向：
 *  1. 入站回复入队：`enqueueOutbound()` 把 T1 路由产出的 OutboundMessage 写进 outbox
 *     （先落库、幂等键唯一），由 `OutboxService.dispatchOnce` 驱动；
 *  2. 投递出口：`ChannelOutboxAdapter` 把 OutboxSendRequest 还原为 OutboundMessage，
 *     调用真实 `ChannelAdapter.send`（飞书 reply API 在这里发生），并把
 *     ChannelSendError 映射为 Outbox 的统一结果：
 *        explicit            → failed（指数退避重试）
 *        network / timeout   → delivery_unknown（不自动重发）
 *
 * 适配器本身不感知 Outbox；T4/T5 适配器可直接复用本桥。
 */

export interface OutboundEnqueueResult {
  id: string;
  deduped: boolean;
}

/** 入站回复 → Outbox（幂等键由 T1 路由生成；缺失时按渠道/会话/消息兜底） */
export function enqueueOutbound(
  outbox: Pick<OutboxService, "enqueue">,
  outbound: OutboundMessage,
): OutboundEnqueueResult {
  const idempotencyKey =
    outbound.idempotency_key ??
    `channel:${outbound.channel}:${outbound.native_conversation_id}:${outbound.reply_to_native_message_id ?? uuidv7()}`;

  const payload: Record<string, unknown> = { text: outbound.text };
  if (outbound.reply_to_native_message_id !== undefined) {
    payload.reply_to_native_message_id = outbound.reply_to_native_message_id;
  }
  if (outbound.attachments !== undefined && outbound.attachments.length > 0) {
    payload.attachments = outbound.attachments;
  }

  return outbox.enqueue({
    idempotencyKey,
    channelId: outbound.channel,
    accountId: outbound.account,
    target: { kind: "conversation", id: outbound.native_conversation_id },
    payload,
  });
}

export interface ChannelOutboundSink {
  enqueue(outbound: OutboundMessage): OutboundEnqueueResult;
}

/** registry 的 outbound sink：入站回复不再直发平台，而是进 Outbox 等 dispatch */
export function createChannelOutboundSink(outbox: Pick<OutboxService, "enqueue">): ChannelOutboundSink {
  return {
    enqueue(outbound) {
      return enqueueOutbound(outbox, outbound);
    },
  };
}

export interface ChannelOutboxAdapterOptions {
  /** 按渠道解析适配器（registry.getAdapter）；未注册 → 明确失败 */
  adapterFor(channelId: string): ChannelAdapter | null;
}

/** Outbox 投递出口：OutboxSendRequest → ChannelAdapter.send */
export class ChannelOutboxAdapter implements OutboxChannelAdapter {
  readonly #adapterFor: (channelId: string) => ChannelAdapter | null;

  constructor(options: ChannelOutboxAdapterOptions) {
    this.#adapterFor = options.adapterFor;
  }

  async send(request: OutboxSendRequest): Promise<OutboxSendOutcome> {
    const adapter = this.#adapterFor(request.channel_id);
    if (adapter === null) {
      return { kind: "failed", error: `no channel adapter registered for "${request.channel_id}"` };
    }

    const text = request.payload.text;
    if (typeof text !== "string") {
      return { kind: "failed", error: "outbox payload.text must be a string" };
    }
    const replyTo = request.payload.reply_to_native_message_id;
    if (replyTo !== undefined && typeof replyTo !== "string") {
      return { kind: "failed", error: "outbox payload.reply_to_native_message_id must be a string" };
    }
    const attachments = parseAttachments(request.payload.attachments);
    if (attachments === null) {
      return { kind: "failed", error: "outbox payload.attachments must be an array" };
    }

    const outbound: OutboundMessage = {
      channel: request.channel_id,
      account: request.account_id,
      native_conversation_id: request.target.id,
      text,
      ...(replyTo === undefined ? {} : { reply_to_native_message_id: replyTo }),
      idempotency_key: request.idempotency_key,
      ...(attachments.length === 0 ? {} : { attachments }),
    };

    let receipt: ChannelSendReceipt;
    try {
      receipt = await adapter.send(outbound);
    } catch (err) {
      if (err instanceof ChannelSendError) {
        if (err.kind === "explicit") {
          // retryable=false（如 QQ 主动消息被平台策略拒绝）原样传给 Outbox，
          // 由状态机立即转 needs_review（不自动重发）而非退避重试。
          return { kind: "failed", error: err.message, ...(err.retryable ? {} : { retryable: false }) };
        }
        throw new OutboxChannelError(err.kind, err.message);
      }
      // 未分类异常按结果未知处理（与 OutboxService 的保守口径一致）
      throw new OutboxChannelError("network", err instanceof Error ? err.message : String(err));
    }

    if (receipt.delivery_unknown === true) {
      throw new OutboxChannelError("network", receipt.error ?? "channel reported delivery unknown");
    }
    if (receipt.error !== undefined) {
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
  }
}

function parseAttachments(value: unknown): InboundAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: InboundAttachment[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    out.push(item as InboundAttachment);
  }
  return out;
}
