import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createPiAdapter, type AgentRuntime } from "@morrow/pi-adapter";
import packageJson from "../package.json" with { type: "json" };
import type { RuntimeConfig } from "./config.ts";
import { testProviderConnectivity } from "./connectivity.ts";
import { DeviceRegistry, type DeviceRecord } from "./devices.ts";
import { detectSecretStore, type SecretStore } from "./keyring.ts";
import { probeSandbox } from "./health.ts";
import { EventLedger } from "./ledger.ts";
import { ProviderRegistry, ProviderRegistryError, ENV_PROVIDER_ID, type ProviderResolver, type ResolvedProvider } from "./providers.ts";
import { SessionManager, type SessionFrame } from "./sessions.ts";
import { buildEventEnvelope } from "./envelope.ts";
import { computeIntegrityHash, type EventEnvelope } from "@morrow/protocol";
import { UUID_RE } from "./uuid-v7.ts";

/**
 * Runtime HTTP 服务（PRD §6.2 的 M0 子集）。
 *
 * node:http + 极简路由，不引框架——为 T8 bun compile 单二进制留路（ADR-0003）。
 * 路由面：GET /v1/health、GET /v1/events、GET /v1/devices（M0 只读登记，票 #3）、
 * T4 会话族（POST/GET /v1/sessions、
 * POST/GET /v1/sessions/:id/messages、GET /v1/sessions/:id/stream SSE）、
 * T5 Provider 族（GET/POST /v1/providers、GET/PUT/DELETE /v1/providers/:id、
 * POST /v1/providers/:id/default、POST /v1/providers/:id/test）。
 * 未匹配路径 404，路径命中但方法不符 405（账本 append-only：对事件的任何变更
 * 方法在请求层即被拒绝）。
 * 生命周期：start 先监听后记账 runtime.started（携带实际端口）；close 先停收请求，
 * 再中止会话运行并释放 AgentRuntime，然后记账 runtime.stopped（causation 指向
 * started），最后关闭账本落盘。
 */

/** 版本号唯一来源：本包 package.json（main.ts 的 ready 行也从这里取——不再双真相源） */
export const VERSION: string = packageJson.version;

interface RequestContext {
  ledger: EventLedger;
  replicaId: string;
  sessions: SessionManager;
  providers: ProviderRegistry;
  devices: DeviceRegistry;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RequestContext,
  params: string[],
) => void | Promise<void>;

interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
}

export interface RuntimeOptions {
  /**
   * Agent Loop 运行时工厂（PiAdapter 接口注入 seam）。缺省时用默认工厂
   * （createPiAdapter，Provider 配置由 ProviderResolver 按会话解析）；
   * 无任何 Provider 时发消息 503（provider_not_configured）。
   */
  agentAdapterFactory?: (sessionId: string, provider: ResolvedProvider | null) => Promise<AgentRuntime>;
  /**
   * 凭据库注入 seam（票 T5）：缺省按平台探测（macOS Keychain 实测；Windows/Linux
   * 未实测）。测试与宿主可注入内存桩避免触碰用户钥匙串。
   */
  secretStore?: SecretStore;
}

export interface RuntimeHandle {
  host: string;
  port: number;
  ledger: EventLedger;
  /** Device 记录注册表（票 #3 最小实现；库形态可直用） */
  devices: DeviceRegistry;
  /** 会话管理器（库形态可直用：abort / 订阅等测试与宿主 seam） */
  sessions: SessionManager;
  /** Provider 注册表（库形态可直用：CRUD / 默认 / env 回退解析） */
  providers: ProviderRegistry;
  /**
   * 优雅停止：停止接收请求 → 中止并释放会话运行时 → 记账 runtime.stopped →
   * 关闭账本（WAL checkpoint）。signal 传入收到的 POSIX 信号名，落进 stopped 事件的 payload。
   */
  close(signal?: string): Promise<void>;
}

