// HTTP 同步传输单测（票 M3-T1 / Issue #30）：与内存实现同一 SyncTransport 契约，
// fetch 注入桩（零真实网络）。验证请求路径/body 与响应映射、远端错误透传。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SyncEnvelope } from "@morrow/protocol";
import { HttpSyncTransport } from "../src/sync/http-transport.ts";
import { SyncError } from "../src/sync/errors.ts";
import { makeEvent } from "./helpers.ts";

const SELF = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const PEER = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

function envelope(sequence: number): SyncEnvelope {
  return {
    source_replica_id: SELF,
    sequence,
    envelope: makeEvent({ replica_id: SELF, event_type: "test.http_transport", payload: { sequence } }),
  };
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init ?? {})) as typeof fetch;
}

test("HttpSyncTransport.push：POST /v1/sync/push，body 带发送方 replica_id，映射 accepted/duplicates", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new HttpSyncTransport({
    selfReplicaId: SELF,
    baseUrlForPeer: (peerId) => (peerId === PEER ? "http://peer.local:8787/" : "http://wrong"),
    fetchImpl: stubFetch((url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ accepted: 2, duplicates: 1, next_seq: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  });

  const batch = [envelope(1), envelope(2), envelope(3)];
  const receipt = await transport.push(PEER, batch);
  assert.deepEqual(receipt, { accepted: 2, duplicates: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://peer.local:8787/v1/sync/push", "末尾斜杠归一");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { peer_replica_id: SELF, envelopes: batch });
});

test("HttpSyncTransport.pull：GET 带 since/limit，映射 next_seq/has_more", async () => {
  const calls: string[] = [];
  const envelopes = [envelope(4), envelope(5)];
  const transport = new HttpSyncTransport({
    selfReplicaId: SELF,
    baseUrlForPeer: () => "http://peer.local:8787",
    fetchImpl: stubFetch((url) => {
      calls.push(url);
      return new Response(JSON.stringify({ envelopes, next_seq: 5, has_more: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  });

  const result = await transport.pull(PEER, 3, 2);
  assert.equal(calls[0], "http://peer.local:8787/v1/sync/pull?since=3&limit=2");
  assert.deepEqual(result.envelopes, envelopes);
  assert.equal(result.nextSeq, 5);
  assert.equal(result.hasMore, true);
});

test("HttpSyncTransport：远端 sync_gap 错误透传 code 与 expected/actual；网络失败 → sync_transport_unavailable", async () => {
  const gapTransport = new HttpSyncTransport({
    selfReplicaId: SELF,
    baseUrlForPeer: () => "http://peer.local",
    fetchImpl: stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: "sync_gap", message: "gap", expected: 3, actual: 4 } }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    ),
  });
  await assert.rejects(
    () => gapTransport.pull(PEER, 0, 10),
    (err: unknown) => {
      assert.ok(err instanceof SyncError);
      assert.equal(err.code, "sync_gap");
      assert.equal((err.details as Record<string, unknown>).expected, 3);
      assert.equal((err.details as Record<string, unknown>).actual, 4);
      return true;
    },
  );

  const downTransport = new HttpSyncTransport({
    selfReplicaId: SELF,
    baseUrlForPeer: () => "http://peer.local",
    fetchImpl: stubFetch(() => {
      throw new Error("connection refused");
    }),
  });
  await assert.rejects(
    () => downTransport.push(PEER, [envelope(1)]),
    (err: unknown) => {
      assert.ok(err instanceof SyncError);
      assert.equal(err.code, "sync_transport_unavailable");
      return true;
    },
  );
});
