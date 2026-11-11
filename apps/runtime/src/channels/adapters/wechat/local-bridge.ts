/**
 * LocalBridge 内部接缝（M4-T5 / Issue #42）。
 *
 * 微信个人号没有官方 Bot API：真实收发依赖「Windows + 最新版微信 + 本地自动化桥」。
 * 本文件只定义适配器依赖的抽象，不包含任何真实桥实现——M4 交付 `StubLocalBridge`
 * （测试/开发用内存桩），真实桥（窗口句柄/UI 自动化协议）作为外部依赖留待
 * Owner Windows 环境（见 packages/channels/README.md）。
 *
 * 适配器只依赖这 5 个动作：connect / disconnect / status / sendMessage / onMessage。
 * 桥实现负责微信客户端进程、登录态、窗口句柄等平台细节；适配器负责归一化、白名单
 * 门槛、健康自报与错误分类。
 */

export type LocalBridgeProcessState = "running" | "stopped" | "error" | "unknown";
export type LocalBridgeLoginState = "logged_in" | "logged_out" | "unknown";
export type LocalBridgeWindowState = "available" | "unavailable" | "unknown";

/** 桥接进程 / 微信登录态 / 窗口句柄可用性（health 的数据源）。 */
export interface LocalBridgeStatus {
  process: LocalBridgeProcessState;
  login: LocalBridgeLoginState;
  window: LocalBridgeWindowState;
  last_error?: string | null;
}

/** 桥上报的一条微信消息（平台原始形状由具体桥决定；适配器只读这些字段）。 */
export interface LocalBridgeInboundMessage {
  message_id: string;
  conversation_id: string;
  conversation_kind?: "direct" | "group";
  sender: { id: string; name?: string };
  text: string;
  /** RFC 3339；缺省时适配器以接收时间代填 */
  timestamp?: string;
  mentions_agent?: boolean;
}

/** 适配器要求桥发送的一条文本消息。 */
export interface LocalBridgeSendInput {
  conversation_id: string;
  text: string;
  /** 引用回复的入站平台消息 id（桥可用微信引用能力；不可用时可忽略） */
  reply_to_message_id?: string;
}

export interface LocalBridgeSendResult {
  message_id?: string;
  delivered_at?: string;
}

/**
 * 桥接错误分类（与 ChannelSendError 对齐）：
 *   explicit → 桥/微信明确拒收（可退避重试）
 *   network / timeout → 可能已发出（Outbox 判 delivery_unknown，不自动重发）
 */
export class LocalBridgeError extends Error {
  readonly kind: "explicit" | "network" | "timeout";
  readonly code?: string;
  readonly retryable: boolean;

  constructor(
    kind: "explicit" | "network" | "timeout",
    message: string,
    options: { code?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "LocalBridgeError";
    this.kind = kind;
    this.code = options.code;
    this.retryable = options.retryable ?? kind === "explicit";
  }
}

/**
 * 可注入的本地自动化桥接缝。
 *
 * 实现约束：`onMessage` 返回取消订阅函数；`disconnect` 必须幂等；`status` 必须
 * 如实报告进程/登录/窗口，不能因为「桥进程活着」就假设微信可收发。
 */
export interface LocalBridge {
  connect(): void | Promise<void>;
  disconnect(): void | Promise<void>;
  status(): LocalBridgeStatus | Promise<LocalBridgeStatus>;
  sendMessage(input: LocalBridgeSendInput): LocalBridgeSendResult | Promise<LocalBridgeSendResult>;
  onMessage(handler: (message: LocalBridgeInboundMessage) => void): () => void;
}
