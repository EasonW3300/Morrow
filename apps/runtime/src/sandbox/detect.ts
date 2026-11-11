/**
 * 容器运行时检测器（票 M2-T2 / Issue #23，PRD §2 执行隔离行 + FR-CAP-4）。
 *
 * 三 OS 检测口径（探测命令可桩注入——keyring.ts ExecFn 同款 seam，测试零真实命令）：
 * - docker：`docker info` 成功即可用；引擎归类看 info 的 OperatingSystem 字段
 *   （macOS 上 Docker Desktop 与 OrbStack 都走 `docker` CLI，OrbStack 归类为 orbstack）；
 * - podman：docker 不可用后探测 `podman info`；
 * - WSL2（Windows）：docker.exe 不可用时探测 `wsl.exe --status`——子系统在但无容器引擎
 *   是「可安装」态，install-hint 给 WSL2 专项指引；
 * - CLI 存在但 daemon 不可达（--version 成功、info 失败）：install-hint 点名启动 daemon，
 *   区别于完全未安装。
 *
 * 无可用容器运行时 → sandboxed 调用拒绝（sandbox_unavailable + install-hint），
 * builtin 工具不经此路径（DockerRunner 仅服务 sandboxed 类）。
 */

import type { ExecFn, ExecResult } from "../keyring.ts";
import { defaultExec } from "../keyring.ts";

/** 归一化的容器引擎标识（OrbStack 与 Docker Desktop 共用 docker CLI，归类在引擎名上） */
export type ContainerEngine = "docker" | "podman" | "orbstack" | "wsl2-docker";

export interface ContainerRuntimeInfo {
  engine: ContainerEngine;
  /** 引擎 server 版本（取不到时 "unknown"） */
  version: string;
  /** 实际执行的 CLI 命令名（Windows 为 docker.exe/podman.exe） */
  command: string;
  /** 引擎细节（如 "OrbStack"、"Docker Desktop"） */
  detail?: string;
}

export interface SandboxAvailability {
  available: boolean;
  runtime: ContainerRuntimeInfo | null;
  /** available=false 时的安装/修复指引（对应 OS） */
  installHint: string | null;
  /**
   * 探测命令超时标记（options.timeoutMs 开启时）：CLI 挂起（而非快速失败）的诚实
   * 区分——容器测试套件据此 skip 并注明「探测超时」理由（#23 修复批）。
   */
  probeTimedOut?: boolean;
}

export interface DetectContainerRuntimeOptions {
  /** 探测命令桩（默认真实 execFile；测试注入假 exec） */
  exec?: ExecFn;
  /** 平台桩（默认 process.platform） */
  platform?: NodeJS.Platform;
  /**
   * 单条探测命令的超时界（ms；缺省 = 不加界，沿用 exec 自身语义）。开启后每条探测
   * 命令与超时哨兵 race，超时按「探测失败（exit 124）」归类并置 probeTimedOut——
   * 测试套件用它把「docker CLI 挂起」与「确实无运行时」诚实区分开。
   */
  timeoutMs?: number;
}

/** 各 OS 安装指引（拒绝路径的 install-hint 文本；保持单源供测试断言） */
const LINUX_INSTALL_HINT =
  "No usable container runtime. Install Docker Engine (https://docs.docker.com/engine/install/) or Podman " +
  "(https://podman.io/docs/installation), then verify with `docker info` / `podman info`. " +
  "Sandboxed (AI-generated) tools are refused until a container runtime is available.";

export const INSTALL_HINT: Partial<Record<NodeJS.Platform, string>> = {
  darwin:
    "No usable container runtime. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) " +
    "or OrbStack (https://orbstack.dev/), then verify with `docker info`. " +
    "Sandboxed (AI-generated) tools are refused until a container runtime is available.",
  linux: LINUX_INSTALL_HINT,
  win32:
    "No usable container runtime. Install Docker Desktop with the WSL2 backend " +
    "(https://docs.docker.com/desktop/setup/install/windows-install/; enable the WSL2 integration), " +
    "then verify with `docker info`. " +
    "Sandboxed (AI-generated) tools are refused until a container runtime is available.",
};

/** 未知平台的兜底指引（Linux 文本最通用：Docker Engine / Podman） */
export const DEFAULT_INSTALL_HINT: string = LINUX_INSTALL_HINT;

const WSL2_HINT =
  "WSL2 detected but no usable container engine inside it. Install Docker Desktop with WSL2 integration " +
    "(https://docs.docker.com/desktop/setup/install/windows-install/) or install Docker Engine inside your " +
    "WSL2 distribution. Sandboxed (AI-generated) tools are refused until a container runtime is available.";

const DAEMON_DOWN_HINT_SUFFIX =
    "A container CLI is installed but its daemon is not reachable — start Docker Desktop / OrbStack " +
    "(or `sudo systemctl start docker` / `podman system service`) and verify with `docker info`. " +
    "Sandboxed (AI-generated) tools are refused until the daemon is up.";

interface EngineProbeSpec {
  engine: Exclude<ContainerEngine, "wsl2-docker"> | ContainerEngine;
  command: string;
}

function probeSpecs(platform: NodeJS.Platform): EngineProbeSpec[] {
  const exe = platform === "win32" ? ".exe" : "";
  return [
    { engine: "docker", command: `docker${exe}` },
    { engine: "podman", command: `podman${exe}` },
  ];
}

