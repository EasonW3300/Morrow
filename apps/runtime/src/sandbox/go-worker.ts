/**
 * Go builtin Worker 调用（票 M2-T2 / Issue #23，PRD §2 双语言：TS/Go Worker）。
 *
 * Go 工具是 human vetted 的编译产物（manifest: author=human / runtime=go /
 * sandbox.type=builtin），不经容器——直接以子进程运行，stdio JSON 协议与容器内
 * TS 工具完全一致（stdin 注入 JSON 输入、stdout 单行信封回传，见 protocol.ts）。
 * 超时 SIGKILL；退出码/信封分类与 DockerRunner 同口径。
 */

import { spawn } from "node:child_process";
import { parseToolEnvelope } from "./protocol.ts";
import type { SandboxErrorCode } from "./runner.ts";

export interface GoWorkerResult {
  ok: boolean;
  exit_code: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  result?: unknown;
  error_code?: SandboxErrorCode;
  error?: string;
  duration_ms: number;
  via: "builtin-go";
  bin: string;
}

export interface RunGoWorkerOptions {
  /** 编译产物路径（workers/go/build.sh 产出的 bin/textstats） */
  binPath: string;
  input: unknown;
  /** 默认 10s（builtin 工具是 vetted 本地代码，超时上限独立于容器契约） */
  timeoutMs?: number;
}

const DEFAULT_GO_TIMEOUT_MS = 10_000;
const GO_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

interface RawResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function runProcess(binPath: string, input: string, timeoutMs: number): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(`go worker binary not found: ${binPath}（先运行 workers/go/build.sh 构建）`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });

    child.stdin.on("error", () => {/* EPIPE（工具提前退出）：以 close 事件为准 */});
    child.stdin.end(input);
  });
}

function classify(raw: RawResult, timeoutMs: number): Omit<GoWorkerResult, "via" | "bin" | "duration_ms"> {
  const base = { ok: false, exit_code: raw.exitCode, timed_out: raw.timedOut, stdout: raw.stdout, stderr: raw.stderr };
  if (raw.timedOut) {
    return { ...base, error_code: "tool_timeout", error: `go worker exceeded ${timeoutMs}ms and was killed` };
  }
  const envelope = parseToolEnvelope(raw.stdout);
  if (envelope.kind === "result" && raw.exitCode === 0) {
    return { ...base, ok: true, result: envelope.result };
  }
  if (envelope.kind === "tool_error") {
    return { ...base, error_code: "tool_error", error: `tool reported failure: ${envelope.error}` };
  }
  if (raw.exitCode !== 0) {
    return { ...base, error_code: "tool_exit_nonzero", error: `go worker exited with code ${raw.exitCode}` };
  }
  return { ...base, error_code: "tool_protocol_error", error: "exit 0 but stdout has no result envelope" };
}

export async function runGoWorker(options: RunGoWorkerOptions): Promise<GoWorkerResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GO_TIMEOUT_MS;
  const started = Date.now();
  const raw = await runProcess(options.binPath, JSON.stringify(options.input ?? {}), timeoutMs);
  return {
    ...classify(raw, timeoutMs),
    duration_ms: Date.now() - started,
    via: "builtin-go",
    bin: options.binPath,
  };
}
