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
  MorrowRunUsage,
  MorrowTool,
  MorrowToolResult,
  ToolCallDecision,
  ToolCallRequest,
  ToolSchema,
} from "./types.ts";
export { createFakePi, type FakePiConfig, type FakeStep } from "./fake-pi.ts";
export { translatePiEvent } from "./events.ts";
// 用量助手（票 M7-C-T1 / Issue #75）：事件族里的 usage 由适配层产出，累加/估算的
// 纯函数也在这一层——会话层与 Goal 预算共用同一套口径，不各写一份。
export { CHARS_PER_TOKEN, EMPTY_USAGE, addUsage, estimateUsage, readPiUsage, resolveRunUsage } from "./usage.ts";
export { createPiAdapter } from "./pi-adapter.ts";
