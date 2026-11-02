import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { CapabilityError, type PermissionEngine } from "./engine.ts";

/**
 * 能力控制面路由（票 M2-T1 / Issue #22，PRD §6.2 能力端点）：
 *
 *   POST /v1/capabilities                      注册（body = manifest v1 全文；校验 +
 *                                              permissions ⊆ grants 五维判定 + 版本化存档）
 *   GET  /v1/capabilities[?status=&author=&runtime=]  能力清单（过滤）
 *   GET  /v1/capabilities/grants               当前五维授权（声明在 :id 之前——路由按
 *                                              声明序首个方法匹配，避免 "grants" 被
 *                                              :id 吞掉）
 *   PUT  /v1/capabilities/grants               更新授权面（capability.grants_updated 审计）
 *   GET  /v1/capabilities/:id                  详情（当前记录 + 版本历史）
 *   POST /v1/capabilities/:id/enable|disable   生命周期（幂等；迁移才审计）
 *   POST /v1/capabilities/:id/rollback         回滚（body {version} 必填；目标版本须存在）
 *
 * 独立成文件以收拢能力路由改动面（memory/routes.ts 同款模式）；错误信封形状与
 * runtime.ts 全局约定一致（`{ error: { code, message } }`）。
 */

export interface CapabilityRoute {
  method: string;
  re: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: CapabilityRouteContext, params: string[]) => void | Promise<void>;
}

export interface CapabilityRouteContext {
  capabilities: PermissionEngine;
}

const LIST_STATUSES = ["enabled", "disabled"] as const;
const LIST_AUTHORS = ["human", "ai"] as const;
const LIST_RUNTIMES = ["typescript", "go"] as const;

export const capabilityRoutes: CapabilityRoute[] = [
  {
    method: "GET",
    re: /^\/v1\/capabilities\/grants$/,
    handler: handleGetGrants,
  },
  {
    method: "PUT",
    re: /^\/v1\/capabilities\/grants$/,
    handler: handlePutGrants,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities$/,
    handler: handleRegister,
  },
  {
    method: "GET",
    re: /^\/v1\/capabilities$/,
    handler: handleList,
  },
  {
    method: "GET",
    re: /^\/v1\/capabilities\/([^/]+)$/,
    handler: handleGetCapability,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities\/([^/]+)\/enable$/,
    handler: handleEnable,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities\/([^/]+)\/disable$/,
    handler: handleDisable,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities\/([^/]+)\/rollback$/,
    handler: handleRollback,
  },
];

async function handleRegister(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: CapabilityRouteContext): Promise<void> {
  const body = await readBody(req, res);
  if (body === null) return;
  try {
    const result = ctx.capabilities.register(body);
    sendJson(res, result.created ? 201 : 200, {
      capability: result.record,
      created: result.created,
      ...(result.eventId === null ? {} : { event_id: result.eventId }),
    });
  } catch (err) {
    handleCapabilityError(res, err);
  }
}

function handleList(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: CapabilityRouteContext): void {
  const filters: { status?: "enabled" | "disabled"; author?: "human" | "ai"; runtime?: "typescript" | "go" } = {};
  for (const [param, allowed] of [
    ["status", LIST_STATUSES],
    ["author", LIST_AUTHORS],
    ["runtime", LIST_RUNTIMES],
  ] as const) {
    const raw = url.searchParams.get(param);
    if (raw === null) continue;
    if (!(allowed as readonly string[]).includes(raw)) {
      sendError(res, 400, "invalid_query", `${param} must be one of ${allowed.join(" | ")}`);
      return;
    }
    (filters as Record<string, string>)[param] = raw;
  }
  sendJson(res, 200, { capabilities: ctx.capabilities.list(filters) });
}

function handleGetCapability(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: CapabilityRouteContext, params: string[]): void {
  const detail = ctx.capabilities.get(params[0]);
  if (detail === null) {
    sendError(res, 404, "capability_not_found", `capability "${params[0]}" is not registered`);
    return;
  }
  sendJson(res, 200, detail);
}

function handleEnable(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: CapabilityRouteContext, params: string[]): void {
  try {
    const { record, changed } = ctx.capabilities.enable(params[0]);
    sendJson(res, 200, { capability: record, changed });
  } catch (err) {
    handleCapabilityError(res, err);
  }
}

function handleDisable(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: CapabilityRouteContext, params: string[]): void {
  try {
    const { record, changed } = ctx.capabilities.disable(params[0]);
    sendJson(res, 200, { capability: record, changed });
  } catch (err) {
    handleCapabilityError(res, err);
  }
}

interface RollbackBody {
  version?: unknown;
}

async function handleRollback(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: CapabilityRouteContext, params: string[]): Promise<void> {
  const body = await readBody(req, res);
  if (body === null) return;
  const { version } = body as RollbackBody;
  if (typeof version !== "string" || version.trim().length === 0) {
    sendError(res, 400, "invalid_body", "version must be a non-empty string (the target version to roll back to)");
    return;
  }
  try {
    const result = ctx.capabilities.rollback(params[0], version);
    sendJson(res, 200, { capability: result.record, from_version: result.from_version, to_version: result.to_version });
  } catch (err) {
    handleCapabilityError(res, err);
  }
}

function handleGetGrants(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: CapabilityRouteContext): void {
  sendJson(res, 200, { grants: ctx.capabilities.getGrants() });
}

async function handlePutGrants(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: CapabilityRouteContext): Promise<void> {
  const body = await readBody(req, res);
  if (body === null) return;
  try {
    const { grants, eventId } = ctx.capabilities.setGrants(body.grants === undefined ? body : body.grants);
    sendJson(res, 200, { grants, event_id: eventId });
  } catch (err) {
    handleCapabilityError(res, err);
  }
}

/** 读 JSON body（415/413/400 已在 http-util 写出） */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  return readJsonBody(req, res);
}

/**
 * CapabilityError → HTTP：invalid_input / invalid_manifest / source_hash_mismatch /
 * sandbox_required / escalation 400（escalation message 含逐维逐项超界原因）；
 * version_conflict / invalid_state 409；not_found / version_not_found 404；其余上抛 500。
 */
export function handleCapabilityError(res: ServerResponse, err: unknown): void {
  if (err instanceof CapabilityError) {
    const status =
      err.code === "not_found" || err.code === "version_not_found"
        ? 404
        : err.code === "version_conflict" || err.code === "invalid_state"
          ? 409
          : 400;
    sendError(res, status, `capability_${err.code}`, err.message);
    return;
  }
  throw err;
}
