// 双副本同步契约测试（票 M3-T1 / Issue #30，AC-04 前置）：
// 两个真实 runtime 实例（独立临时 dataDir + 内存 SyncTransport，零网络）——
// 各离线写 50 条独立事件 → 重连双向拉取/推送 → 逐项对账（无丢失/无重复/顺序一致）；
// 另覆盖重复推幂等、缺口拒绝推进、integrity 拒绝、limit 截断。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope, SyncEnvelope, SyncStatus } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { SyncError } from "../src/sync/errors.ts";
import { InMemorySyncTransport } from "../src/sync/transport.ts";
import { makeEvent, removeDir, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
const OFFLINE_EVENT_TYPE = "test.offline";
const PER_REPLICA_COUNT = 50;

function testConfig(dir: string, replicaId: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId, provider: null };
}

/** 重连：两端共用一个 peer 表 + 各自的（发送方视角）内存传输 */
function reconnect(a: RuntimeHandle, b: RuntimeHandle): void {
  const peers = new Map([
    [REPLICA_A, a.sync],
    [REPLICA_B, b.sync],
  ]);
  a.sync.setTransport(new InMemorySyncTransport({ selfReplicaId: REPLICA_A, peers }));
  b.sync.setTransport(new InMemorySyncTransport({ selfReplicaId: REPLICA_B, peers }));
}

/** 离线写入 n 条合法事件（库形态；模拟断网期间本地继续工作） */
function writeOffline(runtime: RuntimeHandle, replicaId: string): EventEnvelope[] {
  const envelopes: EventEnvelope[] = [];
  for (let index = 0; index < PER_REPLICA_COUNT; index++) {
    const envelope = makeEvent({
      replica_id: replicaId,
      event_type: OFFLINE_EVENT_TYPE,
      payload: { origin: replicaId, index },
    });
    runtime.ledger.append(envelope);
    envelopes.push(envelope);
  }
  return envelopes;
}

function offlineEvents(runtime: RuntimeHandle): EventEnvelope[] {
  return runtime.ledger.scan({ eventType: OFFLINE_EVENT_TYPE }).map((entry) => entry.envelope);
}

function assertNoDuplicates(events: EventEnvelope[], label: string): void {
  const ids = new Set(events.map((event) => event.event_id));
  assert.equal(ids.size, events.length, `${label}: event_id 无重复`);
}

