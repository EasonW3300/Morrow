/**
 * 录制 fixtures 回放测试 —— Pi 1.4.0 真实事件形态 → 五类窄事件。
 *
 * fixtures 取自 pi-mono v1.4.0 的 AgentEvent / AssistantMessageEvent /
 * Message 形态（packages/agent/src/types.ts、packages/ai/src/types.ts），
 * 以静态 JSON 存于本包 fixtures/pi-1.4.0/。回放只经过纯函数 translatePiEvent，
 * 不 import 任何 @earendil-works/* 运行时代码（Node 22.12 引擎隔离）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { translatePiEvent, type MorrowAgentEvent } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures", "pi-1.4.0");

function loadFixture(name: string): { events: unknown[]; description: string } {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

describe("Pi 1.4.0 fixtures 回放：正常对话流（文本 + 工具 + 文本）", () => {
  const fixture = loadFixture("normal-text-tool.json");

  it("翻译为五类窄事件的期望序列", () => {
    const out: MorrowAgentEvent[] = [];
    for (const event of fixture.events) out.push(...translatePiEvent(event));

    assert.deepEqual(out, [
      { type: "text_delta", delta: "北京今天" },
      { type: "text_delta", delta: "晴。" },
      { type: "tool_start", toolCallId: "call_abc123", toolName: "get_weather", args: { city: "北京" } },
      {
        type: "tool_end",
        toolCallId: "call_abc123",
        toolName: "get_weather",
        text: "晴，12°C",
        isError: false,
        durationMs: 42,
      },
      { type: "text_delta", delta: "北京晴，12°C。" },
      { type: "agent_end", stopReason: "stop" },
    ]);
  });

  it("turn/message 生命周期与 toolcall 流式细节被丢弃（不出现在窄事件里）", () => {
    const types = new Set<MorrowAgentEvent["type"]>();
    for (const event of fixture.events) for (const e of translatePiEvent(event)) types.add(e.type);
    assert.deepEqual([...types].sort(), ["agent_end", "text_delta", "tool_end", "tool_start"]);
  });
});

describe("Pi 1.4.0 fixtures 回放：供应商错误", () => {
  const fixture = loadFixture("provider-error.json");

  it("stopReason=error 的 assistant 消息映射为 error 事件，agent_end 随后收尾", () => {
    const out: MorrowAgentEvent[] = [];
    for (const event of fixture.events) out.push(...translatePiEvent(event));

    assert.deepEqual(out, [
      { type: "text_delta", delta: "让我查" },
      { type: "error", message: "HTTP 502: upstream connect error" },
      { type: "agent_end", stopReason: "error" },
    ]);
  });
});

describe("Pi 1.4.0 fixtures 回放：流式中断", () => {
  const fixture = loadFixture("aborted-stream.json");

  it("aborted 映射为 agent_end(stopReason=aborted)，不产生 error 事件", () => {
    const out: MorrowAgentEvent[] = [];
    for (const event of fixture.events) out.push(...translatePiEvent(event));

    assert.deepEqual(out, [
      { type: "text_delta", delta: "我正在" },
      { type: "text_delta", delta: "整理你的偏好" },
      { type: "agent_end", stopReason: "aborted" },
    ]);
  });
});

describe("翻译函数的全域性", () => {
  it("每个 fixture 的每条事件都能翻译而不抛出", () => {
    for (const name of ["normal-text-tool.json", "provider-error.json", "aborted-stream.json"]) {
      const fixture = loadFixture(name);
      for (const event of fixture.events) {
        assert.doesNotThrow(() => translatePiEvent(event), `${name} 的事件 ${JSON.stringify(event).slice(0, 80)}`);
      }
    }
  });

  it("未知/畸形事件返回空数组而不是抛出（容忍上游字段演进，ADR-0001）", () => {
    assert.deepEqual(translatePiEvent(null), []);
    assert.deepEqual(translatePiEvent(undefined), []);
    assert.deepEqual(translatePiEvent(42), []);
    assert.deepEqual(translatePiEvent({}), []);
    assert.deepEqual(translatePiEvent({ type: "message_update" }), []); // 缺 assistantMessageEvent
    assert.deepEqual(translatePiEvent({ type: "future_event_from_newer_pi" }), []);
    // 字段类型不符时不产出事件
    assert.deepEqual(translatePiEvent({ type: "tool_execution_start", toolCallId: 1, toolName: null }), []);
  });
});
