// EventLedger seam 测试：账本是 append-only 事件存储，公共接口为
// open / append / list / verifyIntegrity / close。
// 篡改测试故意绕过接口直接改库（SQL 与字节两级）——那是账本要防御的通道。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventEnvelope } from "@morrow/protocol";
import { EventLedger, LedgerError } from "../src/ledger.ts";
import { uuidv7 } from "../src/uuid-v7.ts";
import { makeEvent, removeDir, tmpDir } from "./helpers.ts";

test("uuidv7 produces schema-valid, unique identifiers", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(uuidv7());
  assert.equal(seen.size, 1000);
  for (const id of seen) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test("append stores a schema-valid envelope and list returns it verbatim", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  const envelope = makeEvent({ payload: { reason: "probe" } });
  ledger.append(envelope);
  const page = ledger.list();
  assert.equal(page.events.length, 1);
  assert.deepEqual(page.events[0], envelope);
  ledger.close();
  removeDir(dir);
});

test("append rejects envelopes that fail the protocol JSON schema", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  const cases = [
    { name: "unknown top-level field", value: { ...makeEvent(), unexpected_field: true } },
    { name: "event_type without dot separator", value: makeEvent({ event_type: "badtype" }) },
    { name: "occurred_at not Z-suffixed UTC", value: makeEvent({ occurred_at: "2026-10-29T12:00:00.000+08:00" }) },
    { name: "missing integrity_hash", value: { ...makeEvent(), integrity_hash: undefined } as unknown as EventEnvelope },
  ];
  for (const { name, value } of cases) {
    assert.throws(() => ledger.append(value), (err: LedgerError) => {
      assert.ok(err instanceof LedgerError);
      assert.equal(err.code, "invalid_envelope", name);
      return true;
    }, name);
  }
  assert.equal(ledger.list().events.length, 0);
  ledger.close();
  removeDir(dir);
});

test("append rejects an envelope whose integrity_hash does not match its content", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  const envelope = makeEvent();
  envelope.payload = { tampered: true }; // 造假 hash 后再改 payload
  assert.throws(() => ledger.append(envelope), (err: LedgerError) => {
    assert.equal(err.code, "hash_mismatch");
    return true;
  });
  assert.equal(ledger.list().events.length, 0);
  ledger.close();
  removeDir(dir);
});

test("append rejects a duplicate event_id", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  const envelope = makeEvent();
  ledger.append(envelope);
  assert.throws(() => ledger.append(envelope), (err: LedgerError) => {
    assert.equal(err.code, "duplicate_event_id");
    return true;
  });
  assert.equal(ledger.list().events.length, 1);
  ledger.close();
  removeDir(dir);
});

test("update and delete on the ledger table are rejected at the database level", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  ledger.append(makeEvent());
  ledger.close();

  // 绕过账本接口、直接开第二条连接的攻击者，也应被库级 append-only 约束拦下
  const raw = new DatabaseSync(join(dir, "events.sqlite"));
  assert.throws(() => raw.exec("UPDATE events SET envelope = envelope"), /append-only/);
  assert.throws(() => raw.exec("DELETE FROM events"), /append-only/);
  raw.close();
  removeDir(dir);
});

test("verifyIntegrity passes on an untouched ledger", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  for (let i = 0; i < 5; i++) ledger.append(makeEvent());
  const report = ledger.verifyIntegrity();
  assert.equal(report.ok, true);
  assert.equal(report.checked, 5);
  assert.equal(report.total, 5);
  assert.deepEqual(report.mismatches, []);
  ledger.close();
  removeDir(dir);
});

test("verifyIntegrity detects byte-level tampering of the database file", async () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  const marker = "ledger-tamper-probe";
  const e1 = makeEvent({ payload: { marker: "untouched" } });
  const e2 = makeEvent({ payload: { marker } });
  const e3 = makeEvent({ payload: { marker: "also-untouched" } });
  ledger.append(e1);
  ledger.append(e2);
  ledger.append(e3);
  ledger.close(); // 干净关闭：WAL checkpoint 回主库文件

  const dbFile = join(dir, "events.sqlite");
  const bytes = readFileSync(dbFile);
  const at = bytes.indexOf(Buffer.from(`"${marker}"`));
  assert.ok(at > 0, "tamper target string must exist in the database file");
  bytes[at + 1] = 0x4c; // 'l' -> 'L'，等长改写 payload 字节
  bytes[at + 2] = 0x45; // 'e' -> 'E'
  writeFileSync(dbFile, bytes);

  const reopened = EventLedger.open(dir);
  const report = reopened.verifyIntegrity();
  assert.equal(report.ok, false);
  assert.equal(report.checked, 3);
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].event_id, e2.event_id);
  // 账本仍可读：篡改是"可检出"，不是"不可读"
  assert.equal(reopened.list().events.length, 3);
  reopened.close();
  removeDir(dir);
});

test("verifyIntegrity sample rate checks a deterministic subset", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  for (let i = 0; i < 10; i++) ledger.append(makeEvent());
  const report = ledger.verifyIntegrity({ sampleRate: 0.5 });
  assert.equal(report.ok, true);
  assert.equal(report.checked, 5);
  assert.equal(report.total, 10);
  ledger.close();
  removeDir(dir);
});

test("list paginates and filters by replica_id", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  const otherReplica = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
  const a = makeEvent({ payload: { i: 1 } });
  const b = makeEvent({ payload: { i: 2 }, replica_id: otherReplica });
  const c = makeEvent({ payload: { i: 3 } });
  const d = makeEvent({ payload: { i: 4 }, replica_id: otherReplica });
  for (const e of [a, b, c, d]) ledger.append(e);

  const page1 = ledger.list({ limit: 2 });
  assert.deepEqual(page1.events.map((e) => e.event_id), [a.event_id, b.event_id]);
  assert.equal(page1.total, 4);
  assert.equal(page1.limit, 2);
  assert.equal(page1.offset, 0);

  const page2 = ledger.list({ limit: 2, offset: 2 });
  assert.deepEqual(page2.events.map((e) => e.event_id), [c.event_id, d.event_id]);

  const filtered = ledger.list({ replicaId: otherReplica });
  assert.deepEqual(filtered.events.map((e) => e.event_id), [b.event_id, d.event_id]);
  assert.equal(filtered.total, 2);
  ledger.close();
  removeDir(dir);
});

test("closed ledger rejects every operation with an honest ledger_closed code (not invalid_envelope)", () => {
  const dir = tmpDir();
  const ledger = EventLedger.open(dir);
  ledger.append(makeEvent({ payload: { i: 1 } }));
  ledger.close();
  ledger.close(); // close 幂等

  const cases: Array<[string, () => unknown]> = [
    ["append", () => ledger.append(makeEvent({ payload: { i: 2 } }))],
    ["list", () => ledger.list()],
    ["scan", () => ledger.scan()],
    ["count", () => ledger.count()],
    ["verifyIntegrity", () => ledger.verifyIntegrity()],
  ];
  for (const [name, fn] of cases) {
    assert.throws(fn, (err: LedgerError) => {
      assert.ok(err instanceof LedgerError, name);
      assert.equal(err.code, "ledger_closed", `${name} 应报 ledger_closed（不是信封非法）`);
      return true;
    }, name);
  }
  removeDir(dir);
});
