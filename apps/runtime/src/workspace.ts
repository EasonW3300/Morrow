/**
 * 会话工作区管理器（票 M7-A-T4 / Issue #61；ADR-0012）。
 *
 * 这里是「会话工作区」的全部 git/gh 副作用接缝：
 * - bindLocal：校验/解析本地项目目录（是否 git 仓库决定后续能否建分支）。
 * - cloneFrom：GitHub 仓库按 remote URL 关联已有 clone（`~/.morrow/workspaces/<repo>-<short>`），
 *   否则 clone 到该目录；私有仓库凭据优先 `gh auth token`，其次 OS 凭据库的
 *   `service=github account=pat`。
 * - ensureBranch：在基线（缺省探测 origin/HEAD，回退 main/master）上建会话分支。
 * - prepareWorktree：同仓库多会话隔离到 `~/.morrow/worktrees/sessions/<session>`。
 * - attach：只读读取会话附件（数量/大小上限见常量），**绝不写入**文件。
 * - status：分支/脏文件状态（摘要与诊断用）。
 * - uncommittedChanges / commitChanges / discardChanges：会话关闭三选一（票 M7-A-T5）。
 *   discard 是破坏性操作，**只允许本会话 worktree**（路径前缀校验），绝不对任意路径
 *   执行 `git clean`。
 *
 * 默认实现全部走 `execFile` 子进程（不引入 git 库依赖），并沿用 worktree.ts 的
 * 约定：`-c` 身份 + 环境变量双重注入（不依赖宿主 git 配置）。
 * 测试注入 `WorkspaceManager` 假实现，或注入 `execFile`/`tokenProvider` 观察真实 git 路径。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SessionAttachment } from "@morrow/protocol";
import type { SecretStore } from "./keyring.ts";

const execFileP = promisify(execFile);

/** 会话分支缺省前缀（名称 = `morrow/<session 前 6 位>`） */
export const DEFAULT_BRANCH_PREFIX = "morrow/";

/** 会话附件上限（票面要求自定并写文档；见 ADR-0012「运行边界」） */
export const ATTACHMENT_MAX_FILES = 10;
/** 单个附件最大字节数（256 KiB） */
export const ATTACHMENT_MAX_FILE_BYTES = 256 * 1024;
/** 一次注入的附件总字节上限（1 MiB） */
export const ATTACHMENT_MAX_TOTAL_BYTES = 1024 * 1024;

/** GitHub PAT 在 OS 凭据库中的位置（与渠道密钥 `service:field` 风格一致） */
export const GITHUB_SECRET_SERVICE = "github";
export const GITHUB_PAT_ACCOUNT = "pat";

/** commit 身份注入（同 worktree.ts：不依赖宿主 git 配置） */
const GIT_IDENTITY = [
  "-c", "user.name=Morrow Runtime",
  "-c", "user.email=morrow@runtime.local",
  "-c", "commit.gpgsign=false",
];

const GIT_IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Morrow Runtime",
  GIT_AUTHOR_EMAIL: "morrow@runtime.local",
  GIT_COMMITTER_NAME: "Morrow Runtime",
  GIT_COMMITTER_EMAIL: "morrow@runtime.local",
};

