// Best 拆票与实现确认门（票 M7-C-T7 / Issue #81，FR-C14/C15/C16）。
//
// 最核心的两条断言：
//   1. **未过实现门时，无分支、无 DAG、无写操作**（且完全权限模式下也一样）；
//   2. 实现阶段**不 push**（远端引用未变）。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createFakePi } from "@morrow/pi-adapter";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { DefaultWorkspaceManager } from "../src/workspace.ts";
import {
  IMPLEMENT_GATE_NOTICE,
  canEnterImplement,
  findCycle,
  implementBranch,
  orderTickets,
  specFilePath,
  ticketFilePath,
  ticketIndexMarkdown,
  ticketMarkdown,
  validateTickets,
  type TicketSpec,
} from "../src/best/tickets.ts";
import { gateApproved } from "../src/best/tickets-service.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const GOOD_SPEC = `# 加导出按钮

## Problem Statement
用户无法带走配置。

## Solution
加导出按钮。

## User Stories
1. 作为 Owner，我要导出配置，以便备份。

## Implementation Decisions
新增导出端点。

## Testing Decisions
HTTP 黑盒。

## Out of Scope
不做导入。
`;

const TICKETS: TicketSpec[] = [
  { title: "加导出端点", what_to_build: "提供 GET /export 返回配置 JSON", criteria: ["返回 200 且 body 含 version"], blocked_by: [] },
  {
    title: "加前端按钮",
    what_to_build: "设置页加导出按钮并下载",
    criteria: ["点按钮触发下载"],
    blocked_by: ["加导出端点"],
  },
];

// --- 拆票校验（纯逻辑）-------------------------------------------------------------

test("合法票通过校验；依赖顺序按拓扑序", () => {
  const result = validateTickets(TICKETS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const ordered = orderTickets(result.plan.tickets);
  assert.deepEqual(ordered.map((ticket) => ticket.title), ["加导出端点", "加前端按钮"]);
});

test("缺 title / what_to_build / 验收 → 逐条报出", () => {
  const result = validateTickets([{ title: "", what_to_build: "", criteria: [] }]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.problems.some((problem) => problem.includes("title")));
    assert.ok(result.problems.some((problem) => problem.includes("what_to_build")));
    assert.ok(result.problems.some((problem) => problem.includes("acceptance")));
  }
});

test("引用不存在的阻塞票 → 拒绝（依赖图不能是假的）", () => {
  const result = validateTickets([
    { title: "A", what_to_build: "x", criteria: ["y"], blocked_by: ["Ghost"] },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.problems.some((problem) => problem.includes("Ghost")));
});

test("依赖环 → 拒绝并给出环路径（有环的票永远没人能开始）", () => {
  const result = validateTickets([
    { title: "A", what_to_build: "x", criteria: ["y"], blocked_by: ["B"] },
    { title: "B", what_to_build: "x", criteria: ["y"], blocked_by: ["A"] },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.problems.some((problem) => problem.includes("cycle")));
});

test("findCycle 能直接定位环", () => {
  const cycle = findCycle([
    { title: "A", what_to_build: "x", criteria: ["y"], blocked_by: ["B"] },
    { title: "B", what_to_build: "x", criteria: ["y"], blocked_by: ["C"] },
    { title: "C", what_to_build: "x", criteria: ["y"], blocked_by: ["A"] },
  ]);
  assert.notEqual(cycle, null);
  assert.equal(cycle?.length, 4, "环路径首尾闭合");
});

// --- 产物（纯逻辑）------------------------------------------------------------------

test("票 Markdown 含标题/说明/阻塞/验收", () => {
  const md = ticketMarkdown({ index: 2, ticket: TICKETS[1], specSlug: "add-export" });
  assert.match(md, /^# 02: 加前端按钮/m);
  assert.match(md, /\*\*Blocked by:\*\* 加导出端点/);
  assert.match(md, /- \[ \] 点按钮触发下载/);
  assert.match(md, /docs\/specs\/add-export\.md/);
});

test("index 含依赖图与开工顺序", () => {
  const md = ticketIndexMarkdown({ specSlug: "add-export", tickets: TICKETS });
  assert.match(md, /## 依赖图/);
  assert.match(md, /加导出端点 {2}\(可立即开始\)/);
  assert.match(md, /加前端按钮 {2}← 加导出端点/);
  assert.match(md, /1\. 加导出端点/);
  assert.match(md, /2\. 加前端按钮/);
});

test("路径与分支命名", () => {
  assert.equal(specFilePath("add-export"), "docs/specs/add-export.md");
  assert.equal(
    ticketFilePath({ specSlug: "add-export", index: 1, title: "加导出端点" }),
    "docs/specs/add-export/issues/01-ticket-1.md",
    "纯中文标题退化为序号（不进文件名，避免非 ASCII 文件名问题）",
  );
  assert.equal(implementBranch("add-export"), "feat/add-export");
});

// --- 实现门（纯逻辑）----------------------------------------------------------------

test("**实现门未批准 → 不能进 implement**（这是 FR-C14 的代码层保证）", () => {
  const blocked = canEnterImplement({ stage: "tickets", implementApproved: false, approvedAt: null });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.match(blocked.reason, /cannot be skipped/);
    assert.match(blocked.reason, /full-permission/);
  }
  assert.equal(canEnterImplement({ stage: "tickets", implementApproved: true, approvedAt: null }).ok, true);
});

test("不在 tickets 阶段也进不了 implement", () => {
  const early = canEnterImplement({ stage: "spec", implementApproved: true, approvedAt: null });
  assert.equal(early.ok, false);
});

test("门文案明确写出「完全权限也不能跳过」", () => {
  assert.match(IMPLEMENT_GATE_NOTICE, /完全权限/);
  assert.match(IMPLEMENT_GATE_NOTICE, /不能跳过/);
  assert.match(IMPLEMENT_GATE_NOTICE, /不会推送/);
});

test("gateApproved 从账本推导：approve 后为真，abort 后回到假", () => {
  const approve = { event_type: "best.implement_gate_decided", payload: { best_id: "b1", decision: "approve" } };
  const abort = { event_type: "best.aborted", payload: { best_id: "b1" } };
  assert.equal(gateApproved([approve], "b1"), true);
  assert.equal(gateApproved([approve, abort], "b1"), false, "中止后批准失效");
  assert.equal(gateApproved([approve], "b2"), false, "别的 run 的批准不算");
});

// --- HTTP 端到端（真实 git 仓库）---------------------------------------------------

interface Harness {
  handle: RuntimeHandle;
  port: number;
  close(): Promise<void>;
}

async function startBestRuntime(options: { withGh?: boolean } = {}): Promise<Harness> {
  const dir = tmpDir("morrow-best-c7-");
  const handle = await startRuntime(
    { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null } as RuntimeConfig,
    {
      notificationDrainIntervalMs: 0,
      mcpReclaimIntervalMs: 0,
      goalResumeIntervalMs: 0,
      agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
      // 注入凭据链：测试不能依赖本机是否登录了 gh（那会让"未配 gh → 本地文件"
      // 这条路径在开发机上永远测不到）。
      workspaceManager: new DefaultWorkspaceManager({
        workspacesRoot: join(dir, "workspaces"),
        worktreesRoot: join(dir, "worktrees", "sessions"),
        tokenProvider: async () => (options.withGh === true ? "fake-token" : null),
      }),
    },
  );
  return {
    handle,
    port: handle.port,
    async close() {
      await handle.close();
      removeDir(dir);
    },
  };
}

function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createSession(port: number): Promise<string> {
  return (await json<{ session_id: string }>(await post(port, "/v1/sessions", {}))).session_id;
}

/** 造一个真实 git 仓库（Best 实现阶段需要真分支） */
function makeGitRepo(): string {
  const dir = tmpDir("morrow-best-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("sh", ["-c", "echo hello > src/a.txt"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function driveToTickets(port: number, sessionId: string): Promise<string> {
  const started = await post(port, "/v1/best", { session_id: sessionId, idea: "加导出按钮" });
  const bestId = (await json<{ run: { best_id: string } }>(started)).run.best_id;
  await post(port, `/v1/best/${bestId}/spec`, { markdown: GOOD_SPEC });
  const approved = await post(port, `/v1/best/${bestId}/spec-gate`, { decision: "approve" });
  assert.equal(approved.status, 200, await approved.clone().text());
  return bestId;
}

test("HTTP：拆票（无确认门）→ 本地一票一文件 + index", async () => {
  const h = await startBestRuntime();
  const repo = makeGitRepo();
  try {
    const sessionId = await createSession(h.port);
    // 绑定工作区（票要写进工作区）
    const bound = await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local", path: repo }),
    });
    assert.equal(bound.status, 200, await bound.clone().text());

    const bestId = await driveToTickets(h.port, sessionId);
    const res = await post(h.port, `/v1/best/${bestId}/tickets`, { tickets: TICKETS });
    assert.equal(res.status, 201, await res.clone().text());
    const body = await json<{
      artifact: { kind: string; files: string[]; order: string[] };
      next: string;
    }>(res);
    assert.equal(body.artifact.kind, "local_files", "未配 gh 时应走本地文件");
    assert.equal(body.next, "implement_gate");

    // 真文件落盘
    for (const relative of body.artifact.files) {
      assert.equal(existsSync(join(repo, relative)), true, `缺少产物：${relative}`);
    }
    // 用 artifact 给出的实际路径读（slug 由标题生成，中文标题会退化为哈希）
    const indexPath = body.artifact.files.find((file) => file.endsWith("issues/index.md"));
    assert.ok(indexPath !== undefined, `产物里应有 index.md；实际 ${JSON.stringify(body.artifact.files)}`);
    assert.match(readFileSync(join(repo, indexPath), "utf8"), /可立即开始/);
  } finally {
    await h.close();
    removeDir(repo);
  }
});

test("HTTP：**未过实现门 → 无分支、无 DAG、无写操作**（关键断言）", async () => {
  const h = await startBestRuntime();
  const repo = makeGitRepo();
  try {
    const sessionId = await createSession(h.port);
    await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local", path: repo }),
    });
    const bestId = await driveToTickets(h.port, sessionId);
    await post(h.port, `/v1/best/${bestId}/tickets`, { tickets: TICKETS });

    // 记录"实现前"的仓库状态
    const branchesBefore = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" });
    const filesBefore = execFileSync("sh", ["-c", "find . -path ./.git -prune -o -type f -print | sort"], {
      cwd: repo,
      encoding: "utf8",
    });

    // 直接调实现（没过门）→ 拒绝
    const blocked = await post(h.port, `/v1/best/${bestId}/implement`, {});
    assert.notEqual(blocked.status, 201, "未过门不该启动实现");
    const error = await json<{ error: { code: string; message: string } }>(blocked);
    assert.equal(error.error.code, "invalid_stage");
    assert.match(error.error.message, /cannot be skipped/);

    // 关键：仓库没被碰过
    const branchesAfter = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" });
    const filesAfter = execFileSync("sh", ["-c", "find . -path ./.git -prune -o -type f -print | sort"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(branchesAfter, branchesBefore, "未过门不该新建分支");
    assert.equal(filesAfter, filesBefore, "未过门不该写任何文件");

    // 也没有 Task 被创建
    const tasks = await json<{ tasks: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/tasks`));
    assert.equal(tasks.tasks.length, 0, "未过门不该展开 DAG");
  } finally {
    await h.close();
    removeDir(repo);
  }
});

