/**
 * 桌面壳联调夹具（票 T6 / Issue #7）：startRuntime + 脚本化 AgentRuntime（无网络、无 Provider）。
 *
 * 用途：给浏览器端 UI 验证（vite dev + ?runtime=http://127.0.0.1:<port>）提供一个
 * 可复现的会话流——text_delta 流式、工具成功/失败、agent.error、assistant 收尾。
 * 不进测试套件，与 smoke-real-provider.ts 同级的手动工具；不改动 src 逻辑。
 *
 *   MORROW_DATA_DIR=<持久目录，重启可回看历史> \
 *   node --experimental-sqlite --experimental-strip-types scripts/dev-fixture.ts
 *
 * stdout 单行 ready JSON（与 src/main.ts 协议一致）；SIGTERM/SIGINT 优雅退出。
 * 输入路由：含「出错」→ 供应商错误轮；含「失败」→ 工具失败轮；其余 → 文本 + 工具成功轮。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import type { AgentRuntime, MorrowAgentEvent } from "@morrow/pi-adapter";

/** 脚本化运行时：按输入文本挑场景，事件序列与 PiAdapter 五类窄事件契约一致 */
function createScriptedRuntime(sessionId: string): AgentRuntime {
  void sessionId;
  const listeners = new Set<(event: MorrowAgentEvent) => void>();
  let toolSeq = 0;
  const emit = (event: MorrowAgentEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const emitText = (chunks: string[]): void => {
    for (const delta of chunks) emit({ type: "text_delta", delta });
  };
  const emitTool = (toolName: string, args: Record<string, unknown>, result: string, isError: boolean): void => {
    const toolCallId = `fixture-call-${toolSeq++}`;
    emit({ type: "tool_start", toolCallId, toolName, args });
    emit({ type: "tool_end", toolCallId, toolName, text: result, isError, durationMs: 12 });
  };

  return {
    async prompt(input: string | { content: string }[]): Promise<void> {
      const text = typeof input === "string" ? input : input.map((m) => m.content).join(" ");
      if (text.includes("出错")) {
        emit({ type: "error", message: "fixture: simulated provider failure (503 upstream)" });
        emit({ type: "agent_end", stopReason: "error" });
        return;
      }
      emitText(["Morrow 收到：", "「", text, "」。", "这是夹具回合，", "流式增量按 text_delta 发送。"]);
      if (text.includes("失败")) {
        emitTool("run_code", { code: "throw new Error('boom')" }, "boom: exit 1", true);
      } else {
        emitTool("lookup_time", { tz: "Asia/Shanghai" }, "2026-10-29T18:00:00+08:00", false);
      }
      emit({ type: "agent_end", stopReason: "stop" });
    },
    subscribe(listener: (event: MorrowAgentEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort(): void {
      // 夹具回合瞬时完成，无需实现中断
    },
    async waitForIdle(): Promise<void> {},
    dispose(): void {
      listeners.clear();
    },
  };
}

const envDataDir = process.env.MORROW_DATA_DIR;
const dataDir = envDataDir ?? mkdtempSync(join(tmpdir(), "morrow-fixture-"));
const config = loadConfigWith(dataDir);
const runtime = await startRuntime(config, {
  agentAdapterFactory: (sessionId: string) => Promise.resolve(createScriptedRuntime(sessionId)),
});

console.log(
  JSON.stringify({
    ready: true,
    version: "0.1.0",
    fixture: true,
    host: runtime.host,
    port: runtime.port,
    pid: process.pid,
    data_dir: config.dataDir,
    replica_id: config.replicaId,
  }),
);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void runtime
    .close(signal)
    .then(() => {
      console.log(JSON.stringify({ stopped: true, signal }));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("[fixture] error during shutdown:", err);
      process.exit(1);
    });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/** 与 loadConfig 一致，仅覆盖 dataDir（夹具默认临时目录，显式 MORROW_DATA_DIR 可持久） */
function loadConfigWith(dataDir: string) {
  const config = loadConfig();
  return { ...config, dataDir };
}
