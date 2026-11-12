// 会话工作区与附件 UI 纯逻辑（票 M7-A-T4 / Issue #61）：新建会话向导的三种来源、
// 分支/URL 校验、clone 确认文案、摘要标签、附件 chip 增删。组件只渲染与回调。
import type { SessionAttachment, SessionWorkspace } from "./api.ts";

export type WorkspaceSource = "local" | "github" | "none";

/** 新建会话向导的工作区草稿（session 创建前收集；分支名可空 = 服务端默认） */
export interface WorkspaceDraft {
  source: WorkspaceSource;
  localPath: string;
  repoUrl: string;
  baseBranch: string;
  newBranch: string;
}

export function emptyWorkspaceDraft(): WorkspaceDraft {
  return { source: "none", localPath: "", repoUrl: "", baseBranch: "", newBranch: "" };
}

export function validateLocalPath(raw: string): { ok: true; path: string } | { ok: false; message: string } {
  const path = raw.trim();
  if (path.length === 0) return { ok: false, message: "请填写本地项目目录" };
  if (path.includes("\u0000")) return { ok: false, message: "目录路径不能包含空字符" };
  return { ok: true, path };
}

/**
 * GitHub 仓库地址校验（只做形状校验，存在性/是否私有由 Runtime + git 判定）：
 * 接受 https://host/owner/repo(.git) 与 git@host:owner/repo(.git)；
 * 必须至少两段路径（owner/repo）。
 */
export function validateGithubUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  const url = raw.trim();
  if (url.length === 0) return { ok: false, message: "请填写 GitHub 仓库地址" };
  if (/\s/.test(url)) return { ok: false, message: "仓库地址不能包含空格" };
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
  if (scp !== null) {
    return hasOwnerRepo(scp[2]) ? { ok: true, url } : { ok: false, message: "仓库地址需包含 owner/repo" };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, message: "仅支持 https:// 或 git@host:owner/repo 形式" };
    }
    if (parsed.host.length === 0) return { ok: false, message: "仓库地址缺少主机名" };
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return hasOwnerRepo(path) ? { ok: true, url } : { ok: false, message: "仓库地址需包含 owner/repo" };
  } catch {
    return { ok: false, message: "无法识别的仓库地址" };
  }
}

function hasOwnerRepo(path: string): boolean {
  const parts = path.replace(/\.git$/i, "").split("/").filter((part) => part.length > 0);
  return parts.length >= 2;
}

/**
 * 分支名校验（与 runtime workspace.ts 的 `isValidBranchName` 同口径；
 * UI 先挡明显非法输入，服务端仍是权威校验）。
 */
export function validateBranchName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, message: "分支名不能为空" };
  if (name.length > 255) return { ok: false, message: "分支名最多 255 个字符" };
  if (
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.includes("..") ||
    name.includes("@{") ||
    name.includes("//")
  ) {
    return { ok: false, message: "分支名含有非法字符序列" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f ~^:?*[\\]/.test(name)) {
    return { ok: false, message: "分支名不能包含空格或 ~ ^ : ? * [ \\ 等字符" };
  }
  if (name.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"))) {
    return { ok: false, message: "分支名的每一段不能为空、不能以 . 开头或以 .lock 结尾" };
  }
  return { ok: true, name };
}

/** 服务端缺省分支名（`morrow/<session 前 6 位>`）；向导里作为占位提示。 */
export function defaultBranchFor(sessionId: string): string {
  return `morrow/${sessionId.slice(0, 6)}`;
}

