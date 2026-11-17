/**
 * 执行前快照与撤销（票 M7-B-T6 / Issue #70，FR-B15）。**保护范围有明确边界**。
 *
 * 这张票最容易被误读的地方是"完全权限下有快照就能回滚"。事实是：
 *   - 快照只覆盖**会话工作区**这一个目录；
 *   - `~/.ssh`、`/etc`、`~/.config`、其它项目目录、OS 凭据库、远端仓库
 *     **都不在保护范围**；
 *   - 容器内的破坏（`/workspace` 内的删除）能撤销，但容器内对 `/tmp` 的写入随
 *     容器销毁而消失（不需要撤销，也不承诺）；
 *   - 一旦脚本真的出了网或改了远端（本 Runner 默认 `--network none`，但 MCP/
 *     能力调用不走这里），撤销无能为力。
 *
 * 这些边界不是"尽力而为"，是**契约**：`SNAPSHOT_SCOPE_NOTICE` 会被原样回传并
 * 显示在 UI 上。不写清边界的"可撤销"比"没有撤销"更危险——它让人以为有保险。
 *
 * 实现：
 *   - git 仓库：`git stash create` 产出一个临时 commit 对象（**不动工作区、不动
 *      stash 栈**），撤销时 `git checkout -- .` + `git clean -fd` 后若需要可再
 *     `git stash apply <sha>`。这里只用它做"改动前状态"的锚点：撤销 = 回到 HEAD
 *     + 清掉未跟踪文件，语义上足够（会话工作区里 Agent 的改动本来就该被丢弃）。
 *     记录 `stash_sha` 是为了审计可追溯，而不是为了自动 apply。
 *   - 非 git 目录：`cp -a` 到 `.morrow/snapshots/<session>/<snapshot>`；撤销时
 *     用快照内容覆盖回去，并删掉快照之后新增的文件。
 *
 * 撤销永远是**整目录**语义（不是按文件）：一次脚本可能改动任意多个路径，
 * 挑文件撤销会把工作区留在半损坏状态。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { GitRunner } from "../workspace.ts";

/** 快照元数据（写进快照目录的 manifest.json，也回传给审计事件） */
export interface SnapshotRecord {
  snapshot_id: string;
  session_id: string;
  /** 被快照的目录（绝对路径） */
  workspace_dir: string;
  strategy: "git" | "copy";
  created_at: string;
  /** git 策略：改动前 HEAD 与 stash 提交（审计追溯用；撤销不 apply stash） */
  head?: string;
  stash_sha?: string;
  /** copy 策略：快照目录（绝对路径） */
  snapshot_dir?: string;
  /** copy 策略：文件数（诊断用） */
  file_count?: number;
}

/** 撤销结果 */
export interface RevertResult {
  snapshot_id: string;
  strategy: "git" | "copy";
  /** 恢复的文件数（copy 策略）或清理/还原的路径数（git 策略） */
  restored: number;
  /** 被删除的"快照之后新增"的文件数 */
  removed: number;
}

