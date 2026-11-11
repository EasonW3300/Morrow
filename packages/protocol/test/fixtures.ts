// 共享测试夹具：合法样例同时用于 JSON Schema 校验测试与 TS 类型 round-trip 测试，
// 两边引用同一份夹具，保证两种形态永不漂移。
// 注意：夹具不带类型标注（types.roundtrip.test.ts 中由 tsc --noEmit 验证其可赋值给 EventEnvelope）。

export const prdExampleEvent = {
  event_id: "01936b9d-8f7a-7abc-9f2e-3d5c7a9b1c2d",
  replica_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  actor_id: "owner",
  task_id: null,
  session_id: "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f",
  event_type: "tool.started",
  occurred_at: "2026-10-29T12:00:00.000Z",
  causation_id: null,
  schema_version: 1,
  payload: {},
  integrity_hash: "sha256-4acca956be71a85a495900514a74a564478db319ea479d772c4d0caa08d83938",
} as const;

// 外发副作用事件：在信封上另带 idempotency_key、渠道回执与 delivery_unknown 状态标记（PRD §6.3）。
export const outboundDeliveredEvent = {
  ...prdExampleEvent,
  event_type: "channel.message.sent",
  idempotency_key: "feishu-20261029-8f14e45f",
  receipt: {
    channel: "feishu",
    remote_message_id: "om_9f2e3d5c7a9b",
    delivered_at: "2026-10-29T12:00:01.500Z",
  },
  delivery_unknown: false,
  integrity_hash: "sha256-dbb1d6e1a17aba2696766137f81e462ca2cb57f8d923d612883d9fe43dc3c422",
} as const;

export const outboundUnknownEvent = {
  ...prdExampleEvent,
  event_type: "channel.message.sent",
  idempotency_key: "feishu-20261029-0a1b2c3d",
  delivery_unknown: true,
  integrity_hash: "sha256-b37289d97baeb53ac1dcb57d90c66e25046be4f24b099492484ba401dead1770",
} as const;

// 合法样例全集：schema 校验测试与 TS 类型 round-trip 测试共用。
export const validFixtures = [prdExampleEvent, outboundDeliveredEvent, outboundUnknownEvent];

const { integrity_hash: _drop, ...withoutHash } = prdExampleEvent;
const { event_id: _dropId, ...withoutEventId } = prdExampleEvent;
const { payload: _dropPayload, ...withoutPayload } = prdExampleEvent;
const { event_type: _dropType, ...withoutEventType } = prdExampleEvent;

// 非法样例：每条都必须被 JSON Schema 拒绝（理由写在 name 里）。
// 这些夹具故意不做类型标注，仅供 Schema 校验测试使用；
// TS 侧的负向断言在 types.roundtrip.test.ts 中用 @ts-expect-error 单独书写。
export const invalidFixtures: ReadonlyArray<{ name: string; value: Record<string, unknown> }> = [
  { name: "missing required event_id", value: withoutEventId },
  { name: "missing required integrity_hash", value: withoutHash },
  { name: "missing required payload", value: withoutPayload },
  { name: "missing required event_type", value: withoutEventType },
  { name: "unknown top-level field is rejected", value: { ...prdExampleEvent, unexpected_field: true } },
  { name: "event_id must be a string (uuid v7)", value: { ...prdExampleEvent, event_id: 123 } },
  { name: "payload must be an object", value: { ...prdExampleEvent, payload: [1, 2] } },
  { name: "schema_version must be 1", value: { ...prdExampleEvent, schema_version: 2 } },
  { name: "occurred_at must be a string", value: { ...prdExampleEvent, occurred_at: 1761744000000 } },
  { name: "event_id must be uuid v7 (version nibble)", value: { ...prdExampleEvent, event_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479" } },
  { name: "event_id must be a uuid at all", value: { ...prdExampleEvent, event_id: "not-a-uuid" } },
  { name: "replica_id must be a uuid", value: { ...prdExampleEvent, replica_id: "device-1" } },
  { name: "task_id must be a uuid when present", value: { ...prdExampleEvent, task_id: "task-42" } },
  { name: "session_id must be a uuid when present", value: { ...prdExampleEvent, session_id: "session-uuid" } },
  { name: "causation_id must be a uuid when present", value: { ...prdExampleEvent, causation_id: "evt_0193" } },
  { name: "actor_id must be owner | contact:<id> | agent:<id>", value: { ...prdExampleEvent, actor_id: "admin" } },
  { name: "event_type must be lowercase dotted identifier", value: { ...prdExampleEvent, event_type: "TOOL.STARTED" } },
  { name: "occurred_at must be RFC 3339 UTC (Z, not offset)", value: { ...prdExampleEvent, occurred_at: "2026-10-29T20:00:00.000+08:00" } },
  { name: "occurred_at must not be a bare date", value: { ...prdExampleEvent, occurred_at: "2026-10-29" } },
  { name: "integrity_hash must be sha256-<64 lowercase hex>", value: { ...prdExampleEvent, integrity_hash: "sha256-ABC" } },
  { name: "idempotency_key must be a non-empty string", value: { ...outboundDeliveredEvent, idempotency_key: "" } },
  { name: "idempotency_key must be a string", value: { ...outboundDeliveredEvent, idempotency_key: 42 } },
  { name: "receipt requires channel", value: { ...outboundDeliveredEvent, receipt: { remote_message_id: "om_x" } } },
  { name: "receipt must not carry unknown fields", value: { ...outboundDeliveredEvent, receipt: { channel: "feishu", bogus: 1 } } },
  { name: "delivery_unknown must be a boolean", value: { ...outboundUnknownEvent, delivery_unknown: "yes" } },
  { name: "delivered_at must be RFC 3339 UTC", value: { ...outboundDeliveredEvent, receipt: { channel: "feishu", delivered_at: "2026-10-29 12:00:01" } } },
];
