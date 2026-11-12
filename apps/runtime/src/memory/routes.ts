import type { IncomingMessage, ServerResponse } from "node:http";
import { parsePaging, readJsonBody, sendError, sendJson } from "../http-util.ts";
import { MemoryControlError, MemoryService, type ConsolidationRunSummary } from "./service.ts";
import { MarkdownParseError, type MemoryProjector } from "./projection.ts";

/**
 * 记忆控制面路由（票 M1-T1 / Issue #13 检索 + M1-T2 / Issue #14 候选/冲突 + M1-T3 /
 * Issue #15 投影/导入/删除，PRD §6.2）：
 *
 *   GET  /v1/memory/facts?q=关键词[&scope=owner|session:<id>]
 *                                              FTS5 关键词检索（候选与事实统一索引），
 *                                              命中条目带 sources（来源账本 event_id 数组）；
 *                                              scope 缺省 owner 只查全局，session:<id>
 *                                              查全局 + 该会话（票 M7-A-T3）
 *   POST /v1/memory/:id/promote               提升为长期记忆（candidate 或 fact）：
 *                                              scope session:* → owner + memory.promoted；
 *                                              非 session scope → 409（票 M7-A-T3）
 *   GET  /v1/memory/candidates?status=          候选列表（status 过滤：pending /
 *                                              consolidated / dismissed / conflicted）
 *   POST /v1/memory/candidates/:id/decide      Owner 决定：accept → 进巩固（绕过置信度
 *                                              准入线）/ dismiss → 状态置 dismissed
 *   GET  /v1/memory/conflicts?status=          冲突列表（open = 待确认队列，FR-MEM-5）
 *   POST /v1/memory/conflicts/:id/resolve      裁决：keep_new / keep_old / merge
 *                                              （merge 需 content）→ 修订 + 修订事件
 *   POST /v1/memory/import                     受控导入（FR-MEM-6）：编辑后的 §6.4
 *                                              Markdown 全文 → 版本化修订；冲突进队列；
 *                                              frontmatter version 落后 → 409 stale_version
 *   DELETE /v1/memory/facts/:id[?confirm=true] 删除标记（FR-MEM-8 单机前置）：tombstone
 *                                              事件 + 软删 + 投影文件移除；locked 默认
 *                                              拒绝（409），?confirm=true 显式确认
 *   POST /v1/memory/project                    投影再生成命令（幂等：同状态同字节，
 *                                              只写差异文件 + 清理孤儿投影）
 *
 * 独立成文件以收拢记忆路由与 runtime.ts 的并行票改动面；错误信封形状与 runtime.ts
 * 全局约定一致（`{ error: { code, message } }`）。
 * 注：memory.* 事件经账本入 SSE 重放（session_id 关联），实时广播由会话帧负责的
 * 部分见 runtime README「记忆管线」一节的边界说明。
 */

export interface MemoryRoute {
  method: string;
  re: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: MemoryRouteContext, params: string[]) => void | Promise<void>;
}

export interface MemoryRouteContext {
  memory: MemoryService;
  /** 投影器（票 M1-T3）：/v1/memory/project 命令的执行体 */
  projector: MemoryProjector;
}

const CANDIDATE_STATUSES = ["pending", "consolidated", "dismissed", "conflicted"] as const;
const CONFLICT_STATUSES = ["open", "resolved"] as const;

export const memoryRoutes: MemoryRoute[] = [
  {
    method: "GET",
    re: /^\/v1\/memory\/facts$/,
    handler: handleMemoryFacts,
  },
  {
    method: "GET",
    re: /^\/v1\/memory\/candidates$/,
    handler: handleListCandidates,
  },
  {
    method: "POST",
    re: /^\/v1\/memory\/candidates\/([^/]+)\/decide$/,
    handler: handleDecideCandidate,
  },
  {
    method: "GET",
    re: /^\/v1\/memory\/conflicts$/,
    handler: handleListConflicts,
  },
  {
    method: "POST",
    re: /^\/v1\/memory\/conflicts\/([^/]+)\/resolve$/,
    handler: handleResolveConflict,
  },
  {
    method: "POST",
    re: /^\/v1\/memory\/import$/,
    handler: handleMemoryImport,
  },
  {
    method: "POST",
    re: /^\/v1\/memory\/([^/]+)\/promote$/,
    handler: handlePromoteMemory,
  },
  {
    method: "DELETE",
    re: /^\/v1\/memory\/facts\/([^/]+)$/,
    handler: handleDeleteFact,
  },
  {
    method: "POST",
    re: /^\/v1\/memory\/project$/,
    handler: handleMemoryProject,
  },
];

