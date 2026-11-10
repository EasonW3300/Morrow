import type { ChannelPermissionContext } from "@morrow/protocol";

/**
 * 渠道路由与联系人域之间的窄接缝（M4-T6 / Issue #43）。
 *
 * 入站路由只依赖这些方法：解析平台发送者对应的联系人、消费邀请码、登记歧义、
 * 记录联系人会话归属、解析权限类别。**权限判定本身在 PermissionEngine**；
 * resolveCategories 只是把类别查询转给引擎（ContactService 实现）。
 */
export interface ContactBindingResolver {
  /** 同一平台发送者已绑定的联系人们（>1 = 歧义，绝不自动合并） */
  matchContacts(accountId: string, nativeSenderId: string): string[];

  /** 渠道文本若是一次性邀请码则消费并绑定；返回绑定结果（reason 用于拒绝留痕） */
  bindFromCode(input: {
    channel: string;
    accountId: string;
    nativeSenderId: string;
    text: string;
    displayName?: string | null;
  }): { bound: boolean; contactId?: string; inviteId?: string; reason?: string };

  /** 登记/复用身份歧义（同一发送者多联系人），返回 ambiguity_id */
  recordAmbiguity(accountId: string, nativeSenderId: string, candidateContactIds: string[]): string;

  /** 联系人经渠道建立的会话归属（「读他人会话」判定的本地依据） */
  recordContactSession(input: {
    contactId: string;
    sessionId: string;
    accountId: string;
    nativeConversationId: string;
  }): void;

  /** 权限类别（联系人 → 类别 → 能力集）；Owner 恒 ["*"]，未知联系人回退 fallback */
  resolveCategories(
    principal: ChannelPermissionContext["principal"],
    contactId: string | null,
    fallback: string[],
  ): string[];
}

/** 授权类别常量（与 protocol CONTACT_CAPABILITY_CATEGORIES 同源，类型收窄用） */
export type ContactCategory = "query" | "task_execute" | "memory_reference";
