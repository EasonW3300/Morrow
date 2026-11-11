// Provider HTTP API seam 测试（票 T5 / Issue #6）：
// GET/POST /v1/providers、GET/PUT/DELETE /v1/providers/:id、POST :id/default、POST :id/test。
// 核心不变量：密钥只写凭据库（测试注入内存桩），任何响应与账本事件都不含密钥。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { ServerResponse } from "node:http";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { createInMemorySecretStore, type SecretStore } from "../src/keyring.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SECRET = "sk-t5-api-secret-value";

interface ProviderRecord {
  provider_id: string;
  name: string;
  base_url: string;
  model: string;
  has_api_key: boolean;
  is_default: boolean;
}

interface ProviderList {
  providers: ProviderRecord[];
  default_provider_id: string | null;
}

interface ApiError {
  error: { code: string; message: string };
}

function testConfig(dir: string, provider: RuntimeConfig["provider"] = null): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider };
}

async function start(opts: { provider?: RuntimeConfig["provider"] } = {}): Promise<{ runtime: Awaited<ReturnType<typeof startRuntime>>; dir: string; store: SecretStore }> {
  const dir = tmpDir("morrow-provapi-");
  const store = createInMemorySecretStore();
  const runtime = await startRuntime(testConfig(dir, opts.provider ?? null), { secretStore: store });
  return { runtime, dir, store };
}

function registerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_id: "deepseek",
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    api_key: SECRET,
    ...overrides,
  };
}

async function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function register(port: number, body: Record<string, unknown>): Promise<ProviderRecord> {
  const res = await post(port, "/v1/providers", body);
  assert.equal(res.status, 201);
  return json<ProviderRecord>(res);
}

