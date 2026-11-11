import {
  BotPlatformError,
  isHttpSuccessStatus,
  type BotPlatformErrorOptions,
  type SendErrorRule,
} from "../shared/error-catalog.ts";

/**
 * 飞书 API 错误分类（M4-T3 / Issue #40）：统一映射到 Outbox 的
 * explicit（平台明确拒收/可重试退避）与 network/timeout（结果未知、不自动重发）。
 *
 * Issue #49 起错误模型与码表骨架在 `shared/`：本文件只保留飞书类别、文案前缀、
 * 不可重试类别与**规则表**（顺序即优先级，与重构前 if 链逐条对应）。
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

export type FeishuErrorOptions = BotPlatformErrorOptions<FeishuErrorCategory>;

/** 飞书平台错误（内部诊断 + 映射为 ChannelSendError 抛给 Outbox 桥） */
export class FeishuError extends BotPlatformError<FeishuErrorCategory> {
  constructor(options: FeishuErrorOptions) {
    super("FeishuError", options, FEISHU_ERROR_POLICY);
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

const FEISHU_ERROR_POLICY = {
  label: "feishu",
  nonRetryableCategories: new Set<FeishuErrorCategory>(["unsupported_attachment"]),
} as const;

/**
 * 飞书响应 → 统一错误类别（表驱动；顺序与重构前 if 链一致）：
 * 429 限流 → token 失效 → 403 权限 → 主动消息受限 → 其余非 2xx/非 0 业务码。
 */
export const FEISHU_SEND_ERROR_RULES: readonly SendErrorRule<FeishuErrorCategory>[] = [
  {
    category: "rate_limited",
    when: ({ httpStatus }) => httpStatus === 429,
    // 429 文案固定拼 retry-after（不采用平台文案），与重构前一致
    preferPlatformMessage: false,
    fallback: ({ retryAfterSeconds }) => `feishu rate limited (retry-after ${retryAfterSeconds ?? 1}s)`,
    httpStatus: 429,
    retryAfterSeconds: ({ retryAfterSeconds }) => retryAfterSeconds ?? 1,
    includeCode: false,
  },
  {
    category: "token_invalid",
    when: ({ httpStatus, code }) =>
      httpStatus === 401 || (code !== undefined && FEISHU_TOKEN_ERROR_CODES.has(code)),
    fallback: () => "tenant_access_token is invalid or expired",
  },
  {
    category: "permission_denied",
    when: ({ httpStatus }) => httpStatus === 403,
    fallback: () => "feishu permission denied",
  },
  {
    category: "proactive_limited",
    when: ({ proactive, code }) =>
      proactive && code !== undefined && FEISHU_PROACTIVE_ERROR_CODES.has(code),
    fallback: () => "feishu proactive message is limited in this scene",
  },
  {
    category: "bad_request",
    // 飞书以 code=0 表示成功；缺 code 也算失败（与重构前 `payload.code !== 0` 一致）
    when: ({ httpStatus, code }) => !isHttpSuccessStatus(httpStatus) || code !== 0,
    fallback: ({ httpStatus }) => `feishu responded ${httpStatus}`,
  },
];
