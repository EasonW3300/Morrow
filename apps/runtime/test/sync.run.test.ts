// 立即同步端点与同步状态真实值（M3 修复批 / Issue #35，缺口来源 #35 / 归属 #30）：
//   - GET /v1/sync/status 的 peers[].pending_upload / pending_download / last_synced_at、
//     顶层 last_sync_at，以及 devices.last_sync_at 的写入（不再是死字段）；
//   - POST /v1/sync/run 双实例真 HTTP 回环双向收敛、单 peer 失败隔离、sync.run_completed 审计；
//   - 对端不可达时 pending_download 为 null + unreachable=true（不伪造 0）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceInfo, SyncRunReport, SyncStatus } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { HttpSyncTransport } from "../src/sync/http-transport.ts";
import { generateDeviceKeyPair, hashToken } from "../src/pairing/crypto.ts";
import { json, makeEvent, removeDir, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
const REPLICA_C = "0f8e7d6c-5b4a-4392-8170-6d5c4b3a2918";

function testConfig(dir: string, replicaId: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId, provider: null };
}

function url(runtime: RuntimeHandle, path: string): string {
  return `http://127.0.0.1:${runtime.port}${path}`;
}

/** 把 peer 记为本机已信任设备（同步 run 的「已配对 peer」来源） */
function trustPeer(runtime: RuntimeHandle, peerReplicaId: string, label = "Peer"): void {
  const key = generateDeviceKeyPair();
  runtime.devices.markPaired({
    replicaId: peerReplicaId,
    label,
    publicKey: key.publicKey,
    fingerprint: key.fingerprint,
    tokenHash: hashToken(`mrw_test_${peerReplicaId}`),
    now: new Date(),
  });
}

/** 双实例 + 真 HTTP 回环传输（base 表可后填：先起服务再互相指路） */
async function bootPair(): Promise<{
  a: RuntimeHandle;
  b: RuntimeHandle;
  bases: Map<string, string>;
  dirs: string[];
}> {
  const bases = new Map<string, string>();
  const transport = (self: string) =>
    new HttpSyncTransport({
      selfReplicaId: self,
      baseUrlForPeer: (peerId) => bases.get(peerId) ?? "http://127.0.0.1:1",
    });
  const dirA = tmpDir("morrow-sync-run-a-");
  const dirB = tmpDir("morrow-sync-run-b-");
  const a = await startRuntime(testConfig(dirA, REPLICA_A), { syncTransport: transport(REPLICA_A) });
  let b: RuntimeHandle;
  try {
    b = await startRuntime(testConfig(dirB, REPLICA_B), { syncTransport: transport(REPLICA_B) });
  } catch (err) {
    await a.close();
    throw err;
  }
  bases.set(REPLICA_A, `http://127.0.0.1:${a.port}`);
  bases.set(REPLICA_B, `http://127.0.0.1:${b.port}`);
  return { a, b, bases, dirs: [dirA, dirB] };
}

async function closePair(pair: { a: RuntimeHandle; b: RuntimeHandle }, dirs: string[]): Promise<void> {
  await pair.b.close();
  await pair.a.close();
  for (const dir of dirs) removeDir(dir);
}

function writeEvents(runtime: RuntimeHandle, replicaId: string, count: number, tag: string): void {
  for (let index = 0; index < count; index++) {
    runtime.ledger.append(
      makeEvent({ replica_id: replicaId, event_type: "test.sync_run", payload: { tag, index } }),
    );
  }
}

async function status(runtime: RuntimeHandle): Promise<SyncStatus> {
  const res = await fetch(url(runtime, "/v1/sync/status"));
  assert.equal(res.status, 200);
  return json<SyncStatus>(res);
}

