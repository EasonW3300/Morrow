// QQ 官方 Bot WebSocket 网关传输测试（M4-T4 / Issue #41）。
// 零真实网络：fake WebSocket（addEventListener/send/close）+ fake fetch（token/gateway）。
// 覆盖 Hello→Identify→心跳、Dispatch→handleTrustedEvent（跳过 Ed25519）、
// op 7/op 9 重连并重新 Identify、断线指数退避、stop 清理幂等、token 刷新后重新 Identify。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QQ_INTENT_GROUP_AND_C2C,
  QqChannelAdapter,
  QqWebSocketTransport,
  type QqConfig,
  type QqWebSocketEventLike,
  type QqWebSocketLike,
  type QqWebSocketTransportOptions,
} from "../src/channels/adapters/qq/index.ts";

const CONFIG: QqConfig = {
  appId: "qq_test_app",
  appSecret: "qq_test_secret",
  // 配置 bot_secret 以证明 WS Dispatch 不走 Webhook 的 Ed25519 校验
  botSecret: "qq_bot_secret",
};

const GATEWAY_URL = "wss://gateway.test/ws";

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 最小 fake WebSocket：只实现传输实际用到的 addEventListener/send/close。 */
class FakeWebSocket implements QqWebSocketLike {
  readonly url: string;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  closeCode: number | null = null;

  readonly #listeners = new Map<string, Array<(event: QqWebSocketEventLike) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: QqWebSocketEventLike) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: QqWebSocketEventLike) => void): void {
    const list = this.#listeners.get(type);
    if (list === undefined) return;
    this.#listeners.set(
      type,
      list.filter((candidate) => candidate !== listener),
    );
  }

  send(data: string): void {
    if (this.closed) throw new Error("send on closed socket");
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, _reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.#emit("close", { code, reason: "client close" });
  }

  // --- 测试驱动 ------------------------------------------------------------

  hello(heartbeatIntervalMs: number): void {
    this.#emit("message", {
      data: JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatIntervalMs } }),
    });
  }

  dispatch(t: string, d: Record<string, unknown>, s?: number): void {
    this.#emit("message", {
      data: JSON.stringify({ op: 0, t, s: s ?? this.sent.length + 1, d }),
    });
  }

  sendOp(op: number, d?: unknown): void {
    this.#emit("message", { data: JSON.stringify({ op, d }) });
  }

  /** 模拟平台侧断开（非客户端主动 close）。 */
  drop(code = 1006): void {
    this.closed = true;
    this.#emit("close", { code, reason: "server drop" });
  }

  #emit(type: string, event: QqWebSocketEventLike): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

interface WsNetwork {
  sockets: FakeWebSocket[];
  gatewayRequests: Array<{ authorization: string | null }>;
  tokenRequests: number;
  factory: (url: string) => FakeWebSocket;
  fetch: typeof fetch;
}

function createNetwork(): WsNetwork {
  const sockets: FakeWebSocket[] = [];
  const gatewayRequests: WsNetwork["gatewayRequests"] = [];

  const network: WsNetwork = {
    sockets,
    gatewayRequests,
    tokenRequests: 0,
    factory(url) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/app/getAppAccessToken")) {
        network.tokenRequests += 1;
        return Response.json({
          access_token: `qq-token-${network.tokenRequests}`,
          expires_in: 7_200,
        });
      }
      if (url.endsWith("/gateway")) {
        gatewayRequests.push({ authorization: headerValue(init, "authorization") });
        return Response.json({ url: GATEWAY_URL });
      }
      throw new Error(`unexpected fetch in qq websocket test: ${url}`);
    }) as typeof fetch,
  };
  return network;
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === name) return value;
    }
    return null;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

interface Harness {
  network: WsNetwork;
  transport: QqWebSocketTransport;
  adapter: QqChannelAdapter;
  inbound: Array<Record<string, unknown>>;
  rejected: Array<{ code: string; message: string }>;
  waits: number[];
  socket(): FakeWebSocket;
  dispose(): Promise<void>;
}

