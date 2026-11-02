/**
 * 沙箱契约（manifest.sandbox）类型与规范化（票 M2-T2 / Issue #23）。
 *
 * 契约是 Tool manifest 的 `sandbox` 字段（PRD §6.3）：{"type":"container","network":"none",
 * "filesystem":"workspace-only"}。本模块把原始声明规范化为 runner 可直接执行的完整契约——
 * 缺省补默认（network: none、filesystem: workspace-only、resources 明确默认而非隐式无限），
 * v1 只放行已知取值（fail-closed：未知 network/filesystem 形态直接拒绝，不静默降级）。
 *
 * GLOSSARY Sandbox：「运行 AI 生成代码的隔离执行环境；无可用沙箱时禁止执行生成代码」。
 * builtin（human 签发的 vetted 工具，如 Go Worker）不走容器，但同一契约结构描述其超时语义。
 */

/** 容器资源限额（票面 resources: cpu/mem/timeout）。 */
export interface SandboxResources {
  /** CPU 核数上限（docker --cpus） */
  cpus: number;
  /** 内存上限 MB（docker --memory） */
  memoryMb: number;
  /** 强杀超时 ms（超时 docker kill，超时路径 timed_out=true） */
  timeoutMs: number;
}

/** v1 仅 none（fail-closed）；未来按 PRD 演进 allowlist 等形态时在此放开。 */
export type SandboxNetwork = "none";

/** v1 仅 workspace-only：工具可见的宿主文件系统 = workspace 挂载 + 工具包目录（只读）。 */
export type SandboxFilesystem = "workspace-only";

export interface SandboxContract {
  /** container = 生成代码进容器；builtin = human vetted（Go Worker 等），不经容器 */
  type: "container" | "builtin";
  network: SandboxNetwork;
  filesystem: SandboxFilesystem;
  resources: SandboxResources;
}

/** manifest.sandbox 的原始输入形态（规范化前的宽松形状） */
export interface SandboxContractInput {
  type: "container" | "builtin";
  network?: string;
  filesystem?: string;
  resources?: {
    cpus?: unknown;
    memoryMb?: unknown;
    timeoutMs?: unknown;
  };
}

export class SandboxContractError extends Error {
  readonly code = "invalid_sandbox_contract";
  constructor(message: string) {
    super(message);
    this.name = "SandboxContractError";
  }
}

/** resources 默认：1 CPU / 256MB / 30s（明确的第四态思想——限额可见，不隐式无限）。 */
export const DEFAULT_SANDBOX_RESOURCES: SandboxResources = {
  cpus: 1,
  memoryMb: 256,
  timeoutMs: 30_000,
};

export const RESOURCE_LIMITS = {
  cpus: { min: 0.05, max: 8 },
  memoryMb: { min: 32, max: 8192 },
  timeoutMs: { min: 100, max: 600_000 },
} as const;

function parseResourceNumber(
  value: unknown,
  field: keyof SandboxResources,
  limits: { min: number; max: number },
): number {
  if (typeof value === "undefined" || value === null) {
    return DEFAULT_SANDBOX_RESOURCES[field];
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new SandboxContractError(
      `sandbox.resources.${field} must be a number between ${limits.min} and ${limits.max}`,
    );
  }
  return value;
}

/**
 * 规范化 manifest.sandbox 声明为完整契约。入参 unknown：这是校验边界，任意形状
 * （含 manifest 反序列化产物）都可传入。抛 SandboxContractError（code=
 * invalid_sandbox_contract）表示声明不可执行——上层（Invoker/未来路由）应把该工具
 * 注册/调用判为非法而非降级到无沙箱执行。
 */
export function normalizeSandboxContract(input: unknown): SandboxContract {
  if (typeof input !== "object" || input === null) {
    throw new SandboxContractError("sandbox contract must be an object");
  }
  const raw = input as SandboxContractInput;
  if (raw.type !== "container" && raw.type !== "builtin") {
    throw new SandboxContractError(`sandbox.type must be "container" or "builtin", got: ${String(raw.type)}`);
  }
  const network = raw.network ?? "none";
  if (network !== "none") {
    throw new SandboxContractError(
      `sandbox.network only supports "none" in v1 (fail-closed), got: ${String(network)}`,
    );
  }
  const filesystem = raw.filesystem ?? "workspace-only";
  if (filesystem !== "workspace-only") {
    throw new SandboxContractError(
      `sandbox.filesystem only supports "workspace-only" in v1, got: ${String(filesystem)}`,
    );
  }
  const resources = raw.resources ?? {};
  return {
    type: raw.type,
    network,
    filesystem,
    resources: {
      cpus: parseResourceNumber(resources.cpus, "cpus", RESOURCE_LIMITS.cpus),
      memoryMb: parseResourceNumber(resources.memoryMb, "memoryMb", RESOURCE_LIMITS.memoryMb),
      timeoutMs: parseResourceNumber(resources.timeoutMs, "timeoutMs", RESOURCE_LIMITS.timeoutMs),
    },
  };
}
