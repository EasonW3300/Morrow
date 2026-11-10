import { ChannelSendError } from "../../types.ts";

/**
 * 飞书 API 错误分类（M4-T3 / Issue #40）：统一映射到 Outbox 的
 * explicit（平台明确拒收/可重试退避）与 network/timeout（结果未知、不自动重发）。
 */
export type FeishuErrorCategory =
  | "token_invalid"
  | "rate_limited"
  | "permission_denied"
  | "proactive_limited"
  | "unsupported_attachment"
  | "bad_request"
  | "network"
  | "timeout"
  | "platform";

export interface FeishuErrorOptions {
  category: FeishuErrorCategory;
  message: string;
  httpStatus?: number;
  /** 飞书业务 code（响应体的 code 字段） */
  code?: number;
  retryAfterSeconds?: number;
  /** 平台是否可能已收到请求（超时/网络中断 = true） */
  deliveryUnknown?: boolean;
}

/** 飞书平台错误（内部诊断 + 映射为 ChannelSendError 抛给 Outbox 桥） */
export class FeishuError extends Error {
  readonly category: FeishuErrorCategory;
  readonly httpStatus: number | undefined;
  readonly code: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly deliveryUnknown: boolean;

  constructor(options: FeishuErrorOptions) {
    super(options.message);
    this.name = "FeishuError";
    this.category = options.category;
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.deliveryUnknown = options.deliveryUnknown ?? false;
  }

  /** 转成渠道层统一发送错误：explicit 可重试；network/timeout 结果未知 */
  toSendError(): ChannelSendError {
    const kind =
      this.category === "network"
        ? "network"
        : this.category === "timeout"
          ? "timeout"
          : "explicit";
    return new ChannelSendError(kind, `feishu ${this.category}: ${this.message}`, {
      code: this.category,
      retryable: kind === "explicit" && this.category !== "unsupported_attachment",
      ...(this.retryAfterSeconds === undefined ? {} : { retry_after_seconds: this.retryAfterSeconds }),
    });
  }
}

/** 飞书 token 失效相关的业务错误码（收到即刷新一次再试） */
export const FEISHU_TOKEN_ERROR_CODES = new Set<number>([
  99991661, // invalid access token
  99991663, // tenant access token invalid
  99991668, // tenant access token expired
  99991677, // user access token expired (defensive)
]);

/** 主动消息被平台拒绝的业务错误码 */
export const FEISHU_PROACTIVE_ERROR_CODES = new Set<number>([230001, 230002]);
