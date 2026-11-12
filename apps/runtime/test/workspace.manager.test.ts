// 会话工作区管理器（票 M7-A-T4 / Issue #61）真实临时仓库测试：
// - ensureBranch 真实建分支 + prepareWorktree 后 `git branch --show-current` 断言；
// - cloneFrom 新 clone / 按 remote URL 关联已有副本（计数 clone 调用）；
// - 无 gh 无 PAT 时 clone 失败的可操作提示；
// - readGhToken 的 gh → OS 凭据库 → null 链路；
// - attach 只读（文件内容/大小不变）与上限校验；
// - 分支冲突与同分支 worktree 占用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretStore } from "../src/keyring.ts";
import {
  ATTACHMENT_MAX_FILE_BYTES,
  DefaultWorkspaceManager,
  WorkspaceError,
  defaultGitRunner,
  defaultBranchForSession,
  isValidBranchName,
  normalizeRepoUrl,
  repoNameFromUrl,
  type GitRunner,
} from "../src/workspace.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Morrow Test",
  GIT_AUTHOR_EMAIL: "test@morrow.local",
  GIT_COMMITTER_NAME: "Morrow Test",
  GIT_COMMITTER_EMAIL: "test@morrow.local",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
}

/** 裸远端 + 已推送 main 的种子仓库（file:// clone 用） */
function makeRemote(root: string): { bare: string; seed: string } {
  const bare = join(root, "remote.git");
  git(root, ["init", "--bare", "-b", "main", bare]);
  const seed = join(root, "seed");
  git(root, ["init", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "hello morrow\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "init"]);
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { bare, seed };
}

function manager(root: string, options: { runner?: GitRunner; token?: string | null; secretStore?: SecretStore } = {}) {
  return new DefaultWorkspaceManager({
    workspacesRoot: join(root, "workspaces"),
    worktreesRoot: join(root, "worktrees"),
    ...(options.runner === undefined ? {} : { gitRunner: options.runner }),
    ...(options.token === undefined ? {} : { tokenProvider: async () => options.token ?? null }),
    ...(options.secretStore === undefined ? {} : { secretStore: options.secretStore }),
  });
}

function countingRunner(): { runner: GitRunner; clones: number; ghCalls: number } {
  const state = { clones: 0, ghCalls: 0 };
  const runner: GitRunner = async (file, args, opts) => {
    if (file === "gh") state.ghCalls += 1;
    if (file === "git" && args.includes("clone")) state.clones += 1;
    return defaultGitRunner(file, args, opts);
  };
  return {
    runner,
    get clones() {
      return state.clones;
    },
    get ghCalls() {
      return state.ghCalls;
    },
  };
}

test("normalizeRepoUrl：https / ssh / scp 形态归一，.git 与末尾斜杠忽略", () => {
  const expected = "github.com/EasonW3300/Morrow";
  assert.equal(normalizeRepoUrl("https://github.com/EasonW3300/Morrow.git"), expected);
  assert.equal(normalizeRepoUrl("https://github.com/EasonW3300/Morrow/"), expected);
  assert.equal(normalizeRepoUrl("git@github.com:EasonW3300/Morrow.git"), expected);
  assert.equal(normalizeRepoUrl("ssh://git@github.com/EasonW3300/Morrow.git"), expected);
  assert.equal(normalizeRepoUrl("https://github.com/EasonW3300/Morrow"), expected);
  assert.equal(normalizeRepoUrl("not a url"), null);
});

test("repoNameFromUrl / defaultBranchForSession / isValidBranchName", () => {
  assert.equal(repoNameFromUrl("https://github.com/a/b.git"), "b");
  assert.equal(repoNameFromUrl("git@github.com:a/Morrow.git"), "Morrow");
  assert.equal(defaultBranchForSession("01936b9d-8f7a-7abc-9f2e-112233445566"), "morrow/01936b");
  assert.equal(isValidBranchName("morrow/01936b"), true);
  assert.equal(isValidBranchName("feature/a-b_c.1"), true);
  assert.equal(isValidBranchName("bad name"), false);
  assert.equal(isValidBranchName("bad..name"), false);
  assert.equal(isValidBranchName("bad:name"), false);
  assert.equal(isValidBranchName("-bad"), false);
  assert.equal(isValidBranchName("bad.lock"), false);
  assert.equal(isValidBranchName(""), false);
});

test("ensureBranch 从 origin/HEAD 探测基线并真实建分支；prepareWorktree 后 branch --show-current 正确", async () => {
  const root = tmpDir("morrow-ws-branch-");
  try {
    const { bare } = makeRemote(root);
    const ws = manager(root, { token: null });
    const cloned = await ws.cloneFrom(`file://${bare}`);
    assert.equal(cloned.reused, false);

    const branch = await ws.ensureBranch(cloned.repoPath, undefined, "morrow/abc123");
    assert.equal(branch.base, "main");
    assert.equal(branch.created, true);

    const prepared = await ws.prepareWorktree(cloned.repoPath, branch.branch, "session-1");
    const current = git(prepared.dir, ["branch", "--show-current"]).trim();
    assert.equal(current, "morrow/abc123");
    assert.ok(readFileSync(join(prepared.dir, "README.md"), "utf8").includes("hello morrow"));
  } finally {
    removeDir(root);
  }
});

test("ensureBranch 同名已存在抛 branch_exists；非法名抛 invalid_branch", async () => {
  const root = tmpDir("morrow-ws-conflict-");
  try {
    const { seed } = makeRemote(root);
    const ws = manager(root);
    await ws.ensureBranch(seed, "main", "morrow/abc123");
    await assert.rejects(
      () => ws.ensureBranch(seed, "main", "morrow/abc123"),
      (err: unknown) => err instanceof WorkspaceError && err.code === "branch_exists",
    );
    await assert.rejects(
      () => ws.ensureBranch(seed, "main", "bad name"),
      (err: unknown) => err instanceof WorkspaceError && err.code === "invalid_branch",
    );
  } finally {
    removeDir(root);
  }
});

test("prepareWorktree：同分支被另一会话占用 → branch_in_use 并给出持有目录", async () => {
  const root = tmpDir("morrow-ws-worktree-");
  try {
    const { seed } = makeRemote(root);
    const ws = manager(root);
    await ws.ensureBranch(seed, "main", "morrow/same");
    await ws.prepareWorktree(seed, "morrow/same", "session-1");
    await assert.rejects(
      () => ws.prepareWorktree(seed, "morrow/same", "session-2"),
      (err: unknown) =>
        err instanceof WorkspaceError &&
        err.code === "branch_in_use" &&
        typeof (err.details as { holder?: string } | undefined)?.holder === "string",
    );
  } finally {
    removeDir(root);
  }
});

test("cloneFrom：本地已有同 remote URL 的 clone 时关联而不重复 clone", async () => {
  const root = tmpDir("morrow-ws-reuse-");
  try {
    const { bare } = makeRemote(root);
    const counter = countingRunner();
    const ws = manager(root, { runner: counter.runner, token: null });
    const first = await ws.cloneFrom(`file://${bare}`);
    assert.equal(counter.clones, 1);

    // 第二次（另一个 agent 实例/另一次绑定）按 remote URL 找到同一副本
    const second = await ws.cloneFrom(`file://${bare}`);
    assert.equal(counter.clones, 1, "关联路径不得再次 clone");
    assert.equal(second.reused, true);
    assert.equal(second.path, first.path);
  } finally {
    removeDir(root);
  }
});

test("cloneFrom 失败且无 gh/PAT 时给出可操作提示（不是静默失败）", async () => {
  const root = tmpDir("morrow-ws-nocred-");
  try {
    const failing: GitRunner = async (file, args, opts) => {
      if (file === "git" && args.includes("clone")) {
        return { code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com'" };
      }
      return defaultGitRunner(file, args, opts);
    };
    const noCred = manager(root, { runner: failing, token: null });
    await assert.rejects(
      () => noCred.cloneFrom("https://github.com/secret/private.git"),
      (err: unknown) =>
        err instanceof WorkspaceError &&
        err.code === "clone_failed" &&
        err.message.includes("GitHub PAT") &&
        err.message.includes("gh auth login"),
    );
  } finally {
    removeDir(root);
  }
});

test("readGhToken：优先 gh auth token，其次 OS 凭据库 github:pat，都没有为 null", async () => {
  const root = tmpDir("morrow-ws-token-");
  try {
    const withGh = manager(root, {
      runner: async (file, args, opts) => {
        if (file === "gh") return { code: 0, stdout: "gh-token\n", stderr: "" };
        return defaultGitRunner(file, args, opts);
      },
    });
    assert.equal(await withGh.readGhToken(), "gh-token");

    const secretStore: SecretStore = {
      async getSecret(service, account) {
        return service === "github" && account === "pat" ? "pat-token" : null;
      },
      async setSecret() {},
      async deleteSecret() {},
    };
    const noGh = manager(root, {
      runner: async (file, args, opts) => {
        if (file === "gh") return { code: 1, stdout: "", stderr: "not logged in" };
        return defaultGitRunner(file, args, opts);
      },
      secretStore,
    });
    assert.equal(await noGh.readGhToken(), "pat-token");

    const neither = manager(root, {
      runner: async (file, args, opts) => {
        if (file === "gh") return { code: 1, stdout: "", stderr: "not logged in" };
        return defaultGitRunner(file, args, opts);
      },
    });
    assert.equal(await neither.readGhToken(), null);
  } finally {
    removeDir(root);
  }
});

test("attach：只读读取（文件内容与 mtime 不变）、拒绝超限与二进制", async () => {
  const root = tmpDir("morrow-ws-attach-");
  try {
    const ws = manager(root);
    const file = join(root, "notes.txt");
    writeFileSync(file, "attachment body\n");
    const before = statSync(file);
    const [attachment] = await ws.attach([file]);
    assert.equal(attachment.content, "attachment body\n");
    assert.equal(attachment.name, "notes.txt");
    assert.equal(readFileSync(file, "utf8"), "attachment body\n");
    assert.equal(statSync(file).mtimeMs, before.mtimeMs);

    const big = join(root, "big.txt");
    writeFileSync(big, "x".repeat(ATTACHMENT_MAX_FILE_BYTES + 1));
    await assert.rejects(
      () => ws.attach([big]),
      (err: unknown) => err instanceof WorkspaceError && err.code === "attachment_too_large",
    );

    const binary = join(root, "bin.dat");
    writeFileSync(binary, Buffer.from([0x61, 0x00, 0x62]));
    await assert.rejects(
      () => ws.attach([binary]),
      (err: unknown) => err instanceof WorkspaceError && err.code === "invalid_attachment",
    );
  } finally {
    removeDir(root);
  }
});

test("bindLocal：目录存在但非 git 返回 null repo；不存在报 not_a_directory", async () => {
  const root = tmpDir("morrow-ws-local-");
  try {
    const ws = manager(root);
    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.deepEqual(await ws.bindLocal(plain), { path: plain, repoPath: null, branch: null });
    await assert.rejects(
      () => ws.bindLocal(join(root, "missing")),
      (err: unknown) => err instanceof WorkspaceError && err.code === "not_a_directory",
    );
  } finally {
    removeDir(root);
  }
});
