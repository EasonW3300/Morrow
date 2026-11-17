/**
 * 动态 bash 执行接缝（票 M7-B-T6 / Issue #70，FR-B13/B16）。
 *
 * 两层结构，故意分开：
 *   - `LocalExecRunner` 是**接缝**：一次"把这段脚本跑起来"的最低约定。测试注入假
 *     实现即可覆盖全部判定逻辑（零 docker）；生产实现是下面的 `ContainerExecRunner`。
 *   - `ContainerExecRunner` 是**唯一生产实现**：不允许"直接在宿主上跑"的路径。
 *     共享/本地两种调用点的区别只在挂载与限额，不在隔离强度。
 *
 * 为什么接缝放在这里而不是"判定层"：判定（危险规则/执行模式/确认）是纯函数，
 * 已经能单独测；把接缝放在执行边界，才能让"脚本到底有没有真的进容器"这件事
 * 在测试里被观察到（断言 argc/argv、断言容器名、断言网络旗标）。
 *
 * 隔离语义（与 M2 SandboxRunner 同源，但不是同一个对象）：
 *   - `--network none` 是**默认且唯一**的取值。规格里"动态 bash"没有"允许联网"
 *     这个选项；需要联网的活应走 MCP/渠道能力（它们有独立的网络权限维度）。
 *   - workspace 只挂载会话工作区，`ro`/`rw` 由调用方按脚本意图决定（默认 `rw`：
 *     Agent 写脚本的目的通常就是改工作区；只读脚本没必要写，但也不额外放宽）。
 *   - 超时按 `docker kill` 强杀；输出按字节上限截断并标记 `truncated`。
 */

import { randomUUID } from "node:crypto";
import type { ExecFn, ExecResult } from "../keyring.ts";
import { defaultDockerExec } from "../sandbox/docker-runner.ts";
import { detectContainerRuntime, DEFAULT_INSTALL_HINT, type ContainerRuntimeInfo } from "../sandbox/detect.ts";
import { SandboxError, SandboxUnavailableError } from "../sandbox/runner.ts";

/** 一次执行请求（判定已通过） */
export interface ExecRequest {
  sessionId: string;
  /** 完整脚本（原样交给 shell） */
  script: string;
  /** 会挂进容器的会话工作区（绝对路径）；无工作区则不挂载 */
  workspaceDir?: string;
  workspaceMode?: "rw" | "ro";
  /** 强杀超时（ms） */
  timeoutMs: number;
  /** stdout/stderr 各自保留的最大字节数（超出截断并标记） */
  maxOutputBytes: number;
}

/** 一次执行结果 */
export interface ExecResultView {
  ok: boolean;
  exit_code: number;
  timed_out: boolean;
  /** 输出超限被截断 */
  truncated: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
  /** 隔离证据：这次执行真的走的容器（引擎名），不是宿主直跑 */
  engine: string;
  image: string;
  /** 容器名（审计/事后 docker logs 定位） */
  container: string;
  /** 失败归类（ok=false 时） */
  error_code?: "exec_unavailable" | "exec_timeout" | "exec_output_too_large" | "exec_failed";
  error?: string;
}

/** 执行接缝：唯一被允许的实现是容器执行（见 ContainerExecRunner） */
export interface LocalExecRunner {
  run(request: ExecRequest): Promise<ExecResultView>;
}

/** 默认限额（与 M2 沙箱的默认语义一致：1 CPU / 256MB / 30s） */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;
/** 输出上限（单流）：4MB。超出即截断——不让一条 `yes` 把内存与账本撑爆 */
export const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const DEFAULT_EXEC_IMAGE = "node:22-alpine";

const KILL_GRACE_MS = 5_000;
const AUX_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 300_000;
/** docker 自身的 maxBuffer 要比我们的截断上限宽裕，否则会先撞 ENOBUFS */
const DOCKER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * 截断到上限并报告是否发生截断（按字节，避免把一个 UTF-8 字符切成半个）。
 *
 * 细节：`Buffer.subarray(0, maxBytes).toString("utf8")` 在切在多字节字符中间时
 * 会产出 U+FFFD 替换字符——输出里平白多出乱码，而且长度还可能超上限。这里
 * 在解码后检测并回退到最后一个完整字符边界（最多回退 3 字节）。
 */
