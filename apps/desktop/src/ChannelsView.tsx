import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ChannelHealth,
  type ChannelSecretsView,
  type ChannelSummary,
  type ContactAmbiguityView,
  type ContactCapabilityCategory,
  type ContactInviteView,
  type ContactView,
  type OutboxMessageRecord,
} from "./api.ts";
import {
  CONTACT_CAPABILITY_CATEGORIES,
  NOTIFICATION_EVENT_TYPE_VALUES,
  type ChannelAllowMode,
} from "@morrow/protocol/browser";
import {
  ALLOW_MODES,
  allowModeLabel,
  allowlistFromEntries,
  buildSecretsPayload,
  capabilityBadges,
  channelDisplayName,
  channelStateLabel,
  channelStateTone,
  channelTypeLabel,
  contactCategoryLabel,
  credentialFieldLabel,
  credentialFormInitial,
  credentialSummary,
  describeChannelHealth,
  experimentalEnableGate,
  grantSelectionSummary,
  grantedCategories,
  inviteCountdown,
  isCredentialConfigurable,
  notificationEventLabel,
  notificationTargetOptions,
  outboxActionState,
  outboxFailureLabel,
  outboxPayloadSummary,
  outboxTargetLabel,
  OUTBOX_STATUS_LABELS,
  retryConfirmed,
  riskConsentState,
  rulesToDrafts,
  toAllowlistPayload,
  toGrantsPayload,
  toRuleInput,
  toggleCategory,
  validateAllowlistRows,
  validateCredentialForm,
  validateDisplayName,
  validateGrantSelection,
  validateNotificationDrafts,
  validateQuietHours,
  type AllowlistDraftRow,
  type CredentialFieldErrors,
  type NotificationRuleDraft,
} from "./channel-ui.ts";

/**
 * 设置 →「渠道」子页签（M4-T8 / Issue #45；PRD §5.1 渠道管理、§4.4 渠道、§4.8 通知/联系人）。
 *
 * 五个区块，自上而下：
 *   1. 适配器清单：类型/状态/health（连接、token 有效期、最近错误、本地桥）/
 *      capabilities 徽标（主动消息受限明确显示「受限」）；启停（实验适配器过风险确认）；
 *      飞书/QQ 凭据配置（写 SecretStore、只显示「已配置」投影、不回显）；
 *   2. 微信风险确认：启用前弹窗展示完整 risk_notice + 勾选 → confirm_risk=true；
 *   3. 群聊白名单：会话 id × 模式（mention_only/proactive_limited）增删与整表保存；
 *   4. 可信联系人：授权类别勾选、邀请码生成 + 倒计时 + 复制、身份歧义裁决；
 *   5. 通知规则：四类事件 × 目标（desktop/channel:<id>）× 免打扰时段 + 启用开关；
 *   6. Outbox 待核对：delivery_unknown/needs_review 的「我已核对，重发 / 标记已送达」
 *      + 最近 sent 对照。
 *
 * 全部走控制面 HTTP API；常量与类型只从 `@morrow/protocol/browser` 引（守卫测试）。
 */
export function ChannelsView({ base }: { base: string }) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [healths, setHealths] = useState<Record<string, ChannelHealth>>({});
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const reload = useCallback(async () => {
    try {
      const list = await api.listChannels(base);
      setChannels(list);
      const pairs = await Promise.all(
        list.map(async (channel) => {
          try {
            return [channel.channel_id, await api.channelHealth(base, channel.channel_id)] as const;
          } catch {
            return [channel.channel_id, null] as const;
          }
        }),
      );
      setHealths(
        Object.fromEntries(
          pairs.filter((pair): pair is readonly [string, ChannelHealth] => pair[1] !== null),
        ),
      );
      setError(null);
    } catch (err) {
      setError(readableError(err, "加载渠道清单失败"));
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => void reload(), 20_000);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div className="settings-section channels-page">
      <div className="page-head">
        <h2>渠道</h2>
        <button className="btn" onClick={() => void reload()}>
          刷新清单与健康
        </button>
      </div>
      <p className="page-hint">
        渠道 = 平台适配器 + 本地账号 + 白名单 + 权限解析。所有外发先落 Outbox（不自动重发未知状态）；
        实验适配器（微信个人号）出厂关闭，启用必须显式确认风险。凭据只进系统凭据库，保存后不回显。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}
      <AdapterSection base={base} channels={channels} healths={healths} nowMs={nowMs} onChanged={reload} />
      <AllowlistSection base={base} channels={channels} />
      <ContactsSection base={base} nowMs={nowMs} />
      <NotificationRulesSection base={base} channels={channels} />
      <OutboxSection base={base} nowMs={nowMs} />
    </div>
  );
}

