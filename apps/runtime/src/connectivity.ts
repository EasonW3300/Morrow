/**
 * Provider 连通性测试（票 T5 / Issue #6）：对指定 Provider 发一次最小 OpenAI 兼容请求
 * （POST {base_url}/chat/completions，max_tokens=1，非流式——请求形态与 pi-adapter 的
 * 真实调用一致，成本最低），区分结果类别（类型唯一真相源在 @morrow/protocol/api-contracts）：
 *
 *   ok            2xx
 *   auth_failed   401 / 403（密钥无效或无权限）
 *   unreachable   连接失败 / DNS 失败 / 超时（默认 10s，AbortController）——
 *                 kind 结构化区分 timeout 与 connect_error（UI 不嗅探 detail 串）
 *   error         其余 HTTP 状态（端点可达但行为异常，如 404/500）——AC 只要求
 *                 前三类两两可区分，此类是附加诊断信息
 *
 * 安全：结果载荷只含状态码 / 错误码 / 延迟，绝不含密钥，也不含供应商响应体
 * （防错误网关回显 Authorization 头导致密钥泄漏到 UI/日志）。
 */
import type { ConnectivityResult } from "@morrow/protocol";
export type { ConnectivityResult };

export interface ConnectivityProbeInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function testProviderConnectivity(
  input: ConnectivityProbeInput,
  opts: { timeoutMs?: number } = {},
): Promise<ConnectivityResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${input.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 空 key 也发 Authorization 头：与 pi-adapter 行为一致（本地免密端点常见空 key）
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const latency = Date.now() - startedAt;
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const kind: "timeout" | "connect_error" = timedOut ? "timeout" : "connect_error";
    const detail = timedOut
      ? `timed out after ${timeoutMs}ms`
      : cause !== undefined
        ? `${cause.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { result: "unreachable", kind, detail, latency_ms: latency };
  }
  const latency = Date.now() - startedAt;
  if (res.status >= 200 && res.status < 300) {
    return { result: "ok", http_status: res.status, latency_ms: latency };
  }
  if (res.status === 401 || res.status === 403) {
    return { result: "auth_failed", http_status: res.status, latency_ms: latency };
  }
  return { result: "error", http_status: res.status, latency_ms: latency };
}
