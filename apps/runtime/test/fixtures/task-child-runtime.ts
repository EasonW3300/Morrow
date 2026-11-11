import { loadConfig } from "../../src/config.ts";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import { startRuntime } from "../../src/runtime.ts";

/**
 * 故障注入子进程入口（票 M1-T5 / Issue #17，AC-07）。
 *
 * 与 main.ts 同构的 runtime 承载 + FakePi 注入（零网络）：父测试以真实进程 spawn
 * 本文件，经环境变量脚本化规划与节点行为，在任意时刻 kill -9 后重启同 dataDir
 * 验证 Checkpoint 恢复。
 *
 * 环境变量：
 * - MORROW_DATA_DIR / MORROW_PORT / MORROW_REPLICA_ID：与生产同一 loadConfig 语义；
 * - MORROW_TEST_PLAN：规划 JSON（存在即注入 FakePi 规划器与节点工厂）；
 * - MORROW_TEST_PLANNER_SCRIPT：规划器完整脚本 JSON（缺省 = [{text MORROW_TEST_PLAN}]）；
 * - MORROW_TEST_NODE_SCRIPTS：节点 key → FakeStep[] 的 JSON map；
 * - MORROW_TEST_SLOW_MS：slow 工具时长（默认 60000；kill 窗口用）。
 *
 * stdout 单行 JSON ready 事件（父子协议同 main.ts）；SIGTERM/SIGINT 优雅退出。
 */

/** 等待一行真正落到 stdout（管道写入异步；与 main.ts 的 writeLine 同款处理） */
function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, () => resolve());
  });
}

function slowTool(ms: number): MorrowTool {
  return {
    name: "slow",
    description: "slow",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      // unref：父进程杀掉本进程即可；优雅退出路径不因本计时器悬挂
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === "function") timer.unref();
      });
      return { text: "slow-done" };
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const plan = process.env.MORROW_TEST_PLAN;
  const runtime = await startRuntime(config, {
    ...(plan === undefined
      ? {}
      : {
          taskPlannerFactory: async () => {
            const plannerScript = process.env.MORROW_TEST_PLANNER_SCRIPT;
            const script: FakeStep[] = plannerScript !== undefined
              ? (JSON.parse(plannerScript) as FakeStep[])
              : [{ kind: "text", deltas: [plan] }];
            return createFakePi({ script, tools: [slowTool(Number(process.env.MORROW_TEST_SLOW_MS ?? "60000"))] });
          },
          taskNodeAgentFactory: async (node) => {
            const scripts = JSON.parse(process.env.MORROW_TEST_NODE_SCRIPTS ?? "{}") as Record<string, FakeStep[]>;
            return createFakePi({
              script: scripts[node.key] ?? [{ kind: "text", deltas: [node.goal] }],
              tools: [slowTool(Number(process.env.MORROW_TEST_SLOW_MS ?? "60000"))],
            });
          },
        }),
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime
      .close(signal)
      .then(async () => {
        await writeLine(JSON.stringify({ stopped: true, signal }));
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error("[morrow-test-child] error during shutdown:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    console.error("[morrow-test-child] uncaught exception:", err);
    process.exitCode = 1;
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[morrow-test-child] unhandled rejection:", reason);
    process.exitCode = 1;
  });

  await writeLine(
    JSON.stringify({
      ready: true,
      host: runtime.host,
      port: runtime.port,
      pid: process.pid,
      data_dir: config.dataDir,
      replica_id: config.replicaId,
    }),
  );
}

main().catch((err: unknown) => {
  console.error("[morrow-test-child] fatal:", err);
  process.exit(1);
});
