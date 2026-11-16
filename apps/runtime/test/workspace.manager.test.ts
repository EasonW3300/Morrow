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
  branchCandidatesForSession,
  credentialHost,
  defaultGitRunner,
  defaultBranchForSession,
  isValidBranchName,
  normalizeRepoUrl,
  redactCredentials,
  repoNameFromUrl,
  type GitRunner,
} from "../src/workspace.ts";
import { uuidv7 } from "../src/uuid-v7.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Morrow Test",
  GIT_AUTHOR_EMAIL: "test@morrow.local",
  GIT_COMMITTER_NAME: "Morrow Test",
  GIT_COMMITTER_EMAIL: "test@morrow.local",
};

function git(cwd: string, args: string[]): string {
  // 超时兜底（#64-C / 与 #65 同类脆弱性）：git 子进程卡住时让测试失败而不是挂起整个套件
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: "utf8",
    timeout: 60_000,
  });
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
  // #64-A2：短 id 取 uuidv7 **尾部随机位**，不是前 6 位时间戳高位
  assert.equal(defaultBranchForSession("01936b9d-8f7a-7abc-9f2e-112233445566"), "morrow/33445566");
  assert.equal(defaultBranchForSession("01936b9d-8f7a-7000-8000-aaaaaaaaaaaa"), "morrow/aaaaaaaa");
  assert.equal(isValidBranchName("morrow/01936b"), true);
  assert.equal(isValidBranchName("feature/a-b_c.1"), true);
  assert.equal(isValidBranchName("bad name"), false);
  assert.equal(isValidBranchName("bad..name"), false);
  assert.equal(isValidBranchName("bad:name"), false);
  assert.equal(isValidBranchName("-bad"), false);
  assert.equal(isValidBranchName("bad.lock"), false);
  assert.equal(isValidBranchName(""), false);
});

test("branchCandidatesForSession：默认名 + -2..-5 后缀（最多 5 次尝试）", () => {
  const sessionId = "01936b9d-8f7a-7abc-9f2e-112233445566";
  assert.deepEqual(branchCandidatesForSession(sessionId), [
    "morrow/33445566",
    "morrow/33445566-2",
    "morrow/33445566-3",
    "morrow/33445566-4",
    "morrow/33445566-5",
  ]);
});

