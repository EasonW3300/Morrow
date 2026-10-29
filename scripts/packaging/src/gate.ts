/**
 * 冒烟门 CLI（T9 / Issue #10）：单平台门禁流水线（本机与 CI 同一口径）。
 *
 * 流程：产物校验 → standalone 探针（ready JSON → /v1/health 200 → 对话探针经内置 mock →
 * exit 0）→ sidecar 探针（生命周期契约 + 同套探针）→ 门禁报告（markdown，可写入
 * GITHUB_STEP_SUMMARY）→ 按 gateVerdict 退出。
 *
 * 负向路径（AC 第 3 条）：产物缺失 → 不跑探针，报告 FAIL，退出码 1。
 *
 * 用法：
 *   node --experimental-strip-types src/gate.ts --binary <path> [--bundle-dir <dir>]
 *        [--report <out.md>] [--summary]
 *   或 --binary-dir <dir>（产物目录内发现唯一 morrow-runtime-*，CI 下载产物后用）。
 * --bundle-dir 缺省时（本机快速门禁）桌面 bundle 项记为 skipped，不影响 CI 判定口径
 * （CI 门禁必须显式传 --bundle-dir，见 .github/workflows/m0.yml）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBunOnThisMachine } from "./bun-path.ts";
import {
  buildGateReport,
  findRuntimeBinary,
  gateVerdict,
  runArtifactChecks,
  type ArtifactCheck,
  type ArtifactFailure,
  type GateCheckItem,
} from "./gate-lib.ts";

interface CliArgs {
  binary?: string;
  binaryDir?: string;
  bundleDir?: string;
  report?: string;
  summary: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { summary: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--binary":
        args.binary = argv[++i];
        break;
      case "--binary-dir":
        args.binaryDir = argv[++i];
        break;
      case "--bundle-dir":
        args.bundleDir = argv[++i];
        break;
      case "--report":
        args.report = argv[++i];
        break;
      case "--summary":
        args.summary = true;
        break;
      default:
        console.error(`[gate] unknown argument: ${argv[i]}`);
        process.exit(2);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(`[gate] FAIL: ${message}`);
  process.exit(1);
}

interface ProbeOutcome {
  ok: boolean;
  exitCode: number | null;
  outputTail: string;
  elapsedMs: number;
}

/** 跑一个探针脚本（stdio 捕获，保留尾部用于报告）；探针脚本自身失败按退出码判定 */
function runProbeScript(script: string, binaryPath: string, timeoutMs: number): ProbeOutcome {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--binary", binaryPath],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: timeoutMs },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    ok: result.status === 0,
    exitCode: result.status,
    outputTail: output.slice(-1200),
    elapsedMs: Date.now() - startedAt,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const platform = process.platform;
  const arch = process.arch;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  // --- 解析二进制路径（--binary 精确 / --binary-dir 发现） ---
  let binaryPath = args.binary;
  if (binaryPath === undefined) {
    if (args.binaryDir === undefined) fail("must pass --binary <path> or --binary-dir <dir>");
    try {
      binaryPath = findRuntimeBinary(args.binaryDir);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`[gate] binary: ${binaryPath}`);

  // --- 产物校验（负向路径：缺失即红，不跑探针） ---
  const checks: ArtifactCheck[] = [{ label: "runtime binary", path: binaryPath, kind: "file" }];
  if (args.bundleDir !== undefined) {
    checks.push({ label: "desktop bundle", path: args.bundleDir, kind: "dir-nonempty" });
  }
  const artifactFailures: ArtifactFailure[] = runArtifactChecks(checks);

  const probeChecks: GateCheckItem[] = [];
  const notes: string[] = [];

  if (args.bundleDir === undefined) {
    notes.push("本机快速门禁未提供 --bundle-dir：桌面 bundle 校验跳过；CI 门禁必须显式提供。");
  }

  if (artifactFailures.length > 0) {
    for (const failure of artifactFailures) {
      console.error(`[gate] artifact missing: ${failure.label}: ${failure.reason}`);
    }
  } else {
    // --- standalone 探针 → 清单 #1 启动 + #2 健康探针/对话 ---
    const standaloneScript = fileURLToPath(new URL("./probe-standalone.ts", import.meta.url));
    console.log("[gate] probe: standalone …");
    const standalone = runProbeScript(standaloneScript, binaryPath, 240_000);
    console.log(`[gate] probe: standalone exit=${standalone.exitCode} (${standalone.elapsedMs}ms)`);
    if (!standalone.ok) console.error(`[gate] standalone output tail:\n${standalone.outputTail}`);
    const standaloneDetail = standalone.ok
      ? "ready JSON 握手 + /v1/health 200 + 对话探针（内置 mock）+ 退出码 0"
      : `probe exit=${standalone.exitCode}`;
    probeChecks.push(
      { id: "startup", label: "启动（standalone ready JSON → 优雅退出）", status: standalone.ok ? "pass" : "fail", executor: "CI", detail: standaloneDetail },
      { id: "health", label: "健康探针 /v1/health → 200 + 对话探针（内置 mock）", status: standalone.ok ? "pass" : "fail", executor: "CI", detail: standaloneDetail },
    );

    // --- sidecar 探针 → 清单 #3 sidecar 通信 ---
    const sidecarScript = fileURLToPath(new URL("./probe-sidecar.ts", import.meta.url));
    console.log("[gate] probe: sidecar …");
    const sidecar = runProbeScript(sidecarScript, binaryPath, 300_000);
    console.log(`[gate] probe: sidecar exit=${sidecar.exitCode} (${sidecar.elapsedMs}ms)`);
    if (!sidecar.ok) console.error(`[gate] sidecar output tail:\n${sidecar.outputTail}`);
    probeChecks.push({
      id: "sidecar",
      label: "sidecar 通信（生命周期 + 同套探针）",
      status: sidecar.ok ? "pass" : "fail",
      executor: "CI",
      detail: sidecar.ok
        ? process.platform === "win32"
          ? "ready → health → 硬终止（Windows kill()=TerminateProcess，无 OS 级 SIGTERM，优雅记账由阶段 B 二进制内 close 覆盖，与桌面壳 sidecar.rs 限制同口径）；阶段 B 同套探针通过"
          : "ready → health → SIGTERM → {stopped} + 退出码 0；阶段 B 同套探针通过"
        : `probe exit=${sidecar.exitCode}`,
    });
  }

  // 清单 #4：麦克风捕获探针 = 真机门禁项（CI runner 无音频设备，T10 执行）
  probeChecks.push({
    id: "microphone",
    label: "麦克风捕获探针（语音管线清单）",
    status: "deferred",
    executor: "真机（T10）",
    detail: "CI runner 无音频设备与 GUI 会话；由 T10 在真机执行",
  });

  // --- bun 版本（追溯用，可选） ---
  let bunVersion: string | undefined;
  const bun = resolveBunOnThisMachine();
  if (bun !== undefined && bun !== null) {
    const probe = spawnSync(bun, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) bunVersion = probe.stdout?.trim();
  }

  // --- 报告与退出码（verdict 与报告同源于 gateVerdict） ---
  const verdict = gateVerdict({ artifactFailures, checks: probeChecks });
  const report = buildGateReport({
    platform,
    arch,
    startedAt,
    elapsedMs: Date.now() - startedAtMs,
    binaryPath,
    bunVersion,
    artifactFailures,
    checks: probeChecks,
    notes,
  });

  const reportPath = args.report ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", `gate-report-${platform}-${arch}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report);
  console.log(`[gate] report: ${reportPath}`);

  if (args.summary) {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath !== undefined && existsSync(dirname(summaryPath))) {
      const existing = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
      writeFileSync(summaryPath, `${existing}${report}\n`);
      console.log(`[gate] appended to GITHUB_STEP_SUMMARY`);
    } else {
      console.log("[gate] --summary set but GITHUB_STEP_SUMMARY absent (local run): skipped");
    }
  }

  console.log(`[gate] verdict: ${verdict.toUpperCase()}`);
  if (verdict !== "pass") process.exit(1);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
