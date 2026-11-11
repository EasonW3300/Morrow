/**
 * 渠道页共享的小工具（纯函数）：错误投影、相对时间、Outbox 排序。
 * 从 ChannelsView 原样搬出，行为不变。
 */
import { ApiError, type OutboxMessageRecord } from "../api.ts";

export function readableError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "network_error") return `${fallback}：${err.message}`;
    return `${fallback}（${err.code}）：${err.message}`;
  }
  return `${fallback}：${err instanceof Error ? err.message : String(err)}`;
}

export function relativeTime(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const delta = Math.max(0, nowMs - at);
  if (delta < 60_000) return "刚刚";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return iso.slice(0, 16).replace("T", " ");
}

export function sortByUpdated(messages: OutboxMessageRecord[]): OutboxMessageRecord[] {
  return [...messages].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}
