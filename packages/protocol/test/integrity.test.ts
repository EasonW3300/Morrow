import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, computeIntegrityHash } from "../src/integrity.ts";
import { prdExampleEvent, validFixtures } from "./fixtures.ts";

// 独立锚点，避免同义反复：
// - 规范序列化字面量按 README 规则【手工写出】（键按 UTF-16 码元升序、无空白、数组保序、
//   JSON.stringify 转义语义、UTF-8 原样输出非 ASCII）；
// - sha256 由 `shasum -a 256` 对上述字面量【独立计算】，不经过被测实现。

const prdCanonical = `{"actor_id":"owner","causation_id":null,"event_id":"01936b9d-8f7a-7abc-9f2e-3d5c7a9b1c2d","event_type":"tool.started","occurred_at":"2026-10-29T12:00:00.000Z","payload":{},"replica_id":"f47ac10b-58cc-4372-a567-0e02b2c3d479","schema_version":1,"session_id":"9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f","task_id":null}`;
const prdHash = "sha256-4acca956be71a85a495900514a74a564478db319ea479d772c4d0caa08d83938";

const trickyEvent = {
  event_id: "01936b9d-8f7a-7abc-9f2e-3d5c7a9b1c2d",
  replica_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  actor_id: "agent:doc-summarizer",
  event_type: "tool.finished",
  occurred_at: "2026-10-29T12:00:00.000Z",
  schema_version: 1,
  payload: { b: 1, a: { d: [2, 1], c: '引"号' } },
} as const;

const trickyCanonical = String.raw`{"actor_id":"agent:doc-summarizer","event_id":"01936b9d-8f7a-7abc-9f2e-3d5c7a9b1c2d","event_type":"tool.finished","occurred_at":"2026-10-29T12:00:00.000Z","payload":{"a":{"c":"引\"号","d":[2,1]},"b":1},"replica_id":"f47ac10b-58cc-4372-a567-0e02b2c3d479","schema_version":1}`;
const trickyHash = "sha256-05a96a63061e827dd965726b7e27b1a24043335f4f78082a3df1e649631af7c2";

test("canonicalJson: recursive key sort, no whitespace, nulls preserved", () => {
  const { integrity_hash: _omit, ...event } = prdExampleEvent;
  assert.equal(canonicalJson(event), prdCanonical);
});

test("canonicalJson: array order kept, JSON.stringify escaping, non-ASCII kept raw as UTF-8", () => {
  assert.equal(canonicalJson(trickyEvent), trickyCanonical);
});

test("computeIntegrityHash: sha256 of canonical form, prefixed sha256-", () => {
  const { integrity_hash: _omit, ...event } = prdExampleEvent;
  assert.equal(computeIntegrityHash(event), prdHash);
  assert.equal(computeIntegrityHash(trickyEvent), trickyHash);
});

test("hash is independent of key insertion order", () => {
  // 与 prdExampleEvent 相同的值，键按相反顺序插入
  const reordered = {
    integrity_hash: "sha256-0f4b3d2a9c8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a",
    task_id: null,
    session_id: "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f",
    schema_version: 1 as const,
    replica_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    payload: {},
    occurred_at: "2026-10-29T12:00:00.000Z",
    event_type: "tool.started",
    event_id: "01936b9d-8f7a-7abc-9f2e-3d5c7a9b1c2d",
    causation_id: null,
    actor_id: "owner" as const,
  };
  assert.equal(computeIntegrityHash(reordered), prdHash);
});

test("an existing integrity_hash field is ignored when recomputing", () => {
  assert.equal(computeIntegrityHash(prdExampleEvent), prdHash);
});

test("hash changes when payload changes (integrity is load-bearing)", () => {
  const { integrity_hash: _omit, ...event } = prdExampleEvent;
  const tampered = { ...event, payload: { tampered: true } };
  assert.notEqual(computeIntegrityHash(tampered), prdHash);
});

test("canonicalJson rejects non-JSON values instead of silently dropping them", () => {
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => canonicalJson({ a: () => 1 }), TypeError);
  assert.throws(() => canonicalJson({ a: 1n }), TypeError);
});

test("every valid fixture carries a hash consistent with the canonical rule (producer contract)", () => {
  for (const fixture of validFixtures) {
    assert.equal(computeIntegrityHash(fixture), fixture.integrity_hash);
  }
});
