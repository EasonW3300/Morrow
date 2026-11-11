import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type {
  ChannelConversationKind,
  InboundAttachment,
  InboundMessage,
} from "@morrow/protocol";
import type { ParseInboundResult } from "../../types.ts";

/**
 * 飞书事件解码（M4-T3 / Issue #40）：
 * - 签名校验：`X-Lark-Signature = sha256(timestamp + nonce + encrypt_key + raw_body)`；
 * - 加密解密：`{encrypt}` 载荷 = AES-256-CBC(key=sha256(encrypt_key), IV=前 16 字节)；
 * - Verification Token：`header.token`（或顶层 token）必须与配置一致；
 * - `im.message.receive_v1` → T1 的 InboundMessage（permission_context 恒为 null）。
 *
 * 所有失败都返回结构化 code（signature_invalid / decrypt_failed / token_mismatch /
 * timestamp_stale / unsupported_event / invalid_inbound），供注册表落
 * `channel.inbound_rejected` 留痕——适配器绝不自行猜测身份或吞掉坏事件。
 */

export interface FeishuEventConfig {
  verificationToken: string;
  encryptKey: string;
  botOpenId?: string;
}

export interface FeishuRawEvent {
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export type FeishuVerifyResult =
  | { ok: true; event: Record<string, unknown>; body: Record<string, unknown> }
  | { ok: false; code: string; message: string };

export interface FeishuVerifyOptions {
  /** 允许的事件时间偏差（秒，默认 300；0 = 不校验） */
  toleranceSeconds?: number;
  /** 注入时钟（测试确定性） */
  now?: () => Date;
}

export function verifyFeishuEvent(
  raw: FeishuRawEvent,
  config: FeishuEventConfig,
  options: FeishuVerifyOptions = {},
): FeishuVerifyResult {
  const timestamp = headerValue(raw.headers, "x-lark-request-timestamp");
  const nonce = headerValue(raw.headers, "x-lark-request-nonce");
  const signature = headerValue(raw.headers, "x-lark-signature");

  if (timestamp === null || nonce === null || signature === null) {
    return { ok: false, code: "signature_missing", message: "missing x-lark-signature/timestamp/nonce headers" };
  }

  const tolerance = options.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const parsed = Number(timestamp);
    const nowSeconds = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
    if (!Number.isInteger(parsed) || Math.abs(nowSeconds - parsed) > tolerance) {
      return { ok: false, code: "timestamp_stale", message: `event timestamp ${timestamp} is outside ±${tolerance}s` };
    }
  }

  const expected = createHash("sha256")
    .update(`${timestamp}${nonce}${config.encryptKey}${raw.body}`)
    .digest("hex");
  if (!constantTimeEqual(signature, expected)) {
    return { ok: false, code: "signature_invalid", message: "event signature does not match" };
  }

  let outer: unknown;
  try {
    outer = JSON.parse(raw.body) as unknown;
  } catch {
    return { ok: false, code: "invalid_body", message: "event body is not valid JSON" };
  }
  if (!isRecord(outer)) {
    return { ok: false, code: "invalid_body", message: "event body must be a JSON object" };
  }

  let payload = outer;
  const encrypted = outer.encrypt;
  if (typeof encrypted === "string") {
    const decrypted = decryptFeishuPayload(encrypted, config.encryptKey);
    if (decrypted === null) {
      return { ok: false, code: "decrypt_failed", message: "event payload could not be decrypted with the configured key" };
    }
    try {
      const parsed: unknown = JSON.parse(decrypted);
      if (!isRecord(parsed)) {
        return { ok: false, code: "invalid_body", message: "decrypted event body must be a JSON object" };
      }
      payload = parsed;
    } catch {
      return { ok: false, code: "invalid_body", message: "decrypted event body is not valid JSON" };
    }
  }

  const header = isRecord(payload.header) ? payload.header : null;
  const token =
    header !== null && typeof header.token === "string"
      ? header.token
      : typeof payload.token === "string"
        ? payload.token
        : null;
  if (token === null || !constantTimeEqual(token, config.verificationToken)) {
    return { ok: false, code: "token_mismatch", message: "verification token does not match the configured value" };
  }

  return { ok: true, event: payload, body: outer };
}

