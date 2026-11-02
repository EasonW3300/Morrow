// Worktree 管理器与资源锁表（票 M2-T4 / Issue #25，PRD §4.3 FR-TASK-8）：
// - WorktreeManager：git worktree 生命周期（创建/复用/变更收集/合并/清理/崩溃残留清扫），
//   全部 git 操作走子进程（真实 git 夹具仓库，零网络）；
// - LockTable：task_locks 表（lock key 单持有者），acquire 全拿或全不拿 / release / 清扫。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorktreeError, WorktreeManager, type WorktreeRecord } from "../src/worktree.ts";
import { LockTable } from "../src/locks.ts";
import { openSqlite } from "../src/db.ts";
import { makeRepo, type GitRepoFixture } from "./fixtures/git-repo.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const TASK = "01990000-0000-7000-8000-000000000001";
const TASK2 = "01990000-0000-7000-8000-000000000002";

interface Harness { mgr: WorktreeManager; root: string; close(): void }

function openManager(): Harness {
  const root = tmpDir("morrow-wt-root-");
  return { mgr: new WorktreeManager({ root }), root, close: () => removeDir(root) };
}

// --- WorktreeManager：创建/复用 -------------------------------------------------

test("prepare creates an isolated worktree on a dedicated branch from the base commit", async () => {
  const repo = makeRepo({ "src/a.txt": "alpha\n" });
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    assert.equal(record.taskId, TASK);
    assert.equal(record.key, "code_a");
    assert.equal(record.repoPath, realpathSync(repo.dir), "主区顶层经 git 解析（macOS /var → /private/var）");
    assert.equal(record.base, repo.head, "基线 = 准备时刻主区 HEAD");
    assert.ok(record.dir.startsWith(h.root), "worktree 落在管理器根目录下");
    assert.ok(record.dir.includes(TASK) && record.dir.includes("code_a"));
    assert.equal(record.branch, `morrow/${TASK}/code_a`);
    // 节点工作目录 = worktree：内容来自仓库，但不是主区本身
    assert.equal(readFileSync(join(record.dir, "src/a.txt"), "utf8"), "alpha\n");
    assert.notEqual(record.dir, repo.dir);
    // 独立分支：主区 worktree 列表包含它
    const list = repo.git(["worktree", "list", "--porcelain"]);
    assert.ok(list.includes(record.dir), "主区应登记该 worktree");
    assert.equal(statSync(join(record.dir, ".git")).isDirectory(), false, "worktree 的 .git 是文件指针不是目录");
  } finally {
    repo.close();
    h.close();
  }
});

test("prepare honors the declared baseline branch; unknown branch is rejected", async () => {
  const repo = makeRepo();
  repo.commitFile("other.txt", "x\n", "second commit on main");
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "n", branch: "main" });
    assert.equal(record.base, repo.git(["rev-parse", "main"]).trim(), "基线解析声明的分支");
    await assert.rejects(
      () => h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n2", key: "n2", branch: "ghost" }),
      (err: unknown) => err instanceof WorktreeError && err.code === "git_failed",
    );
  } finally {
    repo.close();
    h.close();
  }
});

test("prepare is idempotent: reuse resets the worktree to a clean base for the next attempt", async () => {
  const repo = makeRepo({ "src/a.txt": "alpha\n" });
  const h = openManager();
  try {
    const first = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    // 上一次尝试留下的脏状态（未提交修改 + 未跟踪文件）
    writeFileSync(join(first.dir, "src/a.txt"), "dirty\n");
    writeFileSync(join(first.dir, "scratch.txt"), "untracked\n");
    const second = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    assert.equal(second.dir, first.dir, "同任务同节点复用同一目录");
    assert.equal(second.branch, first.branch);
    assert.equal(second.base, first.base);
    assert.equal(readFileSync(join(second.dir, "src/a.txt"), "utf8"), "alpha\n", "复用即重置回基线");
    assert.equal(existsSync(join(second.dir, "scratch.txt")), false, "未跟踪残留被清掉");
  } finally {
    repo.close();
    h.close();
  }
});

test("prepare on a non-git directory fails with not_a_repo", async () => {
  const h = openManager();
  const notRepo = tmpDir("morrow-not-repo-");
  try {
    await assert.rejects(
      () => h.mgr.prepare({ repoPath: notRepo, taskId: TASK, nodeId: "n1", key: "n" }),
      (err: unknown) => err instanceof WorktreeError && err.code === "not_a_repo",
    );
  } finally {
    removeDir(notRepo);
    h.close();
  }
});

// --- 变更收集与提交 ----------------------------------------------------------------

