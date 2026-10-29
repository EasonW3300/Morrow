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
  return { host, port, dataDir, replicaId };
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
