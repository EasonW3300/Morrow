import type { ChannelTestEventFrame } from "./testing/channel-test-server.ts";

/**
 * 渠道事件订阅传输接缝（M4-T4 从飞书适配器抽出的通用形态）。
 *
 * 决策（ADR-0004/ADR-0005）：事件订阅**优先长连接**，Runtime 不监听公网、不需要
 * webhook 回调地址。真实平台长连接（飞书 WebSocket、QQ Webhook/长连接）由平台 SDK
 * 或本地 sidecar 封装成同一接口注入生产适配器，适配器其余代码不变。
 *
 * 默认实现 `HttpLongPollEventTransport` 面向同一 base_url 的 HTTP 长轮询：
 * 它与 ChannelTestServer 的事件队列对齐，用于协议层全链路测试；也可作为内网桥接。
 * `streamPath` 允许各适配器复用同一传输实现（T3 飞书默认路径保持原样）。
 */

export interface EventTransport {
  start(
    onFrame: (frame: ChannelTestEventFrame) => void,
    onError: (error: Error) => void,
  ): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface HttpLongPollEventTransportOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** 单次长轮询等待上限（毫秒，默认 1000；测试/内网桥接均可调） */
  pollTimeoutMs?: number;
  /** 网络错误后的重连等待（毫秒，默认 500） */
  reconnectDelayMs?: number;
  /** 长轮询路径（默认飞书形状；QQ 等适配器可指向自己的桥接路径） */
  streamPath?: string;
}

interface StreamResponse {
  events?: unknown;
  cursor?: unknown;
}

/**
 * 基于 HTTP 长轮询的事件传输（默认）。游标由服务端返回，断线重连从上次游标续传；
 * 网络错误交给 onError 上报健康状态，然后按 reconnectDelayMs 重试（stop 后不再重连）。
 */
export class HttpLongPollEventTransport implements EventTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pollTimeoutMs: number;
  readonly #reconnectDelayMs: number;
  readonly #streamPath: string;

  #running = false;
  #cursor = "0";
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;

  constructor(options: HttpLongPollEventTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? 1_000;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 500;
    this.#streamPath = options.streamPath ?? "/open-apis/event/v1/stream";
  }

  start(
    onFrame: (frame: ChannelTestEventFrame) => void,
    onError: (error: Error) => void,
  ): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run(onFrame, onError);
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#controller?.abort();
    this.#controller = null;
    await this.#loop?.catch(() => undefined);
    this.#loop = null;
  }

  async #run(
    onFrame: (frame: ChannelTestEventFrame) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    while (this.#running) {
      this.#controller = new AbortController();
      try {
        const url = `${this.#baseUrl}${this.#streamPath}?cursor=${encodeURIComponent(this.#cursor)}&timeout_ms=${this.#pollTimeoutMs}`;
        const response = await this.#fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: this.#controller.signal,
        });
        if (!response.ok) {
          throw new Error(`event stream responded ${response.status}`);
        }
        const body = (await response.json()) as StreamResponse;
        if (typeof body.cursor === "string" && body.cursor.length > 0) this.#cursor = body.cursor;
        const frames = Array.isArray(body.events) ? body.events : [];
        for (const candidate of frames) {
          const frame = asFrame(candidate);
          if (frame !== null) onFrame(frame);
        }
      } catch (err) {
        if (!this.#running) return;
        onError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.#controller = null;
      }
      if (!this.#running) return;
      if (this.#reconnectDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.#reconnectDelayMs));
      }
    }
  }
}

function asFrame(value: unknown): ChannelTestEventFrame | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.body !== "string") return null;
  const headers: Record<string, string> = {};
  if (typeof record.headers === "object" && record.headers !== null && !Array.isArray(record.headers)) {
    for (const [key, raw] of Object.entries(record.headers as Record<string, unknown>)) {
      if (typeof raw === "string") headers[key] = raw;
    }
  }
  return { body: record.body, headers };
}
