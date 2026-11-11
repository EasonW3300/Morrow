import type { ChannelCapabilities, OutboundMessage } from "@morrow/protocol";
import type { ChannelTestEventFrame } from "../../testing/channel-test-server.ts";
import type { ParseInboundResult } from "../../types.ts";
import { ChannelSendError, isParseError } from "../../types.ts";
import type { EventTransport } from "../../event-transport.ts";
import {
  HttpBotAdapter,
  type BotChannelSpec,
  type BotHttpResult,
  type ReadTokenResult,
} from "../shared/http-bot-adapter.ts";
import type { BotPlatformErrorOptions } from "../shared/error-catalog.ts";
import { isQqWebSocketTransport } from "./websocket-transport.ts";
import { QqError, QQ_SEND_ERROR_RULES, type QqErrorCategory } from "./errors.ts";
import {
  classifyQqEvent,
  parseQqInbound,
  verifyQqEvent,
  type QqVerifyResult,
} from "./events.ts";
import type { QqConfig } from "./config.ts";

/**
 * QQ 官方 Bot 适配器（M4-T4 / Issue #41，stable baseline channel）。
 *
 * 边界（T1 契约不变）：只做协议转换——事件校验/归一化、群/私聊消息 API 发送、
 * 错误分类、capabilities/health 自报。权限/身份/白名单仍由本地入站路由决定。
 *
 * 与飞书（T3）的差异（显式处理；Issue #49 起骨架在 `shared/`）：
 * - 鉴权：AppID/AppSecret → `POST /app/getAppAccessToken` 换 access token，
 *   头为 `Authorization: QQBot <token>`；token 缓存 + 提前刷新 + 失效重试一次；
 * - 目标：群消息 `/v2/groups/{group_openid}/messages`、私聊
 *   `/v2/users/{user_openid}/messages`（两条 API，需知道会话形态；由入站事件学习，
 *   `conversationKinds` 选项可预注册，未知形态显式失败而非猜测）；
 * - 被动/主动：带 `msg_id` = 被动回复（引用原消息，`msg_seq` 递增避免平台判重）；
 *   不带 = 主动消息（平台有场景/额度限制，`capabilities().group_proactive = limited`）；
 * - 主动消息被拒 → `proactive_rejected`（explicit + 不可重试）→ Outbox 直接
 *   needs_review，不自动重发；
 * - 事件签名：配置 `bot_secret` 后 Webhook 模式强制 Ed25519 校验（真实公网回调语义）；
 *   真实平台推荐用 `QqWebSocketTransport`（官方网关、无需公网回调，见
 *   `websocket-transport.ts`）：WS Dispatch 由 access token 鉴权，走
 *   `handleTrustedEvent`；未配置 bot_secret 时的 HTTP 长轮询/内网桥接仍走 `handleFrame`。
 */

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  // QQ 主动消息受平台场景/额度强限制（且用户可关闭「允许主动发送」）——绝不声明 supported
  group_proactive: "limited",
  // 入站附件只保留平台 URL 引用；出站富媒体需先上传，未实现
  attachments: "limited",
  edit: "unsupported",
};

export interface QqChannelAdapterOptions {
  accountId?: string;
  config: QqConfig;
  /** Bot API 基地址（默认 https://api.sgroup.qq.com；测试改成本地 ChannelTestServer） */
  apiBaseUrl?: string;
  /**
   * access token 端点覆盖（默认 https://api.bot.qq.com/app/getAppAccessToken；
   * 部分旧文档/SDK 用 https://bots.qq.com/app/getAppAccessToken，可在此覆盖）。
   * config.tokenEndpoint 优先于本选项（SecretStore 覆盖运行时选项）。
   */
  tokenEndpoint?: string;
  /** fetch 注入（测试可观察/模拟网络错误；缺省全局 fetch） */
  fetch?: typeof fetch;
  now?: () => Date;
  /** 单次 HTTP 请求超时（毫秒，默认 10000） */
  requestTimeoutMs?: number;
  /** token 提前刷新窗口（毫秒，默认 300000 = 5 分钟） */
  tokenRefreshSkewMs?: number;
  /** 事件时间偏差容忍（秒，默认 300；0 = 不校验） */
  signatureToleranceSeconds?: number;
  /**
   * 事件传输。生产传 `QqWebSocketTransport`（QQ 官方 WebSocket 网关；无需公网回调）；
   * 缺省 = apiBaseUrl 上的 HTTP 长轮询，与 ChannelTestServer 对齐。
   */
  eventTransport?: EventTransport;
  /** 长轮询路径（默认 /open-apis/event/v1/stream，与共享协议桩对齐） */
  eventStreamPath?: string;
  /** 长轮询单次等待（毫秒，默认 1000） */
  eventPollTimeoutMs?: number;
  /** 长轮询重连等待（毫秒，默认 500） */
  eventReconnectDelayMs?: number;
  /**
   * 预注册会话形态（native_conversation_id → group|direct）。入站消息会自动学习；
   * 主动消息（通知等）要发往从未入站的会话时，必须在此显式登记。
   */
  conversationKinds?: Record<string, "group" | "direct">;
  /** 未知会话形态时的缺省（默认不猜测：显式失败） */
  defaultConversationKind?: "group" | "direct";
}

