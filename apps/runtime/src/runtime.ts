import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import packageJson from "../package.json" with { type: "json" };
import type { RuntimeConfig } from "./config.ts";
import { probeSandbox } from "./health.ts";
import { EventLedger } from "./ledger.ts";
import { uuidv7 } from "./uuid-v7.ts";
import { computeIntegrityHash, type EventEnvelope } from "@morrow/protocol";

/**
 * Runtime HTTP 服务（PRD §6.2 的 M0 子集）。
 *
 * node:http + 极简路由，不引框架——为 T8 bun compile 单二进制留路（ADR-0003）。
 * 路由面：GET /v1/health、GET /v1/events。未匹配路径 404，路径命中但方法不符 405
 * （账本 append-only：对事件的任何变更方法在请求层即被拒绝）。
 * 生命周期：start 先监听后记账 runtime.started（携带实际端口）；close 先停收请求，
 * 再记账 runtime.stopped（causation 指向 started），最后关闭账本落盘。
 */

const VERSION: string = packageJson.version;

interface RequestContext {
  ledger: EventLedger;
  replicaId: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, ctx: RequestContext) => void;

interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
}

export interface RuntimeHandle {
  host: string;
  port: number;
  ledger: EventLedger;
  /**
   * 优雅停止：停止接收请求 → 记账 runtime.stopped → 关闭账本（WAL checkpoint）。
   * signal 传入收到的 POSIX 信号名，落进 stopped 事件的 payload。
   */
  close(signal?: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const routes: Route[] = [
  { method: "GET", re: /^\/v1\/health$/, handler: handleHealth },
  { method: "GET", re: /^\/v1\/events$/, handler: handleEvents },
];

export async function startRuntime(config: RuntimeConfig): Promise<RuntimeHandle> {
  const ledger = EventLedger.open(config.dataDir);
  const ctx: RequestContext = { ledger, replicaId: config.replicaId };
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

  const startedEnvelope = runtimeLifecycleEnvelope(config.replicaId, "runtime.started", {
    pid: process.pid,
    host: config.host,
    port,
    version: VERSION,
  });
  ledger.append(startedEnvelope);

  let closing = false;
  return {
    host: config.host,
    port,
    ledger,
    async close(signal?: string): Promise<void> {
      if (closing) return;
      closing = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        ledger.append(
          runtimeLifecycleEnvelope(
            config.replicaId,
            "runtime.stopped",
            signal === undefined ? { reason: "graceful" } : { reason: "graceful", signal },
            startedEnvelope.event_id,
          ),
        );
      } catch (err) {
        console.error("[morrow] failed to append runtime.stopped:", err);
      }
      ledger.close();
    },
  };
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
  try {
    route.handler(req, res, url, ctx);
  } catch (err) {
    console.error("[morrow] handler error:", err);
    if (!res.headersSent) {
      sendError(res, 500, "internal_error", "unexpected server error");
    } else {
      res.end();
    }
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

/** 进程生命周期事件的信封（本票唯一的写入口；Agent 对话事件在 T4 接入） */
function runtimeLifecycleEnvelope(
  replicaId: string,
  eventType: "runtime.started" | "runtime.stopped",
  payload: Record<string, unknown>,
  causationEventId?: string,
): EventEnvelope {
  const envelope: EventEnvelope = {
    event_id: uuidv7(),
    replica_id: replicaId,
    actor_id: "agent:runtime",
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    causation_id: eventType === "runtime.stopped" ? (causationEventId ?? null) : null,
    schema_version: 1,
    payload,
    integrity_hash: "",
  };
  envelope.integrity_hash = computeIntegrityHash(envelope);
  return envelope;
}
