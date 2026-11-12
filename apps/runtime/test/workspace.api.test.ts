// 会话工作区与附件 HTTP 主接缝测试（票 M7-A-T4 / Issue #61）：
// - PUT /v1/sessions/:id/workspace 三形态（local/github/none）；
// - github 路径走注入的 WorkspaceManager（不触真实 git/gh），分支默认 morrow/<6位id>；
// - 分支冲突 409、clone 失败带 PAT/gh 提示（不静默）；
// - 附件添加/列表/移除 + 摘要 attachment_count + 账本事件；
// - 附件注入只进发给 Agent 的 prompt（message.user 账本仍是原文），文件未被写入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createFakePi, type AgentRuntime } from "@morrow/pi-adapter";
import type { EventEnvelope, SessionAttachment, SessionWorkspace } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { WorkspaceError, type WorkspaceManager } from "../src/workspace.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface SessionSummary {
  session_id: string;
  workspace?: SessionWorkspace;
  attachment_count: number;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** 注入的 WorkspaceManager：记录调用，默认全成功；按测试覆盖失败路径。 */
function fakeWorkspace(overrides: Partial<WorkspaceManager> = {}): WorkspaceManager & { calls: string[] } {
  const calls: string[] = [];
  const base: WorkspaceManager = {
    async bindLocal(path) {
      calls.push(`bindLocal:${path}`);
      return { path, repoPath: "/fake/repo", branch: "main" };
    },
    async cloneFrom(url) {
      calls.push(`cloneFrom:${url}`);
      return { path: "/fake/workspaces/repo-abc123", repoPath: "/fake/workspaces/repo-abc123", url, reused: false };
    },
    async ensureBranch(repoPath, base, name) {
      calls.push(`ensureBranch:${repoPath}:${base ?? "auto"}:${name}`);
      return { branch: name, base: base ?? "main", baseCommit: "deadbeef", created: true };
    },
    async prepareWorktree(repoPath, branch, sessionId) {
      calls.push(`prepareWorktree:${sessionId}`);
      return { dir: `/fake/worktrees/${sessionId}`, branch, repoPath };
    },
    async readGhToken() {
      calls.push("readGhToken");
      return null;
    },
    async attach(paths) {
      calls.push(`attach:${paths.join(",")}`);
      return paths.map((path) => {
        const content = readFileSync(path, "utf8");
        return { path, name: basename(path), size: Buffer.byteLength(content), content, truncated: false };
      });
    },
    async status() {
      return { isRepo: true, repoPath: "/fake/repo", branch: "main", dirtyFiles: 0 };
    },
    async uncommittedChanges() {
      calls.push("uncommittedChanges");
      return [];
    },
    async commitChanges(_dir, message) {
      calls.push(`commitChanges:${message}`);
      return { commit: "deadbeef", files: ["README.md"] };
    },
    async discardChanges(sessionId) {
      calls.push(`discardChanges:${sessionId}`);
      return { discarded: 1, files: ["README.md"] };
    },
  };
  return Object.assign(base, overrides, { calls });
}

function capturingFactory(prompts: string[]): () => Promise<AgentRuntime> {
  return async () => {
    const base = await createFakePi({ script: [{ kind: "text", deltas: ["好的"] }] });
    return {
      prompt: async (input) => {
        prompts.push(typeof input === "string" ? input : JSON.stringify(input));
        return base.prompt(input);
      },
      subscribe: base.subscribe,
      abort: base.abort,
      waitForIdle: base.waitForIdle,
      dispose: base.dispose,
    };
  };
}

async function createSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 201);
  return (await json<{ session_id: string }>(res)).session_id;
}

async function bindWorkspace(
  port: number,
  sessionId: string,
  body: unknown,
): Promise<{ status: number; body: { session_id?: string; workspace?: SessionWorkspace | null; reused?: boolean } & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/workspace`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as never };
}

async function addAttachments(
  port: number,
  sessionId: string,
  paths: string[],
): Promise<{ status: number; body: { attachments?: SessionAttachment[]; attachment_count?: number } & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  return { status: res.status, body: (await res.json()) as never };
}

async function listSessions(port: number): Promise<SessionSummary[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`);
  assert.equal(res.status, 200);
  return (await json<{ sessions: SessionSummary[] }>(res)).sessions;
}

