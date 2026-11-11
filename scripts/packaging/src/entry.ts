/**
 * 单二进制打包入口（T8 / Issue #9，ADR-0003）。
 *
 * bun build --compile 的 entrypoint。两种模式：
 *
 * - 常规模式（sidecar / 服务器）：动态 import apps/runtime 的 src/main.ts——
 *   生产启动代码零复制、零改动（ready JSON、信号处理都走 main.ts 原实现）；
 * - `--probe` 模式（打包探针）：启动 Runtime 后依次自检 health → node:sqlite
 *   roundtrip → 真实 PiAdapter 对话（供应商指向 MORROW_PROBE_LLM_BASE_URL 的
 *   OpenAI 兼容 mock 服务器），逐行打印结果报告，优雅关闭后以 0/1 退出。
 *
 * 构建命令由 src/build.ts 生成（--no-compile-autoload-bunfig/dotenv 等，
 * 见 NOTES-bun.md §2 的坑位清单）。
 */

const probeMode = process.argv.includes("--probe");

if (probeMode) {
  const { runProbe } = await import("./probe-mode.ts");
  await runProbe();
} else {
  // main.ts 在 import 时自执行（loadConfig → startRuntime → ready 行 → 信号处理）
  await import("../../../apps/runtime/src/main.ts");
}
