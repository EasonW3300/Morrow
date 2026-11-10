import type {
  ChannelCapabilities,
  ChannelEnvironment,
  ChannelSendReceipt,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
} from "@morrow/protocol";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterHealth,
  ParseInboundResult,
} from "../../types.ts";
import { ChannelSendError } from "../../types.ts";
import { WECHAT_ENVIRONMENT, WECHAT_RISK_NOTICE } from "./constants.ts";
import {
  LocalBridgeError,
  type LocalBridge,
  type LocalBridgeInboundMessage,
  type LocalBridgeStatus,
} from "./local-bridge.ts";

/**
 * 微信个人号实验适配器（M4-T5 / Issue #42，ADR-0005）。
 *
 * 出厂 **disabled**：构造函数不连接任何桥；`enable({confirmRisk:true})` 才能启动，
 * 且 API 层会先强制确认风险并落 `channel.experimental_enabled` 审计。
 *
 * 边界：适配器只做协议转换 + 实验性防护（白名单 fail-closed、健康自报、错误分类）；
 * 身份/权限仍由 T1 统一入站路由按本地账本决定。真实微信收发依赖可注入的 LocalBridge，
 * M4 只提供 StubLocalBridge（真实桥未实现，见 README）。
 *
 * 防护规则：
 * - 只有 `channel_allowlist` 中的会话才收发（私聊/群聊一致，由 registry 注入判定）；
 * - 未启用/未启动时 start/send 明确拒绝；
 * - 禁用立即断开桥并丢弃后续消息（stop/disable 幂等）。
 */

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  // 个人号群聊自动化不承诺稳定（依赖非官方 UI 自动化）
  group_mention: "limited",
  // 绝不承诺无限主动消息
  group_proactive: "unsupported",
  // 出站附件投递未实现；入站附件引用也不在 M4 范围
  attachments: "unsupported",
  edit: "unsupported",
};

/** 未显式确认风险时的拒绝（API 层映射为 409 risk_confirmation_required）。 */
export class WeChatRiskConfirmationRequiredError extends Error {
  readonly code = "risk_confirmation_required";
  constructor() {
    super("wechat experimental adapter requires confirm_risk=true before enable");
    this.name = "WeChatRiskConfirmationRequiredError";
  }
}

/** 出厂 disabled 时尝试启动/发送的拒绝。 */
export class WeChatExperimentalDisabledError extends Error {
  readonly code = "experimental_disabled";
  constructor() {
    super(
      "wechat experimental adapter is disabled; enable it with explicit risk confirmation (confirm_risk=true) first",
    );
    this.name = "WeChatExperimentalDisabledError";
  }
}

export interface WeChatChannelAdapterOptions {
  /** 本地自动化桥（生产 = 真实桥；M4 测试 = StubLocalBridge） */
  bridge: LocalBridge;
  accountId?: string;
  /** 仅测试/宿主显式注入；生产必须走 enable({confirmRisk:true}) */
  enabled?: boolean;
  now?: () => Date;
  environment?: ChannelEnvironment;
  riskNotice?: string;
}

export class WeChatChannelAdapter implements ChannelAdapter {
  readonly channelId = "wechat";
  readonly experimental = true;
  readonly requiresConversationAllowlist = true;
  readonly environment: ChannelEnvironment;
  readonly riskNotice: string;

  readonly #bridge: LocalBridge;
  readonly #now: () => Date;

  #accountId: string;
  #enabled: boolean;
  #running = false;
  #onInbound: ((raw: unknown) => void) | null = null;
  #onInboundRejected: ChannelAdapterContext["onInboundRejected"] | null = null;
  #isConversationAllowed: ((nativeConversationId: string) => boolean) | null = null;
  #unsubscribe: (() => void) | null = null;
  #lastError: string | null = null;

