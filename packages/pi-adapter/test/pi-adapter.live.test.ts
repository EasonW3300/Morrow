/**
 * PiAdapter 真实接线测试：pi-agent-core / pi-ai 1.4.0 ↔ 本地 OpenAI 兼容 SSE 服务器。
 *
 * 不访问外网：伪服务器实现 /v1/chat/completions 的流式协议，
 * 验证 create→prompt→窄事件→abort 的真实端到端行为。
 *
 * 引擎事实：Pi 1.4.0 声明 node >=22.19.0，本机为 22.12.0。
 * 若包导入因运行时差异失败，本套件整体 skip 并记录原因（不伪造通过）。
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { after, before, describe, it } from "node:test";

// --- 引擎/导入守卫 ----------------------------------------------------------

const [major, minor] = process.versions.node.split(".").map(Number);
const meetsEngine = major > 22 || (major === 22 && minor >= 19);

type PiAdapterModule = typeof import("../src/pi-adapter.ts");
let mod: PiAdapterModule | undefined;
let importError: string | undefined;
try {
  mod = await import("../src/pi-adapter.ts");
} catch (err) {
  importError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const skipReason = importError
  ? `真实 Pi 包（@earendil-works/* 1.4.0）在本机 Node ${process.versions.node}` +
    `（Pi 声明 >=22.19.0）导入失败：${importError}`
  : undefined;

// --- 伪 OpenAI 兼容 SSE 服务器 ----------------------------------------------

interface CapturedRequest {
  auth?: string;
  body: Record<string, unknown>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;

const CHUNK_BASE = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 1769692800,
  model: "test-chat-model",
};

function sse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function chunk(res: ServerResponse, delta: Record<string, unknown>, finishReason: string | null): void {
  res.write(`data: ${JSON.stringify({ ...CHUNK_BASE, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function done(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

async function startServer(handler: Handler): Promise<{
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ auth: req.headers.authorization, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "object" === false) throw new Error("no port");
  const port = typeof addr === "object" ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --- 套件 -------------------------------------------------------------------

describe(
  "PiAdapter 真实接线（1.4.0 × 本地 OpenAI 兼容服务器）",
  { skip: skipReason },
  () => {
    const { createPiAdapter } = mod!;
    const cleanups: Array<() => Promise<void>> = [];
    after(async () => {
      for (const fn of cleanups.reverse()) await fn();
    });

    it("正常文本流：文本 delta 按序产出，请求携带 key/model/system/user", { timeout: 30000 }, async () => {
      const server = await startServer((req, res) => {
        sse(res);
        chunk(res, { role: "assistant", content: "你好" }, null);
        chunk(res, { content: "！" }, null);
        chunk(res, {}, "stop");
        done(res);
      });
      cleanups.push(server.close);

      const rt = await createPiAdapter({
        baseUrl: server.url,
        apiKey: "test-key",
        model: { id: "test-chat-model", contextWindow: 8192, maxTokens: 1024 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
        systemPrompt: "你是 Morrow。",
      });
      const events: Array<{ type: string }> = [];
      rt.subscribe((e) => events.push(e));

      await rt.prompt("早上好");

      assert.deepEqual(events, [
        { type: "text_delta", delta: "你好" },
        { type: "text_delta", delta: "！" },
        { type: "agent_end", stopReason: "stop" },
      ]);

      assert.equal(server.requests.length, 1);
      const { auth, body } = server.requests[0];
      assert.equal(auth, "Bearer test-key");
      assert.equal(body.model, "test-chat-model");
      assert.equal(body.stream, true);
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      assert.equal(messages[0].role, "system");
      assert.equal(messages[0].content, "你是 Morrow。");
      assert.equal(messages[1].role, "user");
      // pi-ai 将用户文本规范化为 TextContent 数组
      assert.deepEqual(messages[1].content, [{ type: "text", text: "早上好" }]);

      rt.dispose();
    });

    it("工具调用：两轮流，tool_start/tool_end 翻译正确，工具结果回传供应商", { timeout: 30000 }, async () => {
      const addTool = {
        name: "add",
        description: "加法",
        parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
        execute: async (_id: string, args: unknown) => {
          const { a, b } = args as { a: number; b: number };
          return { text: String(a + b) };
        },
      };
      const server = await startServer((req, res, body) => {
        const messages = body.messages as Array<Record<string, unknown>>;
        const sawToolResult = messages.some((m) => m.role === "tool");
        sse(res);
        if (!sawToolResult) {
          chunk(res, { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_live_1", type: "function", function: { name: "add", arguments: "" } }] }, null);
          chunk(res, { tool_calls: [{ index: 0, function: { arguments: "{\"a\":1,\"b\":2}" } }] }, null);
          chunk(res, {}, "tool_calls");
        } else {
          chunk(res, { role: "assistant", content: "1+2=3。" }, null);
          chunk(res, {}, "stop");
        }
        done(res);
      });
      cleanups.push(server.close);

      const rt = await createPiAdapter({
        baseUrl: server.url,
        apiKey: "test-key",
        model: { id: "test-chat-model", contextWindow: 8192, maxTokens: 1024 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
        tools: [addTool],
      });
      const events: Array<Record<string, unknown>> = [];
      rt.subscribe((e) => events.push(e as Record<string, unknown>));

      await rt.prompt("帮我算 1+2");

      // durationMs 为真实测量值，单独断言类型
      assert.deepEqual(events.slice(0, 1), [
        { type: "tool_start", toolCallId: "call_live_1", toolName: "add", args: { a: 1, b: 2 } },
      ]);
      const toolEnd = events[1] as Record<string, unknown>;
      assert.equal(toolEnd.type, "tool_end");
      assert.equal(toolEnd.toolCallId, "call_live_1");
      assert.equal(toolEnd.toolName, "add");
      assert.equal(toolEnd.text, "3");
      assert.equal(toolEnd.isError, false);
      assert.equal(typeof toolEnd.durationMs, "number");
      assert.deepEqual(events.slice(2), [
        { type: "text_delta", delta: "1+2=3。" },
        { type: "agent_end", stopReason: "stop" },
      ]);

      assert.equal(server.requests.length, 2);
      const second = server.requests[1].body.messages as Array<Record<string, unknown>>;
      const toolMsg = second.find((m) => m.role === "tool");
      assert.ok(toolMsg, "第二轮请求应包含 role=tool 的工具结果");
      assert.equal(toolMsg.tool_call_id, "call_live_1");
      assert.equal(toolMsg.content, "3");

      rt.dispose();
    });

    it("供应商错误：映射为 error 事件 + agent_end(error)，prompt 正常 resolve", { timeout: 30000 }, async () => {
      const server = await startServer((req, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key", type: "invalid_request_error" } }));
      });
      cleanups.push(server.close);

      const rt = await createPiAdapter({
        baseUrl: server.url,
        apiKey: "wrong-key",
        model: { id: "test-chat-model", contextWindow: 8192, maxTokens: 1024 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
      });
      const events: Array<Record<string, unknown>> = [];
      rt.subscribe((e) => events.push(e as Record<string, unknown>));

      await rt.prompt("x"); // 不得 reject

      const errorEvent = events.find((e) => e.type === "error");
      assert.ok(errorEvent, "应产出 error 事件");
      assert.match(String(errorEvent.message), /Invalid API key|401/i);
      assert.deepEqual(events.at(-1), { type: "agent_end", stopReason: "error" });

      rt.dispose();
    });

    it("流式中断：abort 后已产出事件保留，agent_end(aborted) 收尾", { timeout: 30000 }, async () => {
      const server = await startServer((req, res) => {
        sse(res);
        chunk(res, { role: "assistant", content: "第一段" }, null);
        // 之后挂住连接，等待客户端 abort
        res.on("close", () => res.destroy());
        res.on("error", () => {});
      });
      cleanups.push(server.close);

      const rt = await createPiAdapter({
        baseUrl: server.url,
        apiKey: "test-key",
        model: { id: "test-chat-model", contextWindow: 8192, maxTokens: 1024 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
      });
      const events: Array<Record<string, unknown>> = [];
      rt.subscribe((e) => {
        events.push(e as Record<string, unknown>);
        if (e.type === "text_delta") rt.abort();
      });

      await rt.prompt("讲个长故事"); // 不得 reject

      assert.equal((events[0] as { type: string }).type, "text_delta");
      assert.deepEqual(events.at(-1), { type: "agent_end", stopReason: "aborted" });
      assert.ok(!events.some((e) => e.type === "error"), "中断不应产生 error 事件");

      rt.dispose();
    });
  },
);