async function runSync(runtime: RuntimeHandle, body?: unknown): Promise<SyncRunReport> {
  const res = await fetch(url(runtime, "/v1/sync/run"), {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  assert.equal(res.status, 200);
  return json<SyncRunReport>(res);
}

test("POST /v1/sync/run 双向收敛；status pending_upload/pending_download/last_sync_at 与 devices.last_sync_at 同步前后真实变化", async () => {
  const pair = await bootPair();
  try {
    trustPeer(pair.a, REPLICA_B, "B");
    trustPeer(pair.b, REPLICA_A, "A");
    writeEvents(pair.a, REPLICA_A, 2, "a");
    writeEvents(pair.b, REPLICA_B, 3, "b");

    const aMaxBefore = pair.a.ledger.sequenceRange().max ?? 0;
    const bMaxBefore = pair.b.ledger.sequenceRange().max ?? 0;

    // 同步前：对端可达 → pending_download 是真实值，而不是 null/0
    const before = await status(pair.a);
    const peerBefore = before.peers.find((peer) => peer.peer_replica_id === REPLICA_B);
    assert.ok(peerBefore);
    assert.equal(peerBefore.pending_upload, aMaxBefore, "本地 max − last_acked(0)");
    assert.equal(peerBefore.pending_download, bMaxBefore, "对端 max − last_pulled(0)");
    assert.equal(peerBefore.unreachable, false);
    assert.equal(peerBefore.remote_max_sequence, bMaxBefore);
    assert.equal(peerBefore.last_synced_at, null);
    assert.equal(before.last_sync_at, null);
    assert.equal(
      pair.a.devices.list().find((device) => device.replica_id === REPLICA_B)?.last_sync_at,
      null,
      "同步前设备最后同步为从未",
    );

    const first = await runSync(pair.a);
    assert.equal(first.requested_peer_replica_id, null);
    assert.equal(first.totals.peers, 1, "A 只认识已配对的 B");
    assert.equal(first.totals.failed, 0);
    const peerRun = first.peers[0];
    assert.equal(peerRun.peer_replica_id, REPLICA_B);
    assert.equal(peerRun.ok, true);
    assert.deepEqual(peerRun.errors, []);
    assert.equal(peerRun.gaps, 0);
    assert.ok(peerRun.pulled > 0, "从 B 拉到了事件");
    assert.ok(peerRun.pushed > 0, "把本机事件推给了 B");

    // 双向收敛：两端 test.sync_run 事件一致
    assert.equal(pair.a.ledger.scan({ eventType: "test.sync_run" }).length, 5);
    assert.equal(pair.b.ledger.scan({ eventType: "test.sync_run" }).length, 5);

    // 审计事件
    const audits = pair.a.ledger.scan({ eventType: "sync.run_completed" });
    assert.equal(audits.length, 1);
    const auditPayload = audits[0].envelope.payload as Record<string, unknown>;
    assert.equal(auditPayload.peers, 1);
    assert.equal(auditPayload.failed, 0);
    assert.equal(auditPayload.requested_peer_replica_id, null);

    // 同步后：pending_download 归零；last_synced_at/last_sync_at 有值；设备 last_sync_at 被写入
    const after = await status(pair.a);
    const peerAfter = after.peers.find((peer) => peer.peer_replica_id === REPLICA_B);
    assert.ok(peerAfter);
    assert.equal(peerAfter.pending_download, 0, "已拉取到 B 的账本上界");
    assert.notEqual(peerAfter.last_synced_at, null);
    assert.notEqual(after.last_sync_at, null);
    const deviceB = pair.a.devices
      .list()
      .find((device: DeviceInfo) => device.replica_id === REPLICA_B);
    assert.notEqual(deviceB?.last_sync_at, null, "devices.last_sync_at 不再是死字段");
    assert.equal(deviceB?.last_sync_at, peerAfter.last_synced_at);

    // 末尾 pull 会带入对端在 push 期间追加的审计事件，run 结束还要落 sync.run_completed
    // 审计——pending_upload 的残量必须只由这些 sync.* 元事件组成（不能残留业务事件）。
    const unacked = pair.a.ledger.scan().filter((entry) => entry.sequence > peerAfter.last_acked_sequence);
    assert.equal(peerAfter.pending_upload, unacked.length, "pending_upload = 本地 max − last_acked");
    assert.ok(
      unacked.every((entry) => entry.envelope.event_type.startsWith("sync.")),
      `未确认的事件只能是审计残量，实际：${unacked.map((entry) => entry.envelope.event_type).join(",")}`,
    );
    assert.ok(peerAfter.pending_upload <= 5, `只剩审计残量，实际 ${peerAfter.pending_upload}`);

    await runSync(pair.a);
    const settled = await status(pair.a);
    const peerSettled = settled.peers.find((peer) => peer.peer_replica_id === REPLICA_B);
    assert.ok(peerSettled);
    assert.equal(peerSettled.pending_download, 0);
    const unackedAfter = pair.a.ledger.scan().filter((entry) => entry.sequence > peerSettled.last_acked_sequence);
    assert.equal(peerSettled.pending_upload, unackedAfter.length);
    assert.ok(
      unackedAfter.every((entry) => entry.envelope.event_type.startsWith("sync.")),
      "第二轮仍未确认的也只能是审计事件",
    );
  } finally {
    await closePair(pair, pair.dirs);
  }
});

test("GET /v1/sync/status pending 口径：pushToPeer 后 pending_upload=0，pullFromPeer 后 pending_download=0", async () => {
  const pair = await bootPair();
  try {
    trustPeer(pair.a, REPLICA_B, "B");
    writeEvents(pair.a, REPLICA_A, 2, "a");
    writeEvents(pair.b, REPLICA_B, 3, "b");

    const pushed = await pair.a.sync.pushToPeer(REPLICA_B);
    assert.ok(pushed.accepted > 0);
    const afterPush = await status(pair.a);
    const peerAfterPush = afterPush.peers.find((peer) => peer.peer_replica_id === REPLICA_B);
    assert.ok(peerAfterPush);
    assert.equal(peerAfterPush.pending_upload, 0, "已确认到本地账本上界");
    assert.equal(peerAfterPush.pending_download, pair.b.ledger.sequenceRange().max, "尚未拉取对端任何事件");
    assert.notEqual(peerAfterPush.last_synced_at, null);

    await pair.a.sync.pullFromPeer(REPLICA_B);
    const afterPull = await status(pair.a);
    const peerAfterPull = afterPull.peers.find((peer) => peer.peer_replica_id === REPLICA_B);
    assert.ok(peerAfterPull);
    assert.equal(peerAfterPull.pending_download, 0, "已拉取到对端账本上界");
    assert.equal(
      peerAfterPull.pending_upload,
      (afterPull.sequence.max ?? 0) - peerAfterPull.last_acked_sequence,
      "拉取带来的本地新事件在推送前仍计入待上传",
    );
  } finally {
    await closePair(pair, pair.dirs);
  }
});

test("POST /v1/sync/run 单 peer 失败隔离：不可达 peer 记录错误，其他 peer 照常收敛", async () => {
  const pair = await bootPair();
  try {
    trustPeer(pair.a, REPLICA_B, "B");
    trustPeer(pair.a, REPLICA_C, "C"); // bases 里没有 C → 连接 127.0.0.1:1 失败
    writeEvents(pair.a, REPLICA_A, 1, "a");
    writeEvents(pair.b, REPLICA_B, 2, "b");

    const report = await runSync(pair.a);
    assert.equal(report.totals.peers, 2);
    assert.equal(report.totals.ok, 1);
    assert.equal(report.totals.failed, 1);

    const ok = report.peers.find((peer) => peer.peer_replica_id === REPLICA_B);
    const failed = report.peers.find((peer) => peer.peer_replica_id === REPLICA_C);
    assert.ok(ok);
    assert.ok(failed);
    assert.equal(ok.ok, true);
    assert.equal(failed.ok, false);
    assert.equal(failed.errors.length > 0, true, "失败 peer 必须携带可读错误");
    assert.ok(
      failed.errors.some((error) => /unreachable|connection|ECONN|fetch failed/i.test(error)),
      `错误应说明不可达：${failed.errors.join(" | ")}`,
    );

    // 成功的那一侧不受影响
    assert.equal(pair.a.ledger.scan({ eventType: "test.sync_run" }).length, 3);
    assert.equal(pair.b.ledger.scan({ eventType: "test.sync_run" }).length, 3);

    // 汇总审计落在发起方账本
    const audit = pair.a.ledger.scan({ eventType: "sync.run_completed" });
    assert.equal(audit.length, 1);
    const payload = audit[0].envelope.payload as Record<string, unknown>;
    assert.equal(payload.failed, 1);
    assert.equal(payload.ok, 1);
    assert.ok(Array.isArray(payload.errors) && payload.errors.length > 0);

    // 指定单个 peer 时只跑它（失败也只影响它自己）
    const onlyB = await runSync(pair.a, { peer_replica_id: REPLICA_B });
    assert.equal(onlyB.requested_peer_replica_id, REPLICA_B);
    assert.equal(onlyB.peers.length, 1);

    const badBody = await fetch(url(pair.a, "/v1/sync/run"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer_replica_id: "not-a-uuid" }),
    });
    assert.equal(badBody.status, 400);
  } finally {
    await closePair(pair, pair.dirs);
  }
});

