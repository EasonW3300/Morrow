/**
 * 工具 stdout 结构化回传协议（票 M2-T2 / Issue #23，PRD §5：stdout/stderr 结构化回传）。
 *
 * 容器内（或 Go builtin）工具的输出契约：
 * - stdout 最后一个非空行必须是单行 JSON 信封：{"ok":true,"result":…} 或 {"ok":false,"error":"…"}；
 * - stderr 承载诊断（不参与协议解析，原样回传给调用方）；
 * - stdout 前部允许工具自身的日志行（解析只取最后一个非空行）。
 *
 * ADR-0006 关联：沙箱内工具不碰主库——一切输出经本协议以 JSON 回传，由 Runtime 落账。
 */

export type ToolEnvelope =
  | { kind: "result"; result: unknown }
  | { kind: "tool_error"; error: string }
  | { kind: "malformed"; raw: string }
  | { kind: "empty" };

export function parseToolEnvelope(stdout: string): ToolEnvelope {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    return { kind: "empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { kind: "malformed", raw: last };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed", raw: last };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.ok === true && "result" in obj) {
    return { kind: "result", result: obj.result };
  }
  if (obj.ok === false && typeof obj.error === "string") {
    return { kind: "tool_error", error: obj.error };
  }
  return { kind: "malformed", raw: last };
}

/** 工具侧构造成功信封（Go/TS 工具实现同款形状） */
export function resultEnvelope(result: unknown): string {
  return JSON.stringify({ ok: true, result });
}

/** 工具侧构造失败信封 */
export function errorEnvelope(error: string): string {
  return JSON.stringify({ ok: false, error });
}
