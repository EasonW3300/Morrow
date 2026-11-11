/**
 * 同步错误（M3-T1 / Issue #30）。HTTP 层按 code 映射状态码：
 * sync_gap → 409（游标不推进，payload 带 expected/actual）；
 * sync_integrity_mismatch / sync_invalid_batch → 400；
 * sync_transport_unavailable → 503（仅内部编排路径出现）。
 */
export type SyncErrorCode =
  | "sync_gap"
  | "sync_integrity_mismatch"
  | "sync_invalid_batch"
  | "sync_transport_unavailable";

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SyncErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.details = details;
  }
}
