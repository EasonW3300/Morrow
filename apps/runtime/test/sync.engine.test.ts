// 同步引擎 seam 测试（票 M3-T1 / Issue #30，PRD §4.6 FR-DEP-3）：
// SyncEngine 的导出/导入、event_id 幂等、integrity_hash 复算、sequence 缺口拒绝、
// 游标推进与同步审计事件。传输用内存实现（零网络）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { computeIntegrityHash, type EventEnvelope } from "@morrow/protocol";
import { openSqlite } from "../src/db.ts";
import { EventLedger, DB_FILE_NAME } from "../src/ledger.ts";
import { SyncCursorStore } from "../src/sync/cursors.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { SyncError } from "../src/sync/errors.ts";
import { ensureSyncTables } from "../src/sync/migrations.ts";
import { InMemorySyncTransport } from "../src/sync/transport.ts";
import { makeEvent, removeDir, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

interface ReplicaFixture {
  dir: string;
  ledger: EventLedger;
  cursors: SyncCursorStore;
  engine: SyncEngine;
}

function openReplica(replicaId: string): ReplicaFixture {
  const dir = tmpDir("morrow-sync-");
  const ledger = EventLedger.open(dir);
  const cursors = SyncCursorStore.open(dir);
  return { dir, ledger, cursors, engine: new SyncEngine({ ledger, replicaId, cursors }) };
}

function dataEvents(fixture: ReplicaFixture): number {
  return fixture.ledger.scan({ eventType: "test.sync_offline" }).length;
}

function closeReplica(fixture: ReplicaFixture): void {
  fixture.cursors.close();
  fixture.ledger.close();
  removeDir(fixture.dir);
}

/** 写 n 条合法事件（event_id 全局唯一；replica_id 是本地副本） */
function writeEvents(fixture: ReplicaFixture, replicaId: string, n: number, prefix: string): EventEnvelope[] {
  const envelopes: EventEnvelope[] = [];
  for (let i = 0; i < n; i++) {
    const envelope = makeEvent({
      replica_id: replicaId,
      event_type: "test.sync_offline",
      payload: { prefix, index: i },
    });
    fixture.ledger.append(envelope);
    envelopes.push(envelope);
  }
  return envelopes;
}

/** 为一个引擎组挂上共享 peer 表的内存传输（模拟两个副本重连） */
function connect(peers: ReplicaFixture[]): void {
  const engines = new Map(peers.map((peer) => [peer.engine.replicaId, peer.engine]));
  for (const peer of peers) {
    peer.engine.setTransport(
      new InMemorySyncTransport({ selfReplicaId: peer.engine.replicaId, peers: engines }),
    );
  }
}

test("exportBatch 按账本 sequence 升序返回信封原文 + source_replica_id，limit 截断置 has_more", () => {
  const a = openReplica(REPLICA_A);
  try {
    writeEvents(a, REPLICA_A, 5, "a");
    const first = a.engine.exportBatch(0, 2);
    assert.equal(first.envelopes.length, 2);
    assert.equal(first.envelopes[0].sequence, 1);
    assert.equal(first.envelopes[1].sequence, 2);
    assert.equal(first.envelopes[0].source_replica_id, REPLICA_A);
    assert.deepEqual(first.envelopes[0].envelope, a.ledger.list({ limit: 1 }).events[0]);
    assert.equal(first.next_seq, 2);
    assert.equal(first.has_more, true);

    const second = a.engine.exportBatch(first.next_seq, 2);
    assert.deepEqual(second.envelopes.map((e) => e.sequence), [3, 4]);
    assert.equal(second.has_more, true);

    const last = a.engine.exportBatch(second.next_seq, 2);
    assert.deepEqual(last.envelopes.map((e) => e.sequence), [5]);
    assert.equal(last.has_more, false);
    assert.equal(last.next_seq, 5);

    const empty = a.engine.exportBatch(5, 100);
    assert.deepEqual(empty.envelopes, []);
    assert.equal(empty.next_seq, 5);
    assert.equal(empty.has_more, false);
  } finally {
    closeReplica(a);
  }
});

test("receivePush 导入事件并按 event_id 幂等：同批重推无副作用，游标只前进不后退", () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    connect([a, b]);
    writeEvents(a, REPLICA_A, 3, "a");
    // b 尚未写入，先让 a 导出一批推给 b
    const fromA = a.engine.exportBatch(0, 100);
    assert.equal(fromA.envelopes.length, 3);

    const first = b.engine.receivePush(REPLICA_A, fromA.envelopes);
    assert.equal(first.accepted, 3);
    assert.equal(first.duplicates, 0);
    assert.equal(first.next_seq, 3);
    assert.equal(dataEvents(b), 3, "全部导入");
    assert.equal(b.cursors.getOrZero(REPLICA_A).last_pulled_sequence, 3);

    const countBefore = b.ledger.count();
    const second = b.engine.receivePush(REPLICA_A, fromA.envelopes);
    assert.equal(second.accepted, 0);
    assert.equal(second.duplicates, 3);
    assert.equal(second.next_seq, 3);
    assert.equal(dataEvents(b), 3, "重复导入不产生新数据事件");
    assert.equal(b.ledger.count(), countBefore + 1, "只追加一条审计事件");
    assert.equal(b.cursors.getOrZero(REPLICA_A).last_pulled_sequence, 3, "游标不后退也不虚增");

    const pushed = b.ledger.scan({ eventType: "sync.pushed" });
    assert.equal(pushed.length, 2, "每次导入动作都留审计（含全重复批）");
    const firstPush = pushed[0].envelope.payload as Record<string, unknown>;
    assert.equal(firstPush.peer_replica_id, REPLICA_A);
    assert.equal(firstPush.accepted, 3);
    assert.equal(firstPush.duplicates, 0);
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("receivePush 批内 sequence 不连续 → sync_gap（expected/actual），不导入任何事件、不推进游标", () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    connect([a, b]);
    writeEvents(a, REPLICA_A, 5, "a");
    const batch = a.engine.exportBatch(0, 100).envelopes;
    const gapped = [batch[0], batch[1], batch[3]]; // 缺 seq 3

    assert.throws(
      () => b.engine.receivePush(REPLICA_A, gapped),
      (err: unknown) => {
        assert.ok(err instanceof SyncError);
        assert.equal(err.code, "sync_gap");
        const details = err.details as Record<string, unknown>;
        assert.equal(details.expected, 3);
        assert.equal(details.actual, 4);
        return true;
      },
    );
    assert.equal(dataEvents(b), 0, "整批预校验失败，不落任何事件");
    assert.equal(b.cursors.getOrZero(REPLICA_A).last_pulled_sequence, 0, "游标不推进");

    const gaps = b.ledger.scan({ eventType: "sync.gap_detected" });
    assert.equal(gaps.length, 1);
    assert.equal((gaps[0].envelope.payload as Record<string, unknown>).expected, 3);
    assert.equal((gaps[0].envelope.payload as Record<string, unknown>).actual, 4);
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("receivePush 起始 sequence 与游标不衔接 → sync_gap；游标已有值时不接受跳跃", () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    connect([a, b]);
    writeEvents(a, REPLICA_A, 5, "a");
    const batch = a.engine.exportBatch(0, 100).envelopes;

    b.engine.receivePush(REPLICA_A, batch.slice(0, 2)); // 游标 = 2
    assert.equal(b.cursors.getOrZero(REPLICA_A).last_pulled_sequence, 2);

    assert.throws(
      () => b.engine.receivePush(REPLICA_A, [batch[3], batch[4]]), // 从 4 开始，缺 3
      (err: unknown) => {
        assert.ok(err instanceof SyncError);
        assert.equal(err.code, "sync_gap");
        assert.equal((err.details as Record<string, unknown>).expected, 3);
        assert.equal((err.details as Record<string, unknown>).actual, 4);
        return true;
      },
    );
    assert.equal(b.cursors.getOrZero(REPLICA_A).last_pulled_sequence, 2);
    assert.equal(dataEvents(b), 2);
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("receivePush 完整 integrity_hash 不符 → 拒绝整批，已合法的前置事件也不导入、游标不动", () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    connect([a, b]);
    writeEvents(a, REPLICA_A, 3, "a");
    const batch = a.engine.exportBatch(0, 100).envelopes;
    const tampered = structuredClone(batch[1].envelope);
    tampered.payload = { tampered: true }; // hash 仍是旧内容

    assert.throws(
      () => b.engine.receivePush(REPLICA_A, [batch[0], { ...batch[1], envelope: tampered }, batch[2]]),
      (err: unknown) => {
        assert.ok(err instanceof SyncError);
        assert.equal(err.code, "sync_integrity_mismatch");
        assert.equal((err.details as Record<string, unknown>).event_id, tampered.event_id);
        return true;
      },
    );
    assert.equal(dataEvents(b), 0, "整批拒绝：合法的前置事件也不落库");
    assert.equal(b.cursors.getOrZero(REPLICA_A).last_pulled_sequence, 0);
    assert.equal(b.ledger.scan({ eventType: "sync.gap_detected" }).length, 0, "integrity 失败不是 gap");
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("pullFromPeer 经内存传输增量导入并推进 last_pulled_sequence、落 sync.pulled 审计", async () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    connect([a, b]);
    writeEvents(b, REPLICA_B, 4, "b");

    const batch = await a.engine.pullFromPeer(REPLICA_B, { limit: 3 });
    assert.equal(batch.envelopes.length, 3);
    assert.equal(batch.has_more, true);
    assert.equal(batch.next_seq, 3);
    assert.equal(dataEvents(a), 3, "只导入首批");
    assert.equal(a.cursors.getOrZero(REPLICA_B).last_pulled_sequence, 3);

    const rest = await a.engine.pullFromPeer(REPLICA_B);
    assert.equal(rest.envelopes.length, 1);
    assert.equal(rest.has_more, false);
    assert.equal(rest.next_seq, 4);
    assert.equal(a.cursors.getOrZero(REPLICA_B).last_pulled_sequence, 4);
    assert.equal(dataEvents(a), 4);

    const pulled = a.ledger.scan({ eventType: "sync.pulled" });
    assert.equal(pulled.length, 2, "每次拉取动作都留审计");
    const latest = pulled.at(-1)!.envelope.payload as Record<string, unknown>;
    assert.equal(latest.peer_replica_id, REPLICA_B);
    assert.equal(latest.accepted, 1);
    assert.equal(latest.next_seq, 4);

    // 再拉无新事件：不导入、游标不动
    const none = await a.engine.pullFromPeer(REPLICA_B);
    assert.deepEqual(none.envelopes, []);
    assert.equal(a.cursors.getOrZero(REPLICA_B).last_pulled_sequence, 4);
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("pushToPeer 从 last_acked_sequence 增量推送，对端导入并推进两侧游标", async () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    connect([a, b]);
    writeEvents(a, REPLICA_A, 3, "a");

    const first = await a.engine.pushToPeer(REPLICA_B);
    assert.equal(first.accepted, 3);
    assert.equal(first.duplicates, 0);
    assert.equal(first.next_seq, 3);
    assert.equal(dataEvents(b), 3);
    assert.equal(a.cursors.getOrZero(REPLICA_B).last_acked_sequence, 3, "发送侧记住已 ack 的自身 sequence");
    assert.equal(b.cursors.getOrZero(REPLICA_A).last_pulled_sequence, 3, "接收侧 ack 到来源 sequence");

    const second = await a.engine.pushToPeer(REPLICA_B);
    assert.equal(second.accepted, 0);
    assert.equal(second.duplicates, 0, "无新事件时不发送");
    assert.equal(second.next_seq, 3);
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("A push 到 B 后 B 反向 push：从 B 自己账本最早的未确认处起，B 推送前的旧事件全部到达 A", async () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    connect([a, b]);
    // B 在收到 A 的 push **之前**已有自己的本地事件（旧事件）。
    writeEvents(b, REPLICA_B, 2, "b-old");
    const bLocalBefore = b.ledger.count();

    writeEvents(a, REPLICA_A, 3, "a");
    const pushedToB = await a.engine.pushToPeer(REPLICA_B);
    assert.equal(pushedToB.accepted, 3);

    // 收到 push 后：B 的 inbound 游标记录 A 的 sequence；outbound 游标仍是 0
    // （旧实现把二者混在同一列，反向推送会从 3 起跳，跳过 B 的 1..2）。
    const cursorAfterReceive = b.cursors.getOrZero(REPLICA_A);
    assert.equal(cursorAfterReceive.last_pulled_sequence, 3, "inbound 记录已拉到 A 的 sequence");
    assert.equal(cursorAfterReceive.last_acked_sequence, 0, "outbound 不被收到的 push 污染");

    const reverse = await b.engine.pushToPeer(REPLICA_A);
    assert.ok(reverse.accepted >= bLocalBefore, "B 收到 A 的 push 前的旧事件也全部推送");
    // 反向批次也携带 B 刚导入的 A 事件（回显），A 按 event_id 幂等去重。
    assert.equal(reverse.duplicates, 3, "A 的 3 条事件回显为重复");
    const bEventsOnA = a.ledger
      .scan({ eventType: "test.sync_offline" })
      .filter((entry) => entry.envelope.replica_id === REPLICA_B);
    assert.equal(bEventsOnA.length, bLocalBefore, "A 收到了 B 的全部业务事件");
    assert.deepEqual(
      bEventsOnA.map((entry) => entry.envelope.payload.index),
      [0, 1],
      "B 的两条旧事件按原顺序到达 A",
    );
    assert.equal(
      b.cursors.getOrZero(REPLICA_A).last_acked_sequence,
      b.ledger.sequenceRange().max,
      "outbound 推进到本地账本最大 sequence（含导入事件）",
    );
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("status 返回本副本 sequence 范围与各 peer 游标", async () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    connect([a, b]);
    writeEvents(a, REPLICA_A, 2, "a");
    writeEvents(b, REPLICA_B, 1, "b");
    await a.engine.pullFromPeer(REPLICA_B);

    const status = a.engine.status();
    assert.equal(status.replica_id, REPLICA_A);
    // 2 自有 + 1 导入 + 1 sync.pulled 审计
    assert.equal(status.sequence.count, 4);
    assert.equal(status.sequence.min, 1);
    assert.equal(status.sequence.max, 4);
    const cursor = status.cursors.find((row) => row.peer_replica_id === REPLICA_B);
    assert.ok(cursor);
    assert.equal(cursor.last_pulled_sequence, 1);
    assert.equal(cursor.last_acked_sequence, 0);
    assert.match(cursor.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("同步审计事件自身的 integrity_hash 合法（经账本 schema 校验）", () => {
  const a = openReplica(REPLICA_A);
  try {
    writeEvents(a, REPLICA_A, 1, "a");
    const report = a.ledger.verifyIntegrity();
    assert.equal(report.ok, true);
    for (const entry of a.ledger.scan()) {
      assert.equal(entry.envelope.integrity_hash, computeIntegrityHash(entry.envelope));
    }
  } finally {
    closeReplica(a);
  }
});

test("sync_cursors 迁移幂等：旧表缺列经 ensureSyncTables 补齐，重复调用无副作用", () => {
  const dir = tmpDir("morrow-sync-migration-");
  const db = openSqlite(join(dir, DB_FILE_NAME));
  try {
    // 模拟最早版本的表形态（只有 peer 主键），迁移应补齐游标列、updated_at 与
    // M3 修复批新增的 last_synced_at
    db.exec("CREATE TABLE sync_cursors (peer_replica_id TEXT PRIMARY KEY)");
    ensureSyncTables(db);
    ensureSyncTables(db);
    const columns = (db.prepare("SELECT name FROM pragma_table_info('sync_cursors')").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    assert.deepEqual(columns.sort(), [
      "last_acked_local_sequence",
      "last_acked_sequence",
      "last_pulled_remote_sequence",
      "last_pulled_sequence",
      "last_synced_at",
      "peer_replica_id",
      "updated_at",
    ]);
    // 迁移后可正常写入/读取游标（默认值 0）
    db.prepare(
      "INSERT INTO sync_cursors (peer_replica_id, last_pulled_remote_sequence, last_acked_local_sequence, updated_at) VALUES (?, 0, 0, ?)",
    ).run(REPLICA_B, new Date().toISOString());
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sync_cursors").get() as { n: number }).n, 1);
  } finally {
    db.close();
    removeDir(dir);
  }
});
