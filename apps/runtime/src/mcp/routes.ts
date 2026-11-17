import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { MCP_TEMPLATES, MCP_RISK_ACK_TEXT, McpInstallInputError, formatCommandPreview, parseInstallInput, tokenizeCommand } from "./install.ts";
import { McpServerError, type McpServerService } from "./service.ts";
import type { McpServerGrants } from "./store.ts";

/**
 * MCP 控制面路由（票 M7-B-T2 / Issue #71，FR-B1..B6）：
 *
 *   GET    /v1/mcp/templates                 模板列表（**仅预填**；不含任何安装副作用）
 *   GET    /v1/mcp/risk-notice               风险确认文案 + 当前 must-ack 语义
 *   POST   /v1/mcp/preview                   纯解析预览：把输入解析成「将安装什么」，
 *                                            不落库、不启动（安装页的实时预览用）
 *   GET    /v1/mcp/servers                   已安装列表（来源/状态/权限/健康）
 *   POST   /v1/mcp/servers                   安装（**必须** risk_acknowledged=true）
 *   GET    /v1/mcp/servers/:id               单台详情
 *   DELETE /v1/mcp/servers/:id               卸载（先停再删配置，审计保留）
 *   POST   /v1/mcp/servers/:id/enable        启用（启动 + 探测 + 注册工具）
 *   POST   /v1/mcp/servers/:id/disable       停用（关进程 + 禁用工具）
 *   PUT    /v1/mcp/servers/:id/grants        更新该 server 的五维权限
 *
 * `/preview` 独立存在的原因：安装页要在 Owner 勾选风险确认**之前**就展示"将要执行
 * 什么"。如果预览必须走安装端点，就只能靠"试装一下"来预览——那正好绕过了风险门槛。
 */
export interface McpRoute {
  method: string;
  re: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: McpRouteContext,
    params: string[],
  ) => void | Promise<void>;
}

export interface McpRouteContext {
  mcp: McpServerService;
}

export const mcpRoutes: McpRoute[] = [
  { method: "GET", re: /^\/v1\/mcp\/templates$/, handler: handleTemplates },
  { method: "GET", re: /^\/v1\/mcp\/risk-notice$/, handler: handleRiskNotice },
  { method: "POST", re: /^\/v1\/mcp\/preview$/, handler: handlePreview },
  { method: "GET", re: /^\/v1\/mcp\/servers$/, handler: handleList },
  { method: "POST", re: /^\/v1\/mcp\/servers$/, handler: handleInstall },
  { method: "GET", re: /^\/v1\/mcp\/servers\/([^/]+)$/, handler: handleGet },
  { method: "DELETE", re: /^\/v1\/mcp\/servers\/([^/]+)$/, handler: handleRemove },
  { method: "POST", re: /^\/v1\/mcp\/servers\/([^/]+)\/enable$/, handler: handleEnable },
  { method: "POST", re: /^\/v1\/mcp\/servers\/([^/]+)\/disable$/, handler: handleDisable },
  { method: "PUT", re: /^\/v1\/mcp\/servers\/([^/]+)\/grants$/, handler: handleGrants },
];

function handleTemplates(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  _ctx: McpRouteContext,
): void {
  sendJson(res, 200, {
    templates: MCP_TEMPLATES.map((template) => ({
      ...template,
      // 模板的完整命令（同样不截断：UI 直接展示）
      launch_command: formatCommandPreview(template.command, template.args),
    })),
    // 明确：模板不产生安装、不产生授权
    installs_on_select: false,
  });
}

function handleRiskNotice(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  _ctx: McpRouteContext,
): void {
  sendJson(res, 200, {
    // 文案单源在 install.ts，UI 与审计共用同一段文字
    risk_notice: MCP_RISK_ACK_TEXT,
    /** 必须显式传 risk_acknowledged=true；省略或 false 一律拒绝安装 */
    requires_explicit_acknowledgment: true,
  });
}

