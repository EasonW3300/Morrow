// M7-A code-review 修复回归（#64 A3/A4/A6）：
//   A3 临时会话过期可由账本重放推出：过期 → 触发一次投影重建 → 检索与 overview 都看不到；
//      promote 一个过期条目返回 409 而不是复活。
//   A4 临时会话 403 覆盖面：skill invoke 与任务创建同样 403（不只能力 invoke）。
//   A6 附件上限按累计：分两次各加 6 个 → 第二次 400；attach 抛错不被吞掉。
//
// 全部走 HTTP 控制面（黑盒口径，与既有 memory.ephemeral.api / workspace.api 同款），
// 时钟注入保证 24h 到期判定零 sleep。
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { CapabilityManifest } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { WorkspaceError, type WorkspaceManager } from "../src/workspace.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const HOUR_MS = 60 * 60 * 1000;

interface ApiError {
  error: { code: string; message: string } & Record<string, unknown>;
}

interface FactHit {
  id: string;
  stage: string;
  content: string;
  scope: string;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function fakeFactory(script: FakeStep[] = [{ kind: "text", deltas: ["ok"] }]) {
  return async (_sessionId: string, _provider: unknown, extras?: { tools?: MorrowTool[] }) =>
    createFakePi({ script, tools: extras?.tools ?? [] });
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function postJson(
  port: number,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await json(res)) as Record<string, unknown> & ApiError };
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

async function searchFacts(
  port: number,
  q: string,
  scope?: string,
  includeCandidates = false,
): Promise<FactHit[]> {
  const params = new URLSearchParams({ q });
  if (scope !== undefined) params.set("scope", scope);
  if (includeCandidates) params.set("include", "candidates");
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/facts?${params.toString()}`);
  assert.equal(res.status, 200);
  return (await json<{ facts: FactHit[] }>(res)).facts;
}

/** GET /v1/memory/overview 里所有条目（tree 视图展平；快照重建后断言用） */
async function overviewEntryIds(port: number, scope?: string): Promise<string[]> {
  const params = new URLSearchParams({ view: "tree" });
  if (scope !== undefined) params.set("scope", scope);
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/overview?${params.toString()}`);
  assert.equal(res.status, 200);
  const body = await json<{ groups: Array<{ clusters: Array<{ entries: Array<{ id: string }> }> }> }>(res);
  return body.groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.entries.map((entry) => entry.id)));
}

async function allEvents(port: number): Promise<Array<{ event_type: string; session_id?: string | null }>> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: Array<{ event_type: string; session_id?: string | null }> }>(res)).events;
}

/** 发消息并等整轮收尾（message.assistant + memory.extracted 都落账） */
async function sendAndSettle(port: number, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
  await waitFor("message.assistant", async () =>
    (await allEvents(port)).some((event) => event.event_type === "message.assistant"),
  );
}

// --- A3：过期状态可由账本重放推出 -------------------------------------------

