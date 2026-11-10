import type {
  ChannelTestEventFrame,
  ChannelTestRequestKind,
  ChannelTestRouteContext,
  ChannelTestServer,
} from "./channel-test-server.ts";
import { signEd25519 } from "../adapters/qq/events.ts";

/**
 * QQ 官方 Bot 协议桩（M4-T4 / Issue #41）：在共享 ChannelTestServer 上用 `route()`
 * 注册 QQ 形状的端点，**不 fork 服务器**。零真实网络、零真实凭据。
 *
 * 注册的端点（与官方 API v2 一致，唯一差别是 base_url）：
 *   POST /app/getAppAccessToken                    AppID/AppSecret → access token
 *   POST /v2/groups/{group_openid}/messages       群消息（带 msg_id = 被动回复）
 *   POST /v2/users/{user_openid}/messages         单聊消息（带 msg_id = 被动回复）
 *
 * 故障注入（与 T3 的服务端可变状态同一思路，不侵入适配器）：
 *   rejectProactive   主动消息被平台拒绝（群 304046 / 单聊 304050）
 *   rejectAllTokens   任意 access token 都判失效（刷新后仍失败 → 健康降级）
 *   failTokenEndpoint token 端点 500
 *   rateLimit 429 + Retry-After
 *   mode: "ok" | "forbidden" (403) | "hang" (不响应 → 客户端超时)
 *   expireAccessToken() 已签发 token 全部作废
 *
 * 事件：`pushMessage()` 经共享服务器的 `pushFrame()` 入队；配置 botSecret 时按
 * 官方 Ed25519 语义签名（`X-Signature-Ed25519` / `X-Signature-Timestamp`）。
 */

export type QqTestStubRequestKind = "token" | "group" | "direct";

export interface QqTestMessageRecord {
  kind: "group" | "direct";
  conversation_id: string;
  /** 被动回复引用的入站消息 id；主动消息为 null */
  msg_id: string | null;
  msg_seq: number | null;
  /** 是否主动消息（无 msg_id） */
  proactive: boolean;
  body: unknown;
  at: string;
}

export interface QqTestStubOptions {
  appId?: string;
  appSecret?: string;
  /** 配置后事件帧带 Ed25519 签名（适配器侧需同样配置 botSecret） */
  botSecret?: string;
  tokenTtlSeconds?: number;
  now?: () => Date;
}

export interface QqTestStub {
  appId: string;
  appSecret: string;
  botSecret: string | null;
  /** 主动消息被平台拒绝（策略/额度） */
  rejectProactive: boolean;
  /** 任意 access token 都判失效 */
  rejectAllTokens: boolean;
  /** token 端点失败 */
  failTokenEndpoint: boolean;
  /** 429 注入：剩余拒绝次数 + Retry-After 秒数 */
  rateLimit: { remaining: number; retryAfterSeconds: number } | null;
  /** 发送端点响应模式 */
  mode: "ok" | "forbidden" | "hang";
  /** 事件签名模式（默认 valid） */
  signatureMode: "valid" | "invalid" | "missing";

  /** 平台侧收到的消息（按到达顺序） */
  messages: QqTestMessageRecord[];
  /** 平台侧收到的群消息 / 单聊消息 */
  groupMessages: QqTestMessageRecord[];
  c2cMessages: QqTestMessageRecord[];
  /** 被拒绝的主动消息尝试（审计诊断用） */
  rejectedProactive: Array<{ kind: "group" | "direct"; conversation_id: string; code: number; at: string }>;

  /** 已签发 access token 全部作废（模拟长期运行后平台侧过期） */
  expireAccessToken(): void;
  /** 已签发 token 数量（诊断） */
  issuedTokenCount(): number;

  count(kind?: QqTestStubRequestKind | "proactive"): number;

  /** 构造 QQ 事件（不投递） */
  buildMessageEvent(input?: {
    type?: "group" | "direct";
    messageId?: string;
    conversationId?: string;
    senderId?: string;
    text?: string;
    mentionBot?: boolean;
    attachments?: Array<{ url: string; contentType?: string; filename?: string; size?: number }>;
    timestamp?: string;
  }): Record<string, unknown>;
  /** 构造事件帧（botSecret 配置时签名；signatureMode 可注入失败） */
  buildEventFrame(event: Record<string, unknown>): ChannelTestEventFrame;
  /** 事件入队（经共享服务器长轮询取走）；返回帧数 */
  pushMessage(input?: Parameters<QqTestStub["buildMessageEvent"]>[0]): number;
  /** 任意 QQ 事件入队 */
  pushEvent(event: Record<string, unknown>): number;
}

