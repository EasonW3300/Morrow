/**
 * 渠道与联系人 UI 纯逻辑（M4-T8 / Issue #45；PRD §5.1 设置→渠道管理、§4.4、§4.8）。
 *
 * React（ChannelsView）只做装配；本模块承载全部可测决策：
 *   - capabilities 徽标映射：主动消息只允许 supported/limited，limited 必须显示「受限」
 *     而不是「可用」（FR-CH-2 诚实交付）；
 *   - health 投影：连接态 / token 到期倒计时 / 最近错误 / 本地桥；
 *   - 微信实验适配器的启用门状态机（风险确认勾选前后、风险文案缺失时 fail-closed）；
 *   - 群聊白名单草稿校验（会话 id 非空、去重、模式枚举）；
 *   - 联系人授权类别勾选与邀请码倒计时；
 *   - 通知规则草稿校验（target 形态、免打扰 HH:MM、跨天合法、起止相同拒绝、key 去重）；
 *   - Outbox 待核对操作状态机（failed / delivery_unknown / needs_review、needs_review
 *     重发必须二次确认）。
 *
 * 类型一律从 `@morrow/protocol/browser` 引（主入口有浏览器守卫测试）。
 */
import {
  CONTACT_CAPABILITY_CATEGORIES,
  NOTIFICATION_EVENT_TYPE_VALUES,
  type ChannelAllowMode,
  type ChannelAllowlistEntryView,
  type ChannelCapabilities,
  type ChannelFeatureSupport,
  type ChannelHealth,
  type ChannelSecretsView,
  type ChannelSummary,
  type ContactCapabilityCategory,
  type ContactGrantView,
  type NotificationEventType,
  type NotificationQuietHours,
  type NotificationRule,
  type NotificationRuleInput,
  type OutboxMessageRecord,
  type OutboxStatus,
} from "@morrow/protocol/browser";

// --- 渠道命名与状态 ---------------------------------------------------------------

const CHANNEL_NAMES: Record<string, string> = {
  feishu: "飞书",
  qq: "QQ 官方 Bot",
  wechat: "微信个人号（实验）",
  echo: "Echo 参考适配器",
};

export function channelDisplayName(channelId: string): string {
  return CHANNEL_NAMES[channelId] ?? channelId;
}

export function channelTypeLabel(channel: Pick<ChannelSummary, "experimental">): string {
  return channel.experimental ? "实验适配器" : "稳定适配器";
}

/** 渠道状态中文（ChannelAdapterState 全量；未知值原样显示，不臆造） */
export function channelStateLabel(state: string): string {
  switch (state) {
    case "registered":
      return "已注册";
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "stopped":
      return "已停止";
    case "error":
      return "错误";
    default:
      return state;
  }
}

export function channelStateTone(state: string): "ok" | "warn" | "error" | "muted" {
  switch (state) {
    case "running":
      return "ok";
    case "starting":
    case "registered":
      return "warn";
    case "error":
      return "error";
    default:
      return "muted";
  }
}

/** 只有飞书/QQ 有 SecretStore 凭据；微信（本地桥）与 echo（参考）没有 */
export function isCredentialConfigurable(channelId: string): boolean {
  return channelId === "feishu" || channelId === "qq";
}

// --- capabilities 徽标 -------------------------------------------------------------

const CAPABILITY_DIMENSIONS: Array<{
  key: keyof ChannelCapabilities;
  label: string;
  proactive?: boolean;
}> = [
  { key: "direct_message", label: "私聊" },
  { key: "group_mention", label: "群聊 @" },
  { key: "group_proactive", label: "群聊主动消息", proactive: true },
  { key: "attachments", label: "附件" },
  { key: "edit", label: "编辑消息" },
];

export interface CapabilityBadge {
  key: keyof ChannelCapabilities;
  label: string;
  value: ChannelFeatureSupport;
  /** 「可用」/「受限」/「不可用」——limited 绝不显示为可用 */
  valueLabel: "可用" | "受限" | "不可用";
  tone: "ok" | "warn" | "muted";
  hint: string;
}

