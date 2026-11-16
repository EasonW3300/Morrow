import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "./http-util.ts";
import { PersonaService, PersonaValidationError } from "./persona.ts";

/**
 * Persona 控制面路由（票 M7-A-T1 / Issue #58，FR-A1/A5）：
 *
 *   GET /v1/persona  当前人设（无 persona.updated 事件时返回默认值，缺省即默认）
 *   PUT /v1/persona  校验并保存（写 persona.updated，actor=owner，payload=全量 Persona）
 *
 * 响应形状与既有控制面一致：GET 包 `{ persona }`；PUT 额外带 event_id/sequence/
 * occurred_at，便于 UI/审计定位这次变更。校验失败一律 400 invalid_persona。
 */
export interface PersonaRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: PersonaRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface PersonaRouteContext {
  persona: PersonaService;
}

export const personaRoutes: PersonaRoute[] = [
  { method: "GET", re: /^\/v1\/persona$/, handler: handleGetPersona },
  { method: "PUT", re: /^\/v1\/persona$/, handler: handleUpdatePersona },
];

function handleGetPersona(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PersonaRouteContext,
): void {
  sendJson(res, 200, { persona: ctx.persona.get() });
}

async function handleUpdatePersona(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PersonaRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return; // 响应已在 readJsonBody 里写出（415/413/400）
  try {
    const result = ctx.persona.update(body);
    sendJson(res, 200, {
      persona: result.persona,
      event_id: result.eventId,
      sequence: result.sequence,
      occurred_at: result.occurredAt,
    });
  } catch (err) {
    if (err instanceof PersonaValidationError) {
      sendError(res, 400, err.code, err.message);
      return;
    }
    throw err;
  }
}
