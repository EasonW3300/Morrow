import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, readOptionalJsonBody, sendError, sendJson } from "../http-util.ts";
import { SNAPSHOT_SCOPE_NOTICE } from "./snapshot.ts";
import { ExecError, type ExecService } from "./service.ts";
import { DEFAULT_EXEC_MODE, isExecMode, type ExecModeRegistry } from "./mode.ts";
import { DEFAULT_EXEC_MAX_OUTPUT_BYTES, DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS } from "./runner.ts";

/**
 * 动态 bash 控制面路由（票 M7-B-T6 / Issue #70，FR-B13/B14/B15/B16）：
 *
 *   GET  /v1/sessions/:id/exec-mode        当前模式 + 只读豁免是否已用
 *   PUT  /v1/sessions/:id/exec-mode       切换模式（body { mode }）→ 写 exec.mode_changed 审计
 *   POST /v1/sessions/:id/exec            提交脚本：
 *                                            - 危险规则命中 → 400 exec_forbidden（**拒绝**，不是待确认）
 *                                            - 需要确认 → 202 needs_confirmation + 完整脚本
 *                                            - 放行 → 200 executed（快照 + 容器执行 + 审计）
 *   GET  /v1/exec/confirmations/:id       待确认详情（完整脚本，供展示）
 *   POST /v1/exec/confirmations/:id/approve  确认并执行（一次性）
 *   POST /v1/sessions/:id/exec/revert     撤销最近一次快照（body 可带 { snapshot_id }）
 *
 * 端点命名说明：PRD M7 §4.3 的清单写作 `POST /v1/exec/mode`，票面写作
 * `POST /v1/sessions/:id/exec-mode`。本实现取**会话路径**——执行模式是会话级状态，
 * 把 sessionId 放进路径比放进 body 更难被客户端写错，也让"关闭会话即失效"在
 * 语义上更直观（对已关闭会话这里是 409）。
 */
export interface ExecRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: ExecRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface ExecRouteContext {
  exec: ExecService;
  modes: ExecModeRegistry;
  /** 会话可执行判定（与 ExecService 同一个依赖，路由层只需要它做 404/409 区分） */
  isSessionExecutable(sessionId: string): boolean;
  sessionExists(sessionId: string): boolean;
}

export const execRoutes: ExecRoute[] = [
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/exec-mode$/, handler: handleGetMode },
  { method: "PUT", re: /^\/v1\/sessions\/([^/]+)\/exec-mode$/, handler: handlePutMode },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/exec$/, handler: handleSubmit },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/exec\/revert$/, handler: handleRevert },
  { method: "GET", re: /^\/v1\/exec\/confirmations\/([^/]+)$/, handler: handleGetConfirmation },
  { method: "POST", re: /^\/v1\/exec\/confirmations\/([^/]+)\/approve$/, handler: handleApprove },
];

/** 会话不存在 → 404；存在但已关闭/已删 → 409（两者对 UI 的可操作提示不同） */
function assertExecutable(res: ServerResponse, ctx: ExecRouteContext, sessionId: string): boolean {
  if (!ctx.sessionExists(sessionId)) {
    sendError(res, 404, "not_found", `session ${sessionId} does not exist`);
    return false;
  }
  if (!ctx.isSessionExecutable(sessionId)) {
    sendError(
      res,
      409,
      "session_not_executable",
      `session ${sessionId} is closed or deleted; execution modes and script runs are unavailable`,
    );
    return false;
  }
  return true;
}

function handleGetMode(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ExecRouteContext,
  params: string[],
): void {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  sendJson(res, 200, {
    session_id: sessionId,
    mode: ctx.modes.modeOf(sessionId),
    default_mode: DEFAULT_EXEC_MODE,
    readonly_confirmed: ctx.modes.readonlyConfirmed(sessionId),
    // 明确回传"不持久化"：UI 需要据此说明"关闭会话后回到默认"
    persisted: false,
    // 保护范围边界（UI 必须展示）
    snapshot_scope_notice: SNAPSHOT_SCOPE_NOTICE,
    limits: {
      timeout_ms: DEFAULT_EXEC_TIMEOUT_MS,
      max_timeout_ms: MAX_EXEC_TIMEOUT_MS,
      max_output_bytes: DEFAULT_EXEC_MAX_OUTPUT_BYTES,
    },
  });
}

async function handlePutMode(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ExecRouteContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const mode = body.mode;
  if (!isExecMode(mode)) {
    // 非法值**不**回退默认：静默回退会让客户端以为切换成功了
    sendError(res, 400, "invalid_body", 'mode must be "confirm_each" or "full_access"');
    return;
  }
  try {
    const result = ctx.exec.setMode(sessionId, mode);
    sendJson(res, 200, {
      session_id: sessionId,
      mode: result.mode,
      changed: result.changed,
      persisted: false,
      event_id: result.event_id,
      sequence: result.sequence,
      snapshot_scope_notice: SNAPSHOT_SCOPE_NOTICE,
    });
  } catch (error) {
    sendExecError(res, error);
  }
}

