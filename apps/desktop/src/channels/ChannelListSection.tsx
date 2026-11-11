import { useState } from "react";
import { api, type ChannelHealth, type ChannelSummary } from "../api.ts";
import {
  capabilityBadges,
  channelDisplayName,
  channelStateLabel,
  channelStateTone,
  channelTypeLabel,
  describeChannelHealth,
  experimentalEnableGate,
  isCredentialConfigurable,
} from "../channel-ui.ts";
import { Button } from "../design-system/primitives/Button.tsx";
import { useConfirm } from "../design-system/ConfirmDialog.tsx";
import { ChannelCredentialsForm } from "./ChannelCredentialsForm.tsx";
import { ChannelRiskDialog } from "./ChannelRiskDialog.tsx";
import { readableError } from "./shared.ts";

/** 1. 适配器清单：健康/能力边界/启停（实验过风险确认）/凭据配置入口 */
export function ChannelListSection({
  base,
  channels,
  healths,
  nowMs,
  onChanged,
}: {
  base: string;
  channels: ChannelSummary[];
  healths: Record<string, ChannelHealth>;
  nowMs: number;
  onChanged: () => Promise<void>;
}) {
  const [riskTarget, setRiskTarget] = useState<ChannelSummary | null>(null);
  const [credentialTarget, setCredentialTarget] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askConfirm, confirmDialog] = useConfirm();

  const disable = async (channel: ChannelSummary) => {
    const ok = await askConfirm({
      title: "停用渠道",
      message: `停用「${channelDisplayName(channel.channel_id)}」？将立即停止收发（可再用风险确认重新启用）。`,
      confirmLabel: "停用",
      tone: "danger",
    });
    if (!ok) {
      return;
    }
    setBusyId(channel.channel_id);
    setError(null);
    try {
      await api.disableChannel(base, channel.channel_id);
      await onChanged();
    } catch (err) {
      setError(readableError(err, "停用失败"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>适配器清单</h4>
        <span className="hint-inline">健康数据每 20 秒刷新；token 倒计时每秒更新</span>
      </div>
      {error !== null && <div className="banner-error">{error}</div>}
      {channels.length === 0 && <p className="empty-note">还没有注册任何渠道适配器。</p>}
      <ul className="channel-list">
        {channels.map((channel) => {
          const health = healths[channel.channel_id];
          const view = health === undefined ? null : describeChannelHealth(health, nowMs);
          const gate = experimentalEnableGate({
            experimental: channel.experimental,
            enabled: channel.enabled,
            riskConfirmed: false,
            riskNotice: channel.risk_notice,
          });
          const badges = capabilityBadges(channel.capabilities);
          return (
            <li key={channel.channel_id} className="channel-row">
              <div className="channel-main">
                <div className="channel-title">
                  <strong>{channelDisplayName(channel.channel_id)}</strong>
                  <span className="badge">{channelTypeLabel(channel)}</span>
                  {channel.experimental && (
                    <span className="badge badge-experimental" title="实验功能：不稳定、可能违反平台条款，风险自担">
                      实验
                    </span>
                  )}
                  <span className={`badge badge-tone-${channelStateTone(channel.state)}`}>
                    {channelStateLabel(channel.state)}
                  </span>
                  <span className={channel.enabled ? "badge badge-tone-ok" : "badge"}>
                    {channel.enabled ? "已启用" : "未启用"}
                  </span>
                  <span className="mono hint-inline">{channel.account ?? "未绑定账号"}</span>
                </div>

                {view !== null ? (
                  <div className="channel-health">
                    <span className={`health-chip t-${view.connectionTone}`}>
                      连接：{view.connectionLabel}
                    </span>
                    <span className={`health-chip t-${view.tokenTone}`}>token：{view.tokenLabel}</span>
                    {view.bridgeLabel !== null && <span className="health-chip">本地桥：{view.bridgeLabel}</span>}
                    <span className={view.healthy ? "health-chip t-ok" : "health-chip t-error"}>
                      {view.healthy ? "健康" : "不健康"}
                    </span>
                    {view.lastError !== null && (
                      <span className="health-chip t-error" title={view.lastError}>
                        最近错误：{view.lastError}
                      </span>
                    )}
                    {view.detail !== null && <span className="hint-inline">{view.detail}</span>}
                  </div>
                ) : (
                  <div className="channel-health">
                    <span className="health-chip t-muted">健康检查不可用</span>
                  </div>
                )}

                {channel.environment !== undefined && (
                  <div className="channel-meta">
                    <span>
                      声明环境：{channel.environment.os} + {channel.environment.client}
                    </span>
                    <span>桥：{channel.environment.bridge}</span>
                    <span>
                      真实联调：{channel.environment.real_integration === "done" ? "已完成" : "未完成（外部依赖）"}
                    </span>
                  </div>
                )}

                <div className="cap-badges" aria-label="能力边界">
                  {badges.map((badge) => (
                    <span key={badge.key} className={`cap-badge tone-${badge.tone}`} title={badge.hint}>
                      {badge.label}：{badge.valueLabel}
                    </span>
                  ))}
                </div>

                {channel.risk_notice !== undefined && (
                  <p className="risk-inline">
                    <strong>风险声明：</strong>
                    {channel.risk_notice}
                  </p>
                )}
              </div>

              <div className="channel-actions">
                {channel.experimental ? (
                  channel.enabled ? (
                    <Button
                      variant="danger"
                      disabled={busyId === channel.channel_id}
                      onClick={() => void disable(channel)}
                    >
                      {busyId === channel.channel_id ? "停用中…" : "停用…"}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={gate.mode === "confirm_required" && !gate.noticePresent}
                      onClick={() => setRiskTarget(channel)}
                      title={gate.disabledReason ?? "启用前需阅读并确认风险声明"}
                    >
                      启用（实验）…
                    </Button>
                  )
                ) : (
                  <span className="hint-inline">随 Runtime 启动，无实验启用门</span>
                )}
                {isCredentialConfigurable(channel.channel_id) && (
                  <Button onClick={() => setCredentialTarget(channel.channel_id)}>配置凭据…</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {riskTarget !== null && (
        <ChannelRiskDialog
          base={base}
          channel={riskTarget}
          onClose={() => setRiskTarget(null)}
          onEnabled={async () => {
            setRiskTarget(null);
            await onChanged();
          }}
        />
      )}

      {credentialTarget !== null && (
        <ChannelCredentialsForm
          base={base}
          channelId={credentialTarget}
          onClose={() => setCredentialTarget(null)}
          onSaved={onChanged}
        />
      )}
      {confirmDialog}
    </section>
  );
}