test("GET /v1/sync/status：未配置传输时 pending_download=null + unreachable=true（不伪造 0）", async () => {
  const dir = tmpDir("morrow-sync-status-");
  const runtime = await startRuntime(testConfig(dir, REPLICA_A));
  try {
    trustPeer(runtime, REPLICA_B, "B");
    writeEvents(runtime, REPLICA_A, 2, "a");
    const localMax = runtime.ledger.sequenceRange().max ?? 0;

    const body = await status(runtime);
    const peer = body.peers.find((entry) => entry.peer_replica_id === REPLICA_B);
    assert.ok(peer);
    assert.equal(peer.pending_upload, localMax);
    assert.equal(peer.pending_download, null);
    assert.equal(peer.unreachable, true);
    assert.equal(peer.remote_max_sequence, null);
    assert.equal(peer.last_synced_at, null);
    assert.equal(body.last_sync_at, null);

    // ?probe=local：只回本地快照（传输层探测用），不标记 unreachable
    const localOnly = await json<SyncStatus>(await fetch(url(runtime, "/v1/sync/status?probe=local")));
    const localPeer = localOnly.peers.find((entry) => entry.peer_replica_id === REPLICA_B);
    assert.ok(localPeer);
    assert.equal(localPeer.pending_download, null);
    assert.equal(localPeer.unreachable, false);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