test("双副本各离线 50 条 → 重连双向同步 → 逐项对账（无丢失/无重复/顺序一致）", async () => {
  const dirA = tmpDir("morrow-sync-contract-a-");
  const dirB = tmpDir("morrow-sync-contract-b-");
  const a = await startRuntime(testConfig(dirA, REPLICA_A));
  const b = await startRuntime(testConfig(dirB, REPLICA_B));
  try {
    const writtenA = writeOffline(a, REPLICA_A);
    const writtenB = writeOffline(b, REPLICA_B);
    assert.equal(writtenA.length, 50);
    assert.equal(writtenB.length, 50);
    assert.equal(offlineEvents(a).length, 50, "同步前 A 只见自己的 50 条");
    assert.equal(offlineEvents(b).length, 50, "同步前 B 只见自己的 50 条");

    reconnect(a, b);

    // 断点续传：先限 10 条（截断），再拉剩余；随后反向拉取
    const firstPage = await a.sync.pullFromPeer(REPLICA_B, { limit: 10 });
    assert.equal(firstPage.envelopes.length, 10);
    assert.equal(firstPage.has_more, true, "B 账本（启动事件 + 50）多于 10 条");
    assert.equal(a.sync.status().cursors.find((c) => c.peer_replica_id === REPLICA_B)?.last_pulled_sequence, 10);

    const restPage = await a.sync.pullFromPeer(REPLICA_B);
    assert.equal(restPage.has_more, false);
    const bLedgerMax = b.ledger.sequenceRange().max ?? 0;
    assert.equal(
      a.sync.status().cursors.find((c) => c.peer_replica_id === REPLICA_B)?.last_pulled_sequence,
      bLedgerMax,
      "拉取游标推进到 B 账本末尾",
    );

    await b.sync.pullFromPeer(REPLICA_A, { limit: 1000 });
    const aLedgerMaxAtPull = a.ledger.sequenceRange().max ?? 0;
    assert.equal(
      b.sync.status().cursors.find((c) => c.peer_replica_id === REPLICA_A)?.last_pulled_sequence,
      aLedgerMaxAtPull,
      "反向拉取游标推进到 A 账本末尾",
    );

    // 逐项对账：两侧各有 100 条业务事件（50 自有 + 50 对端），无丢失、无重复
    const eventsA = offlineEvents(a);
    const eventsB = offlineEvents(b);
    assert.equal(eventsA.length, 100);
    assert.equal(eventsB.length, 100);
    assertNoDuplicates(eventsA, "A");
    assertNoDuplicates(eventsB, "B");
    assert.deepEqual(
      new Set(eventsA.map((event) => event.event_id)),
      new Set(eventsB.map((event) => event.event_id)),
      "event_id 集合一致",
    );
    const writtenIds = new Set([...writtenA, ...writtenB].map((event) => event.event_id));
    assert.deepEqual(
      new Set(eventsA.map((event) => event.event_id)),
      writtenIds,
      "A 无丢失（集合等于离线写入全集）",
    );
    assert.deepEqual(
      new Set(eventsB.map((event) => event.event_id)),
      writtenIds,
      "B 无丢失（集合等于离线写入全集）",
    );

    // 顺序一致：同一来源的事件在两侧账本中的相对顺序相同
    for (const origin of [REPLICA_A, REPLICA_B]) {
      const orderA = eventsA.filter((event) => event.replica_id === origin).map((event) => event.event_id);
      const orderB = eventsB.filter((event) => event.replica_id === origin).map((event) => event.event_id);
      assert.equal(orderA.length, 50);
      assert.deepEqual(orderA, orderB, `来源 ${origin} 的事件顺序在两侧一致`);
      const written = (origin === REPLICA_A ? writtenA : writtenB).map((event) => event.event_id);
      assert.deepEqual(orderA, written, `来源 ${origin} 的事件顺序与写入顺序一致`);
    }

    // 审计事件：A 有两次 sync.pulled（限批 + 剩余）；B 有一次 sync.pulled。
    // 全部是账本普通事件（append-only）。
    assert.equal(a.ledger.scan({ eventType: "sync.pulled" }).length, 2);
    const bOwnPulled = b.ledger
      .scan({ eventType: "sync.pulled" })
      .filter((entry) => (entry.envelope.payload as Record<string, unknown>).peer_replica_id === REPLICA_A);
    assert.equal(bOwnPulled.length, 1, "B 自己拉取 A 的审计（A 侧拉取审计随事件传播到 B）");

    // 审计事件会随账本传播，但只含 sync.* 元事件的导入不再滋生新审计——
    // 连续拉取最终收敛（无新事件）。
    let stableCount = a.ledger.count();
    for (let round = 0; round < 5; round++) {
      const before = a.ledger.count();
      await a.sync.pullFromPeer(REPLICA_B);
      if (a.ledger.count() === before) break;
      stableCount = a.ledger.count();
    }
    await a.sync.pullFromPeer(REPLICA_B);
    assert.equal(a.ledger.count(), stableCount, "审计事件传播收敛，不形成自增殖");

    // 重复推同一批幂等：B 全量推给 A（A 已拥有全部事件）→ accepted 0、无新业务事件
    const dataBefore = offlineEvents(a).length;
    const ledgerBefore = a.ledger.count();
    const receipt = await b.sync.pushToPeer(REPLICA_A, { limit: 1000 });
    assert.equal(receipt.accepted, 0);
    assert.ok(receipt.duplicates > 0, "对端已有全部事件，逐条计入 duplicates");
    assert.equal(offlineEvents(a).length, dataBefore, "重复推送不产生重复业务事件");
    assert.equal(a.ledger.count(), ledgerBefore + 1, "只追加一条 sync.pushed 审计");
    assert.ok(a.ledger.scan({ eventType: "sync.pushed" }).length >= 1);
    const cursorBOnA = a.sync
      .status()
      .cursors.find((cursor) => cursor.peer_replica_id === REPLICA_B);
    assert.equal(cursorBOnA?.last_pulled_sequence, b.ledger.sequenceRange().max);

    // 再推一次：游标已到对端末尾，无新事件可发
    const again = await b.sync.pushToPeer(REPLICA_A);
    assert.deepEqual(again, { accepted: 0, duplicates: 0, next_seq: b.ledger.sequenceRange().max });

    // 缺口：伪造带洞的新 sequence → sync_gap，游标不推进、事件不落库
    const ackedBefore = a.sync
      .status()
      .cursors.find((cursor) => cursor.peer_replica_id === REPLICA_B)?.last_pulled_sequence;
    const nextExpected = (ackedBefore ?? 0) + 1;
    const beforeCount = a.ledger.count();
    const gapBatch: SyncEnvelope[] = [
      { source_replica_id: REPLICA_B, sequence: nextExpected + 1, envelope: makeEvent({ replica_id: REPLICA_B, event_type: OFFLINE_EVENT_TYPE, payload: { gap: 1 } }) },
      { source_replica_id: REPLICA_B, sequence: nextExpected + 2, envelope: makeEvent({ replica_id: REPLICA_B, event_type: OFFLINE_EVENT_TYPE, payload: { gap: 2 } }) },
    ];
    assert.throws(
      () => a.sync.receivePush(REPLICA_B, gapBatch),
      (err: unknown) => {
        assert.ok(err instanceof SyncError);
        assert.equal(err.code, "sync_gap");
        assert.equal((err.details as Record<string, unknown>).expected, nextExpected);
        assert.equal((err.details as Record<string, unknown>).actual, nextExpected + 1);
        return true;
      },
    );
    assert.equal(a.ledger.count(), beforeCount + 1, "只追加一条 sync.gap_detected 审计");
    assert.equal(
      a.sync.status().cursors.find((cursor) => cursor.peer_replica_id === REPLICA_B)?.last_pulled_sequence,
      ackedBefore,
      "缺口时游标不推进",
    );

    // integrity：篡改既有批中的一个信封（hash 不再匹配）→ 整批拒绝，游标不动
    const tamperSource = b.sync.exportBatch(0, 3).envelopes.map((item) => structuredClone(item));
    tamperSource[1].envelope.payload = { tampered: true };
    const cursorBeforeTamper = a.sync
      .status()
      .cursors.find((cursor) => cursor.peer_replica_id === REPLICA_B)?.last_pulled_sequence;
    assert.throws(
      () => a.sync.receivePush(REPLICA_B, tamperSource),
      (err: unknown) => {
        assert.ok(err instanceof SyncError);
        assert.equal(err.code, "sync_integrity_mismatch");
        return true;
      },
    );
    assert.equal(
      a.sync.status().cursors.find((cursor) => cursor.peer_replica_id === REPLICA_B)?.last_pulled_sequence,
      cursorBeforeTamper,
      "integrity 失败不推进游标",
    );
  } finally {
    await a.close();
    await b.close();
    removeDir(dirA);
    removeDir(dirB);
  }
});

