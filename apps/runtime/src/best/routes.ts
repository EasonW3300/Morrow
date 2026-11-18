import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, readOptionalJsonBody, sendError, sendJson } from "../http-util.ts";
import { BEST_STAGE_LABELS } from "./stage.ts";
import type { BestRunRecord } from "./store.ts";
import { BestError, type BestService } from "./service.ts";
import { gateApproved, type BestTicketsService } from "./tickets-service.ts";

/**
 * Best 模式控制面（票 M7-C-T6 / Issue #80）：
 *
 *   POST /v1/best                          启动（idea + session_id）
 *   GET  /v1/best?session_id=              列表
 *   GET  /v1/best/:id                      详情
 *   GET  /v1/best/:id/interview            访谈进度
 *   POST /v1/best/:id/interview            记录一问一答
 *   POST /v1/best/:id/spec                 提交规格（进入 spec 门）
 *   POST /v1/best/:id/spec-gate            规格门决策（approve/reject）
 *   POST /v1/best/:id/abort                中止
 *   POST /v1/best/:id/tickets              拆票（不设门）
 *   GET  /v1/best/:id/implement-gate       实现门提示（文案里写明完全权限不可跳）
 *   POST /v1/best/:id/implement-gate       通过实现门
 *   POST /v1/best/:id/implement            启动实现（**必须**先过门）
 *   GET  /v1/best/:id/push-plan            推送并开 PR 的指令（不执行）
 */
export interface BestRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: BestRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface BestRouteContext {
  best: BestService;
  tickets: BestTicketsService;
  /** 账本事件（用于推导实现门是否已批准——事件是唯一真相源） */
  events(): Array<{ event_type: string; payload: Record<string, unknown> }>;
}

export const bestRoutes: BestRoute[] = [
  { method: "GET", re: /^\/v1\/best$/, handler: handleList },
  { method: "POST", re: /^\/v1\/best$/, handler: handleStart },
  { method: "GET", re: /^\/v1\/best\/([^/]+)$/, handler: handleGet },
  { method: "GET", re: /^\/v1\/best\/([^/]+)\/interview$/, handler: handleInterviewState },
  { method: "POST", re: /^\/v1\/best\/([^/]+)\/interview$/, handler: handleRecordExchange },
  { method: "POST", re: /^\/v1\/best\/([^/]+)\/spec$/, handler: handleSubmitSpec },
  { method: "POST", re: /^\/v1\/best\/([^/]+)\/spec-gate$/, handler: handleSpecGate },
  { method: "POST", re: /^\/v1\/best\/([^/]+)\/abort$/, handler: handleAbort },
  { method: "POST", re: /^\/v1\/best\/([^/]+)\/tickets$/, handler: handleCreateTickets },
  { method: "GET", re: /^\/v1\/best\/([^/]+)\/implement-gate$/, handler: handleGateNotice },
  { method: "POST", re: /^\/v1\/best\/([^/]+)\/implement-gate$/, handler: handleApproveGate },
  { method: "POST", re: /^\/v1\/best\/([^/]+)\/implement$/, handler: handleStartImplement },
  { method: "GET", re: /^\/v1\/best\/([^/]+)\/push-plan$/, handler: handlePushPlan },
];

/** 视图：阶段带中文标签与"下一步是什么"（UI 不必自己推） */
export function toBestView(run: BestRunRecord): Record<string, unknown> {
  const nextByStage: Record<string, string> = {
    interview: "继续访谈；信息够了就提交规格",
    spec: "规格待确认（approve/reject）；被拒则停在规格可编辑",
    tickets: "拆票（不设确认门）",
    implement: "实现前确认门",
  };
  return {
    ...run,
    stage_label: BEST_STAGE_LABELS[run.stage],
    next: nextByStage[run.stage] ?? "",
    /** 访谈记录会很长，列表视图里只给条数（详情给全文） */
    interview_count: run.interview.length,
    ...(run.stage === "interview" ? { interview: run.interview } : {}),
  };
}

function handleList(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: BestRouteContext,
): void {
  const sessionId = url.searchParams.get("session_id");
  const runs = ctx.best.list(sessionId === null ? {} : { sessionId });
  sendJson(res, 200, { runs: runs.map(toBestView) });
}

async function handleStart(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  if (typeof body.session_id !== "string" || body.session_id.trim().length === 0) {
    sendError(res, 400, "invalid_body", "session_id is required");
    return;
  }
  try {
    const run = ctx.best.start({ sessionId: body.session_id.trim(), idea: String(body.idea ?? "") });
    sendJson(res, 201, { run: toBestView(run) });
  } catch (error) {
    sendBestError(res, error);
  }
}

function handleGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): void {
  const run = ctx.best.get(params[0]);
  if (run === null) {
    sendError(res, 404, "not_found", `best run ${params[0]} does not exist`);
    return;
  }
  sendJson(res, 200, { run: toBestView(run) });
}

