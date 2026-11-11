/**
 * 工厂控制面路由（票 M2-T3 / Issue #24，PRD §6.2 能力端点扩展）：
 *
 *   POST /v1/capabilities/request          触发全流程（fire-and-forget 阶段执行；
 *                                          201 返回 request_id——失败在阶段内落
 *                                          factory_failed 事件，不以状态码转述）
 *   GET  /v1/capabilities/requests/:id     进度/阶段/报告（轮询观察口径）
 *   POST /v1/capabilities/:id/confirm      Owner 确认门：proposed → 注册
 *                                          （author=ai 默认 disabled 语义不变）
 *
 * 错误信封与全局约定一致（{error:{code,message}}）；CapabilityError 映射复用
 * capabilities/routes.ts 的 handleCapabilityError（confirm 的 409/400 语义同源）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "../../http-util.ts";
import type { CapabilityFactory } from "./service.ts";
import { handleCapabilityError } from "../routes.ts";

export interface FactoryRoute {
  method: string;
  re: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, url: URL, factory: CapabilityFactory, params: string[]) => void | Promise<void>;
}

export const factoryRoutes: FactoryRoute[] = [
  {
    method: "POST",
    re: /^\/v1\/capabilities\/request$/,
    handler: handleCreateRequest,
  },
  {
    method: "GET",
    re: /^\/v1\/capabilities\/requests\/([^/]+)$/,
    handler: handleGetRequest,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities\/([^/]+)\/confirm$/,
    handler: handleConfirm,
  },
];

interface CreateRequestBody {
  description?: unknown;
}

async function handleCreateRequest(req: IncomingMessage, res: ServerResponse, _url: URL, factory: CapabilityFactory): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const { description } = body as CreateRequestBody;
  if (typeof description !== "string" || description.trim().length === 0) {
    sendError(res, 400, "invalid_body", "description must be a non-empty string (the capability requirement)");
    return;
  }
  try {
    const { requestId } = factory.submitRequest(description);
    const view = factory.getRequest(requestId);
    sendJson(res, 201, {
      request_id: requestId,
      status: view?.status ?? "submitted",
      stage: view?.stage ?? "submitted",
    });
  } catch (err) {
    handleCapabilityError(res, err);
  }
}

function handleGetRequest(_req: IncomingMessage, res: ServerResponse, _url: URL, factory: CapabilityFactory, params: string[]): void {
  const view = factory.getRequest(params[0]);
  if (view === null) {
    sendError(res, 404, "factory_request_not_found", `factory request "${params[0]}" does not exist`);
    return;
  }
  sendJson(res, 200, view);
}

function handleConfirm(_req: IncomingMessage, res: ServerResponse, _url: URL, factory: CapabilityFactory, params: string[]): void {
  try {
    const { request, capability, eventId } = factory.confirm(params[0]);
    sendJson(res, 200, {
      request,
      capability,
      event_id: eventId,
    });
  } catch (err) {
    handleCapabilityError(res, err);
  }
}
