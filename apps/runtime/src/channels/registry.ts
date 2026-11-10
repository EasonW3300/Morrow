import type {
  ChannelAdapterState,
  ChannelCapabilities,
  ChannelHealth,
  ChannelSecretsView,
  ChannelSummary,
  InboundMessage,
  OutboundMessage,
} from "@morrow/protocol";
import type { EventLedger } from "../ledger.ts";
import type { SecretStore } from "../keyring.ts";
import type { SessionManager } from "../sessions.ts";
import type { ContactBindingResolver } from "../contacts/types.ts";
import { CONTACT_EVENT_TYPES } from "../contacts/events.ts";
import { buildEventEnvelope } from "../envelope.ts";
import { CHANNEL_EVENT_TYPES } from "./events.ts";
import { EchoChannelAdapter } from "./echo.ts";
import {
  channelCredentialSpec,
  readChannelSecrets,
  writeChannelSecrets,
  type ChannelSecretWriteResult,
} from "./credentials.ts";
import { ChannelInboundRouter, type InboundRouteOptions, type InboundRouteResult } from "./inbound.ts";
import { ChannelStore, type ChannelAccountInput, type ChannelAccountRecord, type ChannelIdentityInput, type ChannelMessageRecord, type ConversationAllowInput, type ConversationAllowRow, type ConversationRecord } from "./store.ts";
import { isParseError, type ChannelAdapter } from "./types.ts";

/**
 * 适配器注册表（M4-T1 / Issue #38）：
 *   - 管理适配器生命周期（registered → running / stopped / error）并落 channel.* 事件
 *   - 每个渠道绑定一个已登记账号（channel_accounts）；入站事件经适配器归一化后交路由
 *   - GET /v1/channels 的清单与 health 数据源
 *   - echo 参考适配器仅在 MORROW_CHANNEL_ECHO=1 或显式注入时启用（默认关闭）
 *
 * 适配器只做协议转换；账号/身份/白名单/权限上下文全部由本地表决定（不信任平台自报）。
 */

export interface ChannelRegistryOptions {
  dataDir: string;
  ledger: EventLedger;
  replicaId: string;
  sessions: SessionManager;
  /**
   * 启用 echo 参考适配器（仅测试/开发）。缺省读 MORROW_CHANNEL_ECHO=1；
   * 显式 false 可强制关闭（即使环境变量存在）。
   */
  enableEcho?: boolean;
  /** 任务存在性校验（入站关联 task_id 时）；缺省不校验 */
  taskExists?: (taskId: string) => boolean;
  /**
   * 外发出口（M4-T3）：助手回复入 Outbox；缺省 = 直接 adapter.send（T1/测试兼容）。
   */
  outboundSink?: { enqueue(outbound: OutboundMessage): unknown };
  /** 联系人接缝（M4-T6 / Issue #43）：邀请码绑定、身份歧义、会话归属、类别解析 */
  contacts?: ContactBindingResolver;
  /**
   * 凭据库（M4-T8 / Issue #45）：飞书/QQ 凭据配置端点读写 SecretStore。
   * 缺省 null = 只读投影不可用（GET/PUT secrets 返回 unsupported）。
   */
  secretStore?: SecretStore | null;
  now?: () => Date;
}

/** 账号登记可同时绑定 Owner 的平台身份（owner_native_ids → principal=owner） */
export interface ChannelAccountRegistration extends ChannelAccountInput {
  owner_native_ids?: string[];
}

/** 生产适配器注册项（M4-T3）：适配器 + 绑定的渠道账号（runtime 启动时注入） */
export interface ChannelAdapterRegistration {
  adapter: ChannelAdapter;
  account: ChannelAccountRegistration;
  experimental?: boolean;
}

/** enableChannel 的结果（路由层映射 HTTP 状态；M4-T5） */
export type EnableChannelResult =
  | { ok: true; channel_id: string; enabled: true; risk_notice: string | null }
  | {
      ok: false;
      code: "unknown_channel" | "not_experimental" | "risk_confirmation_required";
      message: string;
      risk_notice?: string;
    };

