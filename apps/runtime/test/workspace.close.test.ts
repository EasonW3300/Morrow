// 会话关闭三选一 + 同分支拒绝（票 M7-A-T5 / Issue #63；ADR-0012）：
// - 同仓库同分支的第二个会话 → 409 branch_in_use，payload 带持有者 session_id/title；
//   判定在内存注册表与账本重建两处一致（重启 Runtime 后仍拒绝）。
// - 关闭普通会话：有未提交改动且不带选择 → 409 uncommitted_changes + 文件列表；
//   commit / keep / discard 三种选择各自产生可观察结果，并写 session.closed。
// - ephemeral 会话关闭语义保持 T3（session.ephemeral_closed + 24h 可恢复）。
// - discard 的路径前缀校验：只允许本会话 worktree，伪造目录被拒且不被清理。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePi } from "@morrow/pi-adapter";
import type { EventEnvelope, SessionWorkspace } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { DefaultWorkspaceManager, WorkspaceError } from "../src/workspace.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Morrow Test",
  GIT_AUTHOR_EMAIL: "test@morrow.local",
  GIT_COMMITTER_NAME: "Morrow Test",
  GIT_COMMITTER_EMAIL: "test@morrow.local",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function fakeFactory() {
  return async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] });
}

interface ApiError {
  error: { code: string; message: string } & Record<string, unknown>;
}

