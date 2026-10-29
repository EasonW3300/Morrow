/**
 * 健康面板呈现（票 T7 / Issue #8）。
 *
 * GET /v1/health 载荷 → Owner 可读字段行 + 沙箱态说明。纯函数，无 DOM / fetch 依赖。
 * 沙箱三态（apps/runtime/src/health.ts）：M0 恒为 not-configured（桩）——呈现为
 * 「未接入」的中性态并提示 M2 接入沙箱后可用；available 正常；unavailable 警示。
 */

export type { HealthPayload } from "./api.ts";
import type { HealthPayload } from "./api.ts";

export interface HealthLine {
  label: string;
  value: string;
  tone: "ok" | "warn" | "dim";
  note?: string;
}

export interface HealthPresentation {
  tone: "ok" | "warn";
  summary: string;
  lines: HealthLine[];
  sandboxNote: string;
  refreshedAt: string;
}

export function describeHealth(payload: HealthPayload, refreshedAt: string): HealthPresentation {
  const sandbox = describeSandbox(payload.sandbox);
  return {
    tone: payload.status === "ok" ? "ok" : "warn",
    summary:
      payload.status === "ok"
        ? "Runtime 运行正常"
        : `Runtime 状态异常（${payload.status}）`,
    lines: [
      { label: "状态", value: payload.status, tone: payload.status === "ok" ? "ok" : "warn" },
      { label: "版本", value: payload.version, tone: "dim" },
      { label: "副本 ID（replica_id）", value: payload.replica_id, tone: "dim" },
      { label: "账本事件数", value: String(payload.ledger.events), tone: "dim" },
      sandbox,
    ],
    sandboxNote: sandbox.note ?? "",
    refreshedAt,
  };
}

function describeSandbox(sandbox: HealthPayload["sandbox"]): HealthLine {
  switch (sandbox.status) {
    case "available":
      return { label: "沙箱", value: "可用", tone: "ok", note: sandbox.detail };
    case "unavailable":
      return {
        label: "沙箱",
        value: "不可用",
        tone: "warn",
        note: `${sandbox.detail}。能力执行将受影响；请检查容器运行时后刷新。`,
      };
    case "not-configured":
    default:
      // M0 明确第四态：沙箱探针是桩，不是故障
      return {
        label: "沙箱",
        value: "未接入（not-configured）",
        tone: "dim",
        note: "M0 的沙箱探针为桩：能力沙箱尚未接线，属预期状态，M2 接入沙箱后可用。",
      };
  }
}
