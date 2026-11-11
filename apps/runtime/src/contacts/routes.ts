import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { ContactError, type ContactService } from "./service.ts";

/**
 * 可信联系人控制面（M4-T6 / Issue #43，PRD §4.8 FR-NOT-3 / §5.2 流程 5）：
 *
 *   POST /v1/contacts/invites             Owner 生成一次性邀请码（可带 contact_id 或
 *                                         display_name；默认新建联系人且只有 query）
 *   GET  /v1/contacts                     联系人 + 授权 + 平台身份绑定
 *   GET  /v1/contacts/:id/grants          授权类别（query | task_execute | memory_reference）
 *   PUT  /v1/contacts/:id/grants          整表替换 { grants: [{ category, scope? }] }
 *   GET  /v1/contacts/ambiguities?status= 身份歧义（同一平台发送者匹配多个联系人）
 *   POST /v1/contacts/ambiguities/:id/resolve  Owner 选择（不自动合并）
 *
 * 错误信封与 runtime 全局一致（`{ error: { code, message } }`）。
 */

export interface ContactRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: ContactRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface ContactRouteContext {
  contacts: ContactService;
}

export const contactRoutes: ContactRoute[] = [
  { method: "POST", re: /^\/v1\/contacts\/invites$/, handler: handleCreateInvite },
  { method: "GET", re: /^\/v1\/contacts$/, handler: handleListContacts },
  { method: "GET", re: /^\/v1\/contacts\/ambiguities$/, handler: handleListAmbiguities },
  { method: "POST", re: /^\/v1\/contacts\/ambiguities\/([^/]+)\/resolve$/, handler: handleResolveAmbiguity },
  { method: "GET", re: /^\/v1\/contacts\/([^/]+)\/grants$/, handler: handleGetGrants },
  { method: "PUT", re: /^\/v1\/contacts\/([^/]+)\/grants$/, handler: handlePutGrants },
];

const AMBIGUITY_STATUSES = ["open", "resolved"] as const;

async function handleCreateInvite(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ContactRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  if (typeof body !== "object" || Array.isArray(body)) {
    sendError(res, 400, "invalid_body", "body must be a JSON object");
    return;
  }
  try {
    const invite = ctx.contacts.createInvite(body as Record<string, unknown>);
    sendJson(res, 201, invite);
  } catch (err) {
    sendContactError(res, err);
  }
}

function handleListContacts(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: ContactRouteContext): void {
  sendJson(res, 200, { contacts: ctx.contacts.listContacts() });
}

function handleListAmbiguities(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ContactRouteContext,
): void {
  const status = url.searchParams.get("status");
  if (status !== null && !(AMBIGUITY_STATUSES as readonly string[]).includes(status)) {
    sendError(res, 400, "invalid_query", `status must be one of ${AMBIGUITY_STATUSES.join(" | ")}`);
    return;
  }
  sendJson(res, 200, {
    ambiguities: ctx.contacts.listAmbiguities(
      status === null ? {} : { status: status as (typeof AMBIGUITY_STATUSES)[number] },
    ),
  });
}

async function handleResolveAmbiguity(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ContactRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const contactId = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { contact_id?: unknown }).contact_id
    : undefined;
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    sendError(res, 400, "invalid_body", "contact_id must be a non-empty string");
    return;
  }
  try {
    sendJson(res, 200, ctx.contacts.resolveAmbiguity(params[0] as string, contactId.trim()));
  } catch (err) {
    sendContactError(res, err);
  }
}

function handleGetGrants(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ContactRouteContext,
  params: string[],
): void {
  const contactId = params[0] as string;
  try {
    sendJson(res, 200, { contact_id: contactId, grants: ctx.contacts.getGrants(contactId) });
  } catch (err) {
    sendContactError(res, err);
  }
}

async function handlePutGrants(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ContactRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const contactId = params[0] as string;
  try {
    sendJson(res, 200, { contact_id: contactId, grants: ctx.contacts.setGrants(contactId, body) });
  } catch (err) {
    sendContactError(res, err);
  }
}

function sendContactError(res: ServerResponse, err: unknown): void {
  if (err instanceof ContactError) {
    const status = err.code === "not_found" ? 404 : err.code === "invalid_state" ? 409 : 400;
    sendError(res, status, err.code, err.message);
    return;
  }
  throw err;
}
