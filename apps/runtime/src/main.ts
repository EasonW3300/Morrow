import { loadConfig } from "./config.ts";
import { startRuntime, VERSION } from "./runtime.ts";

/**
 * Runtime 进程入口（ADR-0003：桌面 sidecar 与 Ubuntu 服务器同一代码）。
 *
 * - 环境变量：MORROW_HOST（默认 127.0.0.1）、MORROW_PORT（默认 0=随机空闲）、
 *   MORROW_DATA_DIR（默认 ~/.morrow/data）、MORROW_REPLICA_ID（默认按 dataDir 持久化）；
 * - stdout 输出单行 JSON ready 事件（sidecar 父进程据此拿到实际端口）；
 * - SIGINT/SIGTERM：优雅退出——停收请求 → 记账 runtime.stopped → 关闭账本落盘。
 */

/** 等待一行真正落到 stdout（管道写入异步，随后可能立即 process.exit —— 直接写可能丢行，
 *  Windows 管道尤甚；与 scripts/packaging/src/probe-mode.ts 的 writeLine 同款处理） */
function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, () => resolve());
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await startRuntime(config);

  // 信号与兜底处理器必须先于 ready 行安装：父进程看到 ready 即可能立刻发信号，
  // 竞态窗口内信号走默认处置直接终止进程（而非优雅退出）。
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
        console.error("[morrow] error during shutdown:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    console.error("[morrow] uncaught exception:", err);
    process.exitCode = 1;
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[morrow] unhandled rejection:", reason);
    process.exitCode = 1;
  });

  // ready 行是父子进程协议的第一帧，落盘确认后再把控制权交回（flush 确定性）
  await writeLine(
    JSON.stringify({
      ready: true,
      version: VERSION,
      host: runtime.host,
      port: runtime.port,
      pid: process.pid,
      data_dir: config.dataDir,
      replica_id: config.replicaId,
    }),
  );
}

main().catch((err: unknown) => {
  console.error("[morrow] fatal:", err);
  process.exit(1);
});
