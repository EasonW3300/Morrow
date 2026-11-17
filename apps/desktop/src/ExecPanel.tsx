import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ExecExecutedResponse, type ExecMode } from "./api.ts";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import {
  DEFAULT_EXEC_MODE,
  MODE_NOT_PERSISTED_HINT,
  SNAPSHOT_SCOPE_TEXT,
  deniedView,
  execResultSummary,
  modeLabel,
  modeSummary,
  modeSwitchWarning,
  pendingConfirmView,
  readonlyExemptHint,
  revertDisabledReason,
} from "./exec-ui.ts";

/**
 * 执行模式与脚本执行面板（票 M7-B-T6 / Issue #70，FR-B14/B15/B16）。
 *
 * 交互次序（与后端语义一一对应，不能简化）：
 *   1. 切换模式：切到「完全权限」先弹风险告知（危险命令仍被拒/快照/审计），
 *      确认后才 PUT。
 *   2. 提交脚本：202 → 展示**完整脚本**等确认；400 → 展示命中的危险规则（硬拒绝；
 *      没有"强行执行"按钮——那会绕过所有保护）。
 *   3. 执行完成后：结果摘要 + 撤销入口（无快照时禁用并说明原因）。
 *
 * 面板常驻"模式不持久化"与"快照范围"两条说明：这两件事最容易被误解成
 * "设置会留存"和"什么都能回滚"。
 */
