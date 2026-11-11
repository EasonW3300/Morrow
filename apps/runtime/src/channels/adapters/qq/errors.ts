import {
  BotPlatformError,
  isHttpSuccessStatus,
  type BotPlatformErrorOptions,
  type SendErrorRule,
} from "../shared/error-catalog.ts";

/**
 * QQ 官方 Bot API 错误分类（M4-T4 / Issue #41）。
 *
 * 与飞书的差异（Issue #49 起由 `shared/` 骨架承载，本文件只剩差异）：
 * - token 失效码是 11241/11242/11243（Access Token 鉴权），且 HTTP 401 也归此类；
 * - 主动消息拒绝有专门类别 `proactive_rejected`（平台策略/额度限制，**不重试**），
 *   对应错误码 304021/304022/304035/304045..304052 等；
 * - 429 限流码包含 HTTP 429 与 20028/504xxx/1100308/1100100 等业务码；
 * - 权限错误固定报 httpStatus 403（业务码命中时响应可能是 200）。
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

export type QqErrorOptions = BotPlatformErrorOptions<QqErrorCategory>;

/** QQ 平台错误（内部诊断 + 映射为 ChannelSendError 抛给 Outbox 桥） */
export class QqError extends BotPlatformError<QqErrorCategory> {
  constructor(options: QqErrorOptions) {
    super("QqError", options, QQ_ERROR_POLICY);
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
  // 40034105：真实平台实测（2026-11-10）群主动消息返回
  // `HTTP 400 {"message":"主动消息失败, 无权限","code":40034105}`——
  // 群场景默认无主动消息权限。此前该码不在表内，会被归为可重试的平台错误，
  // 导致 Outbox 反复重试而不是立即 needs_review（真实联调发现）。
  40034105,
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

const QQ_ERROR_POLICY = {
  label: "qq",
  nonRetryableCategories: new Set<QqErrorCategory>([
    "proactive_rejected",
    "unsupported_attachment",
    "unknown_conversation",
  ]),
} as const;

/** 平台文案里的主动消息拒绝关键词（码表之外的真实平台文案兜底） */
const PROACTIVE_REJECTION_PATTERN = /主动消息|active message|proactive/i;

/**
 * QQ 响应 → 统一错误类别（表驱动；顺序与重构前 if 链一致）：
 * 429/限流码 → token 失效 → 主动消息拒绝 → 权限 → 其余非 2xx 或非 0 业务码。
 * 注意 proactive 判定在 permission 之前（飞书相反），这是既有行为的一部分。
 */
export const QQ_SEND_ERROR_RULES: readonly SendErrorRule<QqErrorCategory>[] = [
  {
    category: "rate_limited",
    when: ({ httpStatus, code }) => httpStatus === 429 || isQqRateLimitCode(code),
    fallback: ({ retryAfterSeconds }) => `qq rate limited (retry-after ${retryAfterSeconds ?? 1}s)`,
    retryAfterSeconds: ({ retryAfterSeconds }) => retryAfterSeconds ?? 1,
  },
  {
    category: "token_invalid",
    when: ({ httpStatus, code }) =>
      httpStatus === 401 || (code !== undefined && QQ_TOKEN_ERROR_CODES.has(code)),
    fallback: () => "qq access token is invalid or expired",
  },
  {
    category: "proactive_rejected",
    when: ({ proactive, code, platformMessage }) =>
      proactive &&
      ((code !== undefined && QQ_PROACTIVE_REJECT_CODES.has(code)) ||
        PROACTIVE_REJECTION_PATTERN.test(platformMessage ?? "")),
    fallback: () => "qq proactive message rejected by platform policy",
  },
  {
    category: "permission_denied",
    when: ({ httpStatus, code }) =>
      httpStatus === 403 || (code !== undefined && QQ_PERMISSION_ERROR_CODES.has(code)),
    // 业务码命中时响应可能是 200；错误对象固定报 403（与重构前一致）
    httpStatus: 403,
    fallback: () => "qq permission denied",
  },
  {
    category: "bad_request",
    when: ({ httpStatus, code }) =>
      !isHttpSuccessStatus(httpStatus) || (code !== undefined && code !== 0),
    fallback: ({ httpStatus }) => `qq responded ${httpStatus}`,
  },
];