function handleInterviewState(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): void {
  const run = ctx.best.get(params[0]);
  if (run === null) {
    sendError(res, 404, "not_found", `best run ${params[0]} does not exist`);
    return;
  }
  const state = ctx.best.interviewState(params[0]);
  sendJson(res, 200, { best_id: params[0], stage: run.stage, state, interview: run.interview });
}

async function handleRecordExchange(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const result = ctx.best.recordExchange({
      bestId: params[0],
      question: body.question,
      answer: typeof body.answer === "string" ? body.answer : "",
    });
    sendJson(res, 200, {
      run: toBestView(result.run),
      state: result.state,
      notice: result.notice,
    });
  } catch (error) {
    sendBestError(res, error);
  }
}

async function handleSubmitSpec(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const result = ctx.best.submitSpec({
      bestId: params[0],
      markdown: typeof body.markdown === "string" ? body.markdown : "",
    });
    sendJson(res, 200, {
      run: toBestView(result.run),
      gate: result.gate,
      /** 门的两条路（UI 直接渲染按钮） */
      decisions: ["approve", "reject"],
    });
  } catch (error) {
    sendBestError(res, error);
  }
}

async function handleSpecGate(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    sendError(res, 400, "invalid_body", 'decision must be "approve" or "reject"');
    return;
  }
  try {
    const run = ctx.best.decideSpecGate({
      bestId: params[0],
      decision,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
    sendJson(res, 200, { run: toBestView(run) });
  } catch (error) {
    sendBestError(res, error);
  }
}

async function handleAbort(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): Promise<void> {
  const body = await readOptionalJsonBody(req, res);
  if (body === null) return;
  try {
    const run = ctx.best.abort(params[0], typeof body.reason === "string" ? body.reason : undefined);
    sendJson(res, 200, {
      run: toBestView(run),
      /** 遗留物明示（不自动删分支：删错东西比留空分支危险） */
      leftovers: {
        branch: run.branch,
        workspace_path: run.workspace_path,
        spec_path: run.spec_path,
      },
    });
  } catch (error) {
    sendBestError(res, error);
  }
}

function sendBestError(res: ServerResponse, error: unknown): void {
  if (error instanceof BestError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "best_already_running" ||
            error.code === "invalid_stage" ||
            error.code === "session_not_executable" ||
            error.code === "ephemeral_session" ||
            error.code === "goal_unavailable"
          ? 409
          : error.code === "spec_incomplete"
            ? 422
            : 400;
    sendError(res, status, error.code, error.message);
    return;
  }
  sendError(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
}

// --- 拆票与实现门（票 M7-C-T7 / #81）----------------------------------------------

async function handleCreateTickets(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const result = await ctx.tickets.createTickets({ bestId: params[0], tickets: body.tickets });
    sendJson(res, 201, {
      run: toBestView(result.run),
      artifact: result.artifact,
      /** 明确：拆票不设确认门，但实现前有门 */
      next: "implement_gate",
    });
  } catch (error) {
    sendBestError(res, error);
  }
}

function handleGateNotice(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): void {
  try {
    const notice = ctx.tickets.implementGateNotice({ bestId: params[0] });
    sendJson(res, 200, {
      best_id: params[0],
      ...notice,
      /** 从账本推导的实际批准状态（事件是唯一真相源） */
      approved: gateApproved(ctx.events(), params[0]),
    });
  } catch (error) {
    sendBestError(res, error);
  }
}

async function handleApproveGate(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): Promise<void> {
  const body = await readOptionalJsonBody(req, res);
  if (body === null) return;
  try {
    const run = ctx.tickets.approveImplementGate({
      bestId: params[0],
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
    sendJson(res, 200, { run: toBestView(run), approved: true });
  } catch (error) {
    sendBestError(res, error);
  }
}

async function handleStartImplement(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): Promise<void> {
  const body = await readOptionalJsonBody(req, res);
  if (body === null) return;
  // 关键：批准状态**只从账本推导**，不看任何请求参数、不看执行模式。
  // 这就是 FR-C14「完全权限也不得跳」的实现方式。
  const approved = gateApproved(ctx.events(), params[0]);
  try {
    const result = await ctx.tickets.startImplementation({ bestId: params[0], implementApproved: approved });
    sendJson(res, 201, {
      run: toBestView(result.run),
      branch: result.branch,
      workspace_path: result.workspacePath,
      task_id: result.taskId,
      /** 明确回传：没有推送 */
      pushed: false,
      next: "push_and_pr",
    });
  } catch (error) {
    sendBestError(res, error);
  }
}

function handlePushPlan(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: BestRouteContext,
  params: string[],
): void {
  try {
    sendJson(res, 200, { best_id: params[0], ...ctx.tickets.pushPlan({ bestId: params[0] }) });
  } catch (error) {
    sendBestError(res, error);
  }
}
