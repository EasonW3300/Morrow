import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UUID_RE } from "./uuid-v7.ts";

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
   * OpenAI 兼容 Provider 三元组（T5 起：MORROW_PROVIDER_* 解析结果作为 ProviderRegistry
   * 的 env 回退——显式 CRUD 注册的 Provider 优先，环境变量只在无注册 Provider 时充当
   * 默认；null 表示未配置——会话可建，发消息返回 503）。
   */
  provider: ProviderConfig | null;
  /**
   * 后台记忆抽取器选择（M1 code-review / Issue #14 补齐，FR-MEM-3）：
   * "heuristic"（默认，确定性启发式，零网络）| "llm"（经 PiAdapter 一次 prompt 的
   * LlmMemoryExtractor——需默认 Provider 可解析，工厂不可用/坏输出返回空候选不抛）。
   * 缺省 = heuristic（loadConfig 由 MORROW_MEMORY_EXTRACTOR 解析，缺省同样 heuristic；
   * 库形态/测试可经 RuntimeOptions.memoryExtractor 注入任意实现，优先于本配置）。
   */
  memoryExtractor?: "heuristic" | "llm";
  /**
   * 本机对外可达的 HTTP 基地址（M3 同步接线修复 / Issue #34，MORROW_PUBLIC_BASE_URL）：
   * join 时随 claim 告知对端，使对端能反向出站同步。缺省按 host:port 推导（通配监听
   * 地址退化为 127.0.0.1，仅本机可用）——跨网络部署必须显式配置 Tailscale/LAN 地址。
   */
  publicBaseUrl?: string | null;
}

/** OpenAI Chat Completions 兼容端点配置（GLOSSARY: Provider） */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}


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
  return {
    host,
    port,
    dataDir,
    replicaId,
    provider: parseProviderConfig(env),
    memoryExtractor: parseMemoryExtractor(env),
    publicBaseUrl: parsePublicBaseUrl(env),
  };
}

/**
 * MORROW_PUBLIC_BASE_URL：显式对外地址（http/https，无 query/hash）；缺省 null =
 * 按实际监听 host:port 推导。非法值启动即失败（错误的地址会让配对写入不可达 peer）。
 */
function parsePublicBaseUrl(env: Record<string, string | undefined>): string | null {
  const raw = env.MORROW_PUBLIC_BASE_URL;
  if (raw === undefined || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`invalid MORROW_PUBLIC_BASE_URL: "${raw}" (absolute http(s) URL expected)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid MORROW_PUBLIC_BASE_URL: "${raw}" (http or https expected)`);
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`invalid MORROW_PUBLIC_BASE_URL: "${raw}" (must not contain query or fragment)`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * 记忆抽取器选择（MORROW_MEMORY_EXTRACTOR，默认 heuristic）：显式选择 llm 但 Provider
 * 未配置时不在此拒绝（启动可用性不因可选后台管线锁死）——抽取时工厂解析失败按坏输出
 * 处理返回空候选。未知取值抛错（宁可启动失败，不静默回退改变行为口径）。
 */
function parseMemoryExtractor(env: Record<string, string | undefined>): "heuristic" | "llm" {
  const raw = env.MORROW_MEMORY_EXTRACTOR;
  if (raw === undefined || raw === "") return "heuristic";
  if (raw === "heuristic" || raw === "llm") return raw;
  throw new Error(`invalid MORROW_MEMORY_EXTRACTOR: "${raw}" ("heuristic" or "llm" expected)`);
}

/** 设备密钥后端（MORROW_SECRET_BACKEND）：auto = 平台凭据库；memory = 仅进程内存。 */
export type SecretBackend = "auto" | "memory";

/**
 * 密钥后端选择（默认 auto = macOS Keychain / Windows 凭据管理器 / Linux secret-tool）。
 *
 * `memory` 只为部署冒烟/CI 提供封闭环境：设备私钥不落盘、不进 OS 凭据库，进程退出即
 * 丢失（副本身份不变，但设备公钥指纹每次启动都会变）。生产部署不要使用。
 */
export function parseSecretBackend(env: Record<string, string | undefined> = process.env): SecretBackend {
  const raw = env.MORROW_SECRET_BACKEND;
  if (raw === undefined || raw === "" || raw === "auto") return "auto";
  if (raw === "memory") return "memory";
  throw new Error(`invalid MORROW_SECRET_BACKEND: "${raw}" ("auto" or "memory" expected)`);
}

/**
 * Provider 环境变量解析（T5 起作为 env 回退种子，票面约定：显式 CRUD > 环境变量）：
 * 三个变量都缺省 → null（未配置 Provider）。任一出现则 BASE_URL 与 MODEL 必填；
 * API_KEY 可空串（vLLM/Ollama 等本地端点常免密）。
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
