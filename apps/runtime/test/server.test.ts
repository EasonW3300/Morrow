// Runtime HTTP seam 测试（PRD §6.2 M0 子集）：
// GET /v1/health、GET /v1/events（分页 + replica_id 过滤）；
// 变更方法在请求层被拒（账本 append-only）；进程内起服务，端口随机。
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIntegrityHash, type EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, makeEvent, removeDir, REPLICA_B, tmpDir } from "./helpers.ts";

interface HealthBody {
  status: string;
  version: string;
  replica_id: string;
  sandbox: { status: string; detail: string };
  ledger: { events: number };
}

interface EventPage {
  events: EventEnvelope[];
  total: number;
  limit: number;
  offset: number;
}

interface ApiError {
  error: { code: string; message: string };
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" };
}

test("GET /v1/health returns ok with the sandbox probe status", async () => {
  const dir = tmpDir("morrow-health-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await json<HealthBody>(res);
    assert.equal(body.status, "ok");
    assert.equal(body.sandbox.status, "not-configured");
    assert.ok(typeof body.sandbox.detail === "string" && body.sandbox.detail.length > 0);
    assert.ok(body.ledger.events >= 1, "startup event should already be recorded");
    assert.equal(body.replica_id, "f47ac10b-58cc-4372-a567-0e02b2c3d479");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("GET /v1/events returns recorded envelopes with pagination metadata", async () => {
  const dir = tmpDir("morrow-events-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/events`);
    assert.equal(res.status, 200);
    const body = await json<EventPage>(res);
    assert.ok(Array.isArray(body.events) && body.events.length >= 1);
    assert.equal(body.events[0].event_type, "runtime.started");
    assert.equal(body.events[0].actor_id, "agent:runtime");
    assert.match(body.events[0].integrity_hash, /^sha256-[0-9a-f]{64}$/);
    assert.equal(body.total, body.events.length);
    assert.equal(body.limit, 50);
    assert.equal(body.offset, 0);
    // API 返回的信封必须能通过完整性复算（返回原文，可被客户端验证）
    for (const envelope of body.events) {
      assert.equal(computeIntegrityHash(envelope), envelope.integrity_hash);
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("GET /v1/events supports replica_id filter and limit/offset pagination", async () => {
  const dir = tmpDir("morrow-pages-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    for (let i = 0; i < 3; i++) {
      runtime.ledger.append(makeEvent({ payload: { i }, replica_id: REPLICA_B }));
    }
    const filtered = await json<EventPage>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/events?replica_id=${REPLICA_B}`),
    );
    assert.equal(filtered.total, 3);
    assert.equal(filtered.events.length, 3);
    for (const e of filtered.events) assert.equal(e.replica_id, REPLICA_B);

    const paged = await json<EventPage>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/events?limit=2&offset=1&replica_id=${REPLICA_B}`),
    );
    assert.equal(paged.total, 3);
    assert.equal(paged.events.length, 2);
    assert.deepEqual(
      paged.events.map((e) => e.payload.i as number),
      [1, 2],
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("invalid query parameters return 400 invalid_query", async () => {
  const dir = tmpDir("morrow-query-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    for (const query of ["limit=abc", "limit=0", "limit=999", "offset=-1", "replica_id=not-a-uuid"]) {
      const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/events?${query}`);
      assert.equal(res.status, 400, query);
      const body = await json<ApiError>(res);
      assert.equal(body.error.code, "invalid_query", query);
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("unknown paths return 404 JSON errors", async () => {
  const dir = tmpDir("morrow-404-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/nope`);
    assert.equal(res.status, 404);
    const body = await json<ApiError>(res);
    assert.equal(body.error.code, "not_found");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("mutation methods on /v1/events are rejected at the request layer", async () => {
  const dir = tmpDir("morrow-405-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/events`, { method });
      assert.equal(res.status, 405, method);
      assert.match(res.headers.get("allow") ?? "", /GET/, method);
      const body = await json<ApiError>(res);
      assert.equal(body.error.code, "method_not_allowed", method);
    }
    assert.equal(runtime.ledger.list().events.length, 1); // 只剩启动事件，没有被改/删
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("close appends runtime.stopped (causation -> started) and flushes the ledger", async () => {
  const dir = tmpDir("morrow-close-");
  const runtime = await startRuntime(testConfig(dir));
  const port = runtime.port;
  await runtime.close();

  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/v1/health`),
    /fetch failed/,
    "server should be down after close",
  );

  const { EventLedger } = await import("../src/ledger.ts");
  const ledger = EventLedger.open(dir);
  const events = ledger.list({ limit: 200 }).events;
  const started = events.find((e) => e.event_type === "runtime.started");
  const stopped = events.find((e) => e.event_type === "runtime.stopped");
  assert.ok(started, "startup event present");
  assert.ok(stopped, "shutdown event present");
  assert.equal(stopped.causation_id, started?.event_id);
  assert.equal(stopped.payload.reason, "graceful");
  ledger.close();
  removeDir(dir);
});
