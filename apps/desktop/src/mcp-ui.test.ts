// MCP UI 纯逻辑测试（票 M7-B-T2 / Issue #71）。
//
// 重点：风险未确认时按钮必须禁用、命令不截断、模板只是预填、状态/权限/健康
// 三类信息都能解释清楚。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_RISK_TEXT_UI,
  extraServersHint,
  grantsSummary,
  healthDetail,
  installDisabledReason,
  previewToFormFill,
  removeConfirmText,
  sourceLabel,
  statusBadge,
  templateFill,
  type McpServerRow,
} from "./mcp-ui.ts";

function row(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    server_id: "fs",
    display_name: "fs",
    source: "manual",
    launch_command: "npx -y @mcp/fs /tmp",
    enabled: false,
    status: "disabled",
    grants: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    health: {
      state: "stopped",
      last_error: null,
      restarts: 0,
      generation: null,
      protocol_version: null,
      server_name: null,
      server_version: null,
      unsupported_capabilities: [],
      tools_count: 0,
    },
    ...overrides,
  };
}

// --- 安装门 -------------------------------------------------------------------------

test("未勾选风险确认 → 安装按钮禁用且原因明确", () => {
  const reason = installDisabledReason({ config: "npx x", riskAcknowledged: false, busy: false });
  assert.notEqual(reason, null);
  assert.match(reason ?? "", /必须勾选/);
  assert.match(reason ?? "", /宿主权限/);
});

test("空配置 → 禁用；已勾选且非空 → 可点", () => {
  assert.notEqual(installDisabledReason({ config: "   ", riskAcknowledged: true, busy: false }), null);
  assert.equal(installDisabledReason({ config: "npx x", riskAcknowledged: true, busy: false }), null);
});

test("安装中禁用（防重复提交）", () => {
  assert.match(
    installDisabledReason({ config: "npx x", riskAcknowledged: true, busy: true }) ?? "",
    /正在安装/,
  );
});

test("风险文案写明「不是沙箱」，不得宣称隔离", () => {
  assert.match(MCP_RISK_TEXT_UI, /不是沙箱/);
  assert.match(MCP_RISK_TEXT_UI, /宿主权限/);
  assert.equal(/已隔离|完全隔离/.test(MCP_RISK_TEXT_UI), false);
});

// --- 命令展示 -----------------------------------------------------------------------

test("完整命令原样进入表单（不截断长参数）", () => {
  const long = "x".repeat(3000);
  const fill = previewToFormFill({
    servers: [{ display_name: "s", command: "cmd", args: [long], launch_command: `cmd ${long}` }],
  });
  assert.equal(fill.launchCommand.includes(long), true, "展示命令不得截断");
});

test("多台配置：只填第一台，并提示其余数量", () => {
  const fill = previewToFormFill({
    servers: [
      { display_name: "a", command: "x", args: [], launch_command: "x" },
      { display_name: "b", command: "y", args: [], launch_command: "y" },
    ],
  });
  assert.equal(fill.displayName, "a");
  assert.equal(fill.extraCount, 1);
  assert.match(extraServersHint(fill.extraCount) ?? "", /2 台 Server/);
});

test("空预览不崩，且不提示多余 server", () => {
  const fill = previewToFormFill({ servers: [] });
  assert.equal(fill.launchCommand, "");
  assert.equal(extraServersHint(0), null);
});

// --- 模板 ---------------------------------------------------------------------------

test("模板填充覆盖旧值（不残留上一个模板的参数）", () => {
  const filesystem = templateFill({
    id: "filesystem",
    command: "npx",
    args: ["-y", "@mcp/server-filesystem", "/path/to/dir"],
  });
  assert.equal(filesystem.displayName, "filesystem");
  assert.equal(filesystem.launchCommand, "npx -y @mcp/server-filesystem /path/to/dir");

  const git = templateFill({ id: "git", command: "npx", args: ["-y", "@mcp/git"] });
  assert.equal(git.launchCommand, "npx -y @mcp/git");
  assert.equal(git.launchCommand.includes("filesystem"), false, "不该残留上一个模板的参数");
});

test("模板命令含空格参数时加引号（可原样粘贴核对）", () => {
  const fill = templateFill({ id: "x", command: "node", args: ["/path with space/s.js"] });
  assert.equal(fill.launchCommand, "node '/path with space/s.js'");
});

// --- 已安装页 -----------------------------------------------------------------------

test("来源标签覆盖 npm/文档/内置/模板/MCP", () => {
  assert.equal(sourceLabel("npm"), "npm");
  assert.equal(sourceLabel("document"), "文档");
  assert.equal(sourceLabel("builtin"), "内置");
  assert.equal(sourceLabel("template"), "模板");
  assert.equal(sourceLabel("manual"), "MCP");
});

test("状态徽标：未启用/运行中/降级/启动失败各有 tone", () => {
  assert.equal(statusBadge("disabled", false).label, "未启用");
  assert.equal(statusBadge("running", true).tone, "ok");
  assert.equal(statusBadge("degraded", true).tone, "warn");
  assert.equal(statusBadge("error", true).tone, "error");
});

test("权限摘要：全空时明确说明「调用会被拒绝」，不是空白", () => {
  const summary = grantsSummary({ filesystem: [], network: [], shell: [], channels: [], credentials: [] });
  assert.match(summary, /未授予任何权限/);
  assert.match(summary, /拒绝/);
});

test("权限摘要：只列非空维度", () => {
  const summary = grantsSummary({
    filesystem: ["/tmp/**"],
    network: [],
    shell: ["readonly"],
    channels: [],
    credentials: [],
  });
  assert.match(summary, /文件系统: \/tmp\/\*\*/);
  assert.match(summary, /Shell: readonly/);
  assert.equal(summary.includes("网络"), false, "空维度不该出现");
});

test("健康详情：degraded 时带原因与重启次数", () => {
  const detail = healthDetail(
    row({
      enabled: true,
      status: "degraded",
      health: {
        state: "degraded",
        last_error: "MCP server crashed 3 times",
        restarts: 3,
        generation: "discover",
        protocol_version: "2026-07-28",
        server_name: "fs",
        server_version: "1.0.0",
        unsupported_capabilities: ["resources"],
        tools_count: 2,
      },
    }),
  );
  assert.match(detail, /discover \/ 2026-07-28/);
  assert.match(detail, /fs v1\.0\.0/);
  assert.match(detail, /工具 2 个/);
  assert.match(detail, /已重启 3 次/);
  assert.match(detail, /不支持: resources/);
  assert.match(detail, /原因: MCP server crashed 3 times/);
});

test("健康详情：正常状态下不出现「原因:」噪音", () => {
  const detail = healthDetail(
    row({
      enabled: true,
      status: "running",
      health: {
        state: "ready",
        last_error: null,
        restarts: 0,
        generation: "initialize",
        protocol_version: "2025-11-25",
        server_name: "ok",
        server_version: null,
        unsupported_capabilities: [],
        tools_count: 1,
      },
    }),
  );
  assert.equal(detail.includes("原因:"), false);
  assert.match(detail, /initialize/);
});

test("卸载确认文案写明审计会保留", () => {
  const text = removeConfirmText(row({ display_name: "我的服务" }));
  assert.match(text, /我的服务/);
  assert.match(text, /审计会保留/);
  assert.match(text, /不会从账本中抹除/);
});
