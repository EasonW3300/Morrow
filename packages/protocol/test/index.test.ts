import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, eventEnvelopeSchema } from "../src/index.ts";
import { prdExampleEvent } from "./fixtures.ts";

test("package entry exports the schema document with version 1 pinned", () => {
  const schema = eventEnvelopeSchema as { properties?: { schema_version?: { const?: number } } };
  assert.equal(schema.properties?.schema_version?.const, 1);
});

test("package entry exports working canonicalization helpers", () => {
  assert.equal(typeof canonicalJson({ b: 1, a: 2 }), "string");
  assert.match(prdExampleEvent.integrity_hash, /^sha256-[0-9a-f]{64}$/);
});
