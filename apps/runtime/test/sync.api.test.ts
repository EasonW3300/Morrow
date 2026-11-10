// 同步控制面 HTTP 测试（票 M3-T1 / Issue #30，PRD §6.2）：
// GET /v1/sync/status、GET /v1/sync/pull（limit/截断）、POST /v1/sync/push
// （幂等、sync_gap 拒绝推进、integrity 拒绝）。进程内起服务，零外部网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope, SyncEnvelope, SyncPullBatch, SyncPushOutcome, SyncStatus } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, makeEvent, removeDir, REPLICA_B, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string; expected?: number; actual?: number; event_id?: string };
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA_A, provider: null };
}

function url(runtime: RuntimeHandle, path: string): string {
  return `http://127.0.0.1:${runtime.port}${path}`;
}

function syncBatch(sourceReplicaId: string, envelopes: EventEnvelope[]): SyncEnvelope[] {
  return envelopes.map((envelope, index) => ({
    source_replica_id: sourceReplicaId,
    sequence: index + 1,
    envelope,
  }));
}

async function push(runtime: RuntimeHandle, peerReplicaId: string, envelopes: SyncEnvelope[]): Promise<Response> {
  return fetch(url(runtime, "/v1/sync/push"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer_replica_id: peerReplicaId, envelopes }),
  });
}

