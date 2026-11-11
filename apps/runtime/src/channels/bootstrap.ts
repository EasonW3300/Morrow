import type {
  ChannelCapabilities,
  ChannelEnvironment,
  ChannelSendReceipt,
  OutboundMessage,
} from "@morrow/protocol";
import type { SecretStore } from "../keyring.ts";
import {
  FeishuChannelAdapter,
  loadFeishuConfig,
  type FeishuChannelAdapterOptions,
} from "./adapters/feishu/index.ts";
import { FEISHU_SECRET_SERVICE } from "./adapters/feishu/config.ts";
import { loadQqConfig, QqChannelAdapter, type QqChannelAdapterOptions } from "./adapters/qq/index.ts";
import { QQ_SECRET_SERVICE } from "./adapters/qq/config.ts";
import { WeChatChannelAdapter } from "./adapters/wechat/adapter.ts";
import { WECHAT_ENVIRONMENT, WECHAT_RISK_NOTICE } from "./adapters/wechat/constants.ts";
import {
  LocalBridgeError,
  type LocalBridge,
  type LocalBridgeInboundMessage,
  type LocalBridgeSendInput,
  type LocalBridgeSendResult,
  type LocalBridgeStatus,
} from "./adapters/wechat/local-bridge.ts";
import type { ChannelAdapterRegistration } from "./registry.ts";
import { ChannelSendError, type ChannelAdapter, type ChannelAdapterHealth, type ParseInboundResult } from "./types.ts";

/**
 * 生产渠道自动装配（A1 修复批 / Issue #37）。
 *
 * 现状修复前：飞书/QQ/微信适配器只在测试与 `scripts/real-machine/*` 里被 `new`，
 * 生产入口（apps/runtime/src/main.ts → startRuntime）不注入任何适配器——UI 配好
 * 凭据后 `/v1/channels` 仍为空。本模块按 SecretStore 中「已配置凭据」自动构造并
 * 返回注册项；启停仍由 ChannelRegistry 管（缺省未启用，Owner 显式 enable）。
 *
 * 判定口径（与渠道凭据端点同源）：
 *   - 飞书：`channel:feishu:app_id` 非空；
 *   - QQ：`channel:qq:app_id` 非空；
 *   - 微信：`channel:wechat:bridge_command` / `bridge_endpoint` 任一非空
 *     （真实本地桥未实现，宿主可经 options.wechat.bridge 注入；未注入时注册一个
 *     health 可见的不可用桥，仍出厂 disabled）。
 *
 * 失败隔离：必填字段缺失时注册一个 `UnavailableChannelAdapter`（state=error，
 * health.detail 给出缺失字段），绝不让单个渠道配置错误阻断 Runtime 启动。
 */

export type AutoChannelId = "feishu" | "qq" | "wechat";

/** 微信凭据服务名（本地桥配置；无平台 AppSecret 概念） */
export const WECHAT_SECRET_SERVICE = "channel:wechat";
export const WECHAT_SECRET_FIELDS = ["bridge_command", "bridge_endpoint"] as const;

export type FeishuChannelOverrides = Omit<Partial<FeishuChannelAdapterOptions>, "config" | "accountId">;
export type QqChannelOverrides = Omit<Partial<QqChannelAdapterOptions>, "config" | "accountId">;

export interface ChannelBootstrapOptions {
  secretStore: SecretStore;
  /** 飞书适配器非机密覆盖（baseUrl/fetch/超时；测试对接 ChannelTestServer） */
  feishu?: FeishuChannelOverrides;
  /** QQ 适配器非机密覆盖（apiBaseUrl/tokenEndpoint/fetch/超时） */
  qq?: QqChannelOverrides;
  /** 微信本地桥注入（生产 = 真桥；测试 = StubLocalBridge）；缺省 = 不可用占位 */
  wechat?: { bridge?: LocalBridge };
  /** Owner 的平台原生 id（入站身份映射 owner_native_ids；缺省不映射） */
  ownerNativeIds?: Partial<Record<AutoChannelId, string[]>>;
}

const CAPABILITIES: ChannelCapabilities = {
  direct_message: "unsupported",
  group_mention: "unsupported",
  group_proactive: "unsupported",
  attachments: "unsupported",
  edit: "unsupported",
};

/** 配置不可用时的占位适配器：让渠道出现在清单/health，start 失败被 registry 隔离 */
class UnavailableChannelAdapter implements ChannelAdapter {
  readonly channelId: string;
  readonly experimental: boolean;
  readonly #error: string;

  constructor(channelId: string, error: string, options: { experimental?: boolean } = {}) {
    this.channelId = channelId;
    this.#error = error;
    this.experimental = options.experimental === true;
  }

