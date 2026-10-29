/**
 * PiAdapter —— @earendil-works/pi-agent-core@1.4.0 + pi-ai@1.4.0 的冻结适配（ADR-0001/0002）。
 *
 * Provider 只走 OpenAI Chat Completions 兼容协议（createProvider + openAICompletionsApi）；
 * Pi 的 10+ 类原始事件经 translatePiEvent 收窄为五类窄事件。
 * 本文件是 packages/ 之下唯一允许 import @earendil-works/* 的地方（架构测试强制）。
 */
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { translatePiEvent } from "./events.ts";
import type {
  AdapterConfig,
  AgentRuntime,
  BeforeToolCallHook,
  MorrowAgentEvent,
  MorrowMessage,
  MorrowTool,
} from "./types.ts";

const PROVIDER_ID = "morrow";

export async function createPiAdapter(config: AdapterConfig): Promise<AgentRuntime> {
  const model: Model<"openai-completions"> = {
    id: config.model.id,
    name: config.model.id,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: config.baseUrl,
    reasoning: config.model.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.model.contextWindow,
    maxTokens: config.model.maxTokens,
    // 显式 compat：对未知端点不做自动探测（ADR-0002；NOTES-pi §5）
    compat: config.compat,
  };

  const resolveKey = config.apiKey;
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Morrow",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "Morrow API key",
        resolve: async () => {
          const key = typeof resolveKey === "function" ? await resolveKey() : resolveKey;
          return { auth: { apiKey: key } };
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt ?? "",
      model,
      tools: (config.tools ?? []).map(toAgentTool),
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
    beforeToolCall: config.beforeToolCall ? toPiBeforeToolCall(config.beforeToolCall) : undefined,
  });

  // --- 事件管道：pi AgentEvent → 五类窄事件 → Morrow 监听器 ------------------
  const listeners = new Set<(event: MorrowAgentEvent) => void>();
  const piUnsubscribe = agent.subscribe((event: AgentEvent) => {
    for (const narrowed of translatePiEvent(event)) {
      for (const listener of [...listeners]) listener(narrowed);
    }
  });

  let disposed = false;
  let active: Promise<void> | null = null;

  return {
    async prompt(input: string | MorrowMessage[]): Promise<void> {
      if (disposed) throw new Error("PiAdapter already disposed");
      if (active) throw new Error("PiAdapter is already running");
      const run = (async () => {
        // 供应商/工具错误以 error 事件呈现（translatePiEvent），prompt 只在误用时 reject
        if (typeof input === "string") await agent.prompt(input);
        else await agent.prompt(toPiMessages(input));
      })();
      active = run.finally(() => {
        active = null;
      });
      await active;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      agent.abort();
    },
    waitForIdle() {
      return active ? active.then(() => undefined) : agent.waitForIdle();
    },
    dispose() {
      disposed = true;
      agent.abort();
      piUnsubscribe();
      listeners.clear();
    },
  };
}

/** MorrowTool → Pi AgentTool：补 label，结果折叠为单文本 content */
function toAgentTool(tool: MorrowTool): AgentTool {
  return {
    name: tool.name,
    description: tool.description,
    label: tool.name,
    parameters: tool.parameters as AgentTool["parameters"],
    execute: async (toolCallId, params, signal) => {
      const result = await tool.execute(toolCallId, params, signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: {},
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
}

/** Morrow beforeToolCall 钩子 → Pi BeforeToolCall；M0 只透传裁决，不做策略 */
function toPiBeforeToolCall(hook: BeforeToolCallHook): NonNullable<AgentOptions["beforeToolCall"]> {
  return async (context, _signal): Promise<BeforeToolCallResult | undefined> => {
    const decision = (await hook({
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      args: context.args,
    })) ?? {};
    if (decision.block === true) {
      return { block: true, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) };
    }
    return undefined;
  };
}

/** MorrowMessage[] → pi 用户消息（M0 只做文本用户消息；历史由 agent state 持有） */
function toPiMessages(input: MorrowMessage[]): AgentMessage[] {
  return input.map((m) => ({ role: "user", content: m.content, timestamp: Date.now() }));
}
