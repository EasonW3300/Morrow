import type {
  ChannelCapabilities,
  ChannelEnvironment,
  ChannelLocalBridgeHealth,
  ChannelSendReceipt,
  InboundMessage,
  OutboundMessage,
} from "@morrow/protocol";

/**
 * ChannelAdapter 内部接缝（M4-T1 / Issue #38，M4 规格 Implementation Decisions）。
 *
 * 适配器只做协议转换，不含业务判断：
 *   parseInbound(raw)  平台原始载荷 → 统一 InboundMessage（或结构化 ParseError）；
 *                      绝不解析权限/身份——permission_context 恒为 null。
 *   send(outbound)     统一出站 → 平台发送，返回回执（送达未知不自动重发）。
 *   start/stop         由 ChannelRegistry 驱动；start 时拿到 onInbound 回调。
 *   health/capabilities 如实自报状态与平台能力边界。
 *
 * 生产适配器（飞书/QQ 官方 Bot/微信实验）在后续票实现；echo 是仅测试/开发用的
 * 参考适配器，证明接缝完整（入站归一化 → 会话产出 → send 回调）。
 */
export interface ChannelAdapterContext {
  /** 绑定到本适配器的渠道账号 id（入站消息的 account 字段来源） */
  accountId: string;
  /** 平台事件到达时回调；registry 负责 parseInbound 与入站路由 */
  onInbound(raw: unknown): void;
  /**
   * 平台事件在适配器层被拒（签名/解密/Verification Token 失败等）——
   * registry 写 `channel.inbound_rejected` 留痕（reason=event_rejected, error_code）。
   */
  onInboundRejected?(event: ChannelInboundRejection): void;
  /**
   * 会话白名单判定（M4-T5）：registry 从本地 channel_allowlist 读取。
   * 实验适配器（微信个人号）用它做收发前的 fail-closed 门槛；稳定适配器不需要。
   */
  isConversationAllowed?(nativeConversationId: string): boolean;
}

/** 适配器层拒绝事件的结构化原因（尚未进入 parseInbound） */
export interface ChannelInboundRejection {
  code: string;
  message: string;
  /**
   * 账本 reason（缺省 event_rejected）；实验适配器可用 conversation_not_allowed
   * 等更精确的原因，便于与路由层拒绝口径一致。
   */
  reason?: string;
  /** 诊断用原始帧（不落敏感载荷；由 registry 决定是否写 detail） */
  raw?: unknown;
}

/**
 * 适配器自报健康（GET /v1/channels/:id/health 的核心字段；状态由 registry 补充）。
 * 生产适配器可给出 token 有效期与最近错误，便于渠道管理 UI 诊断。
 * 实验适配器（M4-T5）另报 environment / risk_notice / bridge。
 */
export interface ChannelAdapterHealth {
  healthy: boolean;
  detail?: string;
  /** 事件连接状态（长连接/长轮询适配器） */
  connection?: "connected" | "connecting" | "disconnected" | "degraded";
  /** 平台 access token 到期时间（RFC 3339；无 token 概念时省略） */
  token_expires_at?: string | null;
  /** 最近一次错误（成功路径清空；诊断用，不含密钥） */
  last_error?: string | null;
  /** 实验适配器标记（M4-T5） */
  experimental?: boolean;
  /** 实验适配器环境声明（M4-T5：Windows + 最新版微信） */
  environment?: ChannelEnvironment;
  /** 实验适配器风险声明（M4-T5：不稳定/条款/风险自担/默认关闭） */
  risk_notice?: string;
  /** 实验适配器本地桥健康（M4-T5：进程/登录/窗口句柄/最近错误） */
  bridge?: ChannelLocalBridgeHealth;
}

/**
 * 适配器发送失败（统一错误模型）：Outbox 桥据此决定
 *   explicit → 平台明确拒收（failed，可指数退避重试）
 *   network / timeout → 请求可能已到达平台（delivery_unknown，不自动重发）
 */
export class ChannelSendError extends Error {
  readonly kind: "explicit" | "network" | "timeout";
  readonly code?: string;
  readonly retryable: boolean;
  readonly retry_after_seconds?: number;

  constructor(
    kind: "explicit" | "network" | "timeout",
    message: string,
    options: { code?: string; retryable?: boolean; retry_after_seconds?: number } = {},
  ) {
    super(message);
    this.name = "ChannelSendError";
    this.kind = kind;
    this.code = options.code;
    this.retryable = options.retryable ?? kind === "explicit";
    this.retry_after_seconds = options.retry_after_seconds;
  }
}

/** 解析失败的结构化错误（parseInbound 的另一半；原因可入 inbound_rejected 留痕） */
export interface ChannelParseError {
  ok: false;
  code: string;
  message: string;
}

export type ParseInboundResult = InboundMessage | ChannelParseError;

export function isParseError(value: ParseInboundResult): value is ChannelParseError {
  return (value as ChannelParseError).ok === false;
}

export interface ChannelAdapter {
  readonly channelId: string;
  /** 实验适配器标记（微信个人号等）；echo 参考适配器为 true，清单如实呈现 */
  readonly experimental?: boolean;
  /**
   * 实验适配器环境声明（M4-T5）：清单/health 原样暴露给 UI。
   * 稳定适配器不提供。
   */
  readonly environment?: ChannelEnvironment;
  /** 实验适配器风险声明（M4-T5）：API/UI 双处呈现；稳定适配器不提供 */
  readonly riskNotice?: string;
  /**
   * 该渠道是否只处理 channel_allowlist 中的会话（M4-T5 微信个人号 = true）。
   * 路由层据此对私聊也做 fail-closed 白名单校验（群聊始终校验）。
   */
  readonly requiresConversationAllowlist?: boolean;
  /**
   * 凭据是否齐备（未配置占位适配器返回 false）。
   *
   * 为什么需要：已知渠道即使未配置也要出现在清单里，否则 `PUT /channels/:id/secrets`
   * 会 404、新渠道永远无法通过 UI 首次配置（死循环）。但未配置的条目不能被 start()。
   */
  readonly isConfigured?: () => boolean;
  /** 实验适配器是否已由 Owner 显式启用（缺省视为已启用，兼容稳定适配器） */
  isEnabled?(): boolean;
  /**
   * 显式启用实验适配器（M4-T5）：必须 confirmRisk=true；否则抛错拒绝。
   * 稳定适配器不实现。
   */
  enable?(options: { confirmRisk?: boolean }): void | Promise<void>;
  /** 禁用实验适配器：立即停止收发（幂等）；稳定适配器不实现 */
  disable?(): void | Promise<void>;
  start(context: ChannelAdapterContext): void | Promise<void>;
  stop(): void | Promise<void>;
  send(outbound: OutboundMessage): ChannelSendReceipt | Promise<ChannelSendReceipt>;
  health(): ChannelAdapterHealth | Promise<ChannelAdapterHealth>;
  parseInbound(raw: unknown): ParseInboundResult;
  capabilities(): ChannelCapabilities;
}