  start(): never {
    throw new Error(this.#error);
  }

  async stop(): Promise<void> {}

  send(_outbound: OutboundMessage): never {
    throw new ChannelSendError("explicit", this.#error, { code: "adapter_unavailable", retryable: false });
  }

  health(): ChannelAdapterHealth {
    return {
      healthy: false,
      detail: this.#error,
      connection: "disconnected",
      last_error: this.#error,
      ...(this.experimental ? { experimental: true } : {}),
    };
  }

  parseInbound(_raw: unknown): ParseInboundResult {
    return { ok: false, code: "adapter_unavailable", message: this.#error };
  }

  capabilities(): ChannelCapabilities {
    return { ...CAPABILITIES };
  }
}

/**
 * 未配置凭据的已知渠道占位（Issue #37 修复批 A5）。
 *
 * 为什么需要：凭据端点 `/v1/channels/:id/secrets` 只对「已注册」适配器开放，
 * 而注册条件又是"凭据已存在"——形成死循环：新渠道无法通过 UI 首次配置，只能
 * 手工写钥匙串。现在三个已知渠道**始终**出现在清单里（capabilities 用真实矩阵，
 * health 明确"未配置"），UI 可先写凭据、再 enable；未配置时 registry 因
 * managed+enabled=false 不会 start，不会产生任何收发。
 */
class PendingChannelAdapter implements ChannelAdapter {
  readonly channelId: string;
  readonly experimental: boolean;
  /** 未配置：registry 据 this 保持 stopped，不尝试 start */
  readonly isConfigured = () => false;
  /** 占位适配器永不可启用；isConfigured=false 会先短路，仅满足 ConfigurableChannel 接口 */
  readonly isEnabled = () => false;
  readonly #capabilities: ChannelCapabilities;

  constructor(
    channelId: string,
    capabilities: ChannelCapabilities,
    options: { experimental?: boolean } = {},
  ) {
    this.channelId = channelId;
    this.#capabilities = capabilities;
    this.experimental = options.experimental === true;
  }

  start(): never {
    throw new ChannelNotConfiguredError(this.channelId);
  }

  async stop(): Promise<void> {}

  send(_outbound: OutboundMessage): never {
    throw new ChannelSendError(
      "explicit",
      `channel "${this.channelId}" is not configured yet (put credentials via PUT /v1/channels/${this.channelId}/secrets)`,
      { code: "channel_not_configured", retryable: false },
    );
  }

  health(): ChannelAdapterHealth {
    return {
      healthy: false,
      detail: "channel_not_configured: 尚未配置凭据",
      connection: "disconnected",
      last_error: null,
      ...(this.experimental ? { experimental: true } : {}),
    };
  }

  parseInbound(_raw: unknown): ParseInboundResult {
    return {
      ok: false,
      code: "channel_not_configured",
      message: `channel "${this.channelId}" is not configured`,
    };
  }

  capabilities(): ChannelCapabilities {
    return { ...this.#capabilities };
  }
}

/** enable 一个未配置渠道时抛出，供 registry 映射为 409 channel_not_configured */
export class ChannelNotConfiguredError extends Error {
  readonly code = "channel_not_configured";
  constructor(channelId: string) {
    super(
      `channel "${channelId}" is not configured: PUT /v1/channels/${channelId}/secrets first, then enable`,
    );
    this.name = "ChannelNotConfiguredError";
  }
}

/** 各渠道的真实能力矩阵（未配置时也如实展示，避免 UI 误标"不支持"） */
const FEISHU_CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  group_proactive: "limited",
  attachments: "limited",
  edit: "unsupported",
};
const QQ_CAPABILITIES: ChannelCapabilities = { ...FEISHU_CAPABILITIES };
const WECHAT_CAPABILITIES: ChannelCapabilities = {
  direct_message: "supported",
  group_mention: "supported",
  group_proactive: "limited",
  attachments: "limited",
  edit: "unsupported",
};

/** 真实微信本地桥未接线时的占位（适配器保持 disabled，不产生收发） */
class UnavailableLocalBridge implements LocalBridge {
  readonly #error: string;

  constructor(error: string) {
    this.#error = error;
  }

  connect(): never {
    throw new Error(this.#error);
  }

  async disconnect(): Promise<void> {}

  status(): LocalBridgeStatus {
    return { process: "error", login: "unknown", window: "unavailable", last_error: this.#error };
  }

  sendMessage(_input: LocalBridgeSendInput): LocalBridgeSendResult {
    throw new LocalBridgeError("explicit", this.#error, { code: "bridge_unavailable", retryable: false });
  }

  onMessage(_handler: (message: LocalBridgeInboundMessage) => void): () => void {
    return () => {};
  }
}

async function readSecret(secretStore: SecretStore, service: string, account: string): Promise<string | null> {
  try {
    const value = await secretStore.getSecret(service, account);
    return value === null || value.trim().length === 0 ? null : value;
  } catch {
    // 凭据库不可读（权限/后端故障）按「未配置」处理：渠道不出现，但 Runtime 继续
    return null;
  }
}

function accountFor(
  channelId: AutoChannelId,
  nativeAccountId: string,
  displayName: string,
  ownerNativeIds: string[] | undefined,
): ChannelAdapterRegistration["account"] {
  return {
    account_id: `${channelId}-default`,
    channel_id: channelId,
    native_account_id: nativeAccountId,
    display_name: displayName,
    ...(ownerNativeIds === undefined || ownerNativeIds.length === 0
      ? {}
      : { owner_native_ids: [...ownerNativeIds] }),
  };
}

/**
 * 遍历 SecretStore 中已配置凭据的渠道，构造注册项。未配置的渠道不返回；
 * 配置残缺返回 error 占位（registry.start 会把 state 置 error，health 可诊断）。
 */
export async function buildConfiguredChannels(
  options: ChannelBootstrapOptions,
): Promise<ChannelAdapterRegistration[]> {
  const registrations: ChannelAdapterRegistration[] = [];
  const ownerNativeIds = options.ownerNativeIds ?? {};

  const feishuAppId = await readSecret(options.secretStore, FEISHU_SECRET_SERVICE, "app_id");
  if (feishuAppId !== null) {
    let adapter: ChannelAdapter;
    try {
      const config = await loadFeishuConfig(options.secretStore);
      adapter = new FeishuChannelAdapter({
        accountId: "feishu-default",
        ...options.feishu,
        config,
      });
    } catch (err) {
      adapter = new UnavailableChannelAdapter(
        "feishu",
        `feishu channel configuration is incomplete: ${errorMessage(err)}`,
      );
    }
    registrations.push({
      adapter,
      account: accountFor("feishu", feishuAppId, "Morrow Feishu", ownerNativeIds.feishu),
      experimental: false,
    });
  } else {
    registrations.push({
      adapter: new PendingChannelAdapter("feishu", FEISHU_CAPABILITIES),
      account: accountFor("feishu", "feishu-unconfigured", "Morrow Feishu", ownerNativeIds.feishu),
      experimental: false,
    });
  }

  const qqAppId = await readSecret(options.secretStore, QQ_SECRET_SERVICE, "app_id");
  if (qqAppId !== null) {
    let adapter: ChannelAdapter;
    try {
      const config = await loadQqConfig(options.secretStore);
      adapter = new QqChannelAdapter({
        accountId: "qq-default",
        ...options.qq,
        config,
      });
    } catch (err) {
      adapter = new UnavailableChannelAdapter(
        "qq",
        `qq channel configuration is incomplete: ${errorMessage(err)}`,
      );
    }
    registrations.push({
      adapter,
      account: accountFor("qq", qqAppId, "Morrow QQ", ownerNativeIds.qq),
      experimental: false,
    });
  } else {
    registrations.push({
      adapter: new PendingChannelAdapter("qq", QQ_CAPABILITIES),
      account: accountFor("qq", "qq-unconfigured", "Morrow QQ", ownerNativeIds.qq),
      experimental: false,
    });
  }

  const wechatBridgeCommand = await readSecret(options.secretStore, WECHAT_SECRET_SERVICE, WECHAT_SECRET_FIELDS[0]);
  const wechatBridgeEndpoint = await readSecret(options.secretStore, WECHAT_SECRET_SERVICE, WECHAT_SECRET_FIELDS[1]);
  if (wechatBridgeCommand !== null || wechatBridgeEndpoint !== null) {
    const bridge =
      options.wechat?.bridge ??
      new UnavailableLocalBridge(
        "wechat local bridge is not implemented in this build; inject a LocalBridge implementation to enable real WeChat automation",
      );
    const environment: ChannelEnvironment = WECHAT_ENVIRONMENT;
    const adapter = new WeChatChannelAdapter({
      accountId: "wechat-default",
      bridge,
      enabled: false,
      environment,
      riskNotice: WECHAT_RISK_NOTICE,
    });
    registrations.push({
      adapter,
      account: accountFor(
        "wechat",
        wechatBridgeEndpoint ?? "wechat-default",
        "Morrow WeChat",
        ownerNativeIds.wechat,
      ),
      experimental: true,
    });
  } else {
    registrations.push({
      adapter: new PendingChannelAdapter("wechat", WECHAT_CAPABILITIES, { experimental: true }),
      account: accountFor("wechat", "wechat-unconfigured", "Morrow WeChat", ownerNativeIds.wechat),
      experimental: true,
    });
  }

  return registrations;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