async function handleSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ExecRouteContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  const body = await readJsonBody(req, res);
  if (body === null) return;

  const script = body.script;
  if (typeof script !== "string" || script.trim().length === 0) {
    sendError(res, 400, "invalid_body", "script must be a non-empty string");
    return;
  }
  const timeoutCheck = readBoundedInt(body.timeout_ms, 100, MAX_EXEC_TIMEOUT_MS);
  if (timeoutCheck.error !== null) {
    sendError(res, 400, "invalid_body", timeoutCheck.error);
    return;
  }
  const outputCheck = readBoundedInt(body.max_output_bytes, 1_024, DEFAULT_EXEC_MAX_OUTPUT_BYTES);
  if (outputCheck.error !== null) {
    sendError(res, 400, "invalid_body", outputCheck.error);
    return;
  }
  const confirmationId = typeof body.confirmation_id === "string" ? body.confirmation_id : undefined;

  try {
    const outcome = await ctx.exec.submit({
      sessionId,
      script,
      ...(timeoutCheck.value === null ? {} : { timeoutMs: timeoutCheck.value }),
      ...(outputCheck.value === null ? {} : { maxOutputBytes: outputCheck.value }),
      ...(confirmationId === undefined ? {} : { confirmationId }),
    });
    // 三种结果三个状态码：拒绝是 400（客户端不该重试同一段脚本/需改脚本），
    // 待确认是 202（还没做完），执行为 200。
    if (outcome.status === "denied") {
      sendJson(res, 400, { ...outcome, error: { code: "exec_forbidden", message: denyMessage(outcome.hits) } });
      return;
    }
    if (outcome.status === "needs_confirmation") {
      sendJson(res, 202, outcome);
      return;
    }
    sendJson(res, 200, outcome);
  } catch (error) {
    sendExecError(res, error);
  }
}

async function handleRevert(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ExecRouteContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!assertExecutable(res, ctx, sessionId)) return;
  // body 是可选的：最常见调用就是"撤销最近一次快照"，不该逼客户端造一个空 JSON
  const body = await readOptionalJsonBody(req, res);
  if (body === null) return;
  const snapshotId = typeof body.snapshot_id === "string" ? body.snapshot_id : undefined;
  try {
    const result = await ctx.exec.revert({ sessionId, ...(snapshotId === undefined ? {} : { snapshotId }) });
    sendJson(res, 200, result);
  } catch (error) {
    sendExecError(res, error);
  }
}

function handleGetConfirmation(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ExecRouteContext,
  params: string[],
): void {
  const pending = ctx.exec.pendingOf(params[0]);
  if (pending === null) {
    sendError(res, 404, "confirmation_not_found", `confirmation ${params[0]} is unknown or expired`);
    return;
  }
  sendJson(res, 200, {
    confirmation_id: pending.confirmationId,
    session_id: pending.sessionId,
    script: pending.script,
    mode: pending.mode,
    readonly: pending.readonly,
    created_at: pending.createdAt,
    expires_at: pending.expiresAt,
  });
}

async function handleApprove(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ExecRouteContext,
  params: string[],
): Promise<void> {
  const confirmationId = params[0];
  const pending = ctx.exec.pendingOf(confirmationId);
  if (pending === null) {
    sendError(res, 404, "confirmation_not_found", `confirmation ${confirmationId} is unknown or expired`);
    return;
  }
  if (!assertExecutable(res, ctx, pending.sessionId)) return;
  // approve 允许带超时/输出上限（与 submit 同口径），也允许空 body
  const body = await readOptionalJsonBody(req, res);
  if (body === null) return;
  const timeoutCheck = readBoundedInt(body.timeout_ms, 100, MAX_EXEC_TIMEOUT_MS);
  if (timeoutCheck.error !== null) {
    sendError(res, 400, "invalid_body", timeoutCheck.error);
    return;
  }
  const outputCheck = readBoundedInt(body.max_output_bytes, 1_024, DEFAULT_EXEC_MAX_OUTPUT_BYTES);
  if (outputCheck.error !== null) {
    sendError(res, 400, "invalid_body", outputCheck.error);
    return;
  }
  try {
    const outcome = await ctx.exec.approve({
      sessionId: pending.sessionId,
      confirmationId,
      ...(timeoutCheck.value === null ? {} : { timeoutMs: timeoutCheck.value }),
      ...(outputCheck.value === null ? {} : { maxOutputBytes: outputCheck.value }),
    });
    if (outcome.status === "denied") {
      sendJson(res, 400, { ...outcome, error: { code: "exec_forbidden", message: denyMessage(outcome.hits) } });
      return;
    }
    sendJson(res, 200, outcome);
  } catch (error) {
    sendExecError(res, error);
  }
}

/** 从命中列表拼一句人类可读的拒绝原因 */
function denyMessage(hits: Array<{ id: string; reason: string }>): string {
  if (hits.length === 0) return "script was rejected by the danger rule set";
  return `script was rejected by the danger rule set: ${hits.map((hit) => `${hit.id} (${hit.reason})`).join("; ")}`;
}

/** 可选整数参数：缺省 → { value: null }；非法 → { error } */
function readBoundedInt(raw: unknown, min: number, max: number): { value: number | null; error: string | null } {
  if (raw === undefined || raw === null) return { value: null, error: null };
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { value: null, error: "numeric fields must be integers" };
  }
  if (raw < min || raw > max) {
    return { value: null, error: `numeric field out of range [${min}, ${max}]` };
  }
  return { value: raw, error: null };
}

/** ExecError → HTTP 错误信封（code 与 status 映射见 service.ts 的 code 清单） */
function sendExecError(res: ServerResponse, error: unknown): void {
  if (error instanceof ExecError) {
    const status =
      error.code === "exec_forbidden"
        ? 400
        : error.code === "session_not_executable"
          ? 409
          : error.code === "exec_unavailable"
            ? 503
            : error.code === "invalid_script"
              ? 400
              : 404;
    sendError(res, status, error.code, error.message);
    return;
  }
  // 快照失败等：500（快照失败已经 fail-closed 不执行，但这是服务端问题）
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
      ? ((error as { code: string }).code)
      : "internal_error";
  sendError(res, 500, code, message);
}
