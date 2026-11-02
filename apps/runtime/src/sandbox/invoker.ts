/**
 * ToolInvoker（票 M2-T2 / Issue #23）：sandboxed 与 builtin 工具的同一注册 + 调用接缝。
 *
 * 注册：manifest（author/runtime/permissions/sandbox）+ 工具包（TS 入口、Go 编译产物或
 * 进程内实现），注册时规范化并校验 sandbox 契约（fail fast）。
 * 调用固定次序（fail-closed）：
 *   1. 查注册表（unknown_tool）；
 *   2. PermissionEngine.assertRuntimeUse 运行时复核（permission_denied）——先于任何执行；
 *   3. 分发：sandbox.type=builtin → Go builtin 直跑（不经 Runner）；
 *      sandbox.type=process → 进程内实现直呼（human vetted TS 内置件，不经容器/子进程）；
 *      sandbox.type=container → SandboxRunner.run（无容器运行时 → sandbox_unavailable）。
 *
 * 注册表同步（#22 修复批 / FR-CAP-5 调用路径）：runtime 启动时把能力注册表的 enabled
 * 能力登记进来（enable/disable/rollback 生命周期事件经 PermissionEngine.onLifecycle
 * 驱动 register/unregister——disable 即摘除，invoke 报 unknown_tool），使「注册表里的
 * 能力」与「可经本接缝调用的工具」同相；Skill invoke 缺省复用同一实例（不绕安全边界）。
 *
 * 权限→workspace 接线：manifest 声明了 filesystem 权限才挂载 workspace（v1 固定 rw；
 * 仅声明读的场景留 "ro:" 前缀约定，M2-T1 Grant 语义合并后细化）。
 */

import type { SandboxContract } from "./contract.ts";
import { normalizeSandboxContract } from "./contract.ts";
import { runGoWorker, type GoWorkerResult } from "./go-worker.ts";
import type { SandboxPermissionEngine, ToolManifestLite } from "./permission.ts";
import type { SandboxResult, SandboxRunner, SandboxToolPackage } from "./runner.ts";

export class UnknownToolError extends Error {
  readonly code = "unknown_tool";
  constructor(name: string) {
    super(`unknown capability "${name}" (not registered)`);
    this.name = "UnknownToolError";
  }
}

/** 调用结果：统一形状；container 路径附 runner 完整 SandboxResult（engine/image/pulled 证据） */
export interface InvocationResult {
  ok: boolean;
  result?: unknown;
  error_code?: SandboxResult["error_code"];
  error?: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  via: "container" | "builtin-go" | "in-process";
  sandbox?: SandboxResult;
}

/** 进程内工具实现（sandbox.type=process 的执行体；返回结构化结果，抛错按 tool_error 归类） */
export type InProcessTool = (input: unknown, context?: InvokeContext) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

export interface ToolRegistration {
  manifest: ToolManifestLite;
  /** 工具包：sandboxed=typescript 入口（esbuild 预打包）；builtin go=编译产物路径；process 类仅占位形状 */
  package: SandboxToolPackage;
  /** 进程内实现（sandbox.type=process 必填；与 package.binPath/go 容器入口互斥的第三形态） */
  inProcess?: InProcessTool;
}

export interface InvokeContext {
  actorId?: string;
  sessionId?: string;
}

export interface ToolInvokerOptions {
  runner: SandboxRunner;
  permissionEngine: SandboxPermissionEngine;
  /** workspace 根（sandboxed 工具按 manifest 接线挂载） */
  workspaceRoot: string;
}

export class ToolInvoker {
  private readonly tools = new Map<string, ToolRegistration & { contract: SandboxContract }>();
  private readonly runner: SandboxRunner;
  private readonly permissionEngine: SandboxPermissionEngine;
  private readonly workspaceRoot: string;

  constructor(options: ToolInvokerOptions) {
    this.runner = options.runner;
    this.permissionEngine = options.permissionEngine;
    this.workspaceRoot = options.workspaceRoot;
  }

