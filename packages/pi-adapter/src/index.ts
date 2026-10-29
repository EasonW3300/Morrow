/**
 * @morrow/pi-adapter —— Pi 内核适配层（ADR-0001）。
 *
 * 冻结接口面：AgentRuntime（prompt/subscribe/abort/waitForIdle/dispose）
 * + 五类窄事件 + MorrowTool + beforeToolCall 钩子预留。
 * 业务模块只允许 import 本包，禁止直接 import @earendil-works/*（架构测试强制）。
 */
export type {
  AdapterCompatConfig,
  AdapterConfig,
  AdapterModelConfig,
  AgentRuntime,
  AgentStopReason,
  BeforeToolCallHook,
  MorrowAgentEvent,
  MorrowMessage,
  MorrowTool,
  MorrowToolResult,
  ToolCallDecision,
  ToolCallRequest,
  ToolSchema,
} from "./types.ts";
export { createFakePi, type FakePiConfig, type FakeStep } from "./fake-pi.ts";
export { translatePiEvent } from "./events.ts";
export { createPiAdapter } from "./pi-adapter.ts";
