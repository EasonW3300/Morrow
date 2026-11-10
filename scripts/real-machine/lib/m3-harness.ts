/**
 * M3 真机门禁脚本共享夹具（票 M3-T7 / Issue #36）。
 *
 * 两个**独立 Runtime 实例**（各自 dataDir / replica_id / SQLite 账本 + 各自 HTTP 端口），
 * 全部走真实 HTTP 接缝：
 *   - 配对：A `POST /v1/pairing/codes` → B `POST /v1/pairing/join`（宿主侧新端点）；
 *   - 同步：两端注入 HttpSyncTransport（真实 fetch + /v1/sync/{pull,push,status}），
 *     `POST /v1/sync/run` 做 pull→push→push→pull 双向收敛；
 *   - 设备私钥只在进程内存（createInMemorySecretStore），不碰 OS 凭据库。
 *
 * 说明（如实边界）：#34 修复批起 startRuntime 已按 devices 表默认接线出站同步传输
 * （main.ts 无需额外注入），本夹具仍显式注入 HttpSyncTransport 以固定两端地址表、独立于
 * 配对流程做 AC 复跑。真实跨网络（Tailscale + bearer token）待 Owner 环境，见
 * docs/gates/m3-gate-report.md §6。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, SyncRunReport } from "@morrow/protocol";
import type { RuntimeConfig } from "../../../apps/runtime/src/config.ts";
import { createInMemorySecretStore, type SecretStore } from "../../../apps/runtime/src/keyring.ts";
import { startRuntime, type RuntimeHandle, type RuntimeOptions } from "../../../apps/runtime/src/runtime.ts";
import { HttpSyncTransport } from "../../../apps/runtime/src/sync/http-transport.ts";

export const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
export const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

export interface Instance {
  name: "A" | "B";
  replicaId: string;
  runtime: RuntimeHandle;
  dir: string;
  base: string;
  secrets: SecretStore;
}

export interface Pair {
  a: Instance;
  b: Instance;
  pairing: PairingEvidence | null;
}

export interface PairingEvidence {
  code_expires_at: string;
  server_fingerprint: string;
  server_fingerprint_short: string;
  joiner_device_replica_id: string;
  join_response_has_token: boolean;
  devices_a: DeviceSummary[];
  devices_b: DeviceSummary[];
}

export interface DeviceSummary {
  replica_id: string;
  label: string | null;
  trusted: boolean;
  revoked: boolean;
  fingerprint: string | null;
  last_sync_at: string | null;
}

export interface StartPairOptions {
  /** 各自 runtime 选项（同步传输由夹具统一注入，调用方无需给） */
  optionsFor?: (name: "A" | "B") => Partial<RuntimeOptions>;
  /** 保留临时 dataDir（排查用） */
  keep?: boolean;
}

function config(dir: string, replicaId: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId, provider: null };
}

export function urlFor(instance: Instance, path: string): string {
  return `http://127.0.0.1:${instance.runtime.port}${path}`;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  raw: string;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body: unknown = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`non-JSON response from ${url}: ${raw.slice(0, 200)}`);
    }
  }
  return { status: response.status, body: body as T, raw };
}

export async function getJson<T>(instance: Instance, path: string): Promise<ApiResponse<T>> {
  return requestJson<T>(urlFor(instance, path));
}

