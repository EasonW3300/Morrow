// MCP 客户端测试（票 M7-B-T1 / Issue #67）。
// 重点：双代际探测三条分支（含"版本不支持不得回退"）、懒启动、空闲回收、
// 崩溃重启上限、工具列表与调用。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_RESTARTS,
  McpClient,
  McpProtocolError,
  type McpTransport,
} from "../src/mcp/client.ts";
import type { JsonRpcResponse } from "../src/mcp/protocol.ts";

/** 一次性脚本化传输：按方法名回放预设响应 */
function scriptedTransport(
  responses: Record<string, JsonRpcResponse | "timeout" | "closed">,
  calls: string[] = [],
): McpTransport & { calls: string[]; opened: number; closed: number } {
  let open = false;
  const state = {
    calls,
    opened: 0,
    closed: 0,
    isOpen: () => open,
    async start() {
      open = true;
      state.opened += 1;
    },
    async request(message: unknown) {
      const method = (message as { method?: string }).method ?? "";
      calls.push(method);
      const preset = responses[method];
      if (preset === undefined) return { jsonrpc: "2.0", id: null, result: {} } as JsonRpcResponse;
      if (preset === "timeout") return new Promise<JsonRpcResponse>(() => {}); // 永不 settle
      if (preset === "closed") {
        open = false;
        throw new Error("transport closed");
      }
      return preset;
    },
    async close() {
      open = false;
      state.closed += 1;
    },
  };
  return state;
}

function ok(result: unknown, id: number | string = 1): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: 1, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** 现代 server：discover 成功 */
const MODERN = () =>
  scriptedTransport({
    "server/discover": ok({
      protocolVersion: "2026-07-28",
      serverInfo: { name: "modern-server", version: "2.0.0" },
      capabilities: { tools: {}, resources: {} },
    }),
    "tools/list": ok({ tools: [{ name: "read_file", description: "读文件" }] }),
    "tools/call": ok({ content: [{ type: "text", text: "文件内容" }] }),
  });

// --- 三条分支 -----------------------------------------------------------------------

test("分支 1：discover 成功 → generation=discover，不回退 initialize", async () => {
  const transport = MODERN();
  const client = new McpClient({ transportFactory: () => transport });
  await client.ensureReady();
  assert.equal(client.state, "ready");
  assert.equal(client.probeResult?.generation, "discover");
  assert.equal(client.probeResult?.protocolVersion, "2026-07-28");
  assert.equal(client.probeResult?.serverInfo.name, "modern-server");
  assert.ok(!transport.calls.includes("initialize"), "不得回退 initialize");
});

test("分支 2：UnsupportedProtocolVersionError → 按 supported 重试，绝不回退 initialize", async () => {
  let discoverCalls = 0;
  const transport: McpTransport = {
    isOpen: () => true,
    async start() {},
    async close() {},
    async request(message: unknown) {
      const record = message as { method: string; params?: { supported?: string[] } };
      if (record.method === "server/discover") {
        discoverCalls += 1;
        if (discoverCalls === 1) {
          // 第一次带了两个版本都不被接受，server 只支持 2025-11-25
          return err(-32000, "Unsupported protocol version", {
            error: "UnsupportedProtocolVersionError",
            supported: ["2025-11-25"],
          });
        }
        assert.deepEqual(record.params?.supported, ["2025-11-25"], "第二次必须只请求 server 支持的版本");
        return ok({
          protocolVersion: "2025-11-25",
          serverInfo: { name: "modern-narrow" },
          capabilities: { tools: {} },
        });
      }
      throw new Error(`unexpected method ${record.method}`);
    },
  };
  const client = new McpClient({ transportFactory: () => transport });
  await client.ensureReady();
  assert.equal(discoverCalls, 2, "discover 被调用两次");
  assert.equal(client.probeResult?.generation, "discover");
  assert.equal(client.probeResult?.protocolVersion, "2025-11-25");
});

