/**
 * 默认容器实现 DockerRunner（票 M2-T2 / Issue #23，PRD §2 执行隔离行）。
 *
 * 执行管线：esbuild 预打包 TS 工具包 → docker run（契约强制：--network none、
 * --cpus/--memory、--read-only + workspace/包目录挂载，见 docker-args.ts）→
 * stdin 注入 JSON 输入 → stdout 结构化信封回传 + stderr 诊断 → 超时按容器名
 * docker kill 强杀 → 退出码/信封分类为 SandboxResult。
 *
 * 镜像拉取策略：node:22-alpine 首次执行按需 pull（image inspect 缺失才 pull，
 * 结果 pulled=true 记录一次拉取；不预拉、不锁版本 registry digest——M2 先用浮动 tag，
 * 后续票可升 digest pin）。
 *
 * 探测口径：可用性经 detectContainerRuntime（探测命令可经 options.exec 桩注入；
 * 本机只实测 docker——OrbStack 亦为 docker CLI）。Windows WSL2/podman/OrbStack
 * 的归类在 detect.ts；本模块对引擎不可知，只要有兼容 docker run 的 CLI。
 *
 * go 工具包不经本 Runner（builtin 直跑，见 go-worker.ts）：kind=go → 显式拒绝
 * （tool_package_unsupported），防止「以为进了沙箱实际直跑」的静默降级。
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecFn, ExecResult } from "../keyring.ts";
import { detectContainerRuntime, DEFAULT_INSTALL_HINT, type ContainerRuntimeInfo } from "./detect.ts";
import { buildDockerRunArgs } from "./docker-args.ts";
import { parseToolEnvelope } from "./protocol.ts";
import { SandboxError, SandboxUnavailableError, type SandboxResult, type SandboxRunner, type SandboxToolPackage } from "./runner.ts";
import type { SandboxContract } from "./contract.ts";

export { SandboxError, SandboxUnavailableError } from "./runner.ts";

export const DEFAULT_SANDBOX_IMAGE = "node:22-alpine";

/** 超时 docker kill 后留给 run 收尾的宽限（超了则硬断言超时，防 kill 失败挂死调用方） */
const KILL_GRACE_MS = 5_000;
const DOCKER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** docker CLI 执行（不设自身超时——超时由 Runner 按 contract.resources.timeoutMs 管理并强杀） */
export function defaultDockerExec(file: string, args: string[], options?: { input?: string }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: DOCKER_MAX_BUFFER_BYTES, windowsHide: true },
      (err, stdout, stderr) => {
        if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
          reject(new SandboxError("sandbox_unavailable", `container CLI "${file}" vanished between detection and run`));
          return;
        }
        if (err !== null && typeof err === "object" && "code" in err && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ stdout: String(stdout ?? ""), stderr: "tool output exceeded 32MB", exitCode: -2 });
          return;
        }
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: code });
      },
    );
    if (options?.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export interface DockerRunnerOptions {
  /** docker CLI 桩（探测与执行共用；测试注入） */
  exec?: ExecFn;
  /** 可用性探测桩（默认 detectContainerRuntime，同样吃 exec 桩） */
  detect?: typeof detectContainerRuntime;
  /** 基础镜像（默认 node:22-alpine） */
  image?: string;
  /** esbuild 产物临时目录根（默认 os.tmpdir()） */
  bundleDirRoot?: string;
}

function stderrTail(stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-3).join(" | ");
  return tail.length > 0 ? tail.slice(0, 400) : "(no stderr)";
}

/** esbuild 预打包（动态 import：esbuild 为 devDependency，单二进制打包路线 M2-T3 决策点） */
async function bundleTool(entry: string, outDir: string): Promise<void> {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    throw new SandboxError(
      "tool_build_failed",
      "esbuild is required to bundle sandboxed TypeScript tools (devDependency of @morrow/runtime)",
    );
  }
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // .mjs：node:22-alpine 容器内无 package.json，靠扩展名保证按 ESM 执行（顶层 await 可用）
    outfile: join(outDir, "bundle.mjs"),
    logLevel: "silent",
  });
}

export class DockerRunner implements SandboxRunner {
  private readonly exec: ExecFn;
  private readonly detect: typeof detectContainerRuntime;
  private readonly image: string;
  private readonly bundleDirRoot: string;

  constructor(options: DockerRunnerOptions = {}) {
    this.exec = options.exec ?? defaultDockerExec;
    this.detect = options.detect ?? detectContainerRuntime;
    this.image = options.image ?? DEFAULT_SANDBOX_IMAGE;
    this.bundleDirRoot = options.bundleDirRoot ?? tmpdir();
  }

  private async requireRuntime(): Promise<ContainerRuntimeInfo> {
    const availability = await this.detect({ exec: this.exec });
    if (!availability.available || availability.runtime === null) {
      throw new SandboxUnavailableError(availability.installHint ?? DEFAULT_INSTALL_HINT);
    }
    return availability.runtime;
  }