function handleMemoryFacts(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: MemoryRouteContext): void {
  const q = url.searchParams.get("q");
  if (q === null || q.trim().length === 0) {
    sendError(res, 400, "invalid_query", "q must be a non-empty keyword");
    return;
  }
  const keyword = q.trim();
  const scopeRaw = url.searchParams.get("scope");
  let scope: string | undefined;
  if (scopeRaw !== null) {
    const trimmed = scopeRaw.trim();
    if (trimmed !== "owner" && !/^session:[^:/]+$/.test(trimmed)) {
      sendError(res, 400, "invalid_query", 'scope must be "owner" or "session:<session_id>"');
      return;
    }
    scope = trimmed;
  }
  // 语义修正（v0.1.1）：端点名为 facts，默认就只返回**已巩固的长期事实**。
  // 底层 FTS 是「候选 + 事实」统一索引（M1-T1 的超集实现），直接把候选混进 facts
  // 会让同一条记忆出现两次（stage=candidate 与 stage=fact），容易被误读成重复写入。
  // 需要超集时显式 ?include=candidates=1。
  // 允许 include=candidates 或 include=candidates=1（后者会被 URL 解析成 "candidates=1"）
  const includeRaw = url.searchParams.get("include") ?? "";
  const includeCandidates = includeRaw.split(",").some((part) => part.trim().startsWith("candidates"));
  const hits = ctx.memory.search(keyword, scope === undefined ? {} : { scope });
  const facts = includeCandidates ? hits : hits.filter((hit) => hit.stage === "fact");
  sendJson(res, 200, { q: keyword, ...(scope === undefined ? {} : { scope }), facts });
}

function handleListCandidates(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: MemoryRouteContext): void {
  const status = url.searchParams.get("status");
  if (status !== null && !(CANDIDATE_STATUSES as readonly string[]).includes(status)) {
    sendError(res, 400, "invalid_query", `status must be one of ${CANDIDATE_STATUSES.join(" | ")}`);
    return;
  }
  const page = parsePaging(url, res, { defaultLimit: 200 });
  if (page === null) return;
  const candidates = ctx.memory.listCandidates({
    ...(status !== null ? { status: status as (typeof CANDIDATE_STATUSES)[number] } : {}),
    limit: page.limit,
    offset: page.offset,
  });
  sendJson(res, 200, { candidates });
}

interface DecideBody {
  decision?: unknown;
}

async function handleDecideCandidate(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: MemoryRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const { decision } = body as DecideBody;
  if (decision !== "accept" && decision !== "dismiss") {
    sendError(res, 400, "invalid_body", "decision must be `accept` or `dismiss`");
    return;
  }
  try {
    const result = ctx.memory.decideCandidate(params[0], decision);
    sendJson(res, 200, {
      candidate_id: result.candidateId,
      decision: result.decision,
      // accept：单候选巩固运行的产物投影；dismiss 无产物
      ...(result.result === null
        ? {}
        : { outcome: consolidationOutcome(result.result), run: result.result }),
    });
  } catch (err) {
    handleMemoryControlError(res, err);
  }
}

