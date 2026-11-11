import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type {
  ChannelConversationKind,
  InboundAttachment,
  InboundMessage,
} from "@morrow/protocol";
import type { ParseInboundResult } from "../../types.ts";

/**
 * QQ 官方 Bot 事件解码（M4-T4 / Issue #41）。
 *
 * 事件形态（官方 Webhook / 长连接一致）：
 *   { op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id, content, timestamp, group_openid,
 *     author: { id, member_openid }, attachments: [...] } }
 *   { op: 0, t: "C2C_MESSAGE_CREATE", d: { id, content, timestamp,
 *     author: { id, user_openid }, attachments: [...] } }
 *   { op: 13, d: { plain_token, event_ts } }   ← 回调地址校验
 *
 * 签名（配置 bot_secret 时强制校验）：
 *   seed   = bot_secret 重复补齐到 32 字节后截断；
 *   keypair= Ed25519(seed)（与官方 botgo GenerateKeyPair 同语义）；
 *   事件   = Ed25519(timestamp + rawBody)，头 `X-Signature-Ed25519` / `X-Signature-Timestamp`；
 *   op 13  = Ed25519(event_ts + plain_token)，响应 { plain_token, signature }。
 *
 * 所有失败都返回结构化 code（signature_missing / signature_invalid / timestamp_stale /
 * invalid_body / unsupported_event / invalid_inbound），供注册表落
 * `channel.inbound_rejected` 留痕——适配器绝不自行猜测身份或吞掉坏事件。
 */

export interface QqEventConfig {
  botSecret?: string;
}

