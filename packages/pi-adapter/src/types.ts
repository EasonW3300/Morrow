/**
 * PiAdapter 冻结接口面（ADR-0001）。
 *
 * 这里的一切都是 Morrow 自有类型：不 re-export Pi 类型，不让 @earendil-works/*
 * 出现在本包之外的任何签名里。事件形态取笔记 NOTES-pi §9 的五类窄事件建议。
 */

/** Agent 运行停止原因（Pi StopReason 的窄化集合，透传不翻译） */
export type AgentStopReason = "stop" | "length" | "toolUse" | "aborted" | "error" | "deferred";

/**
 * Morrow 侧窄事件（五类）。Pi 原始 10+ 类事件在适配层内翻译；
 * 被丢弃的信息（turn/message 生命周期、thinking、toolcall 流式细节）
 * 属于会话层的关注点，不经此接口外泄（NOTES-pi §9）。
 */
export type MorrowAgentEvent =
  /** 模型流式输出文本增量 */
  | { type: "text_delta"; delta: string }
  /** 工具开始执行（参数已经过 schema 校验） */
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  /** 工具执行结束；isError 表示工具失败或被拦截 */
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      /** 返回给模型的文本（失败时为错误描述） */
      text: string;
      isError: boolean;
      /** 执行耗时（毫秒，存在时） */
      durationMs?: number;
    }
  /** 一次 prompt 运行结束；总是最后一条事件 */
  | { type: "agent_end"; stopReason: AgentStopReason }
  /** 供应商/运行错误；其后仍会有 agent_end 收尾 */
  | { type: "error"; message: string };

/** Morrow 工具结果 */
export interface MorrowToolResult {
  /** 返回给模型的文本 */
  text: string;
  /** true 表示工具侧失败 */
  isError?: boolean;
}

/** 工具参数 schema：JSON Schema 对象（TypeBox TSchema 与其兼容） */
export type ToolSchema = Record<string, unknown>;

/** Morrow 工具定义；由适配层翻译为 Pi AgentTool */
export interface MorrowTool {
  name: string;
  description: string;
  parameters: ToolSchema;
  execute(toolCallId: string, args: unknown, signal?: AbortSignal): Promise<MorrowToolResult>;
}

/**
 * Morrow 侧 prompt 输入消息。M0 只收用户文本消息：会话历史由适配层内的
 * Pi agent state 持有（NOTES-pi §9），不通过 prompt 注入。
 */
export interface MorrowMessage {
  role: "user";
  content: string;
}

/** 工具调用请求（beforeToolCall 钩子入参） */
export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  /** 校验后的工具参数 */
  args: unknown;
}

/** 工具调用裁决：{ block: true } 拦截执行；M0 只透传，不做策略（ADR-0001） */
export interface ToolCallDecision {
  block?: boolean;
  reason?: string;
}

export type BeforeToolCallHook = (
  request: ToolCallRequest,
) => ToolCallDecision | void | Promise<ToolCallDecision | void>;

/** OpenAI 兼容端点的 compat 开关（ADR-0002；透传给 pi-ai） */
export interface AdapterCompatConfig {
  /** false → system prompt 走 system 消息而非 developer（vLLM/Ollama 等常需） */
  supportsDeveloperRole?: boolean;
  /** false → 不发送 reasoning_effort */
  supportsReasoningEffort?: boolean;
  /** false → 不请求 stream_options.include_usage */
  supportsUsageInStreaming?: boolean;
}

/** 模型配置（base_url + api_key + model 三元组中的 model 部分） */
export interface AdapterModelConfig {
  id: string;
  contextWindow: number;
  maxTokens: number;
  /** 模型是否具备推理能力 */
  reasoning?: boolean;
}

export interface AdapterConfig {
  /** OpenAI Chat Completions 兼容端点地址（ADR-0002） */
  baseUrl: string;
  /** 静态 key 或动态解析器（密钥轮换/OS 凭据库场景） */
  apiKey: string | (() => string | Promise<string>);
  model: AdapterModelConfig;
  compat?: AdapterCompatConfig;
  systemPrompt?: string;
  tools?: MorrowTool[];
  /** 权限钩子预留：M0 只透传（放行/拦截），策略在业务层 */
  beforeToolCall?: BeforeToolCallHook;
}

/**
 * Agent 运行时冻结接口。PiAdapter 与 FakePi 都实现它；
 * 业务模块（会话/编排）只依赖此接口，不得触达 Pi。
 */
export interface AgentRuntime {
  /**
   * 发起一次 prompt 运行。运行中的供应商/工具错误以 error 事件呈现而不抛出；
   * 仅在误用（并发 prompt、dispose 后调用）时 reject。
   */
  prompt(input: string | MorrowMessage[]): Promise<void>;
  /** 订阅窄事件；返回退订函数。 */
  subscribe(listener: (event: MorrowAgentEvent) => void): () => void;
  /** 中止当前运行；已产出事件不丢失，其后仍有 agent_end(aborted)。 */
  abort(): void;
  /** 等待当前运行结束（含 agent_end 监听器结算）。空闲时立即 resolve。 */
  waitForIdle(): Promise<void>;
  /** 释放运行时；之后不可再 prompt。 */
  dispose(): void;
}
