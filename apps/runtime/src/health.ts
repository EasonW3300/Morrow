/**
 * 沙箱可用性探针（PRD /v1/health 的沙箱维度）。
 *
 * M0 为桩实现：能力沙箱（容器运行时）在能力宿主落地时才接线（ADR-0004 方向），
 * M0 不安装 Docker，恒返回 not-configured——明确的第四态，而非 ok/error。
 */

export type SandboxStatus = "not-configured" | "available" | "unavailable";

export interface SandboxProbe {
  status: SandboxStatus;
  detail: string;
}

export function probeSandbox(): SandboxProbe {
  return {
    status: "not-configured",
    detail: "sandbox probe is a stub in M0: capability sandboxing is not wired yet",
  };
}