  constructor(options: WeChatChannelAdapterOptions) {
    this.#bridge = options.bridge;
    this.#accountId = options.accountId ?? "wechat-default";
    this.#enabled = options.enabled === true;
    this.#now = options.now ?? (() => new Date());
    this.environment = options.environment ?? WECHAT_ENVIRONMENT;
    this.riskNotice = options.riskNotice ?? WECHAT_RISK_NOTICE;
  }

  get accountId(): string {
    return this.#accountId;
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  /** 显式启用：未 confirm_risk=true 一律拒绝（API 层再强制一次）。 */
  enable(options: { confirmRisk?: boolean }): void {
    if (options.confirmRisk !== true) throw new WeChatRiskConfirmationRequiredError();
    this.#enabled = true;
  }

  /** 禁用：立即停止收发并断开桥（幂等）。 */
  async disable(): Promise<void> {
    this.#enabled = false;
    await this.stop();
  }

  async start(context: ChannelAdapterContext): Promise<void> {
    if (!this.#enabled) throw new WeChatExperimentalDisabledError();
    this.#accountId = context.accountId;
    this.#onInbound = context.onInbound;
    this.#onInboundRejected = context.onInboundRejected ?? null;
    this.#isConversationAllowed = context.isConversationAllowed ?? null;
    if (this.#running) return;

    this.#running = true;
    try {
      await this.#bridge.connect();
      this.#unsubscribe = this.#bridge.onMessage((message) => this.#handleBridgeMessage(message));
      this.#lastError = null;
    } catch (err) {
      this.#running = false;
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** 停止：幂等；断开桥并把后续桥消息挡在 onInbound 之外。 */
  async stop(): Promise<void> {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#onInbound = null;
    this.#onInboundRejected = null;
    this.#isConversationAllowed = null;
    try {
      await this.#bridge.disconnect();
    } catch (err) {
      // 停止路径不抛错（幂等优先），错误留在 health 供诊断
      this.#lastError = err instanceof Error ? err.message : String(err);
    }
  }

  parseInbound(raw: unknown): ParseInboundResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return invalid("raw payload must be a JSON object");
    }
    const record = raw as Record<string, unknown>;

    const messageId = nonEmptyString(record.message_id);
    const conversationId = nonEmptyString(record.conversation_id);
    if (messageId === null) return invalid("message_id must be a non-empty string");
    if (conversationId === null) return invalid("conversation_id must be a non-empty string");

    const senderRecord = record.sender;
    if (typeof senderRecord !== "object" || senderRecord === null || Array.isArray(senderRecord)) {
      return invalid("sender must be an object with a native id");
    }
    const senderId = nonEmptyString((senderRecord as Record<string, unknown>).id);
    if (senderId === null) return invalid("sender.id must be a non-empty string");
    const senderName = nonEmptyString((senderRecord as Record<string, unknown>).name);

    const timestamp = nonEmptyString(record.timestamp) ?? this.#now().toISOString();
    const text = typeof record.text === "string" ? record.text : "";
    const conversationKind = record.conversation_kind === "group" ? "group" : "direct";
    const mentionedIds = Array.isArray(record.mentioned_user_ids)
      ? record.mentioned_user_ids.filter((id): id is string => typeof id === "string")
      : undefined;

    const message: InboundMessage = {
      channel: this.channelId,
      account: this.#accountId,
      native_message_id: messageId,
      native_conversation_id: conversationId,
      conversation_kind: conversationKind,
      sender: {
        native_id: senderId,
        ...(senderName === null ? {} : { display_name: senderName }),
      },
      mention: {
        agent: record.mentions_agent === true,
        ...(mentionedIds === undefined ? {} : { native_ids: mentionedIds }),
      },
      // 个人号桥不提供附件引用；M4 不实现附件
      attachments: [] as InboundAttachment[],
      timestamp,
      text,
      // 权限上下文绝不由适配器给出（不信任平台自报身份）
      permission_context: null,
    };
    return message;
  }

  async send(outbound: OutboundMessage): Promise<ChannelSendReceipt> {
    if (!this.#enabled || !this.#running) {
      throw new ChannelSendError("explicit", "wechat experimental adapter is not running", {
        code: "adapter_not_running",
        retryable: true,
      });
    }
    if ((outbound.attachments ?? []).length > 0) {
      throw new ChannelSendError(
        "explicit",
        "wechat outbound attachments are not implemented (capabilities.attachments = unsupported)",
        { code: "unsupported_attachment", retryable: false },
      );
    }
    if (
      this.#isConversationAllowed === null ||
      !this.#isConversationAllowed(outbound.native_conversation_id)
    ) {
      throw new ChannelSendError(
        "explicit",
        `conversation ${outbound.native_conversation_id} is not in channel_allowlist`,
        { code: "conversation_not_allowed", retryable: false },
      );
    }

    try {
      const result = await this.#bridge.sendMessage({
        conversation_id: outbound.native_conversation_id,
        text: outbound.text,
        ...(outbound.reply_to_native_message_id === undefined
          ? {}
          : { reply_to_message_id: outbound.reply_to_native_message_id }),
      });
      this.#lastError = null;
      return {
        channel: this.channelId,
        ...(result.message_id === undefined ? {} : { remote_message_id: result.message_id }),
        delivered_at: result.delivered_at ?? this.#now().toISOString(),
      };
    } catch (err) {
      const mapped = toChannelSendError(err);
      this.#lastError = mapped.message;
      throw mapped;
    }
  }

  async health(): Promise<ChannelAdapterHealth> {
    const status = await this.#bridge.status();
    const healthy =
      this.#enabled &&
      this.#running &&
      status.process === "running" &&
      status.login === "logged_in" &&
      status.window === "available";
    const lastError = status.last_error ?? this.#lastError;
    const bridge = {
      process: status.process,
      login: status.login,
      window: status.window,
      last_error: lastError,
    };
    return {
      healthy,
      detail: this.#detail(status, healthy),
      connection: this.#running ? (healthy ? "connected" : "degraded") : "disconnected",
      experimental: true,
      environment: this.environment,
      risk_notice: this.riskNotice,
      bridge,
      last_error: lastError,
    };
  }

  capabilities(): ChannelCapabilities {
    return { ...CAPABILITIES };
  }

  #handleBridgeMessage(message: LocalBridgeInboundMessage): void {
    if (!this.#running || this.#onInbound === null) return;
    const conversationId =
      typeof message === "object" && message !== null && typeof message.conversation_id === "string"
        ? message.conversation_id
        : "";
    if (
      this.#isConversationAllowed === null ||
      conversationId.length === 0 ||
      !this.#isConversationAllowed(conversationId)
    ) {
      this.#onInboundRejected?.({
        code: "conversation_not_allowed",
        message: `conversation ${conversationId || "<unknown>"} is not in channel_allowlist`,
        reason: "conversation_not_allowed",
        raw: message,
      });
      return;
    }
    this.#onInbound(message);
  }

  #detail(status: LocalBridgeStatus, healthy: boolean): string {
    if (!this.#enabled) {
      return "wechat experimental adapter is disabled (explicit risk confirmation required)";
    }
    if (!this.#running) return "wechat experimental adapter is not running";
    if (healthy) {
      return "wechat local bridge is connected; process running, logged in, window available";
    }
    const reason = status.last_error ?? this.#lastError;
    return `wechat local bridge is degraded${reason === null || reason === undefined ? "" : `: ${reason}`}`;
  }
}

function toChannelSendError(err: unknown): ChannelSendError {
  if (err instanceof ChannelSendError) return err;
  if (err instanceof LocalBridgeError) {
    return new ChannelSendError(err.kind, err.message, {
      ...(err.code === undefined ? {} : { code: err.code }),
      retryable: err.retryable,
    });
  }
  return new ChannelSendError("network", err instanceof Error ? err.message : String(err));
}

function invalid(message: string): ParseInboundResult {
  return { ok: false, code: "invalid_inbound", message };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
