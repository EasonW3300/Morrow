import type { SyncEnvelope } from "@morrow/protocol";
import type { SyncEngine } from "./engine.ts";
import { SyncError } from "./errors.ts";

/**
 * SyncTransport —— 同步引擎的内部接缝（M3-T1 / Issue #30，M3 规格「接缝」条目）。
 *
 * 引擎只通过本接口与 peer 交换事件；HTTP 实现与内存实现共用同一契约：
 *   push(peerId, envelopes) → { accepted, duplicates }
 *   pull(peerId, sinceSeq, limit) → { envelopes, nextSeq, hasMore }
 *
 * 内存实现服务双副本契约测试（两个 runtime 实例、独立 dataDir、零网络）；
 * HTTP 实现（http-transport.ts）在真实部署中打到对端的 /v1/sync/{push,pull}。
 */
export interface SyncPushReceipt {
  /** 对端新导入的事件数 */
  accepted: number;
  /** 对端因 event_id 已存在而跳过的条数 */
  duplicates: number;
}

export interface SyncTransportPullResult {
  envelopes: SyncEnvelope[];
  nextSeq: number;
  hasMore: boolean;
}

export interface SyncTransport {
  push(peerId: string, envelopes: SyncEnvelope[]): Promise<SyncPushReceipt>;
  pull(peerId: string, sinceSeq: number, limit: number): Promise<SyncTransportPullResult>;
}

export interface InMemorySyncTransportOptions {
  /** 调用方（发送方）副本 id，随 push 请求告知对端 */
  selfReplicaId: string;
  /** peer replica_id → 已打开的同步引擎（两端共享同一张表即模拟重连） */
  peers: Map<string, SyncEngine>;
}

/** 进程内传输：直接把批交给对端引擎，零网络、零序列化（契约测试用） */
export class InMemorySyncTransport implements SyncTransport {
  readonly #selfReplicaId: string;
  readonly #peers: Map<string, SyncEngine>;

  constructor(options: InMemorySyncTransportOptions) {
    this.#selfReplicaId = options.selfReplicaId;
    this.#peers = options.peers;
  }

  async push(peerId: string, envelopes: SyncEnvelope[]): Promise<SyncPushReceipt> {
    const peer = this.#peer(peerId);
    const outcome = peer.receivePush(this.#selfReplicaId, envelopes);
    return { accepted: outcome.accepted, duplicates: outcome.duplicates };
  }

  async pull(peerId: string, sinceSeq: number, limit: number): Promise<SyncTransportPullResult> {
    const peer = this.#peer(peerId);
    const batch = peer.exportBatch(sinceSeq, limit);
    return { envelopes: batch.envelopes, nextSeq: batch.next_seq, hasMore: batch.has_more };
  }

  #peer(peerId: string): SyncEngine {
    const peer = this.#peers.get(peerId);
    if (peer === undefined) {
      throw new SyncError("sync_transport_unavailable", `peer ${peerId} is not reachable over the in-memory transport`, {
        peer_replica_id: peerId,
      });
    }
    return peer;
  }
}