const DEFAULT_API_BASE_URL = "https://api.sgroup.qq.com";
/** 官方当前文档指向 api.bot.qq.com；旧文档/部分 SDK 仍用 bots.qq.com，可用配置覆盖 */
const DEFAULT_TOKEN_ENDPOINT = "https://api.bot.qq.com/app/getAppAccessToken";

function parseExpiresIn(value: number | string | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : 7_200;
}

/** access token 端点响应解析（expires_in 可能是字符串；缺失/非法按 7200s） */
function readQqToken(response: BotHttpResult): ReadTokenResult {
  const payload = response.payload;
  if (
    response.status < 200 ||
    response.status >= 300 ||
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0
  ) {
    return {
      ok: false,
      failure: {
        category: "token_invalid",
        message:
          (payload.message as string | undefined) ??
          (payload.msg as string | undefined) ??
          `qq token endpoint responded ${response.status}`,
        httpStatus: response.status,
        ...(payload.code === undefined ? {} : { code: payload.code as number }),
      },
    };
  }
  return {
    ok: true,
    value: payload.access_token,
    expiresInSeconds: parseExpiresIn(payload.expires_in as number | string | undefined),
  };
}

const SPEC: BotChannelSpec = {
  channelId: "qq",
  label: "qq",
  defaultAccountId: "qq-default",
  capabilities: CAPABILITIES,
  healthyDetail: "qq event stream established; access_token cached",
  authScheme: "QQBot",
  tokenLabel: "qq access token",
  nonJsonMessageKey: "message",
  sendErrorRules: QQ_SEND_ERROR_RULES,
  readPlatformMessage: (payload) => {
    // 与重构前一致：message 优先，空字符串视为缺失（用默认文案）
    const message = (payload.message ?? payload.msg ?? "") as string;
    return message.length > 0 ? message : undefined;
  },
  readToken: readQqToken,
  readRemoteMessageId: (payload) => (typeof payload.id === "string" ? payload.id : undefined),
};

export class QqChannelAdapter extends HttpBotAdapter<
  QqError,
  QqVerifyResult,
  "group" | "direct"
