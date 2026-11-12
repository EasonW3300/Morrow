/**
 * 临时会话面板的纯逻辑（票 M7-A-T3 / Issue #60，ADR-0010）。
 *
 * 只做可测的判定与文案：作用域字符串、提升按钮门、24h 恢复窗口、禁写入类能力
 * 的提示。React 只负责装配与 I/O（node:test 直接跑本模块，无 DOM 依赖）。
 */

/** 临时会话关闭后的保留窗口（与 Runtime 的 EPHEMERAL_SESSION_TTL_MS 同口径） */
export const EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;

/** 会话 id → 记忆作用域（后端 scope 的唯一客户端构造点） */
export function ephemeralScope(sessionId: string): string {
  return `session:${sessionId}`;
}

/** `session:<id>` 形态判定（owner 与空 id 都不是临时作用域） */
export function isEphemeralScope(scope: string): boolean {
  return /^session:[^:]+$/.test(scope);
}

/** POST /v1/sessions 的临时会话请求体 */
export function createEphemeralSessionBody(): { kind: "ephemeral" } {
  return { kind: "ephemeral" };
}

/**
 * 「提升为长期记忆」按钮的禁用原因（null = 可点）。
 * 已在 owner 作用域的条目再提升没有语义，禁用并说明。
 */
export function promoteDisabledReason(scope: string): string | null {
  return isEphemeralScope(scope) ? null : "已在长期记忆（owner 作用域），无需提升";
}

/** 关闭后最晚可恢复时刻（ISO 8601 UTC） */
export function restoreDeadline(closedAt: string): string {
  return new Date(Date.parse(closedAt) + EPHEMERAL_TTL_MS).toISOString();
}

/** 当前是否仍在 24h 恢复窗口内（恰好到点即视为过期，与后端一致） */
export function canRestore(closedAt: string, now: Date): boolean {
  return now.getTime() < Date.parse(closedAt) + EPHEMERAL_TTL_MS;
}

/** 关闭后展示的提示文案（写明窗口与截止时刻） */
export function closeNotice(closedAt: string): string {
  return `临时会话已关闭：24 小时内可恢复（截止 ${restoreDeadline(closedAt)}），过期后其中的临时记忆不再出现在检索里。`;
}

/**
 * 临时会话内禁用的写入类能力入口（UI 侧禁用 + 提示；服务端另有 403 兜底）。
 * 返回每个入口的禁用原因，React 用 title/aria-description 呈现。
 */
export function ephemeralCapabilityGate(): { register: string; generate: string; write: string } {
  return {
    register: "临时会话内禁用：不能注册能力",
    generate: "临时会话内禁用：不能生成代码",
    write: "临时会话内禁用写操作（服务端返回 403）",
  };
}