export function truncateOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // UTF-8 续字节形如 0b10xxxxxx：往回退到非续字节边界，避免切出半个字符
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * 构造 `docker run` 参数（纯函数，单测锁死隔离旗标）。
 *
 * 关键点与 M2 的 buildDockerRunArgs 一致，但**不能复用**：那个函数是为
 * "执行打包后的 TS 工具包"（`node /tool/bundle.mjs`）设计的，这里是"执行任意
 * shell 脚本"（`sh -c`），入口与挂载面都不同。复用会迫使其中一个妥协。
 */
export function buildExecDockerArgs(spec: {
  containerName: string;
  image: string;
  script: string;
  workspaceDir?: string;
  workspaceMode: "rw" | "ro";
  timeoutMs: number;
}): string[] {
  const args: string[] = [
    "run",
    "--rm",
    "--name",
    spec.containerName,
    // 网络隔离：动态 bash 没有联网选项（需要联网请走能力/渠道，那里有独立权限维度）
    "--network",
    "none",
    "--cpus",
    "1",
    "--memory",
    "256m",
    "--pids-limit",
    "128",
    "--security-opt",
    "no-new-privileges",
    // 根文件系统只读 + /tmp 独立 tmpfs（脚本要临时文件时用 /tmp，不许写容器根）
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
  ];
  if (spec.workspaceDir !== undefined) {
    args.push("-v", `${spec.workspaceDir}:/workspace:${spec.workspaceMode}`, "-w", "/workspace");
  } else {
    args.push("-w", "/tmp");
  }
  args.push("--entrypoint", "/bin/sh", spec.image, "-c", spec.script);
  return args;
}

export interface ContainerExecRunnerOptions {
  /** docker CLI 桩（探测与执行共用；测试注入） */
  exec?: ExecFn;
  /** 可用性探测桩 */
  detect?: typeof detectContainerRuntime;
  image?: string;
  auxTimeoutMs?: number;
  pullTimeoutMs?: number;
}

/** 生产实现：唯一路径是容器（无"宿主直跑"分支，故意不提供开关） */
export class ContainerExecRunner implements LocalExecRunner {
  readonly #exec: ExecFn;
  readonly #detect: typeof detectContainerRuntime;
  readonly #image: string;
  readonly #auxTimeoutMs: number;
  readonly #pullTimeoutMs: number;

  constructor(options: ContainerExecRunnerOptions = {}) {
    this.#exec = options.exec ?? (defaultDockerExec as unknown as ExecFn);
    this.#detect = options.detect ?? detectContainerRuntime;
    this.#image = options.image ?? DEFAULT_EXEC_IMAGE;
    this.#auxTimeoutMs = options.auxTimeoutMs ?? AUX_TIMEOUT_MS;
    this.#pullTimeoutMs = options.pullTimeoutMs ?? PULL_TIMEOUT_MS;
  }

