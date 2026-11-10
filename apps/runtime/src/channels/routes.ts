import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelHealth, ChannelSummary } from "@morrow/protocol";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import type { ChannelRegistry } from "./registry.ts";
import { CONVERSATION_ALLOW_MODES, type ConversationAllowRow } from "./store.ts";

/**
 * 渠道管理路由（M4-T1 / Issue #38；群聊白名单写端点 M4-T6 / Issue #43）：
 *
 *   GET /v1/channels              适配器清单（channel_id/account/state/capabilities/
 *                                 enabled/experimental）
 *   GET /v1/channels/:id/health   单个适配器健康检查（状态 + 自报健康 + 检查时间）
 *   GET /v1/channels/:id/allowlist   群聊白名单（account × native_conversation_id × mode）
 *   PUT /v1/channels/:id/allowlist   整表替换（mention_only | proactive_limited）+ 审计
 *
 * 未注册渠道 → 404 unknown_channel。未列入白名单的群全部不响应（T1 入站路由已有判定，
 * 本票补齐管理端点与 channel.allowlist_updated 审计）。
 */

export interface ChannelRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: ChannelRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface ChannelRouteContext {
  channels: ChannelRegistry;
}

export const channelRoutes: ChannelRoute[] = [
  { method: "GET", re: /^\/v1\/channels$/, handler: handleListChannels },
  { method: "GET", re: /^\/v1\/channels\/([^/]+)\/health$/, handler: handleChannelHealth },
  { method: "GET", re: /^\/v1\/channels\/([^/]+)\/allowlist$/, handler: handleGetAllowlist },
  { method: "PUT", re: /^\/v1\/channels\/([^/]+)\/allowlist$/, handler: handlePutAllowlist },
];

function handleListChannels(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
): void {
  const channels: ChannelSummary[] = ctx.channels.list();
  sendJson(res, 200, { channels });
}

async function handleChannelHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): Promise<void> {
  const channelId = params[0] as string;
  const health: ChannelHealth | null = await ctx.channels.health(channelId);
  if (health === null) {
    sendError(res, 404, "unknown_channel", `no channel adapter registered for "${channelId}"`);
    return;
  }
  sendJson(res, 200, health);
}

function handleGetAllowlist(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): void {
  const channelId = params[0] as string;
  const view = ctx.channels.allowlist(channelId);
  if (view === null) {
    sendError(res, 404, "unknown_channel", `no channel adapter registered for "${channelId}"`);
    return;
  }
  sendJson(res, 200, allowlistResponse(channelId, view.account_id, view.entries));
}

async function handlePutAllowlist(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): Promise<void> {
  const channelId = params[0] as string;
  if (ctx.channels.allowlist(channelId) === null) {
    sendError(res, 404, "unknown_channel", `no channel adapter registered for "${channelId}"`);
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const holder = body as { allowlist?: unknown; entries?: unknown };
  const raw = holder.allowlist ?? holder.entries;
  if (!Array.isArray(raw)) {
    sendError(res, 400, "invalid_body", "allowlist must be an array of { native_conversation_id, mode }");
    return;
  }
  const entries: Array<{ native_conversation_id: string; mode: ConversationAllowRow["mode"] }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      sendError(res, 400, "invalid_body", "each allowlist entry must be an object");
      return;
    }
    const nativeId = (item as { native_conversation_id?: unknown }).native_conversation_id;
    const mode = (item as { mode?: unknown }).mode;
    if (typeof nativeId !== "string" || nativeId.trim().length === 0) {
      sendError(res, 400, "invalid_body", "native_conversation_id must be a non-empty string");
      return;
    }
    if (typeof mode !== "string" || !(CONVERSATION_ALLOW_MODES as readonly string[]).includes(mode)) {
      sendError(res, 400, "invalid_body", `mode must be one of ${CONVERSATION_ALLOW_MODES.join(" | ")}`);
      return;
    }
    if (seen.has(nativeId.trim())) {
      sendError(res, 400, "invalid_body", `duplicate allowlist entry for "${nativeId.trim()}"`);
      return;
    }
    seen.add(nativeId.trim());
    entries.push({ native_conversation_id: nativeId.trim(), mode: mode as ConversationAllowRow["mode"] });
  }
  const view = ctx.channels.setAllowlist(channelId, entries);
  if (view === null) {
    sendError(res, 404, "unknown_channel", `no channel adapter registered for "${channelId}"`);
    return;
  }
  sendJson(res, 200, allowlistResponse(channelId, view.account_id, view.entries));
}

function allowlistResponse(
  channelId: string,
  accountId: string | null,
  entries: ConversationAllowRow[],
): {
  channel: string;
  account_id: string | null;
  allowlist: Array<{ native_conversation_id: string; mode: ConversationAllowRow["mode"]; created_at: string }>;
} {
  return {
    channel: channelId,
    account_id: accountId,
    allowlist: entries.map((entry) => ({
      native_conversation_id: entry.native_conversation_id,
      mode: entry.mode,
      created_at: entry.created_at,
    })),
  };
}
