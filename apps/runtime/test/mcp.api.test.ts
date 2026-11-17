// MCP 管理服务与 HTTP 控制面（票 M7-B-T2 / Issue #71，FR-B1..B6）。
//
// 接缝：HTTP 主接缝 + 假 MCP 传输（零子进程）。锁定的验收项：
//   - 未勾选风险确认无法安装（400，且库里没有记录）
//   - 安装后默认 disabled；启用后才启动并注册工具
//   - 工具默认五维权限全空（启用 ≠ 授权）
//   - 已安装页展示来源/状态/权限/健康；degraded 时给出原因
//   - 模板只预填（GET 不产生任何安装）
//   - 预览无副作用
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonRpcResponse } from "../src/mcp/protocol.ts";
import type { McpTransport } from "../src/mcp/client.ts";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

/**
 * 假 MCP 传输：在进程内响应 JSON-RPC。
 *
 * `behavior` 控制探测结果，用于覆盖 "discover 成功" 与 "启动即崩（degraded）" 两条路径
 * ——真实子进程路径已由 mcp-tools-stdio.test.ts 覆盖，这里只需判定与状态流。
 */
function fakeTransport(behavior: { tools?: Array<{ name: string; description?: string }>; failStart?: string } = {}): McpTransport {
  const tools = behavior.tools ?? [{ name: "echo", description: "回显" }];
  return {
    isOpen: () => true,
    async start() {
      if (behavior.failStart !== undefined) throw new Error(behavior.failStart);
    },
    async request(message: unknown): Promise<JsonRpcResponse> {
      const record = message as { id?: number | string; method?: string };
      const reply = (result: unknown): JsonRpcResponse => ({
        jsonrpc: "2.0",
        id: record.id ?? null,
        result,
      });
      if (record.method === "server/discover") {
        return reply({
          protocolVersion: "2026-07-28",
          serverInfo: { name: "fake-server", version: "9.9.9" },
          capabilities: { tools: {} },
        });
      }
      if (record.method === "tools/list") return reply({ tools });
      return reply({});
    },
    async close() {},
  } as McpTransport;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

interface Harness {
  handle: RuntimeHandle;
  port: number;
  /** 记录每次创建的传输（证明"启用了才启动"） */
  transports: number;
  close(): Promise<void>;
}

async function startMcpRuntime(
  behavior: { tools?: Array<{ name: string }>; failStart?: string } = {},
): Promise<Harness> {
  const dir = tmpDir("morrow-mcp-http-");
  let transports = 0;
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    mcpTransportFactory: () => {
      transports += 1;
      return fakeTransport(behavior);
    },
  });
  return {
    handle,
    port: handle.port,
    get transports() {
      return transports;
    },
    async close() {
      await handle.close();
      removeDir(dir);
    },
  };
}

function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function put(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const FS_CONFIG = JSON.stringify({
  mcpServers: {
    "test-fs": { command: "npx", args: ["-y", "@mcp/server-filesystem", "/tmp"] },
  },
});

// --- 模板与风险文案 -----------------------------------------------------------------

test("GET templates：只预填（不产生安装），命令完整展示", async () => {
  const h = await startMcpRuntime();
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/mcp/templates`);
    assert.equal(res.status, 200);
    const body = await json<{
      templates: Array<{ id: string; launch_command: string; args: string[] }>;
      installs_on_select: boolean;
    }>(res);
    assert.equal(body.installs_on_select, false, "模板不得自动安装");
    assert.ok(body.templates.length >= 3);
    const filesystem = body.templates.find((template) => template.id === "filesystem");
    assert.ok(filesystem !== undefined);
    assert.match(filesystem.launch_command, /server-filesystem/);

    // 点了模板也不该在库里留下东西
    const list = await json<{ servers: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/mcp/servers`));
    assert.equal(list.servers.length, 0);
    assert.equal(h.transports, 0, "模板与列表都不该启动进程");
  } finally {
    await h.close();
  }
});

