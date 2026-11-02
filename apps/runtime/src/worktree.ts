/**
 * Git Worktree 管理器（票 M2-T4 / Issue #25，PRD §4.3 FR-TASK-8「同项目子 Agent 用
 * Git Worktree 隔离，合并前冲突检测」、§4.7 FR-EVO-2「至少两个隔离 Worker 并行+合并验证」）。
 *
 * 职责：代码任务节点的工作区生命周期——
 * - prepare：节点执行前在主区仓库上建独立 worktree（独立目录 + 独立分支
 *   `morrow/<task_id>/<node_key>`，起点 = 基线提交）。幂等：同任务同节点复用同一
 *   目录，并把上一次尝试的脏状态重置回基线（retry 拿到干净起点）。
 * - collectChanges：节点成功后收集相对基线的变更文件与内容（porcelain 状态 + 内容）。
 * - commitChanges：变更提交到 worktree 分支（空变更不产生提交）。
 * - mergeToBase：把 worktree 分支合回主区——先做冲突检测（git merge --no-commit
 *   试合并，冲突即 abort，主区不受污染），无冲突 → 合并验证（节点声明的 verify 命令
 *   在主区目录执行；未声明时以「合并 diff 非空」为最低验证）→ 验证失败回滚合并。
 * - cleanup / sweepStale：worktree 移除 + 分支删除 + 主区 prune；启动时按任务归属
 *   清扫崩溃残留（进程死亡留下的目录与分支）。
 *
 * 全部 git 操作走子进程（execFile），不引入 git 库依赖；身份以 -c 注入（不依赖宿主
 * git 配置）。合并的跨节点串行化在调度器侧按仓库路径加互斥（见 scheduler.ts）——
 * 本模块只保证单次 mergeToBase 的原子性（试合并 → 验证/回滚 → 提交）。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** commit 身份注入（不依赖宿主 git 配置；gpgsign 显式关闭保证确定性） */
const GIT_IDENTITY = [
  "-c", "user.name=Morrow Runtime",
  "-c", "user.email=morrow@runtime.local",
  "-c", "commit.gpgsign=false",
];

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export type WorktreeErrorCode = "not_a_repo" | "git_failed" | "invalid_record";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly details?: unknown;

  constructor(code: WorktreeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
    this.details = details;
  }
}

/** 一个节点工作区的完整证据（prepare 产出，merge/cleanup 消费） */
export interface WorktreeRecord {
  taskId: string;
  nodeId: string;
  key: string;
  /** 主区仓库顶层（rev-parse --show-toplevel 解析；merge/cleanup 的 git cwd） */
  repoPath: string;
  /** worktree 检出目录（节点 Agent 的工作目录） */
  dir: string;
  /** 专属分支：morrow/<task_id>/<node_key> */
  branch: string;
  /** 基线提交（diff/合并基准；prepare 时刻的基线分支头或 HEAD） */
  base: string;
  createdAt: string;
}

export interface WorktreePrepareInput {
  repoPath: string;
  taskId: string;
  nodeId: string;
  key: string;
  /** 基线分支名；缺省 = 主区当前 HEAD */
  branch?: string;
}

/** 相对基线的变更文件（content = 变更后内容；deleted 为 null） */
export interface WorktreeFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  content: string | null;
}

/**
 * 合并结果：ok=true 带合并提交与文件清单；ok=false 分四类——
 * conflict（冲突文件清单，主区已 abort 回原状）、empty_merge（worktree 相对基线无
 * 有效变更，diff 非空断言不过）、verify_failed（验证命令失败，合并已回滚）、
 * git_failed（底层 git 失败，尽力复位）。
 */
export type MergeOutcome =
  | { ok: true; merged_commit: string; files: string[]; validated_by: "verify_command" | "diff_nonempty" }
  | { ok: false; kind: "conflict" | "empty_merge" | "verify_failed" | "git_failed"; files?: string[]; error?: string };

export interface WorktreeManagerOptions {
  /** worktree 根目录（生产 = <dataDir>/worktrees；每个任务一个子目录） */
  root: string;
}

