import { ChannelSendError } from "../../types.ts";

/**
 * QQ 官方 Bot API 错误分类（M4-T4 / Issue #41）。
 *
 * 与飞书的差异：
 * - token 失效码是 11241/11242/11243（Access Token 鉴权），且 HTTP 401 也归此类；
 * - 主动消息拒绝有专门类别 `proactive_rejected`（平台策略/额度限制，**不重试**），
 *   对应错误码 304021/304022/304035/304045..304052 等；
 * - 429 限流码包含 HTTP 429 与 20028/504xxx/1100308/1100100 等业务码。
 */
export type QqErrorCategory =
  | "token_invalid"
  | "rate_limited"
  | "permission_denied"
  | "proactive_rejected"
  | "unsupported_attachment"
  | "unknown_conversation"
  | "bad_request"
  | "network"
  | "timeout"
  | "platform";

export interface QqErrorOptions {
  category: QqErrorCategory;
  message: string;
  httpStatus?: number;
  /** QQ 业务码（响应体 code 字段） */
  code?: number;
  retryAfterSeconds?: number;
  /** 平台是否可能已收到请求（超时/网络中断 = true） */
  deliveryUnknown?: boolean;
}

/** QQ 平台错误（内部诊断 + 映射为 ChannelSendError 抛给 Outbox 桥） */
export class QqError extends Error {
  readonly category: QqErrorCategory;
  readonly httpStatus: number | undefined;
  readonly code: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly deliveryUnknown: boolean;

  constructor(options: QqErrorOptions) {
    super(options.message);
    this.name = "QqError";
    this.category = options.category;
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.deliveryUnknown = options.deliveryUnknown ?? false;
  }

  /**
   * 转成渠道层统一发送错误：
   *   network/timeout       → 结果未知（Outbox 判 delivery_unknown，不自动重发）
   *   proactive_rejected    → explicit 且 retryable=false（Outbox 直接 needs_review）
   *   其余 explicit 4xx     → explicit 可退避重试
   */
  toSendError(): ChannelSendError {
    const kind =
      this.category === "network"
        ? "network"
        : this.category === "timeout"
          ? "timeout"
          : "explicit";
    const retryable =
      kind === "explicit" &&
      this.category !== "proactive_rejected" &&
      this.category !== "unsupported_attachment" &&
      this.category !== "unknown_conversation";
    return new ChannelSendError(kind, `qq ${this.category}: ${this.message}`, {
      code: this.category,
      retryable,
      ...(this.retryAfterSeconds === undefined ? {} : { retry_after_seconds: this.retryAfterSeconds }),
    });
  }
}

/** Access Token 失效/校验失败（收到即强制刷新一次再试） */
export const QQ_TOKEN_ERROR_CODES = new Set<number>([
  11241, // token 缺失
  11242, // token 校验失败
  11243, // token 校验不通过
]);

/** 主动消息被平台拒绝（策略/频控/场景限制——不重试） */
export const QQ_PROACTIVE_REJECT_CODES = new Set<number>([
  304003,
  304021, // 推送时间限制
  304022, // 推送时间限制
  304035, // 超过子频道推送数上限
  304045, // 子频道主动消息限频
  304046, // 不允许在此子频道发主动消息
  304047, // 主动推送超过允许的子频道数
  304048, // 不允许在此频道发主动消息
  304049, // 私聊主动消息限频
  304050, // 私聊主动消息总量限制
  304052, // 主动消息频控引导
  11298, // 主动消息发送失败（历史码）
]);

/** 限流业务码（HTTP 429 之外；304045/304049/304050/304052 在主动消息场景优先归 proactive） */
export const QQ_RATE_LIMIT_CODES = new Set<number>([
  20028,
  1100100,
  1100308,
  620006,
]);

/** 权限/场景不足业务码 */
export const QQ_PERMISSION_ERROR_CODES = new Set<number>([
  11254, // 应用接口被封禁
  11264, // 频道权限未授权
  11282, // 权限校验不通过
  11253, // 应用权限校验不通过
  1100301, // 调用方不是群成员
  1100303, // 非管理员不能在主频道发言
  1100306, // 非私聊频道成员
  1100307, // 非白名单应用子频道
  304031, // 私聊关闭
  304034, // 非私聊成员
]);

/** 数值码是否落在 QQ 的频率限制区间（504000~504999） */
export function isQqRateLimitCode(code: number | undefined): boolean {
  return code !== undefined && (QQ_RATE_LIMIT_CODES.has(code) || (code >= 504000 && code <= 504999));
}