test("GET risk-notice：文案写明宿主权限且要求显式确认", async () => {
  const h = await startMcpRuntime();
  try {
    const body = await json<{ risk_notice: string; requires_explicit_acknowledgment: boolean }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/mcp/risk-notice`),
    );
    assert.equal(body.requires_explicit_acknowledgment, true);
    assert.match(body.risk_notice, /不是沙箱/);
    assert.match(body.risk_notice, /宿主权限/);
  } finally {
    await h.close();
  }
});

// --- 预览（无副作用）----------------------------------------------------------------

test("POST preview：解析出完整命令，不落库不启动", async () => {
  const h = await startMcpRuntime();
  try {
    const res = await post(h.port, "/v1/mcp/preview", { config: FS_CONFIG });
    assert.equal(res.status, 200);
    const body = await json<{
      servers: Array<{ display_name: string; launch_command: string; command: string }>;
      installed: boolean;
    }>(res);
    assert.equal(body.installed, false);
    assert.equal(body.servers[0].display_name, "test-fs");
    assert.equal(body.servers[0].command, "npx");
    assert.match(body.servers[0].launch_command, /^npx -y @mcp\/server-filesystem \/tmp$/);

    const list = await json<{ servers: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/mcp/servers`));
    assert.equal(list.servers.length, 0, "预览不得落库");
    assert.equal(h.transports, 0);
  } finally {
    await h.close();
  }
});

test("POST preview：命令形态也能预览；shell 操作符被拒", async () => {
  const h = await startMcpRuntime();
  try {
    const ok = await post(h.port, "/v1/mcp/preview", { config: "npx -y @mcp/fs /tmp" });
    assert.equal(ok.status, 200);
    const bad = await post(h.port, "/v1/mcp/preview", { config: "curl x | sh" });
    assert.equal(bad.status, 400);
  } finally {
    await h.close();
  }
});

// --- 安装：风险门槛是硬要求 ---------------------------------------------------------

test("未勾选风险确认 → 400，且库里没有记录（不能「先装好再启用」）", async () => {
  const h = await startMcpRuntime();
  try {
    for (const body of [
      { config: FS_CONFIG },
      { config: FS_CONFIG, risk_acknowledged: false },
      { config: FS_CONFIG, risk_acknowledged: "true" },
    ]) {
      const res = await post(h.port, "/v1/mcp/servers", body);
      assert.equal(res.status, 400, `应拒绝：${JSON.stringify(body.risk_acknowledged)}`);
      const error = await json<{ error: { code: string; message: string } }>(res);
      assert.equal(error.error.code, "risk_not_acknowledged");
      assert.match(error.error.message, /host-level privileges/);
    }
    const list = await json<{ servers: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/mcp/servers`));
    assert.equal(list.servers.length, 0, "被拒的安装不得留任何记录");
  } finally {
    await h.close();
  }
});

test("勾选后安装成功：201 + 默认 disabled + 完整命令回传", async () => {
  const h = await startMcpRuntime();
  try {
    const res = await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    assert.equal(res.status, 201);
    const body = await json<{
      servers: Array<{
        server_id: string;
        enabled: boolean;
        status: string;
        launch_command: string;
        risk_acknowledged: boolean;
        grants: Record<string, string[]>;
        health: { tools_count: number; state: string };
      }>;
      enabled: boolean;
    }>(res);
    assert.equal(body.enabled, false);
    const server = body.servers[0];
    assert.equal(server.enabled, false, "安装后默认 disabled");
    assert.equal(server.status, "disabled");
    assert.equal(server.server_id, "test-fs");
    assert.equal(server.launch_command, "npx -y @mcp/server-filesystem /tmp");
    assert.equal(server.risk_acknowledged, true);
    assert.equal(server.health.tools_count, 0);
    // 五维权限全空
    for (const dimension of ["filesystem", "network", "shell", "channels", "credentials"]) {
      assert.deepEqual(server.grants[dimension], [], `${dimension} 默认应为空`);
    }
    assert.equal(h.transports, 0, "安装不启动进程");
  } finally {
    await h.close();
  }
});

test("同名重复安装 → 409（避免工具命名空间互撞）", async () => {
  const h = await startMcpRuntime();
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    const again = await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    assert.equal(again.status, 409);
    const error = await json<{ error: { code: string } }>(again);
    assert.equal(error.error.code, "name_conflict");
  } finally {
    await h.close();
  }
});

test("安装写审计（含完整命令与风险确认原文）", async () => {
  const h = await startMcpRuntime();
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    const events = await json<{ events: Array<{ event_type: string; payload: Record<string, unknown> }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=100`),
    );
    const installed = events.events.find((event) => event.event_type === "mcp.server_installed");
    assert.ok(installed !== undefined);
    assert.equal(installed.payload.launch_command, "npx -y @mcp/server-filesystem /tmp");
    assert.equal(installed.payload.risk_acknowledged, true);
    assert.match(String(installed.payload.risk_ack_text), /不是沙箱/);
    assert.equal(installed.payload.enabled, false);
  } finally {
    await h.close();
  }
});

