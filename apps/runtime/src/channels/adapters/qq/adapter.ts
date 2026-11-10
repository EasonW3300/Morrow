import type {
  ChannelCapabilities,
  ChannelSendReceipt,
  OutboundMessage,
} from "@morrow/protocol";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterHealth,
  ParseInboundResult,
} from "../../types.ts";
import { ChannelSendError, isParseError } from "../../types.ts";
import type { ChannelTestEventFrame } from "../../testing/channel-test-server.ts";
import { HttpLongPollEventTransport, type EventTransport } from "../../event-transport.ts";
import { isQqWebSocketTransport } from "./websocket-transport.ts";
import {
  QqError,
  QQ_PERMISSION_ERROR_CODES,
  QQ_PROACTIVE_REJECT_CODES,
  QQ_TOKEN_ERROR_CODES,
  isQqRateLimitCode,
} from "./errors.ts";
import {
  classifyQqEvent,
  parseQqInbound,
  verifyQqEvent,
  type QqVerifyResult,
} from "./events.ts";
import type { QqConfig } from "./config.ts";

/**
 * QQ 官方 Bot 适配器（M4-T4 / Issue #41，stable baseline channel）。
 *
 * 边界（T1 契约不变）：只做协议转换——事件校验/归一化、群/私聊消息 API 发送、
 * 错误分类、capabilities/health 自报。权限/身份/白名单仍由本地入站路由决定。
 *
 * 与飞书（T3）的差异（显式处理）：
 * - 鉴权：AppID/AppSecret → `POST /app/getAppAccessToken` 换 access token，
 *   头为 `Authorization: QQBot <token>`；token 缓存 + 提前刷新 + 失效重试一次；
 * - 目标：群消息 `/v2/groups/{group_openid}/messages`、私聊
 *   `/v2/users/{user_openid}/messages`（两条 API，需知道会话形态；由入站事件学习，
 *   `conversationKinds` 选项可预注册，未知形态显式失败而非猜测）；
 * - 被动/主动：带 `msg_id` = 被动回复（引用原消息，`msg_seq` 递增避免平台判重）；
 *   不带 = 主动消息（平台有场景/额度限制，`capabilities().group_proactive = limited`）；
 * - 主动消息被拒 → `proactive_rejected`（explicit + 不可重试）→ Outbox 直接
 *   needs_review，不自动重发；
 * - 事件签名：配置 `bot_secret` 后 Webhook 模式强制 Ed25519 校验（真实公网回调语义）；
 *   真实平台推荐用 `QqWebSocketTransport`（官方网关、无需公网回调，见
 *   `websocket-transport.ts`）：WS Dispatch 由 access token 鉴权，走
 *   `handleTrustedEvent`；未配置 bot_secret 时的 HTTP 长轮询/内网桥接仍走 `handleFrame`。
 */

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  // QQ 主动消息受平台场景/额度强限制（且用户可关闭「允许主动发送」）——绝不声明 supported
  group_proactive: "limited",
  // 入站附件只保留平台 URL 引用；出站富媒体需先上传，未实现
  attachments: "limited",
  edit: "unsupported",
};

export interface QqChannelAdapterOptions {
  accountId?: string;
  config: QqConfig;
  /** Bot API 基地址（默认 https://api.sgroup.qq.com；测试改成本地 ChannelTestServer） */
  apiBaseUrl?: string;
  /**
   * access token 端点覆盖（默认 https://api.bot.qq.com/app/getAppAccessToken；
   * 部分旧文档/SDK 用 https://bots.qq.com/app/getAppAccessToken，可在此覆盖）。
   * config.tokenEndpoint 优先于本选项（SecretStore 覆盖运行时选项）。
   */
  tokenEndpoint?: string;
  /** fetch 注入（测试可观察/模拟网络错误；缺省全局 fetch） */
  fetch?: typeof fetch;
  now?: () => Date;
  /** 单次 HTTP 请求超时（毫秒，默认 10000） */
  requestTimeoutMs?: number;
  /** token 提前刷新窗口（毫秒，默认 300000 = 5 分钟） */
  tokenRefreshSkewMs?: number;
  /** 事件时间偏差容忍（秒，默认 300；0 = 不校验） */
  signatureToleranceSeconds?: number;
  /**
   * 事件传输。生产传 `QqWebSocketTransport`（QQ 官方 WebSocket 网关；无需公网回调）；
   * 缺省 = apiBaseUrl 上的 HTTP 长轮询，与 ChannelTestServer 对齐。
   */
  eventTransport?: EventTransport;
  /** 长轮询路径（默认 /open-apis/event/v1/stream，与共享协议桩对齐） */
  eventStreamPath?: string;
  /** 长轮询单次等待（毫秒，默认 1000） */
  eventPollTimeoutMs?: number;
  /** 长轮询重连等待（毫秒，默认 500） */
  eventReconnectDelayMs?: number;
  /**
   * 预注册会话形态（native_conversation_id → group|direct）。入站消息会自动学习；
   * 主动消息（通知等）要发往从未入站的会话时，必须在此显式登记。
   */
  conversationKinds?: Record<string, "group" | "direct">;
  /** 未知会话形态时的缺省（默认不猜测：显式失败） */
  defaultConversationKind?: "group" | "direct";
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

interface QqApiResponse {
  code?: number;
  message?: string;
  msg?: string;
  access_token?: string;
  expires_in?: number | string;
  id?: string;
  timestamp?: string | number;
}

interface QqHttpResult {
  status: number;
  payload: QqApiResponse;
  retryAfterSeconds: number | null;
}

const DEFAULT_API_BASE_URL = "https://api.sgroup.qq.com";
/** 官方当前文档指向 api.bot.qq.com；旧文档/部分 SDK 仍用 bots.qq.com，可用配置覆盖 */
const DEFAULT_TOKEN_ENDPOINT = "https://api.bot.qq.com/app/getAppAccessToken";

export class QqChannelAdapter implements ChannelAdapter {
  readonly channelId = "qq";
  readonly experimental = false;

