/**
 * Chat 投影的帧归约语义（票 T6 / Issue #7 验收核心）。
 *
 * 覆盖 runtime SSE 的 durable/易失帧契约（apps/runtime README「SSE 会话事件流」）：
 *   - durable 帧（带 id = 账本 seq）顺序与账本一致，按 seq 去重（重连重放边界）；
 *   - text_delta 是易失展示层增量，只累积渲染；
 *   - message.assistant 是权威全文（每轮恰好一条），到达即覆盖易失累积；
 *   - done 关轮：清残留易失文本（错误轮可能没有 assistant 收尾）。
 * 纯函数，无 DOM 依赖 —— node:test 直接跑（--experimental-strip-types）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyFrame,
  emptyChatState,
  stateFromHistory,
  type ChatItem,
  type Envelope,
  type Frame,
} from "./sse.ts";

let seq = 100;
function eventFrame(
  eventType: string,
  payload: Record<string, unknown>,
  override?: { sequence?: number } & Partial<Envelope>,
): Frame {
  seq += 1;
  return {
    type: "event",
    sequence: override?.sequence ?? seq,
    envelope: {
      event_id: `evt-${seq}`,
      event_type: eventType,
      occurred_at: "2026-10-29T10:00:00.000Z",
      session_id: "s1",
      payload,
      ...override,
    },
  };
}

function items(state: { items: ChatItem[] }): ChatItem[] {
  return state.items;
}

test("message.user 开轮：追加 user 气泡并标记 turnActive", () => {
  const state = applyFrame(emptyChatState(), eventFrame("message.user", { message_id: "m1", text: "你好" }));
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].kind, "message");
  const message = state.items[0] as Extract<ChatItem, { kind: "message" }>;
  assert.equal(message.role, "user");
  assert.equal(message.text, "你好");
  assert.equal(state.turnActive, true);
  assert.equal(state.lastSeq, 101);
});

test("text_delta 累积进易失 streaming 缓冲，不产生 item", () => {
  let state = applyFrame(emptyChatState(), eventFrame("message.user", { message_id: "m1", text: "hi" }));
  state = applyFrame(state, { type: "delta", delta: "Hel" });
  state = applyFrame(state, { type: "delta", delta: "lo" });
  assert.equal(state.streaming, "Hello");
  assert.equal(state.items.length, 1); // 只有 user 气泡
  assert.equal(state.turnActive, true);
});

test("tool.started 出现未完成工具项；tool.finished 就地补全结果与耗时", () => {
  let state = applyFrame(emptyChatState(), eventFrame("message.user", { message_id: "m1", text: "现在几点" }));
  state = applyFrame(state, eventFrame("tool.started", { tool_call_id: "t1", tool_name: "get_time", args: { tz: "Asia/Shanghai" } }));
  state = applyFrame(state, eventFrame("tool.finished", { tool_call_id: "t1", tool_name: "get_time", text: "12:00", is_error: false, duration_ms: 42 }));
  const tools = items(state).filter((item) => item.kind === "tool");
  assert.equal(tools.length, 1, "started/finished 应合并为同一工具项");
  const tool = tools[0] as Extract<ChatItem, { kind: "tool" }>;
  assert.equal(tool.toolName, "get_time");
  assert.equal(tool.finished, true);
  assert.equal(tool.resultText, "12:00");
  assert.equal(tool.isError, false);
  assert.equal(tool.durationMs, 42);
  assert.equal(JSON.parse(tool.argsText).tz, "Asia/Shanghai");
});

test("tool.finished(is_error) 标记失败；无对应 started 也能渲染（重连重放防御）", () => {
  const state = applyFrame(
    emptyChatState(),
    eventFrame("tool.finished", { tool_call_id: "t9", tool_name: "run_code", text: "boom", is_error: true }),
  );
  const tool = state.items[0] as Extract<ChatItem, { kind: "tool" }>;
  assert.equal(tool.finished, true);
  assert.equal(tool.isError, true);
  assert.equal(tool.resultText, "boom");
});

test("agent.error 渲染为错误项", () => {
  const state = applyFrame(emptyChatState(), eventFrame("agent.error", { message: "provider timeout" }));
  const error = state.items[0] as Extract<ChatItem, { kind: "error" }>;
  assert.equal(error.kind, "error");
  assert.equal(error.message, "provider timeout");
});

test("message.assistant 是权威全文：覆盖易失累积并清空 streaming", () => {
  let state = applyFrame(emptyChatState(), eventFrame("message.user", { message_id: "m1", text: "hi" }));
  state = applyFrame(state, { type: "delta", delta: "Hel" });
  state = applyFrame(state, { type: "delta", delta: "lo" });
  // 权威全文与易失累积不一致（例如中断轮已产出前缀 + stop_reason）也以 durable 为准
  state = applyFrame(
    state,
    eventFrame("message.assistant", { message_id: "m2", text: "Hello, world", stop_reason: "stop" }),
  );
  const assistant = state.items.at(-1) as Extract<ChatItem, { kind: "message" }>;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.text, "Hello, world");
  assert.equal(assistant.stopReason, "stop");
  assert.equal(state.streaming, "");
  assert.equal(state.turnActive, true, "轮次要到 done 才关闭");
});

test("stop_reason 透传（aborted/error 轮）", () => {
  let state = applyFrame(emptyChatState(), eventFrame("message.user", { message_id: "m1", text: "hi" }));
  state = applyFrame(state, { type: "delta", delta: "部分输出" });
  state = applyFrame(state, eventFrame("message.assistant", { message_id: "m2", text: "部分输出", stop_reason: "aborted" }));
  const assistant = state.items.at(-1) as Extract<ChatItem, { kind: "message" }>;
  assert.equal(assistant.stopReason, "aborted");
  assert.equal(assistant.text, "部分输出");
});

test("durable 帧按 sequence 去重：重复投递不产生重复 item", () => {
  let state = emptyChatState();
  const frame = eventFrame("message.user", { message_id: "m1", text: "你好" }, { sequence: 7 });
  state = applyFrame(state, frame);
  state = applyFrame(state, frame);
  assert.equal(state.items.length, 1);
  assert.equal(state.lastSeq, 7);
});

test("session.created 等非渲染事件只推进游标", () => {
  let state = applyFrame(emptyChatState(), eventFrame("session.created", { title: "smoke" }, { sequence: 1 }));
  assert.equal(state.items.length, 0);
  assert.equal(state.lastSeq, 1);
  state = applyFrame(state, eventFrame("message.user", { message_id: "m1", text: "你好" }, { sequence: 2 }));
  assert.equal(state.items.length, 1);
});

test("done 关轮：清残留易失文本（工厂失败轮没有 assistant 收尾）", () => {
  let state = applyFrame(emptyChatState(), eventFrame("message.user", { message_id: "m1", text: "hi" }));
  state = applyFrame(state, { type: "delta", delta: "partial" });
  state = applyFrame(state, { type: "done" });
  assert.equal(state.turnActive, false);
  assert.equal(state.streaming, "");
});

test("stateFromHistory 以 GET messages 投影播种：items 顺序与 lastSeq 正确，重放去重生效", () => {
  const state = stateFromHistory([
    { message_id: "m1", role: "user", text: "你好", sequence: 5, occurred_at: "2026-10-29T10:00:00Z" },
    { message_id: "m2", role: "assistant", text: "你好！有什么可以帮你？", stop_reason: "stop", sequence: 6, occurred_at: "2026-10-29T10:00:01Z" },
  ]);
  assert.equal(state.items.length, 2);
  assert.equal(state.lastSeq, 6);
  // 重启后 SSE 从 0 重放：<= lastSeq 的 durable 帧全部去重
  const replayed = applyFrame(state, eventFrame("message.user", { message_id: "m1", text: "你好" }, { sequence: 5 }));
  assert.equal(replayed.items.length, 2);
  // 新一轮（seq 更大）正常渲染
  const next = applyFrame(replayed, eventFrame("message.user", { message_id: "m3", text: "再来一条" }, { sequence: 9 }));
  assert.equal(next.items.length, 3);
  assert.equal(next.turnActive, true);
});
