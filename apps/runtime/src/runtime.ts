import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createPiAdapter, type AgentRuntime } from "@morrow/pi-adapter";
import packageJson from "../package.json" with { type: "json" };
import type { ProviderConfig, RuntimeConfig } from "./config.ts";
import { probeSandbox } from "./health.ts";
import { EventLedger } from "./ledger.ts";
import { SessionManager, type SessionFrame } from "./sessions.ts";
import { buildEventEnvelope } from "./envelope.ts";
import { computeIntegrityHash, type EventEnvelope } from "@morrow/protocol";

/**
 * Runtime HTTP 服务（PRD §6.2 的 M0 子集）。
 *
 * node:http + 极简路由，不引框架——为 T8 bun compile 单二进制留路（ADR-0003）。
 * 路由面：GET /v1/health、GET /v1/events、T4 会话族（POST/GET /v1/sessions、
 * POST/GET /v1/sessions/:id/messages、GET /v1/sessions/:id/stream SSE）。
 * 未匹配路径 404，路径命中但方法不符 405（账本 append-only：对事件的任何变更
 * 方法在请求层即被拒绝）。
 * 生命周期：start 先监听后记账 runtime.started（携带实际端口）；close 先停收请求，
 * 再中止会话运行并释放 AgentRuntime，然后记账 runtime.stopped（causation 指向
 * started），最后关闭账本落盘。
 */

const VERSION: string = packageJson.version;

interface RequestContext {
  ledger: EventLedger;
  replicaId: string;
  sessions: SessionManager;
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
   * Agent Loop 运行时工厂（PiAdapter 接口注入 seam）。缺省时由 config.provider
   * 构建 createPiAdapter 工厂；provider 未配置则发消息 503（provider_not_configured）。
   */
  agentAdapterFactory?: (sessionId: string) => Promise<AgentRuntime>;
}

export interface RuntimeHandle {
  host: string;
  port: number;
  ledger: EventLedger;
  /** 会话管理器（库形态可直用：abort / 订阅等测试与宿主 seam） */
  sessions: SessionManager;
  /**
   * 优雅停止：停止接收请求 → 中止并释放会话运行时 → 记账 runtime.stopped →
   * 关闭账本（WAL checkpoint）。signal 传入收到的 POSIX 信号名，落进 stopped 事件的 payload。
   */
  close(signal?: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const routes: Route[] = [
  { method: "GET", re: /^\/v1\/health$/, handler: handleHealth },
  { method: "GET", re: /^\/v1\/events$/, handler: handleEvents },
  { method: "POST", re: /^\/v1\/sessions$/, handler: handleCreateSession },
  { method: "GET", re: /^\/v1\/sessions$/, handler: handleListSessions },
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/messages$/, handler: handleHistory },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/messages$/, handler: handleSendMessage },
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/stream$/, handler: handleStream },
];

export async function startRuntime(config: RuntimeConfig, options: RuntimeOptions = {}): Promise<RuntimeHandle> {
  const ledger = EventLedger.open(config.dataDir);
  const sessions = new SessionManager({
    ledger,
    replicaId: config.replicaId,
    factory: options.agentAdapterFactory ?? defaultAgentFactory(config.provider),
  });
  const ctx: RequestContext = { ledger, replicaId: config.replicaId, sessions };
  const server = createServer((req, res) => {
    routeRequest(req, res, ctx);
  });

  let port: number;
  try {
    port = await listen(server, config.host, config.port);
  } catch (err) {
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
      ledger.close();
    },
  };
}

/** 生产默认工厂：config.provider → createPiAdapter（OpenAI 兼容协议，ADR-0002） */
function defaultAgentFactory(provider: ProviderConfig | null): ((sessionId: string) => Promise<AgentRuntime>) | null {
  if (provider === null) return null;
  return async () =>
    createPiAdapter({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: { id: provider.modelId, contextWindow: provider.contextWindow, maxTokens: provider.maxTokens },
    });
}

function routeRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
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
}

async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return; // 响应已在 readJsonBody 里写出
  const { title } = body as CreateSessionBody;
  if (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) {
    sendError(res, 400, "invalid_body", "title must be a non-empty string when present");
    return;
  }
  const created = ctx.sessions.createSession(title === undefined ? undefined : title.trim());
  sendJson(res, 201, {
    session_id: created.sessionId,
    event_id: created.eventId,
    sequence: created.sequence,
    occurred_at: created.occurredAt,
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

/** 读取并解析 JSON 请求体；非法时写出 400/413 并返回 null */
async function readJsonBody(req: IncomingMessage, res: ServerResponse, maxBytes = 1_000_000): Promise<Record<string, unknown> | null> {
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