/** 飞书 Encrypt Key 解密（AES-256-CBC；IV 为 base64 解码后的前 16 字节） */
export function decryptFeishuPayload(encryptedBase64: string, encryptKey: string): string | null {
  try {
    const key = createHash("sha256").update(encryptKey).digest();
    const packed = Buffer.from(encryptedBase64, "base64");
    if (packed.length <= 16) return null;
    const iv = packed.subarray(0, 16);
    const data = packed.subarray(16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export type FeishuEventKind =
  | { kind: "message"; event: Record<string, unknown> }
  | { kind: "url_verification"; challenge?: string }
  | { kind: "ignored"; eventType: string };

export function classifyFeishuEvent(event: Record<string, unknown>): FeishuEventKind {
  const header = isRecord(event.header) ? event.header : null;
  const eventType =
    header !== null && typeof header.event_type === "string"
      ? header.event_type
      : typeof event.type === "string"
        ? event.type
        : "";
  if (eventType === "im.message.receive_v1") return { kind: "message", event };
  if (eventType === "url_verification") {
    return {
      kind: "url_verification",
      ...(typeof event.challenge === "string" ? { challenge: event.challenge } : {}),
    };
  }
  return { kind: "ignored", eventType };
}

export interface ParseFeishuInboundOptions {
  channelId?: string;
  accountId: string;
  botOpenId?: string;
  /** 平台未给可解析时间时的回退（缺省系统时间） */
  now?: () => Date;
}

/** `im.message.receive_v1` → 统一 InboundMessage（不解析权限/身份） */
export function parseFeishuInbound(
  event: Record<string, unknown>,
  options: ParseFeishuInboundOptions,
): ParseInboundResult {
  const classified = classifyFeishuEvent(event);
  if (classified.kind !== "message") {
    return {
      ok: false,
      code: "unsupported_event",
      message: `event "${classified.kind === "ignored" ? classified.eventType : classified.kind}" is not an inbound message`,
    };
  }

  const eventBody = event.event;
  if (!isRecord(eventBody)) return invalid("event body must be an object");
  const message = eventBody.message;
  if (!isRecord(message)) return invalid("event.message must be an object");
  const sender = eventBody.sender;
  if (!isRecord(sender)) return invalid("event.sender must be an object");

  const messageId = nonEmpty(message.message_id);
  if (messageId === null) return invalid("message.message_id must be a non-empty string");
  const chatId = nonEmpty(message.chat_id);
  if (chatId === null) return invalid("message.chat_id must be a non-empty string");

  const senderIds = isRecord(sender.sender_id) ? sender.sender_id : {};
  const senderNativeId =
    nonEmpty(senderIds.open_id) ?? nonEmpty(senderIds.user_id) ?? nonEmpty(senderIds.union_id);
  if (senderNativeId === null) {
    return invalid("event.sender.sender_id must expose open_id/user_id/union_id");
  }

  const chatType = nonEmpty(message.chat_type);
  const conversationKind: ChannelConversationKind = chatType === "group" ? "group" : "direct";

  const mentions = Array.isArray(message.mentions)
    ? message.mentions.filter(isRecord)
    : [];
  const mentionIds = mentions
    .map((mention) => (isRecord(mention.id) ? nonEmpty(mention.id.open_id) : null))
    .filter((id): id is string => id !== null);
  const botOpenId = options.botOpenId;
  const agentMentioned =
    botOpenId !== undefined && mentions.some((mention) => isRecord(mention.id) && mention.id.open_id === botOpenId);

  const messageType = nonEmpty(message.message_type) ?? "text";
  const content = parseMessageContent(message.content);
  const attachments = extractAttachments(messageType, content);
  const text = extractText(messageType, content, mentions);

  const createTime = nonEmpty(message.create_time);
  const timestamp =
    createTime !== null && /^\d+$/.test(createTime)
      ? new Date(Number(createTime)).toISOString()
      : (options.now ?? (() => new Date()))().toISOString();

  const inbound: InboundMessage = {
    channel: options.channelId ?? "feishu",
    account: options.accountId,
    native_message_id: messageId,
    native_conversation_id: chatId,
    conversation_kind: conversationKind,
    sender: { native_id: senderNativeId },
    mention: {
      agent: agentMentioned,
      ...(mentionIds.length === 0 ? {} : { native_ids: mentionIds }),
    },
    attachments,
    timestamp,
    text,
    permission_context: null,
  };
  return inbound;
}

function extractText(
  messageType: string,
  content: Record<string, unknown> | null,
  mentions: Array<Record<string, unknown>>,
): string {
  if (content === null) return "";
  let text = "";
  if (messageType === "text") {
    text = typeof content.text === "string" ? content.text : "";
    // 飞书文本里的 @ 占位符（@_user_1）不进入会话文本；群 @ 由 mention.agent 表达
    for (const mention of mentions) {
      const key = nonEmpty(mention.key);
      if (key !== null) text = text.split(key).join(" ");
    }
    return text.replace(/[ \t]+/g, " ").trim();
  }
  if (messageType === "post") {
    const title = typeof content.title === "string" ? content.title : "";
    const body = extractPostText(content.content);
    return [title, body].filter((part) => part.length > 0).join("\n").trim();
  }
  return "";
}

function extractPostText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const lines: string[] = [];
  for (const line of value) {
    if (!Array.isArray(line)) continue;
    const parts: string[] = [];
    for (const element of line) {
      if (!isRecord(element)) continue;
      if (element.tag === "text" && typeof element.text === "string") parts.push(element.text);
      else if (element.tag === "a" && typeof element.text === "string") parts.push(element.text);
    }
    const joined = parts.join("").trim();
    if (joined.length > 0) lines.push(joined);
  }
  return lines.join("\n");
}

function extractAttachments(
  messageType: string,
  content: Record<string, unknown> | null,
): InboundAttachment[] {
  if (content === null) return [];
  const nativeId =
    nonEmpty(content.image_key) ?? nonEmpty(content.file_key) ?? nonEmpty(content.file_token) ?? undefined;
  if (messageType === "image") {
    return [{ ...(nativeId === undefined ? {} : { native_id: nativeId }), kind: "image" }];
  }
  if (messageType === "file") {
    return [
      {
        ...(nativeId === undefined ? {} : { native_id: nativeId }),
        kind: "file",
        ...(nonEmpty(content.file_name) === null ? {} : { name: content.file_name as string }),
        ...(typeof content.file_size === "number" ? { size_bytes: content.file_size } : {}),
      },
    ];
  }
  if (messageType === "audio") {
    return [{ ...(nativeId === undefined ? {} : { native_id: nativeId }), kind: "audio" }];
  }
  if (messageType === "media") {
    return [{ ...(nativeId === undefined ? {} : { native_id: nativeId }), kind: "video" }];
  }
  return [];
}

function parseMessageContent(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function invalid(message: string): ParseInboundResult {
  return { ok: false, code: "invalid_inbound", message };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