function handleListConflicts(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: MemoryRouteContext): void {
  const status = url.searchParams.get("status");
  if (status !== null && !(CONFLICT_STATUSES as readonly string[]).includes(status)) {
    sendError(res, 400, "invalid_query", `status must be one of ${CONFLICT_STATUSES.join(" | ")}`);
    return;
  }
  const page = parsePaging(url, res, { defaultLimit: 200 });
  if (page === null) return;
  const conflicts = ctx.memory.listConflicts({
    ...(status !== null ? { status: status as (typeof CONFLICT_STATUSES)[number] } : {}),
    limit: page.limit,
    offset: page.offset,
  });
  sendJson(res, 200, { conflicts });
}

interface ResolveBody {
  resolution?: unknown;
  content?: unknown;
}

async function handleResolveConflict(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: MemoryRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const { resolution, content } = body as ResolveBody;
  try {
    const result = ctx.memory.resolveConflict(params[0], { resolution: resolution as never, content });
    sendJson(res, 200, result);
  } catch (err) {
    handleMemoryControlError(res, err);
  }
}

/** 单候选巩固运行的响应投影（decide accept 的 outcome 字段） */
function consolidationOutcome(run: ConsolidationRunSummary): Record<string, unknown> {
  if (run.createdFactIds.length > 0) return { kind: "fact_created", fact_id: run.createdFactIds[0] };
  if (run.updatedFactIds.length > 0) return { kind: "fact_updated", fact_id: run.updatedFactIds[0] };
  if (run.corroboratedFactIds.length > 0) return { kind: "corroborated", fact_id: run.corroboratedFactIds[0] };
  if (run.conflictIds.length > 0) return { kind: "conflict", conflict_id: run.conflictIds[0] };
  return { kind: "no_action" };
}

// --- T3 投影 / 受控导入 / 删除标记 handlers（票 M1-T3 / Issue #15）----------------

interface ImportBody {
  markdown?: unknown;
}

/** 受控导入：body = { markdown: §6.4 投影文件全文 }（解析失败的 400 在此转译） */
async function handleMemoryImport(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: MemoryRouteContext): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const { markdown } = body as ImportBody;
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    sendError(res, 400, "invalid_body", "markdown must be a non-empty string (the full text of a §6.4 projection file)");
    return;
  }
  try {
    // 200 = 请求本身成立；updated / conflict（进待确认队列）/ unchanged 三态见响应体
    sendJson(res, 200, ctx.memory.importMarkdown(markdown));
  } catch (err) {
    if (err instanceof MarkdownParseError) {
      sendError(res, 400, "memory_invalid_input", err.message);
      return;
    }
    handleMemoryControlError(res, err);
  }
}

/** 提升为长期记忆（票 M7-A-T3）：candidate 或 fact 均可；非 session scope → 409 */
function handlePromoteMemory(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: MemoryRouteContext, params: string[]): void {
  try {
    sendJson(res, 200, ctx.memory.promoteMemory(params[0]));
  } catch (err) {
    handleMemoryControlError(res, err);
  }
}

/** 删除标记：locked 默认拒绝（409），?confirm=true 显式确认放行 */
function handleDeleteFact(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: MemoryRouteContext, params: string[]): void {
  const confirmRaw = url.searchParams.get("confirm");
  try {
    const result = ctx.memory.deleteFact(params[0], confirmRaw === null ? {} : { confirm: confirmRaw === "true" });
    sendJson(res, 200, result);
  } catch (err) {
    handleMemoryControlError(res, err);
  }
}

/** 投影再生成命令（幂等）：只写差异文件 + 清理孤儿投影（外来文件不动） */
function handleMemoryProject(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: MemoryRouteContext): void {
  const result = ctx.projector.projectAll();
  sendJson(res, 200, { directory: ctx.projector.dir, ...result });
}

/**
 * MemoryControlError → HTTP：invalid_input 400、not_found 404；invalid_state /
 * stale_version（导入防覆盖）/ locked_confirm（locked 删除未确认）409；其余上抛 500。
 */
function handleMemoryControlError(res: ServerResponse, err: unknown): void {
  if (err instanceof MemoryControlError) {
    const status = err.code === "not_found" ? 404 : err.code === "invalid_input" ? 400 : 409;
    sendError(res, status, `memory_${err.code}`, err.message);
    return;
  }
  throw err;
}