test("A3：过期后触发一次投影重建，检索与 overview 都看不到；账本事件仍在", async () => {
  const dir = tmpDir("morrow-a3-rebuild-");
  let now = new Date("2026-11-12T00:00:00.000Z");
  // 注入时钟的 runtime：sessionNow 同时驱动会话 24h 判定与记忆 sweep/重放推导
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["记住了"] }]),
    sessionNow: () => new Date(now),
  });
  try {
    const sessionId = await createSession(runtime.port, { kind: "ephemeral" });
    const scope = `session:${sessionId}`;
    await sendAndSettle(runtime.port, sessionId, "请记住 我的备用钥匙放在书房抽屉");

    const beforeSearch = await searchFacts(runtime.port, "备用钥匙", scope);
    assert.equal(beforeSearch.length, 1, "关闭前该作用域可见");
    const factId = beforeSearch[0].id;
    assert.deepEqual(await overviewEntryIds(runtime.port, scope), [factId], "overview 关闭前可见");

    assert.equal((await postJson(runtime.port, `/v1/sessions/${sessionId}/close`)).status, 200);
    now = new Date(now.getTime() + 25 * HOUR_MS);

    // 触发一次投影重建（sync 导入 / 启动补建等都会走这条路径）：
    // 重建后过期状态必须由「closed_at + 24h vs now」重新推出，而不是被置回 null。
    runtime.memoryRebuilder.rebuild();
    runtime.memory.sweepExpiredEphemeralScopes();

    assert.deepEqual(await searchFacts(runtime.port, "备用钥匙", scope), [], "重建后检索不到");
    assert.deepEqual(await overviewEntryIds(runtime.port, scope), [], "重建后 overview 也看不到");

    const events = await allEvents(runtime.port);
    assert.ok(events.some((event) => event.event_type === "memory.fact_created"), "账本事实事件仍在");
    assert.ok(
      events.some((event) => event.event_type === "session.ephemeral_closed" && event.session_id === sessionId),
      "关闭事件仍在（过期是推导结果）",
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("A3：promote 过期条目返回 409（不复活）；overview 入口自带 sweep", async () => {
  const dir = tmpDir("morrow-a3-promote-");
  let now = new Date("2026-11-12T00:00:00.000Z");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["记住了"] }]),
    sessionNow: () => new Date(now),
  });
  try {
    const sessionId = await createSession(runtime.port, { kind: "ephemeral" });
    const scope = `session:${sessionId}`;
    await sendAndSettle(runtime.port, sessionId, "请记住 我的航班是周三上午十点");
    const hits = await searchFacts(runtime.port, "航班", scope);
    const factId = hits[0].id;
    assert.equal((await postJson(runtime.port, `/v1/sessions/${sessionId}/close`)).status, 200);

    // 拨快到过期 + 重建（模拟一次投影重建把 expired_at 缓存抹掉）
    now = new Date(now.getTime() + 25 * HOUR_MS);
    runtime.memoryRebuilder.rebuild();

    const promote = await postJson(runtime.port, `/v1/memory/${factId}/promote`);
    assert.equal(promote.status, 409, JSON.stringify(promote.body));
    assert.equal(promote.body.error.code, "memory_invalid_state");
    assert.match(String(promote.body.error.message), /expired/i);

    // 未走检索、直接看 overview：入口 sweep 同样挡住过期条目
    assert.deepEqual(await overviewEntryIds(runtime.port, scope), []);
    // 全局也看不到（没有提升成功）
    assert.deepEqual(await searchFacts(runtime.port, "航班"), []);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- A4：ephemeral 403 覆盖 skill invoke 与任务创建 --------------------------

test("A4：临时会话 skill invoke 403（step 含写入类能力）；普通会话不受影响", async () => {
  const dir = tmpDir("morrow-a4-skill-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(),
    // 注入规划器，让任务侧可用（本用例只测 skill 门禁）
    taskPlannerFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ['{"nodes":[]}'] }] }),
  });
  try {
    // 授权文件系统权限并注册一个写入类能力
    const grants = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filesystem: ["**"], network: [], shell: [], channels: [], credentials: [] }),
    });
    assert.equal(grants.status, 200, JSON.stringify(await grants.clone().json()));

    const manifest: CapabilityManifest = {
      name: "fs.writer",
      version: "1.0.0",
      author: "human",
      runtime: "typescript",
      permissions: { filesystem: ["**"], network: [], shell: [], channels: [], credentials: [] },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: { type: "none", network: "none", filesystem: "none" },
      // human 注册非空 tests = verified（skill 只允许引用 enabled 且 verified 的能力）
      tests: ["writes a note"],
    };
    assert.equal((await postJson(runtime.port, "/v1/capabilities", manifest)).status, 201);

    // 手动提案 skill（引用写入类能力），Owner 批准
    const proposed = await postJson(runtime.port, "/v1/capabilities/skills", {
      name: "write-note",
      description: "写一条笔记",
      steps: [{ capability_id: "fs.writer", arg_mapping: {} }],
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const skillId = String(proposed.body.skill_id ?? "");
    assert.ok(skillId.length > 0);
    const approved = await postJson(runtime.port, `/v1/capabilities/skills/${skillId}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    const denied = await postJson(runtime.port, `/v1/capabilities/skills/${skillId}/invoke`, {
      params: {},
      session_id: ephemeral,
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "capability_forbidden");

    // 普通会话同样调用不被该门拒绝（执行链自身的处置不属本门，只断言不是 403）
    const normal = await createSession(runtime.port, {});
    const allowed = await postJson(runtime.port, `/v1/capabilities/skills/${skillId}/invoke`, {
      params: {},
      session_id: normal,
    });
    assert.notEqual(allowed.status, 403, JSON.stringify(allowed.body));
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("A4：临时会话创建任务 403；普通会话仍可创建（规划器可用）", async () => {
  const dir = tmpDir("morrow-a4-task-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(),
    taskPlannerFactory: async () =>
      createFakePi({
        script: [
          {
            kind: "text",
            deltas: [JSON.stringify({ nodes: [{ key: "a", title: "节点A", goal: "do a", depends_on: [] }] })],
          },
        ],
      }),
    taskNodeAgentFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["done"] }] }),
  });
  try {
    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    const denied = await postJson(runtime.port, "/v1/tasks", { goal: "在临时会话里跑个任务", session_id: ephemeral });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "ephemeral_task_forbidden");

    const normal = await createSession(runtime.port, {});
    const created = await postJson(runtime.port, "/v1/tasks", { goal: "普通会话任务", session_id: normal });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // 无 session_id 的调用不属临时会话（门禁不越权改语义）
    const noSession = await postJson(runtime.port, "/v1/tasks", { goal: "无会话归属任务" });
    assert.equal(noSession.status, 201, JSON.stringify(noSession.body));
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- A6：附件上限按累计 ------------------------------------------------------

/** 注入的 WorkspaceManager：attach 按真实文件读，discard/commit 不参与本用例 */
function attachmentWorkspace(): WorkspaceManager {
  return {
    async bindLocal(path) {
      return { path, repoPath: null, branch: null };
    },
    async cloneFrom(url) {
      return { path: "/fake/repo", repoPath: "/fake/repo", url, reused: false };
    },
    async ensureBranch(_repoPath, base, name) {
      return { branch: name, base: base ?? "main", baseCommit: "deadbeef", created: true };
    },
    async prepareWorktree(_repoPath, branch, sessionId) {
      return { dir: `/fake/worktrees/${sessionId}`, branch, repoPath: "/fake/repo" };
    },
    async readGhToken() {
      return null;
    },
    async attach(paths) {
      const { readFileSync } = await import("node:fs");
      const { basename } = await import("node:path");
      return paths.map((path) => {
        const content = readFileSync(path, "utf8");
        return { path, name: basename(path), size: Buffer.byteLength(content), content, truncated: false };
      });
    },
    async status() {
      return { isRepo: false, repoPath: null, branch: null, dirtyFiles: 0 };
    },
    async uncommittedChanges() {
      return [];
    },
    async commitChanges() {
      return { commit: "deadbeef", files: [] };
    },
    async discardChanges() {
      return { discarded: 0, files: [] };
    },
  };
}

async function addAttachments(
  port: number,
  sessionId: string,
  paths: string[],
): Promise<{ status: number; body: Record<string, unknown> & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & ApiError };
}

test("A6：分两次各加 6 个附件 → 第二次 400（上限按会话累计，不是单次请求）", async () => {
  const dir = tmpDir("morrow-a6-cumulative-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(),
    workspaceManager: attachmentWorkspace(),
  });
  try {
    const sessionId = await createSession(runtime.port);
    const paths: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const path = join(dir, `note-${index}.txt`);
      writeFileSync(path, `content ${index}\n`);
      paths.push(path);
    }

    const first = await addAttachments(runtime.port, sessionId, paths.slice(0, 6));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.attachment_count, 6);

    const second = await addAttachments(runtime.port, sessionId, paths.slice(6, 12));
    assert.equal(second.status, 400, JSON.stringify(second.body));
    assert.equal(second.body.error.code, "attachment_limit_exceeded");
    assert.match(String(second.body.error.message), /12/);
    assert.match(String(second.body.error.message), /10/);

    // 失败不改状态：仍是 6 个，且没有新的 attachment_added 事件
    const list = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sessionId}/attachments`);
    const listed = (await json<{ attachment_count: number }>(list)).attachment_count;
    assert.equal(listed, 6);
    const addedEvents = (await allEvents(runtime.port)).filter((event) => event.event_type === "session.attachment_added");
    assert.equal(addedEvents.length, 1);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("A6：attach 抛错不被吞掉——添加附件返回错误码（不静默整批失效）", async () => {
  const dir = tmpDir("morrow-a6-attach-error-");
  const workspace = attachmentWorkspace();
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(),
    workspaceManager: {
      ...workspace,
      async attach() {
        throw new WorkspaceError("invalid_attachment", "attachment does not exist: /tmp/missing.txt");
      },
    },
  });
  try {
    const sessionId = await createSession(runtime.port);
    const res = await addAttachments(runtime.port, sessionId, ["/tmp/missing.txt"]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "invalid_attachment");
    assert.equal(await searchFacts(runtime.port, "anything").then((facts) => facts.length), 0);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- A2：两个真实会话在同一仓库建默认分支（HTTP 端到端）---------------------

test("A2：两个真实会话对同一仓库用默认分支名 → 两条不同分支，且都真实存在", async () => {
  const root = tmpDir("morrow-a2-http-");
  const { execFileSync } = await import("node:child_process");
  const git = (cwd: string, args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Morrow Test",
        GIT_AUTHOR_EMAIL: "test@morrow.local",
        GIT_COMMITTER_NAME: "Morrow Test",
        GIT_COMMITTER_EMAIL: "test@morrow.local",
      },
      encoding: "utf8",
      timeout: 60_000,
    });

  // 裸远端 + main 种子（真实 file:// clone + worktree）
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

  const { DefaultWorkspaceManager } = await import("../src/workspace.ts");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "workspaces"), { recursive: true });
  const workspace = new DefaultWorkspaceManager({
    workspacesRoot: join(root, "workspaces"),
    worktreesRoot: join(root, "worktrees"),
    tokenProvider: async () => null,
  });
  const runtime = await startRuntime(testConfig(join(root, "data")), {
    agentAdapterFactory: fakeFactory(),
    workspaceManager: workspace,
  });
  try {
    // 两个会话（uuidv7 由 runtime 生成；同一毫秒创建也不影响——短 id 取尾部随机位）
    const [first, second] = await Promise.all([
      createSession(runtime.port, { title: "甲" }),
      createSession(runtime.port, { title: "乙" }),
    ]);
    const bind = async (sessionId: string) => {
      const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sessionId}/workspace`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "github", url: `file://${bare}` }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> & ApiError };
    };

    const firstBind = await bind(first);
    const secondBind = await bind(second);
    assert.equal(firstBind.status, 200, JSON.stringify(firstBind.body));
    assert.equal(secondBind.status, 200, JSON.stringify(secondBind.body));

    const firstBranch = (firstBind.body.workspace as { branch: string }).branch;
    const secondBranch = (secondBind.body.workspace as { branch: string }).branch;
    assert.notEqual(firstBranch, secondBranch, "两个会话的默认分支名必须不同");
    assert.match(firstBranch, /^morrow\//);
    assert.match(secondBranch, /^morrow\//);

    // 分支真实存在于主 clone（repo_path 由服务端返回，目录名含 URL 短哈希）
    const repoPath = (firstBind.body.workspace as { repo_path: string }).repo_path;
    const listed = git(repoPath, ["branch", "--list", "morrow/*"])
      .split("\n")
      // 前缀标记：`*` = 当前分支、`+` = 被其它 worktree 检出
      .map((line) => line.replace(/^[*+]\s*/, "").trim())
      .filter((line) => line.length > 0);
    assert.ok(listed.includes(firstBranch), `git branch --list 应含 ${firstBranch}；实际 ${JSON.stringify(listed)}`);
    assert.ok(listed.includes(secondBranch), `git branch --list 应含 ${secondBranch}`);

    // 两个 worktree 各自的 HEAD 分支正确
    const firstPath = (firstBind.body.workspace as { path: string }).path;
    const secondPath = (secondBind.body.workspace as { path: string }).path;
    assert.equal(git(firstPath, ["branch", "--show-current"]).trim(), firstBranch);
    assert.equal(git(secondPath, ["branch", "--show-current"]).trim(), secondBranch);
  } finally {
    await runtime.close();
    removeDir(root);
  }
});
