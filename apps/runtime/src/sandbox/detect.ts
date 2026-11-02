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
}

export interface DetectContainerRuntimeOptions {
  /** 探测命令桩（默认真实 execFile；测试注入假 exec） */
  exec?: ExecFn;
  /** 平台桩（默认 process.platform） */
  platform?: NodeJS.Platform;
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

async function probeEngine(
  spec: EngineProbeSpec,
  exec: ExecFn,
  platform: NodeJS.Platform,
): Promise<{ available: boolean; daemonDown: boolean; runtime: ContainerRuntimeInfo | null }> {
  // daemon 探测：`info` 成功 = daemon 可达 + 可用
  const info = await safeExec(exec, spec.command, platform === "win32" ? ["info"] : ["info"]);
  if (info.exitCode !== 0) {
    // CLI 是否存在（--version 纯 CLI 操作，不连 daemon）→ 存在即 daemon-down 态
    const cli = await safeExec(exec, spec.command, ["--version"]);
    return { available: false, daemonDown: cli.exitCode === 0, runtime: null };
  }
  const versionOut = await safeExec(exec, spec.command, ["version", "--format", "{{.Server.Version}}"]);
  const version = versionOut.exitCode === 0 ? versionOut.stdout.trim().split("\n")[0] : "unknown";
  const osField = extractInfoField(info.stdout, "Operating System");
  const engine: ContainerEngine =
    spec.engine === "docker" && osField !== null && /orbstack/i.test(osField) ? "orbstack" : spec.engine;
  return {
    available: true,
    daemonDown: false,
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
 */
export async function detectContainerRuntime(
  options: DetectContainerRuntimeOptions = {},
): Promise<SandboxAvailability> {
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;

  let daemonDown = false;
  for (const spec of probeSpecs(platform)) {
    const probed = await probeEngine(spec, exec, platform);
    if (probed.available) {
      return { available: true, runtime: probed.runtime, installHint: null };
    }
    daemonDown = daemonDown || probed.daemonDown;
  }

  if (platform === "win32" && (await wsl2Available(exec))) {
    return { available: false, runtime: null, installHint: WSL2_HINT };
  }
  const base = INSTALL_HINT[platform] ?? DEFAULT_INSTALL_HINT;
  return { available: false, runtime: null, installHint: daemonDown ? DAEMON_DOWN_HINT_SUFFIX : base };
}