  async run(request: ExecRequest): Promise<ExecResultView> {
    const started = Date.now();
    const containerName = `morrow-exec-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const runtime = await this.#requireRuntime();

    // 镜像按需拉取（与 M2 同款策略：inspect 缺失才 pull，两者都有界）
    await this.#ensureImage();

    const args = buildExecDockerArgs({
      containerName,
      image: this.#image,
      script: request.script,
      ...(request.workspaceDir === undefined ? {} : { workspaceDir: request.workspaceDir }),
      workspaceMode: request.workspaceMode ?? "rw",
      timeoutMs: request.timeoutMs,
    });

    const raw = await this.#runContainer(runtime.command, args, containerName, request.timeoutMs);
    const duration = Date.now() - started;
    const stdout = truncateOutput(raw.stdout, request.maxOutputBytes);
    const stderr = truncateOutput(raw.stderr, request.maxOutputBytes);
    const truncated = stdout.truncated || stderr.truncated;

    if (raw.timedOut) {
      return {
        ok: false,
        exit_code: raw.exitCode,
        timed_out: true,
        truncated,
        stdout: stdout.text,
        stderr: stderr.text,
        duration_ms: duration,
        engine: runtime.engine,
        image: this.#image,
        container: containerName,
        error_code: "exec_timeout",
        error: `script did not finish within ${request.timeoutMs}ms and was killed`,
      };
    }
    if (raw.maxBufferExceeded === true) {
      return {
        ok: false,
        exit_code: raw.exitCode,
        timed_out: false,
        truncated: true,
        stdout: stdout.text,
        stderr: stderr.text,
        duration_ms: duration,
        engine: runtime.engine,
        image: this.#image,
        container: containerName,
        error_code: "exec_output_too_large",
        error: `script output exceeded the ${DOCKER_MAX_BUFFER_BYTES}-byte transport buffer`,
      };
    }
    return {
      ok: raw.exitCode === 0,
      exit_code: raw.exitCode,
      timed_out: false,
      truncated,
      stdout: stdout.text,
      stderr: stderr.text,
      duration_ms: duration,
      engine: runtime.engine,
      image: this.#image,
      container: containerName,
      ...(raw.exitCode === 0 ? {} : { error_code: "exec_failed" as const, error: `script exited with code ${raw.exitCode}` }),
    };
  }

  async #requireRuntime(): Promise<ContainerRuntimeInfo> {
    const availability = await this.#detect({ exec: this.#exec });
    if (!availability.available || availability.runtime === null) {
      throw new SandboxUnavailableError(availability.installHint ?? DEFAULT_INSTALL_HINT);
    }
    return availability.runtime;
  }

  async #ensureImage(): Promise<void> {
    const inspect = await this.#safeExec(["image", "inspect", this.#image], this.#auxTimeoutMs);
    if (inspect.timedOut) {
      throw new SandboxUnavailableError(
        `\`docker image inspect\` did not respond within ${this.#auxTimeoutMs}ms — the container daemon appears wedged.`,
      );
    }
    if (inspect.exitCode !== 0) {
      const pull = await this.#safeExec(["pull", this.#image], this.#pullTimeoutMs);
      if (pull.timedOut || pull.exitCode !== 0) {
        throw new SandboxError(
          "image_pull_failed",
          `failed to pull ${this.#image}: ${pull.timedOut ? "pull timed out" : pull.stderr.slice(-500)}`,
        );
      }
    }
  }

  /** 有界辅助调用（inspect/pull/kill/rm）：CLI 挂起不能拖垮调用方（M2 的同款教训） */
  #safeExec(args: string[], timeoutMs: number): Promise<ExecResult & { timedOut: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ExecResult & { timedOut: boolean }>((resolve) => {
      // 哨兵保持 ref'd：race 的败者可能不持有任何事件循环句柄
      timer = setTimeout(
        () =>
          resolve({
            stdout: "",
            stderr: `docker call timed out after ${timeoutMs}ms: ${args.join(" ")}`,
            exitCode: 124,
            timedOut: true,
          }),
        timeoutMs,
      );
    });
    return Promise.race([
      this.#exec("docker", args).then(
        (result) => ({ ...result, timedOut: false }),
        () => ({ stdout: "", stderr: "exec failed", exitCode: 127, timedOut: false }),
      ),
      timeout,
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /**
   * 跑容器：超时按容器名 `docker kill`（杀 CLI 客户端不杀容器），再兜底硬停。
   *
   * 硬停是必需的：kill 也可能失败（容器已退出、daemon 卡住），没有兜底就会
   * 让 `run` 永远不 settle——这正是 #65 里"等满 60s 叠加 878s"的同款病症。
   */
  async #runContainer(
    command: string,
    args: string[],
    containerName: string,
    timeoutMs: number,
  ): Promise<ExecResult & { timedOut: boolean; maxBufferExceeded?: boolean }> {
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      void this.#safeExec(["kill", containerName], this.#auxTimeoutMs);
    }, timeoutMs);

    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const hardStop = new Promise<ExecResult & { timedOut: boolean; maxBufferExceeded?: boolean }>((resolve) => {
      hardTimer = setTimeout(
        () => resolve({ stdout: "", stderr: "container did not exit after kill", exitCode: 137, timedOut: true }),
        timeoutMs + KILL_GRACE_MS,
      );
    });

    try {
      return await Promise.race([
        this.#exec(command, args).then((result) => {
          // docker 的 maxBuffer 溢出走 stderr 文案（execFile 的 ENOBUFS / 我们自己的哨兵）
          const maxBufferExceeded = /ENOBUFS|maxBuffer|output exceeded/i.test(result.stderr);
          return { ...result, timedOut, ...(maxBufferExceeded ? { maxBufferExceeded: true } : {}) };
        }),
        hardStop,
      ]);
    } finally {
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      clearTimeout(killTimer);
    }
  }
}

/**
 * 默认 Runner 工厂（生产缺省 = ContainerExecRunner）。
 *
 * 存在这个函数而不是让调用方 `new ContainerExecRunner()`：将来若要支持
 * podman/远端 runner，只需要换这一处；路由层不该知道具体引擎。
 */
export function createDefaultExecRunner(options: ContainerExecRunnerOptions = {}): LocalExecRunner {
  return new ContainerExecRunner(options);
}
