import type { EventTransport } from "../../event-transport.ts";
import type { ChannelTestEventFrame } from "../../testing/channel-test-server.ts";

/**
 * QQ 官方 Bot WebSocket 网关传输（M4-T4 / Issue #41）。
 *
 * 为什么不是 Webhook：QQ 官方 Webhook 需要平台能回调到 Runtime（公网 HTTPS），
 * 与 ADR-0004「私有网络、Runtime 不监听公网」冲突；官方 WebSocket 网关由 Runtime
 * 主动外连，天然满足该约束（与飞书长连接同一决策）。
 *
 * 协议（官方 `api.sgroup.qq.com` 文档）：
 *   1. `POST {tokenEndpoint}` 换 access token（由注入的 provider 复用适配器缓存/刷新）；
 *   2. `GET {apiBase}/gateway`（头 `Authorization: QQBot <access_token>`）→ `{url}`；
 *   3. 连接 `wss://...`（Node 22+ 全局 WebSocket，不引第三方依赖）；
 *   4. 服务端 Hello（op 10，含 `heartbeat_interval`）→ 客户端 Identify（op 2）；
 *   5. 按间隔发心跳 op 1（`d` 为最近一次 Dispatch 的 `s`，无则 null），op 11 心跳 ACK 忽略；
 *   6. op 0 Dispatch：`t` 为事件名；消息事件交给已鉴权的 `handleTrustedEvent`；
 *   7. op 7 要求重连、op 9 会话失效（必须重新 Identify）；
 *   8. 断线按指数退避重连：1s → 2s → 4s … 上限 30s（成功 Hello 后重置）。
 *
 * 信任边界：Identify 使用 `QQBot <access_token>` 在网关侧完成鉴权，之后的 Dispatch
 * 都来自已认证连接；网关**没有** Webhook 的 Ed25519 帧签名。因此本传输把事件交给
 * `attachTrustedEventSink()` 注入的 sink（适配器 `handleTrustedEvent`），绝不经过
 * `handleFrame` 的签名校验。Webhook 模式继续用 `handleFrame`。
 *
 * token 刷新：access token TTL 7200s。默认在到期前 300s（`tokenRefreshIntervalMs`
 * = 6_900_000）调用 provider 强制刷新，然后**关闭连接并重连 + 重新 Identify**。
 * 不做 Resume（官方 resume 需要 session_id + seq 的额外状态机，收益有限、出错面更大）；
 * 重连 + 全量 Identify 是简单可靠的选择。
 */

/** QQ 网关 intents：1 << 25 = GROUP_AND_C2C_EVENT（群聊 @ 与单聊消息）。 */
export const QQ_INTENT_GROUP_AND_C2C = 1 << 25;

/** 最小 WebSocket 接缝（Node 全局 WebSocket 与测试伪实现都满足）。 */
export interface QqWebSocketEventLike {
  /** message 事件的载荷（string / Buffer / ArrayBuffer 均可） */
  data?: unknown;
  code?: number;
  reason?: string;
  message?: string;
}