test("HTTP：**完全权限模式下实现门仍然拦得住**（FR-C14 的核心）", async () => {
  const h = await startBestRuntime();
  const repo = makeGitRepo();
  try {
    const sessionId = await createSession(h.port);
    await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local", path: repo }),
    });
    const bestId = await driveToTickets(h.port, sessionId);
    await post(h.port, `/v1/best/${bestId}/tickets`, { tickets: TICKETS });

    // 切到完全权限
    const mode = await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/exec-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "full_access" }),
    });
    assert.equal(mode.status, 200);

    const branchesBefore = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" });

    // 完全权限下没过门照样拒
    const blocked = await post(h.port, `/v1/best/${bestId}/implement`, {});
    assert.equal(blocked.status, 409, `完全权限下也必须拦；实际 ${blocked.status}`);
    assert.equal((await json<{ error: { code: string } }>(blocked)).error.code, "invalid_stage");

    const branchesAfter = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" });
    assert.equal(branchesAfter, branchesBefore, "完全权限下未过门同样不该建分支");
  } finally {
    await h.close();
    removeDir(repo);
  }
});

test("HTTP：过门 → 建 feat 分支 + Task DAG + 不 push", async () => {
  const h = await startBestRuntime();
  const repo = makeGitRepo();
  try {
    const sessionId = await createSession(h.port);
    await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local", path: repo }),
    });
    const bestId = await driveToTickets(h.port, sessionId);
    await post(h.port, `/v1/best/${bestId}/tickets`, { tickets: TICKETS });

    // 过门
    const gate = await post(h.port, `/v1/best/${bestId}/implement-gate`, {});
    assert.equal(gate.status, 200, await gate.clone().text());

    // 启动实现
    const started = await post(h.port, `/v1/best/${bestId}/implement`, {});
    assert.equal(started.status, 201, await started.clone().text());
    const body = await json<{
      branch: string;
      workspace_path: string;
      task_id: string;
      pushed: boolean;
    }>(started);
    assert.match(body.branch, /^feat\//);
    assert.equal(body.pushed, false, "实现阶段不 push");

    // 分支真实存在（在 repo 的分支列表里）
    const branches = execFileSync("git", ["branch", "--list", body.branch], { cwd: repo, encoding: "utf8" });
    assert.match(branches, new RegExp(body.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // Task 被创建
    const tasks = await json<{ tasks: Array<{ task_id: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/tasks`),
    );
    assert.ok(tasks.tasks.some((task) => task.task_id === body.task_id));

    // 远端引用未变（本仓库没有 remote，所以断言"没有 remote 被创建/push"）
    const remotes = execFileSync("git", ["remote"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(remotes, "", "不该自动配远端或推送");
  } finally {
    await h.close();
    removeDir(repo);
  }
});

test("HTTP：push-plan 只返回指令，不执行", async () => {
  const h = await startBestRuntime();
  const repo = makeGitRepo();
  try {
    const sessionId = await createSession(h.port);
    await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local", path: repo }),
    });
    const bestId = await driveToTickets(h.port, sessionId);
    await post(h.port, `/v1/best/${bestId}/tickets`, { tickets: TICKETS });
    await post(h.port, `/v1/best/${bestId}/implement-gate`, {});
    const started = await json<{ branch: string }>(await post(h.port, `/v1/best/${bestId}/implement`, {}));

    const plan = await json<{ commands: string[]; notice: string; branch: string }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/best/${bestId}/push-plan`),
    );
    assert.equal(plan.branch, started.branch);
    assert.ok(plan.commands.some((command) => command.includes("git push")));
    assert.match(plan.notice, /不会自动执行/);

    // 仍然没有 remote（指令只是指令）
    assert.equal(execFileSync("git", ["remote"], { cwd: repo, encoding: "utf8" }).trim(), "");
  } finally {
    await h.close();
    removeDir(repo);
  }
});

test("HTTP：中止 → aborted，遗留分支明示（不自动删）", async () => {
  const h = await startBestRuntime();
  const repo = makeGitRepo();
  try {
    const sessionId = await createSession(h.port);
    await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local", path: repo }),
    });
    const bestId = await driveToTickets(h.port, sessionId);
    await post(h.port, `/v1/best/${bestId}/tickets`, { tickets: TICKETS });
    await post(h.port, `/v1/best/${bestId}/implement-gate`, {});
    const started = await json<{ branch: string }>(await post(h.port, `/v1/best/${bestId}/implement`, {}));

    const aborted = await post(h.port, `/v1/best/${bestId}/abort`, { reason: "不做了" });
    const body = await json<{ run: { status: string }; leftovers: { branch: string | null } }>(aborted);
    assert.equal(body.run.status, "aborted");
    assert.equal(body.leftovers.branch, started.branch, "遗留分支要明示");

    // 分支仍然存在（不自动删：删错东西比留空分支危险）
    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" });
    assert.match(branches, new RegExp(started.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await h.close();
    removeDir(repo);
  }
});
