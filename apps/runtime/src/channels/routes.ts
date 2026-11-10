import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelHealth, ChannelSummary } from "@morrow/protocol";
import { sendError, sendJson } from "../http-util.ts";
import type { ChannelRegistry } from "./registry.ts";

/**
 * 渠道管理路由（M4-T1 / Issue #38，PRD §6.2）：
 *
 *   GET /v1/channels              适配器清单（channel_id/account/state/capabilities/
 *                                 enabled/experimental）
 *   GET /v1/channels/:id/health   单个适配器健康检查（状态 + 自报健康 + 检查时间）
 *
 * 未注册渠道 → 404 unknown_channel。渠道管理 UI 的「适配器健康状态、最近消息」数据源；
 * 白名单/启停写端点在后续联系人/群聊票交付。
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