function makeRepo(root: string): string {
  const repo = join(root, "repo");
  git(root, ["init", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "hello morrow\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

/** 裸远端 + main 的种子仓库（file:// clone + worktree 用） */
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

async function createSession(port: number, body: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await json<{ session_id: string }>(res)).session_id;
}

async function bindWorkspace(
  port: number,
  sessionId: string,
  body: unknown,
): Promise<{ status: number; body: ({ workspace?: SessionWorkspace | null } & ApiError) }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/workspace`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as never };
}

async function closeSession(
  port: number,
  sessionId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as never };
}

async function allEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

test("同仓库同分支：第二个会话 409 branch_in_use（带持有者），重启后仍拒绝", async () => {
  const dir = tmpDir("morrow-close-branch-");
  const repo = makeRepo(dir);
  let runtime = await startRuntime(testConfig(join(dir, "data")), { agentAdapterFactory: fakeFactory() });
  try {
    const first = await createSession(runtime.port, { title: "甲会话" });
    const bound = await bindWorkspace(runtime.port, first, { kind: "local", path: repo });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.equal(bound.body.workspace?.branch, "main");

    const second = await createSession(runtime.port, { title: "乙会话" });
    const rejected = await bindWorkspace(runtime.port, second, { kind: "local", path: repo });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "branch_in_use");
    assert.equal(rejected.body.error.holder_session_id, first);
    assert.equal(rejected.body.error.holder_title, "甲会话");

    // 重启（新进程只靠账本重建注册表）后仍拒绝
    await runtime.close();
    runtime = await startRuntime(testConfig(join(dir, "data")), { agentAdapterFactory: fakeFactory() });
    const third = await createSession(runtime.port, { title: "丙会话" });
    const afterRestart = await bindWorkspace(runtime.port, third, { kind: "local", path: repo });
    assert.equal(afterRestart.status, 409);
    assert.equal(afterRestart.body.error.code, "branch_in_use");
    assert.equal(afterRestart.body.error.holder_session_id, first);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("github 同分支预检：第二个会话说同一 new_branch → 409 branch_in_use（不新建分支）", async () => {
  const root = tmpDir("morrow-close-branch-gh-");
  try {
    const { bare } = makeRemote(root);
    const workspace = new DefaultWorkspaceManager({
      workspacesRoot: join(root, "workspaces"),
      worktreesRoot: join(root, "worktrees"),
    });
    const runtime = await startRuntime(testConfig(join(root, "data")), {
      agentAdapterFactory: fakeFactory(),
      workspaceManager: workspace,
    });
    try {
      const first = await createSession(runtime.port, { title: "主会话" });
      const firstBind = await bindWorkspace(runtime.port, first, {
        kind: "github",
        url: `file://${bare}`,
        new_branch: "morrow/shared",
      });
      assert.equal(firstBind.status, 200, JSON.stringify(firstBind.body));

      const second = await createSession(runtime.port, { title: "抢分支" });
      const rejected = await bindWorkspace(runtime.port, second, {
        kind: "github",
        url: `file://${bare}`,
        new_branch: "morrow/shared",
      });
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error.code, "branch_in_use");
      assert.equal(rejected.body.error.holder_session_id, first);
      assert.equal(rejected.body.error.holder_title, "主会话");
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test("关闭：有未提交改动且未给选择 → 409 uncommitted_changes + 文件列表", async () => {
  const root = tmpDir("morrow-close-409-");
  try {
    const repo = makeRepo(root);
    const runtime = await startRuntime(testConfig(join(root, "data")), { agentAdapterFactory: fakeFactory() });
    try {
      const sessionId = await createSession(runtime.port, { title: "未提交" });
      assert.equal((await bindWorkspace(runtime.port, sessionId, { kind: "local", path: repo })).status, 200);
      writeFileSync(join(repo, "README.md"), "changed\n");
      writeFileSync(join(repo, "new.txt"), "new\n");

      const res = await closeSession(runtime.port, sessionId, {});
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "uncommitted_changes");
      const files = res.body.error.files as string[];
      assert.ok(Array.isArray(files), JSON.stringify(res.body));
      assert.ok(files.includes("README.md"), `files=${JSON.stringify(files)}`);
      assert.ok(files.includes("new.txt"), `files=${JSON.stringify(files)}`);
      // 未给选择：不得静默丢弃、也不得关闭
      assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "changed\n");
      assert.ok(!(await allEvents(runtime.port)).some((e) => e.event_type === "session.closed"));
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test("关闭选择 commit：提交到会话分支、返回 commit id，并写 session.closed", async () => {
  const root = tmpDir("morrow-close-commit-");
  try {
    const repo = makeRepo(root);
    const runtime = await startRuntime(testConfig(join(root, "data")), { agentAdapterFactory: fakeFactory() });
    try {
      const sessionId = await createSession(runtime.port, { title: "提交测试" });
      assert.equal((await bindWorkspace(runtime.port, sessionId, { kind: "local", path: repo })).status, 200);
      writeFileSync(join(repo, "README.md"), "committed\n");

      const res = await closeSession(runtime.port, sessionId, { uncommitted: "commit" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const commit = res.body.commit as string;
      assert.match(commit, /^[0-9a-f]{7,40}$/);
      assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), commit);
      assert.equal(git(repo, ["log", "-1", "--pretty=%s"]).trim(), `morrow: session ${sessionId.slice(0, 8)} 提交测试`);
      assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
      assert.equal(res.body.uncommitted, "commit");

      const closed = (await allEvents(runtime.port)).find((e) => e.event_type === "session.closed");
      assert.ok(closed, "session.closed 入账本");
      assert.equal(closed.session_id, sessionId);
      assert.equal(closed.payload.uncommitted, "commit");
      assert.equal(closed.payload.commit, commit);
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test("关闭选择 keep：工作区原样保留、返回未提交文件", async () => {
  const root = tmpDir("morrow-close-keep-");
  try {
    const repo = makeRepo(root);
    const runtime = await startRuntime(testConfig(join(root, "data")), { agentAdapterFactory: fakeFactory() });
    try {
      const sessionId = await createSession(runtime.port, { title: "保留测试" });
      assert.equal((await bindWorkspace(runtime.port, sessionId, { kind: "local", path: repo })).status, 200);
      writeFileSync(join(repo, "README.md"), "kept\n");
      writeFileSync(join(repo, "notes.txt"), "notes\n");

      const res = await closeSession(runtime.port, sessionId, { uncommitted: "keep" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.uncommitted, "keep");
      assert.deepEqual((res.body.files as string[]).sort(), ["README.md", "notes.txt"]);
      assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "kept\n");
      assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "notes\n");

      const closed = (await allEvents(runtime.port)).find((e) => e.event_type === "session.closed");
      assert.ok(closed);
      assert.equal(closed.payload.uncommitted, "keep");
      assert.deepEqual((closed.payload.files as string[]).sort(), ["README.md", "notes.txt"]);
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test("关闭选择 discard：仅清理本会话 worktree，返回清理文件数", async () => {
  const root = tmpDir("morrow-close-discard-");
  try {
    const { bare } = makeRemote(root);
    const workspace = new DefaultWorkspaceManager({
      workspacesRoot: join(root, "workspaces"),
      worktreesRoot: join(root, "worktrees"),
    });
    const runtime = await startRuntime(testConfig(join(root, "data")), {
      agentAdapterFactory: fakeFactory(),
      workspaceManager: workspace,
    });
    try {
      const sessionId = await createSession(runtime.port, { title: "丢弃测试" });
      const bound = await bindWorkspace(runtime.port, sessionId, {
        kind: "github",
        url: `file://${bare}`,
        new_branch: "morrow/discard",
      });
      assert.equal(bound.status, 200, JSON.stringify(bound.body));
      const dir = bound.body.workspace?.path;
      assert.ok(dir !== undefined);
      assert.equal(dir, join(root, "worktrees", sessionId));

      writeFileSync(join(dir, "README.md"), "discard me\n");
      writeFileSync(join(dir, "leftover.txt"), "leftover\n");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "deep.txt"), "deep\n");

      const res = await closeSession(runtime.port, sessionId, { uncommitted: "discard" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.uncommitted, "discard");
      assert.ok((res.body.discarded as number) >= 3, JSON.stringify(res.body));
      assert.equal(git(dir, ["status", "--porcelain"]).trim(), "");
      assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "hello morrow\n");
      assert.ok(!existsSync(join(dir, "leftover.txt")));
      assert.ok(!existsSync(join(dir, "sub")));

      const closed = (await allEvents(runtime.port)).find((e) => e.event_type === "session.closed");
      assert.ok(closed);
      assert.equal(closed.payload.uncommitted, "discard");
      assert.ok((closed.payload.discarded as number) >= 3);
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test("无未提交改动：直接关闭，不需要选择", async () => {
  const root = tmpDir("morrow-close-clean-");
  try {
    const repo = makeRepo(root);
    const runtime = await startRuntime(testConfig(join(root, "data")), { agentAdapterFactory: fakeFactory() });
    try {
      const sessionId = await createSession(runtime.port, { title: "干净" });
      assert.equal((await bindWorkspace(runtime.port, sessionId, { kind: "local", path: repo })).status, 200);
      const res = await closeSession(runtime.port, sessionId, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.uncommitted, null);
      assert.deepEqual(res.body.files, []);
      assert.ok((await allEvents(runtime.port)).some((e) => e.event_type === "session.closed"));
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test("ephemeral 关闭语义不变：24h 可恢复，不写 session.closed", async () => {
  const root = tmpDir("morrow-close-eph-");
  try {
    const runtime = await startRuntime(testConfig(join(root, "data")), { agentAdapterFactory: fakeFactory() });
    try {
      const sessionId = await createSession(runtime.port, { kind: "ephemeral", title: "临时" });
      const res = await closeSession(runtime.port, sessionId, { uncommitted: "keep" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(typeof res.body.restorable_until === "string");
      assert.equal(res.body.uncommitted, undefined, "ephemeral 关闭不接受三选一");

      const events = await allEvents(runtime.port);
      assert.ok(events.some((e) => e.event_type === "session.ephemeral_closed" && e.session_id === sessionId));
      assert.ok(!events.some((e) => e.event_type === "session.closed" && e.session_id === sessionId));
    } finally {
      await runtime.close();
    }
  } finally {
    removeDir(root);
  }
});

test("discard 路径前缀校验：伪造目录 / 非本会话目录一律拒绝且不清理", async () => {
  const root = tmpDir("morrow-close-safety-");
  try {
    const repo = makeRepo(root);
    const workspace = new DefaultWorkspaceManager({
      workspacesRoot: join(root, "workspaces"),
      worktreesRoot: join(root, "worktrees"),
    });
    // 伪造目录（不在 worktreesRoot 下）
    const forged = join(root, "forged");
    mkdirSync(forged);
    writeFileSync(join(forged, "README.md"), "precious\n");
    writeFileSync(join(forged, "other.txt"), "precious too\n");
    await assert.rejects(
      () => workspace.discardChanges("session-1", forged),
      (err: unknown) => err instanceof WorkspaceError && err.code === "not_isolated",
    );
    assert.equal(readFileSync(join(forged, "README.md"), "utf8"), "precious\n");
    assert.ok(existsSync(join(forged, "other.txt")));

    // sessionId 带 ../ 的路径穿越同样被拒
    await assert.rejects(
      () => workspace.discardChanges("../forged", forged),
      (err: unknown) => err instanceof WorkspaceError && err.code === "not_isolated",
    );

    // worktreesRoot 下但属于另一个会话的目录
    await workspace.ensureBranch(repo, "main", "morrow/other");
    const other = await workspace.prepareWorktree(repo, "morrow/other", "session-other");
    writeFileSync(join(other.dir, "README.md"), "someone else's work\n");
    await assert.rejects(
      () => workspace.discardChanges("session-1", other.dir),
      (err: unknown) => err instanceof WorkspaceError && err.code === "not_isolated",
    );
    assert.equal(readFileSync(join(other.dir, "README.md"), "utf8"), "someone else's work\n");

    // 本会话 worktree：允许清理
    await workspace.ensureBranch(repo, "main", "morrow/mine");
    const mine = await workspace.prepareWorktree(repo, "morrow/mine", "session-1");
    writeFileSync(join(mine.dir, "README.md"), "mine\n");
    const result = await workspace.discardChanges("session-1", mine.dir);
    assert.equal(result.discarded, 1);
    assert.equal(git(mine.dir, ["status", "--porcelain"]).trim(), "");
  } finally {
    removeDir(root);
  }
});
