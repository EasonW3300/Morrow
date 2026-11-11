import type {
  ChannelCapabilities,
  ChannelConversationKind,
  ChannelSendReceipt,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
} from "@morrow/protocol";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterHealth,
  ParseInboundResult,
} from "./types.ts";

/**
 * echo 参考适配器（M4-T1 / Issue #38）：仅测试/开发用，证明 ChannelAdapter 接缝完整。
 *
 * 启停由 registry 控制（`MORROW_CHANNEL_ECHO=1` 或显式注入）；`inject(raw)` 模拟平台
 * 推送一条事件，走真实的 onInbound → 归一化 → 入站路由 → 会话链路；助手回复经
 * `send()` 记录（测试直接断言 sent 数组）。
 *
 * 平台原始载荷形状（模拟，非真实平台协议）：
 *   { message_id, conversation_id, conversation_kind?, sender:{id,name?}, text?,
 *     mentions_agent?, mentioned_user_ids?, attachments?, timestamp? }
 * 注意：载荷里即使带 principal/is_owner 等自报身份字段也会被丢弃——权限只由本地映射解析。
 */

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  // 参考适配器不承诺主动消息（平台限流/场景限制是真实约束，契约层不夸大）
  group_proactive: "unsupported",
  // 入站附件引用可归一化，出站附件投递未实现 —— 如实声明 limited
  attachments: "limited",
  edit: "unsupported",
};

export interface EchoChannelAdapterOptions {
  accountId?: string;
  /** 可注入时钟（测试确定性）；缺省系统时间 */
  now?: () => Date;
}

export class EchoChannelAdapter implements ChannelAdapter {
  readonly channelId = "echo";
  readonly experimental = true;

  #accountId: string;
  #onInbound: ((raw: unknown) => void) | null = null;
  #running = false;
  #sent: OutboundMessage[] = [];
  #now: () => Date;

  constructor(options: EchoChannelAdapterOptions = {}) {
    this.#accountId = options.accountId ?? "echo-default";
    this.#now = options.now ?? (() => new Date());
  }

  /** 已发送的出站消息（测试观察点；生产适配器不会有此内存数组） */
  get sent(): readonly OutboundMessage[] {
    return this.#sent;
  }

  start(context: ChannelAdapterContext): void {
    this.#accountId = context.accountId;
    this.#onInbound = context.onInbound;
    this.#running = true;
  }

  stop(): void {
    this.#running = false;
    this.#onInbound = null;
  }

  /** 模拟平台推送一条原始事件（仅测试/开发注入路径） */
  inject(raw: unknown): void {
    if (!this.#running || this.#onInbound === null) {
      throw new Error("echo adapter is not running");
    }
    this.#onInbound(raw);
  }

  parseInbound(raw: unknown): ParseInboundResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return invalid("raw payload must be a JSON object");
    }
    const record = raw as Record<string, unknown>;

    const messageId = nonEmptyString(record.message_id);
    const conversationId = nonEmptyString(record.conversation_id);
    if (messageId === null) return invalid("message_id must be a non-empty string");
    if (conversationId === null) return invalid("conversation_id must be a non-empty string");

    const senderRecord = record.sender;
    if (typeof senderRecord !== "object" || senderRecord === null || Array.isArray(senderRecord)) {
      return invalid("sender must be an object with a native id");
    }
    const senderId = nonEmptyString((senderRecord as Record<string, unknown>).id);
    if (senderId === null) return invalid("sender.id must be a non-empty string");
    const senderName = nonEmptyString((senderRecord as Record<string, unknown>).name);

    const timestamp = nonEmptyString(record.timestamp);
    if (timestamp === null) return invalid("timestamp must be an RFC 3339 string");

    const conversationKind: ChannelConversationKind =
      record.conversation_kind === "group" ? "group" : "direct";

    const mentionedIds = Array.isArray(record.mentioned_user_ids)
      ? record.mentioned_user_ids.filter((id): id is string => typeof id === "string")
      : undefined;

    const attachments = parseAttachments(record.attachments);
    if (attachments === null) return invalid("attachments must be an array of attachment objects");

    const message: InboundMessage = {
      channel: this.channelId,
      account: this.#accountId,
      native_message_id: messageId,
      native_conversation_id: conversationId,
      conversation_kind: conversationKind,
      sender: {
        native_id: senderId,
        ...(senderName === null ? {} : { display_name: senderName }),
      },
      mention: {
        agent: record.mentions_agent === true,
        ...(mentionedIds === undefined ? {} : { native_ids: mentionedIds }),
      },
      attachments,
      timestamp,
      text: typeof record.text === "string" ? record.text : "",
      // 权限上下文绝不由适配器给出（不信任平台自报身份）
      permission_context: null,
    };
    return message;
  }

  send(outbound: OutboundMessage): ChannelSendReceipt {
    this.#sent.push(outbound);
    return {
      channel: this.channelId,
      remote_message_id: outbound.idempotency_key ?? `echo-${this.#sent.length}`,
      delivered_at: this.#now().toISOString(),
    };
  }

  health(): ChannelAdapterHealth {
    return this.#running
      ? { healthy: true, detail: "echo reference adapter is accepting injected inbound events" }
      : { healthy: false, detail: "echo reference adapter is stopped" };
  }

  capabilities(): ChannelCapabilities {
    return { ...CAPABILITIES };
  }
}

function invalid(message: string): ParseInboundResult {
  return { ok: false, code: "invalid_inbound", message };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseAttachments(value: unknown): InboundAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: InboundAttachment[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    out.push({
      ...(nonEmptyString(record.id) === null ? {} : { native_id: record.id as string }),
      kind:
        kind === "image" || kind === "file" || kind === "audio" || kind === "video" || kind === "other"
          ? kind
          : "other",
      ...(nonEmptyString(record.name) === null ? {} : { name: record.name as string }),
      ...(nonEmptyString(record.mime_type) === null ? {} : { mime_type: record.mime_type as string }),
      ...(typeof record.size_bytes === "number" ? { size_bytes: record.size_bytes } : {}),
      ...(nonEmptyString(record.url) === null ? {} : { url: record.url as string }),
    });
  }
  return out;
}
