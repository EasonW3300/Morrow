import type {
  ChannelCapabilities,
  ChannelSendReceipt,
  InboundAttachment,
  OutboundMessage,
} from "@morrow/protocol";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterHealth,
  ParseInboundResult,
} from "../../types.ts";
import { ChannelSendError } from "../../types.ts";
import type { ChannelTestEventFrame } from "../../testing/channel-test-server.ts";
import { FeishuError, FEISHU_PROACTIVE_ERROR_CODES, FEISHU_TOKEN_ERROR_CODES } from "./errors.ts";
import {
  classifyFeishuEvent,
  parseFeishuInbound,
  verifyFeishuEvent,
  type FeishuVerifyResult,
} from "./events.ts";
import type { FeishuConfig } from "./config.ts";
import { HttpLongPollEventTransport, type FeishuEventTransport } from "./transport.ts";

/**
 * 飞书自建应用 Bot 适配器（M4-T3 / Issue #40，stable baseline channel）。
 *
 * 边界（T1 契约不变）：只做协议转换——事件校验/解密/归一化、reply API 发送、错误分类、
 * capabilities/health 自报。权限/身份/白名单仍由本地入站路由决定。
 *
 * 事件订阅走**长连接**（ADR-0004 私有网络优先，无需公网回调地址）；webhook 模式仅文档
 * 说明。生产长连接由官方 WebSocket SDK 封装成 FeishuEventTransport 注入；默认
 * HttpLongPollEventTransport 与 ChannelTestServer 对齐，用于协议层全链路测试/内网桥接。
 *
 * 发送语义：
 * - 有 reply_to_native_message_id → reply API（引用原消息）；
 * - 无 → 主动消息 API（平台限制真实存在；capabilities().group_proactive = limited）；
 * - token 失效：刷新一次后重试；仍失败 → 健康降级（healthy=false + last_error）；
 * - 429/权限不足/平台明确拒收 → ChannelSendError(explicit)（Outbox 退避重试）；
 * - 超时/网络中断 → ChannelSendError(timeout|network)（Outbox 判 delivery_unknown，不重发）。
 */

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  // 飞书对主动消息有场景/频控限制（且需权限审批）——契约层绝不声明 supported
  group_proactive: "limited",
  // 入站附件只保留平台引用；出站附件投递未实现
  attachments: "limited",
  edit: "unsupported",
};

export interface FeishuChannelAdapterOptions {
  accountId?: string;
  config: FeishuConfig;
  /** Open API 基地址（默认 https://open.feishu.cn；测试改成本地 ChannelTestServer） */
  baseUrl?: string;
  /** fetch 注入（测试可观察/模拟网络错误；缺省全局 fetch） */
  fetch?: typeof fetch;
  now?: () => Date;
  /** 单次 HTTP 请求超时（毫秒，默认 10000） */
  requestTimeoutMs?: number;
  /** token 提前刷新窗口（毫秒，默认 300000 = 5 分钟） */
  tokenRefreshSkewMs?: number;
  /** 事件时间偏差容忍（秒，默认 300；0 = 不校验） */
  signatureToleranceSeconds?: number;
  /** 事件传输（缺省 = 同 baseUrl 的 HTTP 长轮询） */
  eventTransport?: FeishuEventTransport;
  /** 长轮询单次等待（毫秒，默认 1000） */
  eventPollTimeoutMs?: number;
  /** 长轮询重连等待（毫秒，默认 500） */
  eventReconnectDelayMs?: number;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

interface FeishuApiResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
  data?: { message_id?: string };
}