const routes: Route[] = [
  { method: "GET", re: /^\/v1\/health$/, handler: handleHealth },
  { method: "GET", re: /^\/v1\/devices$/, handler: handleListDevices },
  { method: "GET", re: /^\/v1\/events$/, handler: handleEvents },
  { method: "GET", re: /^\/v1\/providers$/, handler: handleListProviders },
  { method: "POST", re: /^\/v1\/providers$/, handler: handleRegisterProvider },
  { method: "GET", re: /^\/v1\/providers\/([^/]+)$/, handler: handleGetProvider },
  { method: "PUT", re: /^\/v1\/providers\/([^/]+)$/, handler: handleUpdateProvider },
  { method: "DELETE", re: /^\/v1\/providers\/([^/]+)$/, handler: handleDeleteProvider },
  { method: "POST", re: /^\/v1\/providers\/([^/]+)\/default$/, handler: handleSetDefaultProvider },
  { method: "POST", re: /^\/v1\/providers\/([^/]+)\/test$/, handler: handleTestProvider },
  { method: "POST", re: /^\/v1\/sessions$/, handler: handleCreateSession },
  { method: "GET", re: /^\/v1\/sessions$/, handler: handleListSessions },
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/messages$/, handler: handleHistory },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/messages$/, handler: handleSendMessage },
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/stream$/, handler: handleStream },
];

export async function startRuntime(config: RuntimeConfig, options: RuntimeOptions = {}): Promise<RuntimeHandle> {
  const ledger = EventLedger.open(config.dataDir);
  // Device 记录（票 #3 的 M0 最小实现）：启动时从 replica-id 演化出的 config.replicaId 种子；
  // 不做配对/撤销（M3 范围）
  const devices = DeviceRegistry.open(config.dataDir);
  devices.touch(config.replicaId);
  const providers = new ProviderRegistry({
    dataDir: config.dataDir,
    secretStore: options.secretStore ?? detectSecretStore().store,
    envFallback: config.provider,
  });
  const sessions = new SessionManager({
    ledger,
    replicaId: config.replicaId,
    factory: options.agentAdapterFactory ?? defaultAgentFactory(),
    providers,
    // 注入工厂（测试/宿主自带 Agent Loop）时不做 Provider 预检（T4 语义）；默认工厂要求有 Provider
    providerRequired: options.agentAdapterFactory === undefined,
  });
  const ctx: RequestContext = { ledger, replicaId: config.replicaId, sessions, providers, devices };
  const server = createServer((req, res) => {
    routeRequest(req, res, ctx);
  });

  let port: number;
  try {
    port = await listen(server, config.host, config.port);
  } catch (err) {
    devices.close();
    ledger.close();
    throw err;
  }

  const startedEnvelope = buildEventEnvelope({
    replicaId: config.replicaId,
    actorId: "agent:runtime",
    eventType: "runtime.started",
    payload: { pid: process.pid, host: config.host, port, version: VERSION },
  });
  ledger.append(startedEnvelope);

  let closing = false;
  return {
    host: config.host,
    port,
    ledger,
    sessions,
    providers,
    devices,
    async close(signal?: string): Promise<void> {
      if (closing) return;
      closing = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // 会话运行先收尾（中止在跑的轮次并释放 AgentRuntime），再记账、再关账本
      await sessions.dispose();
      try {
        ledger.append(
          buildEventEnvelope({
            replicaId: config.replicaId,
            actorId: "agent:runtime",
            eventType: "runtime.stopped",
            payload: signal === undefined ? { reason: "graceful" } : { reason: "graceful", signal },
            causationId: startedEnvelope.event_id,
          }),
        );
      } catch (err) {
        console.error("[morrow] failed to append runtime.stopped:", err);
      }
      devices.close();
      ledger.close();
    },
  };
}

/** 生产默认工厂：按会话解析的 Provider → createPiAdapter（OpenAI 兼容协议，ADR-0002） */
function defaultAgentFactory(): (sessionId: string, provider: ResolvedProvider | null) => Promise<AgentRuntime> {
  return async (_sessionId, provider) => {
    if (provider === null) {
      throw new Error("no model provider configured");
    }
    return createPiAdapter({
      baseUrl: provider.baseUrl,
      // pi-ai 对空 key 抛 "No API key for provider"；免密端点（vLLM/Ollama）用其自身
      // 的 "unused" 占位约定（这些端点忽略 Authorization 头）
      apiKey: provider.apiKey.length > 0 ? provider.apiKey : "unused",
      model: { id: provider.modelId, contextWindow: provider.contextWindow, maxTokens: provider.maxTokens },
      ...(provider.compat !== undefined ? { compat: provider.compat } : {}),
    });
  };
}

function routeRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  // CORS：桌面 WebView 与浏览器联调是跨源客户端（PRD §6.1「渠道适配器亦为 API 客户端」）。
  // 只对本地来源（localhost / 127.0.0.1 / tauri://）放行——互联网页面的 Origin 不在列表内，
  // 其脚本发起的跨源读写会被浏览器拦截。但 CORS 不是 CSRF 的完整防线：不带自定义头的
  // simple POST（safelist content-type 如 text/plain）不经 preflight，请求本身仍会到达——
  // 防线第二道是 readJsonBody 强制 application/json（safelist 外 → 强制 preflight → 204 空
  // 白名单不放行；且服务器端直接 415 拒收）。残余风险见 docs/security/threat-model.md 域 4。
  // last-event-id 供 EventSource 断线重连携带（非 safelist 头，需进 preflight 白名单）。
  const origin = req.headers.origin;
  if (typeof origin === "string" && isLocalOrigin(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, last-event-id");
    // PUT/DELETE：设置 UI 的 Provider 编辑/删除（票 T7 / Issue #8）——跨源 WebView 需在白名单内
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if ((req.method ?? "").toUpperCase() === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    sendError(res, 400, "bad_request", "malformed request target");
    return;
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method ?? "GET").toUpperCase();

  const pathMatches = routes.filter((route) => route.re.test(pathname));
  if (pathMatches.length === 0) {
    sendError(res, 404, "not_found", `no route for ${pathname}`);
    return;
  }
  const route = pathMatches.find((candidate) => candidate.method === method);
  if (!route) {
    res.setHeader("Allow", [...new Set(pathMatches.map((candidate) => candidate.method))].join(", "));
    sendError(res, 405, "method_not_allowed", `${method} is not allowed on ${pathname}`);
    return;
  }
  const params = (route.re.exec(pathname) as RegExpExecArray).slice(1);
  try {
    const result = route.handler(req, res, url, ctx, params);
    if (result instanceof Promise) {
      result.catch((err: unknown) => handleAsyncError(res, err));
    }
  } catch (err) {
    handleAsyncError(res, err);
  }
}

function handleAsyncError(res: ServerResponse, err: unknown): void {
  console.error("[morrow] handler error:", err);
  if (!res.headersSent) {
    sendError(res, 500, "internal_error", "unexpected server error");
  } else {
    res.end();
  }
}

function handleHealth(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): void {
  sendJson(res, 200, {
    status: "ok",
    version: VERSION,
    replica_id: ctx.replicaId,
    sandbox: probeSandbox(),
    ledger: { events: ctx.ledger.count() },
  });
}

/** Device 记录列表（只读；M0 仅本副本一条——多设备是 M3 的事，票 #3） */
function handleListDevices(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): void {
  const devices: DeviceRecord[] = ctx.devices.list();
  sendJson(res, 200, { devices });
}

function handleEvents(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: RequestContext): void {
  const params = url.searchParams;
  let limit = 50;
  let offset = 0;
  let replicaId: string | undefined;

  const limitRaw = params.get("limit");
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 200) {
      sendError(res, 400, "invalid_query", "limit must be an integer between 1 and 200");
      return;
    }
    limit = Number(limitRaw);
  }
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null) {
    if (!/^\d+$/.test(offsetRaw)) {
      sendError(res, 400, "invalid_query", "offset must be a non-negative integer");
      return;
    }
    offset = Number(offsetRaw);
  }
  const replicaRaw = params.get("replica_id");
  if (replicaRaw !== null) {
    if (!UUID_RE.test(replicaRaw.toLowerCase())) {
      sendError(res, 400, "invalid_query", "replica_id must be a lowercase uuid");
      return;
    }
    replicaId = replicaRaw.toLowerCase();
  }

  sendJson(res, 200, ctx.ledger.list({ replicaId, limit, offset }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 本地控制面的放行来源：桌面壳（tauri://localhost、http://tauri.localhost）与浏览器联调 */
function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "tauri.localhost";
    return localHost && (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "tauri:");
  } catch {
    return false;
  }
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error(`unexpected server address: ${String(address)}`));
      }
    });
  });
}

// --- T4 会话族 handlers -----------------------------------------------------

interface CreateSessionBody {
  title?: unknown;
  provider_id?: unknown;
}