  /** 注册能力（manifest.sandbox 非法 → SandboxContractError，fail fast 不进注册表） */
  register(registration: ToolRegistration): void {
    const { manifest } = registration;
    if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
      throw new Error("manifest.name must be a non-empty string");
    }
    if (manifest.author !== "human" && manifest.author !== "ai") {
      throw new Error(`manifest.author must be "human" | "ai", got: ${String(manifest.author)}`);
    }
    if (manifest.runtime !== "typescript" && manifest.runtime !== "go") {
      throw new Error(`manifest.runtime must be "typescript" | "go", got: ${String(manifest.runtime)}`);
    }
    const contract = normalizeSandboxContract(manifest.sandbox);
    // 包形态与沙箱类型一致：go builtin 直跑；typescript 进容器；process=进程内实现；
    // go 进容器 = 显式不支持
    if (contract.type === "builtin" && manifest.runtime !== "go") {
      throw new Error("builtin sandbox requires runtime=go (TS generated code always runs in the container)");
    }
    if (contract.type === "builtin" && registration.package.binPath === undefined) {
      throw new Error("builtin go tool requires package.binPath (build with workers/go/build.sh)");
    }
    if (contract.type === "container" && manifest.runtime !== "typescript") {
      throw new Error("container sandbox requires runtime=typescript (go workers are vetted builtins, not containerized)");
    }
    if (contract.type === "container" && registration.package.entry === undefined) {
      throw new Error("sandboxed typescript tool requires package.entry");
    }
    if (contract.type === "process" && registration.inProcess === undefined) {
      throw new Error("in-process tool (sandbox.type=process) requires registration.inProcess");
    }
    if (contract.type === "process" && manifest.runtime !== "typescript") {
      throw new Error("in-process tool (sandbox.type=process) requires runtime=typescript");
    }
    this.tools.set(manifest.name, { ...registration, contract });
  }

  /** 摘除注册条目（生命周期 disable 的同步半边；返回是否有条目被摘除） */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  listTools(): Array<{ name: string; version: string; author: string; runtime: string; sandboxType: string }> {
    return [...this.tools.values()].map((t) => ({
      name: t.manifest.name,
      version: t.manifest.version,
      author: t.manifest.author,
      runtime: t.manifest.runtime,
      sandboxType: t.contract.type,
    }));
  }

  async invoke(name: string, input: unknown, context?: InvokeContext): Promise<InvocationResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new UnknownToolError(name);
    }

    // 执行前运行时复核（M2-T1 PermissionEngine 接缝；先权限后执行，fail-closed）
    await this.permissionEngine.assertRuntimeUse({
      manifest: tool.manifest,
      contract: tool.contract,
      input,
      ...(context !== undefined ? { context } : {}),
    });

    if (tool.contract.type === "process") {
      return this.#invokeInProcess(tool, input, context);
    }

    if (tool.contract.type === "builtin") {
      const r = await runGoWorker({
        binPath: tool.package.binPath as string,
        input,
        timeoutMs: tool.contract.resources.timeoutMs,
      });
      return {
        ok: r.ok,
        ...(r.result !== undefined ? { result: r.result } : {}),
        ...(r.error_code !== undefined ? { error_code: r.error_code } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        duration_ms: r.duration_ms,
        via: "builtin-go",
      } satisfies InvocationResult;
    }

    // sandboxed：workspace 按声明接线（声明 filesystem 权限 → rw 挂载；未声明 → 不挂载）
    const pkg: SandboxToolPackage = {
      ...tool.package,
      workspaceDir: (tool.manifest.permissions?.filesystem?.length ?? 0) > 0 ? this.workspaceRoot : undefined,
      workspaceMode: "rw",
    };
    const r = await this.runner.run(pkg, input, tool.contract);
    return {
      ok: r.ok,
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.error_code !== undefined ? { error_code: r.error_code } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      exit_code: r.exit_code,
      stdout: r.stdout,
      stderr: r.stderr,
      duration_ms: r.duration_ms,
      via: "container",
      sandbox: r,
    } satisfies InvocationResult;
  }

  /** 进程内路径：实现抛错按 tool_error 结构化归类（不向调用方裸抛执行异常） */
  async #invokeInProcess(
    tool: ToolRegistration & { contract: SandboxContract },
    input: unknown,
    context?: InvokeContext,
  ): Promise<InvocationResult> {
    const started = Date.now();
    try {
      const out = await tool.inProcess?.(input, context);
      const ok = out?.ok === true;
      return {
        ok,
        ...(out?.result !== undefined ? { result: out.result } : {}),
        ...(out?.error !== undefined ? { error: out.error } : {}),
        ...(ok ? {} : { error_code: out?.error !== undefined ? ("tool_error" as const) : ("tool_protocol_error" as const) }),
        exit_code: ok ? 0 : 1,
        stdout: "",
        stderr: "",
        duration_ms: Date.now() - started,
        via: "in-process",
      } satisfies InvocationResult;
    } catch (err) {
      return {
        ok: false,
        error_code: "tool_error",
        error: err instanceof Error ? err.message : String(err),
        exit_code: 1,
        stdout: "",
        stderr: "",
        duration_ms: Date.now() - started,
        via: "in-process",
      } satisfies InvocationResult;
    }
  }
}

export type { GoWorkerResult };
