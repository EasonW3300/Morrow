import { randomUUID } from "node:crypto";
import type { PairingClaimResponse, PairingCodeResponse, DeviceIdentityInfo, DeviceInfo } from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { DeviceRecord, DeviceRegistry } from "../devices.ts";
import type { EventLedger } from "../ledger.ts";
import { UUID_RE } from "../uuid-v7.ts";
import type { DeviceIdentity } from "./identity.ts";
import { PairingStore } from "./store.ts";
import {
  deviceTokenAccount,
  formatFingerprint,
  generateBearerToken,
  generatePairingCode,
  hashPairingCode,
  hashToken,
  normalizeFingerprint,
  parseDevicePublicKey,
} from "./crypto.ts";

/**
 * 设备配对服务（M3-T2 / Issue #31，FR-DEP-2）。
 *
 * 流程（PRD §5.2）：
 *   1. 已信任设备 POST /v1/pairing/codes → 6 位数字码（5 分钟 TTL、单次）+ 本机指纹；
 *   2. 新设备 POST /v1/pairing/claim（code + 公钥 + 标签 [+ replica_id / 期望指纹]）；
 *   3. 服务端校验码 → 落信任（devices.trusted=1）+ 下发一次性 bearer token（ADR-0008）；
 *   4. claim 响应携带双方指纹，客户端与本地显示值比对，不一致则不得信任。
 *
 * 审计：`device.paired` / `device.revoked` 两个事件经账本落盘（append-only）；payload
 * 只含 replica_id / label / 公钥指纹等公开信息，绝不含私钥或 token 明文。
 *
 * 6 位码的离线熵有限：本服务在 claim 侧做按来源地址的失败限速（默认 10 次 / 5 分钟），
 * 叠加 5 分钟 TTL + 单次消费 + 私有网络（ADR-0004）做为纵深。
 */

export const DEVICE_EVENT_TYPES = {
  paired: "device.paired",
  revoked: "device.revoked",
} as const;

export type PairingErrorCode =
  | "issuer_not_trusted"
  | "invalid_code"
  | "code_expired"
  | "code_already_used"
  | "fingerprint_mismatch"
  | "invalid_device_public_key"
  | "invalid_device_label"
  | "invalid_device_replica_id"
  | "device_key_conflict"
  | "device_revoked"
  | "cannot_revoke_self"
  | "too_many_attempts"
  | "secret_store_unavailable";

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  readonly httpStatus: number;

  constructor(code: PairingErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = "PairingError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface PairingServiceOptions {
  dataDir: string;
  replicaId: string;
  devices: DeviceRegistry;
  identity: DeviceIdentity;
  ledger: EventLedger;
  /** 可注入时钟（测试配对码过期）；默认系统时间 */
  now?: () => Date;
  /** 配对码 TTL（默认 5 分钟） */
  codeTtlMs?: number;
  /** 每个来源地址在窗口内的失败上限（默认 10 次 / 5 分钟） */
  claimAttemptLimit?: number;
  claimAttemptWindowMs?: number;
}

export interface ClaimInput {
  code: string;
  devicePublicKey: string;
  deviceLabel?: string | undefined;
  deviceReplicaId?: string | undefined;
  expectedServerFingerprint?: string | undefined;
  /** 来源标识（HTTP 层传 socket 远端地址）；缺省不做限速 */
  remoteKey?: string | undefined;
}

export interface ClaimResult extends PairingClaimResponse {
  token_account: string;
}

const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ATTEMPT_LIMIT = 10;
const DEFAULT_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_LABEL_LENGTH = 128;

export class PairingService {
  readonly #store: PairingStore;
  readonly #devices: DeviceRegistry;
  readonly #identity: DeviceIdentity;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #now: () => Date;
  readonly #codeTtlMs: number;
  readonly #attemptLimit: number;
  readonly #attemptWindowMs: number;
  #attempts = new Map<string, { count: number; windowStart: number }>();
  #closed = false;

