/**
 * 控制面地址解析（UI ↔ Runtime 仅控制面 HTTP/SSE，PRD §6.1）。
 *
 * 1. Tauri 壳内：轮询 `sidecar_status` 命令直到 ready，取 sidecar 上报的 host/port
 *    （壳只负责端点发现，不做任何 Runtime 数据的私有通道）；
 * 2. 浏览器联调（vite dev / 组件验证）：`?runtime=http://127.0.0.1:<port>` 显式指定。
 */
import type { SidecarStatus } from "./sidecar-status.ts";

export async function resolveRuntimeBase(timeoutMs = 15000): Promise<string> {
  const fromQuery = new URLSearchParams(window.location.search).get("runtime");
  if (fromQuery) {
    return fromQuery.replace(/\/+$/, "");
  }
  if (!("__TAURI_INTERNALS__" in window)) {
    throw new Error(
      "未检测到 Tauri 壳。浏览器联调请加查询参数 ?runtime=http://127.0.0.1:<port>",
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await invoke<SidecarStatus>("sidecar_status");
    if (status.state === "ready" && status.host && status.port) {
      return `http://${status.host}:${status.port}`;
    }
    if (status.state === "error") {
      throw new Error(`Runtime sidecar 启动失败：${status.error ?? "未知错误"}`);
    }
    if (Date.now() > deadline) {
      throw new Error("等待 Runtime sidecar 就绪超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
