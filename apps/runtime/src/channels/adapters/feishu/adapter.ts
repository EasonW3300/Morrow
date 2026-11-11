import type { ChannelCapabilities, OutboundMessage } from "@morrow/protocol";
import type { ChannelTestEventFrame } from "../../testing/channel-test-server.ts";
import type { ParseInboundResult } from "../../types.ts";
import {
  HttpBotAdapter,
  type BotChannelSpec,
  type BotHttpResult,
  type ReadTokenResult,
} from "../shared/http-bot-adapter.ts";
import type { BotPlatformErrorOptions } from "../shared/error-catalog.ts";
import { FeishuError, FEISHU_SEND_ERROR_RULES, type FeishuErrorCategory } from "./errors.ts";
import {
  classifyFeishuEvent,
  parseFeishuInbound,
  verifyFeishuEvent,
  type FeishuVerifyResult,
} from "./events.ts";
import type { FeishuConfig } from "./config.ts";
import type { FeishuEventTransport } from "./transport.ts";

/**
 * 飞书自建应用 Bot 适配器（M4-T3 / Issue #40，stable baseline channel）。
 *
 * 边界（T1 契约不变）：只做协议转换——事件校验/解密/归一化、reply API 发送、错误分类、
 * capabilities/health 自报。权限/身份/白名单仍由本地入站路由决定。
 *
 * 事件订阅走**长连接**（ADR-0004 私有网络优先，无需公网回调地址）；webhook 模式仅文档
 * 说明。生产长连接由官方 WebSocket SDK 封装成 FeishuEventTransport 注入；默认
 * HttpLongPollEventTransport 与 ChannelTestServer 对齐，用于协议层全链路测试/内网桥接。
 *
 * Issue #49 起骨架在 `shared/http-bot-adapter.ts`（token 缓存/刷新重试、request、health、
 * 事件入口统一）。本文件只剩飞书差异：
 * - 鉴权：`app_id`/`app_secret` → tenant_access_token，头 `Bearer <token>`；
 * - 发送：有 reply_to → reply API（引用原消息）；无 → 主动消息 API；
 * - 错误表：`FEISHU_SEND_ERROR_RULES`（429 → token → 403 → 主动消息受限 → 其余）。
 *
 * 发送语义（重构前后一字不变）：
 * - token 失效：刷新一次后重试；仍失败 → 健康降级（healthy=false + last_error）；
 * - 429/权限不足/平台明确拒收 → ChannelSendError(explicit)（Outbox 退避重试）；
 * - 超时/网络中断 → ChannelSendError(timeout|network)（Outbox 判 delivery_unknown，不重发）。
 */

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  // 飞书对主动消息有场景/频控限制（且需权限审批）——契约层绝不声明 supported
  group_proactive: "limited",
  // 入站附件只保留平台引用；出站附件投递未实现
  attachments: "limited",
  edit: "unsupported",
};

export interface FeishuChannelAdapterOptions {
  accountId?: string;
  config: FeishuConfig;
  /** Open API 基地址（默认 https://open.feishu.cn；测试改成本地 ChannelTestServer） */
  baseUrl?: string;
  /** fetch 注入（测试可观察/模拟网络错误；缺省全局 fetch） */
  fetch?: typeof fetch;
  now?: () => Date;
  /** 单次 HTTP 请求超时（毫秒，默认 10000） */
  requestTimeoutMs?: number;
  /** token 提前刷新窗口（毫秒，默认 300000 = 5 分钟） */
  tokenRefreshSkewMs?: number;
  /** 事件时间偏差容忍（秒，默认 300；0 = 不校验） */
  signatureToleranceSeconds?: number;
  /** 事件传输（缺省 = 同 baseUrl 的 HTTP 长轮询） */
  eventTransport?: FeishuEventTransport;
  /** 长轮询单次等待（毫秒，默认 1000） */
  eventPollTimeoutMs?: number;
  /** 长轮询重连等待（毫秒，默认 500） */
  eventReconnectDelayMs?: number;
}

