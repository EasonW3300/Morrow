/**
 * FakePi 契约套件 —— 无网络、不 import 任何 @earendil-works/* 包。
 *
 * FakePi 与 PiAdapter 实现同一 AgentRuntime 接口（ADR-0001 冻结面）；
 * 本套件锁定其可脚本化行为，供本包与后续业务包测试引用。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFakePi, type MorrowAgentEvent } from "../src/index.ts";

/** 收集事件的监听器句柄 */
function collector() {
  const events: MorrowAgentEvent[] = [];
  return {
    events,
    listen(rt: Awaited<ReturnType<typeof createFakePi>>) {
      return rt.subscribe((e) => events.push(e));
    },
  };
}

describe("FakePi 契约：正常对话流", () => {
  it("文本脚本按序产出 text_delta，并以 agent_end(stop) 收尾", async () => {
    const rt = await createFakePi({
      script: [{ kind: "text", deltas: ["你", "好", "！"] }],
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("早上好");
    await rt.waitForIdle();

    assert.deepEqual(c.events, [
      { type: "text_delta", delta: "你" },
      { type: "text_delta", delta: "好" },
      { type: "text_delta", delta: "！" },
      { type: "agent_end", stopReason: "stop" },
    ]);

    rt.dispose();
  });

  it("多步脚本（文本 + 文本）按声明顺序发射", async () => {
    const rt = await createFakePi({
      script: [
        { kind: "text", deltas: ["第一段"] },
        { kind: "text", deltas: ["第二段"] },
      ],
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("继续");

    assert.deepEqual(
      c.events.map((e) => (e.type === "text_delta" ? e.delta : e.type)),
      ["第一段", "第二段", "agent_end"],
    );

    rt.dispose();
  });

  it("subscribe 返回退订函数，退订后不再收到事件", async () => {
    const rt = await createFakePi({
      script: [{ kind: "text", deltas: ["a", "b"] }],
    });
    const seen: string[] = [];
    const unsubscribe = rt.subscribe((e) => {
      if (e.type === "text_delta") seen.push(e.delta);
    });

    // 先退订再运行：不应收到任何事件
    unsubscribe();
    await rt.prompt("x");

    assert.deepEqual(seen, []);

    rt.dispose();
  });

  it("多个监听器按注册顺序收到同一事件序列", async () => {
    const rt = await createFakePi({
      script: [{ kind: "text", deltas: ["x"] }],
    });
    const order: string[] = [];
    rt.subscribe(() => order.push("first"));
    rt.subscribe(() => order.push("second"));

    await rt.prompt("y");

    // 2 条事件（text_delta + agent_end）× 2 个监听器，按注册顺序交替
    assert.deepEqual(order, ["first", "second", "first", "second"]);

    rt.dispose();
  });
});

describe("FakePi 契约：工具调用", () => {
  const echoTool = {
    name: "echo",
    description: "回声",
    parameters: { type: "object" },
    execute: async (_id: string, args: unknown) => ({
      text: `echo:${JSON.stringify(args)}`,
    }),
  };

  it("工具成功：tool_start(args) → tool_end(isError=false)", async () => {
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "echo", args: { q: "hi" } }],
      tools: [echoTool],
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("查一下");

    assert.deepEqual(c.events, [
      { type: "tool_start", toolCallId: "call-0", toolName: "echo", args: { q: "hi" } },
      { type: "tool_end", toolCallId: "call-0", toolName: "echo", text: 'echo:{"q":"hi"}', isError: false },
      { type: "agent_end", stopReason: "stop" },
    ]);

    rt.dispose();
  });

  it("工具失败（显式 error）：tool_end(isError=true, text=错误消息)", async () => {
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "echo", error: "权限不足" }],
      tools: [echoTool],
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("危险操作");

    const end = c.events.find((e) => e.type === "tool_end");
    assert.deepEqual(end, {
      type: "tool_end",
      toolCallId: "call-0",
      toolName: "echo",
      text: "权限不足",
      isError: true,
    });
    // 工具失败不终止运行，仍正常收尾
    assert.deepEqual(c.events.at(-1), { type: "agent_end", stopReason: "stop" });

    rt.dispose();
  });

  it("工具抛异常等价失败", async () => {
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "echo" }],
      tools: [
        {
          ...echoTool,
          execute: async () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("x");

    const end = c.events.find((e) => e.type === "tool_end");
    assert.equal((end as Extract<typeof end, { type: "tool_end" }>).isError, true);
    assert.equal((end as Extract<typeof end, { type: "tool_end" }>).text, "boom");

    rt.dispose();
  });

  it("未知工具：tool_end(isError=true, text=Unknown tool: ...)", async () => {
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "nope" }],
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("x");

    assert.deepEqual(c.events[1], {
      type: "tool_end",
      toolCallId: "call-0",
      toolName: "nope",
      text: "Unknown tool: nope",
      isError: true,
    });

    rt.dispose();
  });

  it("混合脚本：文本 → 工具 → 文本，按序发射", async () => {
    const rt = await createFakePi({
      script: [
        { kind: "text", deltas: ["先看", "一下"] },
        { kind: "tool", toolName: "echo", args: { a: 1 } },
        { kind: "text", deltas: ["结果是…"] },
      ],
      tools: [echoTool],
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("流程");

    assert.deepEqual(
      c.events.map((e) => e.type),
      ["text_delta", "text_delta", "tool_start", "tool_end", "text_delta", "agent_end"],
    );

    rt.dispose();
  });
});

