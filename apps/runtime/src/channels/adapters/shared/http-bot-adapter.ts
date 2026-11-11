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
import { ChannelSendError } from "../../types.ts";
import type { ChannelTestEventFrame } from "../../testing/channel-test-server.ts";
import { HttpLongPollEventTransport, type EventTransport } from "../../event-transport.ts";
import {
  BotPlatformError,
  classifySendFailure,
  type BotPlatformErrorOptions,
  type ClassifiedSendFailure,
  type SendErrorRule,
} from "./error-catalog.ts";

/**
 * HTTP Bot 适配器公共骨架（Issue #49）。
 *
 * 收敛飞书（M4-T3）与 QQ（M4-T4）逐行重复的骨架：token 缓存与提前刷新、token 失效
 * 重试一次后健康降级、`request`（超时/错误分类/非 JSON 兜底）、`send` 编排、
 * `health()`、`capabilities()`、事件帧入口（拒绝留痕 + 入站回调）。
 *
 * 平台差异全部落在子类的少量钩子上：
 *   verifyFrame / isInboundEvent  事件签名与分类
 *   buildTokenRequest / spec.readToken / spec.readPlatformMessage / spec.sendErrorRules
 *   prepareSend / buildSendRequest / spec.readRemoteMessageId
 *   createError / formatSendFailure（平台错误类与日志文案）
 *   attachTransport（QQ WebSocket 传输的 token provider 与可信事件 sink 注入）
 *
 * 行为不变是硬约束：错误类别/文案、`capabilities()` 矩阵、`health()` 字段与
 * `last_error` 口径均与重构前逐字一致（既有测试是安全网，不允许改断言）。
 */

export interface BotHttpResult {
  status: number;
  payload: Record<string, unknown>;
  retryAfterSeconds: number | null;
}

/** 事件校验结果（飞书/QQ 的 VerifyResult 结构一致，此处只取共用部分） */
export type BotVerifyResult =
  | { ok: true; event: Record<string, unknown>; body: Record<string, unknown> }
  | { ok: false; code: string; message: string };

/** token 端点响应的解析结果：成功给 token/有效期，失败给统一分类 */
export type ReadTokenResult =
  | { ok: true; value: string; expiresInSeconds: number }
  | { ok: false; failure: ClassifiedSendFailure };

/**
 * 平台静态差异表（构造时传入，子类不持有可变状态）：
 * 鉴权头形态、token 端点响应解析、错误码规则表、响应文案字段、健康文案。
 */
export interface BotChannelSpec {
  channelId: string;
  /** 文案前缀（"feishu" / "qq"）：日志、健康、统一发送错误 */
  label: string;
  defaultAccountId: string;
  capabilities: ChannelCapabilities;
  /** healthy=true 时的 health().detail 文案 */
  healthyDetail: string;
  /** Authorization 头形态（"Bearer" / "QQBot"） */
  authScheme: string;
  /** token 请求失败文案前缀（飞书 "tenant_access_token" / QQ "qq access token"） */
  tokenLabel: string;
  /** 非 JSON 响应的兜底消息字段（飞书 msg / QQ message） */
  nonJsonMessageKey: "msg" | "message";
  /** 表驱动「响应 → 统一错误类别」规则表（顺序即优先级） */
  sendErrorRules: readonly SendErrorRule[];
  /** 平台错误文案归一化（缺省 undefined 表示缺失） */
  readPlatformMessage(payload: Record<string, unknown>): string | undefined;
  /** token 端点响应解析（TTL 缺省值与类型差异在平台侧处理） */
  readToken(response: BotHttpResult): ReadTokenResult;
  /** 成功响应里的平台消息 id（飞书 data.message_id / QQ id） */
  readRemoteMessageId(payload: Record<string, unknown>): string | undefined;
}

