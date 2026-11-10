import { randomUUID } from "node:crypto";
import type {
  PairingClaimResponse,
  PairingCodeResponse,
  DeviceIdentityInfo,
  DeviceInfo,
  PairingJoinResponse,
} from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { DeviceRecord, DeviceRegistry } from "../devices.ts";
import type { EventLedger } from "../ledger.ts";
import type { SecretStore } from "../keyring.ts";
import { UUID_RE } from "../uuid-v7.ts";
import type { DeviceIdentity } from "./identity.ts";
import { PairingStore } from "./store.ts";
import {
  DEVICE_KEY_SERVICE,
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
  | "secret_store_unavailable"
  | "peer_unreachable"
  | "invalid_claim_response"
  | "cannot_join_self"
  | "invalid_base_url";

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
  /** 本机 OS 凭据库（join 拿到的对端 bearer token 只写这里，绝不落库/日志/响应） */
  secretStore: SecretStore;
  /** 可注入时钟（测试配对码过期）；默认系统时间 */
  now?: () => Date;
  /** 配对码 TTL（默认 5 分钟） */
  codeTtlMs?: number;
  /** 每个来源地址在窗口内的失败上限（默认 10 次 / 5 分钟） */
  claimAttemptLimit?: number;
  claimAttemptWindowMs?: number;
  /** 出站 fetch（join 调对端 claim/revoke；测试可用真 HTTP 回环或注入桩） */
  fetchImpl?: typeof fetch;
  /** join 出站请求超时（毫秒，默认 15s） */
  joinTimeoutMs?: number;
  /**
   * 本机对外可达的 HTTP 基地址（M3 同步接线修复 / Issue #34）：join 时随 claim 以
   * `device_base_url` 告知对端，使对端也能反向出站同步。运行端口在 listen 后才确定，
   * 因此传函数而非值；未知返回 null（对端该方向以 no_base_url 明确不可达）。
   */
  selfBaseUrl?: () => string | null;
  /**
   * 设备表变更回调（配对成功 / join / 撤销）：runtime 用它让同步传输注册表立即失效
   * 该 peer 的缓存，避免继续使用旧 base_url/token（读路径本身也会按设备表惰性重建）。
   */
  onDeviceChanged?: (replicaId: string) => void;
}

export interface ClaimInput {
  code: string;
  devicePublicKey: string;
  deviceLabel?: string | undefined;
  deviceReplicaId?: string | undefined;
  /** 新设备自身的 HTTP 基地址（join 的调用方提供；浏览器 claim 可缺省） */
  deviceBaseUrl?: string | undefined;
  expectedServerFingerprint?: string | undefined;
  /** 来源标识（HTTP 层传 socket 远端地址）；缺省不做限速 */
  remoteKey?: string | undefined;
}

export interface ClaimResult extends PairingClaimResponse {
  token_account: string;
}

export interface JoinInput {
  baseUrl: string;
  code: string;
  deviceLabel?: string | undefined;
  expectedServerFingerprint?: string | undefined;
}

export interface JoinResult extends PairingJoinResponse {}

const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ATTEMPT_LIMIT = 10;
const DEFAULT_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_JOIN_TIMEOUT_MS = 15_000;
const MAX_LABEL_LENGTH = 128;

export class PairingService {
  readonly #store: PairingStore;
  readonly #devices: DeviceRegistry;
  readonly #identity: DeviceIdentity;
  readonly #ledger: EventLedger;
  readonly #secrets: SecretStore;
  readonly #replicaId: string;
  readonly #now: () => Date;
  readonly #codeTtlMs: number;
  readonly #attemptLimit: number;
  readonly #attemptWindowMs: number;
  readonly #fetch: typeof fetch;
  readonly #joinTimeoutMs: number;
  readonly #selfBaseUrl: (() => string | null) | undefined;
  readonly #onDeviceChanged: ((replicaId: string) => void) | undefined;
  #attempts = new Map<string, { count: number; windowStart: number }>();
  #closed = false;