test("游标与账本跨重启保持（sync_cursors 迁移幂等，重复打开不丢进度）", async () => {
  const dirA = tmpDir("morrow-sync-restart-a-");
  const dirB = tmpDir("morrow-sync-restart-b-");
  const a = await startRuntime(testConfig(dirA, REPLICA_A));
  const b = await startRuntime(testConfig(dirB, REPLICA_B));
  try {
    writeOffline(b, REPLICA_B);
    reconnect(a, b);
    await a.sync.pullFromPeer(REPLICA_B);
    const cursorBefore = a.sync.status().cursors.find((cursor) => cursor.peer_replica_id === REPLICA_B);
    assert.ok(cursorBefore);
    assert.ok(cursorBefore.last_pulled_sequence > 0);
  } finally {
    await a.close();
    await b.close();
  }

  const reopened = await startRuntime(testConfig(dirA, REPLICA_A));
  try {
    const status: SyncStatus = reopened.sync.status();
    const cursor = status.cursors.find((row) => row.peer_replica_id === REPLICA_B);
    assert.ok(cursor, "重启后游标仍在");
    assert.ok(cursor.last_pulled_sequence > 0, "拉取进度未丢失");
  } finally {
    await reopened.close();
    removeDir(dirA);
    removeDir(dirB);
  }
});
