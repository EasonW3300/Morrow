# pi-adapter

Pi 内核适配层。锁定 Pi release 版本，冻结内部接口；业务模块禁止直接 import Pi API（ADR-0001）。

## 版本锁定（可追溯）

| 包 | 锁定版本 | 依据 |
|---|---|---|
| `@earendil-works/pi-agent-core` | `1.4.0`（exact pin，见 package.json 与 pnpm-lock.yaml） | npm `latest`，对应 git tag `v1.4.0`（badlogic/pi-mono，2026-10-21 发布） |
| `@earendil-works/pi-ai` | `1.4.0`（exact pin） | 与 pi-agent-core 同节奏发布；显式声明以便使用 `api/openai-completions.lazy` 子路径 |

升级 Pi = 显式 ADR 变更 + 本包契约测试（FakePi 套件 + fixtures 回放 + 真实接线）全绿后方可合入。

**引擎注意**：Pi 1.4.0 声明 `node >= 22.19.0`；当前开发机为 22.12.0。实测本包全部测试（含真实接线）在 22.12 上通过，但升级开发环境到 ≥22.19 仍是既定要求（NOTES-pi §7）。

## 冻结接口面

业务模块只允许 `import { … } from "@morrow/pi-adapter"`：

- `createPiAdapter(cfg: AdapterConfig): Promise<AgentRuntime>` —— 真实 Pi 接线（Provider 只走 OpenAI Chat Completions 兼容协议，ADR-0002）
- `createFakePi(cfg: FakePiConfig): Promise<AgentRuntime>` —— 同接口内存实现，行为可脚本化（正常流 / 工具成功与失败 / 错误注入 / 流式中断），供业务包测试引用
- `translatePiEvent(event: unknown): MorrowAgentEvent[]` —— 纯翻译函数（fixtures 回放、会话层复用）
- 类型：`AgentRuntime`、`MorrowAgentEvent`、`MorrowTool`、`MorrowToolResult`、`ToolSchema`、`AdapterConfig`、`BeforeToolCallHook` 等

`AgentRuntime`：`prompt(input)` / `subscribe(listener)` / `abort()` / `waitForIdle()` / `dispose()`。

### 五类窄事件

Pi 原始 10+ 类事件在适配层内翻译（NOTES-pi §9），对外只暴露：

| Morrow 事件 | 来源 |
|---|---|
| `text_delta` | `message_update(assistantMessageEvent.text_delta)` |
| `tool_start` | `tool_execution_start` |
| `tool_end` | `tool_execution_end`（content 折叠为纯文本） |
| `agent_end` | `agent_end`（带最后一条 assistant 消息的 stopReason） |
| `error` | `agent_end` 中最后一条 assistant `stopReason === "error"`（先于 agent_end） |

契约要点：

- `agent_end` 总是一次运行的最后一条事件；错误运行（stopReason `error`）先发 `error` 再发 `agent_end`。
- 中断（`abort()`）以 `agent_end(stopReason: "aborted")` 收尾，**不发** `error`；已产出事件不丢失。
- 供应商/工具错误以事件呈现，`prompt()` 只在误用（并发 prompt、dispose 后调用）时 reject。
- `beforeToolCall` 钩子（M0 只透传，不做策略）：返回 `{ block: true, reason? }` 拦截工具执行，被拦截调用以 `tool_end(isError: true)` 呈现（与 Pi 语义一致）。

## fixtures

`fixtures/pi-1.4.0/` 存放按 pi-mono v1.4.0 事件形态录制的静态 JSON（正常流 / 供应商错误 / 流式中断），由 `test/events.replay.test.ts` 回放。回放只经过纯函数 `translatePiEvent`，不 import Pi 运行时（与引擎版本解耦）。

## 架构测试

`test/architecture.test.ts` 扫描 `packages/` 之下除本包外的所有源文件，出现 `@earendil-works/*` import 即红（ADR-0001 的强制执行点）。