  constructor(options: PairingServiceOptions) {
    this.#store = PairingStore.open(options.dataDir);
    this.#devices = options.devices;
    this.#identity = options.identity;
    this.#ledger = options.ledger;
    this.#secrets = options.secretStore;
    this.#replicaId = options.replicaId;
    this.#now = options.now ?? (() => new Date());
    this.#codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.#attemptLimit = options.claimAttemptLimit ?? DEFAULT_ATTEMPT_LIMIT;
    this.#attemptWindowMs = options.claimAttemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#joinTimeoutMs = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
    this.#selfBaseUrl = options.selfBaseUrl;
    this.#onDeviceChanged = options.onDeviceChanged;
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

    // 新设备自报的基地址（可选）：仅当是本 Runtime 宿主发起 join 时提供。非法值在
    // **消耗配对码之前**拒绝（与指纹校验同一原则：不把可修正的错误变成烧码）。
    const deviceBaseUrl = input.deviceBaseUrl === undefined ? null : normalizeBaseUrl(input.deviceBaseUrl);

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
      baseUrl: deviceBaseUrl,
      now,
    });
    this.#onDeviceChanged?.(deviceReplicaId);

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
   * 宿主侧「加入设备」（M3 修复批 / Issue #35，PRD §5.2 流程 1）：本机 Runtime 作为
   * 新设备向 `baseUrl` 指向的已信任 Runtime 发起 claim。
   *
   * 与浏览器路径的本质差异：token 由宿主进程拿回并写入本机 OS 凭据库
   * （account = `token:<对端 replica_id>`），对端公钥写本机 devices 表；响应绝不回传
   * token 明文。指纹校验在**本机**完成（不把期望值委托给对端）：
   *   - `expect_server_fingerprint` 与对端自证指纹不一致 → 立即撤销对端刚建立的本机
   *     信任（DELETE /v1/devices/:id，带本次 token），本地凭据/设备行均不落地；
   *   - 对端公钥与自证指纹不自洽（公钥派生指纹 ≠ server.fingerprint）同样按
   *     invalid_claim_response 中止并撤销。
   */
  async join(input: JoinInput): Promise<JoinResult> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!/^\d{6}$/.test(input.code)) {
      throw new PairingError("invalid_code", 400, "pairing code must be exactly 6 digits");
    }
    const label = normalizeLabel(input.deviceLabel);
    const self = await this.#ensureIdentity();
    // 自报基地址（M3 同步接线修复）：对端据此把本机记为可出站同步的 peer。
    const selfBaseUrl = this.#selfBaseUrl?.() ?? null;
    const claim = await this.#claimRemote(baseUrl, {
      code: input.code,
      device_public_key: self.public_key,
      device_replica_id: this.#replicaId,
      ...(selfBaseUrl === null ? {} : { device_base_url: selfBaseUrl }),
      ...(label === null ? {} : { device_label: label }),
    });

    // 对端必须把我们登记成提交的身份（replica_id + 公钥），否则视为响应被篡改。
    const claimedDevice = claim.device;
    if (
      typeof claimedDevice !== "object" ||
      claimedDevice === null ||
      claimedDevice.replica_id !== this.#replicaId ||
      claimedDevice.public_key !== self.public_key
    ) {
      await this.#rollbackJoin(baseUrl, claim);
      throw new PairingError("invalid_claim_response", 502, "peer registered a different device identity than requested");
    }

    // 对端身份自洽性：公钥派生指纹必须等于其自报指纹（否则无法作为信任锚）。
    let derivedFingerprint: string;
    try {
      derivedFingerprint = parseDevicePublicKey(claim.server.public_key).fingerprint;
    } catch {
      await this.#rollbackJoin(baseUrl, claim);
      throw new PairingError("invalid_claim_response", 502, "peer returned an unparsable server public key");
    }
    if (derivedFingerprint !== normalizeFingerprint(claim.server.fingerprint)) {
      await this.#rollbackJoin(baseUrl, claim);
      throw new PairingError("invalid_claim_response", 502, "peer server fingerprint does not match its public key");
    }
    if (claim.server.replica_id === this.#replicaId) {
      // 加入自己：不能撤销自身（服务端 409 cannot_revoke_self），直接拒绝。
      throw new PairingError("cannot_join_self", 409, "a runtime cannot join itself");
    }

    // 双端指纹核对：期望值由 Owner 从对端屏幕抄来；不一致立即撤销，不落任何本地状态。
    if (input.expectedServerFingerprint !== undefined) {
      const expected = normalizeFingerprint(input.expectedServerFingerprint);
      if (expected !== normalizeFingerprint(claim.server.fingerprint)) {
        await this.#rollbackJoin(baseUrl, claim);
        throw new PairingError(
          "fingerprint_mismatch",
          409,
          `server fingerprint mismatch: expected ${formatFingerprint(expected)}, got ${formatFingerprint(claim.server.fingerprint)}`,
        );
      }
    }

    const existing = this.#devices.get(claim.server.replica_id);
    if (existing !== null && existing.revoked) {
      await this.#rollbackJoin(baseUrl, claim);
      throw new PairingError("device_revoked", 403, "the target runtime was revoked on this device; restore is not supported");
    }

    // 写本机凭据库：token 只进 OS 凭据库，绝不进 devices 表 / 账本 / 响应 / 日志。
    const tokenAccount = deviceTokenAccount(claim.server.replica_id);
    try {
      await this.#secrets.setSecret(DEVICE_KEY_SERVICE, tokenAccount, claim.token);
    } catch (err) {
      await this.#rollbackJoin(baseUrl, claim);
      throw new PairingError(
        "secret_store_unavailable",
        503,
        `cannot persist the peer token to the OS credential store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      this.#devices.markJoinedPeer({
        replicaId: claim.server.replica_id,
        label: null,
        publicKey: claim.server.public_key,
        fingerprint: normalizeFingerprint(claim.server.fingerprint),
        // 对端地址来自本次 join 的目标 base_url：入站 claim 场景没有这条信息。
        baseUrl,
        now: this.#now(),
      });
    } catch (err) {
      await this.#secrets.deleteSecret(DEVICE_KEY_SERVICE, tokenAccount).catch(() => undefined);
      await this.#rollbackJoin(baseUrl, claim);
      throw err;
    }
    this.#onDeviceChanged?.(claim.server.replica_id);

    const device = this.#devices.get(claim.server.replica_id);
    if (device === null) {
      // 理论不可达（刚写入）；按失败处理而不是伪造响应。
      await this.#secrets.deleteSecret(DEVICE_KEY_SERVICE, tokenAccount).catch(() => undefined);
      await this.#rollbackJoin(baseUrl, claim);
      throw new PairingError("invalid_claim_response", 502, "joined device projection is unavailable");
    }
    return {
      device: device as DeviceRecord,
      server_fingerprint: normalizeFingerprint(claim.server.fingerprint),
      server_fingerprint_short: formatFingerprint(normalizeFingerprint(claim.server.fingerprint)),
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
      // 同步传输注册表立即丢掉该 peer 的缓存与 transport（撤销后不再尝试）。
      this.#onDeviceChanged?.(deviceId);
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

  /** 向对端 POST /v1/pairing/claim 并校验响应形状；网络/协议错误映射为 PairingError */
  async #claimRemote(baseUrl: string, body: Record<string, unknown>): Promise<PairingClaimResponse> {
    const response = await this.#joinFetch(`${baseUrl}/v1/pairing/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error =
        typeof payload === "object" && payload !== null && "error" in payload
          ? ((payload as { error?: Record<string, unknown> }).error ?? {})
          : {};
      const code = typeof error.code === "string" ? error.code : "claim_failed";
      const message = typeof error.message === "string" ? error.message : `peer returned HTTP ${response.status}`;
      // 服务端的配对语义错误（invalid_code/code_expired/...）原样透传；未知一律 502。
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new PairingError(
        isPairingErrorCode(code) ? code : "peer_unreachable",
        status,
        message,
      );
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new PairingError("invalid_claim_response", 502, "peer returned a non-object claim response");
    }
    const claim = payload as Partial<PairingClaimResponse>;
    const server = claim.server;
    if (
      typeof claim.token !== "string" ||
      claim.token.length === 0 ||
      typeof server !== "object" ||
      server === null ||
      typeof server.replica_id !== "string" ||
      !UUID_RE.test(server.replica_id) ||
      typeof server.public_key !== "string" ||
      typeof server.fingerprint !== "string"
    ) {
      throw new PairingError("invalid_claim_response", 502, "peer claim response is malformed");
    }
    return claim as PairingClaimResponse;
  }

  /**
   * join 失败回滚：撤销对端刚为本次 claim 建立的本机设备行（带本次 token）。本地状态
   * 在指纹校验通过前不写入，因此无需清理；若调用方已写入 token，应另行删除（见 join）。
   * 回滚失败不掩盖原始错误——仍抛原始 PairingError，遗留信任可由设备列表人工撤销。
   */
  async #rollbackJoin(baseUrl: string, claim: PairingClaimResponse): Promise<void> {
    try {
      await this.#joinFetch(`${baseUrl}/v1/devices/${encodeURIComponent(this.#replicaId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${claim.token}` },
      });
    } catch {
      // 对端不可达/撤销失败：本地未落任何状态；原始错误继续上抛。
    }
  }

  async #joinFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.#joinTimeoutMs),
      });
    } catch (err) {
      throw new PairingError(
        "peer_unreachable",
        502,
        `cannot reach the target runtime: ${err instanceof Error ? err.message : String(err)}`,
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

/** join 的 base_url 归一化：只接受 http/https，去掉末尾斜杠（query/hash 一律拒绝） */
function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PairingError("invalid_base_url", 400, "base_url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PairingError("invalid_base_url", 400, "base_url must use http or https");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new PairingError("invalid_base_url", 400, "base_url must not contain a query string or fragment");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

const PAIRING_ERROR_CODES: ReadonlySet<string> = new Set<PairingErrorCode>([
  "issuer_not_trusted",
  "invalid_code",
  "code_expired",
  "code_already_used",
  "fingerprint_mismatch",
  "invalid_device_public_key",
  "invalid_device_label",
  "invalid_device_replica_id",
  "device_key_conflict",
  "device_revoked",
  "cannot_revoke_self",
  "too_many_attempts",
  "secret_store_unavailable",
  "peer_unreachable",
  "invalid_claim_response",
  "cannot_join_self",
  "invalid_base_url",
]);

function isPairingErrorCode(code: string): code is PairingErrorCode {
  return PAIRING_ERROR_CODES.has(code);
}
