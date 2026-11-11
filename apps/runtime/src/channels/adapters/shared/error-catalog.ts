import { ChannelSendError } from "../../types.ts";

/**
 * HTTP Bot 适配器公共错误目录（Issue #49，从飞书/QQ 适配器抽出的重复错误模型）。
 *
 * 两层职责：
 * 1. `BotPlatformError` —— 平台错误的公共实现（类别/HTTP 状态/业务码/Retry-After/
 *    送达未知），`toSendError()` 统一映射为 Outbox 桥消费的 `ChannelSendError`；
 *    各平台只提供类名、文案前缀与「即使 explicit 也不可重试」的类别集合。
 * 2. `SendErrorRule` 表 —— **表驱动**的「平台响应 → 统一类别」判定：适配器按顺序
 *    求值规则，命中即得到 `ClassifiedSendFailure`。各平台只提供码表与默认文案；
 *    规则顺序是行为的一部分（例如 QQ 的 proactive 判定先于 permission，飞书相反）。
 *
 * 类别是稳定契约：出现新语义时先扩这里，再改码表。
 */
export type BotErrorCategory =
  | "token_invalid"
  | "rate_limited"
  | "permission_denied"
  | "proactive_limited"
  | "proactive_rejected"
  | "unsupported_attachment"
  | "unknown_conversation"
  | "bad_request"
  | "network"
  | "timeout"
  | "platform";

export interface BotPlatformErrorOptions<C extends string = BotErrorCategory> {
  category: C;
  message: string;
  httpStatus?: number;
  /** 平台业务码（响应体的 code 字段） */
  code?: number;
  retryAfterSeconds?: number;
  /** 平台是否可能已收到请求（超时/网络中断 = true） */
  deliveryUnknown?: boolean;
}

export interface BotErrorPolicy<C extends string = BotErrorCategory> {
  /** 统一发送错误的文案前缀（飞书 "feishu" / QQ "qq"） */
  label: string;
  /** kind=explicit 时仍不可自动重试的类别（如主动消息被拒、未知会话形态） */
  nonRetryableCategories: ReadonlySet<C>;
}

/** 平台错误公共实现（FeishuError / QqError 继承它，只保留差异化策略） */
export class BotPlatformError<C extends string = BotErrorCategory> extends Error {
  readonly category: C;
  readonly httpStatus: number | undefined;
  readonly code: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly deliveryUnknown: boolean;
  readonly #policy: BotErrorPolicy<C>;

  constructor(name: string, options: BotPlatformErrorOptions<C>, policy: BotErrorPolicy<C>) {
    super(options.message);
    this.name = name;
    this.category = options.category;
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.deliveryUnknown = options.deliveryUnknown ?? false;
    this.#policy = policy;
  }

  /**
   * 转成渠道层统一发送错误：
   *   network/timeout        → 结果未知（Outbox 判 delivery_unknown，不自动重发）
   *   explicit + 不可重试类别 → 直接 needs_review
   *   其余 explicit          → 可退避重试
   */
  toSendError(): ChannelSendError {
    const kind =
      this.category === "network" ? "network" : this.category === "timeout" ? "timeout" : "explicit";
    return new ChannelSendError(kind, `${this.#policy.label} ${this.category}: ${this.message}`, {
      code: this.category,
      retryable: kind === "explicit" && !this.#policy.nonRetryableCategories.has(this.category),
      ...(this.retryAfterSeconds === undefined ? {} : { retry_after_seconds: this.retryAfterSeconds }),
    });
  }
}

/** 一次平台发送响应中参与错误判定的字段（各平台在 `readPlatformMessage` 里归一化文案） */
export interface SendFailureContext {
  httpStatus: number;
  code: number | undefined;
  /** 平台返回的错误文案；`undefined` 表示缺失（空字符串是否算缺失由平台归一化决定） */
  platformMessage: string | undefined;
  /** 本次发送是否为主动消息（无 reply_to_native_message_id） */
  proactive: boolean;
  retryAfterSeconds: number | null;
}

/** 规则命中的统一分类结果（随后由平台错误类包装） */
export interface ClassifiedSendFailure<C extends string = BotErrorCategory> {
  category: C;
  message: string;
  httpStatus?: number;
  code?: number;
  retryAfterSeconds?: number;
}

/**
 * 一条分类规则。`when` 命中即产出该类别；规则数组的顺序即优先级。
 * 文案策略：`preferPlatformMessage`（缺省 true）时优先用平台文案，否则用 `fallback`；
 * 飞书的 429 是唯一「忽略平台文案、固定拼 retry-after」的规则。
 */
export interface SendErrorRule<C extends string = BotErrorCategory> {
  category: C;
  when(context: SendFailureContext): boolean;
  fallback(context: SendFailureContext): string;
  preferPlatformMessage?: boolean;
  /** 覆盖响应状态（QQ 权限错误固定报 403）；缺省用响应的 httpStatus */
  httpStatus?: number;
  retryAfterSeconds?(context: SendFailureContext): number | undefined;
  /** 是否把业务码带入错误对象（缺省 true；飞书 429 不带） */
  includeCode?: boolean;
}

export function isHttpSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 按平台规则表把一次发送响应分类；返回 null 表示平台已受理 */
export function classifySendFailure<C extends string>(
  rules: readonly SendErrorRule<C>[],
  context: SendFailureContext,
): ClassifiedSendFailure<C> | null {
  for (const rule of rules) {
    if (!rule.when(context)) continue;
    const usePlatformMessage = rule.preferPlatformMessage ?? true;
    const message =
      usePlatformMessage && context.platformMessage !== undefined
        ? context.platformMessage
        : rule.fallback(context);
    return {
      category: rule.category,
      message,
      httpStatus: rule.httpStatus ?? context.httpStatus,
      ...(rule.includeCode === false || context.code === undefined ? {} : { code: context.code }),
      ...(rule.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: rule.retryAfterSeconds(context) }),
    };
  }
  return null;
}