describe("FakePi 契约：错误与中断", () => {
  it("error 步骤：error 事件 + agent_end(stopReason=error)", async () => {
    const rt = await createFakePi({
      script: [
        { kind: "text", deltas: ["部分输"] },
        { kind: "error", message: "HTTP 502: upstream unavailable" },
      ],
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("x");

    assert.deepEqual(c.events, [
      { type: "text_delta", delta: "部分输" },
      { type: "error", message: "HTTP 502: upstream unavailable" },
      { type: "agent_end", stopReason: "error" },
    ]);

    rt.dispose();
  });

  it("流式中断：已产出事件不丢失，agent_end(aborted) 收尾，waitForIdle 可等待", async () => {
    const rt = await createFakePi({
      script: [
        { kind: "text", deltas: ["你", "好"] },
        { kind: "hang" },
        { kind: "text", deltas: ["不应", "到达"] },
      ],
    });
    const c = collector();
    c.listen(rt);

    const idle = rt.waitForIdle();
    const running = rt.prompt("讲个长故事");
    // 等前两个 delta 落地后再中止
    await new Promise((r) => setTimeout(r, 10));
    rt.abort();
    await running;
    await idle;

    assert.deepEqual(c.events, [
      { type: "text_delta", delta: "你" },
      { type: "text_delta", delta: "好" },
      { type: "agent_end", stopReason: "aborted" },
    ]);

    rt.dispose();
  });

  it("abort 后中止信号传入工具 execute，执行中工具以 aborted 收场", async () => {
    let observedSignal: AbortSignal | undefined;
    const slowTool = {
      name: "slow",
      description: "慢工具",
      parameters: { type: "object" },
      execute: async (_id: string, _args: unknown, signal?: AbortSignal) => {
        observedSignal = signal;
        await new Promise((resolve) => {
          if (signal?.aborted) resolve(undefined);
          else signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        return { text: "不该到达" };
      },
    };
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "slow" }],
      tools: [slowTool],
    });
    const c = collector();
    c.listen(rt);

    const running = rt.prompt("x");
    await new Promise((r) => setTimeout(r, 10));
    rt.abort();
    await running;

    assert.equal(observedSignal?.aborted, true);
    assert.deepEqual(c.events[1], {
      type: "tool_end",
      toolCallId: "call-0",
      toolName: "slow",
      text: "Operation aborted",
      isError: true,
    });
    assert.deepEqual(c.events.at(-1), { type: "agent_end", stopReason: "aborted" });

    rt.dispose();
  });

  it("空闲时 abort 是无害的", async () => {
    const rt = await createFakePi({ script: [{ kind: "text", deltas: ["a"] }] });
    rt.abort();
    await rt.prompt("x");
    rt.abort();
    rt.dispose();
  });

  it("运行中并发 prompt 被 reject", async () => {
    const rt = await createFakePi({
      script: [{ kind: "text", deltas: ["a"], }, { kind: "hang" }],
    });
    const running = rt.prompt("first");
    await assert.rejects(() => rt.prompt("second"), /already running/);
    rt.abort();
    await running;
    rt.dispose();
  });

  it("dispose 后 prompt reject；dispose 清空监听器", async () => {
    const rt = await createFakePi({ script: [{ kind: "text", deltas: ["a"] }] });
    const c = collector();
    c.listen(rt);
    rt.dispose();

    await assert.rejects(() => rt.prompt("x"), /disposed/);
    assert.equal(c.events.length, 0);
  });

  it("waitForIdle：空闲时立即 resolve；运行中等待到结束", async () => {
    const rt = await createFakePi({
      script: [{ kind: "text", deltas: ["a", "b"] }],
    });
    await rt.waitForIdle(); // 空闲
    const order: string[] = [];
    const idle = rt.waitForIdle().then(() => order.push("idle"));
    await rt.prompt("x");
    await idle;
    assert.deepEqual(order, ["idle"]);
    rt.dispose();
  });
});