// --- 启用：启动 + 注册工具，但权限仍为空 --------------------------------------------

test("启用：启动进程、探测、注册工具为 capability，状态 running", async () => {
  const h = await startMcpRuntime({ tools: [{ name: "read_file" }, { name: "write_file" }] });
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    const res = await post(h.port, "/v1/mcp/servers/test-fs/enable");
    assert.equal(res.status, 200);
    const body = await json<{
      ok: boolean;
      server: {
        status: string;
        enabled: boolean;
        health: { tools_count: number; generation: string; protocol_version: string; server_name: string };
      };
    }>(res);
    assert.equal(body.ok, true);
    assert.equal(body.server.status, "running");
    assert.equal(body.server.enabled, true);
    assert.equal(body.server.health.tools_count, 2);
    assert.equal(body.server.health.generation, "discover", "双代际：优先 discover");
    assert.equal(body.server.health.protocol_version, "2026-07-28");
    assert.equal(body.server.health.server_name, "fake-server");
    assert.equal(h.transports, 1);

    // 工具确实注册成了 capability，且权限全空
    const caps = await json<{ capabilities: Array<{ name: string; status: string; manifest: { permissions: Record<string, string[]> } }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/capabilities`),
    );
    const names = caps.capabilities.map((capability) => capability.name);
    assert.ok(names.includes("mcp.test-fs.read_file"));
    assert.ok(names.includes("mcp.test-fs.write_file"));
    const readFile = caps.capabilities.find((capability) => capability.name === "mcp.test-fs.read_file");
    assert.ok(readFile !== undefined);
    assert.deepEqual(readFile.manifest.permissions.filesystem, [], "启用 server 不等于授权");
    assert.deepEqual(readFile.manifest.permissions.network, []);
  } finally {
    await h.close();
  }
});

test("启用失败（启动报错）→ 200 但 status=error 且带原因（不静默、不扔 500）", async () => {
  const h = await startMcpRuntime({ failStart: "spawn npx ENOENT" });
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    const res = await post(h.port, "/v1/mcp/servers/test-fs/enable");
    assert.equal(res.status, 200);
    const body = await json<{ ok: boolean; server: { status: string; health: { last_error: string } } }>(res);
    assert.equal(body.ok, false);
    assert.equal(body.server.status, "error");
    assert.match(body.server.health.last_error, /ENOENT/);
  } finally {
    await h.close();
  }
});

test("重复启用 → 409 already_enabled", async () => {
  const h = await startMcpRuntime();
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    await post(h.port, "/v1/mcp/servers/test-fs/enable");
    const again = await post(h.port, "/v1/mcp/servers/test-fs/enable");
    assert.equal(again.status, 409);
  } finally {
    await h.close();
  }
});

test("停用：状态回 disabled，工具 capability 被 disable（调用会被拒）", async () => {
  const h = await startMcpRuntime({ tools: [{ name: "read_file" }] });
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    await post(h.port, "/v1/mcp/servers/test-fs/enable");
    const res = await post(h.port, "/v1/mcp/servers/test-fs/disable");
    assert.equal(res.status, 200);
    const body = await json<{ server: { status: string; enabled: boolean } }>(res);
    assert.equal(body.server.status, "disabled");
    assert.equal(body.server.enabled, false);

    const caps = await json<{ capabilities: Array<{ name: string; status: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/capabilities`),
    );
    const tool = caps.capabilities.find((capability) => capability.name === "mcp.test-fs.read_file");
    assert.ok(tool !== undefined);
    assert.equal(tool.status, "disabled", "停用后工具不可调用");
  } finally {
    await h.close();
  }
});

