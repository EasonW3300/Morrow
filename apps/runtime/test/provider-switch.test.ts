// Provider 切换与失败隔离 seam 测试（票 T5 / Issue #6，AC-02 前置）：
// - 会话创建可选 provider_id；无则用默认 Provider（显式 CRUD > MORROW_PROVIDER_* env 回退）；
// - 新会话可切换 Provider（切换 = 新会话绑定另一 Provider；会话内 Provider 固定——
//   AgentRuntime 的对话历史由其内部 state 持有，换 Provider 即换会话，账本仍完整审计）；
// - 失败隔离：故意配错一个 Provider（工厂/凭据库解析失败），另一 Provider 上的
//   进行中会话不受影响（测试用注入工厂按 provider 分流 + FakePi，无外网）。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { ServerResponse } from "node:http";
import { createFakePi, type AgentRuntime } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import type { ResolvedProvider } from "../src/providers.ts";
import { createInMemorySecretStore, type SecretStore } from "../src/keyring.ts";
import { startRuntime, type RuntimeHandle, type RuntimeOptions } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SECRET = "sk-t5-switch-secret";

interface ProviderBody {
  provider_id: string;
  name: string;
  base_url: string;
  model: string;
  has_api_key: boolean;
  is_default: boolean;
}

interface SessionCreated {
  session_id: string;
  event_id: string;
  sequence: number;
  occurred_at: string;
  provider_id?: string;
}

interface HistoryBody {
  session_id: string;
  messages: Array<{ role: "user" | "assistant"; text: string; stop_reason?: string }>;
}

interface SendAck {
  status: "processing" | "queued";
}

function testConfig(dir: string, provider: RuntimeConfig["provider"] = null): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider };
}

/** 工厂观察点：每次运行时创建收到的 (sessionId, providerId) */
function routerFactory(handlers: Record<string, (provider: ResolvedProvider) => Promise<AgentRuntime> | AgentRuntime>) {
  const observed: Array<{ sessionId: string; providerId: string | null }> = [];
  const factory = async (sessionId: string, provider: ResolvedProvider | null): Promise<AgentRuntime> => {
    observed.push({ sessionId, providerId: provider?.providerId ?? null });
    if (provider === null) return createFakePi({ script: [{ kind: "text", deltas: ["no-provider"] }] });
    const handler = handlers[provider.providerId];
    if (!handler) throw new Error(`no scripted handler for provider ${provider.providerId}`);
    return handler(provider);
  };
  return { observed, factory };
}

async function registerProvider(port: number, body: Record<string, unknown>, expectStatus = 201): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, expectStatus, `register provider failed: ${JSON.stringify(await json(res))}`);
}

async function createSession(port: number, opts: { title?: string; providerId?: string } = {}): Promise<{ status: number; body: SessionCreated | { error: { code: string; message: string } } }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.providerId !== undefined ? { provider_id: opts.providerId } : {}),
    }),
  });
  return { status: res.status, body: (await json(res)) as SessionCreated | { error: { code: string; message: string } } };
}

async function send(port: number, sessionId: string, text: string): Promise<SendAck> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202, `send failed: ${res.status}`);
  return json<SendAck>(res);
}

