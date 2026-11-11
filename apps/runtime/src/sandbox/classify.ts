/**
 * 工具执行结果分类器（#22 修复批 / C9 单源）：DockerRunner 的 classifyRun 与
 * Go Worker 的 classify 同构——同为「退出码 + 超时标志 + stdout 结构化信封」到
 * SandboxErrorCode 的映射。差异只在文案主体（tool vs go worker）、stderr 尾部诊断
 * 是否随行、maxBuffer 哨兵与超时退出码归一这几个协议细节，全部参数化于此；
 * 两个 Runner 保留薄包装以维持各自的返回形状与既有调用点。
 */

import { parseToolEnvelope } from "./protocol.ts";
import type { SandboxErrorCode } from "./runner.ts";

/** 分类器输入：进程退出三要素（Runner 的 exec 结果投影） */
export interface ToolRunRaw {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** 分类结果（两个 Runner 返回形状的公共核） */
export interface ClassifiedToolRun {
  ok: boolean;
  exit_code: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  result?: unknown;
  error_code?: SandboxErrorCode;
  error?: string;
}

export interface ClassifyToolRunOptions {
  /** 超时阈值（仅用于错误文案） */
  timeoutMs: number;
  /** 错误文案里的运行主体名（容器路径 "tool"，Go Worker 路径 "go worker"） */
  subject: string;
  /** 超时/非零退出文案附带 stderr 尾部诊断（容器路径 true——容器内诊断只在 stderr） */
  stderrTailDetail?: boolean;
  /** 协议违规文案附带 stdout 尾行（容器路径 true） */
  protocolTailDetail?: boolean;
  /** maxBuffer 哨兵退出码（DockerRunner 以 -2 标记输出超限；Go Worker 无此约定不传） */
  maxBufferExitCode?: number;
  /** 超时路径下退出码 0 的归一值（DockerRunner 归一为 137 的 SIGKILL 语义；Go Worker 不归一） */
  timeoutExitCodeZeroAs?: number;
}

/** stderr 尾部诊断（末 3 行、截 400 字符——容器路径错误文案随行） */
export function stderrTail(stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-3).join(" | ");
  return tail.length > 0 ? tail.slice(0, 400) : "(no stderr)";
}

/**
 * 统一分类次序（fail-closed，与两 Runner 原口径逐字一致）：
 * maxBuffer → 超时 → stdout 信封 result（exit 0）→ 信封 tool_error → 非零退出 → 协议违规。
 */
export function classifyToolRun(raw: ToolRunRaw, options: ClassifyToolRunOptions): ClassifiedToolRun {
  const base = { exit_code: raw.exitCode, timed_out: raw.timedOut, stdout: raw.stdout, stderr: raw.stderr };
  if (options.maxBufferExitCode !== undefined && raw.exitCode === options.maxBufferExitCode) {
    return { ...base, ok: false, error_code: "tool_output_too_large", error: "tool stdout exceeded 32MB" };
  }
  if (raw.timedOut) {
    const tail = options.stderrTailDetail === true ? ` (stderr: ${stderrTail(raw.stderr)})` : "";
    return {
      ...base,
      exit_code: options.timeoutExitCodeZeroAs !== undefined && raw.exitCode === 0 ? options.timeoutExitCodeZeroAs : raw.exitCode,
      ok: false,
      error_code: "tool_timeout",
      error: `${options.subject} exceeded ${options.timeoutMs}ms and was killed${tail}`,
    };
  }
  const envelope = parseToolEnvelope(raw.stdout);
  if (envelope.kind === "result" && raw.exitCode === 0) {
    return { ...base, ok: true, result: envelope.result };
  }
  if (envelope.kind === "tool_error") {
    return { ...base, ok: false, error_code: "tool_error", error: `tool reported failure: ${envelope.error}` };
  }
  if (raw.exitCode !== 0) {
    const tail = options.stderrTailDetail === true ? ` (stderr: ${stderrTail(raw.stderr)})` : "";
    return {
      ...base,
      ok: false,
      error_code: "tool_exit_nonzero",
      error: `${options.subject} exited with code ${raw.exitCode}${tail}`,
    };
  }
  const tailDetail =
    options.protocolTailDetail === true
      ? ` (last line: ${raw.stdout.trim().slice(0, 120) || "(empty)"})`
      : "";
  return {
    ...base,
    ok: false,
    error_code: "tool_protocol_error",
    error: `exit 0 but stdout has no result envelope${tailDetail}`,
  };
}