describe("FakePi 契约：beforeToolCall 钩子（M0 只透传）", () => {
  const echoTool = {
    name: "echo",
    description: "回声",
    parameters: { type: "object" },
    execute: async (_id: string, args: unknown) => ({ text: `echo:${JSON.stringify(args)}` }),
  };

  it("透传调用请求（toolCallId/toolName/args），放行时工具正常执行", async () => {
    const seen: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "echo", args: { q: 1 } }],
      tools: [echoTool],
      beforeToolCall: (req) => {
        seen.push({ ...req });
      },
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("x");

    assert.deepEqual(seen, [{ toolCallId: "call-0", toolName: "echo", args: { q: 1 } }]);
    assert.equal((c.events[1] as { isError: boolean }).isError, false);

    rt.dispose();
  });

  it("block: true → 工具不执行，tool_end(isError=true, text=reason)", async () => {
    const executed: string[] = [];
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "echo", args: {} }],
      tools: [{ ...echoTool, execute: async () => { executed.push("ran"); return { text: "ran" }; } }],
      beforeToolCall: () => ({ block: true, reason: "渠道策略不允许" }),
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("x");

    assert.deepEqual(executed, []);
    assert.deepEqual(c.events[1], {
      type: "tool_end",
      toolCallId: "call-0",
      toolName: "echo",
      text: "渠道策略不允许",
      isError: true,
    });

    rt.dispose();
  });

  it("block 无 reason → 使用默认拦截文案（与 Pi 一致）", async () => {
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "echo", args: {} }],
      tools: [echoTool],
      beforeToolCall: () => ({ block: true }),
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("x");

    assert.equal((c.events[1] as { text: string }).text, "Tool execution was blocked");

    rt.dispose();
  });

  it("异步钩子（返回 Promise）被等待", async () => {
    const rt = await createFakePi({
      script: [{ kind: "tool", toolName: "echo", args: {} }],
      tools: [echoTool],
      beforeToolCall: async () => ({ block: true, reason: "异步裁决" }),
    });
    const c = collector();
    c.listen(rt);

    await rt.prompt("x");

    assert.equal((c.events[1] as { text: string }).text, "异步裁决");

    rt.dispose();
  });
});
