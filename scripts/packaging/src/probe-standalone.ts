/**
 * standalone 启动探针（T8 / Issue #9 验收第 1 条）：
 * 单二进制直接执行 → stdout ready JSON → /v1/health 200 → 对话探针 → 退出码 0。
 *
 * 对话探针 = 二进制内嵌 --probe 套件（真实 PiAdapter）× 本地 OpenAI 兼容 mock 服务器
 * （复用 pi-adapter 真实接线测试的实现，见 mock-openai.ts）。
 *
 * 用法：node --experimental-strip-types src/probe-standalone.ts [--binary <path>]
 * （根目录 `pnpm probe:runtime:standalone`）。
 */
import { existsSync } from "node:fs";
import { assertMockContract, resolveBinaryPath, runEmbeddedProbe } from "./probe-lib.ts";

function fail(message: string): never {
  console.error(`[probe:standalone] FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const binaryPath = resolveBinaryPath(process.argv);
  if (!existsSync(binaryPath)) {
    fail(
      `binary not found: ${binaryPath}\n` +
        `build it first: pnpm pack:runtime (bun build --compile)`,
    );
  }
  console.log(`[probe:standalone] binary: ${binaryPath}`);

  const startedAt = Date.now();
  const result = await runEmbeddedProbe({ binaryPath });

  // mock 服务器捕获视角的请求级断言（事件级断言在二进制内完成）
  assertMockContract(result.mockRequests);

  const checks = result.report.checks ?? {};
  console.log(`[probe:standalone] ready:  port=${result.ready.port} version=${result.ready.version} pid=${result.ready.pid}`);
  console.log(`[probe:standalone] health: ${JSON.stringify(checks["health"])}`);
  console.log(`[probe:standalone] sqlite: ${JSON.stringify(checks["sqlite"])}`);
  console.log(`[probe:standalone] dialogue: ${JSON.stringify(checks["dialogue"])}`);
  console.log(
    `[probe:standalone] runtime: ${JSON.stringify(result.report.runtime)} exit=${result.exitCode} elapsed=${Date.now() - startedAt}ms`,
  );
  console.log(`[probe:standalone] PASS`);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