export type WorkspaceErrorCode =
  | "invalid_input"
  | "not_a_directory"
  | "invalid_branch"
  | "branch_exists"
  | "branch_in_use"
  | "base_not_found"
  | "clone_failed"
  | "git_failed"
  | "not_isolated"
  | "invalid_attachment"
  | "attachment_too_large";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly details?: unknown;

  constructor(code: WorkspaceErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = details;
  }
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** git/gh 子进程接缝（测试可计数/注入失败；真实实现是 execFile） */
export type GitRunner = (
  file: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<GitResult>;

export interface LocalWorkspaceBinding {
  /** 解析后的绝对目录 */
  path: string;
  /** git 仓库顶层；非 git 目录为 null */
  repoPath: string | null;
  /** 当前分支；非 git 或分离 HEAD 时为 null */
  branch: string | null;
}

export interface ClonedWorkspace {
  /** clone 或关联到的目录（主 clone） */
  path: string;
  repoPath: string;
  url: string;
  /** true = 按 remote URL 关联到本机已有副本，未发生网络动作 */
  reused: boolean;
}

export interface BranchResult {
  branch: string;
  /** 解析后的基线名 */
  base: string;
  baseCommit: string;
  /** 本次是否新建（同分支已存在会抛 branch_exists） */
  created: boolean;
}

export interface PreparedWorktree {
  dir: string;
  branch: string;
  repoPath: string;
}

export interface WorkspaceStatus {
  isRepo: boolean;
  repoPath: string | null;
  branch: string | null;
  dirtyFiles: number;
}

/** 提交结果（commit 动作）：commit id + 提交前的改动文件 */
export interface CommitResult {
  commit: string;
  files: string[];
}

/** 丢弃结果（discard 动作）：清理的文件数 + 清理前的改动文件 */
export interface DiscardResult {
  discarded: number;
  files: string[];
}

/** `attach()` 的读取结果：元数据 + 注入文本（truncated 仅在文件读取时超出单文件上限出现） */
export interface AttachmentContent extends SessionAttachment {
  content: string;
  truncated: boolean;
}

export interface WorkspaceManager {
  bindLocal(path: string): Promise<LocalWorkspaceBinding>;
  cloneFrom(url: string, options?: { baseBranch?: string }): Promise<ClonedWorkspace>;
  ensureBranch(repoPath: string, base: string | undefined, name: string): Promise<BranchResult>;
  prepareWorktree(repoPath: string, branch: string, sessionId: string): Promise<PreparedWorktree>;
  readGhToken(): Promise<string | null>;
  attach(paths: string[]): Promise<AttachmentContent[]>;
  status(repoPath: string): Promise<WorkspaceStatus>;
  /** 未提交改动（`git status --porcelain` → 路径数组；重命名两边都列出） */
  uncommittedChanges(dir: string): Promise<string[]>;
  /** 提交全部改动到当前分支（会话关闭 commit）；返回 commit id 与提交前的文件 */
  commitChanges(dir: string, message: string): Promise<CommitResult>;
  /**
   * 丢弃改动（会话关闭 discard）：`git checkout -- .` + `git clean -fd`。
   * 安全约束：`dir` 必须是本会话 worktree（`<worktreesRoot>/<sessionId>`），
   * 否则抛 not_isolated 且**不触碰**该目录。
   */
  discardChanges(sessionId: string, dir: string): Promise<DiscardResult>;
}

export interface DefaultWorkspaceManagerOptions {
  /** 受管 clone 根（生产 `~/.morrow/workspaces`） */
  workspacesRoot: string;
  /** 会话 worktree 根（生产 `~/.morrow/worktrees/sessions`） */
  worktreesRoot: string;
  /** OS 凭据库（读 `github:pat`） */
  secretStore?: SecretStore;
  /** git/gh 子进程注入（测试计数/失败路径） */
  gitRunner?: GitRunner;
  /** 覆盖 `readGhToken` 的凭据链（测试强制「无 gh 无 PAT」） */
  tokenProvider?: () => Promise<string | null>;
}

export class DefaultWorkspaceManager implements WorkspaceManager {
  readonly #workspacesRoot: string;
  readonly #worktreesRoot: string;
  readonly #secretStore: SecretStore | undefined;
  readonly #gitRunner: GitRunner;
  readonly #tokenProvider: (() => Promise<string | null>) | undefined;

  constructor(options: DefaultWorkspaceManagerOptions) {
    this.#workspacesRoot = options.workspacesRoot;
    this.#worktreesRoot = options.worktreesRoot;
    this.#secretStore = options.secretStore;
    this.#gitRunner = options.gitRunner ?? defaultGitRunner;
    this.#tokenProvider = options.tokenProvider;
  }

  /** 本地目录绑定：必须存在且为目录；是 git 仓库时回填顶层与当前分支。 */
  async bindLocal(path: string): Promise<LocalWorkspaceBinding> {
    const resolved = expandHome(path.trim());
    if (resolved.length === 0) throw new WorkspaceError("invalid_input", "path must be a non-empty string");
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      throw new WorkspaceError("not_a_directory", `path does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) throw new WorkspaceError("not_a_directory", `path is not a directory: ${resolved}`);
    const top = await this.#git(["rev-parse", "--show-toplevel"], resolved);
    if (top.code !== 0) return { path: resolved, repoPath: null, branch: null };
    const repoPath = top.stdout.trim();
    const branch = await this.#git(["branch", "--show-current"], repoPath);
    return {
      path: resolved,
      repoPath,
      branch: branch.code === 0 && branch.stdout.trim().length > 0 ? branch.stdout.trim() : null,
    };
  }

  /**
   * GitHub 仓库：先按 remote URL 在本机受管目录里找已有 clone（判定口径见
   * `normalizeRepoUrl`：协议/凭据不参与比较，`.git` 后缀与末尾斜杠忽略），
   * 找到即关联；否则 clone 到 `<workspacesRoot>/<repo>-<url短哈希>`。
   * 私有仓库用 token 时通过 `GIT_CONFIG_*` 环境变量注入 Authorization 头，
   * 不把 token 写进 argv、也不写进持久化的 remote URL。
   */
  async cloneFrom(url: string, options: { baseBranch?: string } = {}): Promise<ClonedWorkspace> {
    const normalized = normalizeRepoUrl(url);
    if (normalized === null) {
      throw new WorkspaceError("invalid_input", `not a recognizable git repository URL: ${url}`);
    }
    const existing = await this.#findCloneByRemote(normalized);
    if (existing !== null) {
      return { path: existing, repoPath: existing, url, reused: true };
    }
    const token = await this.readGhToken();
    mkdirSync(this.#workspacesRoot, { recursive: true });
    const target = this.#targetDir(url, normalized);
    const args = ["clone"];
    if (options.baseBranch !== undefined) args.push("--branch", options.baseBranch);
    args.push(url, target);
    const result = await this.#git(args, undefined, token);
    if (result.code !== 0) {
      rmSync(target, { recursive: true, force: true });
      const hint =
        token === null
          ? " If this is a private repository, add a GitHub PAT in Settings or run `gh auth login` first."
          : "";
      throw new WorkspaceError("clone_failed", `git clone failed: ${firstLine(result.stderr)}${hint}`, {
        stderr: result.stderr,
      });
    }
    return { path: target, repoPath: target, url, reused: false };
  }

  /**
   * 建会话分支：base 缺省时探测 `origin/HEAD`，回退 main → master → 当前 HEAD。
   * 同名分支已存在抛 branch_exists（HTTP 409），不覆盖、不复用。
   */
  async ensureBranch(repoPath: string, base: string | undefined, name: string): Promise<BranchResult> {
    if (!isValidBranchName(name)) {
      throw new WorkspaceError("invalid_branch", `invalid git branch name: ${name}`);
    }
    const resolvedBase = base === undefined || base.trim().length === 0
      ? await this.#defaultBase(repoPath)
      : base.trim();
    const baseCommit = await this.#resolveCommit(repoPath, resolvedBase);
    if (baseCommit === null) {
      throw new WorkspaceError("base_not_found", `baseline branch "${resolvedBase}" is not resolvable in ${repoPath}`);
    }
    const exists = await this.#git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repoPath);
    if (exists.code === 0) {
      throw new WorkspaceError("branch_exists", `branch "${name}" already exists in ${repoPath}`);
    }
    const created = await this.#git(["branch", name, baseCommit], repoPath);
    if (created.code !== 0) {
      throw new WorkspaceError("git_failed", `git branch failed: ${firstLine(created.stderr)}`, {
        stderr: created.stderr,
      });
    }
    return { branch: name, base: resolvedBase, baseCommit, created: true };
  }

  /**
   * 会话 worktree：`<worktreesRoot>/<sessionId>`。目录已是有效 worktree 则复用（重绑
   * 不丢工作）；同分支被其它 worktree 占用时抛 branch_in_use 并给出持有目录。
   */
  async prepareWorktree(repoPath: string, branch: string, sessionId: string): Promise<PreparedWorktree> {
    if (!isValidBranchName(branch)) {
      throw new WorkspaceError("invalid_branch", `invalid git branch name: ${branch}`);
    }
    if (sessionId.trim().length === 0) {
      throw new WorkspaceError("invalid_input", "sessionId must be a non-empty string");
    }
    const dir = join(this.#worktreesRoot, sessionId);
    if (existsSync(dir)) {
      const inside = await this.#git(["rev-parse", "--is-inside-work-tree"], dir);
      if (inside.code === 0 && inside.stdout.trim() === "true") {
        await this.#git(["checkout", branch], dir);
        return { dir, branch, repoPath };
      }
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(this.#worktreesRoot, { recursive: true });
    const add = await this.#git(["worktree", "add", dir, branch], repoPath);
    if (add.code !== 0) {
      // git 措辞随版本变化：旧版 "is already checked out at '<dir>'"，
      // 2.50+ "is already used by worktree at '<dir>'"——两种都识别。
      const holder =
        /already checked out at ['"]([^'"]+)['"]/.exec(add.stderr)?.[1] ??
        /already used by worktree at ['"]([^'"]+)['"]/.exec(add.stderr)?.[1];
      if (holder !== undefined) {
        throw new WorkspaceError(
          "branch_in_use",
          `branch "${branch}" is already checked out at ${holder}; use another branch name`,
          { holder },
        );
      }
      throw new WorkspaceError("git_failed", `git worktree add failed: ${firstLine(add.stderr)}`, {
        stderr: add.stderr,
      });
    }
    return { dir, branch, repoPath };
  }

  /** 凭据链：`gh auth token` → OS 凭据库 `github:pat` → null（HTTP 层给出可操作提示）。 */
  async readGhToken(): Promise<string | null> {
    if (this.#tokenProvider !== undefined) return this.#tokenProvider();
    const gh = await this.#gitRunner("gh", ["auth", "token"], { timeout: 10_000 });
    if (gh.code === 0) {
      const token = gh.stdout.trim();
      if (token.length > 0) return token;
    }
    if (this.#secretStore !== undefined) {
      const pat = await this.#secretStore.getSecret(GITHUB_SECRET_SERVICE, GITHUB_PAT_ACCOUNT);
      if (pat !== null && pat.trim().length > 0) return pat.trim();
    }
    return null;
  }

  /** 只读附件读取（去重、去 ~、上限校验；不写入）。 */
  async attach(paths: string[]): Promise<AttachmentContent[]> {
    const unique = [...new Set(paths.map((path) => expandHome(path.trim())).filter((path) => path.length > 0))];
    if (unique.length > ATTACHMENT_MAX_FILES) {
      throw new WorkspaceError(
        "attachment_too_large",
        `too many attachments: ${unique.length} (max ${ATTACHMENT_MAX_FILES} per session)`,
      );
    }
    const out: AttachmentContent[] = [];
    let total = 0;
    for (const path of unique) {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        throw new WorkspaceError("invalid_attachment", `attachment does not exist: ${path}`);
      }
      if (!stat.isFile()) throw new WorkspaceError("invalid_attachment", `attachment is not a file: ${path}`);
      const declaredSize = stat.size;
      if (declaredSize > ATTACHMENT_MAX_FILE_BYTES) {
        throw new WorkspaceError(
          "attachment_too_large",
          `attachment exceeds ${ATTACHMENT_MAX_FILE_BYTES} bytes: ${path}`,
        );
      }
      total += declaredSize;
      if (total > ATTACHMENT_MAX_TOTAL_BYTES) {
        throw new WorkspaceError(
          "attachment_too_large",
          `attachments exceed ${ATTACHMENT_MAX_TOTAL_BYTES} bytes in total`,
        );
      }
      const buffer = readFileSync(path);
      if (buffer.includes(0)) {
        throw new WorkspaceError("invalid_attachment", `attachment looks binary (contains NUL bytes): ${path}`);
      }
      out.push({
        path,
        name: basename(path),
        size: buffer.length,
        content: buffer.toString("utf8"),
        truncated: false,
      });
    }
    return out;
  }

  /** 工作区状态（诊断/摘要用；非 git 目录 isRepo=false）。 */
  async status(repoPath: string): Promise<WorkspaceStatus> {
    const top = await this.#git(["rev-parse", "--show-toplevel"], repoPath);
    if (top.code !== 0) return { isRepo: false, repoPath: null, branch: null, dirtyFiles: 0 };
    const resolvedRoot = top.stdout.trim();
    const branch = await this.#git(["branch", "--show-current"], resolvedRoot);
    const porcelain = await this.#git(["status", "--porcelain"], resolvedRoot);
    return {
      isRepo: true,
      repoPath: resolvedRoot,
      branch: branch.code === 0 && branch.stdout.trim().length > 0 ? branch.stdout.trim() : null,
      dirtyFiles: porcelain.code === 0 ? porcelain.stdout.split("\n").filter((line) => line.trim().length > 0).length : 0,
    };
  }

  /** 未提交改动路径（会话关闭三选一的 409 文件列表 / commit / discard 预览）。 */
  async uncommittedChanges(dir: string): Promise<string[]> {
    const porcelain = await this.#git(["status", "--porcelain"], dir);
    if (porcelain.code !== 0) {
      throw new WorkspaceError("git_failed", `git status failed: ${firstLine(porcelain.stderr)}`, {
        stderr: porcelain.stderr,
      });
    }
    return parsePorcelainPaths(porcelain.stdout);
  }

  /** 提交全部改动（含未跟踪文件）到当前分支；身份由 GIT_IDENTITY 注入。 */
  async commitChanges(dir: string, message: string): Promise<CommitResult> {
    const files = await this.uncommittedChanges(dir);
    if (files.length === 0) {
      const head = await this.#git(["rev-parse", "HEAD"], dir);
      if (head.code === 0) return { commit: head.stdout.trim(), files: [] };
      throw new WorkspaceError("git_failed", "cannot resolve HEAD for an empty commit", { dir });
    }
    const add = await this.#git(["add", "-A"], dir);
    if (add.code !== 0) {
      throw new WorkspaceError("git_failed", `git add failed: ${firstLine(add.stderr)}`, { stderr: add.stderr });
    }
    const commit = await this.#git(["commit", "-m", message], dir);
    if (commit.code !== 0) {
      throw new WorkspaceError("git_failed", `git commit failed: ${firstLine(commit.stderr)}`, {
        stderr: commit.stderr,
      });
    }
    const head = await this.#git(["rev-parse", "HEAD"], dir);
    if (head.code !== 0) {
      throw new WorkspaceError("git_failed", `git rev-parse HEAD failed: ${firstLine(head.stderr)}`, {
        stderr: head.stderr,
      });
    }
    return { commit: head.stdout.trim(), files };
  }

  /**
   * 丢弃改动：先做路径归属校验（`<worktreesRoot>/<sessionId>`，并解析符号链接），
   * 再 `git checkout -- .` + `git clean -fd`。伪造/他人目录抛 not_isolated，目录不动。
   */
  async discardChanges(sessionId: string, dir: string): Promise<DiscardResult> {
    const root = resolve(this.#worktreesRoot);
    const expected = resolve(root, sessionId);
    const actual = resolve(dir);
    // 严格前缀：父目录必须是 worktreesRoot、目录名必须等于 sessionId——
    // 同时挡住 `../` 穿越与「同根下的他人会话目录」。
    if (dirname(expected) !== root || basename(expected) !== sessionId || actual !== expected) {
      throw new WorkspaceError(
        "not_isolated",
        `refusing to discard in ${actual}: only this session's worktree (${expected}) may be cleaned`,
        { expected, actual },
      );
    }
    // 符号链接兜底：两边都存在时要求 realpath 一致（防止 worktree 目录被替换成指向别处的链接）
    try {
      if (realpathSync(actual) !== realpathSync(expected)) {
        throw new WorkspaceError(
          "not_isolated",
          `refusing to discard in ${actual}: it resolves outside this session's worktree`,
          { expected, actual },
        );
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      // 目录不存在：交给 git 报错（下面的 uncommittedChanges 会失败）
    }
    const files = await this.uncommittedChanges(actual);
    const checkout = await this.#git(["checkout", "--", "."], actual);
    if (checkout.code !== 0) {
      throw new WorkspaceError("git_failed", `git checkout failed: ${firstLine(checkout.stderr)}`, {
        stderr: checkout.stderr,
      });
    }
    const clean = await this.#git(["clean", "-fd"], actual);
    if (clean.code !== 0) {
      throw new WorkspaceError("git_failed", `git clean failed: ${firstLine(clean.stderr)}`, {
        stderr: clean.stderr,
      });
    }
    return { discarded: files.length, files };
  }

  // --- 内部 -----------------------------------------------------------------

  async #findCloneByRemote(normalizedUrl: string): Promise<string | null> {
    if (!existsSync(this.#workspacesRoot)) return null;
    for (const entry of readdirSync(this.#workspacesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.#workspacesRoot, entry.name);
      const remote = await this.#git(["remote", "get-url", "origin"], dir);
      if (remote.code !== 0) continue;
      if (normalizeRepoUrl(remote.stdout.trim()) === normalizedUrl) return dir;
    }
    return null;
  }

  #targetDir(url: string, normalizedUrl: string): string {
    const repo = repoNameFromUrl(url);
    const short = createHash("sha1").update(normalizedUrl).digest("hex").slice(0, 6);
    let candidate = join(this.#workspacesRoot, `${repo}-${short}`);
    let suffix = 2;
    while (existsSync(candidate)) {
      candidate = join(this.#workspacesRoot, `${repo}-${short}-${suffix}`);
      suffix += 1;
    }
    return candidate;
  }

  async #defaultBase(repoPath: string): Promise<string> {
    const symbolic = await this.#git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoPath);
    if (symbolic.code === 0) {
      const ref = symbolic.stdout.trim(); // 通常 origin/main
      if (ref.length > 0) return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    }
    for (const candidate of ["main", "master", "trunk"]) {
      if ((await this.#resolveCommit(repoPath, candidate)) !== null) return candidate;
    }
    const head = await this.#git(["rev-parse", "--verify", "HEAD"], repoPath);
    if (head.code === 0) return "HEAD";
    throw new WorkspaceError("base_not_found", `cannot determine a baseline branch in ${repoPath}`);
  }

  async #resolveCommit(repoPath: string, ref: string): Promise<string | null> {
    for (const candidate of [ref, `refs/heads/${ref}`, `origin/${ref}`, `refs/remotes/origin/${ref}`]) {
      const resolved = await this.#git(["rev-parse", "--verify", `${candidate}^{commit}`], repoPath);
      if (resolved.code === 0) return resolved.stdout.trim();
    }
    return null;
  }

  async #git(args: string[], cwd?: string, token?: string | null): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_IDENTITY_ENV };
    if (token !== null && token !== undefined && token.length > 0) {
      // 用 GIT_CONFIG_* 注入而非 argv：token 不出现在进程命令行，也不进 remote URL。
      const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraHeader";
      env.GIT_CONFIG_VALUE_0 = header;
    }
    return this.#gitRunner("git", [...GIT_IDENTITY, ...args], { cwd, env, timeout: 120_000 });
  }
}

/** 默认子进程实现（非零退出码不 reject，返回 code/stderr）。 */
export const defaultGitRunner: GitRunner = async (file, args, options = {}) => {
  try {
    const { stdout, stderr } = await execFileP(file, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      timeout: options.timeout ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
};

/**
 * 仓库地址归一化（「本地已有 clone 就关联」的判定口径）：
 * - `git@host:owner/repo.git` / `ssh://git@host/owner/repo.git` / `https://host/owner/repo.git`
 *   统一为 `host/owner/repo`（协议、凭据、`.git` 后缀、末尾斜杠都不参与比较）；
 * - host 小写（DNS 不区分大小写），路径保留大小写（GitHub owner/repo 事实上不区分，
 *   但保留原样避免把两个不同远端误判为同一个）。
 * 无法识别返回 null。
 */
export function normalizeRepoUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0) return null;
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
  if (scp !== null && !url.includes("://")) {
    return canonicalRemote(scp[1], scp[2]);
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return canonicalRemote("", parsed.pathname);
    if (parsed.host.length === 0) return null;
    return canonicalRemote(parsed.host.toLowerCase(), parsed.pathname);
  } catch {
    return null;
  }
}

function canonicalRemote(host: string, path: string): string {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return host.length === 0 ? `file/${trimmed}` : `${host}/${trimmed}`;
}

/** 仓库名（clone 目标前缀）：URL 最后一段，去掉 .git，非字母数字替换为 -。 */
export function repoNameFromUrl(raw: string): string {
  const withoutQuery = raw.trim().split(/[?#]/)[0].replace(/\/+$/, "");
  const last = withoutQuery.split(/[/:]/).filter((part) => part.length > 0).pop() ?? "repo";
  const name = last.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name.length > 0 ? name : "repo";
}

/** 会话分支缺省名：`morrow/<session 前 6 位>`。 */
export function defaultBranchForSession(sessionId: string): string {
  return `${DEFAULT_BRANCH_PREFIX}${sessionId.slice(0, 6)}`;
}

/**
 * git 分支名合法性（`git check-ref-format --branch` 的纯函数子集）：
 * 非空、≤255、不以 `-` 或 `/` 开头、不以 `/` 或 `.` 结尾、无 `..`/`@{`/
 * `~^:?*[\\`/空白/控制字符、无连续 `/`、每段不以 `.` 开头且不以 `.lock` 结尾。
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f ~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

/** `~` / `~/x` 展开（UI 传入；不做任意变量展开）。 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * `git status --porcelain` 输出 → 路径数组。
 * 每行格式为 `XY <path>`（XY 两位状态 + 空格）；重命名/复制为 `XY old -> new`，
 * 两边都返回（`discard` 的文件数按行计，与 `git clean -fd` 的行为一致）。
 * git 对特殊字符路径会加双引号并做 C 风格转义，能 JSON 解析时还原。
 */
export function parsePorcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.trim().length === 0) continue;
    let rest = raw.length >= 3 ? raw.slice(3) : raw.trim();
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) {
      paths.push(decodePorcelainPath(rest.slice(0, arrow)), decodePorcelainPath(rest.slice(arrow + 4)));
    } else {
      paths.push(decodePorcelainPath(rest));
    }
  }
  return paths;
}

function decodePorcelainPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim().length > 0);
  return (line ?? "unknown git error").trim();
}
