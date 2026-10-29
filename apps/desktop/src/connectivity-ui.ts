/**
 * 连通性结果的 UI 归类（票 T7 / Issue #8）。
 *
 * runtime `POST /v1/providers/:id/test` 返回四类结果（apps/runtime/src/connectivity.ts）：
 *   ok / auth_failed / unreachable / error
 * 本模块把它归类为 Owner 可读呈现：tone（绿/橙/红）、标题、解释、下一步建议。
 * 纯函数，无 DOM / fetch 依赖；文案不携带密钥相关信息（载荷本身就没有，见 T5 密钥安全不变量）。
 */

export type { ConnectivityResult } from "./api.ts";
import type { ConnectivityResult } from "./api.ts";

/** UI 归类：tone 决定颜色档（绿=可用，橙=环境问题，红=配置必须改），advice 是下一步动作 */
export interface ConnectivityPresentation {
  tone: "ok" | "warn" | "error";
  title: string;
  explanation: string;
  advice: string;
}

export function describeConnectivity(result: ConnectivityResult): ConnectivityPresentation {
  switch (result.result) {
    case "ok":
      return {
        tone: "ok",
        title: `连通正常（HTTP ${result.http_status}，${result.latency_ms}ms）`,
        explanation: "端点按 OpenAI 兼容协议应答成功，密钥与模型名均被接受。",
        advice: "可以把该 Provider 设为默认，并新建会话开始使用。",
      };
    case "auth_failed":
      return {
        tone: "error",
        title: `认证失败（HTTP ${result.http_status}）`,
        explanation: "端点可达，但拒绝了请求的密钥：API Key 无效、过期，或无权访问该模型。",
        advice: "核对 API Key 是否正确、是否有该模型权限；在「编辑」里重新粘贴密钥并保存（保存后密钥只进系统凭据库，不再回显）。",
      };
    case "unreachable":
      return {
        tone: "warn",
        title: "网络不可达",
        explanation: isTimeout(result.detail)
          ? `连接超时：${result.detail}。端点地址可能写错（请求黑洞），或服务响应过慢。`
          : `连接未能建立：${result.detail}。端点地址可能写错，或服务未启动。`,
        advice: "核对 base_url 的主机与端口是否正确、服务是否已启动、本机是否能访问；若使用代理，确认代理放行该地址。",
      };
    case "error":
      return {
        tone: "error",
        title: `服务错误（HTTP ${result.http_status}）`,
        explanation: "端点可达，但对测试请求返回了异常状态——地址指向的服务不是预期的 OpenAI 兼容端点，或该模型不存在。",
        advice: "确认 base_url 指向支持 POST /chat/completions 的 OpenAI 兼容端点，并核对模型名是否存在于该服务。",
      };
  }
}

function isTimeout(detail: string): boolean {
  return /timed out|timeout|abort/i.test(detail);
}
