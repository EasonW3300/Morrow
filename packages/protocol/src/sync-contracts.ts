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
}

/** 每对 peer 的同步游标 */
export interface SyncCursorRecord {
  peer_replica_id: string;
  /** 已从 peer 账本拉取并导入的最高 sequence（peer 的命名空间） */
  last_pulled_sequence: number;
  /** 已获 peer 确认的对端推送方向最高 sequence（发送方是本副本时为本地命名空间；
   *  接收方是 peer 推送时存 peer 的命名空间）——见 README 同步章节口径 */
  last_acked_sequence: number;
  /** 最后更新时间（从未推进的 peer 为 null） */
  updated_at: string | null;
}

/** GET /v1/sync/status 响应 */
export interface SyncStatus {
  replica_id: string;
  sequence: { min: number | null; max: number | null; count: number };
  cursors: SyncCursorRecord[];
}

/** 缺口/校验错误 payload 的稳定字段（HTTP 错误信封 error 对象内随 code/message 平铺） */
export interface SyncGapDetails {
  peer_replica_id: string;
  expected: number;
  actual: number;
}