function supportValueLabel(value: ChannelFeatureSupport): CapabilityBadge["valueLabel"] {
  if (value === "supported") return "可用";
  if (value === "limited") return "受限";
  return "不可用";
}

function supportTone(value: ChannelFeatureSupport): CapabilityBadge["tone"] {
  if (value === "supported") return "ok";
  if (value === "limited") return "warn";
  return "muted";
}

/**
 * 五维能力徽标。主动消息维度额外说明平台限制（FR-CH-2）：limited = 「受限」，
 * 永不出现「可用」；契约层虽已禁止 supported，这里仍按 fail-closed 映射兜底。
 */
export function capabilityBadges(capabilities: ChannelCapabilities): CapabilityBadge[] {
  return CAPABILITY_DIMENSIONS.map((dimension) => {
    const value = capabilities[dimension.key];
    const valueLabel = supportValueLabel(value);
    return {
      key: dimension.key,
      label: dimension.label,
      value,
      valueLabel,
      tone: supportTone(value),
      hint:
        dimension.proactive === true
          ? value === "unsupported"
            ? "平台不提供主动消息，不做承诺"
            : "平台有频控/场景限制，仅许可范围内的有限主动消息"
          : value === "limited"
            ? "只能部分做到，请以实际平台能力为准"
            : value === "unsupported"
              ? "平台不提供该能力"
              : "平台协议可直接做到",
    };
  });
}

/** 主动消息是否受限（UI 顶部警示用）：契约上永不为 supported，仍按值判定 */
export function proactiveMessageRestricted(capabilities: ChannelCapabilities): boolean {
  return capabilities.group_proactive !== ("supported" as ChannelCapabilities["group_proactive"]);
}

// --- health 投影 -------------------------------------------------------------------

export interface ChannelHealthView {
  healthy: boolean;
  tone: "ok" | "warn" | "error";
  stateLabel: string;
  connectionLabel: string;
  connectionTone: "ok" | "warn" | "error" | "muted";
  tokenLabel: string;
  tokenTone: "ok" | "warn" | "error" | "muted";
  tokenExpired: boolean;
  lastError: string | null;
  detail: string | null;
  bridgeLabel: string | null;
}

const CONNECTION_LABELS: Record<NonNullable<ChannelHealth["connection"]>, string> = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "未连接",
  degraded: "降级",
};

function formatTokenExpiry(health: ChannelHealth, nowMs: number): Pick<
  ChannelHealthView,
  "tokenLabel" | "tokenTone" | "tokenExpired"
> {
  if (!("token_expires_at" in health)) {
    return { tokenLabel: "—（无 token 概念）", tokenTone: "muted", tokenExpired: false };
  }
  const raw = health.token_expires_at;
  if (raw === null || raw === undefined) {
    return { tokenLabel: "无缓存 token", tokenTone: "warn", tokenExpired: false };
  }
  const expiresMs = Date.parse(raw);
  if (Number.isNaN(expiresMs)) {
    return { tokenLabel: "到期时间未知", tokenTone: "warn", tokenExpired: false };
  }
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) {
    return { tokenLabel: "已过期", tokenTone: "error", tokenExpired: true };
  }
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) {
    // 适配器默认提前 5 分钟刷新；<15 分钟即提示临期
    return {
      tokenLabel: `剩余 ${Math.max(1, minutes)} 分钟`,
      tokenTone: minutes <= 15 ? "warn" : "ok",
      tokenExpired: false,
    };
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return {
    tokenLabel: `剩余 ${hours} 小时${restMinutes === 0 ? "" : ` ${restMinutes} 分`}`,
    tokenTone: "ok",
    tokenExpired: false,
  };
}