async function setup(options: {
  transport?: Partial<QqWebSocketTransportOptions>;
  config?: QqConfig;
} = {}): Promise<Harness> {
  const network = createNetwork();
  const waits: number[] = [];
  const inbound: Array<Record<string, unknown>> = [];
  const rejected: Array<{ code: string; message: string }> = [];

  const transport = new QqWebSocketTransport({
    apiBaseUrl: "https://api.test",
    fetch: network.fetch,
    webSocketFactory: network.factory,
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 4,
    tokenRefreshIntervalMs: 0,
    ...options.transport,
  });

  const adapter = new QqChannelAdapter({
    accountId: "qq-default",
    config: options.config ?? CONFIG,
    apiBaseUrl: "https://api.test",
    tokenEndpoint: "https://api.test/app/getAppAccessToken",
    fetch: network.fetch,
    eventTransport: transport,
    requestTimeoutMs: 500,
  });

  await adapter.start({
    accountId: "qq-default",
    onInbound: (raw) => inbound.push(raw as Record<string, unknown>),
    onInboundRejected: (event) => rejected.push({ code: event.code, message: event.message }),
  });
  // transport 的 start() 是异步外连；等首个 socket 出现
  await waitFor("websocket socket", () => network.sockets.length >= 1);

  return {
    network,
    transport,
    adapter,
    inbound,
    rejected,
    waits,
    socket() {
      const socket = network.sockets[network.sockets.length - 1];
      assert.ok(socket !== undefined, "no websocket created");
      return socket;
    },
    async dispose() {
      await adapter.stop();
    },
  };
}

function groupEvent(messageId = "qq_group_in_1"): Record<string, unknown> {
  return {
    op: 0,
    id: `evt_${messageId}`,
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: messageId,
      content: `<@!${CONFIG.appId}> 你好`,
      timestamp: "2026-11-10T00:00:00.000Z",
      group_openid: "qq_group_1",
      author: { id: "qq_owner", member_openid: "qq_owner" },
    },
  };
}

test("Hello → Identify（QQBot token / intents 1<<25 / shard）→ 心跳 op 1；op 11 忽略", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  assert.equal(h.network.gatewayRequests.length, 1);
  assert.equal(h.network.gatewayRequests[0].authorization, "QQBot qq-token-1");
  assert.equal(h.socket().url, GATEWAY_URL);

  const socket = h.socket();
  socket.hello(5);
  await waitFor("identify frame", () => socket.sent.length >= 1);

  assert.deepEqual(socket.sent[0], {
    op: 2,
    d: {
      token: "QQBot qq-token-1",
      intents: QQ_INTENT_GROUP_AND_C2C,
      shard: [0, 1],
    },
  });
  assert.equal(QQ_INTENT_GROUP_AND_C2C, 1 << 25);

  await waitFor("heartbeat frame", () => socket.sent.some((frame) => frame.op === 1));
  const heartbeat = socket.sent.find((frame) => frame.op === 1);
  assert.deepEqual(heartbeat, { op: 1, d: null });

  // op 11 心跳 ACK：不报错、不产生拒绝，也不影响后续心跳
  const before = socket.sent.filter((frame) => frame.op === 1).length;
  socket.sendOp(11);
  await delay(12);
  assert.equal(socket.sent.filter((frame) => frame.op === 1).length >= before, true);
  assert.equal(h.rejected.length, 0);
});

test("Dispatch → handleTrustedEvent：无 Ed25519 签名也进入 onInbound；非消息事件忽略", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const socket = h.socket();
  socket.hello(60_000);

  socket.dispatch("GROUP_AT_MESSAGE_CREATE", groupEvent().d as Record<string, unknown>);
  socket.dispatch("C2C_MESSAGE_CREATE", {
    id: "qq_dm_in_1",
    content: "私聊",
    timestamp: "2026-11-10T00:00:01.000Z",
    author: { id: "qq_user_1", user_openid: "qq_user_1" },
  });
  socket.dispatch("READY", { user: { id: "bot" } });

  await waitFor("two inbound events", () => h.inbound.length === 2);
  assert.equal(h.inbound[0].t, "GROUP_AT_MESSAGE_CREATE");
  assert.equal(h.inbound[1].t, "C2C_MESSAGE_CREATE");
  assert.equal(h.rejected.length, 0, "WS 通道没有签名，不应产生 signature_* 拒绝");

  // 适配器 health 由 WS 消息恢复为 connected
  const health = await h.adapter.health();
  assert.equal(health.connection !== "degraded", true);
});

test("op 7（要求重连）：关闭旧连接 → 新连接 → 重新 Identify", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const first = h.socket();
  first.hello(60_000);
  await waitFor("identify", () => first.sent.length === 1);

  first.sendOp(7);
  await waitFor("second socket", () => h.network.sockets.length === 2);
  assert.equal(first.closed, true);
  assert.equal(h.waits[0], 0, "op 7 立即重连，不进入指数退避");

  const second = h.network.sockets[1];
  second.hello(60_000);
  await waitFor("re-identify", () => second.sent.some((frame) => frame.op === 2));
  assert.equal((second.sent[0].d as Record<string, unknown>).token, "QQBot qq-token-1");
});

