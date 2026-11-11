/**
 * Chat 发送错误的可读呈现（M6-T2 / Issue #53 走查修复）。
 *
 * 背景：无 Provider 时 Runtime 返回 503 provider_not_configured，原始消息只给出
 * `POST /v1/providers` 与 env 变量——浏览器里的 Owner 需要一条可执行的 UI 路径。
 * 这里把错误码映射成「可读标题 + 原文 + 是否给出设置页入口」，React 只做装配。
 * 纯函数，无 DOM 依赖（node:test 直接跑）。
 */

export interface SendErrorView {
  /** 可读标题（错误码已翻译） */
  title: string;
  /** 服务端原文（保留细节，便于排查） */
  detail: string;
  /** 是否显示「去设置 → Provider 与模型」入口 */
  openSettings: boolean;
}

export function describeSendError(code: string, message: string): SendErrorView {
  return {
    title: readableCode(code),
    detail: message,
    // 只有「没配 Provider」有明确的设置页落点；其余错误给原文即可
    openSettings: code === "provider_not_configured",
  };
}

function readableCode(code: string): string {
  switch (code) {
    case "provider_not_configured":
      return "尚未配置模型 Provider";
    case "invalid_body":
      return "请求体非法";
    case "not_found":
      return "会话不存在";
    case "http_503":
      return "Runtime 拒绝服务";
    default:
      return "请求失败";
  }
}
