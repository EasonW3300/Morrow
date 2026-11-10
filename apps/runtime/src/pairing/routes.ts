import type { IncomingMessage, ServerResponse } from "node:http";
import type { PairingClaimRequest, PairingCodeResponse } from "@morrow/protocol";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import type { DeviceRegistry } from "../devices.ts";
import { UUID_RE } from "../uuid-v7.ts";
import { PairingError, type PairingService } from "./service.ts";

/**
 * 配对与设备管理路由（M3-T2 / Issue #31，PRD §6.2）：
 *
 *   POST   /v1/pairing/codes     已信任设备生成一次性配对码（body 可空）
 *   POST   /v1/pairing/claim     新设备凭码换取设备凭据（唯一免除 bearer 的非回环路径）
 *   POST   /v1/pairing/join      **本机作为新设备**加入对端 Runtime（M3 修复批 / Issue #35）：
 *                                宿主侧 claim + 本地指纹校验 + token 写 OS 凭据库 +
 *                                对端公钥写设备表；响应绝不含 token 明文
 *   DELETE /v1/devices/:id       撤销设备（revoked=1 + 清 token_hash + 审计）
 *
 * GET /v1/devices 仍由 runtime.ts 的极简路由承载（M0 起就在那里；本票只扩展了
 * DeviceRegistry.list 的投影字段）。错误信封与全局约定一致
 * （`{ error: { code, message } }`），PairingError 的 httpStatus 决定状态码。
 */

export interface PairingRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: PairingRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface PairingRouteContext {
  pairing: PairingService;
  devices: DeviceRegistry;
  replicaId: string;
}

export const pairingRoutes: PairingRoute[] = [
  { method: "POST", re: /^\/v1\/pairing\/codes$/, handler: handleCreatePairingCode },
  { method: "POST", re: /^\/v1\/pairing\/claim$/, handler: handleClaimPairing },
  { method: "POST", re: /^\/v1\/pairing\/join$/, handler: handleJoinPairing },
  { method: "DELETE", re: /^\/v1\/devices\/([^/]+)$/, handler: handleRevokeDevice },
];

async function handleCreatePairingCode(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PairingRouteContext,
): Promise<void> {
  try {
    // issuer = 本机 runtime 设备：/v1/pairing/codes 只对回环或已信任令牌放行，
    // 而本机设备行在启动时已 trusted=1。远端已信任设备来调用也由其令牌证明身份，
    // 但码的归属仍记在本机（码只在本机 claim 有效）。
    const response: PairingCodeResponse = await ctx.pairing.createCode(ctx.replicaId);
    sendJson(res, 201, response);
  } catch (err) {
    sendPairingError(res, err);
  }
}

async function handleClaimPairing(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PairingRouteContext,
): Promise<void> {
  const body = (await readJsonBody(req, res)) as PairingClaimRequest | null;
  if (body === null) return;
  const code = body.code;
  const devicePublicKey = body.device_public_key;
  if (typeof code !== "string") {
    sendError(res, 400, "invalid_body", "code must be a string");
    return;
  }
  if (typeof devicePublicKey !== "string") {
    sendError(res, 400, "invalid_body", "device_public_key must be a string");
    return;
  }
  if (body.device_label !== undefined && typeof body.device_label !== "string") {
    sendError(res, 400, "invalid_body", "device_label must be a string when present");
    return;
  }
  if (body.device_replica_id !== undefined && typeof body.device_replica_id !== "string") {
    sendError(res, 400, "invalid_body", "device_replica_id must be a string when present");
    return;
  }
  if (body.device_base_url !== undefined && typeof body.device_base_url !== "string") {
    sendError(res, 400, "invalid_body", "device_base_url must be a string when present");
    return;
  }
  if (body.server_fingerprint !== undefined && typeof body.server_fingerprint !== "string") {
    sendError(res, 400, "invalid_body", "server_fingerprint must be a string when present");
    return;
  }

  try {
    const result = await ctx.pairing.claim({
      code,
      devicePublicKey,
      deviceLabel: body.device_label,
      deviceReplicaId: body.device_replica_id,
      deviceBaseUrl: body.device_base_url,
      expectedServerFingerprint: body.server_fingerprint,
      remoteKey: req.socket.remoteAddress,
    });
    sendJson(res, 200, result);
  } catch (err) {
    sendPairingError(res, err);
  }
}

async function handleJoinPairing(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PairingRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const baseUrl = body.base_url;
  const code = body.code;
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    sendError(res, 400, "invalid_body", "base_url must be a non-empty string");
    return;
  }
  if (typeof code !== "string") {
    sendError(res, 400, "invalid_body", "code must be a string");
    return;
  }
  if (body.device_label !== undefined && typeof body.device_label !== "string") {
    sendError(res, 400, "invalid_body", "device_label must be a string when present");
    return;
  }
  if (body.expect_server_fingerprint !== undefined && typeof body.expect_server_fingerprint !== "string") {
    sendError(res, 400, "invalid_body", "expect_server_fingerprint must be a string when present");
    return;
  }
  try {
    const result = await ctx.pairing.join({
      baseUrl: baseUrl.trim(),
      code,
      deviceLabel: body.device_label,
      expectedServerFingerprint: body.expect_server_fingerprint,
    });
    // 响应类型 PairingJoinResponse 不含 token；join() 已把它写入本机凭据库。
    sendJson(res, 200, result);
  } catch (err) {
    sendPairingError(res, err);
  }
}

function handleRevokeDevice(  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: PairingRouteContext,
  params: string[],
): void {
  const deviceId = params[0];
  if (!UUID_RE.test(deviceId)) {
    sendError(res, 400, "invalid_device_id", "device id must be a lowercase uuid");
    return;
  }
  try {
    const result = ctx.pairing.revoke(deviceId);
    if (result === null) {
      sendError(res, 404, "not_found", `no device ${deviceId}`);
      return;
    }
    sendJson(res, 200, { device: result.device, changed: result.changed });
  } catch (err) {
    sendPairingError(res, err);
  }
}

function sendPairingError(res: ServerResponse, err: unknown): void {
  if (err instanceof PairingError) {
    sendError(res, err.httpStatus, err.code, err.message);
    return;
  }
  throw err;
}
