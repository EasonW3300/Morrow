import type {
  ChannelCapabilities,
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
}

/** 适配器自报健康（GET /v1/channels/:id/health 的核心字段；状态由 registry 补充） */
export interface ChannelAdapterHealth {
  healthy: boolean;
  detail?: string;
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
  start(context: ChannelAdapterContext): void | Promise<void>;
  stop(): void | Promise<void>;
  send(outbound: OutboundMessage): ChannelSendReceipt | Promise<ChannelSendReceipt>;
  health(): ChannelAdapterHealth | Promise<ChannelAdapterHealth>;
  parseInbound(raw: unknown): ParseInboundResult;
  capabilities(): ChannelCapabilities;
}