  readonly #config: QqConfig;
  readonly #apiBaseUrl: string;
  readonly #tokenEndpoint: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #requestTimeoutMs: number;
  readonly #tokenRefreshSkewMs: number;
  readonly #signatureToleranceSeconds: number;
  readonly #eventTransport: EventTransport | null;
  readonly #eventStreamPath: string;
  readonly #eventPollTimeoutMs: number;
  readonly #eventReconnectDelayMs: number;
  readonly #defaultConversationKind: "group" | "direct" | null;
  readonly #conversationKinds = new Map<string, "group" | "direct">();
  /** 每条入站消息已被引用回复的次数（QQ 要求 msg_id + msg_seq 组合唯一，递增避免判重） */
  readonly #replySeq = new Map<string, number>();

  #accountId: string;
  #onInbound: ((raw: unknown) => void) | null = null;
  #onInboundRejected: ChannelAdapterContext["onInboundRejected"] | null = null;
  #running = false;
  #connected = false;
  #degraded = false;
  #lastError: string | null = null;
  #token: CachedToken | null = null;
  #transport: EventTransport | null = null;

  constructor(options: QqChannelAdapterOptions) {
    this.#accountId = options.accountId ?? "qq-default";
    this.#config = options.config;
    this.#apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.#tokenEndpoint = options.config.tokenEndpoint ?? options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 300_000;
    this.#signatureToleranceSeconds = options.signatureToleranceSeconds ?? 300;
    this.#eventTransport = options.eventTransport ?? null;
    this.#eventStreamPath = options.eventStreamPath ?? "/open-apis/event/v1/stream";
    this.#eventPollTimeoutMs = options.eventPollTimeoutMs ?? 1_000;
    this.#eventReconnectDelayMs = options.eventReconnectDelayMs ?? 500;
    this.#defaultConversationKind = options.defaultConversationKind ?? null;
    for (const [id, kind] of Object.entries(options.conversationKinds ?? {})) {
      this.#conversationKinds.set(id, kind);
    }
  }

  get accountId(): string {
    return this.#accountId;
  }

