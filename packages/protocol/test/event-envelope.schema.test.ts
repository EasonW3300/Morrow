import { test } from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import envelopeSchema from "../schema/event-envelope.schema.json" with { type: "json" };
import {
  invalidFixtures,
  outboundDeliveredEvent,
  outboundUnknownEvent,
  prdExampleEvent,
  validFixtures,
} from "./fixtures.ts";

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(envelopeSchema);

test("schema accepts the PRD §6.3 example envelope", () => {
  const ok = validate(prdExampleEvent);
  assert.equal(ok, true, JSON.stringify(validate.errors, null, 2));
});

for (const { name, value } of invalidFixtures) {
  test(`schema rejects: ${name}`, () => {
    assert.equal(validate(value), false, "expected rejection but schema accepted the sample");
  });
}

test("schema accepts every valid fixture", () => {
  for (const fixture of validFixtures) {
    const ok = validate(fixture);
    assert.equal(ok, true, `${JSON.stringify(fixture.event_type)}: ${JSON.stringify(validate.errors, null, 2)}`);
  }
});

test("outbound side-effect events carry idempotency_key and receipt status", () => {
  assert.equal(validate(outboundDeliveredEvent), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate(outboundUnknownEvent), true, JSON.stringify(validate.errors, null, 2));
});
