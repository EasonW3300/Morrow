import type { SyncEnvelope, SyncPullBatch, SyncPushRequest } from "@morrow/protocol";
import { SyncError } from "./errors.ts";
import type { SyncPushReceipt, SyncTransport, SyncTransportPullResult } from "./transport.ts";

/**
 * HTTP 传输实现（M3-T1 / Issue #30）：与内存实现共用 SyncTransport 契约，
 * 打到对端的 /v1/sync/{push,pull}（PRD §6.2）。
 *
 * base URL 按 peerId 解析（部署形态：服务器对端或局域网/私有网络地址，ADR-0004）；
 * fetch 可注入（测试零真实网络）。
 */
export interface HttpSyncTransportOptions {
  /** 本副本 replica_id（push 请求体的 peer_replica_id = 发送方） */
  selfReplicaId: string;
  /** peer replica_id → 对端 HTTP 基地址（不含末尾斜杠亦可） */
  baseUrlForPeer: (peerId: string) => string;
  fetchImpl?: typeof fetch;
}

export class HttpSyncTransport implements SyncTransport {
  readonly #selfReplicaId: string;
  readonly #baseUrlForPeer: (peerId: string) => string;
  readonly #fetch: typeof fetch;

  constructor(options: HttpSyncTransportOptions) {
    this.#selfReplicaId = options.selfReplicaId;
    this.#baseUrlForPeer = options.baseUrlForPeer;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async push(peerId: string, envelopes: SyncEnvelope[]): Promise<SyncPushReceipt> {
    const body: SyncPushRequest = { peer_replica_id: this.#selfReplicaId, envelopes };
    const response = await this.#request(peerId, "/v1/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await this.#payload(response, peerId);
    return {
      accepted: typeof payload.accepted === "number" ? payload.accepted : 0,
      duplicates: typeof payload.duplicates === "number" ? payload.duplicates : 0,
    };
  }

  async pull(peerId: string, sinceSeq: number, limit: number): Promise<SyncTransportPullResult> {
    const query = `?since=${encodeURIComponent(String(sinceSeq))}&limit=${encodeURIComponent(String(limit))}`;
    const response = await this.#request(peerId, `/v1/sync/pull${query}`, { method: "GET" });
    const payload = (await this.#payload(response, peerId)) as Partial<SyncPullBatch>;
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

  async #request(peerId: string, path: string, init: RequestInit): Promise<Response> {
    const base = this.#baseUrlForPeer(peerId).replace(/\/+$/, "");
    try {
      return await this.#fetch(`${base}${path}`, init);
    } catch (err) {
      throw new SyncError("sync_transport_unavailable", `peer ${peerId} is unreachable: ${(err as Error).message}`, {
        peer_replica_id: peerId,
      });
    }
  }

  async #payload(response: Response, peerId: string): Promise<Record<string, unknown>> {
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
      throw new SyncError(
        typeof error.code === "string" ? (error.code as SyncError["code"]) : "sync_transport_unavailable",
        typeof error.message === "string" ? error.message : `peer ${peerId} returned HTTP ${response.status}`,
        { peer_replica_id: peerId, status: response.status, ...error },
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
