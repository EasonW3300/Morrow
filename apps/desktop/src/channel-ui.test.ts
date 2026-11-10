/**
 * 渠道与联系人 UI 纯逻辑测试（M4-T8 / Issue #45）。
 *
 * 覆盖：capabilities 徽标（主动消息 limited → 「受限」，绝不显示「可用」）、
 * health 投影（连接/token 到期/最近错误/本地桥）、微信风险确认启用门状态机、
 * 白名单草稿校验、联系人授权与邀请码倒计时、通知规则（target/免打扰/跨天/去重）、
 * Outbox 人工核对操作状态机与凭据表单校验。node:test + 零网络；React 只做装配。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChannelCapabilities,
  ChannelHealth,
  ChannelSecretsView,
  ContactGrantView,
  NotificationRule,
  OutboxMessageRecord,
} from "@morrow/protocol/browser";
import {
  allowlistFromEntries,
  buildSecretsPayload,
  capabilityBadges,
  channelDisplayName,
  channelStateLabel,
  channelTypeLabel,
  contactCategoryLabel,
  credentialFormInitial,
  credentialSummary,
  describeChannelHealth,
  experimentalEnableGate,
  grantSelectionSummary,
  grantedCategories,
  inviteCountdown,
  isCredentialConfigurable,
  notificationTargetOptions,
  outboxActionState,
  outboxFailureLabel,
  outboxPayloadSummary,
  outboxTargetLabel,
  proactiveMessageRestricted,
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
  validateNotificationRuleDraft,
  validateQuietHours,
} from "./channel-ui.ts";

const SUPPORTED_CAPS: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  group_proactive: "limited",
  attachments: "limited",
  edit: "unsupported",
};

function health(partial: Partial<ChannelHealth> = {}): ChannelHealth {
  return {
    channel_id: "feishu",
    state: "running",
    healthy: true,
    detail: null,
    checked_at: "2026-11-10T10:00:00.000Z",
    connection: "connected",
    token_expires_at: "2026-11-10T12:00:00.000Z",
    last_error: null,
    ...partial,
  };
}

function outbox(partial: Partial<OutboxMessageRecord> & { status: OutboxMessageRecord["status"] }): OutboxMessageRecord {
  return {
    id: "ob-1",
    idempotency_key: "key-1",
    channel_id: "feishu",
    account_id: "feishu-default",
    target: { kind: "conversation", id: "oc_1" },
    payload: { text: "hello" },
    attempts: 2,
    last_error: null,
    receipt: null,
    causation_id: null,
    task_id: null,
    last_attempt_at: null,
    next_attempt_at: null,
    created_at: "2026-11-10T10:00:00.000Z",
    updated_at: "2026-11-10T10:00:00.000Z",
    ...partial,
  };
}

// --- capabilities ------------------------------------------------------------------

test("capabilityBadges：limited 显示「受限」、unsupported 显示「不可用」、supported 显示「可用」", () => {
  const badges = capabilityBadges(SUPPORTED_CAPS);
  const byKey = new Map(badges.map((badge) => [badge.key, badge]));
  assert.equal(byKey.get("direct_message")?.valueLabel, "可用");
  assert.equal(byKey.get("group_proactive")?.valueLabel, "受限");
  assert.equal(byKey.get("group_proactive")?.tone, "warn");
  assert.match(byKey.get("group_proactive")?.hint ?? "", /频控/);
  assert.equal(byKey.get("attachments")?.valueLabel, "受限");
  assert.equal(byKey.get("edit")?.valueLabel, "不可用");
  assert.equal(byKey.get("edit")?.tone, "muted");
});

test("capabilityBadges：任何适配器的主动消息维度都不会显示「可用」", () => {
  for (const proactive of ["limited", "unsupported"] as const) {
    const badges = capabilityBadges({ ...SUPPORTED_CAPS, group_proactive: proactive });
    assert.notEqual(badges.find((badge) => badge.key === "group_proactive")?.valueLabel, "可用");
  }
  assert.equal(proactiveMessageRestricted({ ...SUPPORTED_CAPS, group_proactive: "limited" }), true);
});

test("渠道命名/类型/状态与凭据可配置性映射", () => {
  assert.equal(channelDisplayName("feishu"), "飞书");
  assert.equal(channelDisplayName("unknown"), "unknown");
  assert.equal(channelTypeLabel({ experimental: true }), "实验适配器");
  assert.equal(channelTypeLabel({ experimental: false }), "稳定适配器");
  assert.equal(channelStateLabel("running"), "运行中");
  assert.equal(channelStateLabel("stopped"), "已停止");
  assert.equal(isCredentialConfigurable("feishu"), true);
  assert.equal(isCredentialConfigurable("qq"), true);
  assert.equal(isCredentialConfigurable("wechat"), false);
});

// --- health ------------------------------------------------------------------------

test("describeChannelHealth：token 未到期显示剩余时长，过期显示「已过期」", () => {
  const now = Date.parse("2026-11-10T10:00:00.000Z");
  const fresh = describeChannelHealth(health(), now);
  assert.equal(fresh.tone, "ok");
  assert.equal(fresh.connectionLabel, "已连接");
  assert.equal(fresh.tokenLabel, "剩余 2 小时");
  assert.equal(fresh.tokenExpired, false);

  const soon = describeChannelHealth(
    health({ token_expires_at: "2026-11-10T10:08:00.000Z" }),
    now,
  );
  assert.equal(soon.tokenTone, "warn");
  assert.equal(soon.tokenLabel, "剩余 8 分钟");

  const expired = describeChannelHealth(health({ healthy: false, token_expires_at: "2026-11-10T09:00:00.000Z" }), now);
  assert.equal(expired.tokenLabel, "已过期");
  assert.equal(expired.tokenExpired, true);
  assert.equal(expired.tone, "warn");
});

test("describeChannelHealth：无 token 概念/无缓存/降级连接与最近错误如实呈现", () => {
  const now = Date.parse("2026-11-10T10:00:00.000Z");
  const noToken = describeChannelHealth(
    { channel_id: "wechat", state: "running", healthy: true, detail: null, checked_at: "x", experimental: true },
    now,
  );
  assert.equal(noToken.tokenLabel, "—（无 token 概念）");
  assert.equal(noToken.connectionLabel, "未知");

  const degraded = describeChannelHealth(
    health({
      state: "running",
      healthy: false,
      connection: "degraded",
      token_expires_at: null,
      last_error: "token endpoint failed",
      bridge: { process: "running", login: "logged_out", window: "unavailable", last_error: "logged out" },
    }),
    now,
  );
  assert.equal(degraded.connectionLabel, "降级");
  assert.equal(degraded.connectionTone, "error");
  assert.equal(degraded.lastError, "token endpoint failed");
  assert.match(degraded.bridgeLabel ?? "", /logged_out/);
  assert.equal(degraded.tone, "warn");
});

// --- 微信风险确认 -------------------------------------------------------------------

test("experimentalEnableGate：未勾选确认时禁用并说明原因；勾选后放行带 confirm_risk 的启用", () => {
  const notice = "实验功能，可能封号，风险自担";
  const blocked = experimentalEnableGate({
    experimental: true,
    enabled: false,
    riskConfirmed: false,
    riskNotice: notice,
  });
  assert.equal(blocked.mode, "confirm_required");
  assert.equal(blocked.canSubmit, false);
  assert.equal(blocked.buttonLabel, "确认启用（自担风险）");
  assert.match(blocked.disabledReason ?? "", /勾选确认风险声明/);

  const ready = experimentalEnableGate({ experimental: true, enabled: false, riskConfirmed: true, riskNotice: notice });
  assert.equal(ready.mode, "ready");
  assert.equal(ready.canSubmit, true);
  assert.equal(ready.disabledReason, null);

  const enabled = experimentalEnableGate({ experimental: true, enabled: true, riskConfirmed: true, riskNotice: notice });
  assert.equal(enabled.mode, "enabled");
  assert.equal(enabled.buttonLabel, "停用");
  assert.equal(enabled.canSubmit, false);
});

test("experimentalEnableGate：风险文案缺失时 fail-closed（即使已勾选也不可启用）", () => {
  const missing = experimentalEnableGate({
    experimental: true,
    enabled: false,
    riskConfirmed: true,
    riskNotice: "   ",
  });
  assert.equal(missing.noticePresent, false);
  assert.equal(missing.canSubmit, false);
  assert.match(missing.disabledReason ?? "", /fail-closed/);

  const stable = experimentalEnableGate({ experimental: false, enabled: true, riskConfirmed: false, riskNotice: null });
  assert.equal(stable.mode, "not_experimental");
  assert.equal(stable.canSubmit, false);
});

test("riskConsentState：未勾选/提交中不可确认，勾选且文案存在才允许", () => {
  assert.equal(riskConsentState({ open: true, confirmed: false, submitting: false, riskNotice: "风险" }).canConfirm, false);
  assert.equal(riskConsentState({ open: true, confirmed: true, submitting: true, riskNotice: "风险" }).canConfirm, false);
  assert.equal(riskConsentState({ open: true, confirmed: true, submitting: true, riskNotice: "风险" }).reason, "正在启用…");
  assert.equal(riskConsentState({ open: true, confirmed: true, submitting: false, riskNotice: "风险" }).canConfirm, true);
  assert.equal(riskConsentState({ open: true, confirmed: true, submitting: false, riskNotice: "" }).canConfirm, false);
});

// --- 白名单 ------------------------------------------------------------------------

test("validateAllowlistRows：空 id/重复 id/非法模式分别拒绝，合法行通过", () => {
  assert.match(validateAllowlistRows([{ native_conversation_id: "  ", mode: "mention_only" }]) ?? "", /不能为空/);
  assert.match(
    validateAllowlistRows([
      { native_conversation_id: "g1", mode: "mention_only" },
      { native_conversation_id: " g1 ", mode: "proactive_limited" },
    ]) ?? "",
    /重复/,
  );
  assert.match(
    validateAllowlistRows([{ native_conversation_id: "g1", mode: "bogus" as never }]) ?? "",
    /模式不合法/,
  );
  assert.equal(
    validateAllowlistRows([
      { native_conversation_id: "g1", mode: "mention_only" },
      { native_conversation_id: "g2", mode: "proactive_limited" },
    ]),
    null,
  );
});

test("allowlistFromEntries/toAllowlistPayload：只保留 id+mode 并 trim", () => {
  const drafts = allowlistFromEntries([
    { native_conversation_id: "g1", mode: "mention_only", created_at: "2026-11-10T00:00:00Z" },
  ]);
  assert.deepEqual(drafts, [{ native_conversation_id: "g1", mode: "mention_only" }]);
  assert.deepEqual(toAllowlistPayload([{ native_conversation_id: " g2 ", mode: "proactive_limited" }]), [
    { native_conversation_id: "g2", mode: "proactive_limited" },
  ]);
});

// --- 联系人 ------------------------------------------------------------------------

function grant(category: ContactGrantView["category"]): ContactGrantView {
  return {
    category,
    scope: [],
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-10T00:00:00.000Z",
  };
}

test("联系人授权：类别勾选保持协议顺序、未知类别拒绝、空选择明确说明无授权", () => {
  const current = grantedCategories([grant("task_execute"), grant("query")]);
  assert.deepEqual(current, ["query", "task_execute"]);
  assert.deepEqual(toggleCategory(current, "memory_reference"), ["query", "task_execute", "memory_reference"]);
  assert.deepEqual(toggleCategory(current, "query"), ["task_execute"]);
  assert.equal(validateGrantSelection(["query", "nope"]), "未知授权类别「nope」");
  assert.equal(validateGrantSelection(["query"]), null);
  assert.equal(grantSelectionSummary([]), "无授权（不能访问任何内容）");
  assert.match(grantSelectionSummary(["query"]), /查询问答/);
  assert.deepEqual(toGrantsPayload(["query", "task_execute"]), [
    { category: "query", scope: [] },
    { category: "task_execute", scope: [] },
  ]);
  assert.equal(contactCategoryLabel("memory_reference"), "记忆引用（仅 public）");
});

test("validateDisplayName：空值合法（默认名），超长拒绝", () => {
  assert.equal(validateDisplayName(""), null);
  assert.equal(validateDisplayName("   "), null);
  assert.equal(validateDisplayName("张三"), null);
  assert.match(validateDisplayName("x".repeat(65)) ?? "", /64/);
});

test("inviteCountdown：小时级显示剩余小时，分钟级 mm:ss，过期提示", () => {
  const now = Date.parse("2026-11-10T10:00:00.000Z");
  const day = inviteCountdown("2026-11-11T09:30:00.000Z", now);
  assert.equal(day.expired, false);
  assert.match(day.label, /剩余 23 小时 30 分/);
  const minutes = inviteCountdown("2026-11-10T10:12:34.000Z", now);
  assert.equal(minutes.label, "剩余 12:34");
  const expired = inviteCountdown("2026-11-10T09:00:00.000Z", now);
  assert.equal(expired.expired, true);
  assert.equal(expired.label, "已过期");
});

// --- 通知规则 ----------------------------------------------------------------------

function rule(partial: Partial<NotificationRule> = {}): NotificationRule {
  return {
    rule_id: "rule-1",
    event_type: "completed",
    target: "desktop",
    quiet_hours: null,
    enabled: true,
    created_at: "2026-11-10T00:00:00.000Z",
    updated_at: "2026-11-10T00:00:00.000Z",
    ...partial,
  };
}

test("通知目标候选：桌面 + 每个注册渠道，标签可读", () => {
  const options = notificationTargetOptions([{ channel_id: "feishu" }, { channel_id: "wechat" }]);
  assert.deepEqual(options.map((option) => option.value), ["desktop", "channel:feishu", "channel:wechat"]);
  assert.equal(options[1]?.label, "渠道 · 飞书");
});

test("quiet_hours 校验：HH:MM 合法、跨天合法、起止相同与格式错误拒绝", () => {
  assert.equal(validateQuietHours(null), null);
  assert.equal(validateQuietHours({ start: "22:00", end: "08:00" }), null);
  assert.equal(validateQuietHours({ start: "00:00", end: "23:59" }), null);
  assert.match(validateQuietHours({ start: "8:00", end: "09:00" }) ?? "", /HH:MM/);
  assert.match(validateQuietHours({ start: "25:00", end: "08:00" }) ?? "", /HH:MM/);
  assert.match(validateQuietHours({ start: "08:00", end: "08:00" }) ?? "", /相同/);
});

test("通知规则草稿：target 形态校验、整表 key 去重、toRuleInput 只带协议字段", () => {
  const valid = rulesToDrafts([rule({ target: "channel:feishu", event_type: "milestone" })]);
  assert.equal(validateNotificationRuleDraft(valid[0]), null);
  assert.equal(validateNotificationDrafts(valid), null);

  const badTarget = rulesToDrafts([rule({ target: "slack:#x" })]);
  assert.match(validateNotificationRuleDraft(badTarget[0]) ?? "", /desktop 或 channel:/);

  const duplicate = rulesToDrafts([rule(), rule({ rule_id: "rule-2" })]);
  assert.match(validateNotificationDrafts(duplicate) ?? "", /重复/);

  const input = toRuleInput({
    rule_id: "rule-1",
    event_type: "failed",
    target: " channel:qq ",
    quiet_hours: { start: "22:00", end: "08:00" },
    enabled: false,
  });
  assert.deepEqual(input, {
    event_type: "failed",
    target: "channel:qq",
    quiet_hours: { start: "22:00", end: "08:00" },
    enabled: false,
  });
});

// --- Outbox ------------------------------------------------------------------------

test("outboxActionState：needs_review/delivery_unknown 重发必须确认，failed 直接重发", () => {
  const failed = outboxActionState(outbox({ status: "failed" }));
  assert.equal(failed.canRetry, true);
  assert.equal(failed.retryRequiresConfirm, false);
  assert.equal(failed.canMarkSent, true);
  assert.equal(retryConfirmed(outbox({ status: "failed" })), false);

  for (const status of ["needs_review", "delivery_unknown"] as const) {
    const state = outboxActionState(outbox({ status }));
    assert.equal(state.canRetry, true);
    assert.equal(state.retryRequiresConfirm, true);
    assert.equal(state.retryLabel, "我已核对，重发");
    assert.equal(state.canMarkSent, true);
    assert.equal(retryConfirmed(outbox({ status })), true);
  }
});

test("outboxActionState：pending/sent 无人工操作且说明原因", () => {
  assert.equal(outboxActionState(outbox({ status: "pending" })).canRetry, false);
  assert.match(outboxActionState(outbox({ status: "pending" })).disabledReason ?? "", /等待自动投递/);
  assert.equal(outboxActionState(outbox({ status: "sent" })).canMarkSent, false);
  assert.match(outboxActionState(outbox({ status: "sent" })).disabledReason ?? "", /仅供对照/);
});

test("Outbox 摘要/目标/失败原因可读且截断", () => {
  assert.equal(outboxPayloadSummary({ text: "hello" }), "hello");
  assert.equal(outboxPayloadSummary({ title: "标题" }), "标题");
  assert.equal(outboxPayloadSummary({ other: 1 }), JSON.stringify({ other: 1 }));
  const long = outboxPayloadSummary({ text: "x".repeat(200) });
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
  assert.equal(outboxTargetLabel(outbox({ status: "failed" })), "会话 · oc_1");
  assert.equal(outboxFailureLabel(outbox({ status: "failed", last_error: "403 forbidden" })), "403 forbidden");
  assert.equal(outboxFailureLabel(outbox({ status: "needs_review", last_error: null })), "需核对是否已送达");
});

// --- 凭据表单 ----------------------------------------------------------------------

function secretsView(): ChannelSecretsView {
  return {
    channel_id: "feishu",
    secret_service: "channel:feishu",
    fields: [
      { field: "app_id", configured: true, required: true },
      { field: "app_secret", configured: false, required: true },
      { field: "bot_open_id", configured: false, required: false },
    ],
  };
}

test("validateCredentialForm：必填未配置必须填写；已配置留空保持；只提交非空字段", () => {
  const view = secretsView();
  const errors = validateCredentialForm(view, credentialFormInitial(view));
  assert.deepEqual(errors, { app_secret: "必填：尚未配置" });

  const filled = validateCredentialForm(view, { app_id: "", app_secret: " new-secret ", bot_open_id: "" });
  assert.deepEqual(filled, {});
  assert.deepEqual(buildSecretsPayload({ app_id: "", app_secret: " new-secret ", bot_open_id: "  " }), {
    app_secret: "new-secret",
  });
});

test("credentialSummary：缺失必填项逐项列出，齐全时报配置数量（不含值）", () => {
  assert.match(credentialSummary(secretsView()), /缺少必填凭据：App Secret/);
  assert.equal(
    credentialSummary({
      channel_id: "qq",
      secret_service: "channel:qq",
      fields: [
        { field: "app_id", configured: true, required: true },
        { field: "app_secret", configured: true, required: true },
      ],
    }),
    "已配置 2/2 个字段",
  );
});