async function handlePreview(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  _ctx: McpRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const raw = body.config ?? body.raw ?? body.command;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    sendError(res, 400, "invalid_body", "provide the MCP config as `config` (JSON text or launch command string)");
    return;
  }
  try {
    const parsed = parseInstallInput(raw, {
      ...(typeof body.display_name === "string" ? { displayName: body.display_name } : {}),
      ...(typeof body.source === "string" ? { source: body.source as never } : {}),
    });
    sendJson(res, 200, {
      // 读取既有 server 的 tokenizer 逻辑保证"预览的命令"和"将执行的 argv"同源
      servers: parsed.drafts.map((draft) => ({
        display_name: draft.display_name,
        command: draft.command,
        args: draft.args,
        env_keys: draft.env_keys,
        cwd: draft.cwd,
        source: draft.source,
        /** 完整未截断的启动命令（预览与安装页展示同一份） */
        launch_command: formatCommandPreview(draft.command, draft.args),
        /** 分词结果，供 UI 在需要时逐参展开（与 launch_command 一致） */
        tokens: tokenizeCommand(formatCommandPreview(draft.command, draft.args)),
      })),
      warnings: parsed.warnings,
      /** 预览不落库 */
      installed: false,
    });
  } catch (error) {
    sendMcpError(res, error);
  }
}

function handleList(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: McpRouteContext): void {
  sendJson(res, 200, { servers: ctx.mcp.list() });
}

async function handleInstall(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: McpRouteContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const raw = body.config ?? body.raw ?? body.command;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    sendError(res, 400, "invalid_body", "provide the MCP config as `config` (JSON text or launch command string)");
    return;
  }
  try {
    const result = ctx.mcp.install({
      raw,
      riskAcknowledged: body.risk_acknowledged,
      ...(typeof body.display_name === "string" ? { displayName: body.display_name } : {}),
      ...(typeof body.source === "string" ? { source: body.source as never } : {}),
    });
    sendJson(res, 201, {
      servers: result.servers,
      warnings: result.warnings,
      event_ids: result.event_ids,
      // 显式回传默认态：安装不等于启用
      enabled: false,
    });
  } catch (error) {
    sendMcpError(res, error);
  }
}

function handleGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: McpRouteContext,
  params: string[],
): void {
  const view = ctx.mcp.get(params[0]);
  if (view === null) {
    sendError(res, 404, "not_found", `MCP server ${params[0]} is not installed`);
    return;
  }
  sendJson(res, 200, { server: view });
}

async function handleEnable(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: McpRouteContext,
  params: string[],
): Promise<void> {
  try {
    const view = await ctx.mcp.enable(params[0]);
    // 启动失败也是 200（配置确实被启用了，只是运行时 error）；status 字段携带真相，
    // 让 UI 能同时展示"已启用"与"启动失败原因"，而不是只看到 500。
    sendJson(res, 200, { server: view, ok: view.status === "running" });
  } catch (error) {
    sendMcpError(res, error);
  }
}

async function handleDisable(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: McpRouteContext,
  params: string[],
): Promise<void> {
  try {
    sendJson(res, 200, { server: await ctx.mcp.disable(params[0]) });
  } catch (error) {
    sendMcpError(res, error);
  }
}

async function handleRemove(
  _req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: McpRouteContext,
  params: string[],
): Promise<void> {
  try {
    const result = await ctx.mcp.remove(params[0]);
    if (!result.removed) {
      sendError(res, 404, "not_found", `MCP server ${params[0]} is not installed`);
      return;
    }
    sendJson(res, 200, { removed: true, event_id: result.event_id });
  } catch (error) {
    sendMcpError(res, error);
  }
}

async function handleGrants(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: McpRouteContext,
  params: string[],
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const grants = body.grants ?? body;
  if (typeof grants !== "object" || grants === null || Array.isArray(grants)) {
    sendError(res, 400, "invalid_body", "grants must be an object with filesystem/network/shell/channels/credentials arrays");
    return;
  }
  try {
    const result = ctx.mcp.updateGrants(params[0], grants as Partial<McpServerGrants>);
    sendJson(res, 200, { server: result.view, event_id: result.event_id });
  } catch (error) {
    sendMcpError(res, error);
  }
}

/** McpServerError → HTTP 信封（状态码按语义映射，不是一律 400） */
function sendMcpError(res: ServerResponse, error: unknown): void {
  // install.ts 抛的 McpInstallInputError 会从 preview 直接冒上来，需要同一套映射
  // （早先只认 McpServerError，导致"未勾选风险确认"变成 500）。
  if (error instanceof McpInstallInputError) {
    const status = error.code === "risk_not_acknowledged" ? 400 : 400;
    sendError(res, status, error.code, error.message);
    return;
  }
  if (error instanceof McpServerError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "name_conflict" || error.code === "already_enabled"
          ? 409
          : error.code === "risk_not_acknowledged"
            ? 400
            : error.code === "capability_registration_failed"
              ? 500
              : 400;
    sendError(res, status, error.code, error.message);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendError(res, 500, "internal_error", message);
}
