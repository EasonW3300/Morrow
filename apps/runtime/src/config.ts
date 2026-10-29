import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Runtime 配置（PRD §6.1 本地 HTTP 形态）：
 * - host/port：本地服务默认绑 127.0.0.1，端口默认 0（随机空闲，sidecar 场景无冲突；
 *   实际端口经 stdout ready 行告知父进程）；
 * - dataDir：账本等落盘数据目录，默认 ~/.morrow/data（根 .gitignore 的 data/ 规则覆盖）；
 * - replicaId：本副本 uuid，事件信封必填。未显式配置时按 dataDir 持久化
 *   （<dataDir>/replica-id 文件），重启后副本身份稳定——同步协议按 replica 去重依赖它。
 */

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  replicaId: string;
  /**
   * OpenAI 兼容 Provider 三元组（T4 最小实现：只读环境变量；Provider CRUD 与
   * 凭据库是 T5 的事）。null 表示未配置——会话可建，发消息返回 503。
   */
  provider: ProviderConfig | null;
}

/** OpenAI Chat Completions 兼容端点配置（GLOSSARY: Provider） */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function defaultDataDir(): string {
  return join(homedir(), ".morrow", "data");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const host = env.MORROW_HOST ?? "127.0.0.1";
  const portRaw = env.MORROW_PORT ?? "0";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid MORROW_PORT: "${portRaw}" (integer 0-65535 expected)`);
  }
  const dataDir = env.MORROW_DATA_DIR ?? defaultDataDir();
  const replicaId = env.MORROW_REPLICA_ID ?? resolveReplicaId(dataDir);
  if (!UUID_RE.test(replicaId)) {
    throw new Error(`invalid MORROW_REPLICA_ID: "${replicaId}" (lowercase uuid expected)`);
  }
  return { host, port, dataDir, replicaId, provider: parseProviderConfig(env) };
}

/**
 * Provider 环境变量解析（T4 最小实现）：三个变量都缺省 → null（未配置 Provider）。
 * 任一出现则 BASE_URL 与 MODEL 必填；API_KEY 可空串（vLLM/Ollama 等本地端点常免密）。
 */
export function parseProviderConfig(env: Record<string, string | undefined>): ProviderConfig | null {
  const baseUrl = env.MORROW_PROVIDER_BASE_URL;
  const modelId = env.MORROW_PROVIDER_MODEL;
  if (baseUrl === undefined && modelId === undefined && env.MORROW_PROVIDER_API_KEY === undefined) {
    return null;
  }
  if (!baseUrl || !modelId) {
    throw new Error(
      "provider config requires MORROW_PROVIDER_BASE_URL and MORROW_PROVIDER_MODEL (MORROW_PROVIDER_API_KEY optional)",
    );
  }
  const contextWindow = parsePositiveInt(env.MORROW_PROVIDER_CONTEXT_WINDOW ?? "131072", "MORROW_PROVIDER_CONTEXT_WINDOW");
  const maxTokens = parsePositiveInt(env.MORROW_PROVIDER_MAX_TOKENS ?? "8192", "MORROW_PROVIDER_MAX_TOKENS");
  return { baseUrl, apiKey: env.MORROW_PROVIDER_API_KEY ?? "", modelId, contextWindow, maxTokens };
}

function parsePositiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: "${raw}" (positive integer expected)`);
  }
  return value;
}

/** 从 dataDir 读取或创建副本身份文件；显式传入且合法时直接采用 */
export function resolveReplicaId(dataDir: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!UUID_RE.test(explicit)) {
      throw new Error(`invalid replica id: "${explicit}" (lowercase uuid expected)`);
    }
    return explicit;
  }
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "replica-id");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (UUID_RE.test(existing)) return existing;
  }
  const fresh = randomUUID();
  writeFileSync(file, `${fresh}\n`);
  return fresh;
}
