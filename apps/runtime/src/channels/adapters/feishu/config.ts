import type { SecretStore } from "../../../keyring.ts";

/**
 * 飞书自建应用配置（M4-T3 / Issue #40）。
 *
 * 凭据只进 SecretStore（ADR-0002 的密钥边界；OS 凭据库），服务名固定
 * `channel:feishu`，account = 字段名——即票面约定的 `channel:feishu:<field>`：
 *
 *   channel:feishu:app_id               自建应用 App ID
 *   channel:feishu:app_secret           自建应用 App Secret
 *   channel:feishu:verification_token   事件订阅 Verification Token
 *   channel:feishu:encrypt_key          事件加密 Encrypt Key（签名与 AES 解密共用）
 *   channel:feishu:bot_open_id          可选：Bot 的 open_id（群 @ 判定）
 *
 * Base URL / 请求超时等非机密项由适配器选项注入（测试改 base_url 即可对接
 * ChannelTestServer）；真实联调也只需改配置，不改代码。
 */

export const FEISHU_SECRET_SERVICE = "channel:feishu";

export const FEISHU_SECRET_FIELDS = [
  "app_id",
  "app_secret",
  "verification_token",
  "encrypt_key",
  "bot_open_id",
] as const;

export type FeishuSecretField = (typeof FEISHU_SECRET_FIELDS)[number];

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  /** Bot 的 open_id；配置后群聊 @ 判定按它精确匹配 */
  botOpenId?: string;
}

export class FeishuConfigError extends Error {
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "FeishuConfigError";
    this.missing = missing;
  }
}

/** SecretStore account 名（`channel:feishu:<field>` 的 `<field>` 部分） */
export function feishuSecretAccount(field: FeishuSecretField): string {
  return field;
}

export interface LoadFeishuConfigOptions {
  /** 显式覆盖（优先级最高；测试/宿主可跳过 SecretStore） */
  overrides?: Partial<FeishuConfig>;
  /** 是否要求 bot_open_id（默认 false；未配置时群 @ 一律视为未提及，保守不响应） */
  requireBotOpenId?: boolean;
}

/**
 * 从 SecretStore 读取飞书配置。app_id/app_secret/verification_token/encrypt_key 必填；
 * 缺失时一次性列出所有缺失字段（不逐次失败，方便 Owner 配置）。
 */
export async function loadFeishuConfig(
  secretStore: SecretStore,
  options: LoadFeishuConfigOptions = {},
): Promise<FeishuConfig> {
  const overrides = options.overrides ?? {};
  const read = async (field: FeishuSecretField): Promise<string | null> => {
    const value = await secretStore.getSecret(FEISHU_SECRET_SERVICE, feishuSecretAccount(field));
    return value === null || value.trim().length === 0 ? null : value;
  };

  const [storedAppId, storedAppSecret, storedVerification, storedEncrypt, storedBotOpenId] = await Promise.all([
    read("app_id"),
    read("app_secret"),
    read("verification_token"),
    read("encrypt_key"),
    read("bot_open_id"),
  ]);

  const appId = overrides.appId ?? storedAppId;
  const appSecret = overrides.appSecret ?? storedAppSecret;
  const verificationToken = overrides.verificationToken ?? storedVerification;
  const encryptKey = overrides.encryptKey ?? storedEncrypt;
  const botOpenId = overrides.botOpenId ?? storedBotOpenId ?? undefined;

  const missing: string[] = [];
  if (appId === null || appId === undefined || appId.length === 0) missing.push("app_id");
  if (appSecret === null || appSecret === undefined || appSecret.length === 0) missing.push("app_secret");
  if (verificationToken === null || verificationToken === undefined || verificationToken.length === 0) {
    missing.push("verification_token");
  }
  if (encryptKey === null || encryptKey === undefined || encryptKey.length === 0) missing.push("encrypt_key");
  if (options.requireBotOpenId === true && (botOpenId === undefined || botOpenId.length === 0)) {
    missing.push("bot_open_id");
  }
  if (missing.length > 0) {
    throw new FeishuConfigError(
      `feishu channel is missing required secrets (${missing.join(", ")}) under service "${FEISHU_SECRET_SERVICE}"`,
      missing,
    );
  }

  return {
    appId: appId as string,
    appSecret: appSecret as string,
    verificationToken: verificationToken as string,
    encryptKey: encryptKey as string,
    ...(botOpenId === undefined || botOpenId.length === 0 ? {} : { botOpenId }),
  };
}
