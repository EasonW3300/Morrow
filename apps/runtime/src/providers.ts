import type { AdapterCompatConfig } from "@morrow/pi-adapter";
import type { ProviderConfig } from "./config.ts";
import type { SecretStore } from "./keyring.ts";
import { uuidv7 } from "./uuid-v7.ts";

/**
 * Provider 注册表（票 T5 / Issue #6，ADR-0002：OpenAI 兼容三元组 base_url + api_key + 模型名）。
 *
 * 存储分离（AC：密钥只存在于 OS 凭据库）：
 * - 密钥 → SecretStore（OS 凭据库），account = provider_id，service = keyringService；
 * - 元数据（name/base_url/model/compat/窗口参数）→ <dataDir>/providers.json（本地配置存储，
 *   不入 SQLite 账本——票面明确；providers.json 落盘内容不含密钥）；
 * - env 回退（T4 兼容）：MORROW_PROVIDER_* 解析结果作为虚拟 Provider（id 固定 "env"），
 *   仅当显式默认缺失时充当默认；显式 CRUD > 环境变量。密钥来自环境变量、不入凭据库。
 *
 * 默认指针语义：首个注册的 Provider 自动成为默认；setDefault 显式切换；删除默认时
 * 落到剩余第一个（无剩余则 null，此时若有 env 回退仍可解析默认）。
 */

export const ENV_PROVIDER_ID = "env";
const DEFAULT_KEYRING_SERVICE = "com.morrow.runtime";
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 8192;

/** Provider 元数据（对外投影；绝无密钥字段，has_api_key/is_default 为投影值） */
export interface ProviderRecord {
  provider_id: string;
  name: string;
  base_url: string;
  model: string;
  compat: AdapterCompatConfig;
  context_window: number;
  max_tokens: number;
  created_at: string;
  has_api_key: boolean;
  is_default: boolean;
}

/** 会话运行时可用的完整 Provider 配置（密钥已解析；仅运行时内部使用，不得入日志/响应） */
export interface ResolvedProvider {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  compat?: AdapterCompatConfig;
}

/** SessionManager 依赖的最小 Provider 解析面（ProviderRegistry 实现之；测试可注入替身） */
export interface ProviderResolver {
  /** 是否存在可解析的默认 Provider（显式默认或 env 回退）——HTTP 层 503 预检 */
  hasDefault(): boolean;
  /** provider_id 是否可点名（显式注册或 env 回退）——建会话时校验显式绑定 */
  exists(providerId: string): boolean;
  /** 解析为运行时配置；未知 id 或未配置 → null */
  resolve(providerId?: string): Promise<ResolvedProvider | null>;
}

export class ProviderRegistryError extends Error {
  readonly code: "invalid_input" | "conflict" | "not_found";
  constructor(code: "invalid_input" | "conflict" | "not_found", message: string) {
    super(message);
    this.code = code;
  }
}

interface StoredProvider {
  provider_id: string;
  name: string;
  base_url: string;
  model: string;
  compat: AdapterCompatConfig;
  context_window: number;
  max_tokens: number;
  created_at: string;
}

interface ProvidersFile {
  version: 1;
  default_provider_id: string | null;
  providers: StoredProvider[];
}

export interface ProviderRegistryOptions {
  dataDir: string;
  secretStore: SecretStore;
  /** OS 凭据库 service 名（默认 com.morrow.runtime；测试用独立前缀避免污染用户钥匙串） */
  keyringService?: string;
  /** T4 环境变量解析结果（config.provider）作为 env 回退；null = 无回退 */
  envFallback?: ProviderConfig | null;
}

export class ProviderRegistry implements ProviderResolver {
  readonly #dataDir: string;
  readonly #file: string;
  readonly #secrets: SecretStore;
  readonly #service: string;
  readonly #envFallback: ProviderConfig | null;
  #fileState: ProvidersFile;

