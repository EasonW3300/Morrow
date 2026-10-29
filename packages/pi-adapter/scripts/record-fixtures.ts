/**
 * fixtures 重录脚本（票 #4 / M0 code-review：fixtures 曾为手工构造却自称「录制」）。
 *
 * 对本地 OpenAI 兼容 mock 服务器跑**真实** Pi 1.4.0（@earendil-works/pi-agent-core/pi-ai），
 * 直接订阅 Pi Agent 的原始 AgentEvent 流并落盘为 fixtures/pi-1.4.0/*.json——
 * 与 createPiAdapter（src/pi-adapter.ts）的装配完全一致，只是监听点在翻译层**之前**。
 *
 * 覆盖三场景（与回放测试 events.replay.test.ts 对应）：
 *   normal-text-tool.json   正常文本 + 工具调用（get_weather）+ 收尾文本（两轮流）
 *   provider-error.json     供应商 HTTP 502
 *   aborted-stream.json     流式中断（第二个 text_delta 后 abort）
 *
 * 用法：node --experimental-strip-types scripts/record-fixtures.ts（在本包目录下运行；
 * 不出网——mock 服务器全在 127.0.0.1）。重录后回放测试的期望序列需与实际产出对齐
 * （脚本会把每个 fixture 的窄事件翻译结果打印出来，供测试断言核对）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures", "pi-1.4.0");
const PROVIDER_ID = "morrow";

// --- mock OpenAI 兼容 SSE 服务器（与 pi-adapter.live.test.ts 同款） --------------

const CHUNK_BASE = {
  id: "chatcmpl-record",
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

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => handler(req, res, raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// --- Agent 装配（与 src/pi-adapter.ts 的 createPiAdapter 完全一致） ---------------

function buildAgent(opts: { baseUrl: string; apiKey: string; tools?: AgentTool[] }): Agent {
  const model: Model<"openai-completions"> = {
    id: "test-chat-model",
    name: "test-chat-model",
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: opts.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
  };
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Morrow",
    baseUrl: opts.baseUrl,
    auth: { apiKey: { name: "Morrow API key", resolve: async () => ({ auth: { apiKey: opts.apiKey } }) } },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return new Agent({
    initialState: {
      systemPrompt: opts.tools ? "" : "你是 Morrow。",
      model,
      tools: opts.tools ?? [],
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
  });
}

function getWeatherTool(): AgentTool {
  return {
    name: "get_weather",
    description: "查城市天气",
    label: "get_weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    execute: async () => ({ content: [{ type: "text", text: "晴，12°C" }], details: {} }),
  };
}

async function saveFixture(name: string, description: string, events: AgentEvent[]): Promise<void> {
  writeFileSync(
    join(fixturesDir, name),
    `${JSON.stringify({ description, events }, null, 2)}\n`,
  );
  console.log(`recorded ${name}: ${events.length} raw events`);
}

// 三个场景共用：创建 agent → 订阅原始事件 → prompt（onEvent 里可决定 abort 时机）
async function runScenario(
  serverUrl: string,
  opts: { tools?: boolean },
  onEvent?: (event: AgentEvent, agent: Agent) => void,
): Promise<AgentEvent[]> {
  const agent = buildAgent({
    baseUrl: serverUrl,
    apiKey: "test-key",
    tools: opts.tools ? [getWeatherTool()] : undefined,
  });
  const raw: AgentEvent[] = [];
  agent.subscribe((event: AgentEvent) => {
    raw.push(event);
    onEvent?.(event, agent);
  });
  await agent.prompt("北京今天天气怎么样？");
  return raw;
}

async function main(): Promise<void> {
  mkdirSync(fixturesDir, { recursive: true });

  // 1. 正常文本 + 工具 + 收尾文本（两轮流）
  {
    const server = await startServer((req, res, body) => {
      const messages = body.messages as Array<Record<string, unknown>>;
      const sawToolResult = messages.some((m) => m.role === "tool");
      sse(res);
      if (!sawToolResult) {
        chunk(res, { role: "assistant", content: "北京今天" }, null);
        chunk(res, { content: "晴。" }, null);
        chunk(res, { content: null, tool_calls: [{ index: 0, id: "call_rec_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, null);
        chunk(res, { tool_calls: [{ index: 0, function: { arguments: "{\"city\":\"北京\"}" } }] }, null);
        chunk(res, {}, "tool_calls");
      } else {
        chunk(res, { role: "assistant", content: "北京晴，12°C。" }, null);
        chunk(res, {}, "stop");
      }
      done(res);
    });
    try {
      const raw = await runScenario(server.url, { tools: true });
      await saveFixture(
        "normal-text-tool.json",
        "Pi 1.4.0 真实录制（scripts/record-fixtures.ts × 本地 OpenAI 兼容 mock）：两轮流式文本 + 一次工具调用（get_weather）+ 最终文本。事件为 @earendil-works/pi-agent-core 1.4.0 的原始 AgentEvent。",
        raw,
      );
    } finally {
      await server.close();
    }
  }

  // 2. 供应商错误（HTTP 502）
  {
    const server = await startServer((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream connect error", type: "bad_gateway" } }));
    });
    try {
      const raw = await runScenario(server.url, {});
      await saveFixture(
        "provider-error.json",
        "Pi 1.4.0 真实录制（scripts/record-fixtures.ts × 本地 OpenAI 兼容 mock）：供应商 HTTP 502，运行以 stopReason=error 收尾。事件为原始 AgentEvent。",
        raw,
      );
    } finally {
      await server.close();
    }
  }

  // 3. 流式中断（第二个 text_delta 后 abort）
  {
    const server = await startServer((_req, res) => {
      sse(res);
      chunk(res, { role: "assistant", content: "我正在" }, null);
      chunk(res, { content: "整理你的偏好" }, null);
      // 之后挂住连接等客户端 abort
      res.on("close", () => res.destroy());
      res.on("error", () => {});
    });
    try {
      let deltas = 0;
      const raw = await runScenario(server.url, {}, (event, agent) => {
        const ev = event as { type: string; assistantMessageEvent?: { type?: string } };
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
          deltas += 1;
          if (deltas >= 2) agent.abort();
        }
      });
      await saveFixture(
        "aborted-stream.json",
        "Pi 1.4.0 真实录制（scripts/record-fixtures.ts × 本地 OpenAI 兼容 mock）：流式中断——两个 text_delta 后 abort()，agent_end(stopReason=aborted) 收尾，不发 error。事件为原始 AgentEvent。",
        raw,
      );
    } finally {
      await server.close();
    }
  }
}

main().catch((err) => {
  console.error("recording failed:", err);
  process.exit(1);
});
