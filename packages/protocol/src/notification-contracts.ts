/**
 * 通知规则与投递投影（M4-T7 / Issue #44，PRD §4.8 FR-NOT-1/2，AC-13）。
 *
 * 语义：
 * - 规则以 (event_type, target) 为 key；target = `desktop` 或 `channel:<channel_id>`；
 * - 事件类型 completed / failed / waiting_input / milestone（milestone = 单个任务节点
 *   执行完成，见 runtime notifications/service.ts 的事件映射）；
 * - quiet_hours 用 UTC 的 HH:MM（跨天时段如 22:00-08:00 合法），窗口内不投递，延迟到
 *   结束时刻；
 * - 去重键 task_id + event_type + target，窗口期（默认 10 分钟）内只投递一次；
 * - 渠道目标一律经 Outbox 投递（先落库再外发），桌面目标落本地待拉取表。
 */

export type NotificationEventType = "completed" | "failed" | "waiting_input" | "milestone";

export const NOTIFICATION_EVENT_TYPE_VALUES: readonly NotificationEventType[] = [
  "completed",
  "failed",
  "waiting_input",
  "milestone",
];

/** 免打扰时段（UTC wall clock；start > end 表示跨天） */
export interface NotificationQuietHours {
  start: string;
  end: string;
}

export interface NotificationRule {
  rule_id: string;
  event_type: NotificationEventType;
  /** `desktop` 或 `channel:<channel_id>` */
  target: string;
  quiet_hours: NotificationQuietHours | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** 规则写入载荷（PUT 按 key 合并 upsert） */
export interface NotificationRuleInput {
  event_type: NotificationEventType;
  target: string;
  quiet_hours?: NotificationQuietHours | null;
  enabled?: boolean;
}

/**
 * 投递状态：
 * - pending   桌面通知已落本地表，等待 UI 拉取/确认；
 * - delayed   免打扰时段内，等 deliver_after 到点再投递；
 * - queued    渠道通知已入 Outbox，等待投递器发送；
 * - sent      已送达（渠道=平台回执确认；桌面=UI 已确认）；
 * - failed    平台明确失败或渠道不可用；
 * - delivery_unknown / needs_review  与 Outbox 状态机同名（不自动重发）。
 */
export type NotificationDeliveryStatus =
  | "pending"
  | "delayed"
  | "queued"
  | "sent"
  | "failed"
  | "delivery_unknown"
  | "needs_review";

export type NotificationDeliveryKind = "desktop" | "channel";

export interface NotificationRecord {
  notification_id: string;
  task_id: string | null;
  event_type: NotificationEventType;
  target: string;
  kind: NotificationDeliveryKind;
  channel_id: string | null;
  status: NotificationDeliveryStatus;
  title: string;
  body: string;
  /** 渠道目标关联的 Outbox 行 id（桌面为 null） */
  outbox_id: string | null;
  dedupe_key: string;
  /** delayed 行的最早投递时间（RFC 3339 UTC；其余为 null） */
  deliver_after: string | null;
  detail: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface NotificationHistoryPage {
  notifications: NotificationRecord[];
  total: number;
  limit: number;
  offset: number;
}
