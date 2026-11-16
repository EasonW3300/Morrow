/**
 * 记忆页纯逻辑（票 M7-A-T6 / Issue #62）。
 *
 * 只做可测的展示判定：视图切换、kind/敏感等级标签、时间格式化、展开状态、版本链、
 * 来源回链跳转目标（会话归档/删除给提示而非报错）、分页文案、打开目录提示。
 * React 只负责装配与 I/O（node:test 直接跑本模块，无 DOM 依赖）。
 *
 * 页面只读：本模块不提供任何写操作（改名/编辑/删除入口都不存在）。
 */

export type MemoryOverviewView = "tree" | "timeline";

/** 与 GET /v1/memory/overview 条目同构（api.ts 定义并复用） */
export interface MemorySourceView {
  event_id: string;
  session_id: string | null;
  occurred_at: string;
}

export interface MemoryRevisionView {
  version: number;
  createdAt: string;
  reason: string | null;
  sourceEventId: string | null;
}

export interface MemoryEntryView {
  id: string;
  content: string;
  kind: string;
  sensitivity: string;
  version: number;
  scope: string;
  occurred_at: string;
  createdAt: string;
  updatedAt: string;
  revisions: number[];
  revision_history: MemoryRevisionView[];
  sources: MemorySourceView[];
}

/** 来源跳转需要的会话最小视图（SessionSummary 的结构子集） */
export interface SessionRef {
  session_id: string;
  archived_at?: string | null;
  deleted_at?: string | null;
}

export type SourceJumpTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "unavailable"; reason: "archived" | "deleted" | "missing" | "no_session"; hint: string };

export function overviewViewLabel(view: MemoryOverviewView): string {
  return view === "tree" ? "树视图" : "时间线";
}

const KIND_LABELS: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  profile: "画像",
  procedural: "操作经验",
};

const SENSITIVITY_LABELS: Record<string, string> = {
  public: "公开",
  private: "私有",
  locked: "锁定",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function sensitivityLabel(sensitivity: string): string {
  return SENSITIVITY_LABELS[sensitivity] ?? sensitivity;
}

/**
 * 时间展示：统一转 UTC `YYYY-MM-DD HH:mm`（不依赖运行机器的本地时区，
 * UI 单测可跨时区稳定断言）。非法时间原样返回。
 */
export function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** 条目摘要：类型 · 敏感等级 · 版本 */
export function entryMeta(entry: MemoryEntryView): string {
  return `${kindLabel(entry.kind)} · ${sensitivityLabel(entry.sensitivity)} · v${entry.version}`;
}

/**
 * 版本链文案：v1 是隐式起点（事实创建不落 revision），修订版本号去重升序。
 * 无修订时明确标注，避免误读成「没有历史」。
 */
export function revisionChainLabel(entry: MemoryEntryView): string {
  const versions = [...new Set([1, ...entry.revisions])].filter((version) => Number.isInteger(version) && version >= 1).sort((a, b) => a - b);
  const chain = versions.map((version) => `v${version}`).join(" → ");
  return versions.length <= 1 ? `版本链 ${chain}（无修订）` : `版本链 ${chain}`;
}

/** 展开状态（字符串数组便于序列化与深比较；不修改入参） */
export function toggleExpanded(expanded: readonly string[], entryId: string): string[] {
  return expanded.includes(entryId) ? expanded.filter((id) => id !== entryId) : [...expanded, entryId];
}

export function isExpanded(expanded: readonly string[], entryId: string): boolean {
  return expanded.includes(entryId);
}

/** 簇标签：主题词元；无主题时用 1 基序号的稳定兜底名 */
export function clusterLabel(theme: string | null, index: number): string {
  return theme ?? `未归类 ${index + 1}`;
}

/**
 * 来源回链跳转目标。会话已归档/已删除/已不可用都返回 unavailable + 可读提示——
 * 页面不抛错、不弹窗报错，只在来源行下展示原因。
 */
export function sourceJumpTarget(source: MemorySourceView, sessions: readonly SessionRef[]): SourceJumpTarget {
  if (source.session_id === null) {
    return {
      kind: "unavailable",
      reason: "no_session",
      hint: "该来源不是来自某个会话（例如受控导入），没有可跳转的原始消息。",
    };
  }
  const session = sessions.find((item) => item.session_id === source.session_id);
  if (session === undefined) {
    return { kind: "unavailable", reason: "missing", hint: "原会话已不可用（可能已过期清理），无法跳转到原始消息。" };
  }
  if (session.deleted_at !== undefined && session.deleted_at !== null) {
    return { kind: "unavailable", reason: "deleted", hint: "原会话已删除（30 天后不可恢复），无法跳转到原始消息。" };
  }
  if (session.archived_at !== undefined && session.archived_at !== null) {
    return {
      kind: "unavailable",
      reason: "archived",
      hint: "原会话已归档，请先在设置中恢复归档后再查看原始消息。",
    };
  }
  return { kind: "session", sessionId: session.session_id };
}

/** 来源提示（null = 可跳转，无需提示） */
export function sourceJumpHint(source: MemorySourceView, sessions: readonly SessionRef[]): string | null {
  const target = sourceJumpTarget(source, sessions);
  return target.kind === "session" ? null : target.hint;
}

/** 分页文案：1 基区间 + 总数；空页/越界只报总数 */
export function pagerLabel(total: number, limit: number, offset: number): string {
  if (total <= 0 || offset >= total) return `共 ${total} 条`;
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  return `第 ${start}–${end} 条，共 ${total} 条`;
}

/** scope 选择项：owner 恒在；有活动会话时追加 session:<id>（owner ∪ 该会话） */
export function scopeOptions(activeSessionId: string | null): Array<{ value: string; label: string }> {
  const options = [{ value: "owner", label: "长期记忆（owner）" }];
  if (activeSessionId !== null && activeSessionId.length > 0) {
    options.push({ value: `session:${activeSessionId}`, label: "当前会话（含长期记忆）" });
  }
  return options;
}

/** 「打开记忆文件目录」提示：路径可见；目录尚未生成时说明先投影 */
export function openDirectoryHint(directory: string | null): string {
  return directory === null || directory.length === 0
    ? "记忆文件目录尚未生成（先执行一次记忆投影）。"
    : `记忆文件目录：${directory}`;
}
