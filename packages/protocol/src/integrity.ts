import { createHash } from "node:crypto";
import type { EventEnvelope } from "./event-envelope.ts";

/**
 * integrity_hash 的规范序列化规则（与 Go/其他运行时实现共享的唯一规则，详见 README）：
 *
 * 1. 取整个事件信封对象，【剔除 integrity_hash 字段本身】；
 * 2. 递归按键名升序排序对象键（UTF-16 码元序，即 JS 默认字符串比较）；
 *    数组保持原有顺序；字段一个不删、一个不加；
 * 3. 以紧凑形式输出（键值间无空格），字符串转义与数字格式遵循 ECMAScript
 *    JSON.stringify 语义；非 ASCII 字符不转义，按 UTF-8 原样输出；
 * 4. 对所得字符串按 UTF-8 编码取 sha256，输出 `sha256-<64位小写hex>`。
 *
 * 输入必须是 JSON 值：出现 undefined / 函数 / bigint / symbol 时抛 TypeError，
 * 绝不静默丢弃（否则哈希会掩盖数据）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalJson: NaN/Infinity 不是合法 JSON 值");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: 非 JSON 值（${typeof value}）`);
  }
}

/** 信封减去 integrity_hash 后的形态；允许携带（将被忽略），便于对完整信封直接复算 */
export type EventEnvelopeWithoutHash = Omit<EventEnvelope, "integrity_hash"> & {
  integrity_hash?: string;
};

/** 按规范序列化规则计算事件的 integrity_hash（`sha256-<hex>`） */
export function computeIntegrityHash(event: EventEnvelopeWithoutHash): string {
  const { integrity_hash: _ignored, ...rest } = event;
  const digest = createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
  return `sha256-${digest}`;
}