async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return; // 响应已在 readJsonBody 里写出
  const { title, provider_id: providerId } = body as CreateSessionBody;
  if (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) {
    sendError(res, 400, "invalid_body", "title must be a non-empty string when present");
    return;
  }
  if (providerId !== undefined && (typeof providerId !== "string" || !ctx.providers.exists(providerId))) {
    sendError(res, 400, "unknown_provider", `provider "${String(providerId)}" is not registered (GET /v1/providers for the list)`);
    return;
  }
  const created = ctx.sessions.createSession(
    title === undefined ? undefined : title.trim(),
    typeof providerId === "string" ? providerId : undefined,
  );
  sendJson(res, 201, {
    session_id: created.sessionId,
    event_id: created.eventId,
    sequence: created.sequence,
    occurred_at: created.occurredAt,
    ...(typeof providerId === "string" ? { provider_id: providerId } : {}),
    ...(title === undefined ? {} : { title: title.trim() }),
  });
}

function handleListSessions(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): void {
  sendJson(res, 200, { sessions: ctx.sessions.listSessions() });
}

interface SendMessageBody {
  text?: unknown;
}

async function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: RequestContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!ctx.sessions.sessionExists(sessionId)) {
    sendError(res, 404, "not_found", `session ${sessionId} does not exist`);
    return;
  }
  if (!ctx.sessions.agentAvailable) {
    sendError(res, 503, "provider_not_configured", ctx.sessions.agentUnavailableReason);
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const { text } = body as SendMessageBody;
  if (typeof text !== "string" || text.trim().length === 0) {
    sendError(res, 400, "invalid_body", "text must be a non-empty string");
    return;
  }
  const ack = ctx.sessions.sendUserMessage(sessionId, text);
  sendJson(res, 202, {
    message_id: ack.messageId,
    event_id: ack.eventId,
    sequence: ack.sequence,
    status: ack.status,
  });
}

function handleHistory(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  const sessionId = params[0];
  if (!ctx.sessions.sessionExists(sessionId)) {
    sendError(res, 404, "not_found", `session ${sessionId} does not exist`);
    return;
  }
  sendJson(res, 200, ctx.sessions.history(sessionId));
}

/**
 * SSE：会话事件流。每帧三类——
 *   event: <event_type> + id: <seq> + data: <信封 JSON>   账本事件（ durable，seq 保序）
 *   event: text_delta            + data: {"delta":"..."}  流式文本增量（易失，不落账本、无 id）
 *   event: done                  + data: {"session_id"}   本轮结束（空闲标记，易失）
 * 连接即重放：无 Last-Event-ID 从会话首事件起全量重放；携带 Last-Event-ID（数字 seq）
 * 只重放其后的账本事件，再接live 帧。重放与 live 之间按 seq 去重，顺序与账本一致。
 */