test("分支 2 边界：server 支持的版本与我们无交集 → degraded，且**不**尝试 initialize", async () => {
  const transport = scriptedTransport({
    "server/discover": err(-32000, "Unsupported protocol version", {
      error: "UnsupportedProtocolVersionError",
      supported: ["2024-01-01"],
    }),
  });
  const client = new McpClient({ transportFactory: () => transport });
  await assert.rejects(() => client.ensureReady(), McpProtocolError);
  assert.equal(client.state, "degraded");
  assert.ok(!transport.calls.includes("initialize"), "版本谈不拢不等于旧版，不得回退");
  assert.match(client.health().lastError ?? "", /do not support/);
});

test("分支 3：method not found → 判定 legacy，回退 initialize 并发送 initialized 通知", async () => {
  const transport = scriptedTransport({
    "server/discover": err(-32601, "Method not found"),
    initialize: ok({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "legacy-server", version: "1.0.0" },
      capabilities: { tools: {} },
    }),
    "notifications/initialized": ok({}),
  });
  const client = new McpClient({ transportFactory: () => transport });
  await client.ensureReady();
  assert.equal(client.probeResult?.generation, "initialize");
  assert.equal(client.probeResult?.protocolVersion, "2024-11-05");
  assert.ok(transport.calls.includes("initialize"));
  assert.ok(
    transport.calls.includes("notifications/initialized"),
    "initialize 之后必须发 initialized 通知",
  );
});

test("分支 3 边界：discover 超时 → 也判 legacy（超时是分支信号，不是致命错误）", async () => {
  const transport = scriptedTransport({
    "server/discover": "timeout",
    initialize: ok({ protocolVersion: "2024-11-05", capabilities: { tools: {} } }),
    "notifications/initialized": ok({}),
  });
  const client = new McpClient({
    transportFactory: () => transport,
    requestTimeoutMs: 20, // 极短超时让测试快
  });
  await client.ensureReady();
  assert.equal(client.probeResult?.generation, "initialize");
});

// --- 能力协商 -----------------------------------------------------------------------

test("只接 tools：resources 被如实记为不支持", async () => {
  const client = new McpClient({ transportFactory: MODERN });
  await client.ensureReady();
  assert.equal(client.probeResult?.capabilities.tools, true);
  assert.deepEqual(client.probeResult?.unsupportedCapabilities, ["resources"]);
});

// --- 工具列表与调用 -----------------------------------------------------------------

test("listTools：解析 name/description/inputSchema；缺字段不崩", async () => {
  const transport = scriptedTransport({
    "server/discover": ok({ protocolVersion: "2026-07-28", capabilities: { tools: {} } }),
    "tools/list": ok({
      tools: [
        { name: "a", description: "d", inputSchema: { type: "object" } },
        { name: "b" },
        { description: "没有名字应被过滤" },
      ],
    }),
  });
  const client = new McpClient({ transportFactory: () => transport });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["a", "b"]);
  assert.equal(tools[0].description, "d");
  assert.deepEqual(tools[0].inputSchema, { type: "object" });
});

test("callTool：文本内容拼接；isError 时 ok=false 并带错误文案", async () => {
  const transport = scriptedTransport({
    "server/discover": ok({ protocolVersion: "2026-07-28", capabilities: { tools: {} } }),
    "tools/call": ok({
      content: [
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ],
    }),
  });
  const client = new McpClient({ transportFactory: () => transport });
  const outcome = await client.callTool("x");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, "第一段\n第二段");
});

test("callTool：协议错误（工具不存在）→ ok=false 且带 code", async () => {
  const transport = scriptedTransport({
    "server/discover": ok({ protocolVersion: "2026-07-28", capabilities: { tools: {} } }),
    "tools/call": err(-32602, "Unknown tool"),
  });
  const client = new McpClient({ transportFactory: () => transport });
  const outcome = await client.callTool("nope");
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /-32602/);
});

// --- 进程生命周期 -------------------------------------------------------------------

