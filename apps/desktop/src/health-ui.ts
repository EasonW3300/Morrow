/**
 * 健康面板呈现（票 T7 / Issue #8）。
 *
 * GET /v1/health 载荷 → Owner 可读字段行 + 沙箱态说明。纯函数，无 DOM / fetch 依赖。
 * 沙箱四态（apps/runtime/src/health.ts，票 M2-T1 探针真实化）：ready 正常；
 * daemon_down / missing 警示并透出 install_hint；not_configured 是探测显式关闭的
 * 第四态（中性，不算故障）。
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
  const hint = sandbox.install_hint ?? null;
  const engineVersion = sandbox.engine !== undefined && sandbox.engine !== null && sandbox.version ? `（${sandbox.engine} ${sandbox.version}）` : "";
  switch (sandbox.status) {
    case "ready":
      return { label: "沙箱", value: `可用${engineVersion}`, tone: "ok", note: sandbox.detail };
    case "daemon_down":
      return {
        label: "沙箱",
        value: "守护进程不可达",
        tone: "warn",
        note: `${sandbox.detail}${hint ? `。${hint}` : "。能力执行将受影响；请检查容器运行时后刷新。"}`,
      };
    case "missing":
      return {
        label: "沙箱",
        value: "未安装容器运行时",
        tone: "warn",
        note: `${sandbox.detail}${hint ? `。${hint}` : ""}`,
      };
    case "not_configured":
      return {
        label: "沙箱",
        value: "探测未启用（not_configured）",
        tone: "dim",
        note: "沙箱探测被配置关闭（MORROW_SANDBOX_PROBE=off），不是故障；能力沙箱可用性未知。",
      };
    default:
      // 未知状态（旧 runtime / 演进中）：中性呈现，不打错误色
      return { label: "沙箱", value: String(sandbox.status), tone: "dim", note: sandbox.detail };
  }
}