/** tenant_access_token 端点响应解析（TTL 缺省 7200s；code≠0/非 2xx 均判失败） */
function readFeishuToken(response: BotHttpResult): ReadTokenResult {
  const payload = response.payload;
  if (
    response.status < 200 ||
    response.status >= 300 ||
    payload.code !== 0 ||
    typeof payload.tenant_access_token !== "string"
  ) {
    return {
      ok: false,
      failure: {
        category: "token_invalid",
        message: (payload.msg as string | undefined) ?? `token endpoint responded ${response.status}`,
        httpStatus: response.status,
        ...(payload.code === undefined ? {} : { code: payload.code as number }),
      },
    };
  }
  const expire = payload.expire;
  const expireSeconds = typeof expire === "number" && expire > 0 ? expire : 7_200;
  return {
    ok: true,
    value: payload.tenant_access_token,
    expiresInSeconds: expireSeconds,
  };
}

const SPEC: BotChannelSpec = {
  channelId: "feishu",
  label: "feishu",
  defaultAccountId: "feishu-default",
  capabilities: CAPABILITIES,
  healthyDetail: "feishu long connection established; tenant_access_token cached",
  authScheme: "Bearer",
  tokenLabel: "tenant_access_token",
  nonJsonMessageKey: "msg",
  sendErrorRules: FEISHU_SEND_ERROR_RULES,
  readPlatformMessage: (payload) => payload.msg as string | undefined,
  readToken: readFeishuToken,
  readRemoteMessageId: (payload) =>
    (payload.data as { message_id?: string } | undefined)?.message_id,
};

export class FeishuChannelAdapter extends HttpBotAdapter<FeishuError, FeishuVerifyResult> {
  readonly #config: FeishuConfig;

  constructor(options: FeishuChannelAdapterOptions) {
    super(SPEC, {
      accountId: options.accountId,
      baseUrl: options.baseUrl ?? "https://open.feishu.cn",
      fetch: options.fetch,
      now: options.now,
      requestTimeoutMs: options.requestTimeoutMs,
      tokenRefreshSkewMs: options.tokenRefreshSkewMs,
      signatureToleranceSeconds: options.signatureToleranceSeconds,
      eventTransport: options.eventTransport,
      eventPollTimeoutMs: options.eventPollTimeoutMs,
      eventReconnectDelayMs: options.eventReconnectDelayMs,
    });
    this.#config = options.config;
  }

  protected verifyFrame(frame: ChannelTestEventFrame): FeishuVerifyResult {
    return verifyFeishuEvent(frame, this.#config, {
      toleranceSeconds: this.signatureToleranceSeconds,
      now: this.clock,
    });
  }

  protected isInboundEvent(event: Record<string, unknown>): boolean {
    return classifyFeishuEvent(event).kind === "message";
  }

  parseInbound(raw: unknown): ParseInboundResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, code: "invalid_inbound", message: "feishu event must be a JSON object" };
    }
    return parseFeishuInbound(raw as Record<string, unknown>, {
      channelId: this.channelId,
      accountId: this.accountId,
      ...(this.#config.botOpenId === undefined ? {} : { botOpenId: this.#config.botOpenId }),
      now: this.clock,
    });
  }

  protected buildTokenRequest(): { pathOrUrl: string; body: Record<string, unknown> } {
    return {
      pathOrUrl: "/open-apis/auth/v3/tenant_access_token/internal",
      body: { app_id: this.#config.appId, app_secret: this.#config.appSecret },
    };
  }

  protected prepareSend(): undefined {
    return undefined;
  }

  protected buildSendRequest(
    outbound: OutboundMessage,
  ): { pathOrUrl: string; body: Record<string, unknown> } {
    const replyTo = outbound.reply_to_native_message_id;
    const proactive = replyTo === undefined;
    const pathOrUrl = proactive
      ? "/open-apis/im/v1/messages?receive_id_type=chat_id"
      : `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`;
    const body = proactive
      ? {
          receive_id: outbound.native_conversation_id,
          msg_type: "text",
          content: JSON.stringify({ text: outbound.text }),
        }
      : {
          msg_type: "text",
          content: JSON.stringify({ text: outbound.text }),
        };
    return { pathOrUrl, body };
  }

  protected createError(options: BotPlatformErrorOptions): FeishuError {
    // 骨架只会产出飞书类别表中的类别（token/platform/network/timeout 与 FEISHU_SEND_ERROR_RULES）
    return new FeishuError({ ...options, category: options.category as FeishuErrorCategory });
  }
}
