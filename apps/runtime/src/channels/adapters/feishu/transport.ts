import type { EventTransport } from "../../event-transport.ts";

/**
 * 飞书事件订阅传输接缝（M4-T3 / Issue #40）。
 *
 * 实现已抽到 `channels/event-transport.ts`（M4-T4 起 QQ 复用同一 HTTP 长轮询与
 * 游标语义）；本文件保留飞书命名别名与历史导出，适配器代码无需改动。
 */

export type FeishuEventTransport = EventTransport;

export { HttpLongPollEventTransport } from "../../event-transport.ts";
export type { HttpLongPollEventTransportOptions } from "../../event-transport.ts";
