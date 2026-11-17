import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, readOptionalJsonBody, sendError, sendJson } from "../http-util.ts";
import { GOAL_STATUS_LABELS, type GoalStatus } from "./state.ts";
import type { GoalRecord } from "./store.ts";
import { GoalError, type GoalService } from "./service.ts";

/**
 * Thread Goal 控制面（票 M7-C-T4 / Issue #78，FR-C6..C9）：
 *
 *   GET  /v1/goals?session_id=&status=      列表
 *   POST /v1/goals                          创建（**必须** confirm=true）
 *   GET  /v1/goals/:id                      详情
 *   POST /v1/goals/:id/pause                暂停
 *   POST /v1/goals/:id/resume               恢复（可同时提高 token 预算）
 *   POST /v1/goals/:id/complete             完成（终态）
 *
 * 没有 `create_goal` 的工具面：模型拿不到这个能力，只能由 Owner 显式发起
 * （FR-C7）。这是"不从普通对话推断目标"的结构性保证。
 */
export interface GoalRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: GoalRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface GoalRouteContext {
  goals: GoalService;
}

export const goalRoutes: GoalRoute[] = [
  { method: "GET", re: /^\/v1\/goals$/, handler: handleList },
  { method: "POST", re: /^\/v1\/goals$/, handler: handleCreate },
  { method: "GET", re: /^\/v1\/goals\/([^/]+)$/, handler: handleGet },
  { method: "POST", re: /^\/v1\/goals\/([^/]+)\/pause$/, handler: handlePause },
  { method: "POST", re: /^\/v1\/goals\/([^/]+)\/resume$/, handler: handleResume },
  { method: "POST", re: /^\/v1\/goals\/([^/]+)\/complete$/, handler: handleComplete },
];

/** 视图：状态附带人类可读标签与预算进度（UI 直接用，不再自己算） */
export function toGoalView(record: GoalRecord): Record<string, unknown> {
  const tokenProgress =
    record.token_limit === null || record.token_limit === 0
      ? null
      : Math.min(1, record.tokens / record.token_limit);
  const timeProgress =
    record.time_limit_ms === null || record.time_limit_ms === 0
      ? null
      : Math.min(1, record.elapsed_ms / record.time_limit_ms);
  return {
    ...record,
    status_label: GOAL_STATUS_LABELS[record.status],
    usage: {
      tokens: record.tokens,
      tokens_estimated: record.tokens_estimated,
      elapsed_ms: record.elapsed_ms,
      runs: record.runs,
      token_progress: tokenProgress,
      time_progress: timeProgress,
    },
  };
}

function handleList(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: GoalRouteContext,
): void {
  const sessionId = url.searchParams.get("session_id");
  const status = url.searchParams.get("status");
  if (status !== null && !(status in GOAL_STATUS_LABELS)) {
    sendError(
      res,
      400,
      "invalid_query",
      `status must be one of: ${Object.keys(GOAL_STATUS_LABELS).join(", ")}`,
    );
    return;
  }
  const goals = ctx.goals.list({
    ...(sessionId === null ? {} : { sessionId }),
    ...(status === null ? {} : { status: status as GoalStatus }),
  });
  sendJson(res, 200, { goals: goals.map(toGoalView) });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: GoalRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const sessionId = body.session_id;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    sendError(res, 400, "invalid_body", "session_id is required");
    return;
  }
  if (typeof body.objective !== "string") {
    sendError(res, 400, "invalid_body", "objective is required");
    return;
  }
  try {
    const goal = ctx.goals.create({
      sessionId: sessionId.trim(),
      objective: body.objective,
      tokenLimit: body.token_limit,
      timeLimitMs: body.time_limit_ms,
      confirm: body.confirm === true,
    });
    sendJson(res, 201, { goal: toGoalView(goal) });
  } catch (error) {
    sendGoalError(res, error);
  }
}

function handleGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: GoalRouteContext,
  params: string[],
): void {
  const goal = ctx.goals.get(params[0]);
  if (goal === null) {
    sendError(res, 404, "not_found", `goal ${params[0]} does not exist`);
    return;
  }
  sendJson(res, 200, { goal: toGoalView(goal) });
}

async function handlePause(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: GoalRouteContext,
  params: string[],
): Promise<void> {
  try {
    sendJson(res, 200, { goal: toGoalView(ctx.goals.pause(params[0])) });
  } catch (error) {
    sendGoalError(res, error);
  }
}

async function handleResume(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: GoalRouteContext,
  params: string[],
): Promise<void> {
  // resume 允许空 body；带 token_limit 则同时提高预算（readOptionalJsonBody 统一空体口径）
  const body = await readOptionalJsonBody(req, res);
  if (body === null) return;
  try {
    const goal = ctx.goals.resume(params[0], { tokenLimit: body.token_limit });
    sendJson(res, 200, { goal: toGoalView(goal) });
  } catch (error) {
    sendGoalError(res, error);
  }
}

async function handleComplete(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: GoalRouteContext,
  params: string[],
): Promise<void> {
  const body = await readOptionalJsonBody(req, res);
  if (body === null) return;
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  try {
    const goal = ctx.goals.complete(params[0], reason === undefined ? {} : { reason });
    sendJson(res, 200, { goal: toGoalView(goal) });
  } catch (error) {
    sendGoalError(res, error);
  }
}

function sendGoalError(res: ServerResponse, error: unknown): void {
  if (error instanceof GoalError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "goal_already_open" || error.code === "invalid_transition"
          ? 409
          : error.code === "session_not_executable" || error.code === "ephemeral_session"
            ? 409
            : 400;
    sendError(res, status, error.code, error.message);
    return;
  }
  sendError(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
}
