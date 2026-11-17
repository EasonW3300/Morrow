/**
 * MCP stdio 传输（票 M7-B-T1 / Issue #67）。
 *
 * NDJSON 行协议：每行一个 JSON-RPC 消息。子进程是**宿主进程**（非容器，ADR-0011），
 * 因此本模块只负责"能可靠地收发与清理"，不做隔离。
 *
 * 关键实现点（都是踩过的坑）：
 *   - **stdout 必须按行切分并缓冲**：一次 data 事件可能给半行或多行，直接 JSON.parse
 *     会在负载下随机失败。
 *   - **stderr 单独收集**：server 的日志不能污染协议流；诊断时要能拿到。
 *   - **只读不回的消息（通知/请求）要能处理**：server 可能主动发 notifications。
 *   - **超时后必须能杀掉子进程**：否则挂起的 server 会积累成僵尸。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRpcResponse } from "./protocol.ts";
import { McpTimeoutError, McpTransportClosedError, type McpTransport } from "./client.ts";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 单条请求的兜底超时（客户端也会用 withTimeout，这里是二层保护） */
  requestTimeoutMs?: number;
  /** stderr 保留的最大字节数（避免日志刷爆内存） */
  maxStderrBytes?: number;
}

/** 等待响应的 pending 条目 */
interface Pending {
  resolve(response: JsonRpcResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export function createStdioTransport(options: StdioTransportOptions): McpTransport {
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;

  let child: ChildProcessWithoutNullStreams | null = null;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  /** 我们自己发出的请求 id → pending（只匹配响应，不匹配 server 主动消息） */
  const pending = new Map<number | string, Pending>();
  /** server 主动发来的通知（供未来扩展；当前丢弃但记录最近一条便于诊断） */
  let lastServerNotification: unknown = null;

  function failAllPending(error: Error): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  }

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 非 JSON 行（server 可能输出横幅/日志到 stdout）：记进 stderr 缓冲区供诊断
      appendStderr(`[non-json stdout] ${trimmed}`);
      return;
    }
    const message = parsed as JsonRpcResponse & { method?: string; id?: number | string };
    if (message.id === undefined || message.id === null) {
      // server 主动通知（如 notifications/tools/list_changed）：记录但当前不处理
      lastServerNotification = message;
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) return; // 未知 id：可能是超时后才到的响应，丢弃
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  }

  function appendStderr(chunk: string): void {
    stderrBuffer += chunk;
    if (stderrBuffer.length > maxStderrBytes) {
      stderrBuffer = stderrBuffer.slice(-maxStderrBytes);
    }
  }

  return {
    isOpen(): boolean {
      return child !== null && child.exitCode === null && !child.killed;
    },

    async start(): Promise<void> {
      if (child !== null && child.exitCode === null) return; // 幂等
      const proc = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      child = proc;

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        // 按行切分：最后一段可能是不完整的，留在缓冲里等下一次 data
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => appendStderr(chunk));

      proc.on("exit", (code, signal) => {
        child = null;
        const reason = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
        failAllPending(new McpTransportClosedError(`MCP server exited (${reason})`));
      });
      proc.on("error", (error) => {
        child = null;
        failAllPending(new McpTransportClosedError(`MCP server error: ${error.message}`));
      });
    },

    async request(message: unknown): Promise<JsonRpcResponse> {
      const proc = child;
      if (proc === null || proc.exitCode !== null) {
        throw new McpTransportClosedError("MCP transport is not running");
      }
      const record = message as { id?: number | string; method?: string };
      const isNotification = record.id === undefined;
      if (isNotification) {
        // 通知：写一行即返回（不等待响应）
        proc.stdin.write(`${JSON.stringify(message)}\n`);
        return { jsonrpc: "2.0", id: null, result: {} };
      }
      const id = record.id as number | string;
      const line = `${JSON.stringify(message)}\n`;
      return await new Promise<JsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new McpTimeoutError(`MCP request ${String(id)} (${record.method ?? "?"}) timed out`));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer, method: record.method ?? "?" });
        proc.stdin.write(line, (error?: Error | null) => {
          if (error !== null && error !== undefined) {
            pending.delete(id);
            clearTimeout(timer);
            reject(new McpTransportClosedError(`failed to write request: ${error.message}`));
          }
        });
      });
    },

    async close(): Promise<void> {
      const proc = child;
      child = null;
      if (proc === null) return;
      failAllPending(new McpTransportClosedError("MCP transport closed"));
      // 先温和终止，2 秒后强杀（对齐桌面壳 sidecar 的既有语义）
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (proc.exitCode === null) proc.kill("SIGKILL");
            resolve();
          }, 2_000);
          proc.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },

    /** 诊断用：最近一条 server 主动通知与 stderr 尾部 */
    get diagnostics(): { lastServerNotification: unknown; stderrTail: string } {
      return { lastServerNotification, stderrTail: stderrBuffer.slice(-2_000) };
    },
  } as McpTransport & { diagnostics: { lastServerNotification: unknown; stderrTail: string } };
}