  constructor(options: PairingServiceOptions) {
    this.#store = PairingStore.open(options.dataDir);
    this.#devices = options.devices;
    this.#identity = options.identity;
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#now = options.now ?? (() => new Date());
    this.#codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.#attemptLimit = options.claimAttemptLimit ?? DEFAULT_ATTEMPT_LIMIT;
    this.#attemptWindowMs = options.claimAttemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS;
  }

  /** 已信任设备生成一次性配对码（调用方须先通过鉴权；本方法再校验 issuer 信任态） */
  async createCode(issuerReplicaId: string): Promise<PairingCodeResponse> {
    const issuer = this.#devices.get(issuerReplicaId);
    if (issuer === null || !issuer.trusted || issuer.revoked) {
      throw new PairingError("issuer_not_trusted", 403, "only a trusted, non-revoked device can create pairing codes");
    }
    const server = await this.#ensureIdentity();
    const now = this.#now();
    const code = generatePairingCode();
    const expiresAt = new Date(now.getTime() + this.#codeTtlMs).toISOString();
    this.#store.insert({
      codeHash: hashPairingCode(code),
      issuerReplicaId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return { code, expires_at: expiresAt, server };
  }

  /** 新设备凭码加入信任网络；成功后返回双方指纹与一次性 token */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    const remoteKey = input.remoteKey ?? "unknown";
    this.#assertAttemptAllowed(remoteKey);
    try {
      return await this.#claim(input);
    } catch (err) {
      if (err instanceof PairingError) this.#recordFailure(remoteKey);
      throw err;
    }
  }

  async #claim(input: ClaimInput): Promise<ClaimResult> {
    const now = this.#now();
    if (!/^\d{6}$/.test(input.code)) {
      throw new PairingError("invalid_code", 400, "pairing code must be exactly 6 digits");
    }
    let parsedKey: { fingerprint: string };
    try {
      parsedKey = parseDevicePublicKey(input.devicePublicKey);
    } catch {
      throw new PairingError(
        "invalid_device_public_key",
        400,
        "device_public_key must be the base64 encoding of a raw 32-byte ed25519 public key",
      );
    }
    const label = normalizeLabel(input.deviceLabel);
    const deviceReplicaId = input.deviceReplicaId ?? randomUUID();
    if (!UUID_RE.test(deviceReplicaId)) {
      throw new PairingError("invalid_device_replica_id", 400, "device_replica_id must be a lowercase uuid");
    }

    // 服务端身份（也是 claim 响应里的“本机指纹”）；秘书库不可用时显式报错而非静默成功。
    const server = await this.#ensureIdentity();

    // 双端指纹核对的第一半：客户端若携带期望值，不一致立即失败且**不消耗配对码**，
    // 允许用户核对后重试（避免中间人拿一个错指纹把码烧掉）。
    if (input.expectedServerFingerprint !== undefined) {
      const expected = normalizeFingerprint(input.expectedServerFingerprint);
      if (expected !== server.fingerprint) {
        throw new PairingError(
          "fingerprint_mismatch",
          409,
          `server fingerprint mismatch: expected ${formatFingerprint(expected)}, got ${server.fingerprint_short}`,
        );
      }
    }

    // 已撤销设备即使持有旧码也不得复活（撤销是终态，重新配对须显式从设备列表恢复——
    // 本票未提供恢复端点，保持 fail-closed）。
    const existing = this.#devices.get(deviceReplicaId);
    if (existing !== null && existing.revoked) {
      throw new PairingError("device_revoked", 403, "device has been revoked and cannot be paired again");
    }
    if (existing !== null && existing.public_key !== null && existing.public_key !== input.devicePublicKey) {
      throw new PairingError(
        "device_key_conflict",
        409,
        "device_replica_id is already registered with a different public key",
      );
    }

    const consumed = this.#store.consume(hashPairingCode(input.code), now, deviceReplicaId);
    if (consumed.status === "used") {
      throw new PairingError("code_already_used", 409, "pairing code has already been used");
    }
    if (consumed.status === "expired") {
      throw new PairingError("code_expired", 410, "pairing code has expired");
    }
    if (consumed.status === "unknown") {
      throw new PairingError("invalid_code", 400, "pairing code is not valid");
    }