export class WorktreeManager {
  readonly #root: string;

  constructor(options: WorktreeManagerOptions) {
    this.#root = options.root;
  }

  /** worktree 目录（确定性：root/<taskId>/<key>，同任务同节点复用） */
  dirFor(taskId: string, key: string): string {
    return join(this.#root, taskId, key);
  }

  /**
   * 建（或复用）节点 worktree：基线 = 声明分支的头提交（缺省主区 HEAD）；复用时
   * 重置回基线（retry 的干净起点）；分支已存在（崩溃残留）则直接挂载并复位。
   */
  async prepare(input: WorktreePrepareInput): Promise<WorktreeRecord> {
    const top = await git(["rev-parse", "--show-toplevel"], input.repoPath);
    if (top.code !== 0) {
      throw new WorktreeError("not_a_repo", `not a git repository: ${input.repoPath}`, { stderr: top.stderr });
    }
    const repoPath = top.stdout.trim();
    const base = input.branch === undefined
      ? await git(["rev-parse", "HEAD"], repoPath)
      : await git(["rev-parse", "--verify", `${input.branch}^{commit}`], repoPath);
    if (base.code !== 0) {
      throw new WorktreeError(
        "git_failed",
        `baseline branch "${input.branch}" is not resolvable in ${repoPath}`,
        { stderr: base.stderr },
      );
    }
    const baseCommit = base.stdout.trim();
    const dir = this.dirFor(input.taskId, input.key);
    const branch = `morrow/${input.taskId}/${input.key}`;
    const createdAt = new Date().toISOString();

    if (existsSync(dir)) {
      const inside = await git(["rev-parse", "--is-inside-work-tree"], dir);
      if (inside.code === 0 && inside.stdout.trim() === "true") {
        // 复用：重置回基线（上一次尝试的脏状态清掉，retry 从干净起点开始）
        await git(["reset", "--hard", baseCommit], dir);
        await git(["clean", "-fd"], dir);
        this.#writeMarker({ taskId: input.taskId, nodeId: input.nodeId, key: input.key, repoPath, dir, branch, base: baseCommit, createdAt });
        return { taskId: input.taskId, nodeId: input.nodeId, key: input.key, repoPath, dir, branch, base: baseCommit, createdAt };
      }
      rmSync(dir, { recursive: true, force: true });
    }
    const branchExists = await git(["rev-parse", "--verify", "--quiet", branch]);
    const add = branchExists.code === 0
      ? await git(["worktree", "add", dir, branch], repoPath)
      : await git(["worktree", "add", "-b", branch, dir, baseCommit], repoPath);
    if (add.code !== 0) {
      throw new WorktreeError("git_failed", `git worktree add failed for node "${input.key}"`, {
        stderr: add.stderr,
      });
    }
    await git(["reset", "--hard", baseCommit], dir);
    await git(["clean", "-fd"], dir);
    this.#writeMarker({ taskId: input.taskId, nodeId: input.nodeId, key: input.key, repoPath, dir, branch, base: baseCommit, createdAt });
    return { taskId: input.taskId, nodeId: input.nodeId, key: input.key, repoPath, dir, branch, base: baseCommit, createdAt };
  }

  /** 收集相对基线的变更（porcelain 状态 + 变更后内容；deleted 内容为 null） */
  async collectChanges(record: WorktreeRecord): Promise<WorktreeFileChange[]> {
    const st = await git(["status", "--porcelain"], record.dir);
    if (st.code !== 0) {
      throw new WorktreeError("git_failed", `git status failed in worktree of node "${record.key}"`, { stderr: st.stderr });
    }
    const changes: WorktreeFileChange[] = [];
    for (const line of st.stdout.split("\n")) {
      if (line.length < 4) continue;
      const xy = line.slice(0, 2);
      let rest = line.slice(3);
      if (rest.includes(" -> ")) rest = rest.split(" -> ").pop() ?? rest; // rename 取新路径
      const status: WorktreeFileChange["status"] =
        xy === "??" ? "added"
        : xy.includes("A") ? "added"
        : xy.includes("D") ? "deleted"
        : xy.includes("R") ? "renamed"
        : "modified";
      const content = status === "deleted" ? null : readFileSync(join(record.dir, rest), "utf8");
      changes.push({ path: rest, status, content });
    }
    return changes;
  }

  /** 把变更提交到 worktree 分支；空变更（diff 非空断言失败的前兆）返回 commit=null */
  async commitChanges(record: WorktreeRecord, message: string): Promise<{ commit: string | null; files: number }> {
    const add = await git(["add", "-A"], record.dir);
    if (add.code !== 0) {
      throw new WorktreeError("git_failed", `git add failed in worktree of node "${record.key}"`, { stderr: add.stderr });
    }
    const staged = (await git(["diff", "--cached", "--name-only"], record.dir)).stdout.split("\n").filter(Boolean);
    if (staged.length === 0) return { commit: null, files: 0 };
    const commit = await git([...GIT_IDENTITY, "commit", "-m", message, "--no-verify"], record.dir);
    if (commit.code !== 0) {
      throw new WorktreeError("git_failed", `git commit failed in worktree of node "${record.key}"`, { stderr: commit.stderr });
    }
    const head = await git(["rev-parse", "HEAD"], record.dir);
    return { commit: head.stdout.trim(), files: staged.length };
  }

  /**
   * 合并回主区（调度器已按仓库路径串行化；本方法内部原子）：
   * 试合并（--no-commit --no-ff）→ 冲突即 abort（主区回原状）→ 无冲突时跑验证
   * （verify 命令在主区目录执行，失败回滚合并）→ 提交合并。无 verify 声明时以
   * 「合并 diff 非空」为最低验证（空合并视为验证失败——代码节点必须产出变更）。
   */
  async mergeToBase(record: WorktreeRecord, opts: { verify?: string } = {}): Promise<MergeOutcome> {
    const repo = record.repoPath;
    const preHead = await git(["rev-parse", "HEAD"], repo);
    if (preHead.code !== 0) {
      return { ok: false, kind: "git_failed", error: `cannot resolve main checkout HEAD: ${preHead.stderr}` };
    }
    const merge = await git(["merge", "--no-commit", "--no-ff", record.branch], repo);
    if (merge.code === 0) {
      const mergeHead = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], repo);
      if (mergeHead.code !== 0) {
        return { ok: false, kind: "empty_merge", error: "worktree produced no changes to merge (already contained in the baseline)" };
      }
      const files = (await git(["diff", "--cached", "--name-only"], repo)).stdout.split("\n").filter(Boolean);
      if (files.length === 0) {
        await git(["merge", "--abort"], repo);
        return { ok: false, kind: "empty_merge", error: "merge produced no changes (empty diff; code nodes must produce changes)" };
      }
      if (opts.verify !== undefined) {
        let passed = true;
        let diag = "";
        try {
          await execFileP("/bin/sh", ["-c", opts.verify], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
        } catch (err) {
          passed = false;
          const e = err as { code?: number | string; stderr?: string; message?: string };
          diag = e.stderr !== undefined && e.stderr.length > 0 ? e.stderr : e.message ?? String(e.code ?? "verify failed");
        }
        if (!passed) {
          await git(["reset", "--hard", preHead.stdout.trim()], repo); // reset --hard 同时清掉 MERGE_HEAD
          return { ok: false, kind: "verify_failed", error: `merge verification failed: ${diag.trim()}` };
        }
      }
      const commit = await git(
        [...GIT_IDENTITY, "commit", "-m", `morrow: merge ${record.branch} (task ${record.taskId} node ${record.key})`, "--no-verify"],
        repo,
      );
      if (commit.code !== 0) {
        await git(["reset", "--hard", preHead.stdout.trim()], repo);
        return { ok: false, kind: "git_failed", error: `merge commit failed: ${commit.stderr}` };
      }
      const merged = await git(["rev-parse", "HEAD"], repo);
      return {
        ok: true,
        merged_commit: merged.stdout.trim(),
        files,
        validated_by: opts.verify === undefined ? "diff_nonempty" : "verify_command",
      };
    }
    if (merge.code === 1) {
      const conflicted = (await git(["diff", "--name-only", "--diff-filter=U"], repo)).stdout.split("\n").filter(Boolean);
      await git(["merge", "--abort"], repo); // 主区回原状（冲突裁决留给 Owner：pending_review）
      return { ok: false, kind: "conflict", files: conflicted };
    }
    await git(["merge", "--abort"], repo); // best effort
    return { ok: false, kind: "git_failed", error: merge.stderr.length > 0 ? merge.stderr : `git merge exited ${merge.code}` };
  }