export interface HttpBotAdapterOptions {
  /** 渠道账号 id（缺省取平台 spec 的 defaultAccountId） */
  accountId?: string;
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 单次 HTTP 请求超时（毫秒，默认 10000） */
  requestTimeoutMs?: number;
  /** token 提前刷新窗口（毫秒，默认 300000 = 5 分钟） */
  tokenRefreshSkewMs?: number;
  /** 事件时间偏差容忍（秒，默认 300；0 = 不校验） */
  signatureToleranceSeconds?: number;
  /** 事件传输（缺省 = baseUrl 上的 HTTP 长轮询） */
  eventTransport?: EventTransport | null;
  /** 长轮询路径（缺省 = 共享传输的默认飞书形状） */
  eventStreamPath?: string;
  /** 长轮询单次等待（毫秒，默认 1000） */
  eventPollTimeoutMs?: number;
  /** 长轮询重连等待（毫秒，默认 500） */
  eventReconnectDelayMs?: number;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

export abstract class HttpBotAdapter<
  TError extends BotPlatformError = BotPlatformError,
  TVerify extends BotVerifyResult = BotVerifyResult,
  TSendContext = undefined,
> implements ChannelAdapter {
  readonly channelId: string;
  readonly experimental = false;

  readonly #spec: BotChannelSpec;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #requestTimeoutMs: number;
  readonly #tokenRefreshSkewMs: number;
  readonly #signatureTolerance: number;
  readonly #eventTransport: EventTransport | null;
  readonly #eventStreamPath: string | undefined;
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
  #transport: EventTransport | null = null;

  constructor(spec: BotChannelSpec, options: HttpBotAdapterOptions) {
    this.channelId = spec.channelId;
    this.#spec = spec;
    this.#accountId = options.accountId ?? spec.defaultAccountId;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 300_000;
    this.#signatureTolerance = options.signatureToleranceSeconds ?? 300;
    this.#eventTransport = options.eventTransport ?? null;
    this.#eventStreamPath = options.eventStreamPath;
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
      await this.ensureToken();
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
        ...(this.#eventStreamPath === undefined ? {} : { streamPath: this.#eventStreamPath }),
      });
    this.#transport = transport;
    this.attachTransport(transport);
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
   * 事件帧入口（签名 → 解密 → 解析 → 分类）。返回结构化结果；失败时经
   * onInboundRejected 交给注册表落 `channel.inbound_rejected`。
   */
  handleFrame(frame: ChannelTestEventFrame): TVerify | { ok: true } {
    const verified: BotVerifyResult = this.verifyFrame(frame);
    if (!verified.ok) {
      this.rejectInbound(verified.code, verified.message, { headers: frame.headers });
      return verified as TVerify;
    }

    if (this.isInboundEvent(verified.event)) {
      this.deliverInbound(verified.event);
    }
    // url_verification / 已读回执等非入站事件：安全忽略
    return { ok: true };
  }

  abstract parseInbound(raw: unknown): ParseInboundResult;

  async send(outbound: OutboundMessage): Promise<ChannelSendReceipt> {
    if (!this.#running) {
      throw new ChannelSendError("explicit", `${this.#spec.label} adapter is not running`, {
        retryable: true,
      });
    }
    const attachments = outbound.attachments ?? [];
    if (attachments.length > 0) {
      throw new ChannelSendError(
        "explicit",
        `${this.#spec.label} outbound attachments are not implemented (capabilities.attachments = limited)`,
        { code: "unsupported_attachment", retryable: false },
      );
    }

    // 平台目标解析在 try 之外：不可解析的目标（如 QQ 未知会话形态）必须原样抛
    // explicit/unknown_conversation，不能被下面的错误归一化吞成 platform。
    const context = this.prepareSend(outbound);

    try {
      let token = await this.ensureToken();
      try {
        return await this.#deliver(outbound, context, token);
      } catch (err) {
        if (!(err instanceof BotPlatformError) || err.category !== "token_invalid") throw err;
        // token 失效：强制刷新一次后重试；仍失败则健康降级（票面验收口径）
        this.#token = null;
        this.#lastError = `token refresh after ${err.message}`;
        try {
          token = await this.ensureToken(true);
        } catch (refreshErr) {
          this.#degrade(refreshErr);
          throw refreshErr;
        }
        try {
          return await this.#deliver(outbound, context, token);
        } catch (retryErr) {
          if (retryErr instanceof BotPlatformError && retryErr.category === "token_invalid") {
            this.#degrade(new Error(`token rejected after one refresh: ${retryErr.message}`));
          }
          throw retryErr;
        }
      }
    } catch (err) {
      const platform = this.fromUnknownError(err);
      this.#lastError = this.formatSendFailure(platform);
      throw platform.toSendError();
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
      detail: healthy ? this.#spec.healthyDetail : (this.#lastError ?? `${this.#spec.label} adapter is not ready`),
      connection,
      token_expires_at: this.#token === null ? null : new Date(this.#token.expiresAtMs).toISOString(),
      last_error: this.#lastError,
    };
  }

  capabilities(): ChannelCapabilities {
    return { ...this.#spec.capabilities };
  }

  // --- 骨架能力（供子类复用，不对外） --------------------------------------

  protected get clock(): () => Date {
    return this.#now;
  }

  protected get signatureToleranceSeconds(): number {
    return this.#signatureTolerance;
  }

  protected get isRunning(): boolean {
    return this.#running;
  }

  /** 收到/发出有效事件后清空故障态（connected + 未降级 + 无最近错误） */
  protected markHealthy(): void {
    this.#connected = true;
    this.#degraded = false;
    this.#lastError = null;
  }

  /** 入站消息出口：先标记健康，再交给 registry（QQ 可信入口也走这里） */
  protected deliverInbound(raw: unknown): void {
    this.markHealthy();
    this.#onInbound?.(raw);
  }

  /** 入站拒绝留痕：记录最近错误并交给 registry 落 `channel.inbound_rejected` */
  protected rejectInbound(code: string, message: string, raw: unknown): void {
    this.#lastError = `${code}: ${message}`;
    this.#onInboundRejected?.({ code, message, raw });
  }

  protected async ensureToken(force = false): Promise<string> {
    const nowMs = this.#now().getTime();
    if (!force && this.#token !== null && this.#token.expiresAtMs - this.#tokenRefreshSkewMs > nowMs) {
      return this.#token.value;
    }

    const request = this.buildTokenRequest();
    let response: BotHttpResult;
    try {
      response = await this.request("POST", request.pathOrUrl, request.body);
    } catch (err) {
      // token 请求失败时消息尚未发出——安全可重试（explicit），不是 delivery_unknown
      const platform = this.fromUnknownError(err);
      throw this.createError({
        category: "platform",
        message: `${this.#spec.tokenLabel} request failed: ${platform.message}`,
        deliveryUnknown: false,
      });
    }

    const parsed = this.#spec.readToken(response);
    if (!parsed.ok) throw this.createError(parsed.failure);
    this.#token = {
      value: parsed.value,
      expiresAtMs: this.#now().getTime() + parsed.expiresInSeconds * 1000,
    };
    return this.#token.value;
  }

  protected async request(
    method: "POST" | "GET",
    pathOrUrl: string,
    body?: Record<string, unknown>,
    token?: string,
  ): Promise<BotHttpResult> {
    const url =
      pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
        ? pathOrUrl
        : `${this.#baseUrl}${pathOrUrl}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
          ...(token === undefined ? {} : { authorization: `${this.#spec.authScheme} ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: Record<string, unknown> = {};
      if (raw.length > 0) {
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          payload = { [this.#spec.nonJsonMessageKey]: `non-JSON response: ${raw.slice(0, 200)}` };
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
        throw this.createError({
          category: "timeout",
          message: `${this.#spec.label} request timed out after ${this.#requestTimeoutMs}ms`,
          deliveryUnknown: true,
        });
      }
      throw this.createError({
        category: "network",
        message: err instanceof Error ? err.message : String(err),
        deliveryUnknown: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // --- 平台差异（子类只提供这些） ------------------------------------------

  /** 事件签名/解密/Verification Token 校验（飞书 AES+token、QQ Ed25519+op13） */
  protected abstract verifyFrame(frame: ChannelTestEventFrame): TVerify;
  /** 已通过校验的事件是否为入站消息（url_verification/回执等应返回 false） */
  protected abstract isInboundEvent(event: Record<string, unknown>): boolean;
  /** token 端点与请求体（飞书 app_id/app_secret、QQ appId/clientSecret） */
  protected abstract buildTokenRequest(): { pathOrUrl: string; body: Record<string, unknown> };
  /** 发送前的平台目标解析（QQ 据此选群/私聊端点；飞书无上下文） */
  protected abstract prepareSend(outbound: OutboundMessage): TSendContext;
  /** 发送端点与请求体（飞书 reply vs 主动消息、QQ msg_id+msg_seq） */
  protected abstract buildSendRequest(
    outbound: OutboundMessage,
    context: TSendContext,
  ): { pathOrUrl: string; body: Record<string, unknown> };
  /** 平台错误对象构造（FeishuError / QqError） */
  protected abstract createError(options: BotPlatformErrorOptions): TError;

  /** 任意异常 → 平台错误（网络/超时保留 delivery_unknown 语义） */
  protected fromUnknownError(err: unknown): TError {
    if (err instanceof BotPlatformError) return err as TError;
    if (err instanceof ChannelSendError) {
      return this.createError({
        category: err.kind === "timeout" ? "timeout" : err.kind === "network" ? "network" : "platform",
        message: err.message,
        deliveryUnknown: err.kind !== "explicit",
      });
    }
    return this.createError({
      category: "network",
      message: err instanceof Error ? err.message : String(err),
      deliveryUnknown: true,
    });
  }

  /** 最近错误文案（飞书只存 message；QQ 带 `category:` 前缀，均为既有日志口径） */
  protected formatSendFailure(err: TError): string {
    return err.message;
  }

  /** 传输创建后的注入点（QQ WebSocket 传输在这里接 token provider/可信 sink） */
  protected attachTransport(_transport: EventTransport): void {}

  // --- 内部 ----------------------------------------------------------------

  async #deliver(
    outbound: OutboundMessage,
    context: TSendContext,
    token: string,
  ): Promise<ChannelSendReceipt> {
    const request = this.buildSendRequest(outbound, context);
    const response = await this.request("POST", request.pathOrUrl, request.body, token);

    const failure = classifySendFailure(this.#spec.sendErrorRules, {
      httpStatus: response.status,
      // 与重构前一致：业务码字段按平台声明信任，不做运行时类型收敛
      code: response.payload.code as number | undefined,
      platformMessage: this.#spec.readPlatformMessage(response.payload),
      proactive: outbound.reply_to_native_message_id === undefined,
      retryAfterSeconds: response.retryAfterSeconds,
    });
    if (failure !== null) throw this.createError(failure);

    this.markHealthy();
    const remoteMessageId = this.#spec.readRemoteMessageId(response.payload);
    return {
      channel: this.channelId,
      ...(remoteMessageId === undefined ? {} : { remote_message_id: remoteMessageId }),
      delivered_at: this.#now().toISOString(),
    };
  }

  #degrade(err: unknown): void {
    this.#degraded = true;
    this.#lastError = err instanceof Error ? err.message : String(err);
  }
}