/** GET /v1/channels/:id/health → 可读健康投影（真实数据，无推测） */
export function describeChannelHealth(health: ChannelHealth, nowMs: number): ChannelHealthView {
  const connection = health.connection;
  const connectionLabel = connection === undefined ? "未知" : CONNECTION_LABELS[connection];
  const connectionTone: ChannelHealthView["connectionTone"] =
    connection === "connected"
      ? "ok"
      : connection === "connecting"
        ? "warn"
        : connection === "degraded" || connection === "disconnected"
          ? "error"
          : "muted";
  const token = formatTokenExpiry(health, nowMs);
  const bridge = health.bridge;
  return {
    healthy: health.healthy,
    tone: health.healthy ? "ok" : health.state === "running" ? "warn" : "error",
    stateLabel: channelStateLabel(health.state),
    connectionLabel,
    connectionTone,
    ...token,
    lastError: health.last_error ?? null,
    detail: health.detail,
    bridgeLabel:
      bridge === undefined
        ? null
        : `进程 ${bridge.process} / 登录 ${bridge.login} / 窗口 ${bridge.window}`,
  };
}

// --- 微信实验启用门（风险确认状态机） ------------------------------------------------

export type ExperimentalGateMode = "not_experimental" | "enabled" | "confirm_required" | "ready";

export interface ExperimentalGate {
  mode: ExperimentalGateMode;
  /** 是否可提交「启用（带 confirm_risk=true）」 */
  canSubmit: boolean;
  buttonLabel: string;
  /** 按钮禁用原因（UI 必须说明，不能只灰掉） */
  disabledReason: string | null;
  /** 风险声明是否可用（缺失时 fail-closed，禁止启用） */
  noticePresent: boolean;
}

/**
 * 实验适配器启用门：
 *   - 非实验适配器：不提供实验启用入口（稳定适配器随 Runtime 启动）；
 *   - 已启用：按钮语义变为「停用」（由调用方处理），本门只报 mode；
 *   - 未启用 + 未勾选确认 → 禁用并说明原因；
 *   - 已勾选 + 风险文案存在 → 可提交；风险文案缺失 → 仍然禁用（fail-closed）。
 */
export function experimentalEnableGate(input: {
  experimental: boolean;
  enabled: boolean;
  riskConfirmed: boolean;
  riskNotice: string | null | undefined;
}): ExperimentalGate {
  const notice = typeof input.riskNotice === "string" ? input.riskNotice.trim() : "";
  const noticePresent = notice.length > 0;
  if (!input.experimental) {
    return {
      mode: "not_experimental",
      canSubmit: false,
      buttonLabel: "启用",
      disabledReason: "稳定适配器随 Runtime 启动，没有实验启用门",
      noticePresent,
    };
  }
  if (input.enabled) {
    return { mode: "enabled", canSubmit: false, buttonLabel: "停用", disabledReason: null, noticePresent };
  }
  if (!noticePresent) {
    return {
      mode: "confirm_required",
      canSubmit: false,
      buttonLabel: "确认启用（自担风险）",
      disabledReason: "风险声明缺失，禁止启用（fail-closed）",
      noticePresent,
    };
  }
  if (!input.riskConfirmed) {
    return {
      mode: "confirm_required",
      canSubmit: false,
      buttonLabel: "确认启用（自担风险）",
      disabledReason: "请先阅读并勾选确认风险声明",
      noticePresent,
    };
  }
  return { mode: "ready", canSubmit: true, buttonLabel: "确认启用（自担风险）", disabledReason: null, noticePresent };
}

export interface RiskConsentState {
  open: boolean;
  confirmed: boolean;
  submitting: boolean;
  canConfirm: boolean;
  /** 风险声明是否存在（缺失时勾选框也应禁用） */
  noticePresent: boolean;
  reason: string | null;
}

