// 双 Worker 并行证明（票 M2-T4 / Issue #25，PRD §4.3 FR-TASK-8、§4.7 FR-EVO-2、AC-08 前置）：
// - 同 DAG 两个无冲突代码节点在两个独立 worktree 并行执行（互不可见中间状态）+ 自动合并；
// - 两节点声明同 lock → 串行化（锁生效）；无锁节点照常并行；
// - 预置冲突场景 → 合并冲突检测 → 节点 pending_review + task.merge_conflict + 任务 waiting_input；
// - 合并验证（节点声明的 verify 命令 / diff 非空断言）有事件留痕；
// - 沙箱协作：sandboxed 能力调用的 workspace 指向节点 worktree（与 T2 契约对齐）。
// 全部零网络：FakePi 注入 + 真实 git 夹具仓库（本地 git 子进程）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePi, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import { EventLedger, DB_FILE_NAME } from "../src/ledger.ts";
import { TaskScheduler, type NodeAgentFactory, type NodeWorkspaceInfo } from "../src/scheduler.ts";
import { CheckpointService } from "../src/checkpoint.ts";
import { TaskService } from "../src/tasks.ts";
import { LockTable } from "../src/locks.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { openSqlite } from "../src/db.ts";
import type { SandboxRunner, SandboxToolPackage } from "../src/sandbox/runner.ts";
import type { SandboxContract } from "../src/sandbox/contract.ts";
import { ToolInvoker } from "../src/sandbox/invoker.ts";
import { makeRepo, type GitRepoFixture } from "./fixtures/git-repo.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

interface Harness {
  svc: TaskService;
  checkpoints: CheckpointService;
  worktrees: WorktreeManager;
  locks: LockTable;
  dir: string;
  close(): void;
}

function openHarness(plannerOutput: string): Harness {
  const dir = tmpDir("morrow-tasks-parallel-");
  const ledger = EventLedger.open(dir);
  const svc = new TaskService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    factory: async () => createFakePi({ script: [{ kind: "text", deltas: [plannerOutput] }] }),
  });
  const checkpoints = new CheckpointService({ tasks: svc, dataDir: dir, ledger, replicaId: REPLICA });
  const worktrees = new WorktreeManager({ root: join(dir, "worktrees") });
  const locks = new LockTable({ db: openSqlite(join(dir, DB_FILE_NAME)) });
  return {
    svc,
    checkpoints,
    worktrees,
    locks,
    dir,
    close: () => {
      svc.close();
      checkpoints.close();
      locks.close();
      ledger.close();
      removeDir(dir);
    },
  };
}