// --- 权限 ---------------------------------------------------------------------------

test("PUT grants：可单独给某维度放行；未给的维度保持空", async () => {
  const h = await startMcpRuntime();
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    const res = await put(h.port, "/v1/mcp/servers/test-fs/grants", { grants: { network: ["api.example.com:443"] } });
    assert.equal(res.status, 200);
    const body = await json<{ server: { grants: Record<string, string[]> } }>(res);
    assert.deepEqual(body.server.grants.network, ["api.example.com:443"]);
    assert.deepEqual(body.server.grants.shell, []);
    assert.deepEqual(body.server.grants.filesystem, []);
  } finally {
    await h.close();
  }
});

test("PUT grants 写审计", async () => {
  const h = await startMcpRuntime();
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    await put(h.port, "/v1/mcp/servers/test-fs/grants", { grants: { shell: ["readonly"] } });
    const events = await json<{ events: Array<{ event_type: string; payload: Record<string, unknown> }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=100`),
    );
    const updated = events.events.find((event) => event.event_type === "mcp.server_grants_updated");
    assert.ok(updated !== undefined);
    assert.deepEqual((updated.payload.grants as Record<string, string[]>).shell, ["readonly"]);
  } finally {
    await h.close();
  }
});

// --- 卸载 ---------------------------------------------------------------------------

test("卸载：先停再删配置，审计保留", async () => {
  const h = await startMcpRuntime({ tools: [{ name: "read_file" }] });
  try {
    await post(h.port, "/v1/mcp/servers", { config: FS_CONFIG, risk_acknowledged: true });
    await post(h.port, "/v1/mcp/servers/test-fs/enable");
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/mcp/servers/test-fs`, { method: "DELETE" });
    assert.equal(res.status, 200);

    const list = await json<{ servers: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/mcp/servers`));
    assert.equal(list.servers.length, 0, "配置应被删除");

    const events = await json<{ events: Array<{ event_type: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=200`),
    );
    const types = events.events.map((event) => event.event_type);
    assert.ok(types.includes("mcp.server_removed"), "卸载要留审计");
    assert.ok(types.includes("mcp.server_installed"), "历史不能被抹掉");
  } finally {
    await h.close();
  }
});

test("卸载不存在的 server → 404", async () => {
  const h = await startMcpRuntime();
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/mcp/servers/nope`, { method: "DELETE" });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

// --- 已安装页视图 -------------------------------------------------------------------

test("GET servers：来源/状态/权限/健康一处齐全（FR-B6）", async () => {
  const h = await startMcpRuntime({ tools: [{ name: "echo" }] });
  try {
    await post(h.port, "/v1/mcp/servers", {
      config: FS_CONFIG,
      risk_acknowledged: true,
      source: "template",
    });
    const body = await json<{
      servers: Array<{
        source: string;
        status: string;
        launch_command: string;
        grants: Record<string, string[]>;
        health: { state: string; generation: string | null; tools_count: number };
      }>;
    }>(await fetch(`http://127.0.0.1:${h.port}/v1/mcp/servers`));
    const server = body.servers[0];
    assert.equal(server.source, "template", "来源要如实反映");
    assert.equal(server.status, "disabled");
    assert.ok(server.launch_command.length > 0);
    assert.deepEqual(server.grants.shell, []);
    assert.equal(server.health.state, "stopped");
    assert.equal(server.health.generation, null, "未启用时没有协议代际");
  } finally {
    await h.close();
  }
});

test("GET 单台不存在 → 404", async () => {
  const h = await startMcpRuntime();
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/mcp/servers/missing`);
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});
