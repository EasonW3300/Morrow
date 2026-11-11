import type { SyncEnvelope, SyncPullBatch, SyncPushRequest, SyncStatus } from "@morrow/protocol";
import { SyncError } from "./errors.ts";
import type { SyncPeerProbe, SyncPushReceipt, SyncTransport, SyncTransportPullResult } from "./transport.ts";

/**
 * HTTP 传输实现（M3-T1 / Issue #30）：与内存实现共用 SyncTransport 契约，
 * 打到对端的 /v1/sync/{push,pull}（PRD §6.2）。
 *
 * base URL 按 peerId 解析（部署形态：服务器对端或局域网/私有网络地址，ADR-0004）；
 * fetch 可注入（测试零真实网络）。
 *
 * 鉴权（M3 同步接线修复 / Issue #34，ADR-0008）：所有请求携带
 * `Authorization: Bearer <device token>`（tokenForPeer 解析，缺省不注入）。无 token 是
 * 合法的回环豁免场景；一旦对端以 401/403 拒绝，错误 details 会带 `auth: "none"` 与
 * HTTP 状态，便于把「缺 token」和「网络不通」区分开。
 */
export interface HttpSyncTransportOptions {
  /** 本副本 replica_id（push 请求体的 peer_replica_id = 发送方） */
  selfReplicaId: string;
  /** peer replica_id → 对端 HTTP 基地址（不含末尾斜杠亦可） */
  baseUrlForPeer: (peerId: string) => string;
  /**
   * peer replica_id → bearer token（OS 凭据库读取，可异步）。返回 null/空串 = 不携带
   * Authorization 头（回环豁免）；解析本身失败按传输不可用上抛。
   */
  tokenForPeer?: (peerId: string) => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
}

interface ResolvedRequestAuth {
  token: string | null;
}

export class HttpSyncTransport implements SyncTransport {
  readonly #selfReplicaId: string;
  readonly #baseUrlForPeer: (peerId: string) => string;
  readonly #tokenForPeer: ((peerId: string) => string | null | Promise<string | null>) | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: HttpSyncTransportOptions) {
    this.#selfReplicaId = options.selfReplicaId;
    this.#baseUrlForPeer = options.baseUrlForPeer;
    this.#tokenForPeer = options.tokenForPeer;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async push(peerId: string, envelopes: SyncEnvelope[]): Promise<SyncPushReceipt> {
    const body: SyncPushRequest = { peer_replica_id: this.#selfReplicaId, envelopes };
    const { response, auth } = await this.#request(peerId, "/v1/sync/push", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const payload = await this.#payload(response, peerId, auth);
    return {
      accepted: typeof payload.accepted === "number" ? payload.accepted : 0,
      duplicates: typeof payload.duplicates === "number" ? payload.duplicates : 0,
    };
  }

  async pull(peerId: string, sinceSeq: number, limit: number): Promise<SyncTransportPullResult> {
    const query = `?since=${encodeURIComponent(String(sinceSeq))}&limit=${encodeURIComponent(String(limit))}`;
    const { response, auth } = await this.#request(peerId, `/v1/sync/pull${query}`, { method: "GET" });
    const payload = (await this.#payload(response, peerId, auth)) as Partial<SyncPullBatch>;
    if (!Array.isArray(payload.envelopes) || typeof payload.next_seq !== "number") {
      throw new SyncError("sync_invalid_batch", `peer ${peerId} returned a malformed pull response`, {
        peer_replica_id: peerId,
      });
    }
    return {
      envelopes: payload.envelopes,
      nextSeq: payload.next_seq,
      hasMore: payload.has_more === true,
    };
  }

  /**
   * 探测对端账本上界（M3 修复批 / Issue #35）：`?probe=local` 让对端只回本地 sequence，
   * 不再向它的 peer 探测——否则 A 查 B、B 又查 A 会互相递归。
   */
  async status(peerId: string): Promise<SyncPeerProbe> {
    const { response, auth } = await this.#request(peerId, "/v1/sync/status?probe=local", { method: "GET" });
    const payload = (await this.#payload(response, peerId, auth)) as Partial<SyncStatus>;
    const max = payload.sequence?.max;
    return {
      replica_id: typeof payload.replica_id === "string" ? payload.replica_id : null,
      max_sequence: typeof max === "number" ? max : null,
    };
  }

  async #request(
    peerId: string,
    path: string,
    init: { method: string; body?: string },
  ): Promise<{ response: Response; auth: ResolvedRequestAuth }> {
    const base = this.#baseUrlForPeer(peerId).replace(/\/+$/, "");
    const auth = await this.#resolveAuth(peerId);
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (auth.token !== null) headers.authorization = `Bearer ${auth.token}`;
    try {
      const response = await this.#fetch(`${base}${path}`, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      return { response, auth };
    } catch (err) {
      throw new SyncError("sync_transport_unavailable", `peer ${peerId} is unreachable: ${(err as Error).message}`, {
        peer_replica_id: peerId,
        base_url: base,
        auth: auth.token === null ? "none" : "bearer",
        ...(auth.token === null ? { reason: "transport_error_without_token" } : {}),
      });
    }
  }

  async #resolveAuth(peerId: string): Promise<ResolvedRequestAuth> {
    if (this.#tokenForPeer === undefined) return { token: null };
    let token: string | null;
    try {
      token = await this.#tokenForPeer(peerId);
    } catch (err) {
      throw new SyncError(
        "sync_transport_unavailable",
        `cannot read the device token for peer ${peerId}: ${(err as Error).message}`,
        { peer_replica_id: peerId, auth: "unavailable", reason: "token_store_error" },
      );
    }
    return { token: token === null || token.length === 0 ? null : token };
  }

  async #payload(
    response: Response,
    peerId: string,
    auth: ResolvedRequestAuth,
  ): Promise<Record<string, unknown>> {
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
      // 无 token 的回环豁免请求被非回环对端拒绝时，把「缺凭据」写进 details，避免与
      // 网络错误混为一谈（status 的 unreachable_reason 直接消费本条 message）。
      const authHint =
        auth.token === null && (response.status === 401 || response.status === 403)
          ? { reason: "missing_token" }
          : {};
      throw new SyncError(
        typeof error.code === "string" ? (error.code as SyncError["code"]) : "sync_transport_unavailable",
        typeof error.message === "string" ? error.message : `peer ${peerId} returned HTTP ${response.status}`,
        {
          peer_replica_id: peerId,
          status: response.status,
          auth: auth.token === null ? "none" : "bearer",
          ...authHint,
          ...error,
        },
      );
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new SyncError("sync_invalid_batch", `peer ${peerId} returned a non-object payload`, {
        peer_replica_id: peerId,
      });
    }
    return payload as Record<string, unknown>;
  }
}