    const token = generateBearerToken();
    const nowIso = now.toISOString();
    this.#devices.markPaired({
      replicaId: deviceReplicaId,
      label,
      publicKey: input.devicePublicKey,
      fingerprint: parsedKey.fingerprint,
      tokenHash: hashToken(token),
      now,
    });

    const device: DeviceIdentityInfo & { label: string | null } = {
      replica_id: deviceReplicaId,
      public_key: input.devicePublicKey,
      fingerprint: parsedKey.fingerprint,
      fingerprint_short: formatFingerprint(parsedKey.fingerprint),
      label,
    };

    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType: DEVICE_EVENT_TYPES.paired,
        payload: {
          replica_id: deviceReplicaId,
          label,
          public_key: input.devicePublicKey,
          fingerprint: parsedKey.fingerprint,
          server_replica_id: server.replica_id,
          server_fingerprint: server.fingerprint,
          paired_at: nowIso,
        },
      }),
    );

    return {
      token,
      device,
      server,
      paired_at: nowIso,
      token_account: deviceTokenAccount(this.#replicaId),
    };
  }

  /**
   * 撤销设备：置 revoked + 保留 token 摘要作吊销墓碑；落 device.revoked 审计。
   * 本机自身不可撤销（否则回环之外所有管理入口失去意义）。
   * 返回更新后的投影；设备不存在返回 null（路由层 404）。
   */
  revoke(deviceId: string): { device: DeviceRecord; changed: boolean } | null {
    if (deviceId === this.#replicaId) {
      throw new PairingError("cannot_revoke_self", 409, "the local runtime device cannot revoke itself");
    }
    const before = this.#devices.get(deviceId);
    if (before === null) return null;
    const now = this.#now();
    const changed = this.#devices.revoke(deviceId, now);
    if (changed) {
      this.#ledger.append(
        buildEventEnvelope({
          replicaId: this.#replicaId,
          actorId: "agent:runtime",
          eventType: DEVICE_EVENT_TYPES.revoked,
          payload: {
            replica_id: deviceId,
            label: before.label,
            fingerprint: before.fingerprint,
            revoked_at: now.toISOString(),
          },
        }),
      );
    }
    const after = this.#devices.get(deviceId);
    return after === null ? null : { device: after, changed };
  }

  /**
   * bearer token 校验（ADR-0008）：只比对摘要；已撤销设备一律拒绝。
   * 返回设备投影；无效/撤销分别给出可区分状态（路由 401 vs 403）。
   */
  authenticate(token: string): { device: DeviceInfo } | { denied: "invalid_token" | "device_revoked" | "device_untrusted" } {
    if (token.length === 0) return { denied: "invalid_token" };
    const found = this.#devices.findByTokenHash(hashToken(token));
    if (found === null) return { denied: "invalid_token" };
    if (found.device.revoked) return { denied: "device_revoked" };
    if (!found.device.trusted) return { denied: "device_untrusted" };
    this.#devices.touchDevice(found.device.replica_id, this.#now());
    return { device: found.device };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  async #ensureIdentity(): Promise<DeviceIdentityInfo> {
    try {
      return await this.#identity.ensure();
    } catch (err) {
      throw new PairingError(
        "secret_store_unavailable",
        503,
        `device key is unavailable from the OS credential store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  #assertAttemptAllowed(remoteKey: string): void {
    const now = this.#now().getTime();
    const entry = this.#attempts.get(remoteKey);
    if (entry === undefined) return;
    if (now - entry.windowStart >= this.#attemptWindowMs) {
      this.#attempts.delete(remoteKey);
      return;
    }
    if (entry.count >= this.#attemptLimit) {
      throw new PairingError("too_many_attempts", 429, "too many failed pairing attempts; retry later");
    }
  }

  #recordFailure(remoteKey: string): void {
    const now = this.#now().getTime();
    const entry = this.#attempts.get(remoteKey);
    if (entry === undefined || now - entry.windowStart >= this.#attemptWindowMs) {
      this.#attempts.set(remoteKey, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
  }
}

function normalizeLabel(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new PairingError("invalid_device_label", 400, `device_label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  return trimmed;
}
