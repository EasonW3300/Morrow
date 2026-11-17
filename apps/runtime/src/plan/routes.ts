import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import type { PlanModeRegistry } from "./mode.ts";
import type { PlanQuestionRegistry } from "./questions.ts";
import {
  cleanImplementPrompt,
  isPlanDecision,
  parseProposedPlan,
  type PlanDecision,
  type ParsedPlan,
} from "./plan-block.ts";

/**
 * Plan 模式控制面（票 M7-C-T2 / Issue #76，FR-C1/C4）。
 *
 *   POST /v1/sessions/:id/plan/enter   进入只读计划模式
 *   POST /v1/sessions/:id/plan/exit    退出
 *   GET  /v1/sessions/:id/plan         当前状态（是否在 Plan、阶段、只读能力清单）
 *   PUT  /v1/sessions/:id/plan/phase   切换阶段（explore/clarify/detail）
 *   GET  /v1/sessions/:id/plan/question  当前待回答的问题
 *   POST /v1/sessions/:id/plan/question  登记一个问题（模型经工具调用发起）
 *   POST /v1/sessions/:id/plan/answer    提交回答（消费待回答问题）
 *   POST /v1/sessions/:id/plan/decision  计划落地三选一（implement/implement_clean/continue）
 *   POST /v1/sessions/:id/plan/task      已批准计划转为 Task（需确认）
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
  questions: PlanQuestionRegistry;
  ledger: EventLedger;
  replicaId: string;
  /** 会话可执行（存在、未关闭、未删除） */
  isSessionExecutable(sessionId: string): boolean;
  sessionExists(sessionId: string): boolean;
  /** 当前 Persona 提示（拼进 Plan 提示词） */
  personaPrompt(): string | null;
  /** 会话绑定的工作区路径（无则 null） */
  workspacePathOf(sessionId: string): string | null;
  /** 会话最近一条助手文本（用于解析计划块） */
  lastAssistantText(sessionId: string): string | null;
  /** 把计划转为 Task（复用既有 TaskService）；返回 task_id */
  convertToTask(sessionId: string, plan: ParsedPlan): Promise<{ taskId: string; eventId: string }>;
  now(): Date;
}

/** Plan 的三个阶段（C3 的对话流用同一套取值） */
export const PLAN_PHASES: readonly string[] = ["explore", "clarify", "detail"];

export const planRoutes: PlanRoute[] = [
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/plan$/, handler: handleGet },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/plan\/enter$/, handler: handleEnter },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/plan\/exit$/, handler: handleExit },
  { method: "PUT", re: /^\/v1\/sessions\/([^/]+)\/plan\/phase$/, handler: handlePhase },
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/plan\/question$/, handler: handleGetQuestion },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/plan\/question$/, handler: handleAskQuestion },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/plan\/answer$/, handler: handleAnswer },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/plan\/decision$/, handler: handleDecision },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/plan\/task$/, handler: handleConvertToTask },
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

// --- 阻塞式提问（FR-C2）------------------------------------------------------------

function handleGetQuestion(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PlanRouteContext,
  params: string[],
): void {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  const pending = ctx.questions.pendingOf(sessionId);
  sendJson(res, 200, {
    session_id: sessionId,
    pending,
    turns: ctx.questions.turnsOf(sessionId),
  });
}

async function handleAskQuestion(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PlanRouteContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  if (!ctx.planMode.isActive(sessionId)) {
    sendError(res, 409, "plan_mode_inactive", "questions can only be asked in plan mode");
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const question = body.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    sendError(res, 400, "invalid_body", "question must be a non-empty string");
    return;
  }
  const questionId = typeof body.question_id === "string" ? body.question_id : `q_${Date.now()}`;
  const options = Array.isArray(body.options)
    ? body.options.filter((item): item is string => typeof item === "string")
    : undefined;
  const recommendation = typeof body.recommendation === "string" ? body.recommendation : undefined;

  const pending = ctx.questions.ask({
    sessionId,
    question: question.trim(),
    questionId,
    now: ctx.now(),
    ...(options === undefined ? {} : { options }),
    ...(recommendation === undefined ? {} : { recommendation }),
  });
  if (pending === null) {
    sendError(res, 409, "session_not_executable", `session ${sessionId} cannot accept questions`);
    return;
  }
  // 审计：提问是计划推进的关键节点，事后要能重建"它问了什么、什么时候问的"
  appendEvent(ctx, "plan.question_asked", sessionId, {
    question_id: pending.question_id,
    question: pending.question,
    turn: pending.turn,
    ...(pending.options === undefined ? {} : { options: pending.options }),
  });
  sendJson(res, 200, { session_id: sessionId, pending });
}

