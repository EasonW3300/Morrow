import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type GoalView } from "./api.ts";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import {
  goalCreateDisabledReason,
  goalCreateNotice,
  goalNextStep,
  goalStatusBadge,
  goalUsageSummary,
} from "./automation-ui.ts";

/**
 * Thread Goal 面板（票 M7-C / #78-79；UI 由 C8 补齐）。
 *
 * 创建前必须勾选确认（goal 会自动续跑并烧预算）。六态里三种"停下来"的状态
 * 各自给下一步建议——这是 Owner 最需要的："它停了，我该做什么"。
 */
export function GoalPanel({ base, sessionId }: { base: string; sessionId: string }) {
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [objective, setObjective] = useState("");
  const [tokenLimit, setTokenLimit] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await api.listGoals(base, sessionId);
    setGoals(result.goals);
  }, [base, sessionId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const open = goals.find((goal) => goal.status !== "complete");

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const parsedLimit = tokenLimit.trim().length === 0 ? undefined : Number(tokenLimit.trim());
      const result = await api.createGoal(base, {
        sessionId,
        objective: objective.trim(),
        ...(parsedLimit === undefined || Number.isNaN(parsedLimit) ? {} : { tokenLimit: parsedLimit }),
      });
      setNotice(`已创建目标（${result.goal.status_label}）。空闲时它会自动继续推进。`);
      setObjective("");
      setConfirmed(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(goal: GoalView, action: "pause" | "resume" | "complete") {
    setBusy(true);
    setError(null);
    try {
      // budget_limited 恢复时需要提高预算，否则立刻又超限（后端建议同款）
      const raise =
        action === "resume" && goal.status === "budget_limited" && goal.token_limit !== null
          ? goal.token_limit * 2
          : undefined;
      await api.goalAction(base, goal.goal_id, action, raise);
      setNotice(
        action === "resume" && raise !== undefined
          ? `已恢复，并把 token 预算提高到 ${raise}。`
          : `已${action === "pause" ? "暂停" : action === "resume" ? "恢复" : "标记完成"}。`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  const disabledReason = goalCreateDisabledReason({ objective, confirmed, busy });
  const noticeText = goalCreateNotice({
    tokenLimit: tokenLimit.trim().length === 0 ? null : Number(tokenLimit),
    timeLimitMs: null,
  });

  return (
    <GlassSurface variant="elevated" className="exec-panel">
      <header className="exec-panel__head">
        <h3>线程目标</h3>
        {open === undefined ? null : (
          <Badge tone={goalStatusBadge(open.status).tone as never}>{goalStatusBadge(open.status).label}</Badge>
        )}
      </header>

      {open === undefined ? (
        <>
          <p className="exec-panel__hint">{noticeText}</p>
          <label className="exec-panel__label" htmlFor="goal-objective">
            目标
          </label>
          <textarea
            id="goal-objective"
            className="exec-panel__input"
            rows={3}
            placeholder="例如：把所有测试补到覆盖率 80%"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
          <label className="exec-panel__label" htmlFor="goal-tokens">
            token 预算（留空 = 不限）
          </label>
          <input
            id="goal-tokens"
            className="exec-panel__input"
            placeholder="100000"
            value={tokenLimit}
            onChange={(event) => setTokenLimit(event.target.value)}
          />
          <label className="exec-panel__check">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            我已了解：目标会自动续跑并消耗预算
          </label>
          <div className="exec-panel__actions">
            <Button variant="primary" disabled={disabledReason !== null} onClick={() => void create()}>
              创建目标
            </Button>
          </div>
          {disabledReason === null ? null : <p className="exec-panel__hint">{disabledReason}</p>}
        </>
      ) : (
        <>
          <p className="exec-panel__mode-summary">{open.objective}</p>
          <p className="exec-panel__hint">{goalUsageSummary(open.usage)}</p>
          {open.last_error === null ? null : <p className="exec-panel__hint">最近错误：{open.last_error}</p>}
          {goalNextStep(open.status) === null ? null : (
            <p className="exec-panel__hint">{goalNextStep(open.status)}</p>
          )}
          <div className="exec-panel__actions">
            {open.status === "active" ? (
              <Button variant="secondary" disabled={busy} onClick={() => void act(open, "pause")}>
                暂停
              </Button>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void act(open, "resume")}>
                恢复
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => void act(open, "complete")}>
              标记完成
            </Button>
          </div>
        </>
      )}

      {notice === null ? null : <p className="exec-panel__notice">{notice}</p>}
      {error === null ? null : <p className="exec-panel__error">{error}</p>}
    </GlassSurface>
  );
}
