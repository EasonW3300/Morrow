import { createCipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/**
 * ChannelTestServer（M4-T3 / Issue #40）：平台 API/事件流的本地协议桩，三个渠道适配器
 * 共用（T4/T5 复用）。零真实网络：只监听 127.0.0.1 的随机端口。
 *
 * 设计约束（票面硬要求）：
 * - 真实适配器**只改 base_url** 即可对接：默认注册飞书 Open API 形状的端点
 *   （tenant_access_token / reply / 主动消息 / 事件长轮询），不做任何测试专有握手；
 * - 故障注入是服务端可配置状态，不侵入适配器代码：
 *     签名/解密失败（signatureMode）、429 限流（含 Retry-After）、重复投递
 *     （duplicateEvents）、响应超时（replyMode="hang"）、主动消息被拒
 *     （rejectProactive）、token 失效（expireAccessToken / rejectAllSendTokens）；
 * - 请求计数与最后请求断言：`requests` / `count(kind)` / `lastRequest(kind)`；
 * - 事件流：`pushEvent()` / `pushMessage()` 入队，适配器经
 *   `GET /open-apis/event/v1/stream` 长轮询取走（T3 的 HttpLongPollEventTransport）。
 *
 * 真实飞书长连接是 WebSocket（官方 SDK），本桩用同一 base_url 上的 HTTP 长轮询模拟
 * 事件到达语义；HTTP API 形状保持真实，便于"填配置即可联调"（见 README）。
 */

export type ChannelTestRequestKind =
  | "token"
  | "reply"
  | "proactive"
  | "event_stream"
  | "custom"
  | "unknown";

export interface ChannelTestServerRequest {
  kind: ChannelTestRequestKind;
  method: string;
  path: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
  at: string;
}

export interface ChannelTestReplyRecord {
  native_message_id: string;
  body: unknown;
  at: string;
}

export interface ChannelTestProactiveRecord {
  receive_id_type: string | null;
  body: unknown;
  at: string;
}

/** 事件流中一帧：适配器把 body+headers 交给同一套签名/解密校验 */
export interface ChannelTestEventFrame {
  body: string;
  headers: Record<string, string>;
}

export interface ChannelTestRouteContext {
  request: ChannelTestServerRequest;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** 写 JSON 响应（可在响应头追加 Retry-After 等） */
  respond(status: number, body?: unknown, headers?: Record<string, string>): void;
  /** 故意不响应（客户端超时路径）；连接保持到客户端放弃或 server.stop() */
  hang(): void;
}

export type ChannelTestRouteHandler = (
  context: ChannelTestRouteContext,
) => void | "deferred" | Promise<void | "deferred">;

export interface ChannelTestServerOptions {
  host?: string;
  port?: number;
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  /** 事件加密键（AES-256-CBC，与真实飞书算法一致）；缺省则事件明文 */
  encryptKey?: string;
  botOpenId?: string;
  /** tenant_access_token 有效期（秒，默认 7200） */
  tokenTtlSeconds?: number;
  /** 事件签名模式（默认 valid；invalid/missing 用于签名失败路径） */
  signatureMode?: "valid" | "invalid" | "missing";
  /** 每条 push 的事件是否重复投递两次（默认 false） */
  duplicateEvents?: boolean;
  /** 429 注入：剩余拒绝次数 + Retry-After 秒数（默认关闭） */
  rateLimit?: { remaining: number; retryAfterSeconds?: number } | null;
  /** reply/主动消息响应模式：ok | forbidden | hang（默认 ok） */
  replyMode?: "ok" | "forbidden" | "hang";
  /** 主动消息被平台拒绝（默认 false） */
  rejectProactive?: boolean;
  /** 任意请求使用均返回 token 无效（模拟刷新后仍失败；默认 false） */
  rejectAllSendTokens?: boolean;
  /** tenant_access_token 端点失败（默认 false） */
  failTokenEndpoint?: boolean;
  now?: () => Date;
}

const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const REPLY_RE = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/;
const SEND_PATH = "/open-apis/im/v1/messages";
const EVENT_STREAM_PATH = "/open-apis/event/v1/stream";

interface RouteEntry {
  method: string;
  pattern: RegExp;
  handler: ChannelTestRouteHandler;
  kind: ChannelTestRequestKind;
}

interface IssuedToken {
  value: string;
  expiresAt: number;
}

interface EventWaiter {
  cursor: number;
  respond: (frames: ChannelTestEventFrame[], cursor: number) => void;
  timer: NodeJS.Timeout;
}

export class ChannelTestServer {
  readonly #options: Required<
    Pick<ChannelTestServerOptions, "host" | "appId" | "appSecret" | "verificationToken" | "tokenTtlSeconds">
  > &
    ChannelTestServerOptions;
  readonly #routes: RouteEntry[] = [];
  readonly #requests: ChannelTestServerRequest[] = [];
  readonly #replies: ChannelTestReplyRecord[] = [];
  readonly #proactive: ChannelTestProactiveRecord[] = [];
  readonly #events: ChannelTestEventFrame[] = [];
  readonly #waiters = new Set<EventWaiter>();
  readonly #tokens = new Map<string, IssuedToken>();
  readonly #invalidated = new Set<string>();
  readonly #now: () => Date;

  #server: Server | null = null;
  #host = "127.0.0.1";
  #port = 0;
  #tokenSeq = 0;
  #nonceSeq = 0;
  #messageSeq = 0;

  signatureMode: "valid" | "invalid" | "missing";
  duplicateEvents: boolean;
  rateLimit: { remaining: number; retryAfterSeconds: number } | null;
  replyMode: "ok" | "forbidden" | "hang";
  rejectProactive: boolean;
  rejectAllSendTokens: boolean;
  failTokenEndpoint: boolean;

  constructor(options: ChannelTestServerOptions = {}) {
    this.#options = {
      ...options,
      host: options.host ?? "127.0.0.1",
      appId: options.appId ?? "cli_test_app",
      appSecret: options.appSecret ?? "test_app_secret",
      verificationToken: options.verificationToken ?? "test_verification_token",
      tokenTtlSeconds: options.tokenTtlSeconds ?? 7200,
    };
    this.#now = options.now ?? (() => new Date());
    this.signatureMode = options.signatureMode ?? "valid";
    this.duplicateEvents = options.duplicateEvents ?? false;
    this.rateLimit =
      options.rateLimit === undefined || options.rateLimit === null
        ? null
        : {
            remaining: Math.max(0, options.rateLimit.remaining),
            retryAfterSeconds: options.rateLimit.retryAfterSeconds ?? 1,
          };
    this.replyMode = options.replyMode ?? "ok";
    this.rejectProactive = options.rejectProactive ?? false;
    this.rejectAllSendTokens = options.rejectAllSendTokens ?? false;
    this.failTokenEndpoint = options.failTokenEndpoint ?? false;

    // 内置平台端点；`route()` 追加的自定义端点按注册顺序排在其后（T4/T5 使用不同路径）
    this.#registerBuiltinRoutes();
  }

  /** 监听随机端口（默认 127.0.0.1:0）；返回 base_url */
  async start(): Promise<string> {
    if (this.#server !== null) throw new Error("ChannelTestServer is already started");
    const server = createServer((req, res) => {
      void this.#dispatch(req, res);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port ?? 0, this.#options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("ChannelTestServer did not bind a TCP port");
    }
    this.#host = address.address;
    this.#port = address.port;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.respond([], waiter.cursor);
    }
    this.#waiters.clear();
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get baseUrl(): string {
    return `http://${this.#host}:${this.#port}`;
  }

  get url(): string {
    return this.baseUrl;
  }

  /** 已记录的请求（按到达顺序；含 token/reply/proactive/event_stream） */
  get requests(): readonly ChannelTestServerRequest[] {
    return this.#requests;
  }

  /** 平台侧收到的回复（reply API） */
  get replies(): readonly ChannelTestReplyRecord[] {
    return this.#replies;
  }

  /** 平台侧收到的主动消息 */
  get proactiveMessages(): readonly ChannelTestProactiveRecord[] {
    return this.#proactive;
  }

  count(kind?: ChannelTestRequestKind): number {
    if (kind === undefined) return this.#requests.length;
    return this.#requests.filter((request) => request.kind === kind).length;
  }

  lastRequest(kind?: ChannelTestRequestKind): ChannelTestServerRequest | null {
    for (let index = this.#requests.length - 1; index >= 0; index -= 1) {
      const request = this.#requests[index] as ChannelTestServerRequest;
      if (kind === undefined || request.kind === kind) return request;
    }
    return null;
  }

  requestsFor(kind: ChannelTestRequestKind): ChannelTestServerRequest[] {
    return this.#requests.filter((request) => request.kind === kind);
  }

  /** 清空请求/回执/事件（故障注入状态保留） */
  reset(): void {
    this.#requests.length = 0;
    this.#replies.length = 0;
    this.#proactive.length = 0;
    this.#events.length = 0;
  }

  /** 当前 tenant_access_token 全部作废（下一次 send 需要刷新） */
  expireAccessToken(): void {
    for (const token of this.#tokens.keys()) this.#invalidated.add(token);
  }

  /** 注册自定义平台端点（T4/T5）：处理器自行 respond/hang；请求仍被计数 */
  route(method: string, pattern: RegExp, handler: ChannelTestRouteHandler, kind: ChannelTestRequestKind = "custom"): void {
    this.#routes.push({ method: method.toUpperCase(), pattern, handler, kind });
  }

  /** 事件入队（长轮询取走）；返回本次投递的帧数（duplicateEvents 时为 2） */
  pushEvent(event: Record<string, unknown>): number {
    return this.pushFrame(this.buildEventFrame(event));
  }

  /**
   * 预构造帧入队（M4-T4 起）：供非飞书签名形态的平台使用（QQ Ed25519 等）。
   * 与 pushEvent 共享同一游标/去重/唤醒语义；帧由调用方签名。
   */
  pushFrame(frame: ChannelTestEventFrame): number {
    this.#events.push(frame);
    if (this.duplicateEvents) this.#events.push(frame);
    this.#wakeWaiters();
    return this.duplicateEvents ? 2 : 1;
  }

  /**
   * 便捷构造飞书 `im.message.receive_v1` 事件并投递。默认私聊、文本、无 @；
   * 群聊测试传 `chatType: "group"` 与 `mentionBot: true`。
   */
  pushMessage(
    input: {
      messageId?: string;
      chatId?: string;
      chatType?: "p2p" | "group";
      senderOpenId?: string;
      senderName?: string;
      text?: string;
      mentionBot?: boolean;
      attachments?: Array<{ kind: "image" | "file" | "audio" | "video"; nativeId: string; name?: string }>;
      createTime?: string;
    } = {},
  ): number {
    const seq = (this.#messageSeq += 1);
    return this.pushEvent(
      this.buildMessageEvent({
        messageId: input.messageId ?? `om_in_${seq}`,
        chatId: input.chatId ?? "oc_dm_1",
        chatType: input.chatType ?? "p2p",
        senderOpenId: input.senderOpenId ?? "ou_owner",
        senderName: input.senderName,
        text: input.text ?? `hello ${seq}`,
        mentionBot: input.mentionBot ?? false,
        attachments: input.attachments,
        createTime: input.createTime,
      }),
    );
  }

  /** 构造飞书消息事件载荷（不投递；测试可直接断言/自行签名） */
  buildMessageEvent(input: {
    messageId: string;
    chatId: string;
    chatType: "p2p" | "group";
    senderOpenId: string;
    senderName?: string;
    text?: string;
    mentionBot?: boolean;
    attachments?: Array<{ kind: "image" | "file" | "audio" | "video"; nativeId: string; name?: string }>;
    createTime?: string;
  }): Record<string, unknown> {
    const createTime = input.createTime ?? String(this.#now().getTime());
    const attachment = input.attachments?.[0];
    const messageType =
      attachment === undefined ? "text" : attachment.kind === "video" ? "media" : attachment.kind;
    const content =
      attachment === undefined
        ? JSON.stringify({ text: input.text ?? "" })
        : attachment.kind === "image"
          ? JSON.stringify({ image_key: attachment.nativeId })
          : JSON.stringify({
              file_key: attachment.nativeId,
              ...(attachment.name === undefined ? {} : { file_name: attachment.name }),
            });
    const mentions =
      input.mentionBot && this.#options.botOpenId !== undefined
        ? [
            {
              key: "@_user_1",
              id: { open_id: this.#options.botOpenId },
              name: "Morrow",
            },
          ]
        : [];
    return {
      schema: "2.0",
      header: {
        event_id: `evt_${input.messageId}`,
        event_type: "im.message.receive_v1",
        create_time: createTime,
        token: this.#options.verificationToken,
        app_id: this.#options.appId,
        tenant_key: "tenant_test",
      },
      event: {
        sender: {
          sender_id: { open_id: input.senderOpenId },
          ...(input.senderName === undefined ? {} : { sender_type: "user" }),
        },
        message: {
          message_id: input.messageId,
          create_time: createTime,
          chat_id: input.chatId,
          chat_type: input.chatType,
          message_type: messageType,
          content,
          mentions,
        },
      },
    };
  }

  /** 把事件对象编码为签名（可选加密）后的长连接帧，供测试直接喂给适配器 */
  buildEventFrame(event: Record<string, unknown>): ChannelTestEventFrame {
    const plaintext = JSON.stringify(event);
    const body =
      this.#options.encryptKey === undefined
        ? plaintext
        : JSON.stringify({ encrypt: encryptFeishuPayload(plaintext, this.#options.encryptKey) });
    const timestamp = String(Math.floor(this.#now().getTime() / 1000));
    const nonce = `nonce-${(this.#nonceSeq += 1)}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
    };
    if (this.signatureMode !== "missing") {
      const signature = signFeishuEvent(
        timestamp,
        nonce,
        this.#options.encryptKey ?? "",
        this.signatureMode === "valid" ? body : `${body}:tampered`,
      );
      headers["x-lark-signature"] = signature;
    }
    return { body, headers };
  }

  // --- 内置平台端点 --------------------------------------------------------

  #registerBuiltinRoutes(): void {
    this.route("POST", new RegExp(`^${escapeRegExp(TOKEN_PATH)}$`), (ctx) => this.#handleToken(ctx), "token");
    this.route("POST", REPLY_RE, (ctx) => this.#handleReply(ctx), "reply");
    this.route(
      "POST",
      new RegExp(`^${escapeRegExp(SEND_PATH)}$`),
      (ctx) => this.#handleProactive(ctx),
      "proactive",
    );
    this.route("GET", new RegExp(`^${escapeRegExp(EVENT_STREAM_PATH)}$`), (ctx) => this.#handleEventStream(ctx), "event_stream");
  }

  #handleToken(ctx: ChannelTestRouteContext): void {
    if (this.failTokenEndpoint) {
      ctx.respond(500, { code: 10003, msg: "app secret invalid (injected)" });
      return;
    }
    const body = asRecord(ctx.request.body) ?? {};
    if (body.app_id !== this.#options.appId || body.app_secret !== this.#options.appSecret) {
      ctx.respond(400, { code: 10003, msg: "app_id or app_secret invalid" });
      return;
    }
    const token = this.#issueToken();
    ctx.respond(200, {
      code: 0,
      msg: "ok",
      tenant_access_token: token.value,
      expire: this.#options.tokenTtlSeconds,
    });
  }

  #handleReply(ctx: ChannelTestRouteContext): void {
    if (this.replyMode === "hang") {
      ctx.hang();
      return;
    }
    if (this.#consumeRateLimit(ctx)) return;
    if (!this.#authorizeSend(ctx)) return;
    if (this.replyMode === "forbidden") {
      ctx.respond(403, { code: 230001, msg: "permission denied (injected)" });
      return;
    }
    const nativeMessageId = REPLY_RE.exec(ctx.url.pathname)?.[1] ?? "";
    this.#replies.push({
      native_message_id: nativeMessageId,
      body: ctx.request.body,
      at: this.#now().toISOString(),
    });
    ctx.respond(200, {
      code: 0,
      msg: "success",
      data: { message_id: `om_reply_${(this.#messageSeq += 1)}` },
    });
  }

  #handleProactive(ctx: ChannelTestRouteContext): void {
    if (this.replyMode === "hang") {
      ctx.hang();
      return;
    }
    if (this.#consumeRateLimit(ctx)) return;
    if (!this.#authorizeSend(ctx)) return;
    if (this.rejectProactive) {
      ctx.respond(400, {
        code: 230001,
        msg: "proactive message not allowed in this scene (injected)",
      });
      return;
    }
    this.#proactive.push({
      receive_id_type: ctx.url.searchParams.get("receive_id_type"),
      body: ctx.request.body,
      at: this.#now().toISOString(),
    });
    ctx.respond(200, {
      code: 0,
      msg: "success",
      data: { message_id: `om_proactive_${(this.#messageSeq += 1)}` },
    });
  }

  #handleEventStream(ctx: ChannelTestRouteContext): "deferred" {
    const cursorRaw = Number(ctx.url.searchParams.get("cursor") ?? "0");
    const cursor = Number.isInteger(cursorRaw) && cursorRaw >= 0 ? cursorRaw : 0;
    const timeoutRaw = Number(ctx.url.searchParams.get("timeout_ms") ?? "1000");
    const timeoutMs = Number.isInteger(timeoutRaw) ? Math.min(30_000, Math.max(0, timeoutRaw)) : 1_000;

    const flush = (): boolean => {
      const start = Math.min(cursor, this.#events.length);
      if (start < this.#events.length) {
        const frames = this.#events.slice(start);
        ctx.respond(200, { events: frames, cursor: String(this.#events.length) });
        return true;
      }
      return false;
    };
    if (flush()) return "deferred";

    const waiter: EventWaiter = {
      cursor,
      respond: (frames, nextCursor) => {
        if (ctx.res.writableEnded) return;
        ctx.respond(200, { events: frames, cursor: String(nextCursor) });
      },
      timer: setTimeout(() => {
        this.#waiters.delete(waiter);
        if (!ctx.res.writableEnded) ctx.respond(200, { events: [], cursor: String(cursor) });
      }, timeoutMs),
    };
    this.#waiters.add(waiter);
    ctx.req.once("close", () => {
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
    });
    return "deferred";
  }

  #issueToken(): IssuedToken {
    const value = `t-${(this.#tokenSeq += 1)}-${randomBytes(6).toString("hex")}`;
    const token: IssuedToken = {
      value,
      expiresAt: this.#now().getTime() + this.#options.tokenTtlSeconds * 1000,
    };
    this.#tokens.set(value, token);
    return token;
  }

  #authorizeSend(ctx: ChannelTestRouteContext): boolean {
    const header = ctx.request.headers.authorization;
    const raw = typeof header === "string" ? header : "";
    const token = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
    const issued = token.length > 0 ? this.#tokens.get(token) : undefined;
    const valid =
      !this.rejectAllSendTokens &&
      issued !== undefined &&
      !this.#invalidated.has(token) &&
      issued.expiresAt > this.#now().getTime();
    if (!valid) {
      ctx.respond(401, { code: 99991663, msg: "invalid or expired tenant_access_token" });
      return false;
    }
    return true;
  }

  #consumeRateLimit(ctx: ChannelTestRouteContext): boolean {
    const limit = this.rateLimit;
    if (limit === null || limit.remaining <= 0) return false;
    limit.remaining -= 1;
    ctx.respond(
      429,
      { code: 99991400, msg: "too many request" },
      { "retry-after": String(limit.retryAfterSeconds) },
    );
    return true;
  }

  #wakeWaiters(): void {
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      const start = Math.min(waiter.cursor, this.#events.length);
      waiter.respond(this.#events.slice(start), this.#events.length);
    }
  }

  // --- HTTP 分发 -----------------------------------------------------------

  async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const rawBody = await readBody(req);
    const method = (req.method ?? "GET").toUpperCase();
    let body: unknown = rawBody;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        body = rawBody;
      }
    }
    const route = this.#routes.find(
      (candidate) => candidate.method === method && candidate.pattern.test(url.pathname),
    );
    const request: ChannelTestServerRequest = {
      kind: route?.kind ?? "unknown",
      method,
      path: url.pathname,
      url,
      headers: req.headers,
      body,
      rawBody,
      at: this.#now().toISOString(),
    };
    this.#requests.push(request);

    if (route === undefined) {
      writeJson(res, 404, { code: 404, msg: `no stub route for ${method} ${url.pathname}` });
      return;
    }

    let responded = false;
    let hung = false;
    const context: ChannelTestRouteContext = {
      request,
      req,
      res,
      url,
      respond(status, payload, headers) {
        if (responded || res.writableEnded) return;
        responded = true;
        writeJson(res, status, payload ?? {}, headers);
      },
      hang() {
        hung = true;
        // 不响应：让客户端超时；连接由客户端/stop() 关闭
      },
    };
    try {
      const result = await route.handler(context);
      if (!responded && !hung && result !== "deferred") writeJson(res, 204, null);
    } catch (err) {
      if (!res.writableEnded) {
        writeJson(res, 500, { code: 500, msg: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

/** 飞书事件签名：sha256(timestamp + nonce + encryptKey + rawBody) 的十六进制 */
export function signFeishuEvent(timestamp: string, nonce: string, encryptKey: string, body: string): string {
  return createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${body}`).digest("hex");
}

/** 飞书 Encrypt Key 解密对应的加密：AES-256-CBC，key=sha256(encryptKey)，IV 前置 16 字节 */
export function encryptFeishuPayload(plaintext: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(body === null ? "" : JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
