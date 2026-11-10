import type { SyncEnvelope } from "@morrow/protocol";
import type { DeviceRegistry } from "../devices.ts";
import { DEVICE_KEY_SERVICE, deviceTokenAccount } from "../pairing/crypto.ts";
import type { SecretStore } from "../keyring.ts";
import { SyncError } from "./errors.ts";
import { HttpSyncTransport } from "./http-transport.ts";
import type { SyncPeerProbe, SyncPushReceipt, SyncTransport, SyncTransportPullResult } from "./transport.ts";

/**
 * 设备表驱动的出站同步传输（M3 同步接线修复 / Issue #34）。
 *
 * 这是 Runtime 启动时注入 SyncEngine 的默认传输：peer 的 base_url 从 devices 表读，
 * bearer token 从 SecretStore 读 `token:<peer replica_id>`（配对 join 写入）。
 *
 * 生命周期选择：**读路径惰性重建 + 设备变更时主动失效**。
 * - 每次调用按 devices 表解析 peer（不存在 / 未信任 / 已撤销 → 明确 SyncError）；
 * - base_url 或 token 变化时丢弃缓存的 HttpSyncTransport 重建（配对 join / 撤销经
 *   PairingService.onDeviceChanged 调 invalidate，读路径也会自校验，二者不冲突）；
 * - 不注册设备表监听：设备变更都发生在本进程的配对/撤销路径上，事件回调已足够，
 *   惰性解析同时覆盖外部直接改库/重启后的状态。
 *
 * 无 token 不注入 Authorization（回环豁免）；非回环对端 401 时错误 details 带
 * `auth: "none"` + `reason: "missing_token"`，SyncEngine 的 status 把它写进
 * `unreachable_reason`。
 */
export interface DeviceSyncTransportOptions {
  selfReplicaId: string;
  devices: DeviceRegistry;
  secretStore: SecretStore;
  /** 出站 fetch（测试注入；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
}

interface CachedPeerTransport {
  baseUrl: string;
  transport: HttpSyncTransport;
}

export class DeviceSyncTransport implements SyncTransport {
  readonly #selfReplicaId: string;
  readonly #devices: DeviceRegistry;
  readonly #secrets: SecretStore;
  readonly #fetch: typeof fetch;
  readonly #cache = new Map<string, CachedPeerTransport>();

  constructor(options: DeviceSyncTransportOptions) {
    this.#selfReplicaId = options.selfReplicaId;
    this.#devices = options.devices;
    this.#secrets = options.secretStore;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async push(peerId: string, envelopes: SyncEnvelope[]): Promise<SyncPushReceipt> {
    return (await this.#transportFor(peerId)).push(peerId, envelopes);
  }

  async pull(peerId: string, sinceSeq: number, limit: number): Promise<SyncTransportPullResult> {
    return (await this.#transportFor(peerId)).pull(peerId, sinceSeq, limit);
  }

  async status(peerId: string): Promise<SyncPeerProbe> {
    return (await this.#transportFor(peerId)).status(peerId);
  }

  /**
   * 丢掉某 peer 的缓存（配对加入 / 撤销 / 凭据轮换）。下次调用重新读设备表与凭据库。
   * 缺省清空全部（测试/运维用）。
   */
  invalidate(peerId?: string): void {
    if (peerId === undefined) this.#cache.clear();
    else this.#cache.delete(peerId);
  }

  async #transportFor(peerId: string): Promise<HttpSyncTransport> {
    const device = this.#devices.get(peerId);
    if (device === null) {
      this.#cache.delete(peerId);
      throw new SyncError("sync_transport_unavailable", `peer ${peerId} is not a known device`, {
        peer_replica_id: peerId,
        reason: "unknown_peer",
      });
    }
    if (device.revoked) {
      this.#cache.delete(peerId);
      throw new SyncError("sync_transport_unavailable", `peer ${peerId} has been revoked; sync is disabled`, {
        peer_replica_id: peerId,
        reason: "device_revoked",
      });
    }
    if (!device.trusted) {
      this.#cache.delete(peerId);
      throw new SyncError("sync_transport_unavailable", `peer ${peerId} is not trusted`, {
        peer_replica_id: peerId,
        reason: "device_untrusted",
      });
    }
    const baseUrl = this.#devices.baseUrl(peerId);
    if (baseUrl === null || baseUrl.length === 0) {
      this.#cache.delete(peerId);
      throw new SyncError(
        "sync_transport_unavailable",
        `peer ${peerId} has no base_url (pairing did not report the device address)`,
        { peer_replica_id: peerId, reason: "no_base_url" },
      );
    }

    // 设备表/地址未变时直接复用：凭据只在首次解析或 invalidate 后读取一次，避免每次
    // 同步请求都起一次 OS 凭据库子进程。设备变更（配对/撤销/轮换）经 onDeviceChanged
    // 调 invalidate，读路径也会校验设备行状态。
    const cached = this.#cache.get(peerId);
    if (cached !== undefined && cached.baseUrl === baseUrl) return cached.transport;

    let token: string | null;
    try {
      token = await this.#secrets.getSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(peerId));
    } catch (err) {
      this.#cache.delete(peerId);
      throw new SyncError(
        "sync_transport_unavailable",
        `cannot read the device token for peer ${peerId}: ${(err as Error).message}`,
        { peer_replica_id: peerId, reason: "token_store_error" },
      );
    }
    const normalizedToken = token === null || token.length === 0 ? null : token;

    const transport = new HttpSyncTransport({
      selfReplicaId: this.#selfReplicaId,
      baseUrlForPeer: () => baseUrl,
      tokenForPeer: () => normalizedToken,
      fetchImpl: this.#fetch,
    });
    this.#cache.set(peerId, { baseUrl, transport });
    return transport;
  }
}
