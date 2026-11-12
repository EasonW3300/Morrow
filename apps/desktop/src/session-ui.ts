// 会话元数据 UI 纯逻辑（票 M7-A-T2 / Issue #59）：菜单状态机、动作集合、
// 标题校验、删除确认文案与 30 天恢复窗口。组件只做渲染与回调，判定都在这里。
import type { SessionSummary } from "./api.ts";

export const SESSION_TITLE_MAX = 120;
export const SESSION_RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SessionState = "active" | "archived" | "deleted";

export function sessionState(
  session: Pick<SessionSummary, "archived_at" | "deleted_at">,
): SessionState {
  if (session.deleted_at !== undefined) return "deleted";
  if (session.archived_at !== undefined) return "archived";
  return "active";
}

export type SessionActionId = "rename" | "archive" | "unarchive" | "delete" | "restore";

export interface SessionAction {
  id: SessionActionId;
  label: string;
  danger?: boolean;
}

/** 会话行内菜单/右键菜单的动作集合（按状态）。 */
export function sessionActions(
  session: Pick<SessionSummary, "archived_at" | "deleted_at">,
): SessionAction[] {
  switch (sessionState(session)) {
    case "active":
      return [
        { id: "rename", label: "重命名" },
        { id: "archive", label: "归档" },
        { id: "delete", label: "删除", danger: true },
      ];
    case "archived":
      return [
        { id: "rename", label: "重命名" },
        { id: "unarchive", label: "取消归档" },
        { id: "delete", label: "删除", danger: true },
      ];
    case "deleted":
      return [{ id: "restore", label: "恢复" }];
  }
}

/** 会话菜单状态机：同一时刻只开一个（行内「⋯」与右键共用）。 */
export interface SessionMenuState {
  openFor: string | null;
}

export const closedSessionMenu: SessionMenuState = { openFor: null };

export function openSessionMenu(_state: SessionMenuState, sessionId: string): SessionMenuState {
  return { openFor: sessionId };
}

export function toggleSessionMenu(state: SessionMenuState, sessionId: string): SessionMenuState {
  return { openFor: state.openFor === sessionId ? null : sessionId };
}

export function closeSessionMenu(): SessionMenuState {
  return closedSessionMenu;
}

/** 标题校验：trim 后非空且 ≤120（与端点校验保持一致）。 */
export function validateSessionTitle(
  raw: string,
): { ok: true; title: string } | { ok: false; message: string } {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, message: "标题不能为空" };
  if (title.length > SESSION_TITLE_MAX) {
    return { ok: false, message: `标题最多 ${SESSION_TITLE_MAX} 个字符` };
  }
  return { ok: true, title };
}

export function deleteSessionConfirmTitle(): string {
  return "删除这个会话？";
}

/** 删除二次确认文案：必须写明记忆不受影响、30 天内可恢复（票面硬要求）。 */
export function deleteSessionConfirmMessage(): string {
  return "删除后对话记录会从主列表消失；记忆不受影响，30 天内可在「设置 → 会话管理」恢复。";
}

/** 恢复截止时间（deleted_at + 30d；与 runtime 折叠判定同口径）。 */
export function restoreDeadline(deletedAt: string): Date {
  return new Date(Date.parse(deletedAt) + SESSION_RESTORE_WINDOW_MS);
}

export function canRestore(deletedAt: string, now: number = Date.now()): boolean {
  const deadline = Date.parse(deletedAt);
  if (Number.isNaN(deadline)) return false;
  return deadline + SESSION_RESTORE_WINDOW_MS > now;
}

/** 设置页展示的剩余恢复窗口文案。 */
export function describeRestoreWindow(deletedAt: string, now: number = Date.now()): string {
  const deadline = Date.parse(deletedAt);
  if (Number.isNaN(deadline)) return "删除时间未知";
  const remaining = deadline + SESSION_RESTORE_WINDOW_MS - now;
  if (remaining <= 0) return "已过 30 天恢复期";
  const days = Math.ceil(remaining / DAY_MS);
  return `还剩 ${days} 天可恢复`;
}
