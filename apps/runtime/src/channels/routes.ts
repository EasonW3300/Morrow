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
 *   POST /v1/channels/:id/enable     实验适配器显式启用（M4-T5）：必须
 *                                    { confirm_risk: true }，否则 409；成功落
 *                                    channel.experimental_enabled 审计
 *   POST /v1/channels/:id/disable    禁用实验适配器（立即停止收发，幂等）
 *
 * 未注册渠道 → 404 unknown_channel。未列入白名单的群全部不响应（T1 入站路由已有判定，
 * 本票补齐管理端点与 channel.allowlist_updated 审计）。微信实验适配器对私聊也要求
 * 白名单（适配器/路由双重 fail-closed）。
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
  { method: "POST", re: /^\/v1\/channels\/([^/]+)\/enable$/, handler: handleEnableChannel },
  { method: "POST", re: /^\/v1\/channels\/([^/]+)\/disable$/, handler: handleDisableChannel },
  // 渠道凭据配置（M4-T8 / Issue #45）：只回 configured 投影，绝不回显密文
  { method: "GET", re: /^\/v1\/channels\/([^/]+)\/secrets$/, handler: handleGetSecrets },
  { method: "PUT", re: /^\/v1\/channels\/([^/]+)\/secrets$/, handler: handlePutSecrets },
  // 默认通知会话（A3 修复批 / Issue #37）：channel:<id> 通知目标的解析依据
  { method: "GET", re: /^\/v1\/channels\/([^/]+)\/notify-target$/, handler: handleGetNotifyTarget },
  { method: "PUT", re: /^\/v1\/channels\/([^/]+)\/notify-target$/, handler: handlePutNotifyTarget },
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

/** GET /v1/channels/:id/secrets：凭据字段投影（configured 布尔，不含密文） */
async function handleGetSecrets(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): Promise<void> {
  const channelId = params[0] as string;
  if (ctx.channels.getAdapter(channelId) === null) {
    sendError(res, 404, "unknown_channel", `no channel adapter registered for "${channelId}"`);
    return;
  }
  if (!ctx.channels.supportsSecrets(channelId)) {
    sendError(res, 400, "channel_not_configurable", `channel "${channelId}" has no SecretStore-backed credentials`);
    return;
  }
  const view = await ctx.channels.secrets(channelId);
  if (view === null) {
    sendError(res, 503, "secret_store_unavailable", "no secret store is wired into the runtime");
    return;
  }
  sendJson(res, 200, view);
}

/** PUT /v1/channels/:id/secrets：{ secrets: { field: value } }；空串删除可选字段 */
async function handlePutSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): Promise<void> {
  const channelId = params[0] as string;
  if (ctx.channels.getAdapter(channelId) === null) {
    sendError(res, 404, "unknown_channel", `no channel adapter registered for "${channelId}"`);
    return;
  }
  if (!ctx.channels.supportsSecrets(channelId)) {
    sendError(res, 400, "channel_not_configurable", `channel "${channelId}" has no SecretStore-backed credentials`);
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const result = await ctx.channels.writeSecrets(channelId, (body as { secrets?: unknown }).secrets);
  if (result === null) {
    sendError(res, 503, "secret_store_unavailable", "no secret store is wired into the runtime");
    return;
  }
  if (!result.ok) {
    sendError(res, 400, result.code, result.message);
    return;
  }
  sendJson(res, 200, result.view);
}

/** GET /v1/channels/:id/notify-target：默认通知会话（未配置 native_conversation_id=null） */
function handleGetNotifyTarget(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): void {
  const channelId = params[0] as string;
  if (ctx.channels.getAdapter(channelId) === null) {
    sendError(res, 404, "unknown_channel", `no channel adapter registered for "${channelId}"`);
    return;
  }
  const target = ctx.channels.notifyTarget(channelId);
  sendJson(res, 200, {
    channel: channelId,
    account_id: ctx.channels.accountIdForChannel(channelId),
    native_conversation_id: target?.native_conversation_id ?? null,
    updated_at: target?.updated_at ?? null,
  });
}

/**
 * PUT /v1/channels/:id/notify-target
 * body: { native_conversation_id: "<该渠道已存在/已白名单的会话>" }
 * 未通过校验 → 400（conversation_not_found / no_account），不写库。
 */
async function handlePutNotifyTarget(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): Promise<void> {
  const channelId = params[0] as string;
  if (ctx.channels.getAdapter(channelId) === null) {
    sendError(res, 404, "unknown_channel", `no channel adapter registered for "${channelId}"`);
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const nativeId = (body as { native_conversation_id?: unknown }).native_conversation_id;
  if (typeof nativeId !== "string" || nativeId.trim().length === 0) {
    sendError(res, 400, "invalid_body", "native_conversation_id must be a non-empty string");
    return;
  }
  const result = ctx.channels.setNotifyTarget(channelId, nativeId.trim());
  if (!result.ok) {
    sendError(res, 400, result.code, result.message);
    return;
  }
  sendJson(res, 200, {
    channel: channelId,
    account_id: result.account_id,
    native_conversation_id: result.native_conversation_id,
    updated_at: result.updated_at,
  });
}

function handleGetAllowlist(  _req: IncomingMessage,
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

async function handleEnableChannel(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): Promise<void> {
  const channelId = params[0] as string;
  const body = await readJsonBody(req, res);
  if (body === null) return;

  const result = await ctx.channels.enableChannel(channelId, {
    confirmRisk: body.confirm_risk === true,
  });
  if (!result.ok) {
    if (result.code === "unknown_channel") {
      sendError(res, 404, "unknown_channel", result.message);
      return;
    }
    if (result.code === "not_experimental") {
      sendError(res, 400, "not_experimental_channel", result.message);
      return;
    }
    // 未确认风险：明确拒绝，并原样返回风险文案供 UI 展示
    sendJson(res, 409, {
      error: { code: result.code, message: result.message },
      ...(result.risk_notice === undefined ? {} : { risk_notice: result.risk_notice }),
    });
    return;
  }

  const summary = ctx.channels.list().find((channel) => channel.channel_id === channelId);
  sendJson(res, 200, {
    channel: channelId,
    enabled: true,
    experimental: summary?.experimental ?? true,
    risk_notice: result.risk_notice,
    ...(summary?.environment === undefined ? {} : { environment: summary.environment }),
  });
}

async function handleDisableChannel(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: ChannelRouteContext,
  params: string[],
): Promise<void> {
  const channelId = params[0] as string;
  // 写端点统一要求 JSON content-type（CSRF 防线）；body 本身可为空对象
  const body = await readJsonBody(req, res);
  if (body === null) return;

  const result = await ctx.channels.disableChannel(channelId);
  if (!result.ok) {
    sendError(res, 404, "unknown_channel", result.message);
    return;
  }
  sendJson(res, 200, { channel: channelId, enabled: false });
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