> {
  readonly #config: QqConfig;
  readonly #tokenEndpoint: string;
  readonly #defaultConversationKind: "group" | "direct" | null;
  readonly #conversationKinds = new Map<string, "group" | "direct">();
  /** 每条入站消息已被引用回复的次数（QQ 要求 msg_id + msg_seq 组合唯一，递增避免判重） */
  readonly #replySeq = new Map<string, number>();

  constructor(options: QqChannelAdapterOptions) {
    super(SPEC, {
      accountId: options.accountId,
      baseUrl: options.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      fetch: options.fetch,
      now: options.now,
      requestTimeoutMs: options.requestTimeoutMs,
      tokenRefreshSkewMs: options.tokenRefreshSkewMs,
      signatureToleranceSeconds: options.signatureToleranceSeconds,
      eventTransport: options.eventTransport,
      eventStreamPath: options.eventStreamPath ?? "/open-apis/event/v1/stream",
      eventPollTimeoutMs: options.eventPollTimeoutMs,
      eventReconnectDelayMs: options.eventReconnectDelayMs,
    });
    this.#config = options.config;
    this.#tokenEndpoint = options.config.tokenEndpoint ?? options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
    this.#defaultConversationKind = options.defaultConversationKind ?? null;
    for (const [id, kind] of Object.entries(options.conversationKinds ?? {})) {
      this.#conversationKinds.set(id, kind);
    }
  }

  /** 主动消息目标形态登记（生产宿主可从渠道白名单/配置调用；入站会自动学习） */
  rememberConversationKind(id: string, kind: "group" | "direct"): void {
    this.#conversationKinds.set(id, kind);
  }

  /**
   * 已鉴权 WS 事件入口（QQ 官方 WebSocket 网关专用）。
   *
   * 信任边界：只允许 `QqWebSocketTransport` 调用。该传输在 Identify 时用
   * `QQBot <access_token>` 完成网关鉴权，之后的 Dispatch 都由平台在**已认证连接**
   * 上推送；网关协议没有 Webhook 的 `X-Signature-Ed25519` 帧签名（那是公网回调
   * 防伪用的），因此这里跳过 `verifyQqEvent` 的签名校验，保留 classify 的结构校验
   * 与拒绝留痕。Webhook 模式（带 bot_secret）继续走 `handleFrame`。
   *
   * 其它来源（HTTP 请求体、UI、本地文件）**不得**调用本方法——否则等于绕过签名。
   */
  handleTrustedEvent(event: unknown): QqVerifyResult | { ok: true } {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      const result = {
        ok: false as const,
        code: "invalid_body",
        message: "qq websocket event must be a JSON object",
      };
      this.rejectInbound(result.code, result.message, {});
      return result;
    }

    const record = event as Record<string, unknown>;
    const classified = classifyQqEvent(record);
    if (classified.kind === "message") {
      // 学会话形态（group / direct）：`send()` 据此选择 /v2/groups/* 还是 /v2/users/*，
      // 未学过就会以 unknown_conversation 拒发。Webhook 路径由调用的 parseInbound 学习，
      // WS 路径没有经过那里——真实联调中就是这里漏掉，导致"收到消息但回不出去"。
      const parsed = this.parseInbound(record);
      if (isParseError(parsed)) {
        this.rejectInbound(parsed.code, parsed.message, record);
        return { ok: true };
      }
      this.deliverInbound(record);
    }
    return { ok: true };
  }

  protected verifyFrame(frame: ChannelTestEventFrame): QqVerifyResult {
    return verifyQqEvent(frame, this.#config, {
      toleranceSeconds: this.signatureToleranceSeconds,
      now: this.clock,
    });
  }

  protected isInboundEvent(event: Record<string, unknown>): boolean {
    return classifyQqEvent(event).kind === "message";
  }

  parseInbound(raw: unknown): ParseInboundResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, code: "invalid_inbound", message: "qq event must be a JSON object" };
    }
    const parsed = parseQqInbound(raw as Record<string, unknown>, {
      channelId: this.channelId,
      accountId: this.accountId,
      ...(this.#config.appId.length === 0 ? {} : { botOpenId: this.#config.appId }),
      now: this.clock,
    });
    // 入站时学习会话形态，供后续回复/主动消息选择正确的 API 端点
    if (!isParseError(parsed)) {
      this.#conversationKinds.set(parsed.native_conversation_id, parsed.conversation_kind);
    }
    return parsed;
  }

  protected buildTokenRequest(): { pathOrUrl: string; body: Record<string, unknown> } {
    return {
      pathOrUrl: this.#tokenEndpoint,
      body: { appId: this.#config.appId, clientSecret: this.#config.appSecret },
    };
  }

  /** 目标形态解析在发 token 之前完成；未知形态按 explicit/unknown_conversation 拒发 */
  protected prepareSend(outbound: OutboundMessage): "group" | "direct" {
    const kind =
      this.#conversationKinds.get(outbound.native_conversation_id) ?? this.#defaultConversationKind;
    if (kind === null) {
      throw new ChannelSendError(
        "explicit",
        `unknown qq conversation kind for "${outbound.native_conversation_id}" (register conversationKinds)`,
        { code: "unknown_conversation", retryable: false },
      );
    }
    return kind;
  }

  protected buildSendRequest(
    outbound: OutboundMessage,
    kind: "group" | "direct",
  ): { pathOrUrl: string; body: Record<string, unknown> } {
    const replyTo = outbound.reply_to_native_message_id;
    const pathOrUrl =
      kind === "group"
        ? `/v2/groups/${encodeURIComponent(outbound.native_conversation_id)}/messages`
        : `/v2/users/${encodeURIComponent(outbound.native_conversation_id)}/messages`;

    const body: Record<string, unknown> = {
      content: outbound.text,
      msg_type: 0,
    };
    if (replyTo !== undefined) {
      body.msg_id = replyTo;
      const seq = (this.#replySeq.get(replyTo) ?? 0) + 1;
      this.#replySeq.set(replyTo, seq);
      body.msg_seq = seq;
    }
    return { pathOrUrl, body };
  }

  protected createError(options: BotPlatformErrorOptions): QqError {
    // 骨架只会产出 QQ 类别表中的类别（token/platform/network/timeout 与 QQ_SEND_ERROR_RULES）
    return new QqError({ ...options, category: options.category as QqErrorCategory });
  }

  /** QQ 的 last_error 带 `category:` 前缀（既有日志口径，UI/诊断依赖） */
  protected formatSendFailure(err: QqError): string {
    return `${err.category}: ${err.message}`;
  }

  /** WS 网关传输与适配器共用 token 缓存；Dispatch 走已鉴权的可信入口 */
  protected attachTransport(transport: EventTransport): void {
    if (!isQqWebSocketTransport(transport)) return;
    transport.attachTokenProvider({
      getAccessToken: () => this.ensureToken(),
      refreshAccessToken: () => this.ensureToken(true),
    });
    transport.attachTrustedEventSink((event) => this.handleTrustedEvent(event));
  }
}
