import { useCallback, useEffect, useState } from "react";
import { api, type OutboxMessageRecord } from "../api.ts";
import {
  channelDisplayName,
  outboxActionState,
  outboxFailureLabel,
  outboxPayloadSummary,
  outboxTargetLabel,
  OUTBOX_STATUS_LABELS,
  retryConfirmed,
} from "../channel-ui.ts";
import { Button } from "../design-system/primitives/Button.tsx";
import { useConfirm } from "../design-system/ConfirmDialog.tsx";
import { readableError, relativeTime, sortByUpdated } from "./shared.ts";

/** 5. Outbox 待核对：人工重发 / 标记已送达 + 最近 sent 对照 */
export function OutboxReviewSection({ base, nowMs }: { base: string; nowMs: number }) {
  const [review, setReview] = useState<OutboxMessageRecord[]>([]);
  const [sent, setSent] = useState<OutboxMessageRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [askConfirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [unknown, needsReview, recentSent] = await Promise.all([
        api.listOutbox(base, { status: "delivery_unknown", limit: 50 }),
        api.listOutbox(base, { status: "needs_review", limit: 50 }),
        api.listOutbox(base, { status: "sent", limit: 10 }),
      ]);
      setReview(sortByUpdated([...needsReview.messages, ...unknown.messages]));
      setSent(recentSent.messages);
    } catch (err) {
      setError(readableError(err, "加载 Outbox 失败"));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (record: OutboxMessageRecord) => {
    const state = outboxActionState(record);
    const needsConfirm = retryConfirmed(record);
    if (
      needsConfirm &&
      !(await askConfirm({
        title: "重发可能已送达的消息",
        message: "这条消息可能已经送达平台。重发可能造成重复消息——确认已线下核对、仍要重发吗？",
        confirmLabel: "仍要重发",
        tone: "primary",
      }))
    ) {
      return;
    }
    setBusy(record.id);
    setError(null);
    setMessage(null);
    try {
      await api.retryOutbox(base, record.id, needsConfirm);
      setMessage("已重置为待投递，由 Outbox 投递器按幂等键发送。");
      await load();
    } catch (err) {
      setError(readableError(err, state.retryRequiresConfirm ? "重发失败（需确认）" : "重发失败"));
    } finally {
      setBusy(null);
    }
  };

  const markSent = async (record: OutboxMessageRecord) => {
    const ok = await askConfirm({
      title: "标记为已送达",
      message: "标记为已送达？将写入人工回执（manual receipt）并留审计，不会重新发送。",
      confirmLabel: "标记已送达",
      tone: "primary",
    });
    if (!ok) {
      return;
    }
    setBusy(record.id);
    setError(null);
    setMessage(null);
    try {
      await api.markOutboxSent(base, record.id, { note: "owner_confirmed_in_channels_ui" });
      setMessage("已人工标记为已送达。");
      await load();
    } catch (err) {
      setError(readableError(err, "标记已送达失败"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>Outbox 待核对</h4>
        <Button onClick={() => void load()} disabled={loading}>
          {loading ? "读取中…" : "刷新"}
        </Button>
      </div>
      <p className="page-hint">
        送达未知（delivery_unknown）与需人工核对（needs_review）绝不自动重发：先线下核对，
        再选择「我已核对，重发」或「标记已送达」。最近 sent 只作对照。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}
      {message !== null && <p className="hint-inline tone-ok-text">{message}</p>}
      {review.length === 0 && !loading && <p className="empty-note">没有需要人工核对的 Outbox 行。</p>}
      <ul className="outbox-list">
        {review.map((record) => {
          const actions = outboxActionState(record);
          return (
            <li key={record.id} className="outbox-row">
              <div className="outbox-main">
                <div className="outbox-title">
                  <span className={`badge badge-tone-${record.status === "needs_review" ? "error" : "warn"}`}>
                    {OUTBOX_STATUS_LABELS[record.status]}
                  </span>
                  <span className="badge">{channelDisplayName(record.channel_id)}</span>
                  <span className="mono">{record.account_id}</span>
                  <span className="mono">{outboxTargetLabel(record)}</span>
                  <span className="hint-inline">尝试 {record.attempts} 次 · {relativeTime(record.updated_at, nowMs)}</span>
                </div>
                <div className="outbox-content">{outboxPayloadSummary(record.payload)}</div>
                <div className="outbox-error">失败原因：{outboxFailureLabel(record)}</div>
              </div>
              <div className="outbox-actions">
                <Button
                  disabled={!actions.canRetry || busy === record.id}
                  title={actions.disabledReason ?? ""}
                  onClick={() => void retry(record)}
                >
                  {busy === record.id ? "处理中…" : actions.retryLabel}
                </Button>
                <Button
                  disabled={!actions.canMarkSent || busy === record.id}
                  onClick={() => void markSent(record)}
                >
                  标记已送达
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="outbox-sent">
        <h5>最近 sent（对照）</h5>
        {sent.length === 0 ? (
          <p className="hint-inline">暂无已送达记录。</p>
        ) : (
          <ul className="outbox-list compact">
            {sent.map((record) => (
              <li key={record.id} className="outbox-row compact">
                <div className="outbox-main">
                  <div className="outbox-title">
                    <span className="badge badge-tone-ok">{OUTBOX_STATUS_LABELS[record.status]}</span>
                    <span className="badge">{channelDisplayName(record.channel_id)}</span>
                    <span className="mono">{outboxTargetLabel(record)}</span>
                    <span className="hint-inline">{relativeTime(record.updated_at, nowMs)}</span>
                  </div>
                  <div className="outbox-content">{outboxPayloadSummary(record.payload)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {confirmDialog}
    </section>
  );
}
