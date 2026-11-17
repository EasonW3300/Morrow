// M7-B code-review 修复批的回归测试。
//
// 三条都是"看起来做完、实际不可用"的真缺陷（与 M2/M4 那几次同款病症）：
//   1. `reclaimIdle` 零调用点 → FR-B4「空闲 10min 退出」在生产上是死代码；
//   2. MCP 工具注册进 PermissionEngine 但没登记进 ToolInvoker → 注册表 enabled、
//      调用报 unknown_tool（"注册了但不可调"）；
//   3. `#execute` 快照失败没有审计 → 从账本看这次执行"从未发生"。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonRpcResponse } from "../src/mcp/protocol.ts";
import type { McpTransport } from "../src/mcp/client.ts";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { parseMcpCapabilityName } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

/** 假 MCP 传输：支持 discover / tools.list / tools/call，并记录调用 */
function fakeTransport(record: { calls: Array<{ tool: string; args: unknown }> }): McpTransport {
  return {
    isOpen: () => true,
    async start() {},
    async request(message: unknown): Promise<JsonRpcResponse> {
      const body = message as { id?: number | string; method?: string; params?: Record<string, unknown> };
      const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: body.id ?? null, result });
      if (body.method === "server/discover") {
        return reply({
          protocolVersion: "2026-07-28",
          serverInfo: { name: "fake", version: "1.0.0" },
          capabilities: { tools: {} },
        });
      }
      if (body.method === "tools/list") {
        return reply({ tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }] });
      }
      if (body.method === "tools/call") {
        record.calls.push({ tool: String(body.params?.name), args: body.params?.arguments });
        return reply({ content: [{ type: "text", text: `echoed:${JSON.stringify(body.params?.arguments ?? {})}` }] });
      }
      return reply({});
    },
    async close() {},
  } as McpTransport;
}

function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const FS_CONFIG = JSON.stringify({
  mcpServers: { "echo-server": { command: "npx", args: ["-y", "@mcp/echo"] } },
});

// --- 缺陷 2：MCP 工具必须真的能被调用 ----------------------------------------------

test("MCP 工具启用后**真的可以调用**（不是 unknown_tool）", async () => {
  const dir = tmpDir("morrow-review-mcp-");
  const calls: Array<{ tool: string; args: unknown }> = [];
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    mcpReclaimIntervalMs: 0,
    mcpTransportFactory: () => fakeTransport({ calls }),
  });
  try {
    // 安装并启用
    assert.equal(
      (await post(handle.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true })).status,
      201,
    );
    const enabled = await post(handle.port, "/v1/mcp/servers/echo-server/enable");
    assert.equal(enabled.status, 200);
    const enabledBody = await json<{ ok: boolean; server: { health: { tools_count: number } } }>(enabled);
    assert.equal(enabledBody.ok, true);
    assert.equal(enabledBody.server.health.tools_count, 1);

    // 调用该工具：修复前这里是 404 unknown_tool（注册了但没有执行体分派）。
    // 注意 MCP 工具的 manifest 权限是**全空**的，所以这里的调用不需要额外授予
    // 五维权限（空权限 ⊆ 任何 grants）；"启用 ≠ 授权"体现在 manifest 不声明任何
    // 维度——它拿不到 shell/网络，只能调该 server 自己的工具。
    const invoked = await post(handle.port, "/v1/capabilities/mcp.echo-server.echo/invoke", { hello: "world" });
    assert.equal(invoked.status, 200, `调用失败：${await invoked.clone().text()}`);
    const outcome = await json<{ ok: boolean; result: { text: string } }>(invoked);
    assert.equal(outcome.ok, true);
    assert.match(outcome.result.text, /echoed:/);
    assert.match(outcome.result.text, /hello/);
    // 传输层确实收到了 tools/call（不是被某个本地桩冒充）
    assert.deepEqual(calls, [{ tool: "echo", args: { hello: "world" } }]);
  } finally {
    await handle.close();
    removeDir(dir);
  }
});

test("停用 MCP server 后工具调用被拒（capability_disabled，不是 unknown_tool）", async () => {
  const dir = tmpDir("morrow-review-mcp-disable-");
  const calls: Array<{ tool: string; args: unknown }> = [];
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    mcpReclaimIntervalMs: 0,
    mcpTransportFactory: () => fakeTransport({ calls }),
  });
  try {
    await post(handle.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    await post(handle.port, "/v1/mcp/servers/echo-server/enable");
    await post(handle.port, "/v1/mcp/servers/echo-server/disable");

    const invoked = await post(handle.port, "/v1/capabilities/mcp.echo-server.echo/invoke", {});
    assert.notEqual(invoked.status, 200, "停用后不该能调用");
    const body = await json<{ error: { code: string; message: string } }>(invoked);
    // 权限层把 registry 的错误包成 permission_denied，原文保留在 message 里：
    // 关键断言是"提到 capability_disabled"（语义=已停用），而不是"unknown_tool"
    //（后者意味着注册链断了）。
    assert.match(
      `${body.error.code} ${body.error.message}`,
      /capability_disabled|disabled/,
      `应是「已停用」而不是「不存在」；实际：${body.error.code} ${body.error.message}`,
    );
    assert.equal(/unknown_tool/.test(`${body.error.code} ${body.error.message}`), false);
    assert.equal(calls.length, 0, "停用后不该真的发给 MCP server");
  } finally {
    await handle.close();
    removeDir(dir);
  }
});

