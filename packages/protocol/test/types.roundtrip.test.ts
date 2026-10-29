import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope } from "../src/event-envelope.ts";
import { validFixtures } from "./fixtures.ts";

// TS 类型 round-trip 契约（由 `pnpm test` 中的 tsc --noEmit 强制执行）：
// 1) 每个 JSON Schema 合法样例都必须能赋给 EventEnvelope —— schema ⊆ TS，两种形态永不漂移。
//    合法样例与 schema 测试共享同一份 fixtures.ts，一处漂移两边同时变红。
const typedValidFixtures: readonly EventEnvelope[] = validFixtures;

// 2) 明显非法样例必须不能赋给 EventEnvelope。若类型漂移到"什么都收"，
//    对应的 @ts-expect-error 将因未被命中而使 tsc 报错（TS5071）。
//    注：Schema 比 TS 更严（uuid/pattern 无法用类型表达），守门方向是 Schema；
//    这里只固定 TS 侧能表达的约束。
const control: EventEnvelope = { ...validFixtures[0] };

// @ts-expect-error 缺失必填字段 integrity_hash
const badMissingRequired: EventEnvelope = {
  event_id: "01936b9d-8f7a-7abc-9f2e-3d5c7a9b1c2d",
  replica_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  actor_id: "owner",
  event_type: "tool.started",
  occurred_at: "2026-10-29T12:00:00.000Z",
  schema_version: 1,
  payload: {},
};

// @ts-expect-error 未知字段（excess property check）
const badUnknownField: EventEnvelope = { ...validFixtures[0], unexpected_field: true };

// @ts-expect-error schema_version 必须是字面量 1
const badSchemaVersion: EventEnvelope = { ...validFixtures[0], schema_version: 2 };

// @ts-expect-error actor_id 形态受限（owner | contact:<id> | agent:<id>）
const badActorId: EventEnvelope = { ...validFixtures[0], actor_id: "admin" };

// @ts-expect-error delivery_unknown 必须是 boolean
const badDeliveryUnknown: EventEnvelope = { ...validFixtures[2], delivery_unknown: "yes" };

void typedValidFixtures;
void control;
void badMissingRequired;
void badUnknownField;
void badSchemaVersion;
void badActorId;
void badDeliveryUnknown;

test("valid fixtures resolve to the EventEnvelope TS type (compile-time half enforced by tsc --noEmit)", () => {
  assert.equal(validFixtures.length, 3);
  for (const fixture of validFixtures) {
    assert.ok("event_id" in fixture && "integrity_hash" in fixture);
  }
});
