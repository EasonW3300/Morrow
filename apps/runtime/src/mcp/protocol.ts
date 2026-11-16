/**
 * MCP 协议层：双代际探测与 JSON-RPC 行协议（票 M7-B-T1 / Issue #67）。
 *
 * 为什么需要"双代际"（来自 `morrow-research/NOTES-m7-external.md` §2 的实测结论）：
 * MCP 规范在 2026-07-28 引入了 `server/discover`（一次调用返回版本+能力+身份，无握手）；
 * 但存量生态大量 server 仍是 legacy 的 `initialize` 流程。宿主必须两者都能谈。
 *
 * 探测顺序**不可随意调换**（ADR-0011）：
 *   1. 先发 `server/discover`
 *   2. 成功 → 用其返回的协议版本与能力
 *   3. 返回 `UnsupportedProtocolVersionError` → 该 server 是**现代**的但不支持我们请求的
 *      版本：从其 `supported` 列表里挑一个我们支持的版本重试。
 *      **绝不能在这里回退 `initialize`** —— 那会把"版本谈不拢"误判成"对方是旧版"，
 *      然后在现代 server 上跑 legacy 握手，产生难以诊断的失败。
 *   4. 其他错误或超时 → 判定为 legacy，才回退 `initialize`。
 */

/** 我们支持的现代协议版本（按新到旧；协商时取首个交集） */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2026-07-28", "2025-11-25"];

/** JSON-RPC 2.0 错误码（规范定义 + MCP 扩展） */
export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/**
 * "版本不支持"错误码。
 *
 * 规范用 `-32000..-32099` 区间的服务器自定义错误；`UnsupportedProtocolVersionError`
 * 的判别**不能只看 code**（同一区间还有别的错误），必须同时看 `data.error` 或消息特征。
 * 这里集中成一个判定函数，避免散落在调用点。
 */
export function isUnsupportedVersionError(error: JsonRpcErrorObject | null | undefined): boolean {
  if (error === null || error === undefined) return false;
  if (error.code !== -32000) return false;
  const data = error.data;
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (record.error === "UnsupportedProtocolVersionError") return true;
    if (Array.isArray(record.supported)) return true;
  }
  return /unsupportedprotocolversion|unsupported protocol version/i.test(error.message);
}

/** 从错误对象里取 server 声明支持的版本列表（没有则空数组） */
export function supportedVersionsFromError(
  error: JsonRpcErrorObject | null | undefined,
): string[] {
  if (error === null || error === undefined) return [];
  const data = error.data;
  if (typeof data !== "object" || data === null) return [];
  const supported = (data as Record<string, unknown>).supported;
  if (!Array.isArray(supported)) return [];
  return supported.filter((item): item is string => typeof item === "string");
}

/** JSON-RPC 错误对象 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 请求/通知/响应的最小形状 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

/** 从 server 声明的 supported 列表里挑我们支持的最新版本（无交集返回 null） */
export function negotiateVersion(supported: readonly string[]): string | null {
  for (const ours of SUPPORTED_PROTOCOL_VERSIONS) {
    if (supported.includes(ours)) return ours;
  }
  return null;
}

/** 探测结果（写入 health，便于诊断"这台 server 用什么代际进的"） */
export interface McpProbeResult {
  /** 最终使用的代际 */
  generation: "discover" | "initialize";
  /** 最终协议版本（legacy 时为 initialize 返回的版本） */
  protocolVersion: string;
  /** server 自报的名称/版本（discover 的 serverInfo 或 initialize 的 serverInfo） */
  serverInfo: { name?: string; version?: string };
  /** server 声明的能力（只关心 tools；resources/prompts 会被记为 unsupported） */
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  /** 能力协商里我们**不**支持的部分（如实回报，不静默忽略） */
  unsupportedCapabilities: string[];
}

/** 我们需要 server 提供的能力；其余一律记为不支持 */
export interface McpServerCapabilities {
  tools?: unknown;
  resources?: unknown;
  prompts?: unknown;
  [key: string]: unknown;
}

/** 从任意来源的能力声明里算出"支持什么、不支持什么" */
export function classifyCapabilities(raw: unknown): McpProbeResult["capabilities"] & {
  unsupported: string[];
} {
  const capabilities: McpServerCapabilities =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as McpServerCapabilities)
      : {};
  const tools = capabilities.tools !== undefined && capabilities.tools !== null;
  const resources = capabilities.resources !== undefined && capabilities.resources !== null;
  const prompts = capabilities.prompts !== undefined && capabilities.prompts !== null;
  // 如实回报：我们只实现 tools，其余即便是合法能力也标为不支持
  const unsupported: string[] = [];
  if (resources) unsupported.push("resources");
  if (prompts) unsupported.push("prompts");
  for (const key of Object.keys(capabilities)) {
    if (key !== "tools" && key !== "resources" && key !== "prompts") {
      unsupported.push(key);
    }
  }
  return { tools, resources, prompts, unsupported };
}

/** MCP tool 描述（tools/list 的条目） */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** tools/list 响应 */
export interface McpToolsListResult {
  tools: McpToolDescriptor[];
}

/** tools/call 响应（content 是内容块数组；isError 表示工具自身失败） */
export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

/** 构造 JSON-RPC 请求（自动分配 id 由调用方负责，便于测试确定性） */
export function buildRequest(id: number | string, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}
