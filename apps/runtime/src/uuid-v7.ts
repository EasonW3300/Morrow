import { randomBytes } from "node:crypto";

/**
 * UUID v7（RFC 9562）：48 位 unix 毫秒时间戳（大端）+ 4 位版本(0111) + 随机位 +
 * 2 位变体(10) + 随机位。副本内生成，事件全局唯一不复用（protocol README 事件信封 v1）。
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now) & ((1n << 48n) - 1n);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 小写 uuid 形态校验（事件信封的 event_id/replica_id 都是这个形态）。
 * config.ts（MORROW_REPLICA_ID / replica-id 文件）与 runtime.ts（events 查询参数）
 * 共用此定义——原先各有一份，收敛于此（M0 code-review / Issue #11）。
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