  /** 移除 worktree（目录 + 分支 + 主区 prune + 标记）；幂等，尽力而为 */
  async cleanup(record: WorktreeRecord): Promise<void> {
    if (existsSync(record.dir)) {
      const removed = await git(["worktree", "remove", "--force", record.dir], record.repoPath);
      if (removed.code !== 0) {
        rmSync(record.dir, { recursive: true, force: true });
      }
    }
    await git(["worktree", "prune"], record.repoPath);
    await git(["branch", "-D", record.branch], record.repoPath); // 分支可能仍被引用/未合并，失败即忽略
    rmSync(this.#markerPath(record.taskId, record.key), { force: true });
    // 任务目录空了就一并移除（rmdir 只清空目录，还留着兄弟节点的目录时抛 ENOTEMPTY 忽略）
    try {
      rmdirSync(join(this.#root, record.taskId));
    } catch {
      // 非空（其它节点仍在）或不存在：忽略
    }
  }

  /**
   * 启动清扫：root 下每个任务目录视为一个可能的崩溃残留。keep(taskId)=true 的任务
   * 保留（存活任务）；其余任务的 worktree 全部移除、分支删除、目录清空。返回清扫的
   * 任务 id 列表。标记文件缺失的目录直接物理删除（无法定位主区则不做 prune）。
   */
  async sweepStale(keep: (taskId: string) => boolean): Promise<string[]> {
    if (!existsSync(this.#root)) return [];
    const swept: string[] = [];
    for (const entry of readdirSync(this.#root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      if (keep(taskId)) continue;
      const taskDir = join(this.#root, taskId);
      for (const node of readdirSync(taskDir, { withFileTypes: true })) {
        if (!node.isDirectory()) continue;
        const nodeDir = join(taskDir, node.name);
        const marker = this.#readMarker(taskId, node.name);
        if (marker !== null) {
          await this.cleanup(marker);
        } else {
          rmSync(nodeDir, { recursive: true, force: true });
        }
      }
      rmSync(taskDir, { recursive: true, force: true });
      swept.push(taskId);
    }
    return swept;
  }

  // --- 内部：标记文件（sweep 的归属证据；放 worktree 目录外，避免污染 git 状态）---

  #markerPath(taskId: string, key: string): string {
    return join(this.#root, taskId, `${key}.json`);
  }

  #writeMarker(record: WorktreeRecord): void {
    mkdirSync(join(this.#root, record.taskId), { recursive: true });
    writeFileSync(this.#markerPath(record.taskId, record.key), JSON.stringify(record, null, 2));
  }

  #readMarker(taskId: string, key: string): WorktreeRecord | null {
    const path = this.#markerPath(taskId, key);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorktreeRecord>;
      if (
        typeof parsed.repoPath !== "string" || typeof parsed.dir !== "string" ||
        typeof parsed.branch !== "string" || typeof parsed.base !== "string" ||
        typeof parsed.nodeId !== "string"
      ) {
        throw new WorktreeError("invalid_record", `malformed worktree marker: ${path}`);
      }
      return { taskId, key, nodeId: parsed.nodeId, repoPath: parsed.repoPath, dir: parsed.dir, branch: parsed.branch, base: parsed.base, createdAt: parsed.createdAt ?? "" };
    } catch {
      return null;
    }
  }
}