/** 草稿 → PUT /workspace body；校验失败返回第一条可读错误。 */
export function draftToWorkspaceBody(
  draft: WorkspaceDraft,
): { ok: true; body: { kind: "none" } | { kind: "local"; path: string } | { kind: "github"; url: string; base_branch?: string; new_branch?: string } } | { ok: false; message: string } {
  if (draft.source === "none") return { ok: true, body: { kind: "none" } };
  if (draft.source === "local") {
    const path = validateLocalPath(draft.localPath);
    if (!path.ok) return path;
    return { ok: true, body: { kind: "local", path: path.path } };
  }
  const url = validateGithubUrl(draft.repoUrl);
  if (!url.ok) return url;
  if (draft.baseBranch.trim().length > 0) {
    const base = validateBranchName(draft.baseBranch);
    if (!base.ok) return { ok: false, message: `基线分支：${base.message}` };
  }
  if (draft.newBranch.trim().length > 0) {
    const branch = validateBranchName(draft.newBranch);
    if (!branch.ok) return { ok: false, message: `新分支：${branch.message}` };
  }
  return {
    ok: true,
    body: {
      kind: "github",
      url: url.url,
      ...(draft.baseBranch.trim().length === 0 ? {} : { base_branch: draft.baseBranch.trim() }),
      ...(draft.newBranch.trim().length === 0 ? {} : { new_branch: draft.newBranch.trim() }),
    },
  };
}

/** 选择 GitHub 来源时的确认文案（网络动作必须先确认；已有副本则只是关联）。 */
export function cloneConfirmMessage(url: string): string {
  return `将检查本机是否已有 ${url} 的副本；没有则会联网 clone 到 ~/.morrow/workspaces/ 下。是否继续？`;
}

/** 是否需要 clone 前确认（GitHub 来源恒确认：本地是否已有副本在服务端才知道）。 */
export function needsCloneConfirm(source: WorkspaceSource): boolean {
  return source === "github";
}

/** 会话摘要里的工作区短标签（行内空间有限；完整路径放 title）。 */
export function workspaceLabel(workspace: SessionWorkspace | undefined): string {
  if (workspace === undefined) return "";
  if (workspace.kind === "local") {
    return workspace.branch === undefined ? `本地 · ${shortPath(workspace.path)}` : `本地 · ${workspace.branch} · ${shortPath(workspace.path)}`;
  }
  const repo = repoLabel(workspace.url ?? workspace.path);
  return workspace.branch === undefined ? `GitHub · ${repo}` : `GitHub · ${repo} · ${workspace.branch}`;
}

/** 摘要 title：完整工作目录 + 基线分支。 */
export function workspaceDetail(workspace: SessionWorkspace | undefined): string {
  if (workspace === undefined) return "";
  const lines = [workspace.path];
  if (workspace.repo_path !== undefined && workspace.repo_path !== workspace.path) lines.push(`仓库：${workspace.repo_path}`);
  if (workspace.branch !== undefined) lines.push(`分支：${workspace.branch}`);
  if (workspace.base_branch !== undefined) lines.push(`基线：${workspace.base_branch}`);
  if (workspace.url !== undefined) lines.push(`来源：${workspace.url}`);
  return lines.join("\n");
}

/** 附件 chip：显示文件名（完整路径放 title）。 */
export function attachmentLabel(attachment: SessionAttachment): string {
  return attachment.name.length > 0 ? attachment.name : shortPath(attachment.path);
}

/**
 * 把输入（换行/分号/逗号分隔的路径）并入既有附件路径列表：去空、去重、保序。
 * 文件实际读取与大小校验在服务端（Runtime + WorkspaceManager）。
 */
export function addAttachmentPaths(existing: string[], raw: string): string[] {
  const next = [...existing];
  for (const part of raw.split(/[\n;]+/)) {
    const path = part.trim();
    if (path.length === 0 || next.includes(path)) continue;
    next.push(path);
  }
  return next;
}

export function removeAttachmentPath(existing: string[], path: string): string[] {
  return existing.filter((item) => item !== path);
}

/** 路径缩写：最多保留末尾两段（`/Users/me/project` → `…/me/project`）。 */
function shortPath(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/** 从仓库 URL 取 owner/repo 展示名；失败回退最后一段。 */
function repoLabel(raw: string): string {
  const cleaned = raw.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(raw);
  const path = (scp !== null ? scp[1] : cleaned).replace(/\.git$/i, "");
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] ?? raw;
}