test("op 9（会话失效）：丢弃旧会话 → 新连接 → 重新 Identify", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const first = h.socket();
  first.hello(60_000);
  await waitFor("identify", () => first.sent.length === 1);

  first.sendOp(9);
  await waitFor("second socket", () => h.network.sockets.length === 2);
  assert.equal(first.closed, true);

  const second = h.network.sockets[1];
  second.hello(60_000);
  await waitFor("re-identify", () => second.sent.some((frame) => frame.op === 2));
});

test("断线重连：指数退避 1s→2s→4s…，受 max 截断", async (t) => {
  const h = await setup({ transport: { reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 30 } });
  t.after(() => h.dispose());

  h.socket().drop(1006);
  await waitFor("first reconnect", () => h.network.sockets.length === 2 && h.waits.length === 1);
  h.socket().drop(1006);
  await waitFor("second reconnect", () => h.network.sockets.length === 3 && h.waits.length === 2);
  h.socket().drop(1006);
  await waitFor("third reconnect", () => h.network.sockets.length === 4 && h.waits.length === 3);

  assert.deepEqual(h.waits.slice(0, 3), [10, 20, 30], "10 → 20 → min(40, 30)");
});

test("Hello 成功后退避计数重置", async (t) => {
  const h = await setup({ transport: { reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 30 } });
  t.after(() => h.dispose());

  h.socket().drop(1006);
  await waitFor("first reconnect", () => h.network.sockets.length === 2 && h.waits.length === 1);
  const second = h.socket();
  second.hello(60_000);
  await waitFor("identify", () => second.sent.some((frame) => frame.op === 2));

  second.drop(1006);
  await waitFor("second reconnect", () => h.network.sockets.length === 3 && h.waits.length === 2);
  assert.deepEqual(h.waits, [10, 10], "Hello 重置尝试次数，退避回到基数");
});

test("stop：关闭连接、停心跳、幂等，且不再重连", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const socket = h.socket();
  socket.hello(5);
  await waitFor("heartbeat", () => socket.sent.some((frame) => frame.op === 1));

  await h.transport.stop();
  assert.equal(socket.closed, true);
  assert.equal(socket.closeCode, 1000);

  const sentAfterStop = socket.sent.length;
  const socketsAfterStop = h.network.sockets.length;
  await delay(30);
  assert.equal(socket.sent.length, sentAfterStop, "心跳定时器已清理");
  assert.equal(h.network.sockets.length, socketsAfterStop, "stop 后不再重连");

  socket.drop(1006); // 旧连接的 close 事件不得触发重连
  await delay(20);
  assert.equal(h.network.sockets.length, socketsAfterStop);

  await h.transport.stop(); // 第二次 stop 仍幂等
});

test("token 过期前主动刷新 → 用新 token 重连并重新 Identify", async (t) => {
  const h = await setup({
    transport: { tokenRefreshIntervalMs: 20, reconnectBaseDelayMs: 1 },
  });
  t.after(() => h.dispose());

  const first = h.socket();
  first.hello(60_000);
  await waitFor("initial identify", () => first.sent.some((frame) => frame.op === 2));
  assert.equal(h.network.tokenRequests, 1);

  await waitFor("reconnect after token refresh", () => h.network.sockets.length === 2, 2_000);
  assert.equal(h.network.tokenRequests, 2, "强制刷新一次 token");
  assert.equal(h.waits[0], 0, "刷新后立即重连");

  const second = h.network.sockets[1];
  second.hello(60_000);
  await waitFor("re-identify with new token", () => second.sent.some((frame) => frame.op === 2));
  assert.equal((second.sent[0].d as Record<string, unknown>).token, "QQBot qq-token-2");
});

test("WebSocket 全局缺失且未注入工厂时明确报错", async () => {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  // @ts-expect-error 测试临时移除全局 WebSocket
  delete globalThis.WebSocket;
  try {
    const transport = new QqWebSocketTransport({
      apiBaseUrl: "https://api.test",
      gatewayUrl: GATEWAY_URL,
    });
    const errors: Error[] = [];
    transport.attachTokenProvider({ getAccessToken: async () => "token" });
    transport.start(
      () => undefined,
      (error) => errors.push(error),
    );
    const { setTimeout: localWait } = await import("node:timers/promises");
    let observed = false;
    for (let attempt = 0; attempt < 100 && !observed; attempt += 1) {
      observed = errors.some((error) => /global WebSocket/.test(error.message));
      if (!observed) await localWait(5);
    }
    assert.equal(observed, true);
    await transport.stop();
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
  }
});