function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: RequestContext,
  params: string[],
): void {
  const sessionId = params[0];
  if (!ctx.sessions.sessionExists(sessionId)) {
    sendError(res, 404, "not_found", `session ${sessionId} does not exist`);
    return;
  }
  let afterSeq = 0;
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId !== undefined) {
    const parsed = Number(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
    if (!Number.isInteger(parsed) || parsed < 0) {
      sendError(res, 400, "invalid_query", "last-event-id must be a non-negative integer (ledger sequence)");
      return;
    }
    afterSeq = parsed;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  const sentSeqs = new Set<number>();
  const writeEvent = (frame: SessionFrame): void => {
    if (frame.kind === "event") {
      sentSeqs.add(frame.sequence);
      res.write(`event: ${frame.envelope.event_type}\nid: ${frame.sequence}\ndata: ${JSON.stringify(frame.envelope)}\n\n`);
    } else if (frame.kind === "delta") {
      res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: frame.delta })}\n\n`);
    } else {
      res.write(`event: done\ndata: ${JSON.stringify({ session_id: sessionId })}\n\n`);
    }
  };

  // 先订阅（缓存 live 帧）→ 重放历史 → 冲刷缓存（按 seq 去重）→ 切 live
  const buffered: SessionFrame[] = [];
  let live = false;
  const unsubscribe = ctx.sessions.subscribe(sessionId, (frame) => {
    if (!live) {
      buffered.push(frame);
      return;
    }
    if (frame.kind === "event" && sentSeqs.has(frame.sequence)) return;
    writeEvent(frame);
  }) as () => void; // sessionExists 已确认，退订函数必然存在

  for (const { sequence, envelope } of ctx.sessions.sessionEvents(sessionId, afterSeq)) {
    writeEvent({ kind: "event", sequence, envelope });
  }
  live = true;
  for (const frame of buffered.splice(0)) {
    if (frame.kind === "event" && sentSeqs.has(frame.sequence)) continue;
    writeEvent(frame);
  }
  if (!ctx.sessions.isRunning(sessionId)) {
    writeEvent({ kind: "done" });
  }

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  // 注意：req 的 'close' 在请求体读完（GET 立即）就触发；SSE 连接的生命周期要挂在
  // res 的 'close'（响应未 end，只在连接断开时触发）上做清理。
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// --- T5 Provider 族 handlers -------------------------------------------------
// 密钥安全不变量：任何响应/日志只含 has_api_key 投影，绝不回显 api_key（含错误路径——
// ProviderRegistryError 的消息不携带密钥内容；测试覆盖 JSON 全文不含密钥的断言）。

function handleProviderRegistryError(res: ServerResponse, err: unknown): void {
  if (err instanceof ProviderRegistryError) {
    const status = err.code === "invalid_input" ? 400 : err.code === "conflict" ? 409 : 404;
    sendError(res, status, `provider_${err.code}`, err.message);
    return;
  }
  throw err;
}

async function handleListProviders(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): Promise<void> {
  const providers = await ctx.providers.listAll();
  sendJson(res, 200, { providers, default_provider_id: await ctx.providers.defaultProviderId() });
}

async function handleRegisterProvider(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const record = await ctx.providers.register(body);
    sendJson(res, 201, record);
  } catch (err) {
    handleProviderRegistryError(res, err);
  }
}

async function handleGetProvider(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  const record = await ctx.providers.get(params[0]);
  if (record === null) {
    sendError(res, 404, "provider_not_found", `provider "${params[0]}" not found`);
    return;
  }
  sendJson(res, 200, record);
}

async function handleUpdateProvider(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const record = await ctx.providers.update(params[0], body);
    sendJson(res, 200, record);
  } catch (err) {
    handleProviderRegistryError(res, err);
  }
}

async function handleDeleteProvider(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  try {
    await ctx.providers.delete(params[0]);
    sendJson(res, 200, { deleted: true, provider_id: params[0] });
  } catch (err) {
    handleProviderRegistryError(res, err);
  }
}

async function handleSetDefaultProvider(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  try {
    await ctx.providers.setDefault(params[0]);
    sendJson(res, 200, { default_provider_id: await ctx.providers.defaultProviderId() });
  } catch (err) {
    handleProviderRegistryError(res, err);
  }
}

/** 连通性测试：对注册 Provider（或 env 回退）发一次最小 OpenAI 兼容请求，三类结果（见 connectivity.ts） */
async function handleTestProvider(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  const providerId = params[0];
  if (!ctx.providers.exists(providerId)) {
    sendError(res, 404, "provider_not_found", `provider "${providerId}" not found`);
    return;
  }
  const resolved = await ctx.providers.resolve(providerId);
  if (resolved === null) {
    sendError(res, 404, "provider_not_found", `provider "${providerId}" not found`);
    return;
  }
  const result = await testProviderConnectivity(resolved);
  sendJson(res, 200, result);
}

/**
 * 读取并解析 JSON 请求体；非法时写出 400/413/415 并返回 null。
 *
 * content-type 必须显式为 application/json：application/json 不在 CORS「简单请求」
 * safelist 内，跨源页面伪造的 simple POST（text/plain）会被强制走 preflight——
 * 这是写端点的 CSRF 防线之一（威胁模型域 4「浏览器网页 CSRF 向量」；曾不校验
 * content-type，M0 code-review / Issue #11 补上）。
 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse, maxBytes = 1_000_000): Promise<Record<string, unknown> | null> {
  const contentType = req.headers["content-type"];
  if (contentType === undefined || !/^application\/json\b/i.test(contentType.trim())) {
    sendError(res, 415, "unsupported_media_type", "content-type must be application/json");
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) {
      sendError(res, 413, "payload_too_large", `request body exceeds ${maxBytes} bytes`);
      return null;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    sendError(res, 400, "invalid_body", "a JSON object body is required");
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendError(res, 400, "invalid_body", "a JSON object body is required");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, "invalid_body", "malformed JSON body");
    return null;
  }
}