test("同一毫秒创建的两个会话得到不同的默认分支名（uuidv7 前缀相同、尾部随机）", () => {
  const now = Date.parse("2026-11-15T00:00:00.000Z");
  const first = uuidv7(now);
  const second = uuidv7(now);
  // uuidv7 前 48 bit（时间戳）相同——这正是旧实现撞名的原因
  assert.equal(first.slice(0, 13), second.slice(0, 13));
  assert.notEqual(defaultBranchForSession(first), defaultBranchForSession(second));
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

// --- #64-A1：凭据只注入白名单 host ------------------------------------------

/** 捕获 git clone 的 argv/env（不执行真实网络 clone）。 */
function capturingCloneRunner(): {
  runner: GitRunner;
  calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner: GitRunner = async (file, args, opts) => {
    calls.push({ file, args, env: { ...(opts?.env ?? {}) } });
    if (file === "gh") return { code: 1, stdout: "", stderr: "not logged in" };
    if (file === "git" && args.includes("clone")) {
      return { code: 128, stdout: "", stderr: `fatal: repository '${args[args.length - 2]}' not found` };
    }
    return defaultGitRunner(file, args, opts);
  };
  return { runner, calls };
}

test("A1：非白名单 host 不注入 token（clone argv/env 里没有 Authorization）", async () => {
  const root = tmpDir("morrow-ws-a1-denied-");
  try {
    const { runner, calls } = capturingCloneRunner();
    const ws = manager(root, { runner, token: "ghp_SECRET_TOKEN_123" });
    await assert.rejects(
      () => ws.cloneFrom("https://evil.example/x.git"),
      (err: unknown) => {
        if (!(err instanceof WorkspaceError) || err.code !== "clone_failed") return false;
        // 错误必须说明「仅 github.com 支持凭据注入」，且不含 token 原文
        assert.match(err.message, /only injected for github\.com/i);
        assert.ok(!err.message.includes("ghp_SECRET_TOKEN_123"), "message 不含 token");
        const details = err.details as { stderr?: string; token_injected?: boolean; credential_host?: string };
        assert.equal(details.token_injected, false);
        assert.equal(details.credential_host, "evil.example");
        assert.ok(!(details.stderr ?? "").includes("ghp_SECRET_TOKEN_123"), "details.stderr 不含 token");
        return true;
      },
    );
    const cloneCall = calls.find((call) => call.file === "git" && call.args.includes("clone"));
    assert.ok(cloneCall, "clone 被调用");
    assert.equal(cloneCall.args.includes("ghp_SECRET_TOKEN_123"), false, "argv 里没有 token");
    const envText = JSON.stringify(cloneCall.env);
    assert.ok(!envText.includes("ghp_SECRET_TOKEN_123"), "env 里没有 token");
    assert.ok(!envText.toLowerCase().includes("authorization"), "env 里没有 Authorization 头");
  } finally {
    removeDir(root);
  }
});

test("A1：github.com 才注入 token，且配置按 host 精确限定（http.https://github.com/.extraHeader）", async () => {
  const root = tmpDir("morrow-ws-a1-allow-");
  try {
    const { runner, calls } = capturingCloneRunner();
    const ws = manager(root, { runner, token: "ghp_ALLOWED_TOKEN" });
    await assert.rejects(() => ws.cloneFrom("https://github.com/acme/private.git"));
    const cloneCall = calls.find((call) => call.file === "git" && call.args.includes("clone"));
    assert.ok(cloneCall, "clone 被调用");
    assert.equal(cloneCall.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
    assert.notEqual(cloneCall.env.GIT_CONFIG_KEY_0, "http.extraHeader", "不能是全局配置");
    const expectedHeader = `Authorization: Basic ${Buffer.from("x-access-token:ghp_ALLOWED_TOKEN").toString("base64")}`;
    assert.equal(cloneCall.env.GIT_CONFIG_VALUE_0, expectedHeader);
    assert.equal(cloneCall.args.includes("ghp_ALLOWED_TOKEN"), false, "token 不进 argv");
  } finally {
    removeDir(root);
  }
});

test("A1：GIT_CURL_VERBOSE / GIT_TRACE_CURL 被清除（调试开关不得把 Authorization 打到 stderr）", async () => {
  const root = tmpDir("morrow-ws-a1-verbose-");
  const previousVerbose = process.env.GIT_CURL_VERBOSE;
  process.env.GIT_CURL_VERBOSE = "1";
  process.env.GIT_TRACE_CURL = "1";
  try {
    const { runner, calls } = capturingCloneRunner();
    const ws = manager(root, { runner, token: "ghp_TOKEN" });
    await assert.rejects(() => ws.cloneFrom("https://github.com/acme/private.git"));
    const cloneCall = calls.find((call) => call.file === "git" && call.args.includes("clone"));
    assert.ok(cloneCall);
    assert.equal(cloneCall.env.GIT_CURL_VERBOSE, undefined);
    assert.equal(cloneCall.env.GIT_TRACE_CURL, undefined);
  } finally {
    if (previousVerbose === undefined) delete process.env.GIT_CURL_VERBOSE;
    else process.env.GIT_CURL_VERBOSE = previousVerbose;
    delete process.env.GIT_TRACE_CURL;
    removeDir(root);
  }
});

test("A1：clone 失败详情脱敏——stderr 里的 Authorization 行与 token 原文都被抹掉", () => {
  const token = "ghp_LEAKY_SECRET";
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const raw = [
    "> GET /acme/private.git/info/refs HTTP/1.1",
    `Authorization: Basic ${basic}`,
    `some git error mentioning ${token}`,
    "http.extraheader was set",
  ].join("\n");
  const redacted = redactCredentials(raw, token);
  assert.ok(!redacted.includes(token));
  assert.ok(!redacted.includes(basic));
  assert.ok(!/authorization:/i.test(redacted));
  assert.ok(!/extraheader/i.test(redacted));
  assert.match(redacted, /\[redacted: credential header\]/);
});

test("A1：credentialHost 取归一化 host（https/scp/ssh/file）", () => {
  assert.equal(credentialHost("https://github.com/acme/x.git"), "github.com");
  assert.equal(credentialHost("git@github.com:acme/x.git"), "github.com");
  assert.equal(credentialHost("ssh://git@github.com/acme/x.git"), "github.com");
  assert.equal(credentialHost("https://GitHub.com/acme/x.git"), "github.com");
  assert.equal(credentialHost("https://evil.example/x.git"), "evil.example");
  assert.equal(credentialHost("file:///tmp/x.git"), null);
  assert.equal(credentialHost("not a url"), null);
});

// --- #64-A2：两个真实会话在同一仓库建分支，名字唯一且真实存在 -----------------

test("A2：同一仓库两次绑定（两个真实会话）建出两条不同的分支，且都真实存在", async () => {
  const root = tmpDir("morrow-ws-a2-unique-");
  try {
    const { seed } = makeRemote(root);
    const ws = manager(root);
    // 同一毫秒内创建两个会话（模拟 uuidv7 时间戳前缀相同的最坏情况）
    const now = Date.now();
    const firstSession = uuidv7(now);
    const secondSession = uuidv7(now);
    assert.equal(firstSession.slice(0, 13), secondSession.slice(0, 13), "两个 session 的时间戳前缀相同");

    const firstName = defaultBranchForSession(firstSession);
    const secondName = defaultBranchForSession(secondSession);
    assert.notEqual(firstName, secondName, "默认分支名必须不同");

    const first = await ws.ensureBranch(seed, "main", firstName);
    const second = await ws.ensureBranch(seed, "main", secondName);
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.branch, second.branch);

    const listed = git(seed, ["branch", "--list", "morrow/*"])
      .split("\n")
      .map((line) => line.replace(/^\*?\s*/, "").trim())
      .filter((line) => line.length > 0);
    assert.ok(listed.includes(firstName), `git branch --list 应含 ${firstName}；实际 ${JSON.stringify(listed)}`);
    assert.ok(listed.includes(secondName), `git branch --list 应含 ${secondName}`);
    assert.equal(listed.length, 2);

    // 两个会话各自能建出独立 worktree
    const firstTree = await ws.prepareWorktree(seed, first.branch, firstSession);
    const secondTree = await ws.prepareWorktree(seed, second.branch, secondSession);
    assert.notEqual(firstTree.dir, secondTree.dir);
    assert.equal(git(firstTree.dir, ["branch", "--show-current"]).trim(), firstName);
    assert.equal(git(secondTree.dir, ["branch", "--show-current"]).trim(), secondName);
  } finally {
    removeDir(root);
  }
});

test("A2：默认名撞车时按候选序列 + 后缀重试（-2 生效）", async () => {
  const root = tmpDir("morrow-ws-a2-retry-");
  try {
    const { seed } = makeRemote(root);
    const ws = manager(root);
    const sessionId = "01936b9d-8f7a-7abc-9f2e-112233445566";
    const [base, second] = branchCandidatesForSession(sessionId);
    await ws.ensureBranch(seed, "main", base);
    const created = await ws.ensureBranch(seed, "main", second);
    assert.equal(created.branch, second);
    assert.equal(git(seed, ["branch", "--list", "morrow/*"]).includes(second), true);
  } finally {
    removeDir(root);
  }
});