/** 快照失败归类（写进错误信封，便于 UI 给可操作提示） */
export class SnapshotError extends Error {
  readonly code: "snapshot_failed" | "revert_failed" | "snapshot_not_found";
  constructor(code: SnapshotError["code"], message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/**
 * 保护范围声明（原文回传 UI）。
 *
 * 规格：「撤销只承诺会话工作区，UI 明示 `~/.ssh`、`/etc` 不在保护范围」。
 */
export const SNAPSHOT_SCOPE_NOTICE =
  "快照只覆盖会话工作区（本次执行挂载为 /workspace 的目录）。" +
  "~/.ssh、/etc、其他项目目录、OS 凭据库与远端仓库都不在保护范围内——" +
  "脚本对它们的改动无法撤销。";

/** 快照目录相对工作区的位置（放在工作区内便于随工作区生命周期清理） */
export const SNAPSHOT_DIRNAME = ".morrow";

export interface SnapshotManagerOptions {
  /** 快照根（生产 `~/.morrow/snapshots`；不放在工作区内，避免被 Agent 自己删掉） */
  snapshotsRoot: string;
  /** git 子进程接缝（测试注入，零真实 git） */
  gitRunner?: GitRunner;
  /** 时钟注入（零 sleep 的测试） */
  now?: () => Date;
}

export interface SnapshotManager {
  /**
   * 为一次执行创建快照。`workspaceDir` 不存在或不可读 → SnapshotError。
   * git 仓库走 stash create，其余走 cp -a。
   */
  create(input: { sessionId: string; workspaceDir: string }): Promise<SnapshotRecord>;
  /** 撤销到某个快照（整目录语义） */
  revert(record: SnapshotRecord): Promise<RevertResult>;
  /** 读取某个快照的 manifest（不存在 → null） */
  load(sessionId: string, snapshotId: string): SnapshotRecord | null;
  /** 最近一次快照（无 → null） */
  latest(sessionId: string): SnapshotRecord | null;
}

/** 默认 git 执行器（非零退出码不 reject，与 WorkspaceManager 同口径） */
const defaultGitRunner: GitRunner = async (file, args, options = {}) => {
  return await new Promise((resolveResult) => {
    execFile(
      file,
      args,
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        timeout: options.timeout ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
        resolveResult({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
};

/** 递归统计文件数（跳过 `.git`：git 策略下它不该被当成用户内容） */
export function countFiles(dir: string, skipDotGit = false): number {
  let count = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skipDotGit && entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else count += 1;
    }
  };
  walk(dir);
  return count;
}

/** 稳定 id：时间 + 随机短串（便于按时间排序且不撞） */
function newSnapshotId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  const salt = createHash("sha256").update(`${now.getTime()}-${Math.random()}`).digest("hex").slice(0, 6);
  return `snap_${stamp}_${salt}`;
}

/** 路径必须在根目录之内（防 `../` 逃逸把快照写到别处） */
function assertInside(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  if (normalized !== normalizedRoot && !normalized.startsWith(normalizedRoot + sep)) {
    throw new SnapshotError("snapshot_failed", `path escapes snapshot root: ${candidate}`);
  }
}

export class DefaultSnapshotManager implements SnapshotManager {
  readonly #root: string;
  readonly #git: GitRunner;
  readonly #now: () => Date;

  constructor(options: SnapshotManagerOptions) {
    this.#root = resolve(options.snapshotsRoot);
    this.#git = options.gitRunner ?? defaultGitRunner;
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: { sessionId: string; workspaceDir: string }): Promise<SnapshotRecord> {
    const workspaceDir = resolve(input.workspaceDir);
    if (!existsSync(workspaceDir) || !statSync(workspaceDir).isDirectory()) {
      throw new SnapshotError("snapshot_failed", `workspace directory does not exist: ${workspaceDir}`);
    }
    const now = this.#now();
    const snapshotId = newSnapshotId(now);
    const sessionRoot = join(this.#root, input.sessionId);
    assertInside(this.#root, sessionRoot);
    mkdirSync(sessionRoot, { recursive: true });

    const isRepo = await this.#isGitRepo(workspaceDir);
    const record: SnapshotRecord = {
      snapshot_id: snapshotId,
      session_id: input.sessionId,
      workspace_dir: workspaceDir,
      strategy: isRepo ? "git" : "copy",
      created_at: now.toISOString(),
    };

    if (isRepo) {
      const head = await this.#git("git", ["rev-parse", "HEAD"], { cwd: workspaceDir });
      if (head.code !== 0) {
        // 空仓库（无 commit）：没有 HEAD 也就没有可回退的基线，退化为 copy
        record.strategy = "copy";
      } else {
        record.head = head.stdout.trim();
        // stash create 只产对象，不动工作区/不动 stash 栈——正是"快照"要的语义
        const stash = await this.#git("git", ["stash", "create"], { cwd: workspaceDir });
        if (stash.code === 0 && stash.stdout.trim().length > 0) {
          record.stash_sha = stash.stdout.trim();
        }
      }
    }

    if (record.strategy === "copy") {
      const snapshotDir = join(sessionRoot, snapshotId);
      assertInside(this.#root, snapshotDir);
      mkdirSync(snapshotDir, { recursive: true });
      try {
        // `cp -a` 语义：保留权限/时间戳/符号链接（符号链接按链接本身复制，不解引用）
        cpSync(workspaceDir, join(snapshotDir, "tree"), {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
          filter: (source) => !source.includes(`${sep}.morrow${sep}`) && !source.endsWith(`${sep}.morrow`),
        });
      } catch (error) {
        rmSync(snapshotDir, { recursive: true, force: true });
        throw new SnapshotError(
          "snapshot_failed",
          `failed to copy workspace: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      record.snapshot_dir = join(snapshotDir, "tree");
      record.file_count = countFiles(record.snapshot_dir);
    }

    writeFileSync(join(sessionRoot, `${snapshotId}.json`), JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  async revert(record: SnapshotRecord): Promise<RevertResult> {
    const workspaceDir = resolve(record.workspace_dir);
    if (!existsSync(workspaceDir)) {
      throw new SnapshotError("revert_failed", `workspace directory no longer exists: ${workspaceDir}`);
    }
    if (record.strategy === "git") {
      return await this.#revertGit(record, workspaceDir);
    }
    return await this.#revertCopy(record, workspaceDir);
  }

  load(sessionId: string, snapshotId: string): SnapshotRecord | null {
    const sessionRoot = join(this.#root, sessionId);
    assertInside(this.#root, sessionRoot);
    const file = join(sessionRoot, `${snapshotId}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as SnapshotRecord;
    } catch {
      return null;
    }
  }

  latest(sessionId: string): SnapshotRecord | null {
    const sessionRoot = join(this.#root, sessionId);
    assertInside(this.#root, sessionRoot);
    if (!existsSync(sessionRoot)) return null;
    const manifests = readdirSync(sessionRoot)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (let index = manifests.length - 1; index >= 0; index -= 1) {
      const record = this.load(sessionId, manifests[index].replace(/\.json$/, ""));
      if (record !== null) return record;
    }
    return null;
  }

  async #isGitRepo(dir: string): Promise<boolean> {
    const result = await this.#git("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return result.code === 0 && result.stdout.trim() === "true";
  }

  /**
   * git 策略撤销：回到 HEAD 并清掉未跟踪文件。
   *
   * 为什么不用 `git stash apply` 恢复 stash_sha：那个 stash 提交记录的是**改动后**
   * 的工作区状态（stash create 在改动前调用时，工作区是干净的 → 通常为空对象）。
   * 撤销的语义是"丢弃执行期间的改动"，等价于 `reset --hard HEAD` + `clean -fd`，
   * 但不用 reset（会动 HEAD/索引的副作用更广）：`checkout -- .` + `clean -fd`。
   */
  async #revertGit(record: SnapshotRecord, workspaceDir: string): Promise<RevertResult> {
    const dirtyBefore = await this.#git("git", ["status", "--porcelain"], { cwd: workspaceDir });
    const pathsBefore =
      dirtyBefore.code === 0 ? dirtyBefore.stdout.split("\n").filter((line) => line.trim().length > 0).length : 0;

    const checkout = await this.#git("git", ["checkout", "--", "."], { cwd: workspaceDir });
    if (checkout.code !== 0) {
      throw new SnapshotError(
        "revert_failed",
        `git checkout failed: ${checkout.stderr.trim().slice(-400) || `exit ${checkout.code}`}`,
      );
    }
    const clean = await this.#git("git", ["clean", "-fd"], { cwd: workspaceDir });
    if (clean.code !== 0) {
      throw new SnapshotError(
        "revert_failed",
        `git clean failed: ${clean.stderr.trim().slice(-400) || `exit ${clean.code}`}`,
      );
    }
    const removed = clean.stdout.split("\n").filter((line) => line.startsWith("Removing ")).length;
    return { snapshot_id: record.snapshot_id, strategy: "git", restored: pathsBefore, removed };
  }

  /**
   * copy 策略撤销：删除快照之后新增的条目，再用快照覆盖回去。
   *
   * 顺序很重要——先删新增（否则快照里不存在的旧文件会残留成"幽灵"），
   * 再覆盖（把改坏的已有文件还原）。
   */
  async #revertCopy(record: SnapshotRecord, workspaceDir: string): Promise<RevertResult> {
    if (record.snapshot_dir === undefined || !existsSync(record.snapshot_dir)) {
      throw new SnapshotError("snapshot_not_found", `snapshot content is missing for ${record.snapshot_id}`);
    }
    const snapshotSet = new Set(listRelativePaths(record.snapshot_dir));
    let removed = 0;
    for (const relativePath of listRelativePaths(workspaceDir)) {
      if (relativePath === SNAPSHOT_DIRNAME || relativePath.startsWith(`${SNAPSHOT_DIRNAME}${sep}`)) continue;
      if (!snapshotSet.has(relativePath)) {
        rmSync(join(workspaceDir, relativePath), { recursive: true, force: true });
        removed += 1;
      }
    }
    cpSync(record.snapshot_dir, workspaceDir, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      force: true,
    });
    return {
      snapshot_id: record.snapshot_id,
      strategy: "copy",
      restored: record.file_count ?? countFiles(record.snapshot_dir),
      removed,
    };
  }
}

/** 递归列出相对路径（目录本身也列出，便于删除整棵新增子树） */
export function listRelativePaths(root: string, skipDotMorrow = false): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skipDotMorrow && entry.name === SNAPSHOT_DIRNAME) continue;
      const full = join(current, entry.name);
      out.push(relative(root, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
