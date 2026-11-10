/**
 * 渠道域 API 合约类型（M4-T1 / Issue #38，PRD §4.4 FR-CH-5/6/8、GLOSSARY Channel*）。
 *
 * 与 api-contracts.ts / task-contracts.ts 同一演进规则：字段只加不减、不改名、不收窄
 * 已有类型。runtime 是唯一生产方；渠道适配器 SDK、desktop 与渠道管理 UI 是消费方。
 *
 * 边界（Implementation Decisions）：适配器只做协议转换——parseInbound 产出
 * InboundMessage；permission_context 不来自平台自报身份，而由入站路由按本地账本/
 * 身份映射解析后填入（适配器产出的 permission_context 恒为 null）。
 */

/**
 * 单个渠道能力维度的支撑程度：
 *   supported   平台协议可直接做到
 *   limited     只能部分做到（须在 UI 如实呈现，例如附件仅引用不可上传）
 *   unsupported 平台不提供，不做承诺
 */
export type ChannelFeatureSupport = "supported" | "limited" | "unsupported";

/**
 * 适配器能力声明（PRD §4.4；ticket M4-T1 的 capabilities() 五维）。
 *
 * group_proactive 只允许 unsupported / limited：平台对主动消息的频控与场景限制
 * 真实存在，契约层禁止声明 "supported" 的无限主动推送（FR-CH-2 诚实交付）。
 */
export interface ChannelCapabilities {
  direct_message: ChannelFeatureSupport;
  group_mention: ChannelFeatureSupport;
  group_proactive: "unsupported" | "limited";
  attachments: ChannelFeatureSupport;
  edit: ChannelFeatureSupport;
}

/** 平台会话形态：私聊 / 群聊（GLOSSARY Conversation 的 kind 维度） */
export type ChannelConversationKind = "direct" | "group";

/** 平台发送者（原始身份，仅平台侧 id 与展示名；是否 Owner 由本地身份映射决定） */
export interface InboundSender {
  native_id: string;
  display_name?: string;
}

/** 入站附件引用（平台原始 id / 类型 / 元数据；真正下载与存储不属本票） */
export interface InboundAttachment {
  native_id?: string;
  kind: "image" | "file" | "audio" | "video" | "other";
  name?: string;
  mime_type?: string;
  size_bytes?: number;
  url?: string;
}

/** 入站 @ 提及信息（群聊仅在 agent=true 时交给会话链路） */
export interface InboundMention {
  agent: boolean;
  /** 平台暴露的被提及用户/机器人原生 id（可缺省） */
  native_ids?: string[];
}

/** 已解析的本地主体：Owner 本人或已绑定可信联系人（GLOSSARY Trusted Contact） */
export type ChannelPrincipal = "owner" | `contact:${string}`;

/**
 * 权限上下文（存在则必为本地解析结果，绝不来自平台自报）。
 * channel+account+sender+conversation 四要素 + 解析出的 principal + 授权类别快照。
 */
export interface ChannelPermissionContext {
  channel: string;
  account: string;
  sender: InboundSender;
  conversation: {
    native_conversation_id: string;
    kind: ChannelConversationKind;
  };
  principal: ChannelPrincipal;
  /** 可信联系人 id（principal = contact:<id> 时非空） */
  contact_id: string | null;
  /** 已授权能力类别快照；Owner 为 ["*"]。具体授权执行在 M4 联系人票中收口 */
  granted_categories: string[];
}

/**
 * 统一入站结构（PRD §4.4 FR-CH-5 字段全量）。
 * permission_context 在适配器输出中恒为 null，由入站路由解析后持久化/入事件。
 */
export interface InboundMessage {
  channel: string;
  account: string;
  native_message_id: string;
  native_conversation_id: string;
  conversation_kind: ChannelConversationKind;
  sender: InboundSender;
  mention: InboundMention;
  attachments: InboundAttachment[];
  /** RFC 3339（平台侧时间；无法提供时由适配器以接收时间代填并说明） */
  timestamp: string;
  text: string;
  permission_context: ChannelPermissionContext | null;
}

/** 统一出站结构（Outbox 投递器在 M4-T2 接管持久化；本票适配器 send 的输入） */
export interface OutboundMessage {
  channel: string;
  account: string;
  native_conversation_id: string;
  text: string;
  /** 回复哪条入站消息（平台 reply API 用） */
  reply_to_native_message_id?: string;
  /** 幂等键（Outbox 唯一约束；本票 echo 参考路径也携带） */
  idempotency_key?: string;
  attachments?: InboundAttachment[];
}

/** 发送回执（渠道侧确认；delivery_unknown 时不自动重发——FR-TASK-6） */
export interface ChannelSendReceipt {
  channel: string;
  remote_message_id?: string;
  delivered_at?: string;
  delivery_unknown?: boolean;
  error?: string;
}

/** 适配器生命周期状态（GET /v1/channels 的 state） */
export type ChannelAdapterState = "registered" | "starting" | "running" | "stopped" | "error";

/** GET /v1/channels 的清单元素（适配器 + 绑定账号 + 能力 + 状态） */
export interface ChannelSummary {
  channel_id: string;
  /** 当前绑定的渠道账号 id；未配置账号为 null */
  account: string | null;
  state: ChannelAdapterState;
  capabilities: ChannelCapabilities;
  enabled: boolean;
  /** 实验适配器（出厂默认关闭、需显式启用并自担风险；GLOSSARY Experimental Adapter） */
  experimental: boolean;
}

/** GET /v1/channels/:id/health 的响应（适配器自报健康 + 状态投影） */
export interface ChannelHealth {
  channel_id: string;
  state: ChannelAdapterState;
  healthy: boolean;
  detail: string | null;
  checked_at: string;
}
