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
 * 有界纪律（#23 修复批）：辅助 docker 调用（image inspect / pull / kill / rm）全部经
 * safeExec 的超时 race——daemon 卡死时 inspect 超时按 sandbox_unavailable 拒绝、pull
 * 超时按 image_pull_failed 失败，绝不让挂起的 CLI 拖垮调用方；容器 run 自身由
 * contract.resources.timeoutMs + kill 宽限兜底（原有语义不变）。
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
import { classifyToolRun, stderrTail } from "./classify.ts";
import { detectContainerRuntime, DEFAULT_INSTALL_HINT, type ContainerRuntimeInfo } from "./detect.ts";
import { buildDockerRunArgs } from "./docker-args.ts";
import { SandboxError, SandboxUnavailableError, type SandboxResult, type SandboxRunner, type SandboxToolPackage } from "./runner.ts";
import type { SandboxContract } from "./contract.ts";

export { SandboxError, SandboxUnavailableError } from "./runner.ts";

export const DEFAULT_SANDBOX_IMAGE = "node:22-alpine";

/** 超时 docker kill 后留给 run 收尾的宽限（超了则硬断言超时，防 kill 失败挂死调用方） */
const KILL_GRACE_MS = 5_000;
const DOCKER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 辅助 docker 调用（image inspect / kill / rm）的有界默认值：daemon 卡死不拖垮调用方 */
export const DEFAULT_AUX_TIMEOUT_MS = 10_000;
/** 基础镜像 pull 的有界默认值（首拉走网络，放宽但仍有界） */
export const DEFAULT_PULL_TIMEOUT_MS = 300_000;

/**
 * docker CLI 执行（容器 run 不设自身超时——超时由 Runner 按 contract.resources.timeoutMs
 * 管理并强杀；inspect/pull/kill/rm 等辅助调用经 safeExec 的有界 race 兜底）。
 */
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
  /** 辅助 docker 调用（inspect/kill/rm）超时（默认 10s；daemon 卡死的有界防线，#23） */
  auxTimeoutMs?: number;
  /** 基础镜像 pull 超时（默认 300s；首拉走网络故独立放宽，仍不无界） */
  pullTimeoutMs?: number;
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
  private readonly auxTimeoutMs: number;
  private readonly pullTimeoutMs: number;

  constructor(options: DockerRunnerOptions = {}) {
    this.exec = options.exec ?? defaultDockerExec;
    this.detect = options.detect ?? detectContainerRuntime;
    this.image = options.image ?? DEFAULT_SANDBOX_IMAGE;
    this.bundleDirRoot = options.bundleDirRoot ?? tmpdir();
    this.auxTimeoutMs = options.auxTimeoutMs ?? DEFAULT_AUX_TIMEOUT_MS;
    this.pullTimeoutMs = options.pullTimeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
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

      // 镜像拉取策略：inspect 缺失才 pull（记录 pulled=true）。inspect/pull 均有界：
      // daemon 卡死时 inspect 超时按「沙箱不可用」拒绝、pull 超时按 image_pull_failed
      // 失败——绝不无限等待（#23：本机 docker CLI 挂起的教训）。
      const inspect = await this.safeExec(["image", "inspect", this.image], this.auxTimeoutMs);
      if (inspect.timedOut) {
        throw new SandboxUnavailableError(
          `\`docker image inspect\` did not respond within ${this.auxTimeoutMs}ms — the container daemon appears wedged; ` +
            "restart Docker Desktop / OrbStack (or the docker service) and verify with `docker info`.",
        );
      }
      let pulled: boolean | undefined;
      if (inspect.exitCode !== 0) {
        const pull = await this.safeExec(["pull", this.image], this.pullTimeoutMs);
        if (pull.timedOut || pull.exitCode !== 0) {
          const reason = pull.timedOut ? `pull did not respond within ${this.pullTimeoutMs}ms` : stderrTail(pull.stderr);
          throw new SandboxError("image_pull_failed", `failed to pull ${this.image}: ${reason}`);
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
      const classified = classifyToolRun(result, {
        timeoutMs: contract.resources.timeoutMs,
        subject: "tool",
        stderrTailDetail: true,
        protocolTailDetail: true,
        maxBufferExitCode: -2,
        timeoutExitCodeZeroAs: 137,
      });
      return {
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

  /**
   * 有界 docker 辅助调用（inspect/pull/kill/rm）：exec 结果与超时哨兵 race——
   * CLI 挂起不再拖垮调用方（超时结果 exitCode 124 + timedOut 标记，调用方按语义归类）。
   */
  private safeExec(args: string[], timeoutMs: number): Promise<ExecResult & { timedOut: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ExecResult & { timedOut: boolean }>((resolve) => {
      // 超时哨兵必须保持 ref'd：race 的败者可能不持有任何事件循环句柄（挂起的注入桩、
      // 句柄已被收走的进程），unref 会让事件循环先空、race 永不 settle
      //（node:test 报 "Promise resolution is still pending"——node 22/24 时序差异根因）。
      timer = setTimeout(
        () => resolve({ stdout: "", stderr: `docker call timed out after ${timeoutMs}ms: ${args.join(" ")}`, exitCode: 124, timedOut: true }),
        timeoutMs,
      );
    });
    return Promise.race([
      this.exec("docker", args).then(
        (res) => ({ ...res, timedOut: false }),
        () => ({ stdout: "", stderr: "exec failed", exitCode: 127, timedOut: false }),
      ),
      timeout,
    ]).finally(() => {
      // 胜出路径清掉 ref'd 哨兵：不 clear 会把进程空拖到界才退出
      if (timer !== undefined) clearTimeout(timer);
    });
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
    // 再补一刀 rm 防竞态残留。kill/rm 为 fire-and-forget，但同样有界（防 daemon 卡死泄漏）。
    // kill/hard 哨兵保持 ref'd：与 safeExec 同理，exec 败者可能不持有任何事件循环句柄
    //（挂起桩），unref 会让循环先空、run 的 race 永不 settle；两哨兵在 finally 均 clearTimeout。
    const killTimer = setTimeout(() => {
      timedOut = true;
      void this.safeExec(["kill", containerName], this.auxTimeoutMs);
    }, timeoutMs);
    // 兜底硬停：kill 失败（容器已退出等）也不让调用方无限等——以超时分类收尾
    let hardTimer: NodeJS.Timeout | undefined;
    const hardStop = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(
        () => reject(new SandboxError("tool_timeout", `container kill grace (${KILL_GRACE_MS}ms) elapsed`)),
        timeoutMs + KILL_GRACE_MS,
      );
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
        void this.safeExec(["rm", "-f", containerName], this.auxTimeoutMs);
      }
    }
  }
}