test("collectChanges reports added/modified/deleted files with post-change content", async () => {
  const repo = makeRepo({ "src/keep.txt": "keep\n", "src/drop.txt": "drop\n" });
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    writeFileSync(join(record.dir, "src/keep.txt"), "keep v2\n");
    writeFileSync(join(record.dir, "src/new.txt"), "brand new\n");
    repo.git(["rm", "-f", "src/drop.txt"], { cwd: record.dir });
    const changes = await h.mgr.collectChanges(record);
    const byPath = new Map(changes.map((c) => [c.path, c]));
    assert.equal(byPath.get("src/keep.txt")?.status, "modified");
    assert.equal(byPath.get("src/keep.txt")?.content, "keep v2\n");
    assert.equal(byPath.get("src/new.txt")?.status, "added");
    assert.equal(byPath.get("src/new.txt")?.content, "brand new\n");
    assert.equal(byPath.get("src/drop.txt")?.status, "deleted");
    assert.equal(byPath.get("src/drop.txt")?.content, null);
    // 相对基线的变更：未触碰的文件不出现
    assert.equal(byPath.get("README.md"), undefined);
  } finally {
    repo.close();
    h.close();
  }
});

test("commitChanges commits the changeset; an empty worktree commits nothing", async () => {
  const repo = makeRepo();
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    const empty = await h.mgr.commitChanges(record, "nothing happened");
    assert.equal(empty.commit, null, "空变更不产生提交");
    assert.equal(empty.files, 0);
    writeFileSync(join(record.dir, "feature.txt"), "feature\n");
    const committed = await h.mgr.commitChanges(record, "morrow: feature");
    assert.ok(committed.commit, "非空变更产生提交");
    assert.equal(committed.files, 1);
    const branchHead = repo.git(["rev-parse", record.branch]).trim();
    assert.equal(committed.commit, branchHead, "提交落在 worktree 分支上");
  } finally {
    repo.close();
    h.close();
  }
});

// --- 合并（冲突检测 / 验证 / 回滚）-------------------------------------------------

test("mergeToBase merges a clean changeset back into the main checkout", async () => {
  const repo = makeRepo({ "src/a.txt": "alpha\n" });
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    writeFileSync(join(record.dir, "src/a.txt"), "alpha v2\n");
    await h.mgr.commitChanges(record, "change a");
    const outcome = await h.mgr.mergeToBase(record);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.ok(outcome.merged_commit);
      assert.deepEqual(outcome.files, ["src/a.txt"]);
    }
    assert.equal(readFileSync(join(repo.dir, "src/a.txt"), "utf8"), "alpha v2\n", "主区拿到合并结果");
  } finally {
    repo.close();
    h.close();
  }
});

test("mergeToBase detects a conflict with main-side changes and aborts leaving main intact", async () => {
  const repo = makeRepo({ "shared.txt": "base\n" });
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    // 主区先推进（模拟兄弟节点先合并）
    repo.commitFile("shared.txt", "main moved first\n", "main-side change");
    // worktree 同文件撞车
    writeFileSync(join(record.dir, "shared.txt"), "worktree change\n");
    await h.mgr.commitChanges(record, "worktree-side change");
    const outcome = await h.mgr.mergeToBase(record);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.kind, "conflict");
      assert.deepEqual(outcome.files, ["shared.txt"]);
    }
    assert.equal(readFileSync(join(repo.dir, "shared.txt"), "utf8"), "main moved first\n", "abort 后主区不被污染");
    assert.equal(repo.git(["status", "--porcelain"]).trim(), "", "主区工作区干净（无残留冲突标记）");
  } finally {
    repo.close();
    h.close();
  }
});

test("mergeToBase runs the declared verify command in the main checkout and rolls back on failure", async () => {
  const repo = makeRepo({ "src/a.txt": "alpha\n" });
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    writeFileSync(join(record.dir, "src/a.txt"), "alpha v2\n");
    await h.mgr.commitChanges(record, "change a");
    // 验证命令在主区目录执行：断言合并产物存在
    const okOutcome = await h.mgr.mergeToBase(record, { verify: "test -f src/a.txt && grep -q 'v2' src/a.txt" });
    assert.equal(okOutcome.ok, true);

    // 失败的验证命令 → 合并回滚（主区回到合并前 HEAD）
    const record2 = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n2", key: "code_b" });
    writeFileSync(join(record2.dir, "src/b.txt"), "beta\n");
    await h.mgr.commitChanges(record2, "change b");
    const preHead = repo.git(["rev-parse", "HEAD"]).trim();
    const bad = await h.mgr.mergeToBase(record2, { verify: "test -f missing.txt" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.kind, "verify_failed");
    assert.equal(repo.git(["rev-parse", "HEAD"]).trim(), preHead, "验证失败 → 合并回滚");
    assert.equal(existsSync(join(repo.dir, "src/b.txt")), false, "回滚后主区没有合并产物");
    assert.equal(repo.git(["status", "--porcelain"]).trim(), "");
  } finally {
    repo.close();
    h.close();
  }
});

