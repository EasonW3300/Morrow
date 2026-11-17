// MCP 工具映射与 stdio 传输测试（票 M7-B-T1 / Issue #67）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpCapabilityName, mcpToolToManifest, mcpToolsToManifests } from "../src/mcp/tools.ts";
import { createStdioTransport } from "../src/mcp/stdio-transport.ts";
import { McpClient } from "../src/mcp/client.ts";
import { removeDir, tmpDir } from "./helpers.ts";

// --- 工具映射 -----------------------------------------------------------------------

test("mcpCapabilityName：带命名空间，大写与特殊字符安全化", () => {
  assert.equal(mcpCapabilityName("fs", "read_file"), "mcp.fs.read_file", "下划线属于允许字符，保留");
  assert.equal(mcpCapabilityName("My Server", "Read.File!"), "mcp.my-server.read-file", "空格与点号转连字符");
  assert.equal(mcpCapabilityName("", ""), "mcp.server.tool", "空值有兜底");
});

test("不同 server 的同名工具不会互撞", () => {
  const a = mcpCapabilityName("server-a", "read");
  const b = mcpCapabilityName("server-b", "read");
  assert.notEqual(a, b);
  assert.ok(a.endsWith(".read") && b.endsWith(".read"));
});

test("mcpToolToManifest：sandbox 标 process 而非 container（不谎称有隔离）", () => {
  const manifest = mcpToolToManifest("fs", { name: "read_file", description: "读文件" });
  assert.equal(manifest.sandbox.type, "process");
  assert.equal(manifest.sandbox.network, "none");
  assert.equal(manifest.sandbox.filesystem, "none");
  assert.equal(manifest.author, "human");
});

test("mcpToolToManifest：默认权限全空（装 server 不等于全权）", () => {
  const manifest = mcpToolToManifest("fs", { name: "x" });
  assert.deepEqual(manifest.permissions.filesystem, []);
  assert.deepEqual(manifest.permissions.network, []);
  assert.deepEqual(manifest.permissions.shell, []);
  assert.deepEqual(manifest.permissions.channels, []);
  assert.deepEqual(manifest.permissions.credentials, []);
});

test("mcpToolToManifest：透传 inputSchema；缺失时给空对象 schema", () => {
  const withSchema = mcpToolToManifest("s", { name: "x", inputSchema: { type: "object", required: ["a"] } });
  assert.deepEqual(withSchema.input_schema, { type: "object", required: ["a"] });
  const without = mcpToolToManifest("s", { name: "x" });
  assert.deepEqual(without.input_schema, { type: "object" });
});

test("mcpToolsToManifests：保持 server 的 tools/list 顺序", () => {
  const manifests = mcpToolsToManifests("fs", [{ name: "b" }, { name: "a" }]);
  assert.deepEqual(manifests.map((m) => m.name), ["mcp.fs.b", "mcp.fs.a"]);
});

// --- stdin/stdout 传输（用真实的 node 子进程当假 MCP server）--------------------------

/** 造一个极小的 MCP server 脚本（NDJSON），可指定行为 */
function makeServerScript(root: string, body: string): string {
  const dir = join(root, "server");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "server.mjs");
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

/** 现代 server：响应 discover + tools/list + tools/call */
const MODERN_SERVER = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue; // 通知：不响应
    const reply = (result, error) => {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) }) + "\\n");
    };
    if (message.method === "server/discover") {
      reply({ protocolVersion: "2026-07-28", serverInfo: { name: "echo", version: "1.0.0" }, capabilities: { tools: {} } });
    } else if (message.method === "tools/list") {
      reply({ tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }] });
    } else if (message.method === "tools/call") {
      reply({ content: [{ type: "text", text: "echo:" + JSON.stringify(message.params.arguments ?? {}) }] });
    } else {
      reply(undefined, { code: -32601, message: "Method not found" });
    }
  }
});
`;

test("stdio 端到端：真实子进程完成 discover → tools/list → tools/call", async () => {
  const root = tmpDir("morrow-mcp-stdio-");
  try {
    const script = makeServerScript(root, MODERN_SERVER);
    const client = new McpClient({
      transportFactory: () => createStdioTransport({ command: process.execPath, args: [script] }),
      requestTimeoutMs: 5_000,
    });
    await client.ensureReady();
    assert.equal(client.probeResult?.generation, "discover");
    assert.equal(client.probeResult?.serverInfo.name, "echo");

    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["echo"]);

    const outcome = await client.callTool("echo", { hello: "world" });
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /echo:/);
    assert.match(outcome.text, /hello/);

    await client.close();
  } finally {
    removeDir(root);
  }
});

test("stdio：split 跨 chunk 的半行能正确重组（NDJSON 缓冲）", async () => {
  const root = tmpDir("morrow-mcp-chunk-");
  try {
    // server 故意把一行 JSON 拆成两次 write，验证传输层按行缓冲
    const script = makeServerScript(
      root,
      `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: message.method === "server/discover"
        ? { protocolVersion: "2026-07-28", capabilities: { tools: {} } }
        : { tools: [] },
    });
    // 拆成两半写，中间留一个 tick
    const half = Math.floor(payload.length / 2);
    process.stdout.write(payload.slice(0, half));
    setTimeout(() => process.stdout.write(payload.slice(half) + "\\n"), 10);
  }
});
`,
    );
    const client = new McpClient({
      transportFactory: () => createStdioTransport({ command: process.execPath, args: [script] }),
      requestTimeoutMs: 5_000,
    });
    await client.ensureReady();
    assert.equal(client.probeResult?.generation, "discover");
    await client.close();
  } finally {
    removeDir(root);
  }
});

test("stdio：server 立刻退出 → 请求以 transport closed 失败（不挂死）", async () => {
  const root = tmpDir("morrow-mcp-exit-");
  try {
    const script = makeServerScript(root, "process.exit(1);\n");
    const client = new McpClient({
      transportFactory: () => createStdioTransport({ command: process.execPath, args: [script] }),
      requestTimeoutMs: 3_000,
    });
    await assert.rejects(() => client.ensureReady());
    assert.equal(client.state, "degraded");
  } finally {
    removeDir(root);
  }
});

test("stdio：close 会杀掉子进程（不留僵尸）", async () => {
  const root = tmpDir("morrow-mcp-close-");
  try {
    const script = makeServerScript(root, MODERN_SERVER);
    const transport = createStdioTransport({ command: process.execPath, args: [script] });
    await transport.start();
    assert.equal(transport.isOpen(), true);
    await transport.close();
    assert.equal(transport.isOpen(), false);
  } finally {
    removeDir(root);
  }
});
