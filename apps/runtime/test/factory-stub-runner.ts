// 本地桩 Runner（票 M2-T3 测试桩路径）：SandboxRunner 的无 docker 实现。
// 与容器路径同一断言脚本（verify-entry 模板）：esbuild 打包 → node 子进程执行 →
// stdin 注入用例规格 → stdout 信封解析。契约模拟：network=none 经 --import preload
// 把全局 fetch 换成必抛桩（容器路径由 --network none 强制；本桩为进程级近似）。
// 超时 kill / 退出码 / 信封分类与 DockerRunner.classifyRun 同口径。
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseToolEnvelope } from "../src/sandbox/protocol.ts";
import type { SandboxResult, SandboxRunner, SandboxToolPackage } from "../src/sandbox/runner.ts";
import type { SandboxContract } from "../src/sandbox/contract.ts";

const STUB_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** network=none 模拟 preload：全局 fetch 必抛（ESM --import 加载） */
const NETWORK_NONE_PRELOAD = `
globalThis.fetch = async () => {
  throw new Error("sandbox network blocked (local stub: contract network=none)");
};
`;

function stubExec(
  file: string,
  args: string[],
  options?: { input?: string },
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: STUB_MAX_BUFFER_BYTES, windowsHide: true, ...(cwd !== undefined ? { cwd } : {}) },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: code });
      },
    );
    if (options?.input !== undefined) child.stdin?.end(options.input);
  });
}

async function bundle(entry: string, outfile: string): Promise<void> {
  const esbuild = await import("esbuild");
  // nodePaths：与生产 Builder/DockerRunner 同一解析口径（依赖从宿主 node_modules 出发）
  let dir = new URL("..", import.meta.url).pathname;
  const nodePaths: string[] = [];
  for (let i = 0; i < 6; i++) {
    nodePaths.push(join(dir, "node_modules"));
    dir = join(dir, "..");
  }
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    nodePaths,
    logLevel: "silent",
  });
}

export class LocalNodeRunner implements SandboxRunner {
  async run(toolPackage: SandboxToolPackage, input: unknown, contract: SandboxContract): Promise<SandboxResult> {
    if (toolPackage.kind !== "typescript" || toolPackage.entry === undefined) {
      return {
        ok: false, exit_code: -1, timed_out: false, stdout: "", stderr: "",
        error_code: "tool_package_unsupported",
        error: `LocalNodeRunner executes typescript entries only; got kind=${toolPackage.kind}`,
        duration_ms: 0, engine: "local-node", image: "none",
      };
    }
    const started = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "morrow-factory-stub-"));
    try {
      const bundlePath = join(dir, "bundle.mjs");
      await bundle(toolPackage.entry, bundlePath);
      // network none 模拟：contract.network === "none"（v1 唯一取值）时注入 fetch 桩
      const preloadPath = join(dir, "preload.mjs");
      writeFileSync(preloadPath, NETWORK_NONE_PRELOAD, "utf8");

      const timeoutMs = contract.resources.timeoutMs;
      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
      }, timeoutMs);

      const res = await stubExec(
        process.execPath,
        ["--import", pathToFileURL(preloadPath).href, bundlePath],
        { input: JSON.stringify(input ?? {}) },
        // 容器口径对齐：workspace 即子进程 cwd（容器 -w /workspace）
        toolPackage.workspaceDir,
      );
      clearTimeout(killTimer);

      const base = { exit_code: res.exitCode, timed_out: timedOut, stdout: res.stdout, stderr: res.stderr };
      const classify = (): Omit<SandboxResult, "duration_ms" | "engine" | "image"> => {
        if (timedOut) {
          return { ...base, ok: false, exit_code: res.exitCode === 0 ? 137 : res.exitCode, error_code: "tool_timeout", error: `tool exceeded ${timeoutMs}ms (local stub)` };
        }
        const envelope = parseToolEnvelope(res.stdout);
        if (envelope.kind === "result" && res.exitCode === 0) return { ...base, ok: true, result: envelope.result };
        if (envelope.kind === "tool_error") return { ...base, ok: false, error_code: "tool_error", error: `tool reported failure: ${envelope.error}` };
        if (res.exitCode !== 0) return { ...base, ok: false, error_code: "tool_exit_nonzero", error: `tool exited with code ${res.exitCode} (stderr: ${res.stderr.slice(-200)})` };
        return { ...base, ok: false, error_code: "tool_protocol_error", error: `exit 0 but no result envelope (last line: ${res.stdout.trim().slice(0, 120)})` };
      };
      return { ...classify(), duration_ms: Date.now() - started, engine: "local-node", image: "none" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
