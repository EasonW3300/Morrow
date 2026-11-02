/**
 * 运行时权限复核挂钩（票 M2-T2 / Issue #23 第 4 项）。
 *
 * PermissionEngine 是 M2-T1（能力注册表与权限模型 / Issue #22）定义的单一入口——
 * 注册校验（permissions ⊆ PermissionGrant）与运行时校验共用。本票在执行前调用
 * `assertRuntimeUse`，接口形状按票面口径先行落地；M2-T1 合并后由 merger 对齐
 * 真实实现（Grant 五维存储 + 生命周期），本文件的 LocalPermissionEngine 只是
 * 确定性本地判定桩：不依赖 LLM、不依赖数据库，测试与无注册表环境可独立工作。
 */

import type { CapabilityUseRequest } from "@morrow/protocol";
import { join } from "node:path";
import { CapabilityError } from "../capabilities/engine.ts";
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
  /** manifest.sandbox 原始声明（注册时规范化校验；process = 进程内实现） */
  sandbox: {
    type: "container" | "builtin" | "process";
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
export interface SandboxPermissionEngine {
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
export function createLocalPermissionEngine(options: { workspaceRoot: string }): SandboxPermissionEngine {
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

/** M2-T1 PermissionEngine 的运行时复核面（结构最小化——只依赖 assertRuntimeUse 形状） */
export interface RegistryRuntimeChecker {
  /** m2t1 口径：能力必须存在且 enabled，请求五维 ⊆ manifest ∩ grant；拒绝抛 CapabilityError */
  assertRuntimeUse(name: string, request?: CapabilityUseRequest): unknown;
}

/**
 * 注册表运行时复核适配器（merger 对齐件，票 #23 ↔ #22）：
 * 第一道 = 本地确定性基线（契约一致性 + workspace 越界——注册表不知道 sandbox 契约与输入）；
 * 第二道 = M2-T1 注册表 assertRuntimeUse（存在/enabled/五维 ⊆ manifest ∩ grant），
 * 从输入派生**具体路径**（workspace:// 解析为 workspace 下具体路径；绝对路径原样——
 * 越界的已被第一道拒绝）。network 维不派生：v1 沙箱契约恒 network:none（容器层强制），
 * 输入里的 URL 串是待处理数据而非本次出网目标，派生会把正常输入误判为越权；
 * 将来放开 network 契约时在此加显式声明通道。
 * CapabilityError（not_found/invalid_state/escalation）→ PermissionDeniedError（本接缝统一口径）。
 */
export function createRegistryPermissionAdapter(options: {
  registry: RegistryRuntimeChecker;
  workspaceRoot: string;
}): SandboxPermissionEngine {
  const local = createLocalPermissionEngine({ workspaceRoot: options.workspaceRoot });
  return {
    async assertRuntimeUse(req: RuntimeUseRequest): Promise<void> {
      await local.assertRuntimeUse(req);
      const request: CapabilityUseRequest = {};
      const fsPaths = deriveConcretePaths(req.input, options.workspaceRoot);
      if (fsPaths.length > 0) {
        request.filesystem = fsPaths;
      }
      try {
        options.registry.assertRuntimeUse(req.manifest.name, request);
      } catch (err) {
        if (err instanceof CapabilityError) {
          throw new PermissionDeniedError(`registry ${err.code}: ${err.message}`);
        }
        throw err;
      }
    },
  };
}

function deriveConcretePaths(input: unknown, workspaceRoot: string): string[] {
  const strings: string[] = [];
  collectStrings(input, strings);
  const paths = new Set<string>();
  for (const s of strings) {
    if (s.startsWith(WORKSPACE_PROTOCOL)) {
      const rel = s.slice(WORKSPACE_PROTOCOL.length).replace(/^\/+/, "");
      if (rel.length > 0) {
        paths.add(join(workspaceRoot, rel));
      }
      continue;
    }
    if (ABSOLUTE_PATH_RE.test(s)) {
      paths.add(s);
    }
  }
  return [...paths];
}
