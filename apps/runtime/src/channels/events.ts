/**
 * 渠道事件族（M4-T1 / Issue #38）。event_type 清单只增不减（PRD §6.3 演进规则）：
 *
 *   channel.adapter_started    适配器启动（payload: channel/account_id/experimental）
 *   channel.adapter_stopped    适配器停止（payload: channel/account_id/reason?）
 *   channel.inbound_received   入站消息已归一化并交给会话链路
 *                              （payload: channel/account/native ids/principal/
 *                              permission_context/session_id/message_id/task_id?）
 *   channel.inbound_rejected   入站被拒（payload 必含 reason；未注册渠道/账号、
 *                              未知发送者、未白名单群、未 @、解析失败、未知 Task 等）
 *   channel.experimental_enabled 实验适配器经显式风险确认后启用（M4-T5）
 *                              （payload: channel/account_id/experimental/confirm_risk/
 *                              risk_notice/environment）
 *   channel.enabled            稳定适配器经 Owner 显式启用（A1 修复批；持久化到
 *                              channel_settings）
 *   channel.disabled           稳定适配器经 Owner 显式停用（A1 修复批）
 *   channel.notify_target_updated 默认通知会话变更（A3 修复批）
 */
export const CHANNEL_EVENT_TYPES = {
  adapterStarted: "channel.adapter_started",
  adapterStopped: "channel.adapter_stopped",
  inboundReceived: "channel.inbound_received",
  inboundRejected: "channel.inbound_rejected",
  experimentalEnabled: "channel.experimental_enabled",
  enabled: "channel.enabled",
  disabled: "channel.disabled",
  notifyTargetUpdated: "channel.notify_target_updated",
} as const;