/** 风险确认弹窗状态：未勾选或提交中不可确认；文案缺失时直接给出阻断原因 */
export function riskConsentState(input: {
  open: boolean;
  confirmed: boolean;
  submitting: boolean;
  riskNotice: string | null | undefined;
}): RiskConsentState {
  const notice = typeof input.riskNotice === "string" ? input.riskNotice.trim() : "";
  if (!notice) {
    return {
      open: input.open,
      confirmed: input.confirmed,
      submitting: input.submitting,
      canConfirm: false,
      noticePresent: false,
      reason: "风险声明缺失，无法确认",
    };
  }
  if (input.submitting) {
    return {
      open: input.open,
      confirmed: input.confirmed,
      submitting: true,
      canConfirm: false,
      noticePresent: true,
      reason: "正在启用…",
    };
  }
  if (!input.confirmed) {
    return {
      open: input.open,
      confirmed: false,
      submitting: false,
      canConfirm: false,
      noticePresent: true,
      reason: "请勾选「我已阅读并理解上述风险」",
    };
  }
  return {
    open: input.open,
    confirmed: true,
    submitting: false,
    canConfirm: true,
    noticePresent: true,
    reason: null,
  };
}

// --- 群聊白名单 ---------------------------------------------------------------------

export const ALLOW_MODES: readonly ChannelAllowMode[] = ["mention_only", "proactive_limited"];

export function allowModeLabel(mode: ChannelAllowMode): string {
  return mode === "mention_only" ? "仅 @ 回复" : "有限主动消息";
}

export interface AllowlistDraftRow {
  native_conversation_id: string;
  mode: ChannelAllowMode;
}

export function normalizeConversationId(raw: string): string {
  return raw.trim();
}

export function allowlistFromEntries(entries: ChannelAllowlistEntryView[]): AllowlistDraftRow[] {
  return entries.map((entry) => ({
    native_conversation_id: entry.native_conversation_id,
    mode: entry.mode,
  }));
}

/**
 * 白名单草稿校验：返回第一条错误（null = 全部合法）。
 * 与 PUT 端点同口径：会话 id 非空且不重复、模式必须在枚举内。
 */
export function validateAllowlistRows(rows: AllowlistDraftRow[]): string | null {
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const id = normalizeConversationId(row.native_conversation_id);
    if (id.length === 0) return `第 ${index + 1} 行：会话 id 不能为空`;
    if (seen.has(id)) return `会话 id「${id}」重复`;
    if (!ALLOW_MODES.includes(row.mode)) return `第 ${index + 1} 行：模式不合法（${row.mode}）`;
    seen.add(id);
  }
  return null;
}

export function toAllowlistPayload(rows: AllowlistDraftRow[]): AllowlistDraftRow[] {
  return rows.map((row) => ({ native_conversation_id: normalizeConversationId(row.native_conversation_id), mode: row.mode }));
}

// --- 可信联系人 ---------------------------------------------------------------------

export const CONTACT_CATEGORY_LABELS: Record<ContactCapabilityCategory, string> = {
  query: "查询问答",
  task_execute: "任务执行",
  memory_reference: "记忆引用（仅 public）",
};

export function contactCategoryLabel(category: ContactCapabilityCategory): string {
  return CONTACT_CATEGORY_LABELS[category] ?? category;
}

/** 联系人当前已授权类别（保持协议顺序，UI 勾选状态与后端一致） */
export function grantedCategories(grants: ContactGrantView[]): ContactCapabilityCategory[] {
  const present = new Set(grants.map((grant) => grant.category));
  return CONTACT_CAPABILITY_CATEGORIES.filter((category) => present.has(category));
}

export function toggleCategory(
  categories: ContactCapabilityCategory[],
  category: ContactCapabilityCategory,
): ContactCapabilityCategory[] {
  const next = new Set(categories);
  if (next.has(category)) next.delete(category);
  else next.add(category);
  return CONTACT_CAPABILITY_CATEGORIES.filter((value) => next.has(value));
}

export function isContactCategory(value: string): value is ContactCapabilityCategory {
  return (CONTACT_CAPABILITY_CATEGORIES as readonly string[]).includes(value);
}

