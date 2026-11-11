import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * HTTP 控制面共用小工具（M1 code-review 收敛项）：runtime.ts 与 memory/routes.ts
 * 原各持一份 readJsonBody / parsePaging / sendJson / sendError 副本，语义一致但
 * 双处维护会漂移——收敛为单源。路由本身仍各归各文件（runtime.ts 极简路由 +
 * memoryRoutes 表），本模块只承载请求/响应的公共机械。
 */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/**
 * 读取并解析 JSON 请求体；非法时写出 400/413/415 并返回 null。
 *
 * content-type 必须显式为 application/json：application/json 不在 CORS「简单请求」
 * safelist 内，跨源页面伪造的 simple POST（text/plain）会被强制走 preflight——
 * 这是写端点的 CSRF 防线之一（威胁模型域 4「浏览器网页 CSRF 向量」；曾不校验
 * content-type，M0 code-review / Issue #11 补上）。runtime 与 memory 路由共用本实现，
 * 防线面对全部写端点一致生效（M1 code-review：删除两处私有副本）。
 */
export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown> | null> {
  const contentType = req.headers["content-type"];
  if (contentType === undefined || !/^application\/json\b/i.test(contentType.trim())) {
    sendError(res, 415, "unsupported_media_type", "content-type must be application/json");
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) {
      sendError(res, 413, "payload_too_large", `request body exceeds ${maxBytes} bytes`);
      return null;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    sendError(res, 400, "invalid_body", "a JSON object body is required");
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendError(res, 400, "invalid_body", "a JSON object body is required");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, "invalid_body", "malformed JSON body");
    return null;
  }
}

export interface PagingParams {
  limit: number;
  offset: number;
}

/**
 * 分页公共参数（limit 1–200、offset ≥ 0；defaultLimit 由调用方按端点口径给定：
 * events 族 50、memory 列表族 200）；非法时写出 400 并返回 null。
 * （原 runtime.ts parsePageParams 与 memory/routes.ts parsePaging 的同步收敛。）
 */
export function parsePaging(
  url: URL,
  res: ServerResponse,
  options: { defaultLimit: number },
): PagingParams | null {
  const params = url.searchParams;
  let limit = options.defaultLimit;
  let offset = 0;

  const limitRaw = params.get("limit");
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 200) {
      sendError(res, 400, "invalid_query", "limit must be an integer between 1 and 200");
      return null;
    }
    limit = Number(limitRaw);
  }
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null) {
    if (!/^\d+$/.test(offsetRaw)) {
      sendError(res, 400, "invalid_query", "offset must be a non-negative integer");
      return null;
    }
    offset = Number(offsetRaw);
  }
  return { limit, offset };
}