test("GET /v1/sync/status 返回本副本 sequence 范围与空游标集合", async () => {
  const dir = tmpDir("morrow-sync-api-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(url(runtime, "/v1/sync/status"));
    assert.equal(res.status, 200);
    const body = await json<SyncStatus>(res);
    assert.equal(body.replica_id, REPLICA_A);
    assert.ok(body.sequence.count >= 1, "runtime.started 已在账本");
    assert.equal(body.sequence.min, 1);
    assert.equal(body.sequence.max, body.sequence.count);
    assert.deepEqual(body.cursors, []);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("GET /v1/sync/pull 按 since/limit 增量导出，截断置 has_more；拒绝非法查询参数", async () => {
  const dir = tmpDir("morrow-sync-api-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const initialMax = (await json<SyncStatus>(await fetch(url(runtime, "/v1/sync/status")))).sequence.max ?? 0;
    for (let i = 0; i < 3; i++) {
      runtime.ledger.append(
        makeEvent({ replica_id: REPLICA_A, event_type: "test.sync_api", payload: { index: i } }),
      );
    }
    // 启动事件（runtime.started + builtin 能力注册）+ 3 条
    const total = initialMax + 3;
    const first = await fetch(url(runtime, "/v1/sync/pull?since=0&limit=2"));
    assert.equal(first.status, 200);
    const firstBody = await json<SyncPullBatch>(first);
    assert.deepEqual(firstBody.envelopes.map((item) => item.sequence), [1, 2]);
    assert.equal(firstBody.next_seq, 2);
    assert.equal(firstBody.has_more, total > 2);
    for (const item of firstBody.envelopes) {
      assert.equal(item.source_replica_id, REPLICA_A, "source 是本副本账本（sequence 的分配者）");
      assert.equal(item.envelope.replica_id, REPLICA_A);
    }

    const second = await fetch(url(runtime, "/v1/sync/pull?since=2&limit=2"));
    const secondBody = await json<SyncPullBatch>(second);
    assert.deepEqual(secondBody.envelopes.map((item) => item.sequence), [3, 4]);
    assert.equal(secondBody.next_seq, 4);
    assert.equal(secondBody.has_more, total > 4);

    const third = await fetch(url(runtime, `/v1/sync/pull?since=4&limit=2`));
    const thirdBody = await json<SyncPullBatch>(third);
    assert.deepEqual(thirdBody.envelopes.map((item) => item.sequence), [5]);
    assert.equal(thirdBody.next_seq, 5);
    assert.equal(thirdBody.has_more, false);

    const defaults = await fetch(url(runtime, "/v1/sync/pull"));
    const defaultsBody = await json<SyncPullBatch>(defaults);
    assert.equal(defaultsBody.envelopes.length, total, "since 缺省 0 / limit 缺省 100");
    assert.equal(defaultsBody.has_more, false);

    for (const query of ["since=-1", "since=abc", "limit=0", "limit=1001", "limit=abc"]) {
      const res = await fetch(url(runtime, `/v1/sync/pull?${query}`));
      assert.equal(res.status, 400, `${query} 应 400`);
      assert.equal((await json<ApiError>(res)).error.code, "invalid_query");
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("POST /v1/sync/push 幂等导入：同批重推 accepted=0/duplicates=N，事件数不变，游标不后退", async () => {
  const dir = tmpDir("morrow-sync-api-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const envelopes = syncBatch(REPLICA_B, [
      makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api", payload: { index: 0 } }),
      makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api", payload: { index: 1 } }),
      makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api", payload: { index: 2 } }),
    ]);

    const first = await push(runtime, REPLICA_B, envelopes);
    assert.equal(first.status, 200);
    const firstBody = await json<SyncPushOutcome>(first);
    assert.deepEqual(firstBody, { accepted: 3, duplicates: 0, next_seq: 3 });
    assert.equal(runtime.ledger.scan({ eventType: "test.sync_api" }).length, 3);

    const countBefore = runtime.ledger.count();
    const second = await push(runtime, REPLICA_B, envelopes);
    assert.equal(second.status, 200, "重复批不是错误");
    const secondBody = await json<SyncPushOutcome>(second);
    assert.deepEqual(secondBody, { accepted: 0, duplicates: 3, next_seq: 3 });
    assert.equal(runtime.ledger.scan({ eventType: "test.sync_api" }).length, 3, "不产生重复事件");
    assert.equal(runtime.ledger.count(), countBefore + 1, "只追加一条 sync.pushed 审计");

    const status = await json<SyncStatus>(await fetch(url(runtime, "/v1/sync/status")));
    const cursor = status.cursors.find((row) => row.peer_replica_id === REPLICA_B);
    assert.ok(cursor);
    assert.equal(cursor.last_pulled_sequence, 3, "接收 push 推进 inbound 游标");
    assert.equal(cursor.last_acked_sequence, 0, "outbound 不被收到的 push 污染");

    const pushed = runtime.ledger.scan({ eventType: "sync.pushed" });
    assert.equal(pushed.length, 2);
    assert.equal((pushed[0].envelope.payload as Record<string, unknown>).accepted, 3);
    assert.equal((pushed[1].envelope.payload as Record<string, unknown>).duplicates, 3);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("POST /v1/sync/push 批内 sequence 缺口 → 409 sync_gap（expected/actual），不落数据、游标不推进", async () => {
  const dir = tmpDir("morrow-sync-api-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const all = syncBatch(REPLICA_B, [
      makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api", payload: { index: 0 } }),
      makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api", payload: { index: 1 } }),
      makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api", payload: { index: 2 } }),
    ]);
    const gapped = [all[0], all[2]]; // 缺 sequence 2

    const res = await push(runtime, REPLICA_B, gapped);
    assert.equal(res.status, 409);
    const body = await json<ApiError>(res);
    assert.equal(body.error.code, "sync_gap");
    assert.equal(body.error.expected, 2);
    assert.equal(body.error.actual, 3);
    assert.equal(runtime.ledger.scan({ eventType: "test.sync_api" }).length, 0, "整批未导入");
    assert.equal(runtime.ledger.scan({ eventType: "sync.gap_detected" }).length, 1, "缺口留审计");
    const status = await json<SyncStatus>(await fetch(url(runtime, "/v1/sync/status")));
    assert.equal(status.cursors.length, 0, "游标未创建（不推进）");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("POST /v1/sync/push integrity_hash 不符 → 400 拒绝整批（合法前置事件也不落库）", async () => {
  const dir = tmpDir("morrow-sync-api-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const batch = syncBatch(REPLICA_B, [
      makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api", payload: { index: 0 } }),
      makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api", payload: { index: 1 } }),
    ]);
    const tampered = structuredClone(batch[1].envelope);
    tampered.payload = { tampered: true };

    const res = await push(runtime, REPLICA_B, [batch[0], { ...batch[1], envelope: tampered }]);
    assert.equal(res.status, 400);
    const body = await json<ApiError>(res);
    assert.equal(body.error.code, "sync_integrity_mismatch");
    assert.equal(body.error.event_id, tampered.event_id);
    assert.equal(runtime.ledger.scan({ eventType: "test.sync_api" }).length, 0, "整批拒绝");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("POST /v1/sync/push 非法 body（peer/源不一致、非数组）→ 400", async () => {
  const dir = tmpDir("morrow-sync-api-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const mismatch = syncBatch(REPLICA_B, [makeEvent({ replica_id: REPLICA_B, event_type: "test.sync_api" })]);
    const res = await push(runtime, REPLICA_A, mismatch);
    assert.equal(res.status, 400);
    assert.equal((await json<ApiError>(res)).error.code, "sync_invalid_batch");

    const badPeer = await fetch(url(runtime, "/v1/sync/push"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer_replica_id: "not-a-uuid", envelopes: [] }),
    });
    assert.equal(badPeer.status, 400);
    assert.equal((await json<ApiError>(badPeer)).error.code, "invalid_body");

    const badEnvelopes = await fetch(url(runtime, "/v1/sync/push"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer_replica_id: REPLICA_B, envelopes: "nope" }),
    });
    assert.equal(badEnvelopes.status, 400);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