export function ExecPanel({ base, sessionId }: { base: string; sessionId: string }) {
  const [mode, setMode] = useState<ExecMode>(DEFAULT_EXEC_MODE);
  const [readonlyConfirmed, setReadonlyConfirmed] = useState(false);
  const [script, setScript] = useState("");
  const [pending, setPending] = useState<{
    confirmationId: string;
    script: string;
    why: string;
    expiresAt: string;
  } | null>(null);
  const [denied, setDenied] = useState<Array<{ id: string; level: string; reason: string }> | null>(null);
  const [result, setResult] = useState<{
    summary: string;
    stdout: string;
    stderr: string;
    snapshotId: string | null;
    scopeNotice: string;
  } | null>(null);
  const [confirmingMode, setConfirmingMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadMode = useCallback(async () => {
    const state = await api.getExecMode(base, sessionId);
    setMode(state.mode);
    setReadonlyConfirmed(state.readonly_confirmed);
  }, [base, sessionId]);

  useEffect(() => {
    // 会话已关闭/未知时这里必然失败：面板保持默认态即可，不打扰用户
    void loadMode().catch(() => undefined);
  }, [loadMode]);

  async function applyMode(next: ExecMode) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setExecMode(base, sessionId, next);
      setMode(updated.mode);
      setConfirmingMode(false);
      setNotice(updated.changed ? `已切换为「${modeLabel(updated.mode)}」` : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function applyExecuted(outcome: ExecExecutedResponse) {
    setResult({
      summary: execResultSummary(outcome.result),
      stdout: outcome.result.stdout,
      stderr: outcome.result.stderr,
      snapshotId: outcome.snapshot_id,
      scopeNotice: outcome.scope_notice,
    });
  }

  async function submit() {
    if (script.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setDenied(null);
    setResult(null);
    try {
      const outcome = await api.submitExec(base, sessionId, script);
      if (outcome.status === "denied") {
        setDenied(outcome.hits);
      } else if (outcome.status === "needs_confirmation") {
        setPending({
          confirmationId: outcome.confirmation_id,
          script: outcome.script,
          why: outcome.why,
          expiresAt: outcome.expires_at,
        });
      } else {
        applyExecuted(outcome);
        await loadMode(); // 只读首次确认后 readonly_confirmed 会置位
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.approveExec(base, pending.confirmationId);
      applyExecuted(outcome);
      setPending(null);
      await loadMode();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revert() {
    if (result === null) return;
    setBusy(true);
    setError(null);
    try {
      const reverted = await api.revertExec(base, sessionId);
      setNotice(
        `已撤销到快照（还原 ${reverted.restored} 项，删除 ${reverted.removed} 项新增）`,
      );
      setResult(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const confirmView = pending === null ? null : pendingConfirmView({ script: pending.script, why: pending.why, mode });
  const deniedInfo = denied === null ? null : deniedView(denied);
  const readonlyHint = readonlyExemptHint({ mode, readonlyConfirmed });
  const revertReason = revertDisabledReason(result?.snapshotId ?? null);

  return (
    <GlassSurface variant="elevated" className="exec-panel">
      <header className="exec-panel__head">
        <h3>脚本执行</h3>
        <Badge tone={mode === "full_access" ? "warn" : "muted"}>{modeLabel(mode)}</Badge>
      </header>

      <p className="exec-panel__mode-summary">{modeSummary(mode)}</p>

      <div className="exec-panel__modes">
        <Button
          variant={mode === "confirm_each" ? "primary" : "ghost"}
          disabled={busy || mode === "confirm_each"}
          onClick={() => void applyMode("confirm_each")}
        >
          每次命令确认
        </Button>
        <Button
          variant={mode === "full_access" ? "primary" : "ghost"}
          disabled={busy || mode === "full_access"}
          onClick={() => setConfirmingMode(true)}
        >
          完全权限
        </Button>
      </div>

      {confirmingMode ? (
        <GlassSurface variant="clear" className="exec-panel__warning">
          {/* 风险告知必须先于切换：这是 Owner 做决定的唯一依据 */}
          <pre className="exec-panel__notice-text">{modeSwitchWarning("full_access")}</pre>
          <div className="exec-panel__actions">
            <Button variant="danger" disabled={busy} onClick={() => void applyMode("full_access")}>
              我已了解，启用完全权限
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmingMode(false)}>
              取消
            </Button>
          </div>
        </GlassSurface>
      ) : null}

      <p className="exec-panel__hint">{MODE_NOT_PERSISTED_HINT}</p>
      <p className="exec-panel__hint">{SNAPSHOT_SCOPE_TEXT}</p>
      {readonlyHint === null ? null : <p className="exec-panel__hint">{readonlyHint}</p>}

      <label className="exec-panel__label" htmlFor="exec-script">
        脚本
      </label>
      <textarea
        id="exec-script"
        className="exec-panel__input"
        rows={6}
        spellCheck={false}
        placeholder="例如：pnpm --filter @morrow/runtime test"
        value={script}
        onChange={(event) => setScript(event.target.value)}
      />
      <div className="exec-panel__actions">
        <Button variant="primary" disabled={busy || script.trim().length === 0} onClick={() => void submit()}>
          运行
        </Button>
      </div>

      {confirmView === null ? null : (
        <GlassSurface variant="clear" className="exec-panel__confirm">
          <h4>{confirmView.confirmLabel}</h4>
          <p className="exec-panel__hint">{confirmView.detail}</p>
          {/* 完整脚本：不做省略号截断（截断 = 让用户在信息不全时授权） */}
          <pre className="exec-panel__script">{confirmView.script}</pre>
          <p className="exec-panel__hint">
            确认有效至 {new Date(pending?.expiresAt ?? "").toLocaleTimeString()}，过期需重新发起。
          </p>
          <div className="exec-panel__actions">
            <Button variant="primary" disabled={busy} onClick={() => void approve()}>
              确认并执行
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              放弃
            </Button>
          </div>
        </GlassSurface>
      )}

      {deniedInfo === null ? null : (
        <GlassSurface variant="clear" className="exec-panel__denied">
          <h4>{deniedInfo.title}</h4>
          <ul>
            {deniedInfo.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {/* 没有"仍要执行"按钮：硬拒绝不可通过 UI 绕过 */}
          <p className="exec-panel__hint">
            这类命令即使处于完全权限也不会执行。请改写脚本，改用受支持的操作。
          </p>
        </GlassSurface>
      )}

      {result === null ? null : (
        <GlassSurface variant="clear" className="exec-panel__result">
          <h4>{result.summary}</h4>
          <p className="exec-panel__hint">{result.scopeNotice}</p>
          {result.stdout.length > 0 ? <pre className="exec-panel__output">{result.stdout}</pre> : null}
          {result.stderr.length > 0 ? (
            <pre className="exec-panel__output exec-panel__output--err">{result.stderr}</pre>
          ) : null}
          <div className="exec-panel__actions">
            <Button variant="ghost" disabled={busy || revertReason !== null} onClick={() => void revert()}>
              撤销本次改动
            </Button>
          </div>
          {revertReason === null ? null : <p className="exec-panel__hint">{revertReason}</p>}
        </GlassSurface>
      )}

      {notice === null ? null : <p className="exec-panel__notice">{notice}</p>}
      {error === null ? null : <p className="exec-panel__error">{error}</p>}
    </GlassSurface>
  );
}
