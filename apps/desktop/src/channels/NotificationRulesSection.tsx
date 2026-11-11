import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ChannelSummary } from "../api.ts";
import { NOTIFICATION_EVENT_TYPE_VALUES } from "@morrow/protocol/browser";
import {
  notificationEventLabel,
  notificationTargetOptions,
  rulesToDrafts,
  toRuleInput,
  validateNotificationDrafts,
  type NotificationRuleDraft,
} from "../channel-ui.ts";
import { Button } from "../design-system/primitives/Button.tsx";
import { readableError } from "./shared.ts";

/** 4. 通知规则：四类事件 × 目标 × 免打扰时段 + 启用开关 */
export function NotificationRulesSection({ base, channels }: { base: string; channels: ChannelSummary[] }) {
  const [drafts, setDrafts] = useState<NotificationRuleDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const targetOptions = notificationTargetOptions(channels);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rules = await api.listNotificationRules(base);
      setDrafts(rulesToDrafts(rules));
    } catch (err) {
      setError(readableError(err, "加载通知规则失败"));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (saving) return;
    if (drafts.length === 0) {
      setError("至少需要一条通知规则。");
      return;
    }
    const validation = validateNotificationDrafts(drafts);
    if (validation !== null) {
      setError(validation);
      setMessage(null);
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await api.putNotificationRules(base, drafts.map(toRuleInput));
      setMessage("已按 (事件类型, 目标) 保存（notification.rule_upserted 审计已落账）。");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "notify_target_required") {
        setError(
          `channel 目标还没有默认通知会话（notify_target_required）：请先在上方「默认通知会话」为对应渠道配置接收会话，再保存规则。`,
        );
      } else {
        setError(readableError(err, "保存通知规则失败"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>通知规则</h4>
        <Button onClick={() => void load()} disabled={loading}>
          {loading ? "读取中…" : "刷新"}
        </Button>
      </div>
      <p className="page-hint">
        四类事件 × 目标（桌面 / channel:&lt;id&gt;）。免打扰时段用 UTC HH:MM，跨天合法（22:00–08:00）；
        窗内不投递、延迟到结束时刻。保存按 key 合并 upsert（关闭规则只把「启用」去掉，不删除行）。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}
      {message !== null && <p className="hint-inline tone-ok-text">{message}</p>}
      {drafts.length === 0 && !loading && <p className="empty-note">还没有通知规则。</p>}
      <div className="rule-table">
        <div className="rule-row rule-head">
          <span>事件</span>
          <span>目标</span>
          <span>免打扰开始</span>
          <span>免打扰结束</span>
          <span>启用</span>
          <span />
        </div>
        {drafts.map((draft, index) => (
          <div className="rule-row" key={draft.rule_id ?? `new-${index}`}>
            <select
              value={draft.event_type}
              onChange={(event) => {
                const next = [...drafts];
                next[index] = { ...draft, event_type: event.target.value as NotificationRuleDraft["event_type"] };
                setDrafts(next);
              }}
            >
              {NOTIFICATION_EVENT_TYPE_VALUES.map((eventType) => (
                <option key={eventType} value={eventType}>
                  {notificationEventLabel(eventType)}
                </option>
              ))}
            </select>
            <select
              value={draft.target}
              onChange={(event) => {
                const next = [...drafts];
                next[index] = { ...draft, target: event.target.value };
                setDrafts(next);
              }}
            >
              {targetOptions.some((option) => option.value === draft.target) ? null : (
                <option value={draft.target}>{draft.target}</option>
              )}
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              className="mono"
              placeholder="22:00"
              value={draft.quiet_hours?.start ?? ""}
              onChange={(event) => {
                const next = [...drafts];
                next[index] = {
                  ...draft,
                  quiet_hours: withQuietHours(draft.quiet_hours, "start", event.target.value),
                };
                setDrafts(next);
              }}
            />
            <input
              className="mono"
              placeholder="08:00"
              value={draft.quiet_hours?.end ?? ""}
              onChange={(event) => {
                const next = [...drafts];
                next[index] = {
                  ...draft,
                  quiet_hours: withQuietHours(draft.quiet_hours, "end", event.target.value),
                };
                setDrafts(next);
              }}
            />
            <label className="checkbox-row inline">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => {
                  const next = [...drafts];
                  next[index] = { ...draft, enabled: event.target.checked };
                  setDrafts(next);
                }}
              />
              启用
            </label>
            <Button variant="danger" onClick={() => setDrafts(drafts.filter((_v, pos) => pos !== index))}>
              删除
            </Button>
          </div>
        ))}
      </div>
      <div className="form-actions">
        <Button
          onClick={() =>
            setDrafts([
              ...drafts,
              {
                rule_id: null,
                event_type: "completed",
                target: targetOptions[0]?.value ?? "desktop",
                quiet_hours: null,
                enabled: true,
              },
            ])
          }
        >
          新增规则
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存规则"}
        </Button>
      </div>
      <p className="hint-inline">
        目标说明：{targetOptions.map((option) => `${option.label}=${option.value}`).join("；")}
      </p>
    </section>
  );
}

function withQuietHours(
  current: { start: string; end: string } | null,
  key: "start" | "end",
  value: string,
): { start: string; end: string } | null {
  const start = key === "start" ? value : (current?.start ?? "");
  const end = key === "end" ? value : (current?.end ?? "");
  return start === "" && end === "" ? null : { start, end };
}