  async run(toolPackage: SandboxToolPackage, input: unknown, contract: SandboxContract): Promise<SandboxResult> {
    if (toolPackage.kind !== "typescript" || toolPackage.entry === undefined) {
      throw new SandboxError(
        "tool_package_unsupported",
        `DockerRunner executes bundled TypeScript packages only; got kind=${toolPackage.kind} ` +
          "(Go workers run as vetted builtins, not inside the node container)",
      );
    }
    const runtime = await this.requireRuntime();
    const started = Date.now();

    // 预打包 → 临时包目录（只读挂载 /tool）
    let packageDir: string | null = null;
    try {
      packageDir = mkdtempSync(join(this.bundleDirRoot, "morrow-sandbox-"));
      await bundleTool(toolPackage.entry, packageDir);

      // 镜像拉取策略：inspect 缺失才 pull（记录 pulled=true）
      let pulled: boolean | undefined;
      const inspect = await this.safeExec(["image", "inspect", this.image]);
      if (inspect.exitCode !== 0) {
        const pull = await this.safeExec(["pull", this.image]);
        if (pull.exitCode !== 0) {
          throw new SandboxError("image_pull_failed", `failed to pull ${this.image}: ${stderrTail(pull.stderr)}`);
        }
        pulled = true;
      }

      const containerName = `morrow-sb-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const args = buildDockerRunArgs({
        containerName,
        image: this.image,
        bundleContainerPath: "/tool/bundle.mjs",
        packageHostDir: packageDir,
        workspaceHostDir: toolPackage.workspaceDir,
        workspaceMode: toolPackage.workspaceMode ?? "ro",
        contract,
      });

      const result = await this.runContainer(runtime.command, args, containerName, JSON.stringify(input ?? {}), contract.resources.timeoutMs);
      const classified = classifyRun(result, contract.resources.timeoutMs);      return {
        ...classified,
        duration_ms: Date.now() - started,
        engine: runtime.engine,
        image: this.image,
        ...(pulled !== undefined ? { pulled } : {}),
      };
    } finally {
      if (packageDir !== null) {
        rmSync(packageDir, { recursive: true, force: true });
      }
    }
  }

  private safeExec(args: string[]): Promise<ExecResult> {
    return this.exec("docker", args).catch(() => ({ stdout: "", stderr: "exec failed", exitCode: 127 }));
  }

  private async runContainer(
    command: string,
    args: string[],
    containerName: string,
    input: string,
    timeoutMs: number,
  ): Promise<ExecResult & { timedOut: boolean }> {
    let timedOut = false;
    // 超时强杀：按容器名 docker kill（杀 CLI 客户端不杀容器）；杀完 --rm 自动清理，
    // 再补一刀 rm 防竞态残留。
    const killTimer = setTimeout(() => {
      timedOut = true;
      void this.safeExec(["kill", containerName]);
    }, timeoutMs);
    if (typeof killTimer.unref === "function") killTimer.unref();
    // 兜底硬停：kill 失败（容器已退出等）也不让调用方无限等——以超时分类收尾
    let hardTimer: NodeJS.Timeout | undefined;
    const hardStop = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(
        () => reject(new SandboxError("tool_timeout", `container kill grace (${KILL_GRACE_MS}ms) elapsed`)),
        timeoutMs + KILL_GRACE_MS,
      );
      if (hardTimer !== undefined && typeof hardTimer.unref === "function") hardTimer.unref();
    });

    try {
      const res = await Promise.race([this.exec(command, args, { input }), hardStop]);
      return { ...res, timedOut };
    } catch (err) {
      if (err instanceof SandboxError && err.code === "tool_timeout") {
        // 硬停路径：容器状态未知，按超时合成结果（exit 137 语义）
        return { stdout: "", stderr: "container kill grace elapsed", exitCode: 137, timedOut: true };
      }
      throw err;
    } finally {
      clearTimeout(killTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      if (timedOut) {
        void this.safeExec(["rm", "-f", containerName]);
      }
    }
  }
}

function classifyRun(
  res: ExecResult & { timedOut: boolean },
  timeoutMs: number,
): Omit<SandboxResult, "duration_ms" | "engine" | "image"> {
  const base = { exit_code: res.exitCode, timed_out: res.timedOut, stdout: res.stdout, stderr: res.stderr };
  if (res.exitCode === -2) {
    // maxBuffer：输出超限
    return { ...base, ok: false, error_code: "tool_output_too_large", error: "tool stdout exceeded 32MB" };
  }
  if (res.timedOut) {
    return {
      ...base,
      ok: false,
      exit_code: res.exitCode === 0 ? 137 : res.exitCode,
      error_code: "tool_timeout",
      error: `tool exceeded ${timeoutMs}ms and was killed (stderr: ${stderrTail(res.stderr)})`,
    };
  }
  const envelope = parseToolEnvelope(res.stdout);
  if (envelope.kind === "result" && res.exitCode === 0) {
    return { ...base, ok: true, result: envelope.result };
  }
  if (envelope.kind === "tool_error") {
    return { ...base, ok: false, error_code: "tool_error", error: `tool reported failure: ${envelope.error}` };
  }
  if (res.exitCode !== 0) {
    return {
      ...base,
      ok: false,
      error_code: "tool_exit_nonzero",
      error: `tool exited with code ${res.exitCode} (stderr: ${stderrTail(res.stderr)})`,
    };
  }
  return {
    ...base,
    ok: false,
    error_code: "tool_protocol_error",
    error: `exit 0 but stdout has no result envelope (last line: ${res.stdout.trim().slice(0, 120) || "(empty)"})`,
  };
}