  /** 主动消息目标形态登记（生产宿主可从渠道白名单/配置调用；入站会自动学习） */
  rememberConversationKind(id: string, kind: "group" | "direct"): void {
    this.#conversationKinds.set(id, kind);
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    this.#accountId = context.accountId;
    this.#onInbound = context.onInbound;
    this.#onInboundRejected = context.onInboundRejected ?? null;
    this.#running = true;
    this.#connected = true;
    this.#degraded = false;
    this.#lastError = null;

    // 预热 token：失败不阻断 start（健康检查暴露原因），首次 send 会再尝试
    try {
      await this.#ensureToken();
    } catch (err) {
      this.#degrade(err);
    }

    const transport =
      this.#eventTransport ??
      new HttpLongPollEventTransport({
        baseUrl: this.#apiBaseUrl,
        fetch: this.#fetch,
        pollTimeoutMs: this.#eventPollTimeoutMs,
        reconnectDelayMs: this.#eventReconnectDelayMs,
        streamPath: this.#eventStreamPath,
      });
    this.#transport = transport;
    if (isQqWebSocketTransport(transport)) {
      // WS 传输与适配器共用同一份 access token 缓存/刷新逻辑；Dispatch 走可信入口
      // （见 handleTrustedEvent 的信任边界说明），不走 Ed25519 的 handleFrame。
      transport.attachTokenProvider({
        getAccessToken: () => this.#ensureToken(),
        refreshAccessToken: () => this.#ensureToken(true),
      });
      transport.attachTrustedEventSink((event) => this.handleTrustedEvent(event));
    }
    transport.start(
      (frame) => this.handleFrame(frame),
      (error) => {
        if (!this.#running) return;
        this.#connected = false;
        this.#degraded = true;
        this.#lastError = `event stream: ${error.message}`;
      },
    );
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#connected = false;
    await this.#transport?.stop();
    this.#transport = null;
    this.#onInbound = null;
    this.#onInboundRejected = null;
  }

  /**
   * 事件帧入口（签名 → 解析 → 分类）。返回结构化结果；失败时经 onInboundRejected
   * 交给注册表落 `channel.inbound_rejected`。op 13 回调校验不进入会话链路。
   */
  handleFrame(frame: ChannelTestEventFrame): QqVerifyResult | { ok: true } {
    const verified = verifyQqEvent(frame, this.#config, {
      toleranceSeconds: this.#signatureToleranceSeconds,
      now: this.#now,
    });
    if (!verified.ok) {
      this.#lastError = `${verified.code}: ${verified.message}`;
      this.#onInboundRejected?.({
        code: verified.code,
        message: verified.message,
        raw: { headers: frame.headers },
      });
      return verified;
    }

