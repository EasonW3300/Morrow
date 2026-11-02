/**
 * SandboxRunner 接缝（票 M2-T2 / Issue #23，接口注入的新内部接缝）。
 *
 * Runner 只服务 sandboxed 类工具（manifest.sandbox.type=container 的生成代码）；
 * builtin（human vetted，如 Go Worker）不经 Runner，由 ToolInvoker 直接分发——
 * 「无沙箱 → 拒绝执行生成代码」不波及 builtin。
 *
 * 错误口径（HTTP 映射在接入路由层时按本表执行，本票为库层接缝）：
 * - sandbox_unavailable      → 503（无可用容器运行时，附对应 OS install-hint）
 * - tool_package_unsupported → 400（包形态不能进该沙箱，如 go 进 node 容器）
 * - tool_build_failed        → 500（esbuild 预打包失败）
 * - image_pull_failed        → 503（基础镜像拉取失败，网络/registry 问题）
 * 工具执行失败不抛错，以 SandboxResult{ok:false,error_code:…} 结构化返回。
 */

import type { SandboxContract } from "./contract.ts";

/** 沙箱内工具包：kind=typescript 经 esbuild 预打包进容器；kind=go 为编译产物（builtin 直跑） */
export interface SandboxToolPackage {
  name: string;
  kind: "typescript" | "go";
  /** kind=typescript：esbuild 入口 .ts 文件 */
  entry?: string;
  /** kind=go：已编译二进制路径（builtin 类） */
  binPath?: string;
  /** workspace 目录（宿主路径；缺省 = 工具不碰文件系统，容器不挂 workspace） */
  workspaceDir?: string;
  /** workspace 挂载读写（manifest permissions.filesystem 含写域 → rw，否则 ro；默认 ro） */
  workspaceMode?: "rw" | "ro";
}

export type SandboxErrorCode =
  | "tool_error"
  | "tool_timeout"
  | "tool_exit_nonzero"
  | "tool_protocol_error"
  | "tool_output_too_large"
  | "sandbox_unavailable"
  | "tool_package_unsupported"
  | "tool_build_failed"
  | "image_pull_failed";

export interface SandboxResult {
  ok: boolean;
  /** 容器内进程退出码（超时强杀通常 137） */
  exit_code: number;
  timed_out: boolean;
  stdout: string;
  /** 工具诊断输出（原样回传，不进协议解析） */
  stderr: string;
  /** ok=true 时的结构化结果（协议信封 result 字段） */
  result?: unknown;
  /** ok=false 时的失败归类与消息 */
  error_code?: SandboxErrorCode;
  error?: string;
  duration_ms: number;
  engine: string;
  image: string;
  /** 本次执行触发了基础镜像 pull（镜像拉取策略记录：node:22-alpine 首次按需拉取） */
  pulled?: boolean;
}

export interface SandboxRunner {
  /**
   * 在隔离环境执行工具包。input 以 JSON 经 stdin 注入；结果经 stdout 结构化协议回传
   * （见 protocol.ts）。超时强杀（timed_out=true）；资源限额按 contract.resources。
   */
  run(toolPackage: SandboxToolPackage, input: unknown, contract: SandboxContract): Promise<SandboxResult>;
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly installHint?: string;
  constructor(code: SandboxErrorCode, message: string, installHint?: string) {
    super(installHint === undefined ? message : `${message} ${installHint}`);
    this.name = "SandboxError";
    this.code = code;
    this.installHint = installHint;
  }
}

/** 无可用容器运行时（拒绝路径）：sandboxed 调用一律拒绝，附对应 OS 安装指引。 */
export class SandboxUnavailableError extends SandboxError {
  constructor(installHint: string) {
    super("sandbox_unavailable", "no usable container runtime: sandboxed (AI-generated) tools are refused.", installHint);
    this.name = "SandboxUnavailableError";
  }
}
