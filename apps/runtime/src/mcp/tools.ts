/**
 * MCP 工具 → Morrow capability 映射（票 M7-B-T1 / Issue #67）。
 *
 * 设计要点：
 *   - MCP 工具注册为 `runtime: "mcp"` 的 capability，**走同一套五维权限**（管控面统一）；
 *   - 默认权限为**空**（无 shell、无网络、无文件系统）——MCP server 本身在宿主上跑，
 *     但我们仍要求 Owner 显式授予，避免"装了 server 就等于全权"；
 *   - 工具名做前缀命名空间（`mcp.<server>.<tool>`），防止不同 server 的同名工具互撞。
 */

import type { CapabilityManifest } from "@morrow/protocol";
import type { McpToolDescriptor } from "./protocol.ts";

/** 工具名命名空间前缀：`mcp.<serverId>.<toolName>` */
export const MCP_TOOL_PREFIX = "mcp";

/**
 * 把 MCP 工具名合成为 Morrow capability 名。
 *
 * serverId 与 toolName 都做安全化（只保留 `[a-z0-9_-]`，其余转 `-`，转小写）：
 * capability 名有格式约束（小写点分），而 MCP 工具名允许大写与其它字符。
 */
export function mcpCapabilityName(serverId: string, toolName: string): string {
  const safe = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-");
  const server = safe(serverId) || "server";
  const tool = safe(toolName) || "tool";
  return `${MCP_TOOL_PREFIX}.${server}.${tool}`;
}

/**
 * 派生 capability manifest。
 *
 * 注意 `sandbox.type` 用 `"process"` 而不是 `"container"`：MCP server 本身就是宿主
 * 子进程（ADR-0011 已登记的残余风险），把它标成 container 是**说谎**——会让权限审查
 * 与 UI 都误以为有隔离。标 process 才能让"这条能力没有容器隔离"在数据里可见。
 */
export function mcpToolToManifest(
  serverId: string,
  tool: McpToolDescriptor,
  options: { version?: string; serverVersion?: string } = {},
): CapabilityManifest {
  return {
    name: mcpCapabilityName(serverId, tool.name),
    version: options.version ?? "1.0.0",
    author: "human", // 安装是 Owner 的显式动作；权限仍需单独授予
    runtime: "typescript", // capability manifest 的 runtime 枚举只有 ts/go；MCP 工具由宿主代理调用
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema:
      tool.inputSchema !== undefined && tool.inputSchema !== null
        ? tool.inputSchema
        : { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "process", network: "none", filesystem: "none" },
    tests: [], // MCP 工具的"测试"是 server 自己的事；这里不伪造
    ...(options.serverVersion === undefined ? {} : { source_hash: undefined }),
  };
}

/** 一批工具 → 一批 manifest（保持原顺序，便于对照 server 的 tools/list） */
export function mcpToolsToManifests(
  serverId: string,
  tools: readonly McpToolDescriptor[],
  options: { version?: string } = {},
): CapabilityManifest[] {
  return tools.map((tool) => mcpToolToManifest(serverId, tool, options));
}