async function handleAnswer(
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
  const questionId = body.question_id;
  const answer = body.answer;
  if (typeof questionId !== "string" || questionId.trim().length === 0) {
    sendError(res, 400, "invalid_body", "question_id is required (prevents answering a stale question)");
    return;
  }
  if (typeof answer !== "string" || answer.trim().length === 0) {
    sendError(res, 400, "invalid_body", "answer must be a non-empty string");
    return;
  }
  const consumed = ctx.questions.answer(sessionId, questionId);
  if (consumed === null) {
    sendError(
      res,
      409,
      "question_mismatch",
      `no pending question ${questionId} for this session (it may have been answered or replaced)`,
    );
    return;
  }
  appendEvent(ctx, "plan.question_answered", sessionId, {
    question_id: questionId,
    answer: answer.trim(),
  });
  sendJson(res, 200, {
    session_id: sessionId,
    question_id: questionId,
    answer: answer.trim(),
    /** 回答要作为下一轮的 prompt 送进会话 */
    next_prompt: answer.trim(),
  });
}

// --- 计划落地三选一（FR-C3）--------------------------------------------------------

async function handleDecision(
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
  const decision = body.decision;
  if (!isPlanDecision(decision)) {
    sendError(res, 400, "invalid_body", 'decision must be "implement", "implement_clean" or "continue"');
    return;
  }

  // 计划从最近的助手文本里解析（不信任客户端传来的一份——那可能是被改过的）
  const assistantText = ctx.lastAssistantText(sessionId);
  if (assistantText === null) {
    sendError(res, 409, "no_plan", "there is no assistant output to parse a plan from yet");
    return;
  }
  const parsed = parseProposedPlan(assistantText);

  if (decision === "continue") {
    // 继续规划：计划不合格也允许（这正是"格式不完整 → 继续规划"的路径）
    appendEvent(ctx, "plan.rejected", sessionId, {
      decision,
      ...(parsed.ok ? {} : { reason: parsed.reason }),
    });
    sendJson(res, 200, {
      session_id: sessionId,
      decision,
      plan: parsed.ok ? parsed.plan : null,
      ...(parsed.ok ? {} : { parse_error: parsed }),
      next: "continue_planning",
    });
    return;
  }

  // 实现类决策要求计划可解析
  if (!parsed.ok) {
    sendError(res, 422, "plan_incomplete", `the plan block is not usable: ${parsed.reason} — ${parsed.detail}`);
    return;
  }

  appendEvent(ctx, "plan.approved", sessionId, {
    decision,
    title: parsed.plan.title,
    steps: parsed.plan.steps.length,
    affected_files: parsed.plan.affectedFiles,
  });

  if (decision === "implement_clean") {
    const workspacePath = ctx.workspacePathOf(sessionId);
    const prompt = cleanImplementPrompt(parsed.plan, workspacePath);
    sendJson(res, 200, {
      session_id: sessionId,
      decision,
      plan: parsed.plan,
      next: "implement",
      /** 调用方据此新开会话运行（不继承探索历史） */
      clean_context_prompt: prompt,
    });
    return;
  }

  sendJson(res, 200, {
    session_id: sessionId,
    decision,
    plan: parsed.plan,
    next: "implement",
  });
}

// --- 转为任务（FR-C5）--------------------------------------------------------------

async function handleConvertToTask(
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
  // 需显式确认（规格：计划可「转为任务」，需确认）
  if (body.confirm !== true) {
    sendError(
      res,
      400,
      "confirmation_required",
      "converting a plan to a task requires confirm=true (it creates a real task and starts scheduling)",
    );
    return;
  }
  const assistantText = ctx.lastAssistantText(sessionId);
  if (assistantText === null) {
    sendError(res, 409, "no_plan", "there is no assistant output to parse a plan from yet");
    return;
  }
  const parsed = parseProposedPlan(assistantText);
  if (!parsed.ok) {
    sendError(res, 422, "plan_incomplete", `the plan block is not usable: ${parsed.reason} — ${parsed.detail}`);
    return;
  }
  try {
    const created = await ctx.convertToTask(sessionId, parsed.plan);
    appendEvent(ctx, "plan.converted_to_task", sessionId, {
      task_id: created.taskId,
      title: parsed.plan.title,
    });
    sendJson(res, 201, {
      session_id: sessionId,
      task_id: created.taskId,
      event_id: created.eventId,
      title: parsed.plan.title,
    });
  } catch (error) {
    sendError(res, 500, "task_creation_failed", error instanceof Error ? error.message : String(error));
  }
}

/** 决策类型的响应形状（供 UI 类型对齐） */
export interface PlanDecisionResponse {
  session_id: string;
  decision: PlanDecision;
  plan: ParsedPlan | null;
  next: string;
}