  constructor(options: ProviderRegistryOptions) {
    this.#dataDir = options.dataDir;
    this.#file = `${options.dataDir}/providers.json`;
    this.#secrets = options.secretStore;
    this.#service = options.keyringService ?? DEFAULT_KEYRING_SERVICE;
    this.#envFallback = options.envFallback ?? null;
    this.#fileState = this.#load();
  }

  // --- 查询 ------------------------------------------------------------------

  /** 显式注册列表（投影 has_api_key / is_default） + env 回退虚拟条目（若配置） */
  async listAll(): Promise<ProviderRecord[]> {
    const out: ProviderRecord[] = [];
    for (const stored of this.#fileState.providers) {
      out.push(await this.#project(stored));
    }
    if (this.#envFallback !== null) {
      const defaultId = await this.defaultProviderId();
      out.push({
        provider_id: ENV_PROVIDER_ID,
        name: "MORROW_PROVIDER_* (environment)",
        base_url: this.#envFallback.baseUrl,
        model: this.#envFallback.modelId,
        compat: {},
        context_window: this.#envFallback.contextWindow,
        max_tokens: this.#envFallback.maxTokens,
        created_at: "",
        has_api_key: this.#envFallback.apiKey !== "",
        is_default: defaultId === ENV_PROVIDER_ID,
      });
    }
    return out;
  }

  async get(providerId: string): Promise<ProviderRecord | null> {
    const stored = this.#storedOf(providerId);
    return stored === null ? null : this.#project(stored);
  }

  async defaultProviderId(): Promise<string | null> {
    const explicit = this.#fileState.default_provider_id;
    if (explicit !== null && this.#storedOf(explicit) !== null) return explicit;
    const first = this.#fileState.providers[0];
    if (first !== undefined) return first.provider_id;
    return this.#envFallback !== null ? ENV_PROVIDER_ID : null;
  }

  hasDefault(): boolean {
    const explicit = this.#fileState.default_provider_id;
    if (explicit !== null && this.#storedOf(explicit) !== null) return true;
    return this.#fileState.providers.length > 0 || this.#envFallback !== null;
  }

  exists(providerId: string): boolean {
    return providerId === ENV_PROVIDER_ID
      ? this.#envFallback !== null
      : this.#storedOf(providerId) !== null;
  }

  /** 解析密钥（凭据库查找）；仅注册过的 Provider 走凭据库，env 回退用环境变量值 */
  async resolveKey(providerId: string): Promise<string> {
    if (providerId === ENV_PROVIDER_ID) {
      return this.#envFallback?.apiKey ?? "";
    }
    const stored = this.#storedOf(providerId);
    if (stored === null) throw new ProviderRegistryError("not_found", `provider "${providerId}" not found`);
    return (await this.#secrets.getSecret(this.#service, providerId)) ?? "";
  }

  /** 解析为会话运行时配置；providerId 缺省用默认；未知/未配置 → null */
  async resolve(providerId?: string): Promise<ResolvedProvider | null> {
    const id = providerId ?? (await this.defaultProviderId());
    if (id === null) return null;
    if (id === ENV_PROVIDER_ID) {
      if (this.#envFallback === null) return null;
      return {
        providerId: ENV_PROVIDER_ID,
        baseUrl: this.#envFallback.baseUrl,
        apiKey: this.#envFallback.apiKey,
        modelId: this.#envFallback.modelId,
        contextWindow: this.#envFallback.contextWindow,
        maxTokens: this.#envFallback.maxTokens,
      };
    }
    const stored = this.#storedOf(id);
    if (stored === null) return null;
    return {
      providerId: stored.provider_id,
      baseUrl: stored.base_url,
      apiKey: (await this.#secrets.getSecret(this.#service, id)) ?? "",
      modelId: stored.model,
      contextWindow: stored.context_window,
      maxTokens: stored.max_tokens,
      ...(Object.keys(stored.compat).length > 0 ? { compat: stored.compat } : {}),
    };
  }

  // --- 变更 ------------------------------------------------------------------

  /**
   * 注册。密钥先写凭据库再落元数据（凭据库失败不残留半条元数据；元数据落盘失败
   * 回滚凭据库条目）。未显式指定默认时首个注册自动成为默认。
   */
  async register(input: {
    name?: unknown;
    base_url?: unknown;
    model?: unknown;
    api_key?: unknown;
    compat?: unknown;
    context_window?: unknown;
    max_tokens?: unknown;
    provider_id?: unknown;
  }): Promise<ProviderRecord> {
    const name = requireNonEmptyString(input.name, "name");
    const baseUrl = requireHttpUrl(input.base_url, "base_url");
    const model = requireNonEmptyString(input.model, "model");
    const providerId =
      input.provider_id === undefined
        ? uuidv7()
        : requireProviderId(input.provider_id);
    const contextWindow = requirePositiveInt(input.context_window ?? DEFAULT_CONTEXT_WINDOW, "context_window");
    const maxTokens = requirePositiveInt(input.max_tokens ?? DEFAULT_MAX_TOKENS, "max_tokens");
    const compat = requireCompat(input.compat);
    const apiKey = input.api_key === undefined || input.api_key === null ? "" : requireApiKey(input.api_key);

    if (this.#storedOf(providerId) !== null) {
      throw new ProviderRegistryError("conflict", `provider "${providerId}" already exists`);
    }

    const stored: StoredProvider = {
      provider_id: providerId,
      name,
      base_url: baseUrl,
      model,
      compat,
      context_window: contextWindow,
      max_tokens: maxTokens,
      created_at: new Date().toISOString(),
    };

    if (apiKey !== "") {
      await this.#secrets.setSecret(this.#service, providerId, apiKey);
    }
    try {
      this.#fileState.providers.push(stored);
      if (this.#fileState.default_provider_id === null) {
        this.#fileState.default_provider_id = providerId;
      }
      this.#save();
    } catch (err) {
      // 回滚：凭据库条目清掉、内存态复原
      this.#fileState.providers.pop();
      if (this.#fileState.default_provider_id === providerId) {
        this.#fileState.default_provider_id = null;
      }
      if (apiKey !== "") {
        await this.#secrets.deleteSecret(this.#service, providerId).catch(() => {});
      }
      throw err;
    }
    return this.#project(stored);
  }

  /** 更新（部分字段）；api_key 提供即轮换；provider_id 不可变 */
  async update(providerId: string, patch: {
    name?: unknown;
    base_url?: unknown;
    model?: unknown;
    api_key?: unknown;
    compat?: unknown;
    context_window?: unknown;
    max_tokens?: unknown;
  }): Promise<ProviderRecord> {
    const stored = this.#storedOf(providerId);
    if (stored === null) {
      throw new ProviderRegistryError("not_found", `provider "${providerId}" not found`);
    }
    if (patch.name !== undefined) stored.name = requireNonEmptyString(patch.name, "name");
    if (patch.base_url !== undefined) stored.base_url = requireHttpUrl(patch.base_url, "base_url");
    if (patch.model !== undefined) stored.model = requireNonEmptyString(patch.model, "model");
    if (patch.context_window !== undefined) stored.context_window = requirePositiveInt(patch.context_window, "context_window");
    if (patch.max_tokens !== undefined) stored.max_tokens = requirePositiveInt(patch.max_tokens, "max_tokens");
    if (patch.compat !== undefined) stored.compat = requireCompat(patch.compat);
    if (patch.api_key !== undefined && patch.api_key !== null) {
      await this.#secrets.setSecret(this.#service, providerId, requireApiKey(patch.api_key));
    }
    this.#save();
    return this.#project(stored);
  }

  async delete(providerId: string): Promise<void> {
    const index = this.#fileState.providers.findIndex((p) => p.provider_id === providerId);
    if (index < 0) {
      throw new ProviderRegistryError("not_found", `provider "${providerId}" not found`);
    }
    const [removed] = this.#fileState.providers.splice(index, 1);
    if (this.#fileState.default_provider_id === providerId) {
      this.#fileState.default_provider_id = null;
    }
    this.#save();
    if (removed !== undefined) {
      await this.#secrets.deleteSecret(this.#service, providerId).catch(() => {});
    }
  }

  async setDefault(providerId: string): Promise<void> {
    if (providerId !== ENV_PROVIDER_ID && this.#storedOf(providerId) === null) {
      throw new ProviderRegistryError("not_found", `provider "${providerId}" not found`);
    }
    if (providerId === ENV_PROVIDER_ID && this.#envFallback === null) {
      throw new ProviderRegistryError("not_found", `provider "${providerId}" not found`);
    }
    this.#fileState.default_provider_id = providerId;
    this.#save();
  }

  // --- 内部 ------------------------------------------------------------------

  #storedOf(providerId: string): StoredProvider | null {
    return this.#fileState.providers.find((p) => p.provider_id === providerId) ?? null;
  }

  async #project(stored: StoredProvider): Promise<ProviderRecord> {
    const hasKey = (await this.#secrets.getSecret(this.#service, stored.provider_id)) !== null;
    const explicitDefault = this.#fileState.default_provider_id;
    const isDefault =
      explicitDefault !== null
        ? explicitDefault === stored.provider_id
        : this.#fileState.providers[0]?.provider_id === stored.provider_id;
    return { ...stored, has_api_key: hasKey, is_default: isDefault };
  }

  #load(): ProvidersFile {
    let raw: string;
    try {
      raw = readTextFile(this.#file);
    } catch {
      return { version: 1, default_provider_id: null, providers: [] };
    }
    try {
      const parsed = JSON.parse(raw) as ProvidersFile;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.providers) ||
        (parsed.default_provider_id !== null && typeof parsed.default_provider_id !== "string")
      ) {
        throw new Error("unexpected shape");
      }
      return parsed;
    } catch (err) {
      throw new Error(`corrupted providers config at ${this.#file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 原子落盘：tmp 写入后 rename，避免半写文件（凭据库之外的第二道存储边界） */
  #save(): void {
    writeTextFileAtomic(this.#file, JSON.stringify(this.#fileState, null, 2));
  }
}

// --- 校验工具（错误信息面向 API 客户端，绝不回显密钥内容） ---------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderRegistryError("invalid_input", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireHttpUrl(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderRegistryError("invalid_input", `${field} must be a valid http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderRegistryError("invalid_input", `${field} must be a valid http(s) URL`);
  }
  // 去尾斜杠统一形态（chat/completions 由连接层拼接）
  return raw.replace(/\/+$/, "");
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ProviderRegistryError("invalid_input", `${field} must be a positive integer`);
  }
  return value;
}

function requireProviderId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_ID_RE.test(value)) {
    throw new ProviderRegistryError("invalid_input", `provider_id must match ${PROVIDER_ID_RE.source}`);
  }
  if (value === ENV_PROVIDER_ID) {
    throw new ProviderRegistryError("invalid_input", `provider_id "${ENV_PROVIDER_ID}" is reserved for the MORROW_PROVIDER_* environment fallback`);
  }
  return value;
}

function requireApiKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProviderRegistryError("invalid_input", "api_key must be a string");
  }
  return value;
}

const COMPAT_KEYS = ["supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming"] as const;

function requireCompat(value: unknown): AdapterCompatConfig {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderRegistryError("invalid_input", "compat must be an object");
  }
  const compat: AdapterCompatConfig = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!(COMPAT_KEYS as readonly string[]).includes(key)) {
      throw new ProviderRegistryError("invalid_input", `compat.${key} is not a known switch (${COMPAT_KEYS.join(", ")})`);
    }
    if (typeof val !== "boolean") {
      throw new ProviderRegistryError("invalid_input", `compat.${key} must be a boolean`);
    }
    compat[key as (typeof COMPAT_KEYS)[number]] = val;
  }
  return compat;
}

// --- 文件工具（node:fs 收敛在文件尾，避免类体中间穿插） ------------------------

import { readFileSync, renameSync, writeFileSync } from "node:fs";

function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

function writeTextFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
