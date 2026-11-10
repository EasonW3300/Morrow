import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  NotificationDeliveryStatus,
  NotificationRuleInput,
} from "@morrow/protocol";
import { NOTIFICATION_EVENT_TYPE_VALUES } from "@morrow/protocol";
import { parsePaging, readJsonBody, sendError, sendJson } from "../http-util.ts";
import { NotificationError, type NotificationService } from "./service.ts";

/**
 * 通知控制面路由（M4-T7 / Issue #44，PRD §4.8 FR-NOT-1/2）：
 *
 *   GET  /v1/notifications/rules              规则清单
 *   PUT  /v1/notifications/rules              按 (event_type, target) key 合并 upsert + 审计
 *   GET  /v1/notifications/history            已发/延迟/失败通知与状态（分页、status 过滤）
 *   GET  /v1/notifications/pending            桌面待拉取（同时放行到点的免打扰延迟行）
 *   POST /v1/notifications/:id/ack            桌面通知确认（pending → sent）
 *
 * 桌面投递选择轮询而非 SSE：通知量小、需跨重启持久、UI 可幂等重复拉取；渠道投递不经
 * 本文件，一律由 NotificationService 入 Outbox 后由投递器外发。
 */

export interface NotificationRouteContext {
  notifications: NotificationService;
}

export interface NotificationRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: NotificationRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

const DELIVERY_STATUSES: readonly NotificationDeliveryStatus[] = [
  "pending",
  "delayed",
  "queued",
  "sent",
  "failed",
  "delivery_unknown",
  "needs_review",
];

export const notificationRoutes: NotificationRoute[] = [
  { method: "GET", re: /^\/v1\/notifications\/rules$/, handler: handleListRules },
  { method: "PUT", re: /^\/v1\/notifications\/rules$/, handler: handlePutRules },
  { method: "GET", re: /^\/v1\/notifications\/history$/, handler: handleHistory },
  { method: "GET", re: /^\/v1\/notifications\/pending$/, handler: handlePending },
  { method: "POST", re: /^\/v1\/notifications\/([^/]+)\/ack$/, handler: handleAck },
];

function handleListRules(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: NotificationRouteContext,
): void {
  sendJson(res, 200, { rules: ctx.notifications.listRules() });
}

async function handlePutRules(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: NotificationRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const rules = body.rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    sendError(res, 400, "invalid_body", "rules must be a non-empty array");
    return;
  }
  for (const entry of rules) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      sendError(res, 400, "invalid_body", "each rule must be an object");
      return;
    }
    const eventType = (entry as Record<string, unknown>).event_type;
    if (typeof eventType !== "string" || !NOTIFICATION_EVENT_TYPE_VALUES.includes(eventType as never)) {
      sendError(res, 400, "invalid_body", `event_type must be one of ${NOTIFICATION_EVENT_TYPE_VALUES.join(" | ")}`);
      return;
    }
  }
  try {
    const written = ctx.notifications.upsertRules(rules as NotificationRuleInput[]);
    sendJson(res, 200, { rules: written });
  } catch (err) {
    if (!sendNotificationError(res, err)) throw err;
  }
}

function handleHistory(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: NotificationRouteContext,
): void {
  const statusRaw = url.searchParams.get("status");
  if (statusRaw !== null && !DELIVERY_STATUSES.includes(statusRaw as NotificationDeliveryStatus)) {
    sendError(res, 400, "invalid_query", `status must be one of ${DELIVERY_STATUSES.join(" | ")}`);
    return;
  }
  const page = parsePaging(url, res, { defaultLimit: 50 });
  if (page === null) return;
  sendJson(
    res,
    200,
    ctx.notifications.history({
      ...(statusRaw === null ? {} : { status: statusRaw as NotificationDeliveryStatus }),
      limit: page.limit,
      offset: page.offset,
    }),
  );
}

function handlePending(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: NotificationRouteContext,
): void {
  const page = parsePaging(url, res, { defaultLimit: 50 });
  if (page === null) return;
  sendJson(res, 200, { notifications: ctx.notifications.pendingDesktop(page.limit) });
}

function handleAck(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: NotificationRouteContext,
  params: string[],
): void {
  try {
    sendJson(res, 200, { notification: ctx.notifications.acknowledge(params[0]) });
  } catch (err) {
    if (!sendNotificationError(res, err)) throw err;
  }
}

/** NotificationError → HTTP：404 不存在；400 入参；409 状态不符 */
function sendNotificationError(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof NotificationError)) return false;
  const status = err.code === "not_found" ? 404 : err.code === "invalid_status" ? 409 : 400;
  sendError(res, status, `notification_${err.code}`, err.message);
  return true;
}
