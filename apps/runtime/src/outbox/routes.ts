import type { IncomingMessage, ServerResponse } from "node:http";
import type { OutboxStatus } from "@morrow/protocol";
import { parsePaging, readJsonBody, sendError, sendJson } from "../http-util.ts";
import { OutboxError, type OutboxService } from "./service.ts";

/**
 * Outbox 控制面路由（M4-T2 / Issue #39，FR-TASK-7 / FR-CH-7）：
 *
 *   GET  /v1/outbox?status=&limit=&offset=   外发审计列表（分页；status 可选）
 *   POST /v1/outbox/:id/retry                人工显式重试（仅 failed / needs_review；
 *                                            needs_review 需 body {"confirmed": true}）
 *   POST /v1/outbox/:id/mark-sent            人工标记已送达（写 manual receipt + 审计）
 *
 * 自动 dispatch 不暴露 HTTP：由 channel 域驱动（OutboxService.dispatchOnce）。本文件只承载
 * Owner 的人工核对出口——这正是「未知状态宁可人工核对也不自动重发」的落点。
 */

export interface OutboxRouteContext {
  outbox: OutboxService;
}

export interface OutboxRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: OutboxRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

const OUTBOX_STATUSES: readonly OutboxStatus[] = [
  "pending",
  "sent",
  "failed",
  "delivery_unknown",
  "needs_review",
];

export const outboxRoutes: OutboxRoute[] = [
  { method: "GET", re: /^\/v1\/outbox$/, handler: handleList },
  { method: "POST", re: /^\/v1\/outbox\/([^/]+)\/retry$/, handler: handleRetry },
  { method: "POST", re: /^\/v1\/outbox\/([^/]+)\/mark-sent$/, handler: handleMarkSent },
];

function handleList(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: OutboxRouteContext,
): void {
  const statusRaw = url.searchParams.get("status");
  if (statusRaw !== null && !OUTBOX_STATUSES.includes(statusRaw as OutboxStatus)) {
    sendError(res, 400, "invalid_query", `status must be one of ${OUTBOX_STATUSES.join(" | ")}`);
    return;
  }
  const page = parsePaging(url, res, { defaultLimit: 50 });
  if (page === null) return;
  const result = ctx.outbox.list({
    ...(statusRaw === null ? {} : { status: statusRaw as OutboxStatus }),
    limit: page.limit,
    offset: page.offset,
  });
  sendJson(res, 200, result);
}

async function handleRetry(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: OutboxRouteContext,
  params: string[],
): Promise<void> {
  // body 可选（failed 行重试不需要确认）；needs_review 必须 {"confirmed": true}。
  let body: Record<string, unknown> = {};
  if (req.headers["content-type"] !== undefined) {
    const parsed = await readJsonBody(req, res);
    if (parsed === null) return;
    body = parsed;
  }
  if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") {
    sendError(res, 400, "invalid_body", "confirmed must be a boolean when present");
    return;
  }
  try {
    const message = ctx.outbox.retry(params[0], {
      ...(body.confirmed === true ? { confirmed: true } : {}),
    });
    sendJson(res, 200, { message });
  } catch (err) {
    if (!sendOutboxError(res, err)) throw err;
  }
}

async function handleMarkSent(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: OutboxRouteContext,
  params: string[],
): Promise<void> {
  let body: Record<string, unknown> = {};
  if (req.headers["content-type"] !== undefined) {
    const parsed = await readJsonBody(req, res);
    if (parsed === null) return;
    body = parsed;
  }
  if (
    body.platform_message_id !== undefined &&
    (typeof body.platform_message_id !== "string" || body.platform_message_id.length === 0)
  ) {
    sendError(res, 400, "invalid_body", "platform_message_id must be a non-empty string when present");
    return;
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    sendError(res, 400, "invalid_body", "note must be a string when present");
    return;
  }
  try {
    const message = ctx.outbox.markSent(params[0], {
      ...(typeof body.platform_message_id === "string" ? { platformMessageId: body.platform_message_id } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
    });
    sendJson(res, 200, { message });
  } catch (err) {
    if (!sendOutboxError(res, err)) throw err;
  }
}

/** OutboxError → HTTP：404 不存在；400 入参；409 状态/确认门；503 适配器未接线 */
function sendOutboxError(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof OutboxError)) return false;
  const status =
    err.code === "not_found"
      ? 404
      : err.code === "invalid_input"
        ? 400
        : err.code === "invalid_status" || err.code === "confirmation_required"
          ? 409
          : 503;
  sendJson(res, status, {
    error: { code: `outbox_${err.code}`, message: err.message, ...(err.details ?? {}) },
  });
  return true;
}
