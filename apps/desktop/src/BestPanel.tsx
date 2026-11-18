import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type BestRunView } from "./api.ts";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import {
  IMPLEMENT_GATE_UI_NOTICE,
  SPEC_GATE_NOTICE,
  artifactsSummary,
  bestStageProgress,
  implementGateDisabledReason,
  pushConfirmText,
} from "./automation-ui.ts";

/**
 * Best 模式面板（票 M7-C / #80-81；UI 由 C8 补齐）。
 *
 * 两类门在这里呈现，且**实现门的文案明说完全权限不能跳**——这是 Owner 最需要的
 * 保证，不能只写在文档里。
 */
export function BestPanel({ base, sessionId }: { base: string; sessionId: string }) {
  const [run, setRun] = useState<BestRunView | null>(null);
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [pushPlan, setPushPlan] = useState<{ branch: string; commands: string[]; notice: string } | null>(null);

  const refresh = useCallback(async (bestId: string) => {
    const result = await api.getBest(base, bestId);
    setRun(result.run);
  }, [base]);

  useEffect(() => {
    // 进入面板时尝试取该会话最近一次 best（列表接口按会话过滤）
    void (async () => {
      try {
        const started = await api.listGoals(base, sessionId); // 复用列表调用做可达性探测
        void started;
      } catch {
        // 探测失败不打扰
      }
    })();
  }, [base, sessionId]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.startBest(base, { sessionId, idea: idea.trim() });
      setRun(result.run);
      setNotice("已进入访谈阶段：逐轮提问，每题都会给出推荐答案。");
      setIdea("");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function gate(decision: "approve" | "reject") {
    if (run === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.decideBestSpecGate(base, run.best_id, decision);
      setRun(result.run);
      setNotice(decision === "approve" ? "规格已确认，开始拆票（不设确认门）。" : "规格被拒：停在规格阶段，可编辑后重提。");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function approveImplement() {
    if (run === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.approveBestImplementGate(base, run.best_id);
      setRun(result.run);
      setApproved(true);
      setNotice("已通过实现门。点「开始实现」将创建分支并展开任务。");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startImplement() {
    if (run === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.startBestImplement(base, run.best_id);
      setRun(result.run);
      setNotice(`已开始实现：分支 ${result.branch}。提交只留在本地，未推送。`);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadPushPlan() {
    if (run === null) return;
    setBusy(true);
    setError(null);
    try {
      setPushPlan(await api.bestPushPlan(base, run.best_id));
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  const progress = run === null ? [] : bestStageProgress(run.stage as never);
  const gateDisabled = implementGateDisabledReason({ stage: run?.stage ?? "", approved, busy });

  return (
    <GlassSurface variant="elevated" className="exec-panel">
      <header className="exec-panel__head">
        <h3>Best 模式</h3>
        {run === null ? null : (
          <>
            <Badge tone="run">{run.stage_label}</Badge>
            <Badge tone={run.status === "aborted" ? "error" : run.status === "awaiting_gate" ? "warn" : "muted"}>
              {run.status}
            </Badge>
          </>
        )}
      </header>

      {run === null ? (
        <>
          <p className="exec-panel__hint">
            给一个想法，自动走完「访谈 → 规格 → 拆票 → 实现」。规格成稿与实现前各有一道确认门；
            拆票不设门。
          </p>
          <textarea
            className="exec-panel__input"
            rows={3}
            placeholder="例如：给设置页加一个导出配置的按钮"
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
          />
          <div className="exec-panel__actions">
            <Button variant="primary" disabled={busy || idea.trim().length === 0} onClick={() => void start()}>
              开始
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="exec-panel__actions">
            {progress.map((step) => (
              <Badge key={step.stage} tone={step.current ? "run" : step.done ? "ok" : "dim"}>
                {step.label}
              </Badge>
            ))}
          </div>

          {run.stage === "spec" ? (
            <>
              <p className="exec-panel__hint">{SPEC_GATE_NOTICE}</p>
              <div className="exec-panel__actions">
                <Button variant="primary" disabled={busy} onClick={() => void gate("approve")}>
                  规格通过
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void gate("reject")}>
                  打回修改
                </Button>
              </div>
            </>
          ) : null}

          {run.stage === "tickets" ? (
            <>
              <p className="exec-panel__hint">{IMPLEMENT_GATE_UI_NOTICE}</p>
              <div className="exec-panel__actions">
                <Button variant="primary" disabled={gateDisabled !== null} onClick={() => void approveImplement()}>
                  确认实现范围
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !approved}
                  onClick={() => void startImplement()}
                >
                  开始实现
                </Button>
              </div>
              {gateDisabled === null ? null : <p className="exec-panel__hint">{gateDisabled}</p>}
            </>
          ) : null}

          {run.stage === "implement" ? (
            <>
              <div className="exec-panel__actions">
                <Button variant="secondary" disabled={busy} onClick={() => void loadPushPlan()}>
                  推送并开 PR…
                </Button>
              </div>
              {pushPlan === null ? null : (
                <>
                  <p className="exec-panel__hint">{pushConfirmText({ branch: pushPlan.branch })}</p>
                  <pre className="exec-panel__output">{pushPlan.commands.join("\n")}</pre>
                  <p className="exec-panel__hint">{pushPlan.notice}</p>
                </>
              )}
            </>
          ) : null}

          {artifactsSummary(run).length === 0 ? null : (
            <ul className="exec-panel__hint">
              {artifactsSummary(run).map((item) => (
                <li key={item.label}>
                  {item.label}：{item.value}
                </li>
              ))}
            </ul>
          )}

          <div className="exec-panel__actions">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh(run.best_id)}>
              刷新
            </Button>
          </div>
        </>
      )}

      {notice === null ? null : <p className="exec-panel__notice">{notice}</p>}
      {error === null ? null : <p className="exec-panel__error">{error}</p>}
    </GlassSurface>
  );
}