interface FeishuHttpResult {
  status: number;
  payload: FeishuApiResponse;
  retryAfterSeconds: number | null;
}

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly channelId = "feishu";
  readonly experimental = false;

  readonly #config: FeishuConfig;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #requestTimeoutMs: number;
  readonly #tokenRefreshSkewMs: number;
  readonly #signatureToleranceSeconds: number;
  readonly #eventTransport: FeishuEventTransport | null;
  readonly #eventPollTimeoutMs: number;
  readonly #eventReconnectDelayMs: number;

  #accountId: string;
  #onInbound: ((raw: unknown) => void) | null = null;
  #onInboundRejected: ChannelAdapterContext["onInboundRejected"] | null = null;
  #running = false;
  #connected = false;
  #degraded = false;
  #lastError: string | null = null;
  #token: CachedToken | null = null;
  #transport: FeishuEventTransport | null = null;

  constructor(options: FeishuChannelAdapterOptions) {
    this.#accountId = options.accountId ?? "feishu-default";
    this.#config = options.config;
    this.#baseUrl = (options.baseUrl ?? "https://open.feishu.cn").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 300_000;
    this.#signatureToleranceSeconds = options.signatureToleranceSeconds ?? 300;
    this.#eventTransport = options.eventTransport ?? null;
    this.#eventPollTimeoutMs = options.eventPollTimeoutMs ?? 1_000;
    this.#eventReconnectDelayMs = options.eventReconnectDelayMs ?? 500;
  }

  get accountId(): string {
    return this.#accountId;
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
        baseUrl: this.#baseUrl,
        fetch: this.#fetch,
        pollTimeoutMs: this.#eventPollTimeoutMs,
        reconnectDelayMs: this.#eventReconnectDelayMs,
      });
    this.#transport = transport;
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
   * 事件帧入口（签名 → 解密 → Verification Token → 分类）。返回结构化结果；
   * 失败时经 onInboundRejected 交给注册表落 `channel.inbound_rejected`。
   */
  handleFrame(frame: ChannelTestEventFrame): FeishuVerifyResult | { ok: true } {
    const verified = verifyFeishuEvent(frame, this.#config, {
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

    const classified = classifyFeishuEvent(verified.event);
    if (classified.kind === "message") {
      this.#connected = true;
      this.#degraded = false;
      this.#lastError = null;
      this.#onInbound?.(verified.event);
      return { ok: true };
    }
    // url_verification / 其它事件（已读回执等）不属于入站消息：安全忽略
    return { ok: true };
  }

  parseInbound(raw: unknown): ParseInboundResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, code: "invalid_inbound", message: "feishu event must be a JSON object" };
    }
    return parseFeishuInbound(raw as Record<string, unknown>, {
      channelId: this.channelId,
      accountId: this.#accountId,
      ...(this.#config.botOpenId === undefined ? {} : { botOpenId: this.#config.botOpenId }),
      now: this.#now,
    });
  }

  async send(outbound: OutboundMessage): Promise<ChannelSendReceipt> {
    if (!this.#running) {
      throw new ChannelSendError("explicit", "feishu adapter is not running", { retryable: true });
    }
    const attachments = outbound.attachments ?? [];
    if (attachments.length > 0) {
      throw new ChannelSendError(
        "explicit",
        "feishu outbound attachments are not implemented (capabilities.attachments = limited)",
        { code: "unsupported_attachment", retryable: false },
      );
    }

    try {
      let token = await this.#ensureToken();
      try {
        return await this.#sendWithToken(outbound, token);
      } catch (err) {
        if (!(err instanceof FeishuError) || err.category !== "token_invalid") throw err;
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
          return await this.#sendWithToken(outbound, token);
        } catch (retryErr) {
          if (retryErr instanceof FeishuError && retryErr.category === "token_invalid") {
            this.#degrade(new Error(`token rejected after one refresh: ${retryErr.message}`));
          }
          throw retryErr;
        }
      }
    } catch (err) {
      const feishu = toFeishuError(err);
      this.#lastError = feishu.message;
      throw feishu.toSendError();
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
        ? "feishu long connection established; tenant_access_token cached"
        : (this.#lastError ?? "feishu adapter is not ready"),
      connection,
      token_expires_at: this.#token === null ? null : new Date(this.#token.expiresAtMs).toISOString(),
      last_error: this.#lastError,
    };
  }

  capabilities(): ChannelCapabilities {
    return { ...CAPABILITIES };
  }

  // --- 内部 ----------------------------------------------------------------

  async #sendWithToken(outbound: OutboundMessage, token: string): Promise<ChannelSendReceipt> {
    const replyTo = outbound.reply_to_native_message_id;
    const proactive = replyTo === undefined;
    const path = proactive
      ? `/open-apis/im/v1/messages?receive_id_type=chat_id`
      : `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`;
    const body = proactive
      ? {
          receive_id: outbound.native_conversation_id,
          msg_type: "text",
          content: JSON.stringify({ text: outbound.text }),
        }
      : {
          msg_type: "text",
          content: JSON.stringify({ text: outbound.text }),
        };

    const response = await this.#request("POST", path, body, token);
    const payload = response.payload;

    if (response.status === 429) {
      throw new FeishuError({
        category: "rate_limited",
        message: `feishu rate limited (retry-after ${response.retryAfterSeconds ?? 1}s)`,
        httpStatus: 429,
        retryAfterSeconds: response.retryAfterSeconds ?? 1,
      });
    }
    if (response.status === 401 || (payload.code !== undefined && FEISHU_TOKEN_ERROR_CODES.has(payload.code))) {
      throw new FeishuError({
        category: "token_invalid",
        message: payload.msg ?? "tenant_access_token is invalid or expired",
        httpStatus: response.status,
        ...(payload.code === undefined ? {} : { code: payload.code }),
      });
    }
    if (response.status === 403) {
      throw new FeishuError({
        category: "permission_denied",
        message: payload.msg ?? "feishu permission denied",
        httpStatus: 403,
        ...(payload.code === undefined ? {} : { code: payload.code }),
      });
    }
    if (proactive && payload.code !== undefined && FEISHU_PROACTIVE_ERROR_CODES.has(payload.code)) {
      throw new FeishuError({
        category: "proactive_limited",
        message: payload.msg ?? "feishu proactive message is limited in this scene",
        httpStatus: response.status,
        code: payload.code,
      });
    }
    if (response.status < 200 || response.status >= 300 || payload.code !== 0) {
      throw new FeishuError({
        category: "bad_request",
        message: payload.msg ?? `feishu responded ${response.status}`,
        httpStatus: response.status,
        ...(payload.code === undefined ? {} : { code: payload.code }),
      });
    }

    const remoteMessageId = payload.data?.message_id;
    this.#degraded = false;
    this.#lastError = null;
    this.#connected = true;
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

    let response: FeishuHttpResult;
    try {
      response = await this.#request("POST", "/open-apis/auth/v3/tenant_access_token/internal", {
        app_id: this.#config.appId,
        app_secret: this.#config.appSecret,
      });
    } catch (err) {
      // token 请求失败时消息尚未发出——安全可重试（explicit），不是 delivery_unknown
      const feishu = toFeishuError(err);
      throw new FeishuError({
        category: "platform",
        message: `tenant_access_token request failed: ${feishu.message}`,
        deliveryUnknown: false,
      });
    }

    const payload = response.payload;
    if (
      response.status < 200 ||
      response.status >= 300 ||
      payload.code !== 0 ||
      typeof payload.tenant_access_token !== "string"
    ) {
      throw new FeishuError({
        category: "token_invalid",
        message: payload.msg ?? `token endpoint responded ${response.status}`,
        httpStatus: response.status,
        ...(payload.code === undefined ? {} : { code: payload.code }),
      });
    }
    const expireSeconds =
      typeof payload.expire === "number" && payload.expire > 0 ? payload.expire : 7_200;
    this.#token = {
      value: payload.tenant_access_token,
      expiresAtMs: this.#now().getTime() + expireSeconds * 1000,
    };
    return this.#token.value;
  }

  async #request(
    method: "POST" | "GET",
    path: string,
    body?: Record<string, unknown>,
    token?: string,
  ): Promise<FeishuHttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: FeishuApiResponse = {};
      if (raw.length > 0) {
        try {
          payload = JSON.parse(raw) as FeishuApiResponse;
        } catch {
          payload = { msg: `non-JSON response: ${raw.slice(0, 200)}` };
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
        throw new FeishuError({
          category: "timeout",
          message: `feishu request timed out after ${this.#requestTimeoutMs}ms`,
          deliveryUnknown: true,
        });
      }
      throw new FeishuError({
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

function toFeishuError(err: unknown): FeishuError {
  if (err instanceof FeishuError) return err;
  if (err instanceof ChannelSendError) {
    return new FeishuError({
      category: err.kind === "timeout" ? "timeout" : err.kind === "network" ? "network" : "platform",
      message: err.message,
      deliveryUnknown: err.kind !== "explicit",
    });
  }
  return new FeishuError({
    category: "network",
    message: err instanceof Error ? err.message : String(err),
    deliveryUnknown: true,
  });
}