function makeScheduler(h: Harness, factory: NodeAgentFactory | null, concurrency?: number): TaskScheduler {
  return new TaskScheduler({
    tasks: h.svc,
    ledger: h.svc.ledger,
    replicaId: REPLICA,
    nodeAgentFactory: factory,
    checkpoints: h.checkpoints,
    worktrees: h.worktrees,
    locks: h.locks,
    ...(concurrency === undefined ? {} : { concurrency }),
  });
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function eventsOf(h: Harness, taskId: string): EventEnvelope[] {
  return h.svc.taskEvents(taskId, { limit: 500 })?.events ?? [];
}

function types(events: EventEnvelope[]): string[] {
  return events.map((e) => e.event_type);
}

// --- AC-08 核心：双 worktree 并行 + 互不可见 + 自动合并 ------------------------------

test("two code nodes run in isolated worktrees in parallel, stay mutually invisible, and auto-merge (AC-08 core)", async () => {
  const repo = makeRepo({ "src/a.txt": "a0\n", "src/b.txt": "b0\n" });
  const h = openHarness(planJson([
    { key: "a", title: "A", resources: { git_repo: { path: repo.dir, verify: "test -f src/a.txt" } } },
    { key: "b", title: "B", resources: { git_repo: { path: repo.dir } } },
  ]));
  try {
    const detail = await h.svc.createTask("两个代码节点并行改 repo");
    const taskId = detail.task_id;
    let active = 0;
    let maxActive = 0;
    /** 会合闩：两个节点都写完自己的变更后才一起放行（窗口不会瞬时关闭） */
    const arrived = new Set<string>();
    /** 各节点看到的中间状态（隔离证据）与拿到的 workspace */
    const observed = new Map<string, { workspace: NodeWorkspaceInfo; siblingContent: string }>();
    const factory: NodeAgentFactory = async (node) => {
      // 节点 Agent 的工作目录 = worktree：工厂拿到的 workspace 即执行工作区
      assert.ok(node.workspace, `代码节点 ${node.key} 应拿到 workspace`);
      const ws = node.workspace as NodeWorkspaceInfo;
      assert.equal(ws.branch, `morrow/${taskId}/${node.key}`);
      assert.equal(ws.repoPath, realpathSync(repo.dir), "主区顶层经 git 解析（macOS /var → /private/var）");
      assert.ok(ws.dir.startsWith(h.worktrees.dirFor(taskId, node.key)));
      const mine = node.key === "a" ? "src/a.txt" : "src/b.txt";
      const theirs = node.key === "a" ? "src/b.txt" : "src/a.txt";
      const tool: MorrowTool = {
        name: "work", description: "work", parameters: { type: "object", properties: {} },
        execute: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          writeFileSync(join(ws.dir, mine), `${node.key}-edit\n`);
          arrived.add(node.key);
          await waitFor(`${node.key} sees a sibling in flight`, () => arrived.size === 2);
          // 隔离断言：兄弟节点的编辑对我的 worktree 不可见（我看到的还是基线内容）
          observed.set(node.key, { workspace: ws, siblingContent: readFileSync(join(ws.dir, theirs), "utf8") });
          active -= 1;
          return { text: "ok" };
        },
      };
      return createFakePi({
        script: [{ kind: "tool", toolName: "work" }, { kind: "text", deltas: [`${node.key}-done`] }],
        tools: [tool],
      });
    };
    await makeScheduler(h, factory).schedule(taskId);

    const final = h.svc.getTask(taskId);
    assert.equal(final?.status, "completed");
    assert.deepEqual(final?.nodes.map((n) => [n.key, n.status]), [["a", "completed"], ["b", "completed"]]);
    assert.equal(maxActive, 2, "两个代码节点真实并行（并发观测 2）");
    // 互不可见：a 在 worktree 里看到 src/b.txt 还是基线内容（反之亦然）
    assert.equal(observed.get("a")?.siblingContent, "b0\n");
    assert.equal(observed.get("b")?.siblingContent, "a0\n");

    // 自动合并回主区：两个节点的变更都落进主区
    assert.equal(readFileSync(join(repo.dir, "src/a.txt"), "utf8"), "a-edit\n");
    assert.equal(readFileSync(join(repo.dir, "src/b.txt"), "utf8"), "b-edit\n");

    // 合并有验证记录（task.merged × 2）：a 带 verify 命令，b 为 diff 非空断言
    const events = eventsOf(h, taskId);
    const merged = events.filter((e) => e.event_type === "task.merged");
    assert.equal(merged.length, 2);
    const mergedA = merged.find((e) => e.payload.key === "a");
    const mergedB = merged.find((e) => e.payload.key === "b");
    assert.equal(mergedA?.payload.validated_by, "verify_command", "声明的 verify 命令在主区执行");
    assert.equal(mergedB?.payload.validated_by, "diff_nonempty", "未声明 verify → diff 非空断言");
    assert.deepEqual(mergedA?.payload.files, ["src/a.txt"]);
    assert.ok(mergedA?.payload.merged_commit);
    // node_started 留 worktree 证据
    const started = events.filter((e) => e.event_type === "task.node_started");
    for (const e of started) {
      assert.equal((e.payload.worktree as { branch: string }).branch, `morrow/${taskId}/${e.payload.key}`);
    }
    // 生命周期：任务完成后 worktree 与分支清理干净
    assert.equal(existsSync(h.worktrees.dirFor(taskId, "a")), false);
    assert.equal(existsSync(h.worktrees.dirFor(taskId, "b")), false);
    assert.throws(() => repo.git(["rev-parse", "--verify", `morrow/${taskId}/a`]), "合并后分支删除");
    assert.equal(h.locks.list().length, 0, "无锁声明 → 无锁残留");
  } finally {
    repo.close();
    h.close();
  }
});

// --- 资源锁：同 lock 串行化，无锁节点照常并行 ---------------------------------------

