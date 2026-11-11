/**
 * 可信联系人事件族（M4-T6 / Issue #43）。event_type 清单只增不减：
 *
 *   contact.invited              Owner 生成一次性邀请码（payload: invite_id/contact_id/expires_at）
 *   contact.bound                对方在渠道回复邀请码，平台身份绑定到联系人
 *                                （payload: contact_id/invite_id/account_id/native_sender_id/channel）
 *   contact.grants_updated       Owner 更新联系人授权（payload: contact_id/grants）
 *   contact.permission_denied    联系人越权请求被阻断并留痕
 *                                （payload: contact_id/action/reason + 请求细节）
 *   contact.ambiguity_detected   同一平台发送者匹配多个联系人，需 Owner 选择
 *   contact.ambiguity_resolved   Owner 选择联系人后解除歧义
 *   channel.allowlist_updated    群聊白名单替换（payload: channel/account_id/allowlist）
 */
export const CONTACT_EVENT_TYPES = {
  invited: "contact.invited",
  bound: "contact.bound",
  grantsUpdated: "contact.grants_updated",
  permissionDenied: "contact.permission_denied",
  ambiguityDetected: "contact.ambiguity_detected",
  ambiguityResolved: "contact.ambiguity_resolved",
  allowlistUpdated: "channel.allowlist_updated",
} as const;
