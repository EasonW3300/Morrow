/**
 * FakePi —— AgentRuntime 的内存实现（无网络、无 Pi 依赖）。
 *
 * 行为按 script 脚本化：正常流、工具调用（成功/失败/拦截）、错误注入、
 * 流式中断。契约与本包对 PiAdapter 的承诺一致，供本包与业务包测试共用。
 */
import type {
  AgentRuntime,
  AgentStopReason,
  BeforeToolCallHook,
  MorrowAgentEvent,
  MorrowMessage,
  MorrowTool,
} from "./types.ts";

/** 可脚本化的行为步骤 */
export type FakeStep =
  /** 逐个发射 text_delta */
  | { kind: "text"; deltas: string[] }
  /**
   * 调用一次工具：发射 tool_start → 执行（过 beforeToolCall 钩子）→ tool_end。
   * 显式 error 时工具以失败收场；工具抛异常等价失败。
   */
  | {
      kind: "tool";
      toolName: string;
      toolCallId?: string;
      args?: unknown;
      /** 成功时返回给模型的文本 */
      result?: string;
      /** 模拟工具失败：tool_end(isError: true, text=该消息) */
      error?: string;
    }
  /** 注入供应商错误：error 事件 + agent_end(stopReason: "error") */
  | { kind: "error"; message: string }
  /** 挂起直到 abort()（模拟流式中断场景） */
  | { kind: "hang" };

export interface FakePiConfig {
  script?: FakeStep[];
  /** 供 tool 步骤调用的工具实现 */
  tools?: MorrowTool[];
  beforeToolCall?: BeforeToolCallHook;
  systemPrompt?: string;
}

const BLOCKED_SUFFIX = "Tool execution was blocked";

type Listener = (event: MorrowAgentEvent) => void;

export async function createFakePi(config: FakePiConfig = {}): Promise<AgentRuntime> {
  const script: FakeStep[] = config.script ?? [];
  const tools = new Map<string, MorrowTool>((config.tools ?? []).map((t) => [t.name, t]));
  let toolSeq = 0;
  const listeners = new Set<Listener>();
  let disposed = false;
  let active: Promise<void> | null = null;
  let abortController: AbortController | null = null;

  const emit = (event: MorrowAgentEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const finish = (stopReason: AgentStopReason): void => {
    emit({ type: "agent_end", stopReason });
  };

  const runToolStep = async (step: Extract<FakeStep, { kind: "tool" }>): Promise<void> => {
    const toolCallId = step.toolCallId ?? `call-${toolSeq++}`;
    const toolName = step.toolName;
    const args = step.args ?? {};
    emit({ type: "tool_start", toolCallId, toolName, args });

    const end = (text: string, isError: boolean): void => {
      emit({ type: "tool_end", toolCallId, toolName, text, isError });
    };

    const decision = (await config.beforeToolCall?.({ toolCallId, toolName, args })) ?? {};
    if (decision.block) {
      end(decision.reason || BLOCKED_SUFFIX, true);
      return;
    }

    const tool = tools.get(toolName);
    if (!tool) {
      end(`Unknown tool: ${toolName}`, true);
      return;
    }
    try {
      const result = await tool.execute(toolCallId, args, abortController?.signal);
      const aborted = abortController?.signal.aborted === true;
      // 脚本显式声明的失败优先于工具自身的成功结果
      if (step.error !== undefined) {
        end(step.error, true);
        return;
      }
      end(aborted ? "Operation aborted" : result.text, aborted || result.isError === true);
    } catch (err) {
      if (abortController?.signal.aborted === true) {
        end("Operation aborted", true);
        return;
      }
      end(step.error ?? errorMessage(err), true);
      return;
    }
  };

  const runScript = async (signal: AbortSignal): Promise<void> => {
    for (const step of script) {
      if (signal.aborted) break;
      switch (step.kind) {
        case "text": {
          for (const delta of step.deltas) {
            if (signal.aborted) break;
            emit({ type: "text_delta", delta });
          }
          break;
        }
        case "tool": {
          await runToolStep(step);
          break;
        }
        case "error": {
          emit({ type: "error", message: step.message });
          finish("error");
          return;
        }
        case "hang": {
          await hangUntilAbort(signal);
          break;
        }
      }
    }
    finish(signal.aborted ? "aborted" : "stop");
  };

  const run = async (input: string | MorrowMessage[]): Promise<void> => {
    void input; // FakePi 不消费输入；契约由 script 决定
    abortController = new AbortController();
    try {
      await runScript(abortController.signal);
    } finally {
      abortController = null;
    }
  };

  return {
    prompt(input) {
      if (disposed) return Promise.reject(new Error("FakePi already disposed"));
      if (active) return Promise.reject(new Error("FakePi is already running"));
      active = run(input).finally(() => {
        active = null;
      });
      return active;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      abortController?.abort();
    },
    waitForIdle() {
      return active ? active.then(() => undefined) : Promise.resolve();
    },
    dispose() {
      disposed = true;
      abortController?.abort();
      listeners.clear();
    },
  };
}

function hangUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