test("two nodes declaring the same lock serialize; a lock-free sibling still runs in parallel", async () => {
  const h = openHarness(planJson([
    { key: "n1", title: "N1", resources: { lock: ["db:users"] } },
    { key: "n2", title: "N2", resources: { lock: ["db:users"] } },
    { key: "n3", title: "N3" },
  ]));
  try {
    const detail = await h.svc.createTask("锁串行化场景");
    const taskId = detail.task_id;
    let lockActive = 0;
    let lockMaxActive = 0;
    /** 持锁节点的工具：计数并发（锁生效 → 恒 1） */
    const lockedTool = (): MorrowTool => ({
      name: "step", description: "step", parameters: { type: "object", properties: {} },
      execute: async () => {
        lockActive += 1;
        lockMaxActive = Math.max(lockMaxActive, lockActive);
        await new Promise((resolve) => setTimeout(resolve, 40));
        lockActive -= 1;
        return { text: "ok" };
      },
    });
    /** 无锁节点的工具：只耗时，不计数 */
    const freeTool = (): MorrowTool => ({
      name: "step", description: "step", parameters: { type: "object", properties: {} },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { text: "ok" };
      },
    });
    const factory: NodeAgentFactory = async (node) => createFakePi({
      script: [{ kind: "tool", toolName: "step" }, { kind: "text", deltas: ["done"] }],
      tools: [(node.resources?.lock?.length ?? 0) > 0 ? lockedTool() : freeTool()],
    });
    await makeScheduler(h, factory).schedule(taskId);

    const final = h.svc.getTask(taskId);
    assert.equal(final?.status, "completed");
    assert.equal(lockMaxActive, 1, "同 lock 节点从不重叠");

    // 事件时序：n2 的启动晚于 n1 的收尾（串行化），n3 与 n1 并行
    const events = eventsOf(h, taskId);
    const idxOf = (pred: (e: EventEnvelope) => boolean): number => {
      const idx = events.findIndex(pred);
      assert.ok(idx >= 0, "event not found");
      return idx;
    };
    const ns = (key: string) => idxOf((e) => e.event_type === "task.node_started" && e.payload.key === key);
    const nf = (key: string) => idxOf((e) => e.event_type === "task.node_finished" && e.payload.key === key && e.payload.status === "completed");
    assert.ok(ns("n2") > nf("n1"), "n2 等到 n1 释放锁后才启动");
    assert.ok(ns("n3") < nf("n1"), "无锁的 n3 与 n1 并行");
    assert.equal(h.locks.list().length, 0, "节点终态后锁全部释放");
  } finally {
    h.close();
  }
});

// --- 冲突合并：pending_review + task.merge_conflict + waiting_input ------------------

test("conflicting worktree changes are detected: node pending_review + task.merge_conflict + task waiting_input", async () => {
  const repo = makeRepo({ "shared.txt": "base\n" });
  const h = openHarness(planJson([
    { key: "a", title: "A", resources: { git_repo: { path: repo.dir } } },
    { key: "b", title: "B", resources: { git_repo: { path: repo.dir } } },
  ]));
  try {
    const detail = await h.svc.createTask("两个节点改同一文件");
    const taskId = detail.task_id;
    const factory: NodeAgentFactory = async (node) => {
      const ws = node.workspace as NodeWorkspaceInfo;
      const tool: MorrowTool = {
        name: "work", description: "work", parameters: { type: "object", properties: {} },
        execute: async () => {
          writeFileSync(join(ws.dir, "shared.txt"), `${node.key}-edit\n`);
          if (node.key === "b") {
            // 确定性：b 等 a 的合并先落进主区，再结束自己的 Agent Loop
            await waitFor("a's merge to land in main", () => readFileSync(join(repo.dir, "shared.txt"), "utf8") === "a-edit\n");
          }
          return { text: "ok" };
        },
      };
      return createFakePi({
        script: [{ kind: "tool", toolName: "work" }, { kind: "text", deltas: [`${node.key}-done`] }],
        tools: [tool],
      });
    };
    await makeScheduler(h, factory).schedule(taskId);

    const final = h.svc.getTask(taskId);
    assert.equal(final?.status, "waiting_input", "冲突节点挂起等 Owner（reconciliation_required）");
    const a = final?.nodes.find((n) => n.key === "a");
    const b = final?.nodes.find((n) => n.key === "b");
    assert.equal(a?.status, "completed");
    assert.equal(b?.status, "pending_review", "冲突节点进人工核对态");
    assert.equal(b?.result, "b-done", "pending_review 保留节点产出供核对");

    const events = eventsOf(h, taskId);
    const conflict = events.find((e) => e.event_type === "task.merge_conflict");
    assert.ok(conflict, "task.merge_conflict 留痕");
    assert.equal(conflict?.payload.node_id, b?.node_id);
    assert.deepEqual(conflict?.payload.files, ["shared.txt"]);
    assert.equal(conflict?.payload.branch, `morrow/${taskId}/b`);
    assert.ok(existsSync(conflict?.payload.worktree_dir as string), "冲突 worktree 保留供 Owner 调解");
    const merged = events.filter((e) => e.event_type === "task.merged");
    assert.equal(merged.length, 1, "只有先合并的 a 成功");
    // 主区不被污染：abort 后是 a 的版本，干净无冲突标记
    assert.equal(readFileSync(join(repo.dir, "shared.txt"), "utf8"), "a-edit\n");
    assert.equal(repo.git(["status", "--porcelain"]).trim(), "");
    // waiting_input 带 reconciliation_required 语义
    const waiting = events.at(-1);
    assert.equal(waiting?.event_type, "task.waiting_input");
    assert.equal(waiting?.payload.reason, "reconciliation_required");
  } finally {
    repo.close();
    h.close();
  }
});

