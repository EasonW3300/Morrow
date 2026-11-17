import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type McpServerRowView, type McpTemplateView } from "./api.ts";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
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

/**
 * MCP Server 安装与已安装页（票 M7-B-T2 / Issue #71，FR-B1..B6）。
 *
 * 页面结构（与票面「安装栏 + 已安装页」一致）：
 *   1. 安装栏：模板（点选只预填）→ 粘贴配置或命令 → 预览（无副作用）→ 勾选风险 → 安装
 *   2. 已安装列表：来源 / 状态 / 权限摘要 / 健康详情 + 启用/停用/卸载 + 授权编辑
 *
 * 风险确认是**勾选框**而不是弹窗里的"我知道了"——规格要求 Owner 主动勾选；
 * 勾选前安装按钮禁用（installDisabledReason 给原因，服务端另有 400 兜底）。
 */
export function McpInstallView({ base }: { base: string }) {
  const [templates, setTemplates] = useState<McpTemplateView[]>([]);
  const [servers, setServers] = useState<McpServerRowView[]>([]);
  const [mcpForm, setMcpForm] = useState({ displayName: "", launchCommand: "" });
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [preview, setPreview] = useState<{ launchCommand: string; extraCount: number; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [templateResult, serverResult] = await Promise.all([api.listMcpTemplates(base), api.listMcpServers(base)]);
    setTemplates(templateResult.templates);
    setServers(serverResult.servers);
  }, [base]);

  useEffect(() => {
    void refresh().catch((err: unknown) => {
      setError(err instanceof ApiError ? err.message : String(err));
    });
  }, [refresh]);

  function selectTemplate(template: McpTemplateView) {
    // 覆盖而非合并：上一份模板的参数不该残留
    setMcpForm(templateFill(template));
    setPreview(null);
    setNotice(`已填入「${template.label}」模板。请确认路径参数后再勾选风险确认并安装。`);
  }

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.previewMcp(
        base,
        mcpForm.launchCommand,
        mcpForm.displayName.trim().length === 0 ? undefined : mcpForm.displayName.trim(),
      );
      const fill = previewToFormFill(result);
      setPreview({ launchCommand: fill.launchCommand, extraCount: fill.extraCount, warnings: result.warnings });
      // 预览不改变已安装列表，但可以让表单显示"解析后的完整命令"
      if (fill.launchCommand.length > 0) setMcpForm((current) => ({ ...current, launchCommand: fill.launchCommand }));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.installMcpServer(base, {
        config: mcpForm.launchCommand,
        ...(mcpForm.displayName.trim().length === 0 ? {} : { displayName: mcpForm.displayName.trim() }),
        source: "manual",
      });
      const names = result.servers.map((server) => server.display_name).join(", ");
      setNotice(`已安装 ${names}（默认未启用）。启用前请先配置权限。`);
      setMcpForm({ displayName: "", launchCommand: "" });
      setRiskAcknowledged(false);
      setPreview(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(server: McpServerRowView) {
    setBusy(true);
    setError(null);
    try {
      if (server.enabled) {
        await api.disableMcpServer(base, server.server_id);
        setNotice(`已停用「${server.display_name}」，其工具不可再调用。`);
      } else {
        const result = await api.enableMcpServer(base, server.server_id);
        if (result.ok) setNotice(`「${server.display_name}」已启动，工具已注册（权限仍为空）。`);
        else setError(`「${server.display_name}」启动失败：${result.server.health.last_error ?? "未知原因"}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(server: McpServerRowView) {
    // 卸载是不可逆的配置删除：用 confirm 显式问一次
    if (!window.confirm(removeConfirmText(toRow(server)))) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeMcpServer(base, server.server_id);
      setNotice(`已卸载「${server.display_name}」（审计保留）。`);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  const disabledReason = installDisabledReason({
    config: mcpForm.launchCommand,
    riskAcknowledged,
    busy,
  });

  return (
    <div className="mcp-view">
      <GlassSurface variant="elevated" className="mcp-install">
        <header className="mcp-install__head">
          <h3>安装 MCP Server</h3>
        </header>

        <p className="mcp-install__hint">
          模板只填入表单，不会自动安装或授权。安装后默认<strong>未启用</strong>，需要你显式启用并授予权限。
        </p>

        <div className="mcp-install__templates">
          {templates.map((template) => (
            <Button key={template.id} variant="ghost" size="sm" disabled={busy} onClick={() => selectTemplate(template)}>
              {template.label}
            </Button>
          ))}
        </div>

        <label className="mcp-install__label" htmlFor="mcp-config">
          MCP 配置（JSON）或启动命令
        </label>
        <textarea
          id="mcp-config"
          className="mcp-install__input"
          rows={5}
          spellCheck={false}
          placeholder={'{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}}'}
          value={mcpForm.launchCommand}
          onChange={(event) => {
            setMcpForm((current) => ({ ...current, launchCommand: event.target.value }));
            setPreview(null);
          }}
        />

        <label className="mcp-install__label" htmlFor="mcp-name">
          显示名（可空，默认从命令推断）
        </label>
        <input
          id="mcp-name"
          className="mcp-install__input"
          value={mcpForm.displayName}
          onChange={(event) => setMcpForm((current) => ({ ...current, displayName: event.target.value }))}
        />

        <div className="mcp-install__actions">
          <Button variant="secondary" disabled={busy || mcpForm.launchCommand.trim().length === 0} onClick={() => void runPreview()}>
            预览
          </Button>
        </div>

        {preview === null ? null : (
          <GlassSurface variant="clear" className="mcp-install__preview">
            <h4>将要执行的完整命令</h4>
            {/* 完整命令：不截断（这是 Owner 唯一能审查的东西） */}
            <pre className="mcp-install__command">{preview.launchCommand}</pre>
            {extraServersHint(preview.extraCount) === null ? null : (
              <p className="mcp-install__hint">{extraServersHint(preview.extraCount)}</p>
            )}
            {preview.warnings.map((warning) => (
              <p key={warning} className="mcp-install__hint">
                {warning}
              </p>
            ))}
            <p className="mcp-install__hint">预览不会安装、不会启动进程。</p>
          </GlassSurface>
        )}

        <GlassSurface variant="clear" className="mcp-install__risk">
          <p className="mcp-install__risk-text">{MCP_RISK_TEXT_UI}</p>
          <label className="mcp-install__check">
            <input
              type="checkbox"
              checked={riskAcknowledged}
              onChange={(event) => setRiskAcknowledged(event.target.checked)}
            />
            我已了解上述风险，仍要安装
          </label>
        </GlassSurface>

        <div className="mcp-install__actions">
          <Button variant="primary" disabled={disabledReason !== null} onClick={() => void install()}>
            安装
          </Button>
        </div>
        {disabledReason === null ? null : <p className="mcp-install__hint">{disabledReason}</p>}
      </GlassSurface>

      <GlassSurface variant="elevated" className="mcp-list">
        <header className="mcp-list__head">
          <h3>已安装</h3>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
            刷新
          </Button>
        </header>
        {servers.length === 0 ? (
          <p className="mcp-install__hint">还没有安装任何 MCP Server。</p>
        ) : (
          <ul className="mcp-list__items">
            {servers.map((server) => {
              const badge = statusBadge(server.status, server.enabled);
              return (
                <li key={server.server_id} className="mcp-list__item">
                  <div className="mcp-list__item-head">
                    <strong>{server.display_name}</strong>
                    <Badge tone={badge.tone as never}>{badge.label}</Badge>
                    <Badge tone="dim">{sourceLabel(server.source)}</Badge>
                  </div>
                  <pre className="mcp-install__command">{server.launch_command}</pre>
                  <p className="mcp-install__hint">{grantsSummary(server.grants)}</p>
                  <p className="mcp-install__hint">{healthDetail(toRow(server))}</p>
                  <div className="mcp-install__actions">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void toggle(server)}>
                      {server.enabled ? "停用" : "启用"}
                    </Button>
                    <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove(server)}>
                      卸载
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </GlassSurface>

      {notice === null ? null : <p className="mcp-install__notice">{notice}</p>}
      {error === null ? null : <p className="mcp-install__error">{error}</p>}
    </div>
  );
}

/** 视图类型 → 纯逻辑模块的行类型（字段同名，显式转换避免 any） */
function toRow(server: McpServerRowView): McpServerRow {
  return server;
}