export interface QqWebSocketLike {
  addEventListener(type: string, listener: (event: QqWebSocketEventLike) => void): void;
  removeEventListener?(type: string, listener: (event: QqWebSocketEventLike) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** 适配器注入的 access token 提供者（复用缓存、强制刷新与健康状态） */
export interface QqAccessTokenProvider {
  getAccessToken(): Promise<string>;
  /** 强制刷新（token 临近过期/失效）；缺省退回 getAccessToken */
  refreshAccessToken?(): Promise<string>;
}

export interface QqWebSocketTransportOptions {
  /** Bot API 基地址（默认 https://api.sgroup.qq.com）；GET {apiBase}/gateway */
  apiBaseUrl?: string;
  /** 直接指定网关地址（内网/测试）；设置后跳过 GET /gateway */
  gatewayUrl?: string;
  fetch?: typeof fetch;
  /** 测试注入：返回 WS 实例；缺省使用 Node 22+ 全局 WebSocket（缺失则明确报错） */
  webSocketFactory?: (url: string) => QqWebSocketLike;
  /** 测试注入：重连等待（缺省 setTimeout；便于断言指数退避序列） */
  wait?: (delayMs: number) => Promise<void>;
  /** 覆盖 Hello 的 heartbeat_interval（毫秒；仅测试/内网调优用） */
  heartbeatIntervalMs?: number;
  /** 指数退避基数（毫秒，默认 1000） */
  reconnectBaseDelayMs?: number;
  /** 指数退避上限（毫秒，默认 30000） */
  reconnectMaxDelayMs?: number;
  /** token 主动刷新周期（毫秒，默认 6_900_000 = 7200s − 300s）；0 = 关闭 */
  tokenRefreshIntervalMs?: number;
  /** token 刷新失败后的重试间隔（毫秒，默认 30000） */
  tokenRefreshRetryMs?: number;
  /** 请求 gateway 的超时（毫秒，默认 10000） */
  requestTimeoutMs?: number;
  /** Identify intents（默认 QQ_INTENT_GROUP_AND_C2C = 1<<25） */
  intents?: number;
  /** Hello 处理完、Identify 已发送时回调（联调脚本打印 READY；不参与协议） */
  onReady?: () => void;
}

const DEFAULT_API_BASE_URL = "https://api.sgroup.qq.com";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 41_250;
const DEFAULT_TOKEN_REFRESH_INTERVAL_MS = 7_200_000 - 300_000;

interface GatewayResponse {
  url?: unknown;
  code?: unknown;
  message?: unknown;
}

interface QqGatewayFrame {
  op?: unknown;
  d?: unknown;
  t?: unknown;
  s?: unknown;
}

export class QqWebSocketTransport implements EventTransport {
  readonly #apiBaseUrl: string;
  readonly #gatewayUrl: string | null;
  readonly #fetch: typeof fetch;
  readonly #webSocketFactory: (url: string) => QqWebSocketLike;
  readonly #wait: (delayMs: number) => Promise<void>;
  readonly #heartbeatIntervalMs: number;
  readonly #reconnectBaseDelayMs: number;
  readonly #reconnectMaxDelayMs: number;
  readonly #tokenRefreshIntervalMs: number;
  readonly #tokenRefreshRetryMs: number;
  readonly #requestTimeoutMs: number;
  readonly #intents: number;
  readonly #onReady: (() => void) | null;

  #provider: QqAccessTokenProvider | null = null;
  #trustedSink: ((event: unknown) => void) | null = null;
  #onFrame: ((frame: ChannelTestEventFrame) => void) | null = null;
  #onError: ((error: Error) => void) | null = null;

  #running = false;
  #generation = 0;
  #socket: QqWebSocketLike | null = null;
  #currentToken: string | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #reconnecting = false;
  #lastSequence: number | null = null;

  constructor(options: QqWebSocketTransportOptions = {}) {
    this.#apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.#gatewayUrl = options.gatewayUrl ?? null;
    this.#fetch = options.fetch ?? fetch;
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#wait =
      options.wait ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        }));
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
    this.#reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.#reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.#tokenRefreshIntervalMs = options.tokenRefreshIntervalMs ?? DEFAULT_TOKEN_REFRESH_INTERVAL_MS;
    this.#tokenRefreshRetryMs = options.tokenRefreshRetryMs ?? 30_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#intents = options.intents ?? QQ_INTENT_GROUP_AND_C2C;
    this.#onReady = options.onReady ?? null;
  }

  /**
   * 绑定 access token 提供者。适配器在 start() 时注入自己的缓存/刷新逻辑，
   * 因此 WS 与 HTTP 发送共用同一份 token（不会出现两条独立刷新链）。
   */
  attachTokenProvider(provider: QqAccessTokenProvider): void {
    this.#provider = provider;
  }

  /**
   * 绑定信任事件 sink（适配器 `handleTrustedEvent`）。未绑定时回落到
   * `start()` 的 onFrame（把事件序列化为 `{body, headers:{}}`，仅用于不带签名的桩）。
   */
  attachTrustedEventSink(sink: (event: unknown) => void): void {
    this.#trustedSink = sink;
  }

  start(
    onFrame: (frame: ChannelTestEventFrame) => void,
    onError: (error: Error) => void,
  ): void {
    if (this.#running) return;
    this.#running = true;
    this.#onFrame = onFrame;
    this.#onError = onError;
    this.#reconnectAttempt = 0;
    this.#lastSequence = null;
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#reconnecting = false;
    this.#teardownSocket();
  }

  // --- 连接/重连 ------------------------------------------------------------

  async #connect(): Promise<void> {
    if (!this.#running) return;
    const generation = (this.#generation += 1);
    try {
      const provider = this.#provider;
      if (provider === null) {
        throw new Error(
          "qq websocket transport: access token provider not attached (adapter must call attachTokenProvider)",
        );
      }
      const token = await provider.getAccessToken();
      if (!this.#running || generation !== this.#generation) return;
      const url = await this.#resolveGatewayUrl(token);
      if (!this.#running || generation !== this.#generation) return;

      const socket = this.#webSocketFactory(url);
      this.#socket = socket;
      this.#currentToken = token;
      socket.addEventListener("message", (event) => this.#handleMessage(generation, event));
      socket.addEventListener("close", (event) => this.#handleClose(generation, event));
      socket.addEventListener("error", (event) => this.#handleSocketError(generation, event));
      // Identify 必须等 Hello（op 10）；此处不做任何发送。
      this.#scheduleTokenRefresh(generation);
    } catch (err) {
      if (!this.#running || generation !== this.#generation) return;
      this.#report(err);
      this.#scheduleReconnect();
    }
  }

  async #resolveGatewayUrl(token: string): Promise<string> {
    if (this.#gatewayUrl !== null) return this.#gatewayUrl;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(`${this.#apiBaseUrl}/gateway`, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `QQBot ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`qq gateway endpoint responded ${response.status}`);
      }
      const payload = (await response.json()) as GatewayResponse;
      if (typeof payload.url !== "string" || !/^wss?:\/\//.test(payload.url)) {
        throw new Error("qq gateway response is missing a valid websocket url");
      }
      return payload.url;
    } finally {
      clearTimeout(timer);
    }
  }

  #scheduleReconnect(delayOverrideMs?: number): void {
    if (!this.#running || this.#reconnecting) return;
    this.#reconnecting = true;
    const delay =
      delayOverrideMs ??
      Math.min(
        this.#reconnectBaseDelayMs * 2 ** this.#reconnectAttempt,
        this.#reconnectMaxDelayMs,
      );
    this.#reconnectAttempt += 1;
    void this.#wait(delay).then(() => {
      this.#reconnecting = false;
      if (!this.#running) return;
      void this.#connect();
    });
  }

  #teardownSocket(): void {
    // 递增 generation：旧 socket 的 close/error 回调全部失效（自身发起的关闭不触发重连）
    this.#generation += 1;
    this.#clearHeartbeat();
    this.#clearRefresh();
    const socket = this.#socket;
    this.#socket = null;
    this.#currentToken = null;
    if (socket !== null) {
      try {
        socket.close(1000, "client teardown");
      } catch {
        // close 失败不影响清理（连接可能已断开）
      }
    }
  }

  // --- 帧处理 ----------------------------------------------------------------

  #handleMessage(generation: number, event: QqWebSocketEventLike): void {
    if (!this.#running || generation !== this.#generation) return;
    const frame = parseFrame(event.data);
    if (frame === null) {
      this.#report(new Error("qq websocket received a non-JSON frame"));
      return;
    }
    const op = typeof frame.op === "number" ? frame.op : -1;

    if (op === 10) {
      this.#handleHello(frame);
      return;
    }
    if (op === 11) {
      // 心跳 ACK：无需动作（连接活性已由平台确认）
      return;
    }
    if (op === 0) {
      if (typeof frame.s === "number") this.#lastSequence = frame.s;
      this.#emitDispatch(frame);
      return;
    }
    if (op === 7) {
      // 平台要求重连：立即重连并重新 Identify
      this.#reconnectNow();
      return;
    }
    if (op === 9) {
      // 会话失效：丢弃 session，重新 Identify
      this.#reconnectNow();
    }
    // 其它 op 忽略（协议未来扩展）
  }

  #handleHello(frame: QqGatewayFrame): void {
    const data = isRecord(frame.d) ? frame.d : {};
    const helloInterval =
      typeof data.heartbeat_interval === "number" && data.heartbeat_interval > 0
        ? data.heartbeat_interval
        : DEFAULT_HEARTBEAT_INTERVAL_MS;
    const heartbeatInterval =
      this.#heartbeatIntervalMs > 0 ? this.#heartbeatIntervalMs : helloInterval;

    this.#reconnectAttempt = 0;
    const token = this.#currentToken;
    if (token === null) {
      this.#report(new Error("qq websocket Hello received without an access token"));
      return;
    }
    this.#send({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: this.#intents,
        shard: [0, 1],
      },
    });
    this.#startHeartbeat(heartbeatInterval);
    this.#onReady?.();
  }

  #emitDispatch(frame: QqGatewayFrame): void {
    const event = isRecord(frame) ? frame : null;
    if (event === null) return;

    if (this.#trustedSink !== null) {
      this.#trustedSink(event);
      return;
    }
    // 回退路径：没有可信 sink 时按通用帧交给 onFrame。调用方必须知道该帧未经
    // Ed25519 校验（WS 已由 access token 鉴权），不要用于 Webhook 签名路径。
    const onFrame = this.#onFrame;
    if (onFrame === null) return;
    onFrame({ body: JSON.stringify(event), headers: {} });
  }

  #reconnectNow(): void {
    this.#teardownSocket();
    if (!this.#running) return;
    this.#reconnectAttempt = 0;
    this.#scheduleReconnect(0);
  }

  #handleClose(generation: number, event: QqWebSocketEventLike): void {
    if (generation !== this.#generation) return;
    this.#socket = null;
    this.#currentToken = null;
    this.#clearHeartbeat();
    this.#clearRefresh();
    if (!this.#running) return;
    const code = typeof event.code === "number" ? event.code : null;
    this.#report(new Error(`qq websocket closed${code === null ? "" : ` (code ${code})`}`));
    this.#scheduleReconnect();
  }

  #handleSocketError(generation: number, event: QqWebSocketEventLike): void {
    if (!this.#running || generation !== this.#generation) return;
    const detail =
      typeof event.message === "string" && event.message.length > 0
        ? event.message
        : "qq websocket error";
    this.#report(new Error(detail));
  }

  #send(frame: Record<string, unknown>): void {
    const socket = this.#socket;
    if (socket === null) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (err) {
      this.#report(err);
    }
  }

  // --- 定时器 ----------------------------------------------------------------

  #startHeartbeat(intervalMs: number): void {
    this.#clearHeartbeat();
    if (intervalMs <= 0) return;
    const timer = setInterval(() => {
      this.#send({ op: 1, d: this.#lastSequence });
    }, intervalMs);
    timer.unref?.();
    this.#heartbeatTimer = timer;
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer === null) return;
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  #scheduleTokenRefresh(generation: number): void {
    this.#clearRefresh();
    if (this.#tokenRefreshIntervalMs <= 0) return;
    const timer = setTimeout(() => {
      void this.#refreshAccessToken(generation);
    }, this.#tokenRefreshIntervalMs);
    timer.unref?.();
    this.#refreshTimer = timer;
  }

  async #refreshAccessToken(generation: number): Promise<void> {
    if (!this.#running || generation !== this.#generation) return;
    try {
      const provider = this.#provider;
      if (provider === null) throw new Error("access token provider not attached");
      if (provider.refreshAccessToken !== undefined) {
        await provider.refreshAccessToken();
      } else {
        await provider.getAccessToken();
      }
    } catch (err) {
      if (!this.#running || generation !== this.#generation) return;
      this.#report(
        new Error(`qq access token refresh failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      const retry = setTimeout(() => {
        void this.#refreshAccessToken(generation);
      }, this.#tokenRefreshRetryMs);
      retry.unref?.();
      this.#refreshTimer = retry;
      return;
    }
    if (!this.#running || generation !== this.#generation) return;

    // 简单可靠：刷新后断开并用新 token 重新 Identify（不做 resume）
    this.#teardownSocket();
    if (!this.#running) return;
    this.#reconnectAttempt = 0;
    this.#scheduleReconnect(0);
  }

  #clearRefresh(): void {
    if (this.#refreshTimer === null) return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
  }

  #report(err: unknown): void {
    this.#onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/** 传输实例判定：适配器据此注入 token provider 与可信事件 sink。 */
export function isQqWebSocketTransport(value: unknown): value is QqWebSocketTransport {
  return value instanceof QqWebSocketTransport;
}

function defaultWebSocketFactory(url: string): QqWebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (ctor === undefined) {
    throw new Error(
      "qq websocket transport requires a global WebSocket (Node 22+); " +
        "upgrade Node or inject webSocketFactory",
    );
  }
  return new ctor(url) as QqWebSocketLike;
}

function parseFrame(data: unknown): QqGatewayFrame | null {
  let text: string | null = null;
  if (typeof data === "string") {
    text = data;
  } else if (data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(data);
  } else if (ArrayBuffer.isView(data)) {
    text = new TextDecoder().decode(data as unknown as Uint8Array);
  }
  if (text === null || text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? (parsed as QqGatewayFrame) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