// --- 合并验证失败：verify 命令不过 → 节点失败，任务 failed ---------------------------

test("merge verify failure fails the node with the merge error and the main checkout is rolled back", async () => {
  const repo = makeRepo({ "src/a.txt": "a0\n" });
  const h = openHarness(planJson([
    { key: "a", title: "A", retriable: false, resources: { git_repo: { path: repo.dir, verify: "test -f missing.txt" } } },
  ]));
  try {
    const detail = await h.svc.createTask("验证命令必失败");
    const taskId = detail.task_id;
    const factory: NodeAgentFactory = async (node) => createFakePi({
      script: [{ kind: "tool", toolName: "work" }, { kind: "text", deltas: [`${node.key}-done`] }],
      tools: [{
        name: "work", description: "work", parameters: { type: "object", properties: {} },
        execute: async () => {
          writeFileSync(join((node.workspace as NodeWorkspaceInfo).dir, "src/a.txt"), "a-edit\n");
          return { text: "ok" };
        },
      }],
    });
    await makeScheduler(h, factory).schedule(taskId);

    const final = h.svc.getTask(taskId);
    assert.equal(final?.status, "failed");
    const a = final?.nodes.find((n) => n.key === "a");
    assert.equal(a?.status, "failed");
    assert.match(a?.error ?? "", /verify_failed|merge verification/i);
    assert.equal(readFileSync(join(repo.dir, "src/a.txt"), "utf8"), "a0\n", "主区回滚到合并前");
    const events = eventsOf(h, taskId);
    assert.equal(events.filter((e) => e.event_type === "task.merged").length, 0, "验证失败不留 task.merged");
    assert.equal(existsSync(h.worktrees.dirFor(taskId, "a")), false, "失败节点的 worktree 清理");
  } finally {
    repo.close();
    h.close();
  }
});

// --- 沙箱协作：sandboxed 能力调用的 workspace = 节点 worktree（与 T2 契约对齐）--------

