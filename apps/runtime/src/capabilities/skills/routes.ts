import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "../../http-util.ts";
import { SkillError, type SkillInvokeResult, type SkillRecord, type SkillService } from "./service.ts";

/**
 * Skill 控制面路由（票 M2-T5 / Issue #26，FR-EVO-1 + FR-CAP-1；T6 api.ts 合约）。
 *
 * 两个路径族同 handler——票面口径挂 /v1/capabilities/skills*（能力域家族），T6 桌面
 * api.ts 已编码的合约挂 /v1/skills*（路径即合约：UI 先行票，落地侧对齐两侧）：
 *
 *   GET  /v1/capabilities/skills[?match=]                                  ←→ GET /v1/skills
 *        已批准 Skill 清单（T6 SkillSummary）；match= 描述检索（FR-CAP-1 重用路径：
 *        命中返回 reused=true 的可重用清单而非"需新建"）
 *   GET  /v1/capabilities/skills/proposals                                 ←→ GET /v1/skills/proposals
 *        提案列表（T6 SkillProposal：proposed → pending 投影；含已决策历史三态）
 *   POST /v1/capabilities/skills                                           手动提案（悬空引用 409）
 *   POST /v1/capabilities/skills/cases                                     案例上报（成功/失败 + 来源事件）
 *   POST /v1/capabilities/skills/proposals/:id/{approve,reject}            ←→ T6 decideSkillProposal
 *   POST /v1/capabilities/skills/:id/{approve,reject}                      Owner 决策（票面口径）
 *   POST /v1/capabilities/skills/:id/invoke                                重用调用（参数模板填充）
 *
 * 路由声明序：本文件在 runtime.ts 里先于 capabilityRoutes 展开——GET /v1/capabilities/:id
 * 的 `[^/]+` 会吞掉 /v1/capabilities/skills（grants 路由同款先具体后通配的理由）。
 * 错误信封形状与 runtime.ts 全局约定一致（`{ error: { code, message } }`）。
 */

export interface SkillRoute {
  method: string;
  re: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: SkillRouteContext, params: string[]) => void | Promise<void>;
}

export interface SkillRouteContext {
  skills: SkillService;
}

// --- T6 投影（apps/desktop/src/capability-ui.ts 的 SkillSummary/SkillProposal 口径）--

const SKILL_VERSION = "1.0.0"; // Skill 不版本化（声明式组合随 capability 演进）；T6 形状要求 version 字段

/** 已批准 Skill → T6 SkillSummary（额外字段为增量，T6 只读它认识的） */
export function toSkillSummary(record: SkillRecord): Record<string, unknown> {
  return {
    skill_id: record.skill_id,
    name: record.name,
    title: record.title,
    version: SKILL_VERSION,
    description: record.description,
    capabilities: record.capabilities,
    steps: record.steps,
    enabled: true,
    status: record.status,
    created_at: record.created_at,
  };
}

