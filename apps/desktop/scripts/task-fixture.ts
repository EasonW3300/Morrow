/**
 * Task 视图与人工介入的联调夹具（票 M1-T6 / Issue #18）：真实 Runtime + 脚本化任务
 * （FakePi 规划 + 慢节点执行，零网络）+ 一个关联任务的会话（Chat 任务卡片演示）。
 *
 * 与 apps/desktop/scripts/settings-fixture.ts 的分工：那里验证设置页，这里验证
 * Task 视图与 AC-12 的 暂停→修改→恢复 全流程。
 *
 *   node --experimental-sqlite --experimental-strip-types scripts/task-fixture.ts
 *   # 浏览器打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<runtime_port>
 *
 * 预置数据：
 *   - 会话「Task 演示会话」+ 关联任务「整理季度资料并归档」（session_id 关联 → Chat
 *     顶部出现任务卡片，点击跳 Task 视图）；
 *   - 任务初始 planned（未自动调度）：Task 视图点「恢复」开始执行；节点每个约 4s
 *     （慢 Agent），在跑时点「暂停」→ 观察安全点暂停 + checkpoint；「修改…」改
 *     节点目标/模型或增删未完成节点（task_version+1）→「恢复」跑完 → completed；
 *   - 节点级「接管」：pending 节点上接管 → 任务转 waiting_input(owner_intervention)
 *     → 「完成…」提交结果或「交还调度」。
 *
 * stdout 单行 ready JSON；SIGTERM/SIGINT 优雅退出。
 * 密钥存内存 SecretStore；数据落 MORROW_DATA_DIR（默认临时目录）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySecretStore } from "../../runtime/src/keyring.ts";
import { loadConfig } from "../../runtime/src/config.ts";
import { startRuntime } from "../../runtime/src/runtime.ts";

/** 节点计划：A→B 串行 + C 并行；B 是修订/接管的演示对象 */
const PLAN = JSON.stringify({
  nodes: [
    { key: "collect", title: "收集资料", goal: "collect materials", depends_on: [], retriable: true, side_effect: "reversible" },
    { key: "archive", title: "归档", goal: "archive results", depends_on: ["collect"], retriable: true, side_effect: "delivery_unknown" },
    { key: "summarize", title: "写摘要", goal: "summarize findings", depends_on: [], retriable: true, side_effect: "delivery_unknown" },
  ],
});

const envDataDir = process.env.MORROW_DATA_DIR;
const dataDir = envDataDir ?? mkdtempSync(join(tmpdir(), "morrow-task-fixture-"));
const config = loadConfig({ ...process.env, MORROW_DATA_DIR: dataDir });
const runtime = await startRuntime(config, {
  secretStore: createInMemorySecretStore(),
  // 会话 Agent：脚本化回声（Chat 可发消息，无网络）
  agentAdapterFactory: async () => createScriptedSessionAgent(),
  // 规划：FakePi 输出脚本化 DAG
  taskPlannerFactory: async () => createSlowAgent([{ kind: "plan", text: PLAN }], 0),
  // 节点执行：慢 Agent（每个节点约 4s）——pause 的安全点窗口足够操作 UI
  taskNodeAgentFactory: async (node) => createSlowAgent([{ kind: "node", text: `${node.key} ok` }], 4000),
});

// 预置：会话 + 关联任务（planned，不自动调度——Task 视图「恢复」开始执行）
const session = runtime.sessions.createSession("Task 演示会话");
const task = await runtime.tasks.createTask("整理季度资料并归档", { sessionId: session.sessionId });

console.log(
  JSON.stringify({
    ready: true,
    fixture: "task",
    version: "0.1.0",
    host: runtime.host,
    port: runtime.port,
    data_dir: config.dataDir,
    session_id: session.sessionId,
    task_id: task.task_id,
    task_status: task.status,
    hint:
      `浏览器打开 http://127.0.0.1:1420/?runtime=http://${runtime.host}:${runtime.port}；` +
      "Chat 页顶部有本会话的任务卡片（点击跳 Task 视图）；" +
      "Task 页：恢复 →（节点约 4s）→ 暂停 → 修改… → 恢复 演示 AC-12 全流程；" +
      "pending 节点可 接管/完成/交还。",
  }),
);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void runtime
    .close(signal)
    .then(() => {
      console.log(JSON.stringify({ stopped: true, signal }));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("[task-fixture] error during shutdown:", err);
      process.exit(1);
    });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

interface Step {
  kind: "plan" | "node";
  text: string;
}

/**
 * 慢脚本 Agent（FakePi 同构的最小实现，额外带节流）：text_delta 分片 + agent_end；
 * delayMs 控制执行时长，给「暂停」留出安全点窗口。
 */
function createSlowAgent(steps: Step[], delayMs: number) {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async prompt(): Promise<void> {
      for (const step of steps) {
        // 分 3 片输出，模拟流式
        const third = Math.max(1, Math.ceil(step.text.length / 3));
        for (let i = 0; i < step.text.length; i += third) {
          emit({ type: "text_delta", delta: step.text.slice(i, i + third) });
          await sleep(delayMs / 4);
        }
      }
      await sleep(delayMs / 2);
      emit({ type: "agent_end", stopReason: "stop" });
    },
    subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort(): void {},
    async waitForIdle(): Promise<void> {},
    dispose(): void {
      listeners.clear();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/** 会话脚本 Agent（回声）：让「建会话 → 发消息」无需真实模型即可走通 */
function createScriptedSessionAgent() {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async prompt(input: string | { content: string }[]): Promise<void> {
      const text = typeof input === "string" ? input : input.map((m) => m.content).join(" ");
      emit({ type: "text_delta", delta: `task-fixture 收到：「${text}」` });
      emit({ type: "agent_end", stopReason: "stop" });
    },
    subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort(): void {},
    async waitForIdle(): Promise<void> {},
    dispose(): void {
      listeners.clear();
    },
  };
}