test("sandboxed capability invocations inside a code node point at the node worktree (T2 contract)", async () => {
  const repo = makeRepo({ "src/a.txt": "a0\n" });
  const h = openHarness(planJson([
    { key: "a", title: "A", resources: { git_repo: { path: repo.dir } } },
  ]));
  try {
    const detail = await h.svc.createTask("代码节点内走沙箱工具");
    const taskId = detail.task_id;
    const seenWorkspace: Array<{ dir: string; mode: string | undefined }> = [];
    const fakeRunner = (): SandboxRunner => ({
      async run(pkg: SandboxToolPackage, input: unknown, _contract: SandboxContract) {
        // FakeRunner 模拟容器挂载 workspace 后的写文件效果（写进挂载的 workspace 目录）
        const { file, content } = input as { file: string; content: string };
        if (pkg.workspaceDir !== undefined) {
          const target = join(pkg.workspaceDir, file);
          mkdirSync(join(target, ".."), { recursive: true });
          writeFileSync(target, content);
        }
        seenWorkspace.push({ dir: pkg.workspaceDir ?? "", mode: pkg.workspaceMode });
        return { ok: true, exit_code: 0, timed_out: false, stdout: "", stderr: "", result: { wrote: true }, duration_ms: 1, engine: "fake", image: "fake" };
      },
    });
    const factory: NodeAgentFactory = async (node) => {
      const ws = node.workspace as NodeWorkspaceInfo;
      // 节点侧工具接线（生产由节点 Agent 的工具装配层做）：把节点 worktree 作为
      // ToolInvoker 的 workspaceRoot——sandboxed 调用的容器挂载即 worktree。
      const invoker = new ToolInvoker({
        runner: fakeRunner(),
        permissionEngine: { assertRuntimeUse: async () => undefined },
        workspaceRoot: ws.dir,
      });
      invoker.register({
        manifest: {
          name: "gen_editor", version: "1.0.0", author: "ai", runtime: "typescript",
          permissions: { filesystem: ["workspace://**"] },
          sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
        },
        package: { name: "gen_editor", kind: "typescript", entry: "tool.ts" },
      });
      return createFakePi({
        script: [{ kind: "tool", toolName: "gen_editor" }, { kind: "text", deltas: ["done"] }],
        tools: [{
          name: "gen_editor", description: "gen", parameters: { type: "object", properties: {} },
          execute: async () => {
            const r = await invoker.invoke("gen_editor", { file: "src/a.txt", content: "sandboxed edit\n" });
            return { text: JSON.stringify(r.result ?? null) };
          },
        }],
      });
    };
    await makeScheduler(h, factory).schedule(taskId);

    const final = h.svc.getTask(taskId);
    assert.equal(final?.status, "completed");
    assert.equal(seenWorkspace.length, 1);
    assert.equal(seenWorkspace[0].dir, h.worktrees.dirFor(taskId, "a"), "沙箱 workspace 指向节点 worktree");
    assert.equal(seenWorkspace[0].mode, "rw", "声明 filesystem 权限 → rw 挂载（T2 接线口径）");
    assert.equal(existsSync(h.worktrees.dirFor(taskId, "a")), false);
  } finally {
    repo.close();
    h.close();
  }
});

// --- 启动清扫：崩溃残留（worktree/分支/锁）清掉，冲突证据保留 -------------------------

test("sweepResidue clears crash leftovers (worktrees/branches/locks) but keeps pending_review evidence", async () => {
  const repo = makeRepo();
  const h = openHarness(planJson([{ key: "a", title: "A" }]));
  try {
    const detail = await h.svc.createTask("现存任务");
    const taskId = detail.task_id;
    // 残留 1：未知任务的 worktree + 脏状态
    const residue = await h.worktrees.prepare({ repoPath: repo.dir, taskId: "01990000-0000-7000-8000-000000009999", nodeId: "n", key: "code" });
    writeFileSync(join(residue.dir, "dirty.txt"), "residue\n");
    // 残留 2：现存任务（将被打成 pending_review）的冲突证据 worktree
    const held = await h.worktrees.prepare({ repoPath: repo.dir, taskId, nodeId: detail.nodes[0].node_id, key: "a" });
    // 残留 3：孤儿锁
    assert.equal(h.locks.acquireAll(["db:users"], taskId, detail.nodes[0].node_id, "2026-11-02T00:00:00Z"), true);
    // 节点打成 pending_review（模拟冲突挂起后的重启）
    h.svc.setNodeState(detail.nodes[0].node_id, { status: "pending_review" });

    const scheduler = makeScheduler(h, null);
    const swept = await scheduler.sweepResidue();
    assert.deepEqual(swept.worktrees, ["01990000-0000-7000-8000-000000009999"], "未知任务残留被清扫");
    assert.equal(existsSync(residue.dir), false);
    assert.equal(existsSync(held.dir), true, "pending_review 节点的 worktree 是核对证据，保留");
    assert.equal(swept.locks, 1, "启动时无在跑节点 → 孤儿锁全清");
    assert.equal(h.locks.list().length, 0);
  } finally {
    repo.close();
    h.close();
  }
});
