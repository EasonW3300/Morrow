import type { PairingService } from "./service.ts";

/**
 * 请求鉴权中间层（M3-T2 / Issue #31，ADR-0008）。
 *
 * 规则（fail-closed）：
 * - 回环来源（127.0.0.1 / ::1 / ::ffff:127.0.0.1）**豁免**——纯本地部署零配置可用；
 *   这是唯一的来源豁免，不信任任何代理头（X-Forwarded-For 等一律不看）。
 * - `POST /v1/pairing/claim` 豁免 bearer：新设备尚未持有令牌，配对码本身是
 *   单次、5 分钟、按来源限速的凭据（见 PairingService）。
 * - 其余非回环请求必须携带 `Authorization: Bearer <token>`；令牌只比对摘要。
 *   无效 401 invalid_token；已撤销 403 device_revoked；未信任 403 device_untrusted。
 * - OPTIONS（CORS preflight）不承载业务意图，由路由层先返回 204。
 *
 * 该模块把策略做成纯函数，便于不依赖真实网卡地测试非回环判定；runtime 只在
 * routeRequest 里接线。
 */

export interface AuthorizationInput {
  remoteAddress: string | undefined;
  method: string;
  pathname: string;
  authorization: string | undefined;
}

export type AuthorizationDecision =
  | { kind: "allow"; device: { replica_id: string } | null; loopback: boolean }
  | { kind: "deny"; status: number; code: "unauthorized" | "invalid_token" | "device_revoked" | "device_untrusted"; message: string };

/** 回环地址判定（仅精确 127.0.0.1 / ::1；IPv4-mapped 形式归一） */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined || remoteAddress.length === 0) return false;
  let address = remoteAddress;
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
  return address === "127.0.0.1" || address === "::1";
}

/** 从 Authorization 头提取 bearer token；非 Bearer 方案返回 null */
export function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match === null ? null : match[1];
}

/** 判定一个请求是否放行（纯策略，不写响应） */
export function authorizeRequest(
  input: AuthorizationInput,
  pairing: Pick<PairingService, "authenticate">,
): AuthorizationDecision {
  if (isLoopbackAddress(input.remoteAddress)) {
    return { kind: "allow", device: null, loopback: true };
  }
  // 新设备尚无令牌：配对码是这条路径的凭据（单次 + 5 分钟 + 来源限速）。
  if (input.method.toUpperCase() === "POST" && input.pathname === "/v1/pairing/claim") {
    return { kind: "allow", device: null, loopback: false };
  }
  const token = extractBearerToken(input.authorization);
  if (token === null) {
    return {
      kind: "deny",
      status: 401,
      code: "unauthorized",
      message: "non-loopback requests require Authorization: Bearer <device token>",
    };
  }
  const result = pairing.authenticate(token);
  if ("denied" in result) {
    if (result.denied === "device_revoked") {
      return { kind: "deny", status: 403, code: "device_revoked", message: "device has been revoked" };
    }
    if (result.denied === "device_untrusted") {
      return { kind: "deny", status: 403, code: "device_untrusted", message: "device is not trusted" };
    }
    return { kind: "deny", status: 401, code: "invalid_token", message: "device token is not valid" };
  }
  return { kind: "allow", device: { replica_id: result.device.replica_id }, loopback: false };
}
