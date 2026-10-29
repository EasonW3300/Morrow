/**
 * sidecar 启动探针（T8 / Issue #9 验收第 2 条）：模拟桌面壳父进程拉起单二进制。
 *
 * 阶段 A（sidecar 生命周期契约，复刻 Tauri 父进程行为）：
 *   常规模式拉起 → 读 stdout 单行 ready JSON 拿端口 → GET /v1/health 探针请求 →
 *   unix：SIGTERM → 断言 {stopped:true, signal} 行 + 退出码 0（优雅退出：记账 + WAL checkpoint）；
 *   Windows：kill() 即 TerminateProcess（OS 级无 SIGTERM，运行时收不到信号），断言
 *   进程被终止即止——优雅记账改由阶段 B 二进制内 runtime.close() 覆盖（standalone
 *   已证该路径可用）；与桌面壳 src-tauri/src/sidecar.rs 的 Windows 已知限制同口径。
 * 阶段 B（同一套探针）：与 standalone 相同的嵌入探针（health + sqlite + 对话），
 *   以被父进程拉起的方式再跑一遍——"同样探针"在 sidecar 形态下通过。
 *
 * 对话探针没有走 HTTP 端点：M0 的 Runtime 还没有对话 API（T4 接入），对话能力经由
 * 二进制内嵌 --probe 套件验证；T4 落地后 sidecar 探针可升级为 HTTP 级对话探针。
 * 见 scripts/packaging/README.md「探针设计」。
 *
 * 用法：node --experimental-strip-types src/probe-sidecar.ts [--binary <path>]
 * （根目录 `pnpm probe:runtime:sidecar`）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asReadyEvent,
  assertMockContract,
  createJsonLineSource,
  describeChildDiagnostics,
  ensureExecutable,
  fetchJson,
  resolveBinaryPath,
  runEmbeddedProbe,
  waitExit,
  type ReadyEvent,
} from "./probe-lib.ts";
import { startMockOpenAI } from "./mock-openai.ts";

interface LifecycleResult {
  ready: ReadyEvent;
  healthBody: unknown;
  stoppedLine: Record<string, unknown>;
  exitCode: number | null;
}

function fail(message: string): never {
  console.error(`[probe:sidecar] FAIL: ${message}`);
  process.exit(1);
}

/** 阶段 A：sidecar 生命周期契约（父进程视角） */
async function runSidecarLifecycle(binaryPath: string): Promise<LifecycleResult> {
  const mock = await startMockOpenAI(); // 挂着但常规模式不使用；保持两阶段环境一致
  const dataDir = mkdtempSync(join(tmpdir(), "morrow-sidecar-"));
  let child: ReturnType<typeof spawn> | undefined;
  let killOrigin: string | undefined; // 诊断用：探针最近一次 kill 的来源（外部 kill 时为 undefined）
  try {
    ensureExecutable(binaryPath); // CI 产物无执行位（download-artifact 不保留 mode），spawn 前自愈
    child = spawn(binaryPath, [], {
      env: { ...process.env, MORROW_DATA_DIR: dataDir, MORROW_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const source = createJsonLineSource();
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => source.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("close", () => source.end());

    try {
      const ready = asReadyEvent(await source.next(20_000));
      if (ready === undefined) {
        throw new Error("sidecar phase A: first stdout json line is not a ready event");
      }

      const health = await fetchJson(`http://${ready.host}:${ready.port}/v1/health`, 5_000);
      const body = health.body as { status?: string; ledger?: { events?: number } } | undefined;
      if (health.status !== 200 || body?.status !== "ok" || (body.ledger?.events ?? 0) < 1) {
        throw new Error(`sidecar phase A: health probe failed: ${health.status} ${JSON.stringify(health.body)}`);
      }

      // 终止契约分平台（run 40882409974 windows 腿定位：探针自己的 kill("SIGTERM") 在
      // Windows 即 TerminateProcess，子进程收不到信号、无 stopped 行，close 触发 EOF——
      // 不是子进程崩溃，也不是 watchdog/cleanup 误杀）
      const graceful = process.platform !== "win32";
      killOrigin = graceful
        ? "phase A: SIGTERM after health (graceful contract, unix)"
        : "phase A: hard terminate after health (Windows kill()=TerminateProcess, no stopped line expected)";
      child.kill("SIGTERM");

      if (graceful) {
        const stopped = await source.next(15_000);
        if (stopped.stopped !== true || stopped.signal !== "SIGTERM") {
          throw new Error(`sidecar phase A: expected stopped line, got ${JSON.stringify(stopped)}`);
        }
        const exit = await waitExit(child, 15_000);
        if (exit.code !== 0) {
          throw new Error(`sidecar phase A: exit code ${exit.code} (expected 0); stderr: ${stderr.slice(-500)}`);
        }
        return { ready, healthBody: health.body, stoppedLine: stopped, exitCode: exit.code };
      }
      // Windows：断言进程确被终止；stopped 行不期望（无 OS 级 SIGTERM 可投递）
      const exit = await waitExit(child, 15_000);
      if (exit.code === null && exit.signal === null) {
        throw new Error(`sidecar phase A: child did not terminate after hard kill; stderr: ${stderr.slice(-500)}`);
      }
      return {
        ready,
        healthBody: health.body,
        stoppedLine: { stopped: false, reason: "Windows hard terminate (no OS-level SIGTERM)" },
        exitCode: exit.code,
      };
    } catch (err) {
      // 失败必附子进程可观测状态与 kill 来源（外部 kill 还是探针自身 kill 一眼可辨）
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${message} [${describeChildDiagnostics(child, stderr, source, killOrigin)}]`);
    }
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await mock.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const binaryPath = resolveBinaryPath(process.argv);
  if (!existsSync(binaryPath)) {
    fail(`binary not found: ${binaryPath}\nbuild it first: pnpm pack:runtime`);
  }
  console.log(`[probe:sidecar] binary: ${binaryPath}`);

  // 阶段 A：生命周期契约
  const startedAt = Date.now();
  const lifecycle = await runSidecarLifecycle(binaryPath);
  console.log(
    `[probe:sidecar] phase A (lifecycle): ready port=${lifecycle.ready.port}, health ok, ` +
      `terminate → ${JSON.stringify(lifecycle.stoppedLine)}, exit=${lifecycle.exitCode}`,
  );

  // 阶段 B：同一套探针（health + sqlite + 对话）以 sidecar 方式（父进程拉起）通过
  const embedded = await runEmbeddedProbe({ binaryPath });
  assertMockContract(embedded.mockRequests);
  const checks = embedded.report.checks ?? {};
  console.log(`[probe:sidecar] phase B (same probe suite):`);
  console.log(`[probe:sidecar]   health: ${JSON.stringify(checks["health"])}`);
  console.log(`[probe:sidecar]   sqlite: ${JSON.stringify(checks["sqlite"])}`);
  console.log(`[probe:sidecar]   dialogue: ${JSON.stringify(checks["dialogue"])}`);
  console.log(`[probe:sidecar] PASS (elapsed=${Date.now() - startedAt}ms)`);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