async function history(port: number, sessionId: string): Promise<HistoryBody> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`);
  assert.equal(res.status, 200);
  return json<HistoryBody>(res);
}

async function ledgerEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  const body = (await json(res)) as { events: EventEnvelope[] };
  return body.events;
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

// --- 慢工具 gate：让一个会话停在"进行中" ------------------------------------

interface Gate {
  open(): void;
  promise: Promise<void>;
}

function makeGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open: release, promise };
}

async function startWith(opts: {
  factory?: (sessionId: string, provider: ResolvedProvider | null) => Promise<AgentRuntime>;
  secretStore?: SecretStore;
  envProvider?: RuntimeConfig["provider"];
  dir?: string;
}): Promise<{ runtime: RuntimeHandle; dir: string }> {
  const dir = opts.dir ?? tmpDir("morrow-switch-");
  const options: RuntimeOptions = {};
  if (opts.factory !== undefined) options.agentAdapterFactory = opts.factory;
  if (opts.secretStore !== undefined) options.secretStore = opts.secretStore;
  const runtime = await startRuntime(testConfig(dir, opts.envProvider ?? null), options);
  return { runtime, dir };
}

// --- 用例 -------------------------------------------------------------------

test("会话创建可选 provider_id：账本 payload 与列表投影记录绑定", async () => {
  const dir = tmpDir("morrow-switch-bind-");
  const store = createInMemorySecretStore();
  const { runtime } = await startWith({ factory: routerFactory({ a: () => createFakePi({ script: [{ kind: "text", deltas: ["a"] }] }) }).factory, secretStore: store });
  try {
    await registerProvider(runtime.port, {
      provider_id: "a",
      name: "Provider A",
      base_url: "https://a.example.com/v1",
      model: "model-a",
      api_key: SECRET,
    });
    const created = await createSession(runtime.port, { providerId: "a", title: "bound" });
    assert.equal(created.status, 201);
    const session = created.body as SessionCreated;
    assert.equal(session.provider_id, "a");

    // 列表投影
    const listRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`);
    const list = (await json<{ sessions: Array<{ session_id: string; provider_id?: string }> }>(listRes));
    assert.equal(list.sessions[0]?.provider_id, "a");

    // 账本 payload
    const events = await ledgerEvents(runtime.port);
    const created_ = events.find((e) => e.event_type === "session.created");
    assert.equal(created_?.payload.provider_id, "a");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("未知 provider_id → 400 unknown_provider，不建会话", async () => {
  const dir = tmpDir("morrow-switch-unknown-");
  const store = createInMemorySecretStore();
  const { runtime } = await startWith({ factory: routerFactory({}).factory, secretStore: store });
  try {
    const res = await createSession(runtime.port, { providerId: "ghost" });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, "unknown_provider");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("不带 provider_id 的会话用默认 Provider（首个注册）", async () => {
  const dir = tmpDir("morrow-switch-default-");
  const store = createInMemorySecretStore();
  const router = routerFactory({
    a: () => createFakePi({ script: [{ kind: "text", deltas: ["from-a"] }] }),
    b: () => createFakePi({ script: [{ kind: "text", deltas: ["from-b"] }] }),
  });
  const { runtime } = await startWith({ factory: router.factory, secretStore: store });
  try {
    await registerProvider(runtime.port, { provider_id: "a", name: "A", base_url: "https://a.example.com/v1", model: "ma" });
    await registerProvider(runtime.port, { provider_id: "b", name: "B", base_url: "https://b.example.com/v1", model: "mb" });
    const created = await createSession(runtime.port, {});
    const session = created.body as SessionCreated;
    await send(runtime.port, session.session_id, "hi");
    await waitFor("default-provider reply", async () => (await history(runtime.port, session.session_id)).messages.some((m) => m.role === "assistant"));
    assert.deepEqual(
      router.observed.filter((o) => o.sessionId === session.session_id),
      [{ sessionId: session.session_id, providerId: "a" }],
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("新会话切换 Provider：两个端点各自对话完整、互不污染", async () => {
  const dir = tmpDir("morrow-switch-two-");
  const store = createInMemorySecretStore();
  const router = routerFactory({
    deepseek: () => createFakePi({ script: [{ kind: "text", deltas: ["deepseek-答复"] }] }),
    openai: () => createFakePi({ script: [{ kind: "text", deltas: ["openai-答复"] }] }),
  });
  const { runtime } = await startWith({ factory: router.factory, secretStore: store });
  try {
    await registerProvider(runtime.port, { provider_id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat", api_key: SECRET });
    await registerProvider(runtime.port, { provider_id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-test", api_key: "sk-other-key" });

    const s1 = (await createSession(runtime.port, { providerId: "deepseek" })).body as SessionCreated;
    const s2 = (await createSession(runtime.port, { providerId: "openai" })).body as SessionCreated;
    assert.equal(s1.provider_id, "deepseek");
    assert.equal(s2.provider_id, "openai");

    await send(runtime.port, s1.session_id, "用 deepseek 回答");
    await send(runtime.port, s2.session_id, "用 openai 回答");
    await waitFor("both replies", async () => {
      const h1 = await history(runtime.port, s1.session_id);
      const h2 = await history(runtime.port, s2.session_id);
      return h1.messages.some((m) => m.role === "assistant") && h2.messages.some((m) => m.role === "assistant");
    });

    const h1 = await history(runtime.port, s1.session_id);
    const h2 = await history(runtime.port, s2.session_id);
    assert.deepEqual(h1.messages.map((m) => m.text), ["用 deepseek 回答", "deepseek-答复"]);
    assert.deepEqual(h2.messages.map((m) => m.text), ["用 openai 回答", "openai-答复"]);

    // 两个 provider 都被工厂用到（切换真实生效）
    assert.deepEqual(
      router.observed.map((o) => o.providerId).sort(),
      ["deepseek", "openai"],
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("失败隔离：配错的 Provider 报错，另一 Provider 上的进行中会话不受影响", async () => {
  const dir = tmpDir("morrow-switch-iso-");
  const store = createInMemorySecretStore();
  const gate = makeGate();
  const router = routerFactory({
    broken: () => {
      throw new Error("simulated misconfiguration (bad credentials file)");
    },
    good: () =>
      createFakePi({
        script: [
          { kind: "tool", toolName: "slow", result: "tool-done" },
          { kind: "text", deltas: ["good-答复"] },
        ],
        tools: [
          {
            name: "slow",
            description: "slow tool",
            parameters: { type: "object", properties: {} },
            execute: async () => {
              await gate.promise; // 停在工具执行中 = 会话"进行中"
              return { text: "tool-done" };
            },
          },
        ],
      }),
  });
  const { runtime } = await startWith({ factory: router.factory, secretStore: store });
  try {
    await registerProvider(runtime.port, { provider_id: "broken", name: "Broken", base_url: "https://broken.example.com/v1", model: "mb" });
    await registerProvider(runtime.port, { provider_id: "good", name: "Good", base_url: "https://good.example.com/v1", model: "mg" });

    // good 会话先进入进行中（工具卡在 gate 上）
    const goodSession = (await createSession(runtime.port, { providerId: "good" })).body as SessionCreated;
    await send(runtime.port, goodSession.session_id, "长任务");
    await waitFor("good session mid-run", async () => {
      const events = await ledgerEvents(runtime.port);
      return events.some((e) => e.event_type === "tool.started" && e.session_id === goodSession.session_id);
    });

    // 此时配错的 broken 会话发消息 → 工厂失败 → agent.error，但不影响 good
    const brokenSession = (await createSession(runtime.port, { providerId: "broken" })).body as SessionCreated;
    await send(runtime.port, brokenSession.session_id, "这会失败");
    await waitFor("broken agent.error", async () => {
      const events = await ledgerEvents(runtime.port);
      return events.some((e) => e.event_type === "agent.error" && e.session_id === brokenSession.session_id);
    });
    const brokenErr = (await ledgerEvents(runtime.port)).find(
      (e) => e.event_type === "agent.error" && e.session_id === brokenSession.session_id,
    );
    assert.match(String(brokenErr?.payload.message), /simulated misconfiguration/);

    // good 会话仍在进行中未被打断：放行 gate，完整收尾
    gate.open();
    await waitFor("good session completes", async () => {
      const h = await history(runtime.port, goodSession.session_id);
      return h.messages.some((m) => m.role === "assistant" && m.text.includes("good-答复"));
    });
    const goodHistory = await history(runtime.port, goodSession.session_id);
    assert.deepEqual(
      goodHistory.messages.map((m) => m.role),
      ["user", "assistant"],
    );
    const goodAssistant = goodHistory.messages.find((m) => m.role === "assistant");
    assert.equal(goodAssistant?.stop_reason, "stop");

    // good 会话之后还能继续正常对话（运行时未受污染）
    await send(runtime.port, goodSession.session_id, "继续");
    await waitFor("good session second reply", async () => {
      const h = await history(runtime.port, goodSession.session_id);
      return h.messages.filter((m) => m.role === "assistant").length === 2;
    });
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("env 回退（MORROW_PROVIDER_*）端到端：无 CRUD 时默认工厂经 env 配置真实对话（mock OpenAI 服务器）", async () => {
  const dir = tmpDir("morrow-switch-env-");
  const server = await startMockOpenAI(["你好", "！"]);
  const envProvider = {
    baseUrl: server.url,
    apiKey: "",
    modelId: "env-test-model",
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const { runtime } = await startWith({ envProvider, dir });
  try {
    const created = await createSession(runtime.port, {});
    const session = created.body as SessionCreated;
    await send(runtime.port, session.session_id, "早上好");
    await waitFor("env reply", async () => {
      const h = await history(runtime.port, session.session_id);
      return h.messages.some((m) => m.role === "assistant" && m.text.includes("你好"));
    });
    // mock 服务器收到真实 OpenAI 兼容请求
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].body.model, "env-test-model");
  } finally {
    await runtime.close();
    removeDir(dir);
    await server.close();
  }
});

// --- 辅助 -------------------------------------------------------------------

async function startMockOpenAI(textParts: string[]): Promise<{
  url: string;
  requests: Array<{ body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ body: Record<string, unknown> }> = [];
  const CHUNK_BASE = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1769692800,
    model: "env-test-model",
  };
  const server = http.createServer((req: http.IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push({ body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const part of textParts) {
        res.write(`data: ${JSON.stringify({ ...CHUNK_BASE, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
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