async function events(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

async function sendMessage(port: number, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
}

async function history(port: number, sessionId: string): Promise<{ messages: Array<{ role: string; text: string }> }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`);
  assert.equal(res.status, 200);
  return json(res);
}

test("三种工作区来源：local / github / none 均可绑定，摘要与事件可查", async () => {
  const dir = tmpDir("morrow-ws-api-");
  const workspace = fakeWorkspace();
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: capturingFactory([]),
    workspaceManager: workspace,
  });
  try {
    const sessionId = await createSession(runtime.port);

    const local = await bindWorkspace(runtime.port, sessionId, { kind: "local", path: "/tmp/project" });
    assert.equal(local.status, 200);
    assert.deepEqual(local.body.workspace, {
      kind: "local",
      path: "/tmp/project",
      repo_path: "/fake/repo",
      branch: "main",
    });

    const github = await bindWorkspace(runtime.port, sessionId, {
      kind: "github",
      url: "https://github.com/acme/widget.git",
    });
    assert.equal(github.status, 200);
    const ws = github.body.workspace as SessionWorkspace;
    assert.equal(ws.kind, "github");
    assert.equal(ws.path, `/fake/worktrees/${sessionId}`);
    assert.equal(ws.repo_path, "/fake/workspaces/repo-abc123");
    assert.equal(ws.branch, `morrow/${sessionId.slice(0, 6)}`);
    assert.equal(ws.base_branch, "main");
    assert.equal(ws.url, "https://github.com/acme/widget.git");
    assert.equal(github.body.reused, false);
    // 只走注入实现：clone → ensureBranch → prepareWorktree 顺序
    assert.deepEqual(workspace.calls, [
      "bindLocal:/tmp/project",
      "cloneFrom:https://github.com/acme/widget.git",
      `ensureBranch:/fake/workspaces/repo-abc123:auto:morrow/${sessionId.slice(0, 6)}`,
      `prepareWorktree:${sessionId}`,
    ]);

    let summaries = await listSessions(runtime.port);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].workspace?.branch, `morrow/${sessionId.slice(0, 6)}`);
    assert.equal(summaries[0].attachment_count, 0);

    const bound = (await events(runtime.port)).filter((event) => event.event_type === "session.workspace_bound");
    assert.equal(bound.length, 2, "local + github 各写一条事件");
    assert.equal(bound[0].actor_id, "owner");

    const none = await bindWorkspace(runtime.port, sessionId, { kind: "none" });
    assert.equal(none.status, 200);
    assert.equal(none.body.workspace, null);
    summaries = await listSessions(runtime.port);
    assert.equal(summaries[0].workspace, undefined, "解绑后摘要不再有 workspace");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("github 自定义分支与基线：传入 base_branch/new_branch 原样落到 ensureBranch 与摘要", async () => {
  const dir = tmpDir("morrow-ws-api-branch-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: capturingFactory([]),
    workspaceManager: fakeWorkspace(),
  });
  try {
    const sessionId = await createSession(runtime.port);
    const res = await bindWorkspace(runtime.port, sessionId, {
      kind: "github",
      url: "git@github.com:acme/widget.git",
      base_branch: "develop",
      new_branch: "feature/thing",
    });
    assert.equal(res.status, 200);
    assert.equal((res.body.workspace as SessionWorkspace).branch, "feature/thing");
    assert.equal((res.body.workspace as SessionWorkspace).base_branch, "develop");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("分支冲突（注入实现抛 branch_exists）→ 409，且不写 workspace_bound 事件", async () => {
  const dir = tmpDir("morrow-ws-api-conflict-");
  const workspace = fakeWorkspace({
    async ensureBranch() {
      throw new WorkspaceError("branch_exists", 'branch "morrow/dup" already exists');
    },
  });
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: capturingFactory([]),
    workspaceManager: workspace,
  });
  try {
    const sessionId = await createSession(runtime.port);
    const res = await bindWorkspace(runtime.port, sessionId, {
      kind: "github",
      url: "https://github.com/acme/widget.git",
      new_branch: "morrow/dup",
    });
    assert.equal(res.status, 409);
    assert.equal((res.body as ApiError).error.code, "branch_exists");
    const bound = (await events(runtime.port)).filter((event) => event.event_type === "session.workspace_bound");
    assert.equal(bound.length, 0);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("clone 失败（注入实现抛 clone_failed）→ 502 且提示填 PAT / gh auth login", async () => {
  const dir = tmpDir("morrow-ws-api-clonefail-");
  const workspace = fakeWorkspace({
    async cloneFrom() {
      throw new WorkspaceError(
        "clone_failed",
        "git clone failed: authentication required. If this is a private repository, add a GitHub PAT in Settings or run `gh auth login` first.",
      );
    },
  });
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: capturingFactory([]),
    workspaceManager: workspace,
  });
  try {
    const sessionId = await createSession(runtime.port);
    const res = await bindWorkspace(runtime.port, sessionId, {
      kind: "github",
      url: "https://github.com/acme/private.git",
    });
    assert.equal(res.status, 502);
    const error = (res.body as ApiError).error;
    assert.equal(error.code, "clone_failed");
    assert.ok(error.message.includes("GitHub PAT"));
    assert.ok(error.message.includes("gh auth login"));
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("附件：添加/列表/移除、摘要 attachment_count、事件可查；只进 prompt 但账本保留原文且文件未变", async () => {
  const dir = tmpDir("morrow-ws-api-attach-");
  const prompts: string[] = [];
  const workspace = fakeWorkspace();
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: capturingFactory(prompts),
    workspaceManager: workspace,
  });
  try {
    const file = join(dir, "note.txt");
    writeFileSync(file, "CONTEXT-FOR-AGENT\n");
    const sessionId = await createSession(runtime.port);

    const added = await addAttachments(runtime.port, sessionId, [file]);
    assert.equal(added.status, 200);
    assert.equal(added.body.attachment_count, 1);
    assert.equal(added.body.attachments?.[0].name, "note.txt");

    let summaries = await listSessions(runtime.port);
    assert.equal(summaries[0].attachment_count, 1);

    await sendMessage(runtime.port, sessionId, "请读附件");
    await waitFor("assistant reply", async () => {
      const page = await history(runtime.port, sessionId);
      return page.messages.some((message) => message.role === "assistant");
    });
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes("CONTEXT-FOR-AGENT"), "附件内容进入发给 Agent 的 prompt");
    assert.ok(prompts[0].includes("<附件内容>"), "注入段落有稳定标记");
    assert.ok(prompts[0].startsWith("请读附件"), "用户原文仍在最前");

    const page = await history(runtime.port, sessionId);
    const user = page.messages.find((message) => message.role === "user");
    assert.equal(user?.text, "请读附件", "账本 message.user 不落附件内容");
    assert.equal(readFileSync(file, "utf8"), "CONTEXT-FOR-AGENT\n", "附件文件未被写入");

    const addedEvents = (await events(runtime.port)).filter((event) => event.event_type === "session.attachment_added");
    assert.equal(addedEvents.length, 1);
    assert.equal(addedEvents[0].actor_id, "owner");

    const removed = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sessionId}/attachments`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [file] }),
    });
    assert.equal(removed.status, 200);
    const removedBody = (await removed.json()) as { attachment_count: number; changed: boolean };
    assert.equal(removedBody.attachment_count, 0);
    assert.equal(removedBody.changed, true);

    summaries = await listSessions(runtime.port);
    assert.equal(summaries[0].attachment_count, 0);
    const removedEvents = (await events(runtime.port)).filter((event) => event.event_type === "session.attachment_removed");
    assert.equal(removedEvents.length, 1);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("附件上限由 WorkspaceManager 校验（注入 attachment_too_large → 400）", async () => {
  const dir = tmpDir("morrow-ws-api-attachlimit-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: capturingFactory([]),
    workspaceManager: fakeWorkspace({
      async attach() {
        throw new WorkspaceError("attachment_too_large", "attachment exceeds 262144 bytes: big.txt");
      },
    }),
  });
  try {
    const sessionId = await createSession(runtime.port);
    const res = await addAttachments(runtime.port, sessionId, ["/tmp/big.txt"]);
    assert.equal(res.status, 400);
    assert.equal((res.body as ApiError).error.code, "attachment_too_large");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("未知会话：workspace / attachments 均 404", async () => {
  const dir = tmpDir("morrow-ws-api-404-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: capturingFactory([]),
    workspaceManager: fakeWorkspace(),
  });
  try {
    assert.equal((await bindWorkspace(runtime.port, "nope", { kind: "none" })).status, 404);
    assert.equal((await addAttachments(runtime.port, "nope", ["/tmp/x"])).status, 404);
    const list = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/nope/attachments`);
    assert.equal(list.status, 404);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
