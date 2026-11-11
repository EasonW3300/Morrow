/**
 * 本地 OpenAI 兼容 mock 服务器（对话探针的供应商端）。
 *
 * 实现改编自 packages/pi-adapter/test/pi-adapter.live.test.ts 的伪 SSE 服务器
 * （/v1/chat/completions 流式协议），按任务要求复用为 T8 打包探针——让编译产物内的
 * 真实 Pi 依赖树对"供应商"发起完整对话。协议形状与该测试保持一致：
 * chunk 帧 = { id, object: "chat.completion.chunk", created, model, choices: [{ index, delta, finish_reason }] }，
 * 终帧 data: [DONE]。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";

export interface MockOpenAIRequest {
  auth?: string;
  body: Record<string, unknown>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;

const CHUNK_BASE = {
  id: "chatcmpl-morrow-probe",
  object: "chat.completion.chunk",
  created: 1769692800,
  model: "probe-chat-model",
};

function sse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function chunk(res: ServerResponse, delta: Record<string, unknown>, finishReason: string | null): void {
  res.write(
    `data: ${JSON.stringify({ ...CHUNK_BASE, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
  );
}

function done(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

/** 探针默认对话：两段文本 delta + stop（对应断言 text_delta × 2 → agent_end(stop)） */
function defaultHandler(_req: IncomingMessage, res: ServerResponse): void {
  sse(res);
  chunk(res, { role: "assistant", content: "探针" }, null);
  chunk(res, { content: "正常" }, null);
  chunk(res, {}, "stop");
  done(res);
}

export interface MockOpenAIServer {
  /** OpenAI 兼容 base url（以 /v1 结尾，直接喂 AdapterConfig.baseUrl） */
  url: string;
  port: number;
  /** 收到的请求（auth = Authorization 头，body = 解析后的 JSON 请求体），按序追加 */
  requests: MockOpenAIRequest[];
  close(): Promise<void>;
}

export async function startMockOpenAI(handler: Handler = defaultHandler): Promise<MockOpenAIServer> {
  const requests: MockOpenAIRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => (raw += d.toString("utf8")));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ auth: req.headers.authorization, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr !== "object") throw new Error("mock server: no address");
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    port: addr.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
