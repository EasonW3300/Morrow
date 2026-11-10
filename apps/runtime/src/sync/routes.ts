import type { IncomingMessage, ServerResponse } from "node:http";
import type { SyncEnvelope } from "@morrow/protocol";
import { parsePaging, readJsonBody, sendError, sendJson } from "../http-util.ts";
import { MemoryControlError, type MemoryService } from "../memory/service.ts";
import { UUID_RE } from "../uuid-v7.ts";
import type { SyncConflictStore } from "./conflict-store.ts";
import { SYNC_PULL_DEFAULT_LIMIT, SYNC_PULL_MAX_LIMIT, type SyncEngine } from "./engine.ts";
import { SyncError } from "./errors.ts";
import { listSyncConflicts } from "./memory-sync.ts";

/**
 * 同步控制面路由（M3-T1 / Issue #30，PRD §4.6 FR-DEP-3 / §6.2；M3-T3 冲突汇总）：
 *
 *   GET  /v1/sync/status                       本副本 sequence 范围 + 各 peer 游标
 *   GET  /v1/sync/pull?since=<seq>&limit=      按本副本账本 sequence 升序导出 SyncEnvelope
 *                                              批次（默认 100，上限 1000；截断 has_more）
 *   POST /v1/sync/push                         body { peer_replica_id, envelopes[] }——
 *                                              event_id 幂等导入 + integrity 复算 +
 *                                              sequence 缺口拒绝（sync_gap）
 *   GET  /v1/sync/conflicts?status=            跨设备冲突汇总（M3-T3）：M1 memory_conflicts
 *                                              本体 + 来源 replica / 三方版本；这是同一队列的
 *                                              同步视图，不另建队列
 *   POST /v1/sync/conflicts/:id/resolve        复用 M1 裁决语义（keep_new / keep_old / merge），
 *                                              并标记同步元数据 resolved
 *
 * 绝不复制 DB 文件：导出/导入的只是事件信封原文。错误信封与 runtime 全局约定一致
 * （`{ error: { code, message } }`）；sync_gap 额外平铺 expected/actual。
 */

export interface SyncRouteContext {
  sync: SyncEngine;
  /** M3-T3：/v1/sync/conflicts 复用 M1 冲突队列与裁决语义 */
  memory?: MemoryService;
  syncConflicts?: SyncConflictStore;
}

export interface SyncRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: SyncRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export const syncRoutes: SyncRoute[] = [
  { method: "GET", re: /^\/v1\/sync\/status$/, handler: handleStatus },
  { method: "GET", re: /^\/v1\/sync\/pull$/, handler: handlePull },
  { method: "POST", re: /^\/v1\/sync\/push$/, handler: handlePush },
  { method: "GET", re: /^\/v1\/sync\/conflicts$/, handler: handleSyncConflicts },
  { method: "POST", re: /^\/v1\/sync\/conflicts\/([^/]+)\/resolve$/, handler: handleSyncResolveConflict },
];

function handleStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: SyncRouteContext,
): void {
  sendJson(res, 200, ctx.sync.status());
}

function handlePull(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: SyncRouteContext,
): void {
  const since = parseNonNegativeInteger(url.searchParams.get("since"), "since");
  if (since === null) {
    sendErrorWithCode(res, 400, "invalid_query", "since must be a non-negative integer");
    return;
  }
  let limit = SYNC_PULL_DEFAULT_LIMIT;
  const limitRaw = url.searchParams.get("limit");
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > SYNC_PULL_MAX_LIMIT) {
      sendErrorWithCode(
        res,
        400,
        "invalid_query",
        `limit must be an integer between 1 and ${SYNC_PULL_MAX_LIMIT}`,
      );
      return;
    }
    limit = Number(limitRaw);
  }
  sendJson(res, 200, ctx.sync.exportBatch(since, limit));
}

async function handlePush(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: SyncRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const peerReplicaId = body.peer_replica_id;
  if (typeof peerReplicaId !== "string" || !UUID_RE.test(peerReplicaId)) {
    sendErrorWithCode(res, 400, "invalid_body", "peer_replica_id must be a lowercase uuid");
    return;
  }
  if (!Array.isArray(body.envelopes)) {
    sendErrorWithCode(res, 400, "invalid_body", "envelopes must be an array");
    return;
  }
  try {
    const outcome = ctx.sync.receivePush(peerReplicaId, body.envelopes as SyncEnvelope[]);
    sendJson(res, 200, outcome);
  } catch (err) {
    if (!sendSyncError(res, err)) throw err;
  }
}

/** GET /v1/sync/pull 的 since 解析：缺省 = 0；非法数字/负数返回 null */
function parseNonNegativeInteger(raw: string | null, _name: string): number | null {
  if (raw === null) return 0;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** sync_gap → 409；integrity/invalid batch → 400；传输不可用 → 503；非 SyncError 交回上层 500 */
function sendSyncError(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof SyncError)) return false;
  const status =
    err.code === "sync_gap" ? 409 : err.code === "sync_transport_unavailable" ? 503 : 400;
  sendJson(res, status, {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ?? {}),
    },
  });
  return true;
}

function sendErrorWithCode(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { code, message } });
}

// --- M3-T3 跨设备冲突（票 #32）-------------------------------------------------

const SYNC_CONFLICT_STATUSES = ["open", "resolved"] as const;

function handleSyncConflicts(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: SyncRouteContext,
): void {
  if (ctx.memory === undefined || ctx.syncConflicts === undefined) {
    sendErrorWithCode(res, 503, "sync_semantics_unavailable", "sync conflict semantics are not wired in this runtime");
    return;
  }
  const status = url.searchParams.get("status");
  if (status !== null && !(SYNC_CONFLICT_STATUSES as readonly string[]).includes(status)) {
    sendError(res, 400, "invalid_query", `status must be one of ${SYNC_CONFLICT_STATUSES.join(" | ")}`);
    return;
  }
  const page = parsePaging(url, res, { defaultLimit: 200 });
  if (page === null) return;
  const conflicts = listSyncConflicts(ctx.memory, ctx.syncConflicts, {
    ...(status !== null ? { status: status as (typeof SYNC_CONFLICT_STATUSES)[number] } : {}),
    limit: page.limit,
    offset: page.offset,
  });
  sendJson(res, 200, { conflicts });
}

async function handleSyncResolveConflict(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: SyncRouteContext,
  params: string[],
): Promise<void> {
  if (ctx.memory === undefined || ctx.syncConflicts === undefined) {
    sendErrorWithCode(res, 503, "sync_semantics_unavailable", "sync conflict semantics are not wired in this runtime");
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    // 与 POST /v1/memory/conflicts/:id/resolve 完全同一实现（同一队列、同一裁决语义），
    // 区别只在响应附带来源副本信息并把同步元数据标为已裁决。
    const result = ctx.memory.resolveConflict(params[0], {
      resolution: body.resolution as never,
      content: body.content,
    });
    ctx.syncConflicts.markResolved(params[0]);
    sendJson(res, 200, {
      ...result,
      sync: ctx.syncConflicts.get(params[0]),
    });
  } catch (err) {
    if (err instanceof MemoryControlError) {
      const status = err.code === "not_found" ? 404 : err.code === "invalid_input" ? 400 : 409;
      sendError(res, status, `memory_${err.code}`, err.message);
      return;
    }
    throw err;
  }
}
