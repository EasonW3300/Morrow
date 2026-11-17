/**
 * MCP 安装与已安装页的纯逻辑（票 M7-B-T2 / Issue #71）。
 *
 * 三条不可退让的 UI 纪律，全部在这里可单测：
 *   1. **风险确认未勾选时安装按钮必须禁用**（服务端也会拒绝，这里是双保险 + 明确提示）；
 *   2. **启动命令永远完整展示**，不做省略号截断——它是 Owner 唯一能审查的东西；
 *   3. **模板只是预填**，选中后必须仍然走"勾选风险 + 点安装"，不能一键装；
 *      并且切换模板要覆盖表单而不保留上一个模板的残留参数。
 */

/** 已安装列表行的视图模型 */
export interface McpServerRow {
  server_id: string;
  display_name: string;
  source: string;
  /** 完整启动命令（不截断） */
  launch_command: string;
  enabled: boolean;
  status: string;
  grants: Record<string, string[]>;
  health: {
    state: string;
    last_error: string | null;
    restarts: number;
    generation: string | null;
    protocol_version: string | null;
    server_name: string | null;
    server_version: string | null;
    unsupported_capabilities: string[];
    tools_count: number;
  };
}

/** 来源标签（「已安装」页一眼看出从哪来的） */
export function sourceLabel(source: string): string {
  switch (source) {
    case "npm":
      return "npm";
    case "document":
      return "文档";
    case "builtin":
      return "内置";
    case "template":
      return "模板";
    case "manual":
      return "MCP";
    default:
      return source;
  }
}

/** 状态徽标：tone + 文案 */
export function statusBadge(status: string, enabled: boolean): { tone: string; label: string } {
  if (!enabled) return { tone: "muted", label: "未启用" };
  switch (status) {
    case "running":
      return { tone: "ok", label: "运行中" };
    case "degraded":
      return { tone: "warn", label: "降级" };
    case "error":
      return { tone: "error", label: "启动失败" };
    case "disabled":
      return { tone: "muted", label: "未启用" };
    default:
      return { tone: "idle", label: status };
  }
}

/** 权限摘要：只列非空维度；全空时给出明确说明（比空列表更有信息量） */
export function grantsSummary(grants: Record<string, string[]>): string {
  const labels: Record<string, string> = {
    filesystem: "文件系统",
    network: "网络",
    shell: "Shell",
    channels: "渠道",
    credentials: "凭据",
  };
  const parts: string[] = [];
  for (const [dimension, label] of Object.entries(labels)) {
    const values = grants[dimension] ?? [];
    if (values.length > 0) parts.push(`${label}: ${values.join(", ")}`);
  }
  return parts.length === 0 ? "未授予任何权限（工具调用会被拒绝）" : parts.join(" · ");
}

/** 健康详情（degraded/error 时必须能解释原因） */
export function healthDetail(server: McpServerRow): string {
  const parts: string[] = [];
  if (server.health.generation !== null) {
    parts.push(`${server.health.generation} / ${server.health.protocol_version ?? "unknown"}`);
  }
  if (server.health.server_name !== null) {
    parts.push(`${server.health.server_name}${server.health.server_version === null ? "" : ` v${server.health.server_version}`}`);
  }
  parts.push(`工具 ${server.health.tools_count} 个`);
  if (server.health.restarts > 0) parts.push(`已重启 ${server.health.restarts} 次`);
  if (server.health.unsupported_capabilities.length > 0) {
    parts.push(`不支持: ${server.health.unsupported_capabilities.join(", ")}`);
  }
  if (server.health.last_error !== null) {
    // 错误放在最后并显式标注，避免被前面的正常信息淹没
    parts.push(`原因: ${server.health.last_error}`);
  }
  return parts.join(" · ");
}

/** 安装按钮的禁用原因（null = 可点） */
export function installDisabledReason(input: {
  config: string;
  riskAcknowledged: boolean;
  busy: boolean;
}): string | null {
  if (input.busy) return "正在安装…";
  if (input.config.trim().length === 0) return "请粘贴 MCP 配置或启动命令";
  if (!input.riskAcknowledged) {
    // 文案点明"这是硬要求"，避免用户以为按钮是灰的不好使
    return "安装前必须勾选确认：该 Server 拥有与 Morrow 同等的宿主权限";
  }
  return null;
}

/** 风险确认文案（与服务端 MCP_RISK_ACK_TEXT 同义；UI 侧先告知） */
export const MCP_RISK_TEXT_UI =
  "该 MCP Server 作为普通宿主进程运行，拥有与 Morrow 同等的宿主权限——" +
  "它可以读写宿主机上 Morrow 能访问的文件、可以出网、可以执行命令。" +
  "它不是沙箱，Morrow 无法限制它的实际行为。";

/**
 * 预览结果 → 表单填充值。
 *
 * JSON 可能带多台 server，但安装栏一次只装一台：取第一台并提示其余（不做静默丢弃）。
 */
export function previewToFormFill(preview: {
  servers: Array<{ display_name: string; command: string; args: string[]; launch_command: string }>;
}): { displayName: string; launchCommand: string; extraCount: number } {
  const first = preview.servers[0];
  if (first === undefined) return { displayName: "", launchCommand: "", extraCount: 0 };
  return {
    displayName: first.display_name,
    launchCommand: first.launch_command,
    extraCount: Math.max(0, preview.servers.length - 1),
  };
}

/** 多台 server 的提示文案（null = 无需提示） */
export function extraServersHint(extraCount: number): string | null {
  if (extraCount <= 0) return null;
  return `该配置包含 ${extraCount + 1} 台 Server，本次只安装第一台。其余请分别粘贴安装。`;
}

/** 模板选中后的表单值（**覆盖**而非合并：避免上一份参数残留） */
export function templateFill(template: { command: string; args: string[]; id: string }): {
  displayName: string;
  launchCommand: string;
} {
  const quote = (value: string): string => {
    if (value.length === 0) return "''";
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
  };
  return {
    displayName: template.id,
    launchCommand: [template.command, ...template.args].map(quote).join(" "),
  };
}

/** 卸载确认文案（写明审计会保留） */
export function removeConfirmText(server: McpServerRow): string {
  return `卸载「${server.display_name}」会停止其进程并删除配置；安装与调用审计会保留，不会从账本中抹除。`;
}
