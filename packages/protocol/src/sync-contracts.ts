import type { EventEnvelope } from "./event-envelope.ts";

/**
 * 同步协议 v1（PRD §4.6 FR-DEP-3 / §6.3；M3-T1 / Issue #30）。
 *
 * **演进规则与事件信封同口径：只加字段不删改。** 同步单元是逻辑事件，绝不复制
 * 活跃 SQLite 文件：每条 SyncEnvelope 携带事件信封原文 + 分配该 sequence 的账本
 * 副本 id。`sequence` 属于 `source_replica_id` 的本地账本序列（单调、跨副本可重放），
 * 而 `envelope.replica_id` 仍是事件最初产生的副本——两者在传递同步中可能不同。
 */
export interface SyncEnvelope {
  /** 分配 sequence 的账本副本（同步批次的来源账本） */
  source_replica_id: string;
  /** 来源账本内的写入序号（从 1 起单调递增） */
  sequence: number;
  /** 事件信封原文（完整性哈希随行，导入方复算校验） */
  envelope: EventEnvelope;
}

/** GET /v1/sync/pull 响应 */
export interface SyncPullBatch {
  /** 按来源账本 sequence 升序排列 */
  envelopes: SyncEnvelope[];
  /** 本批最后一条的 sequence；空批 = 请求的 since */
  next_seq: number;
  /** 是否还有更多（limit 截断时 true） */
  has_more: boolean;
}

/** POST /v1/sync/push 请求体 */
export interface SyncPushRequest {
  /** 推送方副本 id（与 envelopes 的 source_replica_id 一致） */
  peer_replica_id: string;
  envelopes: SyncEnvelope[];
}

/** POST /v1/sync/push 响应（导入结果） */
export interface SyncPushOutcome {
  /** 新写入账本的事件数 */
  accepted: number;
  /** 因 event_id 已存在而跳过的条数（幂等去重） */
  duplicates: number;
  /** 可推进到的来源 sequence；空批为 null */
  next_seq: number | null;
  /** 命中删除集合（tombstone）而跳过的事件数（M3-T3；无跳过时省略） */
  skipped?: number;
}

/** 每对 peer 的同步游标（两个方向各用独立存储列，M3 code-review A2） */
export interface SyncCursorRecord {
  peer_replica_id: string;
  /** inbound：已从 peer 拉取/接收并导入的最高 **peer** 账本 sequence
   *  （pull 与 receivePush 共用这一列） */
  last_pulled_sequence: number;
  /** outbound：已获 peer 确认的最高 **本地** sequence（只由 push 回执推进；
   *  接收对端 push 不会改变它，否则反向推送会从错误序号起跳） */
  last_acked_sequence: number;
  /**
   * 最近一次成功同步（任一方向的 pull / push / 接收 push）时间；从未成功过为 null。
   * M3 修复批（Issue #35）新增——此前只有 updated_at（游标推进时间），「空批成功
   * 同步」不会推进游标也读不到时间。
   */
  last_synced_at: string | null;
  /** 最后更新时间（从未推进的 peer 为 null） */
  updated_at: string | null;
}

/**
 * 单个 peer 的同步状态（GET /v1/sync/status 的 `peers` 元素，M3 修复批 / Issue #35）。
 *
 * 待同步量口径：
 *   pending_upload   = max(0, 本副本账本最大 sequence − last_acked_sequence)。
 *                      last_acked_sequence 是 outbound 游标（本地命名空间，已获 peer 确认）。
 *   pending_download = max(0, 对端账本最大 sequence − last_pulled_sequence)。对端上界必须
 *                      实时查询（GET /v1/sync/status?probe=local）；对端不可达时为 null
 *                      且 unreachable=true——不伪造 0。
 */
export interface SyncPeerStatus {
  peer_replica_id: string;
  last_pulled_sequence: number;
  last_acked_sequence: number;
  last_synced_at: string | null;
  pending_upload: number;
  pending_download: number | null;
  /** 本次状态查询未能从对端取得账本上界（pending_download 因此为 null） */
  unreachable: boolean;
  /**
   * 不可达原因（M3 同步接线修复 / Issue #34）：`no_base_url`（设备记录缺地址）、
   * `device_revoked`、`missing_token` 401、`invalid_token`、网络错误等。
   * 可达时为 null。
   */
  unreachable_reason: string | null;
  /** 对端账本最大 sequence（取到才给；诊断用） */
  remote_max_sequence: number | null;
}

/** GET /v1/sync/status 响应 */
export interface SyncStatus {
  replica_id: string;
  sequence: { min: number | null; max: number | null; count: number };
  /** 所有 peer 中最近一次成功同步时间；从未同步为 null（M3 修复批） */
  last_sync_at: string | null;
  /** 兼容既有消费者：逐 peer 游标原样保留（含新增 last_synced_at） */
  cursors: SyncCursorRecord[];
  /** 逐 peer 状态（游标 + 待上传/下载；M3 修复批） */
  peers: SyncPeerStatus[];
}

/** POST /v1/sync/run 请求体（M3 修复批 / Issue #35） */
export interface SyncRunRequest {
  /** 缺省 = 全部已配对 peer；给定时只跑该 peer */
  peer_replica_id?: string;
}

/** 单个 peer 的一轮同步结果（pull → push → push → pull，双向两轮） */
export interface SyncPeerRunResult {
  peer_replica_id: string;
  /** 从对端导入并新增到本副本账本的事件数 */
  pulled: number;
  /** 对端接受（新导入）的本副本事件数 */
  pushed: number;
  /** 双向因 event_id 已存在而跳过的条数合计 */
  duplicates: number;
  /** 本轮命中的序列缺口次数（sync_gap） */
  gaps: number;
  /** 空数组 = 成功；失败时为可读错误码/消息（单 peer 失败不中断其他 peer） */
  errors: string[];
  ok: boolean;
}

/** POST /v1/sync/run 响应 */
export interface SyncRunReport {
  requested_peer_replica_id: string | null;
  peers: SyncPeerRunResult[];
  totals: {
    peers: number;
    ok: number;
    failed: number;
    pulled: number;
    pushed: number;
    duplicates: number;
    gaps: number;
  };
}

/** 缺口/校验错误 payload 的稳定字段（HTTP 错误信封 error 对象内随 code/message 平铺） */
export interface SyncGapDetails {
  peer_replica_id: string;
  expected: number;
  actual: number;
}
