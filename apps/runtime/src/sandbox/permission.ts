/**
 * 运行时权限复核挂钩（票 M2-T2 / Issue #23 第 4 项）。
 *
 * PermissionEngine 是 M2-T1（能力注册表与权限模型 / Issue #22）定义的单一入口——
 * 注册校验（permissions ⊆ PermissionGrant）与运行时校验共用。本票在执行前调用
 * `assertRuntimeUse`，接口形状按票面口径先行落地；M2-T1 合并后由 merger 对齐
 * 真实实现（Grant 五维存储 + 生命周期），本文件的 LocalPermissionEngine 只是
 * 确定性本地判定桩：不依赖 LLM、不依赖数据库，测试与无注册表环境可独立工作。
 */

import type { SandboxContract } from "./contract.ts";

/** manifest 权限五维（PRD §6.3；M2-T1 的 manifest v1 字段集，这里取必需子集） */
export interface ToolPermissions {
  filesystem?: string[];
  network?: string[];
  shell?: string[];
  channels?: string[];
  credentials?: string[];
}

/** 注册表条目的 manifest 形状（本票所需字段；M2-T1 完整 manifest v1 向后兼容） */
export interface ToolManifestLite {
  name: string;
  version: string;
  author: "human" | "ai";
  runtime: "typescript" | "go";
  permissions?: ToolPermissions;
  /** manifest.sandbox 原始声明（注册时规范化校验） */
  sandbox: {
    type: "container" | "builtin";
    network?: string;
    filesystem?: string;
    resources?: {
      cpus?: unknown;
      memoryMb?: unknown;
      timeoutMs?: unknown;
    };
  };
}

export interface RuntimeUseContext {
  actorId?: string;
  sessionId?: string;
}

export interface RuntimeUseRequest {
  manifest: ToolManifestLite;
  contract: SandboxContract;
  input: unknown;
  context?: RuntimeUseContext;
}

/**
 * 权限引擎单一入口（M2-T1 接缝）。实现方约定：拒绝时抛 PermissionDeniedError；
 * 通过即返回（void）。执行前复核必须发生在任何执行机制（容器/直跑）之前。
 */
export interface PermissionEngine {
  assertRuntimeUse(req: RuntimeUseRequest): Promise<void>;
}

export class PermissionDeniedError extends Error {
  readonly code = "permission_denied";
  readonly reason: string;
  constructor(reason: string) {
    super(`runtime use denied: ${reason}`);
    this.name = "PermissionDeniedError";
    this.reason = reason;
  }
}

/** 绝对路径形态（POSIX 与 Windows 盘符；workspace:// 协议另算） */
const ABSOLUTE_PATH_RE = /^(\/|\\|[A-Za-z]:[\\/])/;
const WORKSPACE_PROTOCOL = "workspace://";

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
}

/**
 * 本地判定桩（确定性，零 LLM 零存储）：
 * 1. 契约一致性——manifest 声明了 network 权限但沙箱契约是 network none：工具要拿到
 *    沙箱明确不给的东西，按 fail-closed 拒绝（去修 manifest 或契约，不静默降级）；
 * 2. filesystem 越界——输入里出现的绝对路径若不在 workspaceRoot 下（也不是
 *    workspace:// 引用），在沙箱执行前即拒绝（越界路径本就进不了容器，提前拒绝把
 *    诊断留在权限层而非让工具运行时撞 ENOENT）。
 * M2-T1 合并后由其 Grant 五维语义接管，本实现仅作基线守卫。
 */
export function createLocalPermissionEngine(options: { workspaceRoot: string }): PermissionEngine {
  const workspaceRoot = options.workspaceRoot;
  return {
    async assertRuntimeUse(req: RuntimeUseRequest): Promise<void> {
      const { manifest, contract } = req;

      if (contract.type === "container" && contract.network === "none") {
        const networkPerms = manifest.permissions?.network ?? [];
        if (networkPerms.length > 0) {
          throw new PermissionDeniedError(
            `manifest declares network permissions (${networkPerms.join(", ")}) but the sandbox contract is network:none — fail-closed`,
          );
        }
      }

      if (contract.filesystem === "workspace-only") {
        const strings: string[] = [];
        collectStrings(req.input, strings);
        for (const s of strings) {
          if (s.startsWith(WORKSPACE_PROTOCOL)) continue;
          if (!ABSOLUTE_PATH_RE.test(s)) continue;
          if (s === workspaceRoot || s.startsWith(workspaceRoot.endsWith("/") ? workspaceRoot : workspaceRoot + "/")) continue;
          throw new PermissionDeniedError(
            `filesystem scope is workspace-only but input references an absolute path outside the workspace: ${s}`,
          );
        }
      }
    },
  };
}