export async function postJson<T>(instance: Instance, path: string, body?: unknown): Promise<ApiResponse<T>> {
  return requestJson<T>(urlFor(instance, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function assertStatus<T>(response: ApiResponse<T>, expected: number, label: string): T {
  if (response.status !== expected) {
    throw new Error(`${label}: HTTP ${response.status} (expected ${expected}) ${response.raw.slice(0, 300)}`);
  }
  return response.body;
}

/** 起两个独立实例并互相注入真实 HTTP 同步传输；返回时端口已就绪 */
export async function startPair(options: StartPairOptions = {}): Promise<Pair> {
  const dirA = mkdtempSync(join(tmpdir(), "morrow-m3-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "morrow-m3-b-"));
  const bases = new Map<string, string>();
  const secretsA = createInMemorySecretStore();
  const secretsB = createInMemorySecretStore();
  const transportFor = (self: string): HttpSyncTransport =>
    new HttpSyncTransport({
      selfReplicaId: self,
      baseUrlForPeer: (peerId) => bases.get(peerId) ?? "http://127.0.0.1:1",
    });
  let a: RuntimeHandle | undefined;
  let b: RuntimeHandle | undefined;
  try {
    a = await startRuntime(config(dirA, REPLICA_A), {
      ...options.optionsFor?.("A"),
      secretStore: secretsA,
      syncTransport: transportFor(REPLICA_A),
    });
    b = await startRuntime(config(dirB, REPLICA_B), {
      ...options.optionsFor?.("B"),
      secretStore: secretsB,
      syncTransport: transportFor(REPLICA_B),
    });
    bases.set(REPLICA_A, `http://127.0.0.1:${a.port}`);
    bases.set(REPLICA_B, `http://127.0.0.1:${b.port}`);
    const instanceA: Instance = { name: "A", replicaId: REPLICA_A, runtime: a, dir: dirA, base: `http://127.0.0.1:${a.port}`, secrets: secretsA };
    const instanceB: Instance = { name: "B", replicaId: REPLICA_B, runtime: b, dir: dirB, base: `http://127.0.0.1:${b.port}`, secrets: secretsB };
    return { a: instanceA, b: instanceB, pairing: null };
  } catch (err) {
    await b?.close().catch(() => undefined);
    await a?.close().catch(() => undefined);
    if (options.keep === true) {
      console.error(`[m3-harness] kept data dirs: ${dirA} ${dirB}`);
    } else {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
    throw err;
  }
}

/** B 作为新设备加入 A（走 POST /v1/pairing/join；响应不得含 token 明文） */
export async function pairViaJoin(pair: Pair): Promise<PairingEvidence> {
  const codeBody = assertStatus(
    await postJson<{
      code: string;
      expires_at: string;
      server: { replica_id: string; public_key: string; fingerprint: string; fingerprint_short: string };
    }>(pair.a, "/v1/pairing/codes", {}),
    201,
    "POST /v1/pairing/codes",
  );
  const joinResponse = await postJson<{
    device: { replica_id: string; trusted: boolean; revoked: boolean };
    server_fingerprint: string;
    server_fingerprint_short: string;
    token?: string;
  }>(pair.b, "/v1/pairing/join", {
    base_url: pair.a.base,
    code: codeBody.code,
    device_label: "m3-joiner",
    expect_server_fingerprint: codeBody.server.fingerprint,
  });
  const join = assertStatus(joinResponse, 200, "POST /v1/pairing/join");
  if (join.device.replica_id !== REPLICA_A) {
    throw new Error(`join response device replica ${join.device.replica_id} != ${REPLICA_A}`);
  }
  pair.pairing = {
    code_expires_at: codeBody.expires_at,
    server_fingerprint: join.server_fingerprint,
    server_fingerprint_short: join.server_fingerprint_short,
    joiner_device_replica_id: join.device.replica_id,
    join_response_has_token: joinResponse.raw.includes("mrw_") || join.token !== undefined,
    devices_a: await listDevices(pair.a),
    devices_b: await listDevices(pair.b),
  };
  return pair.pairing;
}

export async function listDevices(instance: Instance): Promise<DeviceSummary[]> {
  const body = assertStatus(
    await getJson<{ devices: DeviceSummary[] }>(instance, "/v1/devices"),
    200,
    "GET /v1/devices",
  );
  return body.devices;
}

/** 创建会话（一条 session.created 业务事件；AC-04 的“小事件”） */
export async function createSession(instance: Instance, title: string): Promise<{ session_id: string; event_id: string; sequence: number }> {
  return assertStatus(
    await postJson<{ session_id: string; event_id: string; sequence: number }>(instance, "/v1/sessions", { title }),
    201,
    "POST /v1/sessions",
  );
}

export async function runSync(instance: Instance, peerReplicaId?: string): Promise<SyncRunReport> {
  return assertStatus(
    await postJson<SyncRunReport>(instance, "/v1/sync/run", peerReplicaId === undefined ? {} : { peer_replica_id: peerReplicaId }),
    200,
    "POST /v1/sync/run",
  );
}

export interface SyncStatusPeerView {
  peer_replica_id: string;
  last_pulled_sequence: number;
  last_acked_sequence: number;
  last_synced_at: string | null;
  pending_upload: number;
  pending_download: number | null;
  unreachable: boolean;
  remote_max_sequence: number | null;
}

export interface SyncStatusView {
  replica_id: string;
  sequence: { min: number | null; max: number | null; count: number };
  last_sync_at: string | null;
  cursors: Array<{ peer_replica_id: string; last_pulled_sequence: number; last_acked_sequence: number }>;
  peers: SyncStatusPeerView[];
}

export async function syncStatus(instance: Instance): Promise<SyncStatusView> {
  return assertStatus(await getJson<SyncStatusView>(instance, "/v1/sync/status"), 200, "GET /v1/sync/status");
}

/** 双向同步若干轮（A、B 各 run 一次算一轮），返回每轮报告 */
export async function syncRounds(pair: Pair, rounds: number): Promise<Array<{ round: number; a: SyncRunReport; b: SyncRunReport }>> {
  const out: Array<{ round: number; a: SyncRunReport; b: SyncRunReport }> = [];
  for (let round = 1; round <= rounds; round++) {
    const a = await runSync(pair.a);
    const b = await runSync(pair.b);
    out.push({ round, a, b });
  }
  return out;
}

interface EventPage {
  events: EventEnvelope[];
  total: number;
  limit: number;
  offset: number;
}

/** 分页读取完整账本（测试规模小，一次运行几十到几百条） */
export async function fetchAllEvents(instance: Instance): Promise<EventEnvelope[]> {
  const all: EventEnvelope[] = [];
  let offset = 0;
  for (let guard = 0; guard < 200; guard++) {
    const page = assertStatus(
      await getJson<EventPage>(instance, `/v1/events?limit=200&offset=${offset}`),
      200,
      "GET /v1/events",
    );
    all.push(...page.events);
    offset += page.events.length;
    if (offset >= page.total || page.events.length === 0) return all;
  }
  throw new Error("event pagination did not terminate");
}

export function countByType(events: EventEnvelope[], eventType: string): number {
  return events.filter((event) => event.event_type === eventType).length;
}

export async function closePair(pair: Pair, keep = false): Promise<void> {
  await pair.b.runtime.close().catch(() => undefined);
  await pair.a.runtime.close().catch(() => undefined);
  if (keep) {
    console.error(`[m3-harness] kept data dirs: ${pair.a.dir} ${pair.b.dir}`);
    return;
  }
  rmSync(pair.a.dir, { recursive: true, force: true });
  rmSync(pair.b.dir, { recursive: true, force: true });
}

/** 百分位（最近秩法；样本已升序或内部排序） */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile: empty samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nodeEnv(): Record<string, string> {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cwd: process.cwd(),
  };
}

export function parseOutArg(argv: string[]): string | null {
  const index = argv.indexOf("--out");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--out requires a directory path");
  return value;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}