// --- 1. 适配器清单 ------------------------------------------------------------------

function AdapterSection({
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

  const disable = async (channel: ChannelSummary) => {
    if (!window.confirm(`停用「${channelDisplayName(channel.channel_id)}」？将立即停止收发（可再用风险确认重新启用）。`)) {
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
                    <button
                      className="btn danger"
                      disabled={busyId === channel.channel_id}
                      onClick={() => void disable(channel)}
                    >
                      {busyId === channel.channel_id ? "停用中…" : "停用…"}
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      disabled={gate.mode === "confirm_required" && !gate.noticePresent}
                      onClick={() => setRiskTarget(channel)}
                      title={gate.disabledReason ?? "启用前需阅读并确认风险声明"}
                    >
                      启用（实验）…
                    </button>
                  )
                ) : (
                  <span className="hint-inline">随 Runtime 启动，无实验启用门</span>
                )}
                {isCredentialConfigurable(channel.channel_id) && (
                  <button className="btn" onClick={() => setCredentialTarget(channel.channel_id)}>
                    配置凭据…
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {riskTarget !== null && (
        <RiskDialog
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
        <CredentialDialog
          base={base}
          channelId={credentialTarget}
          onClose={() => setCredentialTarget(null)}
          onSaved={onChanged}
        />
      )}
    </section>
  );
}

/** 微信实验启用：完整风险文案 + 勾选确认 → POST enable { confirm_risk: true } */
function RiskDialog({
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
      <div
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
          <button className="btn primary" disabled={!consent.canConfirm} onClick={() => void confirm()}>
            {submitting ? "启用中…" : "确认启用（自担风险）"}
          </button>
          <button className="btn" disabled={submitting} onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** 飞书/QQ 凭据表单：显示 configured 投影，只提交新填写的值 */
function CredentialDialog({
  base,
  channelId,
  onClose,
  onSaved,
}: {
  base: string;
  channelId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [view, setView] = useState<ChannelSecretsView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<CredentialFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getChannelSecrets(base, channelId)
      .then((loaded) => {
        if (cancelled) return;
        setView(loaded);
        setValues(credentialFormInitial(loaded));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(readableError(err, "读取凭据投影失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [base, channelId]);

  const save = async () => {
    if (view === null || saving) return;
    const nextErrors = validateCredentialForm(view, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const payload = buildSecretsPayload(values);
    if (Object.keys(payload).length === 0) {
      setError("没有填写任何字段；空值表示保持现有凭据不变。");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await api.putChannelSecrets(base, channelId, payload);
      setView(updated);
      setValues(credentialFormInitial(updated));
      setMessage("已写入系统凭据库（不回显）。");
      await onSaved();
    } catch (err) {
      setError(readableError(err, "保存凭据失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="渠道凭据配置"
        onClick={(event) => event.stopPropagation()}
      >
        <h3>配置凭据：{channelDisplayName(channelId)}</h3>
        <p className="modal-lead">
          凭据只写系统凭据库（SecretStore），界面只显示「已配置」投影；保存后不会回显任何密钥。
          留空表示保持现有值不变。
        </p>
        {error !== null && <div className="banner-error">{error}</div>}
        {view === null ? (
          <p className="empty-note">正在读取凭据投影…</p>
        ) : (
          <>
            <p className="hint-inline">{credentialSummary(view)}</p>
            <div className="form-grid">
              {view.fields.map((field) => (
                <label className="field" key={field.field}>
                  <span className="field-label">
                    {credentialFieldLabel(field.field)}
                    {field.required ? "（必填）" : ""}
                    {field.configured && <span className="badge badge-tone-ok">已配置（不回显）</span>}
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={values[field.field] ?? ""}
                    placeholder={field.configured ? "••••••••（留空保持不变）" : "请输入"}
                    onChange={(event) => setValues({ ...values, [field.field]: event.target.value })}
                  />
                  {errors[field.field] !== undefined ? (
                    <span className="field-error">{errors[field.field]}</span>
                  ) : null}
                </label>
              ))}
            </div>
            {message !== null && <p className="hint-inline tone-ok-text">{message}</p>}
            <div className="form-actions">
              <button className="btn primary" onClick={() => void save()} disabled={saving}>
                {saving ? "保存中…" : "保存凭据"}
              </button>
              <button className="btn" onClick={onClose} disabled={saving}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- 2. 群聊白名单 ------------------------------------------------------------------

function AllowlistSection({ base, channels }: { base: string; channels: ChannelSummary[] }) {
  const [channelId, setChannelId] = useState<string>("");
  const [rows, setRows] = useState<AllowlistDraftRow[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (channelId === "" && channels.length > 0) {
      const preferred = channels.find((channel) => channel.channel_id === "wechat") ?? channels[0];
      setChannelId(preferred.channel_id);
    }
  }, [channels, channelId]);

  const load = useCallback(async (id: string) => {
    if (id === "") return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.getAllowlist(base, id);
      setRows(allowlistFromEntries(response.allowlist));
      setAccountId(response.account_id);
    } catch (err) {
      setError(readableError(err, "加载白名单失败"));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load(channelId);
  }, [channelId, load]);

  const save = async () => {
    if (channelId === "" || saving) return;
    const validation = validateAllowlistRows(rows);
    if (validation !== null) {
      setError(validation);
      setMessage(null);
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.putAllowlist(base, channelId, toAllowlistPayload(rows));
      setRows(allowlistFromEntries(response.allowlist));
      setAccountId(response.account_id);
      setMessage("已保存（整表替换，channel.allowlist_updated 审计已落账）。");
    } catch (err) {
      setError(readableError(err, "保存白名单失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>群聊白名单</h4>
        <div className="inline-actions">
          <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
            {channels.map((channel) => (
              <option key={channel.channel_id} value={channel.channel_id}>
                {channelDisplayName(channel.channel_id)}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void load(channelId)} disabled={loading || channelId === ""}>
            {loading ? "读取中…" : "刷新"}
          </button>
        </div>
      </div>
      <p className="page-hint">
        只有白名单内的会话才响应。微信个人号对私聊也要求白名单（fail-closed）。
        「仅 @ 回复」= 群内必须 @ 才处理；「有限主动消息」仍需服从平台频控与场景限制。
      </p>
      {accountId === null && channelId !== "" && (
        <p className="field-hint">该渠道未绑定账号：保存不会生效（先在 Runtime 注册渠道账号）。</p>
      )}
      {error !== null && <div className="banner-error">{error}</div>}
      {rows.length === 0 && error === null && !loading && (
        <p className="empty-note">白名单为空。点「新增会话」添加要响应的群/私聊会话 id。</p>
      )}
      <ul className="allowlist-list">
        {rows.map((row, index) => (
          <li key={index} className="allowlist-row">
            <input
              className="mono allowlist-id"
              value={row.native_conversation_id}
              placeholder="平台会话 id（如 oc_xxx / wx-group-1）"
              spellCheck={false}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, native_conversation_id: event.target.value };
                setRows(next);
              }}
            />
            <select
              value={row.mode}
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, mode: event.target.value as ChannelAllowMode };
                setRows(next);
              }}
            >
              {ALLOW_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {allowModeLabel(mode)}
                </option>
              ))}
            </select>
            <button
              className="btn danger"
              onClick={() => setRows(rows.filter((_value, position) => position !== index))}
            >
              删除
            </button>
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <button
          className="btn"
          onClick={() => setRows([...rows, { native_conversation_id: "", mode: "mention_only" }])}
        >
          新增会话
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={saving || channelId === ""}>
          {saving ? "保存中…" : "保存白名单"}
        </button>
        {message !== null && <span className="hint-inline tone-ok-text">{message}</span>}
      </div>
    </section>
  );
}

// --- 3. 可信联系人 ------------------------------------------------------------------

function ContactsSection({ base, nowMs }: { base: string; nowMs: number }) {
  const [contacts, setContacts] = useState<ContactView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ContactCapabilityCategory[]>>({});
  const [ambiguities, setAmbiguities] = useState<ContactAmbiguityView[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [invite, setInvite] = useState<ContactInviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [loadedContacts, loadedAmbiguities] = await Promise.all([
        api.listContacts(base),
        api.listContactAmbiguities(base, "open"),
      ]);
      setContacts(loadedContacts);
      setDrafts((previous) =>
        Object.fromEntries(
          loadedContacts.map((contact) => [
            contact.contact_id,
            previous[contact.contact_id] ?? grantedCategories(contact.grants),
          ]),
        ),
      );
      setAmbiguities(loadedAmbiguities);
      setError(null);
    } catch (err) {
      setError(readableError(err, "加载联系人失败"));
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const generateInvite = async () => {
    const nameError = validateDisplayName(displayName);
    if (nameError !== null) {
      setError(nameError);
      return;
    }
    setBusy("invite");
    setError(null);
    setMessage(null);
    setCopied(false);
    try {
      const created = await api.createContactInvite(
        base,
        displayName.trim().length === 0 ? {} : { display_name: displayName.trim() },
      );
      setInvite(created);
      setMessage("邀请码只显示这一次；请经渠道发送给对方，由对方回复绑定。");
      await reload();
    } catch (err) {
      setError(readableError(err, "生成邀请码失败"));
    } finally {
      setBusy(null);
    }
  };

  const copyInvite = async () => {
    if (invite === null) return;
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("复制失败：请手动选中邀请码复制。");
    }
  };

  const saveGrants = async (contact: ContactView) => {
    const categories = drafts[contact.contact_id] ?? grantedCategories(contact.grants);
    const validation = validateGrantSelection(categories);
    if (validation !== null) {
      setError(validation);
      return;
    }
    setBusy(contact.contact_id);
    setError(null);
    setMessage(null);
    try {
      await api.putContactGrants(base, contact.contact_id, toGrantsPayload(categories));
      setMessage(`已更新「${contact.display_name}」的授权（contact.grants_updated 审计已落账）。`);
      await reload();
    } catch (err) {
      setError(readableError(err, "保存授权失败"));
    } finally {
      setBusy(null);
    }
  };

  const resolveAmbiguity = async (ambiguity: ContactAmbiguityView) => {
    const contactId = choices[ambiguity.ambiguity_id] ?? ambiguity.candidate_contact_ids[0] ?? "";
    if (contactId === "") {
      setError("该歧义没有可选择的候选联系人。");
      return;
    }
    setBusy(ambiguity.ambiguity_id);
    setError(null);
    setMessage(null);
    try {
      await api.resolveContactAmbiguity(base, ambiguity.ambiguity_id, contactId);
      setMessage("已裁决身份歧义（contact.ambiguity_resolved 审计已落账）。");
      await reload();
    } catch (err) {
      setError(readableError(err, "裁决失败"));
    } finally {
      setBusy(null);
    }
  };

  const countdown = invite === null ? null : inviteCountdown(invite.expires_at, nowMs);

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>可信联系人</h4>
        <button className="btn" onClick={() => void reload()}>
          刷新
        </button>
      </div>
      <p className="page-hint">
        授权粒度 = 联系人 × 能力类别；默认只有「查询问答」。任务执行与记忆引用（仅 public）需显式勾选；
        身份歧义必须由你选择，系统不自动合并。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}
      {message !== null && <p className="hint-inline tone-ok-text">{message}</p>}

      <div className="invite-box">
        <div className="invite-form">
          <label className="field">
            <span className="field-label">邀请新联系人（显示名可选）</span>
            <input
              value={displayName}
              placeholder="例如：同事小王"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <button className="btn primary" onClick={() => void generateInvite()} disabled={busy === "invite"}>
            {busy === "invite" ? "生成中…" : "生成邀请码"}
          </button>
        </div>
        {invite !== null && countdown !== null && (
          <div className="invite-result">
            <div>
              <span className="field-label">一次性邀请码</span>
              <div className="invite-code mono">{invite.code}</div>
            </div>
            <div className="invite-meta">
              <span className={`badge badge-tone-${countdown.tone === "ok" ? "ok" : countdown.tone === "warn" ? "warn" : "error"}`}>
                {countdown.label}
              </span>
              <button className="btn" onClick={() => void copyInvite()}>
                {copied ? "已复制" : "复制"}
              </button>
              {countdown.expired && <span className="field-error">已过期，请重新生成。</span>}
            </div>
          </div>
        )}
      </div>

      {contacts.length === 0 && <p className="empty-note">还没有可信联系人。生成邀请码并让对方在渠道里回复即可绑定。</p>}
      <ul className="contact-list">
        {contacts.map((contact) => {
          const categories = drafts[contact.contact_id] ?? grantedCategories(contact.grants);
          return (
            <li key={contact.contact_id} className="contact-row">
              <div className="contact-main">
                <div className="contact-title">
                  <strong>{contact.display_name}</strong>
                  <span className="badge">{contact.status === "active" ? "有效" : "已暂停"}</span>
                  <span className="mono hint-inline">{contact.contact_id.slice(0, 8)}</span>
                </div>
                <div className="contact-meta">
                  {contact.identities.length === 0 ? (
                    <span className="hint-inline">尚未绑定渠道身份</span>
                  ) : (
                    contact.identities.map((identity) => (
                      <span key={`${identity.account_id}:${identity.native_sender_id}`} className="mono">
                        {identity.account_id} / {identity.native_sender_id}
                        {identity.display_name === null ? "" : `（${identity.display_name}）`}
                      </span>
                    ))
                  )}
                </div>
                <div className="grant-checks">
                  {CONTACT_CAPABILITY_CATEGORIES.map((category) => (
                    <label key={category} className="checkbox-row inline">
                      <input
                        type="checkbox"
                        checked={categories.includes(category)}
                        onChange={() =>
                          setDrafts({
                            ...drafts,
                            [contact.contact_id]: toggleCategory(categories, category),
                          })
                        }
                      />
                      {contactCategoryLabel(category)}
                    </label>
                  ))}
                </div>
                <p className="hint-inline">当前授权：{grantSelectionSummary(categories)}</p>
              </div>
              <div className="contact-actions">
                <button
                  className="btn primary"
                  disabled={busy === contact.contact_id}
                  onClick={() => void saveGrants(contact)}
                >
                  {busy === contact.contact_id ? "保存中…" : "保存授权"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="ambiguity-block">
        <h5>身份歧义待裁决</h5>
        {ambiguities.length === 0 ? (
          <p className="hint-inline">没有待裁决的身份歧义。</p>
        ) : (
          <ul className="ambiguity-list">
            {ambiguities.map((ambiguity) => (
              <li key={ambiguity.ambiguity_id} className="ambiguity-row">
                <div>
                  <div className="mono">
                    {ambiguity.account_id} / {ambiguity.native_sender_id}
                  </div>
                  <div className="hint-inline">
                    候选：{ambiguity.candidate_contact_ids.length} 个 · 发生于 {relativeTime(ambiguity.created_at, nowMs)}
                  </div>
                </div>
                <select
                  value={choices[ambiguity.ambiguity_id] ?? ambiguity.candidate_contact_ids[0] ?? ""}
                  onChange={(event) =>
                    setChoices({ ...choices, [ambiguity.ambiguity_id]: event.target.value })
                  }
                >
                  {ambiguity.candidate_contact_ids.map((contactId) => {
                    const contact = contacts.find((candidate) => candidate.contact_id === contactId);
                    return (
                      <option key={contactId} value={contactId}>
                        {contact?.display_name ?? contactId}
                      </option>
                    );
                  })}
                </select>
                <button
                  className="btn"
                  disabled={busy === ambiguity.ambiguity_id}
                  onClick={() => void resolveAmbiguity(ambiguity)}
                >
                  选择此人
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// --- 4. 通知规则 --------------------------------------------------------------------

function NotificationRulesSection({ base, channels }: { base: string; channels: ChannelSummary[] }) {
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
      setError(readableError(err, "保存通知规则失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="task-section channel-section">
      <div className="section-head">
        <h4>通知规则</h4>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? "读取中…" : "刷新"}
        </button>
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
            <button className="btn danger" onClick={() => setDrafts(drafts.filter((_v, pos) => pos !== index))}>
              删除
            </button>
          </div>
        ))}
      </div>
      <div className="form-actions">
        <button
          className="btn"
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
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存规则"}
        </button>
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

// --- 5. Outbox 待核对 ---------------------------------------------------------------

function OutboxSection({ base, nowMs }: { base: string; nowMs: number }) {
  const [review, setReview] = useState<OutboxMessageRecord[]>([]);
  const [sent, setSent] = useState<OutboxMessageRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    const confirm = retryConfirmed(record);
    if (
      confirm &&
      !window.confirm(
        "这条消息可能已经送达平台。重发可能造成重复消息——确认已线下核对、仍要重发吗？",
      )
    ) {
      return;
    }
    setBusy(record.id);
    setError(null);
    setMessage(null);
    try {
      await api.retryOutbox(base, record.id, confirm);
      setMessage("已重置为待投递，由 Outbox 投递器按幂等键发送。");
      await load();
    } catch (err) {
      setError(readableError(err, state.retryRequiresConfirm ? "重发失败（需确认）" : "重发失败"));
    } finally {
      setBusy(null);
    }
  };

  const markSent = async (record: OutboxMessageRecord) => {
    if (!window.confirm("标记为已送达？将写入人工回执（manual receipt）并留审计，不会重新发送。")) {
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
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? "读取中…" : "刷新"}
        </button>
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
                <button
                  className="btn"
                  disabled={!actions.canRetry || busy === record.id}
                  title={actions.disabledReason ?? ""}
                  onClick={() => void retry(record)}
                >
                  {busy === record.id ? "处理中…" : actions.retryLabel}
                </button>
                <button
                  className="btn"
                  disabled={!actions.canMarkSent || busy === record.id}
                  onClick={() => void markSent(record)}
                >
                  标记已送达
                </button>
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
    </section>
  );
}

// --- 辅助 ---------------------------------------------------------------------------

function sortByUpdated(messages: OutboxMessageRecord[]): OutboxMessageRecord[] {
  return [...messages].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

function relativeTime(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const delta = Math.max(0, nowMs - at);
  if (delta < 60_000) return "刚刚";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return iso.slice(0, 16).replace("T", " ");
}

function readableError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "network_error") return `${fallback}：${err.message}`;
    return `${fallback}（${err.code}）：${err.message}`;
  }
  return `${fallback}：${err instanceof Error ? err.message : String(err)}`;
}
