/**
 * 可信联系人（Trusted Contact）API 合约类型（M4-T6 / Issue #43，PRD §4.8 FR-NOT-3、
 * GLOSSARY Trusted Contact / Invite Code / Sensitivity Level）。
 *
 * 授权粒度 = 联系人 × 能力类别；类别默认仅 query（查询问答）。
 * scope 是类别的可选细粒度声明（当前用于「该类别的联系人可执行哪些能力名」）。
 */

/** 可信联系人能力类别（FR-NOT-3 三类；只增不减） */
export const CONTACT_CAPABILITY_CATEGORIES = ["query", "task_execute", "memory_reference"] as const;

export type ContactCapabilityCategory = (typeof CONTACT_CAPABILITY_CATEGORIES)[number];

/** 一条联系人授权（category + 可选 scope：允许执行的能力名列表） */
export interface ContactGrantView {
  category: ContactCapabilityCategory;
  scope: string[];
  created_at: string;
  updated_at: string;
}

/** 平台身份绑定（联系人 ↔ 渠道账号 × 平台发送者） */
export interface ContactIdentityView {
  account_id: string;
  native_sender_id: string;
  display_name: string | null;
  created_at: string;
}

/** GET /v1/contacts 的元素 */
export interface ContactView {
  contact_id: string;
  display_name: string;
  status: "active" | "suspended";
  grants: ContactGrantView[];
  identities: ContactIdentityView[];
  created_at: string;
  updated_at: string;
}

/** POST /v1/contacts/invites 的响应（code 只在生成时返回一次） */
export interface ContactInviteView {
  invite_id: string;
  contact_id: string;
  code: string;
  expires_at: string;
  created_at: string;
}

/** 身份歧义待 Owner 选择（同一平台发送者匹配多个联系人） */
export interface ContactAmbiguityView {
  ambiguity_id: string;
  account_id: string;
  native_sender_id: string;
  candidate_contact_ids: string[];
  status: "open" | "resolved";
  resolved_contact_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** GET /v1/channels/:id/allowlist 的群聊模式 */
export type ChannelAllowMode = "mention_only" | "proactive_limited";

/** 群聊白名单元素（channel × native_conversation_id × 模式） */
export interface ChannelAllowlistEntryView {
  native_conversation_id: string;
  mode: ChannelAllowMode;
  created_at: string;
}