export interface QqRawEvent {
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

export type QqVerifyResult =
  | { ok: true; event: Record<string, unknown>; body: Record<string, unknown> }
  | { ok: false; code: string; message: string };

export interface QqVerifyOptions {
  /** 允许的事件时间偏差（秒，默认 300；0 = 不校验） */
  toleranceSeconds?: number;
  /** 注入时钟（测试确定性） */
  now?: () => Date;
}

export function verifyQqEvent(
  raw: QqRawEvent,
  config: QqEventConfig,
  options: QqVerifyOptions = {},
): QqVerifyResult {
  if (config.botSecret !== undefined && config.botSecret.length > 0) {
    const timestamp = headerValue(raw.headers, "x-signature-timestamp");
    const signature = headerValue(raw.headers, "x-signature-ed25519");
    if (timestamp === null || signature === null) {
      return {
        ok: false,
        code: "signature_missing",
        message: "missing x-signature-ed25519/x-signature-timestamp headers",
      };
    }

    const tolerance = options.toleranceSeconds ?? 300;
    if (tolerance > 0) {
      const parsed = Number(timestamp);
      const nowSeconds = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
      if (!Number.isInteger(parsed) || Math.abs(nowSeconds - parsed) > tolerance) {
        return {
          ok: false,
          code: "timestamp_stale",
          message: `event timestamp ${timestamp} is outside ±${tolerance}s`,
        };
      }
    }

    if (!verifyEd25519(config.botSecret, `${timestamp}${raw.body}`, signature)) {
      return { ok: false, code: "signature_invalid", message: "event signature does not match" };
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw.body) as unknown;
  } catch {
    return { ok: false, code: "invalid_body", message: "event body is not valid JSON" };
  }
  if (!isRecord(payload)) {
    return { ok: false, code: "invalid_body", message: "event body must be a JSON object" };
  }
  return { ok: true, event: payload, body: payload };
}

export type QqEventKind =
  | { kind: "message"; event: Record<string, unknown> }
  | { kind: "validation"; event: Record<string, unknown>; plainToken: string; eventTs: string }
  | { kind: "ignored"; eventType: string; op: number };

export function classifyQqEvent(event: Record<string, unknown>): QqEventKind {
  const op = typeof event.op === "number" ? event.op : -1;
  if (op === 13) {
    const data = isRecord(event.d) ? event.d : {};
    return {
      kind: "validation",
      event,
      plainToken: typeof data.plain_token === "string" ? data.plain_token : "",
      eventTs: typeof data.event_ts === "string" ? data.event_ts : "",
    };
  }
  const eventType = typeof event.t === "string" ? event.t : "";
  if (op === 0 && (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "C2C_MESSAGE_CREATE")) {
    return { kind: "message", event };
  }
  return { kind: "ignored", eventType, op };
}

/** 回调地址校验应答：{ plain_token, signature }；非 op 13 返回 null */
export function answerQqValidation(
  event: Record<string, unknown>,
  botSecret: string,
): { plain_token: string; signature: string } | null {
  const classified = classifyQqEvent(event);
  if (classified.kind !== "validation") return null;
  return {
    plain_token: classified.plainToken,
    signature: signEd25519(botSecret, `${classified.eventTs}${classified.plainToken}`),
  };
}

export interface ParseQqInboundOptions {
  channelId?: string;
  accountId: string;
  /** Bot 的 AppID（群 @ 的 native_ids 提示；缺省从内容里的 <@!id> 提取） */
  botOpenId?: string;
  /** 平台未给可解析时间时的回退（缺省系统时间） */
  now?: () => Date;
}

/** QQ 消息事件 → 统一 InboundMessage（不解析权限/身份） */
export function parseQqInbound(
  event: Record<string, unknown>,
  options: ParseQqInboundOptions,
): ParseInboundResult {
  const classified = classifyQqEvent(event);
  if (classified.kind !== "message") {
    const label =
      classified.kind === "validation"
        ? "callback_validation"
        : classified.eventType.length > 0
          ? classified.eventType
          : `op ${classified.op}`;
    return {
      ok: false,
      code: "unsupported_event",
      message: `event "${label}" is not an inbound message`,
    };
  }

  const data = event.d;
  if (!isRecord(data)) return invalid("event.d must be an object");

  const messageId = nonEmpty(data.id);
  if (messageId === null) return invalid("event.d.id must be a non-empty string");

  const author = isRecord(data.author) ? data.author : null;
  if (author === null) return invalid("event.d.author must be an object");

  const eventType = String(event.t);
  const isGroup = eventType === "GROUP_AT_MESSAGE_CREATE";

  const conversationId = isGroup
    ? nonEmpty(data.group_openid)
    : (nonEmpty(author.user_openid) ?? nonEmpty(author.id));
  if (conversationId === null) {
    return invalid(
      isGroup
        ? "event.d.group_openid must be a non-empty string"
        : "event.d.author.user_openid must be a non-empty string",
    );
  }

  const senderNativeId = isGroup
    ? (nonEmpty(author.member_openid) ?? nonEmpty(author.id))
    : (nonEmpty(author.user_openid) ?? nonEmpty(author.id));
  if (senderNativeId === null) {
    return invalid(
      isGroup
        ? "event.d.author.member_openid must be a non-empty string"
        : "event.d.author.user_openid must be a non-empty string",
    );
  }

  const rawContent = typeof data.content === "string" ? data.content : "";
  const mentionIds = extractMentionIds(rawContent);
  const botOpenId = options.botOpenId;
  // GROUP_AT_MESSAGE_CREATE 只在 @ 机器人时投递；再次用显式 @ 标记兜底说明来源。
  const agentMentioned = isGroup;
  if (agentMentioned && botOpenId !== undefined && !mentionIds.includes(botOpenId)) {
    mentionIds.unshift(botOpenId);
  }

  const attachments = extractAttachments(data.attachments);
  const timestamp = normalizeTimestamp(data.timestamp, options.now);

  const inbound: InboundMessage = {
    channel: options.channelId ?? "qq",
    account: options.accountId,
    native_message_id: messageId,
    native_conversation_id: conversationId,
    conversation_kind: isGroup ? "group" : "direct",
    sender: { native_id: senderNativeId },
    mention: {
      agent: agentMentioned,
      ...(mentionIds.length === 0 ? {} : { native_ids: mentionIds }),
    },
    attachments,
    timestamp,
    text: stripMentionTags(rawContent).replace(/[ \t]+/g, " ").trim(),
    permission_context: null,
  };
  return inbound;
}

// --- Ed25519（QQ 回调签名） --------------------------------------------------

/** bot_secret → 32 字节 seed（不足则重复，超长截断；官方 botgo 同语义） */
export function qqSigningSeed(botSecret: string): Buffer {
  if (botSecret.length === 0) return Buffer.alloc(32);
  let seed = Buffer.from(botSecret, "utf8");
  while (seed.length < 32) seed = Buffer.concat([seed, Buffer.from(botSecret, "utf8")]);
  return seed.subarray(0, 32);
}

function qqPrivateKey(botSecret: string) {
  const seed = qqSigningSeed(botSecret);
  // PKCS#8 Ed25519 私钥 DER 前缀 + 32 字节 seed
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function qqPublicKeyHex(botSecret: string): string {
  const publicKey = createPublicKey(qqPrivateKey(botSecret));
  const der = publicKey.export({ format: "der", type: "spki" });
  // SPKI 末尾 32 字节即 Ed25519 公钥
  return Buffer.from(der).subarray(-32).toString("hex");
}

export function signEd25519(botSecret: string, message: string): string {
  return sign(null, Buffer.from(message, "utf8"), qqPrivateKey(botSecret)).toString("hex");
}

export function verifyEd25519(botSecret: string, message: string, signatureHex: string): boolean {
  try {
    const publicKey = createPublicKey(qqPrivateKey(botSecret));
    const signature = Buffer.from(signatureHex, "hex");
    if (signature.length !== 64) return false;
    return verify(null, Buffer.from(message, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

// --- 内部解析 ----------------------------------------------------------------

function extractMentionIds(content: string): string[] {
  const out: string[] = [];
  const pattern = /<@!?([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const id = match[1]?.trim();
    if (id !== undefined && id.length > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

function stripMentionTags(content: string): string {
  return content.replace(/<@!?[^>]+>/g, " ");
}

function extractAttachments(value: unknown): InboundAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: InboundAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const url = nonEmpty(item.url) ?? undefined;
    const contentType = nonEmpty(item.content_type) ?? "";
    const filename = nonEmpty(item.filename) ?? undefined;
    const size = typeof item.size === "number" ? item.size : undefined;
    out.push({
      ...(url === undefined ? {} : { native_id: url, url }),
      kind: attachmentKind(contentType, filename),
      ...(filename === undefined ? {} : { name: filename }),
      ...(contentType.length === 0 ? {} : { mime_type: contentType }),
      ...(size === undefined ? {} : { size_bytes: size }),
    });
  }
  return out;
}

function attachmentKind(contentType: string, filename: string | undefined): InboundAttachment["kind"] {
  const type = contentType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/") || type.includes("voice") || type.includes("silk")) return "audio";
  if (type.length > 0) return "file";
  if (filename !== undefined && /\.(png|jpe?g|gif|webp|bmp)$/i.test(filename)) return "image";
  return "file";
}

function normalizeTimestamp(value: unknown, now: (() => Date) | undefined): string {
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return (now ?? (() => new Date()))().toISOString();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** 供测试/诊断：seed 的 hash 形态（不暴露密钥本身） */
export function qqSigningSeedFingerprint(botSecret: string): string {
  return createHash("sha256").update(qqSigningSeed(botSecret)).digest("hex").slice(0, 16);
}
