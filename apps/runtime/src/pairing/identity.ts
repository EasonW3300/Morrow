import type { DeviceIdentityInfo } from "@morrow/protocol";
import type { DeviceRegistry } from "../devices.ts";
import type { SecretStore } from "../keyring.ts";
import {
  DEVICE_KEY_SERVICE,
  derivePublicKey,
  deviceKeyAccount,
  formatFingerprint,
  generateDeviceKeyPair,
} from "./crypto.ts";

/**
 * 本机设备身份（M3-T2 / Issue #31）。
 *
 * 惰性供给：纯本地部署（回环豁免，ADR-0008）永远不需要设备密钥，因此不在 startRuntime
 * 时触碰 OS 凭据库——首次 `POST /v1/pairing/codes` 或 `POST /v1/pairing/claim` 时才
 * 生成/读取。这样既保证「纯本地零配置可用」，也避免启动阶段弹出钥匙串授权框。
 *
 * 私钥只存在于 SecretStore（service `com.morrow.device` + account replica_id）；
 * 本类内存缓存仅在进程生命周期内持有，不写任何文件/日志。公钥/指纹落 devices 表。
 * 若凭据库有私钥但 devices 表丢公钥（库被替换等），由私钥重新派生公钥并自愈落库。
 */

export interface DeviceIdentityOptions {
  replicaId: string;
  secretStore: SecretStore;
  devices: DeviceRegistry;
  now?: () => Date;
}

export class DeviceIdentity {
  readonly #replicaId: string;
  readonly #secrets: SecretStore;
  readonly #devices: DeviceRegistry;
  readonly #now: () => Date;
  #cached: DeviceIdentityInfo | null = null;

  constructor(options: DeviceIdentityOptions) {
    this.#replicaId = options.replicaId;
    this.#secrets = options.secretStore;
    this.#devices = options.devices;
    this.#now = options.now ?? (() => new Date());
  }

  get replicaId(): string {
    return this.#replicaId;
  }

  /** 生成或读取本机密钥，返回公开身份（幂等；进程内缓存） */
  async ensure(): Promise<DeviceIdentityInfo> {
    if (this.#cached !== null) return this.#cached;
    const account = deviceKeyAccount(this.#replicaId);
    let privateKeyPem = await this.#secrets.getSecret(DEVICE_KEY_SERVICE, account);
    if (privateKeyPem === null) {
      const pair = generateDeviceKeyPair();
      await this.#secrets.setSecret(DEVICE_KEY_SERVICE, account, pair.privateKeyPem);
      privateKeyPem = pair.privateKeyPem;
    }
    const { publicKey, fingerprint } = derivePublicKey(privateKeyPem);
    this.#devices.setIdentity(this.#replicaId, publicKey, fingerprint, this.#now());
    this.#cached = {
      replica_id: this.#replicaId,
      public_key: publicKey,
      fingerprint,
      fingerprint_short: formatFingerprint(fingerprint),
    };
    return this.#cached;
  }

  /**
   * 已有的公开身份（不触碰凭据库）：本机配对过则返回，否则 null。
   * GET /v1/devices 走 devices 表，不用本方法；预留给 UI 展示。
   */
  peek(): DeviceIdentityInfo | null {
    return this.#cached;
  }
}