/** 超时哨兵退出码（有界探测把 CLI 挂起归类为此——timeout(1) 同款约定） */
export const PROBE_TIMED_OUT_EXIT_CODE = 124;

async function probeEngine(
  spec: EngineProbeSpec,
  exec: ExecFn,
  platform: NodeJS.Platform,
): Promise<{ available: boolean; daemonDown: boolean; timedOut: boolean; runtime: ContainerRuntimeInfo | null }> {
  // daemon 探测：`info` 成功 = daemon 可达 + 可用
  const info = await safeExec(exec, spec.command, platform === "win32" ? ["info"] : ["info"]);
  if (info.exitCode !== 0) {
    // CLI 是否存在（--version 纯 CLI 操作，不连 daemon）→ 存在即 daemon-down 态
    const cli = await safeExec(exec, spec.command, ["--version"]);
    return {
      available: false,
      daemonDown: cli.exitCode === 0,
      timedOut: info.exitCode === PROBE_TIMED_OUT_EXIT_CODE,
      runtime: null,
    };
  }
  const versionOut = await safeExec(exec, spec.command, ["version", "--format", "{{.Server.Version}}"]);
  const version = versionOut.exitCode === 0 ? versionOut.stdout.trim().split("\n")[0] : "unknown";
  const osField = extractInfoField(info.stdout, "Operating System");
  const engine: ContainerEngine =
    spec.engine === "docker" && osField !== null && /orbstack/i.test(osField) ? "orbstack" : spec.engine;
  return {
    available: true,
    daemonDown: false,
    timedOut: false,
    runtime: {
      engine,
      version: version || "unknown",
      command: spec.command,
      ...(osField !== null ? { detail: osField } : {}),
    },
  };
}

async function safeExec(exec: ExecFn, file: string, args: string[]): Promise<ExecResult> {
  try {
    return await exec(file, args);
  } catch {
    // ENOENT（CLI 不存在）等执行层失败统一视为不可用（与 keyring defaultExec 的非零退出码口径一致）
    return { stdout: "", stderr: "probe failed", exitCode: 127 };
  }
}

function extractInfoField(stdout: string, field: string): string | null {
  const line = stdout.split("\n").find((l) => l.startsWith(`${field}:`));
  return line === undefined ? null : line.slice(field.length + 1).trim();
}

function wsl2Available(exec: ExecFn): Promise<boolean> {
  return safeExec(exec, "wsl.exe", ["--status"]).then((r) => r.exitCode === 0);
}

/**
 * 检测本机容器运行时。顺序：docker → podman；Windows 上两者都不可用再探 WSL2
 * （子系统在但无引擎 → WSL2 专项指引）。探测顺序固定，第一个可用者胜出。
 * options.timeoutMs 开启有界探测：CLI 挂起按超时归类（probeTimedOut=true），探测总
 * 耗时有上界（每条命令一界），测试套件据此诚实 skip。
 */
export async function detectContainerRuntime(
  options: DetectContainerRuntimeOptions = {},
): Promise<SandboxAvailability> {
  const rawExec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs;
  const exec: ExecFn =
    timeoutMs === undefined
      ? rawExec
      : (file, args) => {
          let timer: NodeJS.Timeout | undefined;
          return Promise.race([
            // exec 自身以 reject 表达「被杀」（defaultExec 的 SIGTERM 超时同款）→ 按超时哨兵
            // 归类：探测有界的语义是「界内无结论」，reject 与哨兵同为无结论（不区分成因）
            rawExec(file, args).catch(
              () =>
                ({
                  stdout: "",
                  stderr: `${file} ${args.join(" ")} did not complete within ${timeoutMs}ms probe bound`,
                  exitCode: PROBE_TIMED_OUT_EXIT_CODE,
                }) as ExecResult,
            ),
            new Promise<ExecResult>((resolve) => {
              // 超时哨兵必须保持 ref'd：race 的败者可能不持有任何事件循环句柄（挂起的
              // 注入桩、句柄已被收走的进程），unref 会让事件循环先空、race 永不 settle
              //（node:test 报 "Promise resolution is still pending"——node 22/24 时序差异根因）。
              timer = setTimeout(
                () => resolve({ stdout: "", stderr: `${file} ${args.join(" ")} timed out after ${timeoutMs}ms`, exitCode: PROBE_TIMED_OUT_EXIT_CODE }),
                timeoutMs,
              );
            }),
          ]).finally(() => {
            // 胜出路径清掉 ref'd 哨兵：不 clear 会把进程空拖到界才退出（探测尾部延迟）
            if (timer !== undefined) clearTimeout(timer);
          });
        };

  let daemonDown = false;
  let probeTimedOut = false;
  for (const spec of probeSpecs(platform)) {
    const probed = await probeEngine(spec, exec, platform);
    if (probed.available) {
      return { available: true, runtime: probed.runtime, installHint: null };
    }
    daemonDown = daemonDown || probed.daemonDown;
    probeTimedOut = probeTimedOut || probed.timedOut;
  }

  if (platform === "win32" && (await wsl2Available(exec))) {
    return { available: false, runtime: null, installHint: WSL2_HINT, ...(probeTimedOut ? { probeTimedOut: true } : {}) };
  }
  const base = INSTALL_HINT[platform] ?? DEFAULT_INSTALL_HINT;
  return {
    available: false,
    runtime: null,
    installHint: daemonDown ? DAEMON_DOWN_HINT_SUFFIX : base,
    ...(probeTimedOut ? { probeTimedOut: true } : {}),
  };
}
