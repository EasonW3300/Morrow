import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type HealthPayload } from "./api.ts";
import { describeHealth } from "./health-ui.ts";

/**
 * 健康面板（票 T7 / Issue #8）：反映 GET /v1/health 全量字段（status / version /
 * replica_id / sandbox 探针 / ledger 事件数）。
 *
 * 刷新策略（选择记录在案）：**10s 轮询 + 手动刷新**——health 是轻量本地 GET，轮询让
 * 沙箱/账本状态无需 Owner 关注即保持新鲜；M0 没有健康 SSE/推送通道，事件数也只有
 * 轮询能跟进。组件卸载即停表，不产生后台流量。上次刷新时间显式呈现，Owner 能判断数据新旧。
 */
const POLL_INTERVAL_MS = 10_000;

export function HealthView({ base }: { base: string }) {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const payload = await api.health(base);
      setHealth(payload);
      setError(null);
      setRefreshedAt(clockNow());
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "network_error"
            ? err.message
            : `健康检查失败（${err.code}）：${err.message}`
          : String(err),
      );
    } finally {
      setRefreshing(false);
    }
  }, [base]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error !== null && health === null) {
    return (
      <div className="page">
        <div className="page-head">
          <h2>系统健康</h2>
          <button className="btn primary" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "刷新中…" : "立即刷新"}
          </button>
        </div>
        <div className="banner-error">{error}</div>
        <p className="page-hint">无法读取健康状态。请确认 Runtime 正在运行，然后手动刷新。</p>
      </div>
    );
  }
  if (health === null) {
    return (
      <div className="page">
        <p className="page-hint">正在读取健康状态…</p>
      </div>
    );
  }

  const out = describeHealth(health, refreshedAt);
  return (
    <div className="page">
      <div className="page-head">
        <h2>系统健康</h2>
        <button className="btn primary" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "刷新中…" : "立即刷新"}
        </button>
      </div>
      {error !== null && <div className="banner-error">最近一次轮询失败：{error}（将在下个周期自动重试）</div>}
      <div className={`health-card tone-${out.tone}`}>
        <div className="health-summary">
          <span className={`dot tone-${out.tone}`} aria-hidden />
          {out.summary}
        </div>
        <dl className="health-lines">
          {out.lines.map((line) => (
            <div key={line.label} className={`health-line tone-${line.tone}`}>
              <dt>{line.label}</dt>
              <dd>
                <span className="mono">{line.value}</span>
                {line.note !== undefined && <span className="health-note">{line.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <div className="health-foot">
          每 10s 自动轮询 · 上次刷新 {out.refreshedAt}
          {out.sandboxNote.length > 0 && <p className="health-note standalone">{out.sandboxNote}</p>}
        </div>
      </div>
    </div>
  );
}

function clockNow(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
