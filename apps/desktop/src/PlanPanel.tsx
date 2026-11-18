import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import { PLAN_CHOICES, PLAN_PHASE_LABELS, PLAN_READONLY_NOTE, planBadge, planParseFailureHint, type PlanPhase } from "./automation-ui.ts";

/**
 * Plan 模式面板（票 M7-C / #77；UI 由 C8 补齐）。
 *
 * 只读徽标常驻：Owner 必须一眼看出"它现在不会改我的文件"。
 * 三种实现选择来自 `/plan/decision`（后端已实现，本面板只做呈现）。
 */
export function PlanPanel({ base, sessionId }: { base: string; sessionId: string }) {
  const [state, setState] = useState<{ active: boolean; phase: string | null }>({ active: false, phase: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await api.getPlanState(base, sessionId);
    setState({ active: result.active, phase: result.phase });
  }, [base, sessionId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  async function toggle(action: "enter" | "exit") {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setPlanMode(base, sessionId, action);
      setState({ active: result.active, phase: result.phase ?? null });
      setNotice(action === "enter" ? "已进入计划模式（只读）。" : "已退出计划模式。");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setPhase(phase: string) {
    setBusy(true);
    setError(null);
    try {
      await api.setPlanPhase(base, sessionId, phase);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "implement" | "implement_clean" | "continue") {
    setBusy(true);
    setError(null);
    setParseError(null);
    try {
      const result = await api.decidePlan(base, sessionId, decision);
      if (result.parse_error !== undefined) {
        setParseError(planParseFailureHint(result.parse_error.reason, result.parse_error.detail));
      } else if (decision === "continue") {
        setNotice("继续规划。");
      } else if (decision === "implement_clean") {
        setNotice(`已生成「清空上下文后实现」的提示词（${result.clean_context_prompt?.length ?? 0} 字符）。`);
      } else {
        setNotice("已批准，按计划实现。");
      }
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  const badge = planBadge(state.active, state.phase);

  return (
    <GlassSurface variant="elevated" className="exec-panel">
      <header className="exec-panel__head">
        <h3>计划模式</h3>
        {badge === null ? null : <Badge tone={badge.tone as never}>{badge.label}</Badge>}
      </header>
      <p className="exec-panel__hint">{PLAN_READONLY_NOTE}</p>

      <div className="exec-panel__actions">
        <Button
          variant={state.active ? "ghost" : "primary"}
          disabled={busy}
          onClick={() => void toggle(state.active ? "exit" : "enter")}
        >
          {state.active ? "退出计划模式" : "进入计划模式"}
        </Button>
      </div>

      {state.active ? (
        <>
          <div className="exec-panel__actions">
            {(["explore", "clarify", "detail"] as PlanPhase[]).map((phase) => (
              <Button
                key={phase}
                size="sm"
                variant={state.phase === phase ? "primary" : "ghost"}
                disabled={busy}
                onClick={() => void setPhase(phase)}
              >
                {PLAN_PHASE_LABELS[phase]}
              </Button>
            ))}
          </div>
          <h4>计划产出后</h4>
          <div className="exec-panel__actions">
            {PLAN_CHOICES.map((choice) => (
              <Button
                key={choice.decision}
                size="sm"
                variant={choice.decision === "implement" ? "primary" : "secondary"}
                disabled={busy}
                title={choice.detail}
                onClick={() => void decide(choice.decision)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </>
      ) : null}

      {parseError === null ? null : <p className="exec-panel__error">{parseError}</p>}
      {notice === null ? null : <p className="exec-panel__notice">{notice}</p>}
      {error === null ? null : <p className="exec-panel__error">{error}</p>}
    </GlassSurface>
  );
}
