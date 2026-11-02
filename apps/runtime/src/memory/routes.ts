import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemoryService } from "./service.ts";

/**
 * 记忆控制面路由（票 M1-T1 / Issue #13，PRD §6.2）：
 *
 *   GET /v1/memory/facts?q=关键词   FTS5 关键词检索（候选与事实统一索引），
 *                                   命中条目带 sources（来源账本 event_id 数组，PRD §6.4）
 *
 * 独立成文件以收拢记忆路由与 runtime.ts 的并行票改动面；错误信封形状与 runtime.ts
 * 全局约定一致（`{ error: { code, message } }`）。
 * 注：memory.* 事件经账本入 SSE 重放（session_id 关联），实时广播由会话帧负责的
 * 部分见 runtime README「记忆管线」一节的边界说明。
 */

export interface MemoryRouteContext {
  memory: MemoryService;
}

export const memoryFactsRoute: {
  method: string;
  re: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: MemoryRouteContext) => void;
} = {
  method: "GET",
  re: /^\/v1\/memory\/facts$/,
  handler: handleMemoryFacts,
};

function handleMemoryFacts(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: MemoryRouteContext): void {
  const q = url.searchParams.get("q");
  if (q === null || q.trim().length === 0) {
    sendError(res, 400, "invalid_query", "q must be a non-empty keyword");
    return;
  }
  const keyword = q.trim();
  sendJson(res, 200, { q: keyword, facts: ctx.memory.search(keyword) });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}
