import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import type { PlanModeRegistry } from "./mode.ts";

/**
 * Plan 模式控制面（票 M7-C-T2 / Issue #76，FR-C1/C4）。
 *
 *   POST /v1/sessions/:id/plan/enter   进入只读计划模式
 *   POST /v1/sessions/:id/plan/exit    退出
 *   GET  /v1/sessions/:id/plan         当前状态（是否在 Plan、阶段、只读能力清单）
 *   PUT  /v1/sessions/:id/plan/phase   切换阶段（explore/clarify/detail）
 *
 * 进入/退出都写审计（`plan.mode_entered` / `plan.mode_exited`）。阶段切换写
 * `plan.phase_changed`（C3 会用到，但事件在此先就位——C3 只加流程不加事件）。
 *
 * 关于「自动回合不得自行进入/离开 Plan」（FR-C4）：这条由**接口形状**保证——
 * 进入/退出只有 HTTP 端点，模型侧没有对应工具（`planModeSession` 只读不写）。
 * C3 会有测试断言这一点。
 */
export interface PlanRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: PlanRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface PlanRouteContext {
  planMode: PlanModeRegistry;
  ledger: EventLedger;
  replicaId: string;
  /** 会话可执行（存在、未关闭、未删除） */
  isSessionExecutable(sessionId: string): boolean;
  sessionExists(sessionId: string): boolean;
}

/** Plan 的三个阶段（C3 的对话流用同一套取值） */
export const PLAN_PHASES: readonly string[] = ["explore", "clarify", "detail"];

export const planRoutes: PlanRoute[] = [
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/plan$/, handler: handleGet },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/plan\/enter$/, handler: handleEnter },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/plan\/exit$/, handler: handleExit },
  { method: "PUT", re: /^\/v1\/sessions\/([^/]+)\/plan\/phase$/, handler: handlePhase },
];

function assertExecutable(res: ServerResponse, ctx: PlanRouteContext, sessionId: string): boolean {
  if (!ctx.sessionExists(sessionId)) {
    sendError(res, 404, "not_found", `session ${sessionId} does not exist`);
    return false;
  }
  if (!ctx.isSessionExecutable(sessionId)) {
    sendError(
      res,
      409,
      "session_not_executable",
      `session ${sessionId} is closed or deleted; plan mode is unavailable`,
    );
    return false;
  }
  return true;
}

function handleGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PlanRouteContext,
  params: string[],
): void {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  sendJson(res, 200, {
    session_id: sessionId,
    active: ctx.planMode.isActive(sessionId),
    phase: ctx.planMode.phaseOf(sessionId),
    phases: PLAN_PHASES,
    // 明确回传"不持久化"：UI 需要据此说明"关闭会话后回到普通模式"
    persisted: false,
    // 只读契约说明（UI 展示给 Owner 看）
    readonly_notice:
      "计划模式下工具集只含只读工具（读文件/列目录/搜代码/git 只读命令/记忆检索）；" +
      "写操作在工具装配层就不提供，即使模型尝试调用也会被拒并留审计。",
  });
}

async function handleEnter(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PlanRouteContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  const result = ctx.planMode.enter(sessionId);
  if (result.changed) {
    appendEvent(ctx, "plan.mode_entered", sessionId, { phase: ctx.planMode.phaseOf(sessionId) });
  }
  sendJson(res, 200, {
    session_id: sessionId,
    active: result.active,
    changed: result.changed,
    phase: ctx.planMode.phaseOf(sessionId),
    persisted: false,
  });
}

async function handleExit(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PlanRouteContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  const result = ctx.planMode.exit(sessionId);
  if (result.changed) {
    appendEvent(ctx, "plan.mode_exited", sessionId, {});
  }
  sendJson(res, 200, {
    session_id: sessionId,
    active: result.active,
    changed: result.changed,
    persisted: false,
  });
}

async function handlePhase(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PlanRouteContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const phase = body.phase;
  if (typeof phase !== "string" || !PLAN_PHASES.includes(phase)) {
    sendError(res, 400, "invalid_body", `phase must be one of: ${PLAN_PHASES.join(", ")}`);
    return;
  }
  const result = ctx.planMode.setPhase(sessionId, phase);
  if (result === null) {
    // 不在 Plan 模式时切阶段没有意义（也不隐式进入：进入必须是显式动作）
    sendError(res, 409, "plan_mode_inactive", "session is not in plan mode; enter plan mode first");
    return;
  }
  if (result.changed) {
    appendEvent(ctx, "plan.phase_changed", sessionId, { phase });
  }
  sendJson(res, 200, { session_id: sessionId, phase: result.phase, changed: result.changed });
}

function appendEvent(
  ctx: PlanRouteContext,
  eventType: string,
  sessionId: string,
  payload: Record<string, unknown>,
): void {
  const envelope = buildEventEnvelope({
    replicaId: ctx.replicaId,
    actorId: "owner",
    eventType,
    sessionId,
    payload,
  });
  ctx.ledger.append(envelope);
}