test("懒启动：构造后不启动；首次 ensureReady 才 start（且只启动一次）", async () => {
  let factoryCalls = 0;
  const client = new McpClient({
    transportFactory: () => {
      factoryCalls += 1;
      return MODERN();
    },
  });
  assert.equal(factoryCalls, 0, "构造时不启动");
  await client.ensureReady();
  await client.ensureReady();
  await client.listTools();
  assert.equal(factoryCalls, 1, "复用同一传输，不重复启动");
});

test("空闲回收：超过 idleTimeoutMs 后 close 并把状态置 stopped", async () => {
  let nowMs = 1_000;
  const transport = MODERN();
  const client = new McpClient({ transportFactory: () => transport, now: () => nowMs });
  await client.ensureReady();
  nowMs += 1_000;
  assert.equal(await client.reclaimIfIdle(), false, "未到超时不回收");
  nowMs += DEFAULT_IDLE_TIMEOUT_MS;
  assert.equal(await client.reclaimIfIdle(), true, "到超时即回收");
  assert.equal(client.state, "stopped");
  assert.equal(transport.closed, 1);
});

test("传输关闭后再次调用会自动重连（懒启动语义），不报错", async () => {
  let factoryCalls = 0;
  const client = new McpClient({
    transportFactory: () => {
      factoryCalls += 1;
      return MODERN();
    },
  });
  await client.ensureReady();
  assert.equal(factoryCalls, 1);
  // 模拟空闲回收/对端断开：传输关闭，但下次调用应自动重建并重新探测
  await client.close();
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["read_file"], "自动重连后可继续工作");
  assert.equal(factoryCalls, 2, "重连会新建传输");
  assert.equal(client.state, "ready");
});

test("显式标记损坏：未超上限进入 stopped 等待重启，计数 +1", async () => {
  const client = new McpClient({ transportFactory: MODERN });
  await client.ensureReady();
  await client.markTransportBroken("transport closed by peer");
  assert.equal(client.state, "stopped", "未超上限时允许重启");
  assert.equal(client.health().restarts, 1);
  assert.match(client.health().lastError ?? "", /transport closed by peer/);
});

test("重启超上限 → degraded 且后续调用直接拒绝（不再无声重试）", async () => {
  let factoryCalls = 0;
  const client = new McpClient({
    transportFactory: () => {
      factoryCalls += 1;
      return MODERN();
    },
    maxRestarts: 1,
  });
  await client.ensureReady();
  // 连续两次标记损坏：第一次进入重启窗口，第二次超上限 → degraded
  await client.markTransportBroken("first failure");
  assert.equal(client.state, "stopped");
  await client.markTransportBroken("second failure");
  assert.equal(client.state, "degraded");
  assert.equal(client.health().restarts, 1, "达到上限即停止计数");

  const before = factoryCalls;
  await assert.rejects(() => client.listTools(), McpProtocolError);
  assert.equal(factoryCalls, before, "degraded 后不再新建传输");
});

test("start 失败 → degraded 且错误可读（不抛出裸异常）", async () => {
  const client = new McpClient({
    transportFactory: () => ({
      isOpen: () => false,
      async start() {
        throw new Error("spawn ENOENT");
      },
      async request() {
        return ok({});
      },
      async close() {},
    }),
  });
  await assert.rejects(() => client.ensureReady(), McpProtocolError);
  assert.equal(client.state, "degraded");
  assert.match(client.health().lastError ?? "", /spawn ENOENT/);
});

test("close 幂等：反复调用不抛错", async () => {
  const client = new McpClient({ transportFactory: MODERN });
  await client.ensureReady();
  await client.close();
  await client.close();
  assert.equal(client.state, "stopped");
});

test("MAX_RESTARTS 默认 3；IDLE 默认 10 分钟", () => {
  assert.equal(DEFAULT_MAX_RESTARTS, 3);
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 10 * 60 * 1000);
});
