import type { IncomingMessage, ServerResponse } from "node:http";
import type { SyncEnvelope } from "@morrow/protocol";
import { readJsonBody, sendJson } from "../http-util.ts";
import { UUID_RE } from "../uuid-v7.ts";
import { SYNC_PULL_DEFAULT_LIMIT, SYNC_PULL_MAX_LIMIT, type SyncEngine } from "./engine.ts";
import { SyncError } from "./errors.ts";

/**
 * 同步控制面路由（M3-T1 / Issue #30，PRD §4.6 FR-DEP-3 / §6.2）：
 *
 *   GET  /v1/sync/status                       本副本 sequence 范围 + 各 peer 游标
 *   GET  /v1/sync/pull?since=<seq>&limit=      按本副本账本 sequence 升序导出 SyncEnvelope
 *                                              批次（默认 100，上限 1000；截断 has_more）
 *   POST /v1/sync/push                         body { peer_replica_id, envelopes[] }——
 *                                              event_id 幂等导入 + integrity 复算 +
 *                                              sequence 缺口拒绝（sync_gap）
 *
 * 绝不复制 DB 文件：导出/导入的只是事件信封原文。错误信封与 runtime 全局约定一致
 * （`{ error: { code, message } }`）；sync_gap 额外平铺 expected/actual。
 */

export interface SyncRouteContext {
  sync: SyncEngine;
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
