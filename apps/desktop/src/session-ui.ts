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

export type SessionActionId = "rename" | "archive" | "unarchive" | "close" | "delete" | "restore";

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
        { id: "close", label: "关闭会话" },
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

// --- 会话关闭三选一（票 M7-A-T5 / Issue #63）--------------------------------

export type UncommittedChoice = "commit" | "keep" | "discard";

export interface UncommittedOption {
  id: UncommittedChoice;
  label: string;
  description: string;
  /** discard 是破坏性操作（UI 用 danger 样式 + 二次确认） */
  danger?: boolean;
}

/** 三选一对话框的选项顺序与文案（提交 / 保留 / 丢弃）。 */
export function uncommittedOptions(): UncommittedOption[] {
  return [
    { id: "commit", label: "提交到本分支", description: "把改动提交到会话分支后再关闭" },
    { id: "keep", label: "保留工作区", description: "关闭会话，但保留所有未提交改动" },
    {
      id: "discard",
      label: "丢弃改动",
      description: "执行 checkout + clean，不可撤销",
      danger: true,
    },
  ];
}

/** 409 的 code 是否为「有未提交改动」。 */
export function isUncommittedConflict(code: string | undefined): boolean {
  return code === "uncommitted_changes";
}

/** 从错误信封 details 提取改动文件列表（缺失/非法 → 空数组）。 */
export function uncommittedFiles(details: Record<string, unknown> | undefined): string[] {
  const files = details?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function closeUncommittedTitle(): string {
  return "会话有未提交改动";
}

/** 三选一对话框的说明文案：绝不静默丢弃。 */
export function closeUncommittedMessage(files: string[]): string {
  return `关闭前请选择如何处理这 ${files.length} 个改动文件；未提供选择时不会关闭。`;
}

/** discard 二次确认文案：必须红字警示「将丢弃这些改动」。 */
export function discardConfirmTitle(): string {
  return "丢弃这些改动？";
}

export function discardWarning(files: string[]): string {
  const shown = files.slice(0, 8);
  const rest = files.length - shown.length;
  const list = shown.map((file) => `• ${file}`).join("\n");
  return `将丢弃这些改动（${files.length} 个文件），此操作不可撤销：\n${list}${
    rest > 0 ? `\n… 还有 ${rest} 个文件` : ""
  }`;
}
