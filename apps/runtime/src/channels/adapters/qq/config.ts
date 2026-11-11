import type { SecretStore } from "../../../keyring.ts";

/**
 * QQ 官方 Bot 配置（M4-T4 / Issue #41）。
 *
 * 凭据只进 SecretStore（ADR-0002 的密钥边界；OS 凭据库），服务名固定
 * `channel:qq`，account = 字段名——即票面约定的 `channel:qq:<field>`：
 *
 *   channel:qq:app_id          机器人 AppID（开放平台「机器人 ID」）
 *   channel:qq:app_secret      机器人 AppSecret（换取 access token 的 clientSecret）
 *   channel:qq:bot_secret      可选：Webhook 回调 Ed25519 签名校验用的 BotSecret
 *   channel:qq:token_endpoint  可选：access token 端点覆盖（非机密，便于内网/联调）
 *
 * 注意：QQ 官方已废弃旧的 `Bot Token` 鉴权，统一走 AppID/AppSecret 换 access token
 * （`POST /app/getAppAccessToken`）。Access Token 本身**不落 SecretStore**，只在进程内
 * 缓存并按 expires_in 提前刷新（票面：token 缓存/刷新）。
 *
 * 非机密项（API base、请求超时、事件传输）由适配器选项注入；默认指向官方地址，
 * 测试只改 base_url 即可对接 ChannelTestServer。
 */

export const QQ_SECRET_SERVICE = "channel:qq";

export const QQ_SECRET_FIELDS = ["app_id", "app_secret", "bot_secret", "token_endpoint"] as const;

export type QqSecretField = (typeof QQ_SECRET_FIELDS)[number];

export interface QqConfig {
  appId: string;
  appSecret: string;
  /** Webhook 回调签名密钥；配置后事件帧必须带有效 Ed25519 签名 */
  botSecret?: string;
  /** access token 端点（可选覆盖；默认 https://bots.qq.com/app/getAppAccessToken） */
  tokenEndpoint?: string;
}

export class QqConfigError extends Error {
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "QqConfigError";
    this.missing = missing;
  }
}

/** SecretStore account 名（`channel:qq:<field>` 的 `<field>` 部分） */
export function qqSecretAccount(field: QqSecretField): string {
  return field;
}

export interface LoadQqConfigOptions {
  /** 显式覆盖（优先级最高；测试/宿主可跳过 SecretStore） */
  overrides?: Partial<QqConfig>;
  /** 是否要求 bot_secret（webhook 模式；默认 false） */
  requireBotSecret?: boolean;
}

/**
 * 从 SecretStore 读取 QQ 配置。app_id/app_secret 必填；缺失时一次性列出所有缺失字段。
 */
export async function loadQqConfig(
  secretStore: SecretStore,
  options: LoadQqConfigOptions = {},
): Promise<QqConfig> {
  const overrides = options.overrides ?? {};
  const read = async (field: QqSecretField): Promise<string | null> => {
    const value = await secretStore.getSecret(QQ_SECRET_SERVICE, qqSecretAccount(field));
    return value === null || value.trim().length === 0 ? null : value;
  };

  const [storedAppId, storedAppSecret, storedBotSecret, storedTokenEndpoint] = await Promise.all([
    read("app_id"),
    read("app_secret"),
    read("bot_secret"),
    read("token_endpoint"),
  ]);

  const appId = overrides.appId ?? storedAppId;
  const appSecret = overrides.appSecret ?? storedAppSecret;
  const botSecret = overrides.botSecret ?? storedBotSecret ?? undefined;
  const tokenEndpoint = overrides.tokenEndpoint ?? storedTokenEndpoint ?? undefined;

  const missing: string[] = [];
  if (appId === null || appId === undefined || appId.length === 0) missing.push("app_id");
  if (appSecret === null || appSecret === undefined || appSecret.length === 0) missing.push("app_secret");
  if (options.requireBotSecret === true && (botSecret === undefined || botSecret.length === 0)) {
    missing.push("bot_secret");
  }
  if (missing.length > 0) {
    throw new QqConfigError(
      `qq channel is missing required secrets (${missing.join(", ")}) under service "${QQ_SECRET_SERVICE}"`,
      missing,
    );
  }

  return {
    appId: appId as string,
    appSecret: appSecret as string,
    ...(botSecret === undefined || botSecret.length === 0 ? {} : { botSecret }),
    ...(tokenEndpoint === undefined || tokenEndpoint.length === 0 ? {} : { tokenEndpoint }),
  };
}