test("parseMcpCapabilityName：与 mcpCapabilityName 互为逆运算", () => {
  assert.deepEqual(parseMcpCapabilityName("mcp.fs.read_file"), { serverId: "fs", toolName: "read_file" });
  // 工具名里允许点号（合成的 safe 化会保留 - 和 _，但不留点；这里验证解析不误切）
  assert.deepEqual(parseMcpCapabilityName("mcp.my-server.a-b_c"), {
    serverId: "my-server",
    toolName: "a-b_c",
  });
  assert.deepEqual(parseMcpCapabilityName("memory.write"), { serverId: null, toolName: null });
  assert.deepEqual(parseMcpCapabilityName("mcp.only"), { serverId: null, toolName: null });
});

// --- 缺陷 1：空闲回收必须有驱动器 ------------------------------------------------

test("MCP 空闲回收定时器：mcpReclaimIntervalMs>0 时会被驱动（进程不无限挂住）", async () => {
  const dir = tmpDir("morrow-review-reclaim-");
  const calls: Array<{ tool: string; args: unknown }> = [];
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    // 20ms 轮询 + 0ms 空闲阈值：让回收在测试里立刻发生（生产是 60s / 10min）
    mcpReclaimIntervalMs: 20,
    mcpIdleTimeoutMs: 0, // 空闲阈值 0：下一轮轮询即回收（生产是 10min）
    mcpTransportFactory: () => fakeTransport({ calls }),
  });
  try {
    await post(handle.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    await post(handle.port, "/v1/mcp/servers/echo-server/enable");

    // 等定时器至少跑几轮：如果没有驱动器，这里不会有任何变化
    await new Promise((resolve) => setTimeout(resolve, 120));

    const view = await json<{ server: { enabled: boolean; health: { state: string } } }>(
      await fetch(`http://127.0.0.1:${handle.port}/v1/mcp/servers/echo-server`),
    );
    // 空闲回收后进程退出（state=stopped），但 enabled 仍是 true（下次调用会自动拉起）
    assert.equal(view.server.health.state, "stopped", "空闲回收应当关掉了传输");
    assert.equal(view.server.enabled, true, "回收不等于停用：下次调用应自动重启");
  } finally {
    await handle.close();
    removeDir(dir);
  }
});

test("reclaimInterval=0 时不启动定时器（测试可控性）", async () => {
  const dir = tmpDir("morrow-review-no-reclaim-");
  const calls: Array<{ tool: string; args: unknown }> = [];
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    mcpReclaimIntervalMs: 0,
    mcpTransportFactory: () => fakeTransport({ calls }),
  });
  try {
    await post(handle.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    await post(handle.port, "/v1/mcp/servers/echo-server/enable");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 没有定时器 → 不会回收，工具仍可调用
    const invoked = await post(handle.port, "/v1/capabilities/mcp.echo-server.echo/invoke", {});
    assert.equal(invoked.status, 200);
  } finally {
    await handle.close();
    removeDir(dir);
  }
});

// --- 缺陷 3：快照失败必须留审计 --------------------------------------------------

test("快照失败 → 拒绝执行，且审计里留下 phase=snapshot_failed", async () => {
  const dir = tmpDir("morrow-review-snapfail-");
  const calls: Array<{ tool: string; args: unknown }> = [];
  // 让快照根指向一个不可写的位置：把 snapshotsRoot 设成一个文件而非目录
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(dir, { recursive: true });
  const blockedRoot = join(dir, "blocked-snapshots");
  writeFileSync(blockedRoot, "not a directory");

  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    mcpReclaimIntervalMs: 0,
    execSnapshotsRoot: blockedRoot,
    execRunner: {
      async run() {
        throw new Error("runner must not be called when snapshot fails");
      },
    },
  });
  try {
    const sessionId = (
      await json<{ session_id: string }>(
        await post(handle.port, "/v1/sessions", {}),
      )
    ).session_id;
    // 绑定一个真实存在的工作区（否则不会尝试快照）
    const workspace = join(dir, "ws");
    mkdirSync(workspace, { recursive: true });
    const bound = await fetch(`http://127.0.0.1:${handle.port}/v1/sessions/${sessionId}/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "local", path: workspace }),
    });
    assert.equal(bound.status, 200);

    await fetch(`http://127.0.0.1:${handle.port}/v1/sessions/${sessionId}/exec-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "full_access" }),
    });

    const executed = await post(handle.port, `/v1/sessions/${sessionId}/exec`, { script: "echo hi" });
    assert.notEqual(executed.status, 200, "快照失败必须拒绝执行（fail-closed）");

    const events = await json<{ events: Array<{ event_type: string; payload: Record<string, unknown> }> }>(
      await fetch(`http://127.0.0.1:${handle.port}/v1/events?limit=200`),
    );
    const snapshotFailed = events.events.find(
      (event) => event.event_type === "exec.requested" && event.payload.phase === "snapshot_failed",
    );
    assert.ok(snapshotFailed !== undefined, "快照失败必须留审计（否则账本看这次执行从未发生过）");
    assert.equal(snapshotFailed.payload.script, "echo hi");
    assert.ok(typeof snapshotFailed.payload.error === "string");

    // 没有 exec.finished：确实没执行
    assert.equal(
      events.events.some((event) => event.event_type === "exec.finished"),
      false,
      "快照失败不该有任何执行完成事件",
    );
  } finally {
    await handle.close();
    removeDir(dir);
  }
});