/** disableChannel 的结果（M4-T5） */
export type DisableChannelResult =
  | { ok: true; channel_id: string; enabled: false }
  | { ok: false; code: "unknown_channel"; message: string };

interface AdapterEntry {
  adapter: ChannelAdapter;
  state: ChannelAdapterState;
  experimental: boolean;
  detail: string | null;
}

export class ChannelRegistry {
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #sessions: SessionManager;
  readonly #store: ChannelStore;
  readonly #router: ChannelInboundRouter;
  readonly #now: () => Date;
  readonly #secretStore: SecretStore | null;
  readonly #adapters = new Map<string, AdapterEntry>();
  #closed = false;

  constructor(options: ChannelRegistryOptions) {
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#sessions = options.sessions;
    this.#store = ChannelStore.open(options.dataDir);
    this.#now = options.now ?? (() => new Date());
    this.#secretStore = options.secretStore ?? null;
    this.#router = new ChannelInboundRouter({
      ledger: options.ledger,
      replicaId: options.replicaId,
      sessions: options.sessions,
      store: this.#store,
      adapterFor: (channelId) => this.getAdapter(channelId),
      ...(options.outboundSink === undefined ? {} : { outboundSink: options.outboundSink }),
      ...(options.taskExists === undefined ? {} : { taskExists: options.taskExists }),
      ...(options.contacts === undefined ? {} : { contacts: options.contacts }),
      now: this.#now,
    });

    const echoEnabled = options.enableEcho ?? process.env.MORROW_CHANNEL_ECHO === "1";
    if (echoEnabled) this.enableEcho();
  }

  /**
   * 启用 echo 参考适配器（幂等）：注册适配器和默认账号（owner 平台身份 = "owner"）。
   * 测试可在之后 registerIdentity 增加可信联系人；生产环境不应启用。
   */
  enableEcho(): EchoChannelAdapter {
    const existing = this.#adapters.get("echo");
    let adapter: EchoChannelAdapter;
    if (existing === undefined) {
      adapter = new EchoChannelAdapter({ accountId: "echo-default", now: this.#now });
      this.registerAdapter(adapter, { experimental: true });
    } else {
      adapter = existing.adapter as EchoChannelAdapter;
    }
    if (this.#store.findAccount("echo-default") === null) {
      this.registerAccount({
        account_id: "echo-default",
        channel_id: "echo",
        native_account_id: "echo-default",
        display_name: "Echo reference adapter",
        owner_native_ids: ["owner"],
      });
    }
    return adapter;
  }

  registerAdapter(adapter: ChannelAdapter, options: { experimental?: boolean } = {}): void {
    this.#adapters.set(adapter.channelId, {
      adapter,
      state: "registered",
      experimental: options.experimental ?? adapter.experimental === true,
      detail: null,
    });
  }

  /** 登记渠道账号；owner_native_ids 同时写入本地身份映射（principal=owner, ["*"]） */
  registerAccount(input: ChannelAccountRegistration): ChannelAccountRecord {
    const account = this.#store.registerAccount(input, this.#now());
    for (const nativeId of input.owner_native_ids ?? []) {
      this.#store.registerIdentity(
        {
          account_id: account.account_id,
          native_sender_id: nativeId,
          principal: "owner",
          granted_categories: ["*"],
        },
        this.#now(),
      );
    }
    return account;
  }

  registerIdentity(input: ChannelIdentityInput): void {
    this.#store.registerIdentity(input, this.#now());
  }

  allowConversation(input: ConversationAllowInput): void {
    this.#store.allowConversation(input, this.#now());
  }

  /**
   * GET /v1/channels/:id/allowlist：渠道 ✓ 账号 → 白名单。
   * 未注册渠道返回 null（404）；已注册但未绑定账号返回空名单（不是错误——可诊断）。
   */
  allowlist(channelId: string): { account_id: string | null; entries: ConversationAllowRow[] } | null {
    if (!this.#adapters.has(channelId)) return null;
    const account = this.#store.findAccountByChannel(channelId);
    return {
      account_id: account?.account_id ?? null,
      entries: account === null ? [] : this.#store.listAllowlist(account.account_id),
    };
  }

  /**
   * PUT /v1/channels/:id/allowlist：整表替换 + channel.allowlist_updated 审计。
   * 入参已由路由校验形态（native_conversation_id 非空、mode 枚举）；这里再兜一次。
   */
  setAllowlist(
    channelId: string,
    entries: Array<{ native_conversation_id: string; mode: ConversationAllowRow["mode"] }>,
  ): { account_id: string | null; entries: ConversationAllowRow[] } | null {
    if (!this.#adapters.has(channelId)) return null;
    const account = this.#store.findAccountByChannel(channelId);
    if (account === null) return { account_id: null, entries: [] };
    this.#store.replaceAllowlist(account.account_id, entries, this.#now());
    const stored = this.#store.listAllowlist(account.account_id);
    this.#append(CONTACT_EVENT_TYPES.allowlistUpdated, {
      channel: channelId,
      account_id: account.account_id,
      allowlist: stored.map((entry) => ({ native_conversation_id: entry.native_conversation_id, mode: entry.mode })),
    });
    return { account_id: account.account_id, entries: stored };
  }

  getAdapter(channelId: string): ChannelAdapter | null {
    return this.#adapters.get(channelId)?.adapter ?? null;
  }

  /** 渠道当前绑定的账号 id（通知/Outbox 外发的 account_id 来源）；未绑定 null */
  accountIdForChannel(channelId: string): string | null {
    return this.#store.findAccountByChannel(channelId)?.account_id ?? null;
  }

  /** GET /v1/channels：适配器清单 + 绑定账号 + capabilities + state */
  list(): ChannelSummary[] {
    const out: ChannelSummary[] = [];
    for (const [channelId, entry] of this.#adapters) {
      const account = this.#store.findAccountByChannel(channelId);
      out.push({
        channel_id: channelId,
        account: account?.account_id ?? null,
        state: entry.state,
        capabilities: entry.adapter.capabilities(),
        enabled: entry.state === "running" && account?.enabled === true,
        experimental: entry.experimental,
        ...(entry.adapter.environment === undefined
          ? {}
          : { environment: entry.adapter.environment }),
        ...(entry.adapter.riskNotice === undefined ? {} : { risk_notice: entry.adapter.riskNotice }),
      });
    }
    return out;
  }

  /**
   * 渠道凭据投影（M4-T8 / Issue #45）：只报 configured，不回显密文。
   * 未注册渠道或渠道无凭据概念（微信/echo）返回 null；路由层区分 404 与 400。
   */
  async secrets(channelId: string): Promise<ChannelSecretsView | null> {
    if (!this.#adapters.has(channelId)) return null;
    const spec = channelCredentialSpec(channelId);
    if (spec === null || this.#secretStore === null) return null;
    return readChannelSecrets(this.#secretStore, spec);
  }

  /** 渠道是否有可配置凭据（路由层把「已注册但无凭据概念」映射为 400） */
  supportsSecrets(channelId: string): boolean {
    return channelCredentialSpec(channelId) !== null;
  }

  /** PUT /v1/channels/:id/secrets：只写本次提交的字段；空字符串删除可选字段 */
  async writeSecrets(channelId: string, input: unknown): Promise<ChannelSecretWriteResult | null> {
    if (!this.#adapters.has(channelId)) return null;
    const spec = channelCredentialSpec(channelId);
    if (spec === null || this.#secretStore === null) return null;
    return writeChannelSecrets(this.#secretStore, spec, input);
  }

  /** GET /v1/channels/:id/health；未知渠道 null（HTTP 404） */
  async health(channelId: string): Promise<ChannelHealth | null> {
    const entry = this.#adapters.get(channelId);
    if (entry === undefined) return null;
    const reported = await entry.adapter.health();
    return {
      channel_id: channelId,
      state: entry.state,
      healthy: entry.state === "running" && reported.healthy,
      detail: entry.detail ?? reported.detail ?? null,
      checked_at: this.#now().toISOString(),
      ...(reported.experimental === undefined || !entry.experimental
        ? {}
        : { experimental: true }),
      ...(reported.environment === undefined ? {} : { environment: reported.environment }),
      ...(reported.risk_notice === undefined ? {} : { risk_notice: reported.risk_notice }),
      ...(reported.bridge === undefined ? {} : { bridge: reported.bridge }),
      ...(reported.connection === undefined ? {} : { connection: reported.connection }),
      ...(reported.token_expires_at === undefined ? {} : { token_expires_at: reported.token_expires_at }),
      ...(reported.last_error === undefined ? {} : { last_error: reported.last_error }),
    };
  }

  capabilities(channelId: string): ChannelCapabilities | null {
    return this.getAdapter(channelId)?.capabilities() ?? null;
  }

  /** 启动所有已注册适配器；无启用账号/出厂 disabled 的适配器不强行启动（清单可见） */
  async start(): Promise<void> {
    for (const [channelId, entry] of this.#adapters) {
      if (entry.state === "running" || entry.state === "starting") continue;
      // 实验适配器（M4-T5）：出厂 disabled，必须经 enableChannel(confirmRisk=true)
      if (entry.adapter.isEnabled !== undefined && !entry.adapter.isEnabled()) {
        entry.state = "stopped";
        entry.detail = "experimental adapter disabled (explicit risk confirmation required)";
        continue;
      }
      await this.#startEntry(channelId, entry);
    }
  }

  /**
   * 显式启用实验适配器（M4-T5）：不做隐式启用。
   *   - 非实验适配器/未实现 enable → not_experimental
   *   - confirm_risk !== true → risk_confirmation_required（API 映射 409）
   *   - 成功：启用 → 启动适配器 → 落 channel.experimental_enabled 审计
   */
  async enableChannel(
    channelId: string,
    options: { confirmRisk?: boolean } = {},
  ): Promise<EnableChannelResult> {
    const entry = this.#adapters.get(channelId);
    if (entry === undefined) {
      return { ok: false, code: "unknown_channel", message: `no channel adapter registered for "${channelId}"` };
    }
    if (!entry.experimental || entry.adapter.enable === undefined) {
      return {
        ok: false,
        code: "not_experimental",
        message: `channel "${channelId}" is not an experimental adapter`,
      };
    }
    const riskNotice = entry.adapter.riskNotice ?? null;
    if (options.confirmRisk !== true) {
      return {
        ok: false,
        code: "risk_confirmation_required",
        message: `enabling experimental channel "${channelId}" requires confirm_risk=true`,
        ...(riskNotice === null ? {} : { risk_notice: riskNotice }),
      };
    }

    const wasEnabled = entry.adapter.isEnabled?.() ?? false;
    await entry.adapter.enable({ confirmRisk: true });
    if (entry.state !== "running" && entry.state !== "starting") {
      await this.#startEntry(channelId, entry);
    }
    if (!wasEnabled) {
      this.#append(CHANNEL_EVENT_TYPES.experimentalEnabled, {
        channel: channelId,
        account_id: this.accountIdForChannel(channelId),
        experimental: true,
        confirm_risk: true,
        risk_notice: riskNotice,
        environment: entry.adapter.environment ?? null,
      });
    }
    return { ok: true, channel_id: channelId, enabled: true, risk_notice: riskNotice };
  }

  /** 禁用实验适配器：立即停止收发（幂等）；未知渠道返回 unknown_channel */
  async disableChannel(channelId: string): Promise<DisableChannelResult> {
    const entry = this.#adapters.get(channelId);
    if (entry === undefined) {
      return { ok: false, code: "unknown_channel", message: `no channel adapter registered for "${channelId}"` };
    }
    const account = this.#store.findAccountByChannel(channelId);
    await entry.adapter.disable?.();
    if (entry.state === "running" || entry.state === "starting") {
      try {
        await entry.adapter.stop();
      } catch (err) {
        entry.detail = err instanceof Error ? err.message : String(err);
      }
      this.#append(CHANNEL_EVENT_TYPES.adapterStopped, {
        channel: channelId,
        account_id: account?.account_id ?? null,
        reason: "disabled",
      });
    }
    entry.state = "stopped";
    entry.detail = "adapter disabled by Owner (explicit risk confirmation required to re-enable)";
    return { ok: true, channel_id: channelId, enabled: false };
  }

  /** 启动单个适配器条目（start / enable 共用）；失败只影响本渠道 */
  async #startEntry(channelId: string, entry: AdapterEntry): Promise<void> {
    const account = this.#store.findAccountByChannel(channelId);
    if (account === null) {
      entry.state = "error";
      entry.detail = "no enabled channel account registered";
      return;
    }
    entry.state = "starting";
    try {
      await entry.adapter.start({
        accountId: account.account_id,
        onInbound: (raw) => {
          this.ingest(channelId, raw);
        },
        onInboundRejected: (rejection) => {
          this.#router.reject({
            channel: channelId,
            reason: rejection.reason ?? "event_rejected",
            error_code: rejection.code,
            detail: rejection.message,
          });
        },
        isConversationAllowed: (nativeConversationId) =>
          this.#store.isConversationAllowed(account.account_id, nativeConversationId),
      });
      entry.state = "running";
      entry.detail = null;
      this.#append(CHANNEL_EVENT_TYPES.adapterStarted, {
        channel: channelId,
        account_id: account.account_id,
        experimental: entry.experimental,
      });
    } catch (err) {
      entry.state = "error";
      entry.detail = err instanceof Error ? err.message : String(err);
      this.#append(CHANNEL_EVENT_TYPES.adapterStopped, {
        channel: channelId,
        account_id: account.account_id,
        reason: "start_failed",
        error: entry.detail,
      });
    }
  }

  /** 停止运行中的适配器（幂等）；每次实际停止落 channel.adapter_stopped */
  async stop(): Promise<void> {
    for (const [channelId, entry] of this.#adapters) {
      if (entry.state !== "running" && entry.state !== "starting") continue;
      const account = this.#store.findAccountByChannel(channelId);
      try {
        await entry.adapter.stop();
      } catch (err) {
        entry.detail = err instanceof Error ? err.message : String(err);
      }
      entry.state = "stopped";
      this.#append(CHANNEL_EVENT_TYPES.adapterStopped, {
        channel: channelId,
        account_id: account?.account_id ?? null,
      });
    }
  }

  /**
   * 平台事件入口（适配器 onInbound 回调）：取适配器 → parseInbound →
   * 解析失败落 inbound_rejected（reason=parse_error）→ 成功交统一入站路由。
   */
  ingest(channelId: string, raw: unknown, options: InboundRouteOptions = {}): InboundRouteResult {
    const entry = this.#adapters.get(channelId);
    if (entry === undefined) {
      return this.#router.reject({ channel: channelId, reason: "channel_not_registered" });
    }
    if (entry.state !== "running") {
      return this.#router.reject({ channel: channelId, reason: "adapter_not_running" });
    }
    const parsed = entry.adapter.parseInbound(raw);
    if (isParseError(parsed)) {
      return this.#router.reject({
        channel: channelId,
        reason: "parse_error",
        error_code: parsed.code,
        detail: parsed.message,
      });
    }
    return this.#router.route(parsed, { ...options, raw });
  }

  /** 已归一化消息的直接入口（程序化注入/测试；仍走完整路由与权限解析） */
  routeInbound(inbound: InboundMessage, options: InboundRouteOptions = {}): InboundRouteResult {
    return this.#router.route(inbound, options);
  }

  getConversation(accountId: string, nativeConversationId: string): ConversationRecord | null {
    return this.#store.findConversation(accountId, nativeConversationId);
  }

  listMessages(conversationId: string): ChannelMessageRecord[] {
    return this.#store.listMessages(conversationId);
  }

  /** 关闭底层存储（调用方应先 stop 以落 adapter_stopped 事件） */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  #append(eventType: string, payload: Record<string, unknown>): void {
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType,
        payload,
      }),
    );
  }
}
