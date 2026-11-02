/**
 * docker run 参数构建（纯函数，票 M2-T2 / Issue #23）。
 *
 * 隔离旗标是 manifest.sandbox 契约的强制落地（PRD §2 / §5 安全语义）——在这里单测锁死：
 * - `--network none`（network 契约 v1 仅 none）；
 * - `--cpus` / `--memory`（resources 契约）；
 * - `--read-only`（filesystem=workspace-only：容器根文件系统只读，可写面仅 workspace 挂载
 *   与 /tmp tmpfs）+ 工具包目录 `:ro` 挂载；
 * - `--name`（超时强杀按名 docker kill）、`-i`（stdin 注入输入）、无 `-t`（stdout 不被 tty 污染，
 *   结构化回传协议依赖干净 stdout）；
 * - 纵深加固：`--pids-limit`（fork 炸弹止血）、`--security-opt no-new-privileges`。
 */

import type { SandboxContract } from "./contract.ts";

export interface DockerRunSpec {
  /** 容器名（morrow-sb-<shortid>；超时 docker kill 用） */
  containerName: string;
  image: string;
  /** 打包产物在容器内的路径（如 /tool/bundle.js） */
  bundleContainerPath: string;
  /** 工具包目录（宿主路径，只读挂载到 /tool） */
  packageHostDir: string;
  /** workspace 目录（宿主路径，挂载到 /workspace；缺省 = 工具声明不碰文件系统） */
  workspaceHostDir?: string;
  workspaceMode: "rw" | "ro";
  contract: SandboxContract;
}

export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const { contract } = spec;
  const args: string[] = [
    "run",
    "--rm",
    "--name", spec.containerName,
    "--network", "none",
    "--cpus", String(contract.resources.cpus),
    "--memory", `${contract.resources.memoryMb}m`,
    "--pids-limit", "128",
    "--security-opt", "no-new-privileges",
    // workspace-only：根文件系统只读 + /tmp 独立 tmpfs（noexec 防落地二进制再执行）
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
  ];
  if (spec.workspaceHostDir !== undefined) {
    args.push("-v", `${spec.workspaceHostDir}:/workspace:${spec.workspaceMode}`);
  }
  args.push(
    "-v", `${spec.packageHostDir}:/tool:ro`,
    "-i",
    "-w", "/workspace",
    spec.image,
    "node", spec.bundleContainerPath,
  );
  return args;
}