test("POST /v1/providers → 201 元数据投影（无密钥字段，has_api_key=true），密钥入凭据库", async () => {
  const { runtime, dir, store } = await start();
  try {
    const record = await register(runtime.port, registerBody());
    assert.equal(record.provider_id, "deepseek");
    assert.equal(record.has_api_key, true);
    assert.equal(record.is_default, true);
    assert.equal("api_key" in record, false);
    // 凭据库侧（内存桩）确有密钥；元数据文件不含
    assert.equal(await store.getSecret("com.morrow.runtime", "deepseek"), SECRET);
    const raw = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers`).then((r) => r.text());
    assert.ok(!raw.includes(SECRET), "列表响应不得含密钥");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("重复 provider_id → 409 provider_conflict；非法入参 → 400 provider_invalid_input", async () => {
  const { runtime, dir } = await start();
  try {
    await register(runtime.port, registerBody());
    const dup = await post(runtime.port, "/v1/providers", registerBody());
    assert.equal(dup.status, 409);
    assert.equal((await json<ApiError>(dup)).error.code, "provider_conflict");

    const bad = await post(runtime.port, "/v1/providers", { name: "X", base_url: "nope", model: "m" });
    assert.equal(bad.status, 400);
    const badBody = await json<ApiError>(bad);
    assert.equal(badBody.error.code, "provider_invalid_input");
    assert.match(badBody.error.message, /base_url/);

    const reserved = await post(runtime.port, "/v1/providers", registerBody({ provider_id: "env" }));
    assert.equal(reserved.status, 400);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("GET/PUT/DELETE /v1/providers/:id 全链路；未知 id 404 provider_not_found", async () => {
  const { runtime, dir } = await start();
  try {
    await register(runtime.port, registerBody({ provider_id: "a" }));
    await register(runtime.port, registerBody({ provider_id: "b", api_key: "sk-b-key" }));

    // detail
    const got = await json<ProviderRecord>(await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/a`));
    assert.equal(got.model, "deepseek-chat");
    assert.equal(got.has_api_key, true);

    // update：改名 + 轮换 key
    const put = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/a`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "DeepSeek v2", api_key: "sk-rotated" }),
    });
    assert.equal(put.status, 200);
    const updated = await json<ProviderRecord>(put);
    assert.equal(updated.name, "DeepSeek v2");
    const got2 = await json<ProviderRecord>(await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/a`));
    assert.equal(got2.name, "DeepSeek v2");

    // delete：默认 a 被删后默认指针落到 b
    const del = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/a`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const after = await json<ProviderList>(await fetch(`http://127.0.0.1:${runtime.port}/v1/providers`));
    assert.equal(after.default_provider_id, "b");
    const gone = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/a`);
    assert.equal(gone.status, 404);
    assert.equal((await json<ApiError>(gone)).error.code, "provider_not_found");

    // delete 未知 → 404
    const delGhost = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/ghost`, { method: "DELETE" });
    assert.equal(delGhost.status, 404);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("POST /v1/providers/:id/default 切换默认", async () => {
  const { runtime, dir } = await start();
  try {
    await register(runtime.port, registerBody({ provider_id: "a" }));
    await register(runtime.port, registerBody({ provider_id: "b" }));
    const res = await post(runtime.port, "/v1/providers/b/default");
    assert.equal(res.status, 200);
    const body = await json<{ default_provider_id: string }>(res);
    assert.equal(body.default_provider_id, "b");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("env 回退出现在列表：source 标注、无 CRUD 时是默认；PUT/DELETE env → 404", async () => {
  const { runtime, dir } = await start({
    provider: { baseUrl: "https://api.env.com/v1", apiKey: "env-key", modelId: "env-model", contextWindow: 131072, maxTokens: 8192 },
  });
  try {
    const list = await json<ProviderList>(await fetch(`http://127.0.0.1:${runtime.port}/v1/providers`));
    assert.equal(list.providers.length, 1);
    assert.equal(list.providers[0].provider_id, "env");
    assert.equal(list.providers[0].is_default, true);
    assert.equal(list.default_provider_id, "env");

    const put = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/env`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });
    assert.equal(put.status, 404, "env 回退不可经 CRUD 修改");
    const del = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/env`, { method: "DELETE" });
    assert.equal(del.status, 404);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- /test 连通性端点：三类结果（本地 mock 服务器，不出网） -------------------

interface Captured {
  auth?: string | undefined;
  body: Record<string, unknown>;
}

async function startMockOpenAI(handler: (req: http.IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = [];
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
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface TestResult {
  result: "ok" | "auth_failed" | "unreachable" | "error";
  http_status?: number;
  latency_ms?: number;
  detail?: string;
}

test("POST /v1/providers/:id/test：ok / auth_failed / unreachable 三类可区分，密钥不出现在响应", async () => {
  const { runtime, dir } = await start();
  const closers: Array<() => Promise<void>> = [];
  try {
    // ok
    const okServer = await startMockOpenAI((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "pong" } }] }));
    });
    closers.push(okServer.close);
    await register(runtime.port, registerBody({ provider_id: "good", base_url: okServer.url }));
    const okRes = (await (await post(runtime.port, "/v1/providers/good/test")).json()) as TestResult;
    assert.equal(okRes.result, "ok");
    assert.equal(okServer.requests[0].auth, `Bearer ${SECRET}`);
    assert.equal(okServer.requests[0].body.model, "deepseek-chat");

    // auth_failed
    const authServer = await startMockOpenAI((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    });
    closers.push(authServer.close);
    await register(runtime.port, registerBody({ provider_id: "bad-key", base_url: authServer.url }));
    const authRes = (await (await post(runtime.port, "/v1/providers/bad-key/test")).json()) as TestResult;
    assert.equal(authRes.result, "auth_failed");
    assert.equal(authRes.http_status, 401);

    // unreachable（连接拒绝）
    const deadServer = await startMockOpenAI(() => {});
    const deadUrl = deadServer.url;
    await deadServer.close();
    await register(runtime.port, registerBody({ provider_id: "dead", base_url: deadUrl }));
    const deadRes = (await (await post(runtime.port, "/v1/providers/dead/test")).json()) as TestResult;
    assert.equal(deadRes.result, "unreachable");
    assert.ok((deadRes.detail ?? "").length > 0);

    // 三个结果两两可区分
    const results = new Set([okRes.result, authRes.result, deadRes.result]);
    assert.equal(results.size, 3);

    // 未知 provider → 404
    const ghost = await post(runtime.port, "/v1/providers/ghost/test");
    assert.equal(ghost.status, 404);

    // 密钥不出现在任何测试响应
    for (const r of [okRes, authRes, deadRes]) {
      assert.equal(JSON.stringify(r).includes(SECRET), false);
    }
  } finally {
    for (const fn of closers) await fn();
    await runtime.close();
    removeDir(dir);
  }
});

test("密钥全链路不泄漏：/v1/events 账本、/v1/sessions 投影、错误响应均无密钥", async () => {
  const { runtime, dir } = await start();
  try {
    await register(runtime.port, registerBody());
    // 重复注册（409 错误路径）
    await post(runtime.port, "/v1/providers", registerBody());
    // 更新（含 key 轮换）
    await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/deepseek`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "sk-rotated-2" }),
    });

    const endpoints = [
      `/v1/providers`,
      `/v1/providers/deepseek`,
      `/v1/events?limit=200`,
      `/v1/sessions`,
      `/v1/health`,
    ];
    for (const ep of endpoints) {
      const text = await fetch(`http://127.0.0.1:${runtime.port}${ep}`).then((r) => r.text());
      assert.equal(text.includes(SECRET), false, `${ep} 响应不得含密钥`);
      assert.equal(text.includes("sk-rotated-2"), false, `${ep} 响应不得含轮换后的密钥`);
    }
    // 账本里确实有会话族事件（确保上面的断言不是打在空账本上）
    const events = await json<{ events: EventEnvelope[] }>(await fetch(`http://127.0.0.1:${runtime.port}/v1/events?limit=200`));
    assert.ok(events.events.length > 0);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("PATCH /v1/providers → 405（路径命中方法不符）", async () => {
  const { runtime, dir } = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers`, { method: "PATCH" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, POST");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