const TOKEN_PATH = "/app/getAppAccessToken";
const GROUP_RE = /^\/v2\/groups\/([^/]+)\/messages$/;
const DIRECT_RE = /^\/v2\/users\/([^/]+)\/messages$/;

interface IssuedToken {
  value: string;
  expiresAtMs: number;
}

export function registerQqTestStub(
  server: ChannelTestServer,
  options: QqTestStubOptions = {},
): QqTestStub {
  const now = options.now ?? (() => new Date());
  const appId = options.appId ?? "qq_test_app";
  const appSecret = options.appSecret ?? "qq_test_secret";
  const botSecret = options.botSecret ?? null;
  const tokenTtlSeconds = options.tokenTtlSeconds ?? 7_200;

  const tokens = new Map<string, IssuedToken>();
  const invalidated = new Set<string>();
  const groupMessages: QqTestMessageRecord[] = [];
  const c2cMessages: QqTestMessageRecord[] = [];
  const rejectedProactive: QqTestStub["rejectedProactive"] = [];
  let tokenSeq = 0;
  let messageSeq = 0;
  let nonceSeq = 0;
  let tokenRequests = 0;
  let groupRequests = 0;
  let directRequests = 0;

  const stub: QqTestStub = {
    appId,
    appSecret,
    botSecret,
    // 选项必须在此生效：曾只声明不赋值，导致 `setup({ stub: { mode: "hang" } })` 这类
    // 注入被静默忽略（测试假绿）。rateLimit 需克隆，避免消费时改动调用方对象。
    rejectProactive: options.rejectProactive ?? false,
    rejectAllTokens: options.rejectAllTokens ?? false,
    failTokenEndpoint: options.failTokenEndpoint ?? false,
    rateLimit: options.rateLimit === undefined ? null : { ...options.rateLimit },
    mode: options.mode ?? "ok",
    signatureMode: options.signatureMode ?? "valid",
    messages: [],
    groupMessages,
    c2cMessages,
    rejectedProactive,
    expireAccessToken() {
      for (const token of tokens.keys()) invalidated.add(token);
    },
    issuedTokenCount() {
      return tokens.size;
    },
    count(kind) {
      if (kind === undefined) return tokenRequests + groupRequests + directRequests;
      if (kind === "token") return tokenRequests;
      if (kind === "group") return groupRequests;
      if (kind === "direct") return directRequests;
      return [...groupMessages, ...c2cMessages].filter((record) => record.proactive).length;
    },
    buildMessageEvent(input = {}) {
      const type = input.type ?? "group";
      const seq = (messageSeq += 1);
      const messageId = input.messageId ?? `qq_in_${seq}`;
      const senderId = input.senderId ?? "qq_owner";
      const conversationId =
        input.conversationId ?? (type === "group" ? "qq_group_1" : senderId);
      const text = input.text ?? `hello ${seq}`;
      const mention = input.mentionBot === true || type === "group";
      const timestamp = input.timestamp ?? now().toISOString();
      return {
        op: 0,
        id: `evt_${messageId}`,
        t: type === "group" ? "GROUP_AT_MESSAGE_CREATE" : "C2C_MESSAGE_CREATE",
        d: {
          id: messageId,
          content: mention ? `<@!${appId}> ${text}` : text,
          timestamp,
          ...(type === "group" ? { group_openid: conversationId } : {}),
          author:
            type === "group"
              ? { id: senderId, member_openid: senderId }
              : { id: senderId, user_openid: senderId },
          ...(input.attachments === undefined
            ? {}
            : {
                attachments: input.attachments.map((attachment) => ({
                  url: attachment.url,
                  content_type: attachment.contentType ?? "application/octet-stream",
                  filename: attachment.filename ?? "file.bin",
                  size: attachment.size ?? 0,
                })),
              }),
        },
      };
    },
    buildEventFrame(event) {
      const body = JSON.stringify(event);
      const timestamp = String(Math.floor(now().getTime() / 1000));
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-signature-timestamp": timestamp,
        "x-bot-appid": appId,
      };
      if (botSecret !== null && stub.signatureMode !== "missing") {
        const message = stub.signatureMode === "invalid" ? `${timestamp}${body}:tampered` : `${timestamp}${body}`;
        headers["x-signature-ed25519"] = signEd25519(botSecret, message);
      }
      headers["x-qq-nonce"] = `nonce-${(nonceSeq += 1)}`;
      return { body, headers };
    },
    pushMessage(input) {
      return stub.pushEvent(stub.buildMessageEvent(input));
    },
    pushEvent(event) {
      return server.pushFrame(stub.buildEventFrame(event));
    },
  };

  const respondJson = (ctx: ChannelTestRouteContext, status: number, payload: unknown, headers?: Record<string, string>) =>
    ctx.respond(status, payload, headers);

  server.route(
    "POST",
    new RegExp(`^${escapeRegExp(TOKEN_PATH)}$`),
    (ctx) => {
      tokenRequests += 1;
      if (stub.failTokenEndpoint) {
        respondJson(ctx, 500, { code: 11242, message: "token endpoint failure (injected)" });
        return;
      }
      const body = asRecord(ctx.request.body) ?? {};
      if (body.appId !== appId || body.clientSecret !== appSecret) {
        respondJson(ctx, 400, { code: 11243, message: "appId or clientSecret invalid" });
        return;
      }
      const value = `qq-token-${(tokenSeq += 1)}`;
      tokens.set(value, { value, expiresAtMs: now().getTime() + tokenTtlSeconds * 1000 });
      respondJson(ctx, 200, { access_token: value, expires_in: tokenTtlSeconds });
    },
    "token",
  );

  const handleSend = (ctx: ChannelTestRouteContext, kind: "group" | "direct", conversationId: string): void => {
    if (kind === "group") groupRequests += 1;
    else directRequests += 1;

    if (stub.mode === "hang") {
      ctx.hang();
      return;
    }
    if (consumeRateLimit(ctx)) return;
    if (!authorize(ctx)) {
      respondJson(ctx, 401, { code: 11242, message: "access token verify failed" });
      return;
    }
    if (stub.mode === "forbidden") {
      respondJson(ctx, 403, { code: 11282, message: "permission not pass (injected)" });
      return;
    }

    const body = asRecord(ctx.request.body) ?? {};
    const msgId = typeof body.msg_id === "string" && body.msg_id.length > 0 ? body.msg_id : null;
    const msgSeq = typeof body.msg_seq === "number" ? body.msg_seq : null;
    const proactive = msgId === null;

    if (proactive && stub.rejectProactive) {
      const code = kind === "group" ? 304046 : 304050;
      rejectedProactive.push({ kind, conversation_id: conversationId, code, at: now().toISOString() });
      respondJson(ctx, 400, {
        code,
        message:
          kind === "group"
            ? "不允许在此群发主动消息 (injected)"
            : "私聊主动消息超过限制 (injected)",
      });
      return;
    }

    const record: QqTestMessageRecord = {
      kind,
      conversation_id: conversationId,
      msg_id: msgId,
      msg_seq: msgSeq,
      proactive,
      body: ctx.request.body,
      at: now().toISOString(),
    };
    if (kind === "group") groupMessages.push(record);
    else c2cMessages.push(record);
    stub.messages.push(record);

    respondJson(ctx, 200, {
      id: `qq_${kind}_msg_${(messageSeq += 1)}`,
      timestamp: now().toISOString(),
    });
  };

  server.route(
    "POST",
    GROUP_RE,
    (ctx) => {
      const conversationId = decodeURIComponent(GROUP_RE.exec(ctx.url.pathname)?.[1] ?? "");
      handleSend(ctx, "group", conversationId);
    },
    "custom" as ChannelTestRequestKind,
  );
  server.route(
    "POST",
    DIRECT_RE,
    (ctx) => {
      const conversationId = decodeURIComponent(DIRECT_RE.exec(ctx.url.pathname)?.[1] ?? "");
      handleSend(ctx, "direct", conversationId);
    },
    "custom" as ChannelTestRequestKind,
  );

  function authorize(ctx: ChannelTestRouteContext): boolean {
    if (stub.rejectAllTokens) return false;
    const raw = ctx.request.headers.authorization;
    const header = typeof raw === "string" ? raw : "";
    const token = header.startsWith("QQBot ") ? header.slice("QQBot ".length) : "";
    if (token.length === 0) return false;
    const issued = tokens.get(token);
    return issued !== undefined && !invalidated.has(token) && issued.expiresAtMs > now().getTime();
  }

  function consumeRateLimit(ctx: ChannelTestRouteContext): boolean {
    const limit = stub.rateLimit;
    if (limit === null || limit.remaining <= 0) return false;
    limit.remaining -= 1;
    respondJson(
      ctx,
      429,
      { code: 429, message: "too many request" },
      { "retry-after": String(limit.retryAfterSeconds) },
    );
    return true;
  }

  return stub;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
