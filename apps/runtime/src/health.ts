import { execFile } from "node:child_process";
import { constants as fsConstants, accessSync, statSync } from "node:fs";

/**
 * 沙箱可用性探针（票 M2-T1 / Issue #22；PRD /v1/health 的沙箱维度、§2 执行隔离行）。
 *
 * M0 为桩（恒 not-configured）；本票真实化：探测 docker / podman / OrbStack 的
 * 「命令存在（PATH 查找）→ daemon 可达（探测命令退出码）→ 版本」三级状态，
 * 状态机：
 *   ready           命令存在且 daemon 可达，版本已取得（engine/version 字段给值）
 *   daemon_down     至少一个运行时命令存在，但 daemon 不可达（install_hint 给启动指引）
 *   missing         一个运行时命令都找不到（install_hint 给三 OS 安装指引）
 *   not_configured  探测被配置关闭（MORROW_SANDBOX_PROBE=off）——显式第四态，不是故障
 *
 * 探测顺序 docker → podman → orb（OrbStack 的 docker CLI 兼容层与其 orb 命令）：
 * 命中 daemon 可达的即 ready；全部不可达但存在命令 → daemon_down（detail 列出各自失败
 * 原因）。docker 用 `version --format {{.Server.Version}}`（server 侧，daemon 不可达即
 * 失败）；podman 用 `info --format {{.Version.Version}}`（macOS 需 machine 在跑）；orb 用
 * `orb version`。exec/which 可注入（测试桩；零网络——探测命令是本地 daemon 查询）。
 */

export type SandboxStatus = "not_configured" | "missing" | "daemon_down" | "ready";

export interface SandboxProbe {
  status: SandboxStatus;
  /** 命中的容器运行时：docker | podman | orbstack（ready 时非空） */
  engine: string | null;
  /** daemon 版本（ready 时非空；docker 取 server version） */
  version: string | null;
  detail: string;
  /** missing / daemon_down 时的行动指引；其余为 null */
  install_hint: string | null;
}

export interface SandboxProbeOptions {
  /** PATH 命令查找；缺省扫 PATH 目录找可执行文件 */
  which?: (cmd: string) => string | null;
  /** 命令执行（非零退出码不 reject，返回 exitCode）；缺省 execFile 包装（3s 超时） */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** 安装指引的 OS 基准（缺省 process.platform） */
  platform?: string;
  /** 缺省读 MORROW_SANDBOX_PROBE（=off 关闭探测） */
  enabled?: boolean;
}

interface EngineCandidate {
  id: "docker" | "podman" | "orbstack";
  cmd: string;
  /** 只在 daemon 可达时成功、stdout 即版本号的探测命令 */
  probeArgs: string[];
}

const ENGINES: EngineCandidate[] = [
  { id: "docker", cmd: "docker", probeArgs: ["version", "--format", "{{.Server.Version}}"] },
  { id: "podman", cmd: "podman", probeArgs: ["info", "--format", "{{.Version.Version}}"] },
  { id: "orbstack", cmd: "orb", probeArgs: ["version"] },
];

const PROBE_TIMEOUT_MS = 3_000;

const INSTALL_HINTS: Record<string, string> = {
  darwin:
    "Install a container runtime: OrbStack (brew install --cask orbstack), Docker Desktop (brew install --cask docker), or Podman (brew install podman)",
  linux:
    "Install Docker Engine (https://docs.docker.com/engine/install/) or Podman via your package manager",
  win32:
    "Install Docker Desktop with the WSL2 backend (https://docs.docker.com/desktop/install/windows-install/)",
};

const START_HINTS: Record<string, string> = {
  docker: "start Docker Desktop (or the dockerd service) and retry",
  podman: "start the podman machine (`podman machine init && podman machine start`) and retry",
  orbstack: "open OrbStack once to start its VM and retry",
};

export async function probeSandbox(options: SandboxProbeOptions = {}): Promise<SandboxProbe> {
  const enabled = options.enabled ?? process.env.MORROW_SANDBOX_PROBE !== "off";
  if (!enabled) {
    return {
      status: "not_configured",
      engine: null,
      version: null,
      detail: "sandbox probe is disabled (MORROW_SANDBOX_PROBE=off): capability sandboxing is not being checked",
      install_hint: null,
    };
  }
  const which = options.which ?? defaultWhich;
  const exec = options.exec ?? defaultProbeExec;
  const platform = options.platform ?? process.platform;

  const failures: string[] = [];
  let foundAny = false;
  for (const candidate of ENGINES) {
    const path = which(candidate.cmd);
    if (path === null) continue;
    foundAny = true;
    try {
      const res = await exec(path, candidate.probeArgs);
      if (res.exitCode === 0 && res.stdout.trim().length > 0) {
        const version = res.stdout.trim();
        return {
          status: "ready",
          engine: candidate.id,
          version,
          detail: `${candidate.id} daemon reachable (version ${version})`,
          install_hint: null,
        };
      }
      failures.push(`${candidate.id}: daemon unreachable (exit ${res.exitCode})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${candidate.id}: ${message}`);
    }
  }

  if (!foundAny) {
    return {
      status: "missing",
      engine: null,
      version: null,
      detail: "no container runtime found in PATH (searched: docker, podman, orb) — AI-generated code cannot be sandboxed",
      install_hint: INSTALL_HINTS[platform] ?? INSTALL_HINTS.linux,
    };
  }
  return {
    status: "daemon_down",
    engine: null,
    version: null,
    detail: `container runtime found but daemon unreachable: ${failures.join("; ")}`,
    install_hint: failures.length === 1 ? (START_HINTS[failures[0].split(":")[0]] ?? null) : "start the container runtime daemon and retry",
  };
}

// --- 默认实现（PATH 查找 + execFile 包装） -------------------------------------

/** PATH 扫描找可执行文件（零依赖；Windows 补 .exe 后缀；找不到返回 null） */
export function defaultWhich(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(/[;:]/).filter((dir) => dir.length > 0);
  const suffixes = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const full = `${dir}/${cmd}${suffix}`;
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        accessSync(full, fsConstants.X_OK);
        return full;
      } catch {
        // 不可执行或不存在 → 下一个候选
      }
    }
  }
  return null;
}

function defaultProbeExec(file: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          resolve({ stdout: "", stderr: "", exitCode: 124 });
          return;
        }
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode: code });
      },
    );
  });
}