/** Skill/提案记录 → T6 SkillProposal（status: proposed → pending；悬空引用呈现字段） */
export function toSkillProposal(record: SkillRecord): Record<string, unknown> {
  return {
    proposal_id: record.skill_id,
    skill_id: record.skill_id,
    name: record.name,
    title: record.title,
    status: record.status === "proposed" ? "pending" : record.status,
    capabilities: record.capabilities,
    steps: record.steps,
    description: record.description,
    origin: record.origin,
    ...(typeof record.source.reason === "string" ? { reason: record.source.reason } : {}),
    ...(Array.isArray(record.source.missing_capabilities) ? { missing_capabilities: record.source.missing_capabilities } : {}),
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export const skillRoutes: SkillRoute[] = [
  {
    method: "POST",
    re: /^\/v1\/capabilities\/skills\/cases$/,
    handler: handleRecordCase,
  },
  {
    method: "GET",
    re: /^\/v1\/capabilities\/skills\/cases$/,
    handler: handleListCases,
  },
  {
    method: "GET",
    re: /^\/v1\/capabilities\/skills$/,
    handler: handleListSkills,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities\/skills$/,
    handler: handlePropose,
  },
  {
    method: "GET",
    re: /^\/v1\/capabilities\/skills\/proposals$/,
    handler: handleListProposals,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities\/skills\/proposals\/([^/]+)\/(approve|reject)$/,
    handler: handleDecide,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities\/skills\/([^/]+)\/(approve|reject)$/,
    handler: handleDecide,
  },
  {
    method: "POST",
    re: /^\/v1\/capabilities\/skills\/([^/]+)\/invoke$/,
    handler: handleInvoke,
  },
  // T6 api.ts 已编码的合约路径（路径即合约；同 handler 同形状）
  {
    method: "GET",
    re: /^\/v1\/skills$/,
    handler: handleListSkills,
  },
  {
    method: "GET",
    re: /^\/v1\/skills\/proposals$/,
    handler: handleListProposals,
  },
  {
    method: "POST",
    re: /^\/v1\/skills\/proposals\/([^/]+)\/(approve|reject)$/,
    handler: handleDecide,
  },
];

// --- handlers ------------------------------------------------------------------

function handleListSkills(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: SkillRouteContext): void {
  const match = url.searchParams.get("match");
  if (match === null) {
    sendJson(res, 200, { skills: ctx.skills.listSkills().map(toSkillSummary) });
    return;
  }
  if (match.trim().length === 0) {
    sendError(res, 400, "invalid_query", "match must be a non-empty description");
    return;
  }
  const result = ctx.skills.matchSkills(match);
  sendJson(res, 200, {
    match,
    reused: result.reused,
    skills: result.skills.map((hit) => ({ ...toSkillSummary(hit), score: hit.score })),
  });
}

function handleListProposals(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: SkillRouteContext): void {
  sendJson(res, 200, { proposals: ctx.skills.listProposals().map(toSkillProposal) });
}

/** 案例表投影（可观测性：经验收集是晋升提案的证据链） */
function handleListCases(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: SkillRouteContext): void {
  const capability = url.searchParams.get("capability");
  const cases = ctx.skills.listCases(capability === null ? {} : { capability });
  sendJson(res, 200, { cases });
}

interface ProposeBody {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  steps?: unknown;
}

async function handlePropose(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: SkillRouteContext): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const record = ctx.skills.propose({
      name: body.name as string,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      steps: body.steps as never,
    });
    sendJson(res, 201, toSkillProposal(record));
  } catch (err) {
    handleSkillError(res, err);
  }
}

interface CaseBody {
  capability?: unknown;
  outcome?: unknown;
  source_event_id?: unknown;
  session_id?: unknown;
  occurred_at?: unknown;
}

async function handleRecordCase(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: SkillRouteContext): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const { capability, outcome, source_event_id: sourceEventId, session_id: sessionId, occurred_at: occurredAt } = body as CaseBody;
  if (occurredAt !== undefined && (typeof occurredAt !== "string" || occurredAt.trim().length === 0)) {
    sendError(res, 400, "invalid_body", "occurred_at must be a non-empty ISO timestamp when present");
    return;
  }
  try {
    const result = ctx.skills.recordCase({
      capability: capability as string,
      outcome: outcome as "success" | "failure",
      sourceEventId: sourceEventId as string,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
      occurredAt: typeof occurredAt === "string" ? occurredAt : new Date().toISOString(),
    });
    sendJson(res, 201, {
      recorded: result.recorded,
      ...(result.case !== null ? { case: result.case } : {}),
      ...(result.proposal !== null ? { proposal: toSkillProposal(result.proposal) } : {}),
    });
  } catch (err) {
    handleSkillError(res, err);
  }
}

async function handleDecide(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: SkillRouteContext,
  params: string[],
): Promise<void> {
  const decision = params[1] as "approve" | "reject";
  // T6 decideSkillProposal 是无 body 的 POST（同既有 enable/disable 先例）；reason 为
  // 可选呈现字段——仅在显式 application/json body 时读取，无 body 不阻断决策。
  let reason: string | undefined;
  const contentType = req.headers["content-type"];
  if (contentType !== undefined && /^application\/json\b/i.test(contentType.trim())) {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    if (typeof body.reason === "string" && body.reason.trim().length > 0) {
      reason = body.reason;
    }
  }
  try {
    const record = ctx.skills.decide(params[0], decision, reason === undefined ? {} : { reason });
    sendJson(res, 200, toSkillProposal(record));
  } catch (err) {
    handleSkillError(res, err);
  }
}

interface InvokeBody {
  params?: unknown;
}

async function handleInvoke(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: SkillRouteContext, params: string[]): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const result: SkillInvokeResult = await ctx.skills.invoke(params[0], (body as InvokeBody).params ?? {});
    sendJson(res, 200, result);
  } catch (err) {
    handleSkillError(res, err);
  }
}

/**
 * SkillError → HTTP：not_found 404；invalid_input / missing_params 400；conflict /
 * invalid_state / not_approved / dangling_reference 409（悬空引用 message 携带具体
 * 缺失能力清单）；其余上抛 500。
 */
export function handleSkillError(res: ServerResponse, err: unknown): void {
  if (err instanceof SkillError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "invalid_input" || err.code === "missing_params"
          ? 400
          : 409;
    sendError(res, status, `skill_${err.code}`, err.message);
    return;
  }
  throw err;
}
