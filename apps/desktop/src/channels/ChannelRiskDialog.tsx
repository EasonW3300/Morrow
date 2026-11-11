import { useEffect, useState } from "react";
import { api, type ChannelSummary } from "../api.ts";
import { channelDisplayName, riskConsentState } from "../channel-ui.ts";
import { GlassSurface } from "../design-system/primitives/GlassSurface.tsx";
import { Button } from "../design-system/primitives/Button.tsx";
import { readableError } from "./shared.ts";

/** 微信实验启用：完整风险文案 + 勾选确认 → POST enable { confirm_risk: true } */
export function ChannelRiskDialog({
  base,
  channel,
  onClose,
  onEnabled,
}: {
  base: string;
  channel: ChannelSummary;
  onClose: () => void;
  onEnabled: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consent = riskConsentState({
    open: true,
    confirmed,
    submitting,
    riskNotice: channel.risk_notice,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const confirm = async () => {
    if (!consent.canConfirm) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.enableChannel(base, channel.channel_id, true);
      await onEnabled();
    } catch (err) {
      setError(readableError(err, "启用失败"));
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <GlassSurface
        variant="elevated"
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="实验适配器风险确认"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>启用实验适配器：{channelDisplayName(channel.channel_id)}</h3>
        <p className="modal-lead">
          这是实验功能，出厂默认关闭。启用后 Morrow 会通过非官方自动化与你的个人账号交互，
          请完整阅读以下风险声明。
        </p>
        {channel.environment !== undefined && (
          <dl className="modal-facts">
            <dt>声明环境</dt>
            <dd>
              {channel.environment.os} + {channel.environment.client}
            </dd>
            <dt>本地桥</dt>
            <dd>{channel.environment.bridge}</dd>
            <dt>真实联调</dt>
            <dd>{channel.environment.real_integration === "done" ? "已完成" : "未完成（外部依赖）"}</dd>
            {channel.environment.notes !== undefined && (
              <>
                <dt>说明</dt>
                <dd>{channel.environment.notes}</dd>
              </>
            )}
          </dl>
        )}
        <div className="risk-notice-full">
          <strong>风险声明（完整原文）</strong>
          <p>{channel.risk_notice ?? "风险声明缺失——按 fail-closed 原则禁止启用。"}</p>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={submitting || !consent.noticePresent}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我已阅读并理解上述风险，自愿启用并自行承担账号风险。
        </label>
        {consent.reason !== null && <p className="field-hint">{consent.reason}</p>}
        {error !== null && <div className="banner-error">{error}</div>}
        <div className="form-actions">
          <Button variant="primary" disabled={!consent.canConfirm} onClick={() => void confirm()}>
            {submitting ? "启用中…" : "确认启用（自担风险）"}
          </Button>
          <Button disabled={submitting} onClick={onClose}>
            取消
          </Button>
        </div>
      </GlassSurface>
    </div>
  );
}