/** 授权选择校验：不认识的类别拒绝；空选择合法但 UI 必须说明「无授权」 */
export function validateGrantSelection(categories: string[]): string | null {
  for (const category of categories) {
    if (!isContactCategory(category)) return `未知授权类别「${category}」`;
  }
  return null;
}

export function grantSelectionSummary(categories: ContactCapabilityCategory[]): string {
  if (categories.length === 0) return "无授权（不能访问任何内容）";
  return categories.map(contactCategoryLabel).join(" / ");
}

/** grants 请求载荷：scope 留空（类别级授权，细粒度 scope 当前不由 UI 编辑） */
export function toGrantsPayload(categories: ContactCapabilityCategory[]): Array<{ category: ContactCapabilityCategory; scope: string[] }> {
  return categories.map((category) => ({ category, scope: [] }));
}

export function validateDisplayName(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.length > 64) return "显示名最长 64 个字符";
  return null;
}

export interface CountdownView {
  remainingMs: number;
  label: string;
  expired: boolean;
  tone: "ok" | "warn" | "error";
}

/** 邀请码倒计时（服务端 expires_at 为准；过期明确提示重新生成） */
export function inviteCountdown(expiresAt: string, nowMs: number): CountdownView {
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return { remainingMs: 0, label: "过期时间未知", expired: true, tone: "error" };
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) return { remainingMs: 0, label: "已过期", expired: true, tone: "error" };
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return {
      remainingMs,
      label: `剩余 ${hours} 小时 ${String(minutes).padStart(2, "0")} 分`,
      expired: false,
      tone: "ok",
    };
  }
  return {
    remainingMs,
    label: `剩余 ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    expired: false,
    tone: minutes < 5 ? "warn" : "ok",
  };
}

// --- 通知规则 -----------------------------------------------------------------------

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventType, string> = {
  completed: "任务完成",
  failed: "任务失败",
  waiting_input: "等待输入",
  milestone: "节点里程碑",
};

export function notificationEventLabel(event: NotificationEventType): string {
  return NOTIFICATION_EVENT_LABELS[event] ?? event;
}

export interface TargetOption {
  value: string;
  label: string;
}

/** 目标候选：桌面 + 每个已注册渠道（channel:<id>） */
export function notificationTargetOptions(channels: Array<Pick<ChannelSummary, "channel_id">>): TargetOption[] {
  return [
    { value: "desktop", label: "桌面" },
    ...channels.map((channel) => ({
      value: `channel:${channel.channel_id}`,
      label: `渠道 · ${channelDisplayName(channel.channel_id)}`,
    })),
  ];
}

export function targetLabel(target: string): string {
  if (target === "desktop") return "桌面";
  if (target.startsWith("channel:")) return `渠道 · ${channelDisplayName(target.slice("channel:".length))}`;
  return target;
}

/**
 * 默认通知会话输入校验（channel:<id> 通知规则的前置条件）：
 * 必填、去首尾空白。服务端还会校验会话已存在/已白名单（fail-closed），
 * 前端只挡住空输入，避免无意义请求。
 */
export function validateNotifyTargetInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "请填写默认通知会话 id（该渠道已存在或已加入白名单的会话）。";
  if (/\s/.test(trimmed)) return "会话 id 不能包含空白字符。";
  return null;
}

export interface NotificationRuleDraft {
  /** 既有规则的 id（新行 null）；仅用于 UI key */
  rule_id: string | null;
  event_type: NotificationEventType;
  target: string;
  quiet_hours: NotificationQuietHours | null;
  enabled: boolean;
}

export function rulesToDrafts(rules: NotificationRule[]): NotificationRuleDraft[] {
  return rules.map((rule) => ({
    rule_id: rule.rule_id,
    event_type: rule.event_type,
    target: rule.target,
    quiet_hours: rule.quiet_hours,
    enabled: rule.enabled,
  }));
}

export function ruleKey(draft: Pick<NotificationRuleDraft, "event_type" | "target">): string {
  return `${draft.event_type}|${draft.target.trim()}`;
}

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isClockValue(value: string): boolean {
  return CLOCK_RE.test(value);
}

/** 免打扰时段校验：起止都必须 HH:MM；跨天合法（22:00→08:00），起止相同拒绝 */
export function validateQuietHours(quiet: NotificationQuietHours | null): string | null {
  if (quiet === null) return null;
  if (!isClockValue(quiet.start)) return "免打扰开始时间必须是 HH:MM";
  if (!isClockValue(quiet.end)) return "免打扰结束时间必须是 HH:MM";
  if (quiet.start === quiet.end) return "免打扰起止时间相同（等于不免打扰）";
  return null;
}

export function validateNotificationRuleDraft(draft: NotificationRuleDraft): string | null {
  if (!(NOTIFICATION_EVENT_TYPE_VALUES as readonly string[]).includes(draft.event_type)) {
    return `未知事件类型「${draft.event_type}」`;
  }
  const target = draft.target.trim();
  if (!(target === "desktop" || /^channel:\S+$/.test(target))) {
    return "目标必须是 desktop 或 channel:<channel_id>";
  }
  return validateQuietHours(draft.quiet_hours);
}

/** 整表校验：逐行 + key 去重（runtime 按 key upsert，重复行只会静默合并） */
export function validateNotificationDrafts(drafts: NotificationRuleDraft[]): string | null {
  const keys = new Set<string>();
  for (const [index, draft] of drafts.entries()) {
    const error = validateNotificationRuleDraft(draft);
    if (error !== null) return `第 ${index + 1} 条规则：${error}`;
    const key = ruleKey(draft);
    if (keys.has(key)) return `第 ${index + 1} 条规则：事件与目标重复（${key}）`;
    keys.add(key);
  }
  return null;
}

export function toRuleInput(draft: NotificationRuleDraft): NotificationRuleInput {
  return {
    event_type: draft.event_type,
    target: draft.target.trim(),
    quiet_hours: draft.quiet_hours,
    enabled: draft.enabled,
  };
}

// --- Outbox 待核对 ------------------------------------------------------------------

export const OUTBOX_STATUS_LABELS: Record<OutboxStatus, string> = {
  pending: "待投递",
  sent: "已送达",
  failed: "失败（可重试）",
  delivery_unknown: "送达未知",
  needs_review: "需人工核对",
};

/** 待核对列表展示的状态（与通知域的 delivery_unknown/needs_review 同名） */
export const OUTBOX_REVIEW_STATUSES = ["delivery_unknown", "needs_review"] as const;
export type OutboxReviewStatus = (typeof OUTBOX_REVIEW_STATUSES)[number];

export function isOutboxReviewStatus(status: OutboxStatus): status is OutboxReviewStatus {
  return (OUTBOX_REVIEW_STATUSES as readonly string[]).includes(status);
}

export interface OutboxActionState {
  canRetry: boolean;
  /** needs_review 重发必须显式确认「可能已送达/可能重复」 */
  retryRequiresConfirm: boolean;
  canMarkSent: boolean;
  retryLabel: string;
  /** 无操作时说明原因（不留下不可解释的灰按钮） */
  disabledReason: string | null;
}

/**
 * Outbox 操作状态机：
 *   failed                   → 可重试（幂等安全）+ 可标记已送达
 *   delivery_unknown         → 可重试但必须确认 + 可标记已送达（不自动重发）
 *   needs_review             → 可重试但必须确认 + 可标记已送达
 *   pending / sent           → 无人工操作
 */
export function outboxActionState(record: Pick<OutboxMessageRecord, "status">): OutboxActionState {
  switch (record.status) {
    case "failed":
      return {
        canRetry: true,
        retryRequiresConfirm: false,
        canMarkSent: true,
        retryLabel: "重发",
        disabledReason: null,
      };
    case "delivery_unknown":
    case "needs_review":
      return {
        canRetry: true,
        retryRequiresConfirm: true,
        canMarkSent: true,
        retryLabel: "我已核对，重发",
        disabledReason: null,
      };
    case "pending":
      return {
        canRetry: false,
        retryRequiresConfirm: false,
        canMarkSent: false,
        retryLabel: "重发",
        disabledReason: "等待自动投递",
      };
    default:
      return {
        canRetry: false,
        retryRequiresConfirm: false,
        canMarkSent: false,
        retryLabel: "重发",
        disabledReason: "已送达（仅供对照）",
      };
  }
}

/** 重发请求体：只有需要确认的状态才带 confirmed=true */
export function retryConfirmed(record: Pick<OutboxMessageRecord, "status">): boolean {
  return outboxActionState(record).retryRequiresConfirm;
}

/** 内容摘要：优先 text，其次 common JSON；截断到 120 字符（列表可读） */
export function outboxPayloadSummary(payload: Record<string, unknown>): string {
  const text =
    typeof payload.text === "string"
      ? payload.text
      : typeof payload.content === "string"
        ? payload.content
        : typeof payload.title === "string"
          ? payload.title
          : JSON.stringify(payload);
  const value = text ?? "";
  return value.length > 120 ? `${value.slice(0, 119)}…` : value;
}

export function outboxTargetLabel(record: Pick<OutboxMessageRecord, "target">): string {
  return `${record.target.kind === "conversation" ? "会话" : "用户"} · ${record.target.id}`;
}

export function outboxFailureLabel(record: Pick<OutboxMessageRecord, "status" | "last_error">): string {
  if (record.last_error !== null && record.last_error.length > 0) return record.last_error;
  return record.status === "needs_review" ? "需核对是否已送达" : "—";
}

// --- 凭据配置表单 --------------------------------------------------------------------

export const CREDENTIAL_FIELD_LABELS: Record<string, string> = {
  app_id: "App ID",
  app_secret: "App Secret",
  verification_token: "Verification Token",
  encrypt_key: "Encrypt Key",
  bot_open_id: "Bot open_id（可选）",
  bot_secret: "Bot Secret（可选）",
  token_endpoint: "Token 端点（可选）",
};

export function credentialFieldLabel(field: string): string {
  return CREDENTIAL_FIELD_LABELS[field] ?? field;
}

export function credentialFormInitial(view: ChannelSecretsView): Record<string, string> {
  return Object.fromEntries(view.fields.map((field) => [field.field, ""]));
}

export type CredentialFieldErrors = Record<string, string>;

/**
 * 凭据表单校验：已配置的字段留空 = 保持不变；必填且从未配置 = 必须填写。
 * 只校验本次可提交的字段，不读取/回显任何既有密文。
 */
export function validateCredentialForm(
  view: ChannelSecretsView,
  values: Record<string, string>,
): CredentialFieldErrors {
  const errors: CredentialFieldErrors = {};
  for (const field of view.fields) {
    const value = (values[field.field] ?? "").trim();
    if (value.length > 0) continue;
    if (field.required && !field.configured) {
      errors[field.field] = "必填：尚未配置";
    }
  }
  return errors;
}

/** 只提交本次填写的非空字段；空值表示保持不变（不覆盖既有密文） */
export function buildSecretsPayload(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([field, value]) => [field, value.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );
}

/** 凭据配置状态摘要（不回显值） */
export function credentialSummary(view: ChannelSecretsView): string {
  const configured = view.fields.filter((field) => field.configured).length;
  const requiredMissing = view.fields.filter((field) => field.required && !field.configured).map((field) => credentialFieldLabel(field.field));
  if (requiredMissing.length > 0) return `缺少必填凭据：${requiredMissing.join(" / ")}`;
  return `已配置 ${configured}/${view.fields.length} 个字段`;
}
