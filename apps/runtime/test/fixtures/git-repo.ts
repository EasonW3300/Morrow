// 真实 git 夹具仓库（票 M2-T4 / Issue #25）：零网络（本地 git 子进程），供 worktree /
// 锁 / 合并场景复用。identity 固定注入（-c user.name/email），不依赖宿主 git 配置。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitRepoFixture {
  /** 仓库主区目录 */
  dir: string;
  /** 初始提交 sha（基线） */
  head: string;
  /** 在主区执行 git 子命令（返回 stdout，trim 后） */
  git(args: string[], opts?: { cwd?: string }): string;
  /** 在主区写文件 + 提交（模拟主区推进，如其它节点先合并） */
  commitFile(path: string, content: string, message: string): string;
  close(): void;
}

const GIT_IDENTITY = ["-c", "user.name=Morrow Test", "-c", "user.email=morrow@test.local", "-c", "commit.gpgsign=false"];

export function makeRepo(files: Record<string, string> = { "README.md": "# demo\n" }): GitRepoFixture {
  const dir = mkdtempSync(join(tmpdir(), "morrow-git-repo-"));
  const git = (args: string[], opts?: { cwd?: string }): string =>
    execFileSync("git", GIT_IDENTITY.concat(args), {
      cwd: opts?.cwd ?? dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  git(["init", "-b", "main"]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  return {
    dir,
    head,
    git,
    commitFile(path, content, message) {
      writeFileSync(join(dir, path), content);
      git(["add", "-A"]);
      git(["commit", "-m", message]);
      return git(["rev-parse", "HEAD"]).trim();
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
