import { loadConfig } from "./config.ts";
import { startRuntime } from "./runtime.ts";

/**
 * Runtime 进程入口（ADR-0003：桌面 sidecar 与 Ubuntu 服务器同一代码）。
 *
 * - 环境变量：MORROW_HOST（默认 127.0.0.1）、MORROW_PORT（默认 0=随机空闲）、
 *   MORROW_DATA_DIR（默认 ~/.morrow/data）、MORROW_REPLICA_ID（默认按 dataDir 持久化）；
 * - stdout 输出单行 JSON ready 事件（sidecar 父进程据此拿到实际端口）；
 * - SIGINT/SIGTERM：优雅退出——停收请求 → 记账 runtime.stopped → 关闭账本落盘。
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await startRuntime(config);
  console.log(
    JSON.stringify({
      ready: true,
      version: "0.1.0",
      host: runtime.host,
      port: runtime.port,
      pid: process.pid,
      data_dir: config.dataDir,
      replica_id: config.replicaId,
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
}

main().catch((err: unknown) => {
  console.error("[morrow] fatal:", err);
  process.exit(1);
});