    const classified = classifyQqEvent(verified.event);
    if (classified.kind === "message") {
      this.#connected = true;
      this.#degraded = false;
      this.#lastError = null;
      this.#onInbound?.(verified.event);
      return { ok: true };
    }
    return { ok: true };
  }

  /**
   * 已鉴权 WS 事件入口（QQ 官方 WebSocket 网关专用）。
   *
   * 信任边界：只允许 `QqWebSocketTransport` 调用。该传输在 Identify 时用
   * `QQBot <access_token>` 完成网关鉴权，之后的 Dispatch 都由平台在**已认证连接**
   * 上推送；网关协议没有 Webhook 的 `X-Signature-Ed25519` 帧签名（那是公网回调
   * 防伪用的），因此这里跳过 `verifyQqEvent` 的签名校验，保留 classify 的结构校验
   * 与拒绝留痕。Webhook 模式（带 bot_secret）继续走 `handleFrame`。
   *
   * 其它来源（HTTP 请求体、UI、本地文件）**不得**调用本方法——否则等于绕过签名。
   */
  handleTrustedEvent(event: unknown): QqVerifyResult | { ok: true } {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      const result = {
        ok: false as const,
        code: "invalid_body",
        message: "qq websocket event must be a JSON object",
      };
      this.#lastError = `${result.code}: ${result.message}`;
      this.#onInboundRejected?.({
        code: result.code,
        message: result.message,
        raw: {},
      });
      return result;
    }

    const record = event as Record<string, unknown>;
    const classified = classifyQqEvent(record);
    if (classified.kind === "message") {
      // 学会话形态（group / direct）：`send()` 据此选择 /v2/groups/* 还是 /v2/users/*，
      // 未学过就会以 unknown_conversation 拒发。Webhook 路径由调用的 parseInbound 学习，
      // WS 路径没有经过那里——真实联调中就是这里漏掉，导致"收到消息但回不出去"。
      const parsed = this.parseInbound(record);
      if (isParseError(parsed)) {
        this.#lastError = `${parsed.code}: ${parsed.message}`;
        this.#onInboundRejected?.({
          code: parsed.code,
          message: parsed.message,
          raw: record,
        });
        return { ok: true };
      }
      this.#connected = true;
      this.#degraded = false;
      this.#lastError = null;
      this.#onInbound?.(record);
    }
    return { ok: true };
  }

  parseInbound(raw: unknown): ParseInboundResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, code: "invalid_inbound", message: "qq event must be a JSON object" };
    }
    const parsed = parseQqInbound(raw as Record<string, unknown>, {
      channelId: this.channelId,
      accountId: this.#accountId,
      ...(this.#config.appId.length === 0 ? {} : { botOpenId: this.#config.appId }),
      now: this.#now,
    });
    // 入站时学习会话形态，供后续回复/主动消息选择正确的 API 端点
    if (!isParseError(parsed)) {
      this.#conversationKinds.set(parsed.native_conversation_id, parsed.conversation_kind);
    }
    return parsed;
  }

  async send(outbound: OutboundMessage): Promise<ChannelSendReceipt> {
    if (!this.#running) {
      throw new ChannelSendError("explicit", "qq adapter is not running", { retryable: true });
    }
    const attachments = outbound.attachments ?? [];
    if (attachments.length > 0) {
      throw new ChannelSendError(
        "explicit",
        "qq outbound attachments are not implemented (capabilities.attachments = limited)",
        { code: "unsupported_attachment", retryable: false },
      );
    }

    const kind =
      this.#conversationKinds.get(outbound.native_conversation_id) ?? this.#defaultConversationKind;
    if (kind === null) {
      throw new ChannelSendError(
        "explicit",
        `unknown qq conversation kind for "${outbound.native_conversation_id}" (register conversationKinds)`,
        { code: "unknown_conversation", retryable: false },
      );
    }

    try {
      let token = await this.#ensureToken();
      try {
        return await this.#sendWithToken(outbound, kind, token);
      } catch (err) {
        if (!(err instanceof QqError) || err.category !== "token_invalid") throw err;
        // token 失效：强制刷新一次后重试；仍失败则健康降级（票面验收口径）
        this.#token = null;
        this.#lastError = `token refresh after ${err.message}`;
        try {
          token = await this.#ensureToken(true);
        } catch (refreshErr) {
          this.#degrade(refreshErr);
          throw refreshErr;
        }
        try {
          return await this.#sendWithToken(outbound, kind, token);
        } catch (retryErr) {
          if (retryErr instanceof QqError && retryErr.category === "token_invalid") {
            this.#degrade(new Error(`token rejected after one refresh: ${retryErr.message}`));
          }
          throw retryErr;
        }
      }
    } catch (err) {
      const qq = toQqError(err);
      this.#lastError = `${qq.category}: ${qq.message}`;
      throw qq.toSendError();
    }
  }

  health(): ChannelAdapterHealth {
    const tokenValid =
      this.#token === null ? false : this.#token.expiresAtMs > this.#now().getTime() + this.#tokenRefreshSkewMs;
    const healthy = this.#running && this.#connected && !this.#degraded && tokenValid;
    const connection = !this.#running
      ? "disconnected"
      : this.#degraded
        ? "degraded"
        : this.#connected
          ? "connected"
          : "connecting";
    return {
      healthy,
      detail: healthy
        ? "qq event stream established; access_token cached"
        : (this.#lastError ?? "qq adapter is not ready"),
      connection,
      token_expires_at: this.#token === null ? null : new Date(this.#token.expiresAtMs).toISOString(),
      last_error: this.#lastError,
    };
  }

  capabilities(): ChannelCapabilities {
    return { ...CAPABILITIES };
  }

  // --- 内部 ----------------------------------------------------------------

  async #sendWithToken(
    outbound: OutboundMessage,
    kind: "group" | "direct",
    token: string,
  ): Promise<ChannelSendReceipt> {
    const replyTo = outbound.reply_to_native_message_id;
    const proactive = replyTo === undefined;
    const path =
      kind === "group"
        ? `/v2/groups/${encodeURIComponent(outbound.native_conversation_id)}/messages`
        : `/v2/users/${encodeURIComponent(outbound.native_conversation_id)}/messages`;

    const body: Record<string, unknown> = {
      content: outbound.text,
      msg_type: 0,
    };
    if (replyTo !== undefined) {
      body.msg_id = replyTo;
      const seq = (this.#replySeq.get(replyTo) ?? 0) + 1;
      this.#replySeq.set(replyTo, seq);
      body.msg_seq = seq;
    }

    const response = await this.#request("POST", path, body, token);
    const payload = response.payload;
    const code = payload.code;
    const message = payload.message ?? payload.msg ?? "";

    if (response.status === 429 || isQqRateLimitCode(code)) {
      throw new QqError({
        category: "rate_limited",
        message: message.length > 0 ? message : `qq rate limited (retry-after ${response.retryAfterSeconds ?? 1}s)`,
        httpStatus: response.status,
        ...(code === undefined ? {} : { code }),
        retryAfterSeconds: response.retryAfterSeconds ?? 1,
      });
    }
    if (response.status === 401 || (code !== undefined && QQ_TOKEN_ERROR_CODES.has(code))) {
      throw new QqError({
        category: "token_invalid",
        message: message.length > 0 ? message : "qq access token is invalid or expired",
        httpStatus: response.status,
        ...(code === undefined ? {} : { code }),
      });
    }
    if (
      proactive &&
      ((code !== undefined && QQ_PROACTIVE_REJECT_CODES.has(code)) ||
        /主动消息|active message|proactive/i.test(message))
    ) {
      throw new QqError({
        category: "proactive_rejected",
        message: message.length > 0 ? message : "qq proactive message rejected by platform policy",
        httpStatus: response.status,
        ...(code === undefined ? {} : { code }),
      });
    }
    if (response.status === 403 || (code !== undefined && QQ_PERMISSION_ERROR_CODES.has(code))) {
      throw new QqError({
        category: "permission_denied",
        message: message.length > 0 ? message : "qq permission denied",
        httpStatus: 403,
        ...(code === undefined ? {} : { code }),
      });
    }
    if (response.status < 200 || response.status >= 300 || (code !== undefined && code !== 0)) {
      throw new QqError({
        category: "bad_request",
        message: message.length > 0 ? message : `qq responded ${response.status}`,
        httpStatus: response.status,
        ...(code === undefined ? {} : { code }),
      });
    }

    this.#degraded = false;
    this.#lastError = null;
    this.#connected = true;
    const remoteMessageId = typeof payload.id === "string" ? payload.id : undefined;
    return {
      channel: this.channelId,
      ...(remoteMessageId === undefined ? {} : { remote_message_id: remoteMessageId }),
      delivered_at: this.#now().toISOString(),
    };
  }

  async #ensureToken(force = false): Promise<string> {
    const nowMs = this.#now().getTime();
    if (
      !force &&
      this.#token !== null &&
      this.#token.expiresAtMs - this.#tokenRefreshSkewMs > nowMs
    ) {
      return this.#token.value;
    }

    let response: QqHttpResult;
    try {
      response = await this.#request("POST", this.#tokenEndpoint, {
        appId: this.#config.appId,
        clientSecret: this.#config.appSecret,
      });
    } catch (err) {
      // token 请求失败时消息尚未发出——安全可重试（explicit），不是 delivery_unknown
      const qq = toQqError(err);
      throw new QqError({
        category: "platform",
        message: `qq access token request failed: ${qq.message}`,
        deliveryUnknown: false,
      });
    }

    const payload = response.payload;
    if (
      response.status < 200 ||
      response.status >= 300 ||
      typeof payload.access_token !== "string" ||
      payload.access_token.length === 0
    ) {
      throw new QqError({
        category: "token_invalid",
        message: payload.message ?? payload.msg ?? `qq token endpoint responded ${response.status}`,
        httpStatus: response.status,
        ...(payload.code === undefined ? {} : { code: payload.code }),
      });
    }
    const expiresSeconds = parseExpiresIn(payload.expires_in);
    this.#token = {
      value: payload.access_token,
      expiresAtMs: this.#now().getTime() + expiresSeconds * 1000,
    };
    return this.#token.value;
  }

  async #request(
    method: "POST" | "GET",
    pathOrUrl: string,
    body?: Record<string, unknown>,
    token?: string,
  ): Promise<QqHttpResult> {
    const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
      ? pathOrUrl
      : `${this.#apiBaseUrl}${pathOrUrl}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
          // QQ 官方鉴权头（Access Token），与飞书的 Bearer 不同
          ...(token === undefined ? {} : { authorization: `QQBot ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: QqApiResponse = {};
      if (raw.length > 0) {
        try {
          payload = JSON.parse(raw) as QqApiResponse;
        } catch {
          payload = { message: `non-JSON response: ${raw.slice(0, 200)}` };
        }
      }
      const retryAfterRaw = response.headers.get("retry-after");
      const retryAfter = retryAfterRaw === null ? null : Number(retryAfterRaw);
      return {
        status: response.status,
        payload,
        retryAfterSeconds: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
      };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new QqError({
          category: "timeout",
          message: `qq request timed out after ${this.#requestTimeoutMs}ms`,
          deliveryUnknown: true,
        });
      }
      throw new QqError({
        category: "network",
        message: err instanceof Error ? err.message : String(err),
        deliveryUnknown: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #degrade(err: unknown): void {
    this.#degraded = true;
    this.#lastError = err instanceof Error ? err.message : String(err);
  }
}

function parseExpiresIn(value: number | string | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : 7_200;
}

function toQqError(err: unknown): QqError {
  if (err instanceof QqError) return err;
  if (err instanceof ChannelSendError) {
    return new QqError({
      category: err.kind === "timeout" ? "timeout" : err.kind === "network" ? "network" : "platform",
      message: err.message,
      deliveryUnknown: err.kind !== "explicit",
    });
  }
  return new QqError({
    category: "network",
    message: err instanceof Error ? err.message : String(err),
    deliveryUnknown: true,
  });
}