test("mergeToBase fails honestly when the worktree produced no changes (empty diff)", async () => {
  const repo = makeRepo();
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    await h.mgr.commitChanges(record, "empty").then((r) => assert.equal(r.commit, null));
    const outcome = await h.mgr.mergeToBase(record);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.kind, "empty_merge");
      assert.match(outcome.error ?? "", /no changes|empty/i);
    }
    assert.equal(repo.git(["rev-parse", "HEAD"]).trim(), repo.head, "主区不变");
  } finally {
    repo.close();
    h.close();
  }
});

// --- 生命周期：清理与残留清扫 -------------------------------------------------------

test("cleanup removes the worktree dir and its branch; main repo is pruned", async () => {
  const repo = makeRepo();
  const h = openManager();
  try {
    const record = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" });
    await h.mgr.cleanup(record);
    assert.equal(existsSync(record.dir), false, "worktree 目录被移除");
    const list = repo.git(["worktree", "list", "--porcelain"]);
    assert.ok(!list.includes(record.dir), "主区不再登记该 worktree");
    assert.throws(() => repo.git(["rev-parse", "--verify", record.branch]), "分支被删除");
    assert.ok(!existsSync(join(h.root, TASK)), "任务目录清空");
  } finally {
    repo.close();
    h.close();
  }
});

test("sweepStale removes worktrees of tasks that are not alive; keeps the rest", async () => {
  const repo = makeRepo();
  const h = openManager();
  try {
    const kept = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK, nodeId: "n1", key: "code_a" }) as WorktreeRecord;
    const stale = await h.mgr.prepare({ repoPath: repo.dir, taskId: TASK2, nodeId: "n1", key: "code_b" }) as WorktreeRecord;
    // 残留场景：worktree 里还有未提交脏状态
    writeFileSync(join(stale.dir, "dirty.txt"), "residue\n");
    const swept = await h.mgr.sweepStale((taskId) => taskId === TASK);
    assert.deepEqual(swept, [TASK2]);
    assert.equal(existsSync(kept.dir), true, "存活任务的 worktree 保留");
    assert.equal(existsSync(stale.dir), false, "残留 worktree 被清扫");
    assert.throws(() => repo.git(["rev-parse", "--verify", stale.branch]), "残留分支删除");
    assert.equal(repo.git(["status", "--porcelain"]).trim(), "", "清扫后主区干净");
  } finally {
    repo.close();
    h.close();
  }
});

// --- LockTable -------------------------------------------------------------------

test("LockTable: acquire is all-or-nothing; release frees; sweep clears residue", () => {
  const dir = tmpDir("morrow-locks-");
  const db = openSqlite(join(dir, "events.sqlite"));
  try {
    const locks = new LockTable({ db });
    assert.equal(locks.acquireAll(["db:users", "db:orders"], TASK, "n1", "2026-11-02T00:00:00Z"), true);
    assert.deepEqual(locks.list().map((r) => r.lock_key).sort(), ["db:orders", "db:users"]);
    // 同 key 第二个节点拿不到（且不会留下半拿状态）
    assert.equal(locks.acquireAll(["db:users"], TASK2, "n2", "2026-11-02T00:00:01Z"), false);
    assert.equal(locks.acquireAll(["db:users", "db:other"], TASK2, "n2", "2026-11-02T00:00:01Z"), false);
    assert.equal(locks.list().some((r) => r.task_id === TASK2), false, "失败申请不落任何行");
    // 持有者可查
    const holder = locks.holder("db:users");
    assert.equal(holder?.task_id, TASK);
    assert.equal(holder?.node_id, "n1");
    // 释放（按 task+node 粒度）
    locks.releaseAll(TASK, "n1");
    assert.equal(locks.list().length, 0);
    assert.equal(locks.acquireAll(["db:users"], TASK2, "n2", "2026-11-02T00:00:02Z"), true);
    // 崩溃残留清扫（启动时无在跑节点 → 全清）
    assert.equal(locks.sweepStale(() => false), 1);
    assert.equal(locks.list().length, 0);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test("LockTable rows survive a reopen (lock state is durable across process restarts)", () => {
  const dir = tmpDir("morrow-locks-dur-");
  const dbPath = join(dir, "events.sqlite");
  try {
    const first = new LockTable({ db: openSqlite(dbPath) });
    assert.equal(first.acquireAll(["repo:demo"], TASK, "n1", "2026-11-02T00:00:00Z"), true);
    // 不 close：模拟另一个连接打开同一库
    const second = new LockTable({ db: openSqlite(dbPath) });
    assert.equal(second.acquireAll(["repo:demo"], TASK2, "n2", "2026-11-02T00:00:01Z"), false, "跨连接可见");
    second.sweepStale(() => false);
    second.close();
    first.close();
  } finally {
    removeDir(dir);
  }
});
