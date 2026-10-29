// 连通性测试 seam（票 T5 / Issue #6）：对指定 Provider 发一次最小 OpenAI 兼容请求，
// 区分三类结果——成功 / 认证失败（401/403）/ 网络不可达（含超时）。
// mock 服务器思路与 packages/pi-adapter 的 pi-adapter.live.test.ts 一致（本地 http，不出网）。
import assert from "node:assert/strict";
import http from "node:http";
import type { ServerResponse } from "node:http";
import { after, describe, it } from "node:test";
import { testProviderConnectivity, type ConnectivityResult } from "../src/connectivity.ts";

const SECRET = "sk-t5-connectivity-secret";

interface Captured {
  auth?: string | undefined;
  path: string;
  body: Record<string, unknown>;
}

type Handler = (req: http.IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;

async function startServer(handler: Handler): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ auth: req.headers.authorization, path: req.url ?? "", body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of closers.reverse()) await fn();
});

function probe(baseUrl: string, opts: { timeoutMs?: number } = {}): Promise<ConnectivityResult> {
  return testProviderConnectivity({ baseUrl, apiKey: SECRET, modelId: "test-chat-model" }, opts);
}

describe("testProviderConnectivity：三类结果", () => {
  it("200 → ok；请求形态：POST {base}/chat/completions + Bearer key + 最小 body", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "pong" } }] }));
    });
    closers.push(server.close);

    const result = await probe(server.url);
    assert.equal(result.result, "ok");
    if (result.result === "ok") {
      assert.equal(result.http_status, 200);
      assert.ok(Number.isFinite(result.latency_ms) && result.latency_ms >= 0);
    }
    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.path, "/v1/chat/completions");
    assert.equal(req.auth, `Bearer ${SECRET}`);
    assert.equal(req.body.model, "test-chat-model");
    assert.equal(req.body.stream, false);
    assert.equal(req.body.max_tokens, 1);
    assert.ok(Array.isArray(req.body.messages));
  });

  it("401 → auth_failed（带 http_status，不含密钥）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
    });
    closers.push(server.close);

    const result = await probe(server.url);
    assert.deepEqual(result, { result: "auth_failed", http_status: 401, latency_ms: result.result === "auth_failed" ? result.latency_ms : -1 });
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  });

  it("403 → auth_failed", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end("{}");
    });
    closers.push(server.close);

    const result = await probe(server.url);
    assert.equal(result.result, "auth_failed");
    if (result.result === "auth_failed") assert.equal(result.http_status, 403);
  });

  it("连接拒绝 → unreachable（detail 无密钥）", async () => {
    // 起一个服务器再关掉，拿到一个确定无人监听的端口
    const server = await startServer(() => {});
    const deadUrl = server.url;
    await server.close();

    const result = await probe(deadUrl);
    assert.equal(result.result, "unreachable");
    if (result.result === "unreachable") {
      assert.ok(result.detail.length > 0);
      assert.ok(result.detail.includes("ECONNREFUSED") || result.detail.includes("fetch failed"));
    }
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  });

  it("超时 → unreachable（detail 注明 timed out）", async () => {
    const server = await startServer((_req, res) => {
      // 挂住不响应，等客户端超时断开
      res.on("close", () => res.destroy());
      res.on("error", () => {});
    });
    closers.push(server.close);

    const result = await probe(server.url, { timeoutMs: 150 });
    assert.equal(result.result, "unreachable");
    if (result.result === "unreachable") {
      assert.match(result.detail, /timed out|abort/i);
    }
  });

  it("其他 HTTP 状态（500/404）→ error 类，带 http_status（AC 三类仍两两可区分）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
    closers.push(server.close);

    const result = await probe(server.url);
    assert.equal(result.result, "error");
    if (result.result === "error") {
      assert.equal(result.http_status, 500);
      assert.equal(JSON.stringify(result).includes(SECRET), false);
    }
  });

  it("base_url 尾斜杠归一（不产生 //chat/completions）", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    closers.push(server.close);

    const result = await probe(`${server.url}/`);
    assert.equal(result.result, "ok");
    assert.equal(server.requests[0].path, "/v1/chat/completions");
  });
});
