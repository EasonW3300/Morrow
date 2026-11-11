// 跨副本 fencing token 单调（M3 code-review A1；FR-DEP-4）：
// 两个**独立** dataDir/账本/租约表 + 事件同步（不是共用 store）——A 持 token=1，
// 转移事件声明 next=2；B 同步后 acquire 必须得到 2；B.validate(1)=false；
// A 侧旧 token=1 即使本地租约行仍看似有效，也被观察到的预留 token 否定。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { LeaseStore } from "../src/lease/store.ts";
import { replayLeaseView } from "../src/lease/view.ts";
import { SyncCursorStore } from "../src/sync/cursors.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { InMemorySyncTransport } from "../src/sync/transport.ts";
import { makeEvent, removeDir, tmpDir } from "./helpers.ts";

const TASK = "01936b9d-8f7a-7abc-9f2e-0000000000f1";
const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
const TTL = 60_000;

interface Replica {
  dir: string;
  ledger: EventLedger;
  cursors: SyncCursorStore;
  engine: SyncEngine;
  leases: LeaseStore;
}

function openReplica(replicaId: string): Replica {
  const dir = tmpDir("morrow-fencing-");
  const ledger = EventLedger.open(dir);
  const cursors = SyncCursorStore.open(dir);
  const engine = new SyncEngine({ ledger, replicaId, cursors });
  const leases = new LeaseStore({ dataDir: dir });
  return { dir, ledger, cursors, engine, leases };
}

function closeReplica(replica: Replica): void {
  replica.leases.close();
  replica.cursors.close();
  replica.ledger.close();
  removeDir(replica.dir);
}

function leaseEvent(
  replicaId: string,
  eventType: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return makeEvent({ replica_id: replicaId, event_type: eventType, task_id: TASK, payload });
}

/** 把账本事件从 A 同步到 B（独立 store；走真实 SyncEngine + 内存传输） */
async function syncAToB(a: Replica, b: Replica): Promise<void> {
  const peers = new Map([
    [REPLICA_A, a.engine],
    [REPLICA_B, b.engine],
  ]);
  a.engine.setTransport(new InMemorySyncTransport({ selfReplicaId: REPLICA_A, peers }));
  b.engine.setTransport(new InMemorySyncTransport({ selfReplicaId: REPLICA_B, peers }));
  for (let page = 0; page < 10; page++) {
    const batch = await b.engine.pullFromPeer(REPLICA_A);
    if (!batch.has_more) return;
  }
}

test("A token=1 → 转移声明 next=2 → 同步到 B：B acquire=2，B.validate(1)=false，A 旧 token=1 被拒", async () => {
  const a = openReplica(REPLICA_A);
  const b = openReplica(REPLICA_B);
  try {
    const granted = a.leases.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in granted);
    assert.equal(granted.token, 1);

    a.ledger.append(
      leaseEvent(REPLICA_A, "task.lease_acquired", {
        replica_id: REPLICA_A,
        holder_replica_id: REPLICA_A,
        fencing_token: 1,
        expires_at: granted.expires_at,
        acquired_at: granted.acquired_at,
      }),
    );
    // 模拟「转移已宣告但旧进程尚未停止」：A 的本地行仍是 holder=A、token=1；
    // 转移事件声明目标应拿 token=2。
    a.ledger.append(
      leaseEvent(REPLICA_A, "task.execution_transferred", {
        from_replica_id: REPLICA_A,
        to_replica_id: REPLICA_B,
        fencing_token: 1,
        next_fencing_token: 2,
      }),
    );
    a.leases.observeGrantedToken(TASK, 1);
    a.leases.observeReservedToken(TASK, 2);
    assert.equal(a.leases.current(TASK)?.holder_replica_id, REPLICA_A, "A 的本地行仍看似由 A 持有");
    assert.equal(a.leases.validate(TASK, 1), false, "A 用旧 token=1 提交被跨副本预留值拒绝");

    await syncAToB(a, b);
    assert.equal(b.ledger.scan({ taskId: TASK }).length, 2, "B 已同步到两条租约事件");

    const view = replayLeaseView(b.ledger, TASK);
    assert.equal(view.max_granted_token, 1);
    assert.equal(view.max_reserved_token, 2, "转移声明的 next_fencing_token 进入观察值");
    b.leases.observeGrantedToken(TASK, view.max_granted_token);
    b.leases.observeReservedToken(TASK, view.max_reserved_token);

    const acquired = b.leases.acquire(TASK, REPLICA_B, TTL);
    assert.ok("token" in acquired);
    assert.equal(acquired.token, 2, "B 跨过 A 已发放的 token 1 与转移预留 2");
    assert.equal(b.leases.validate(TASK, 1), false, "B 拒绝旧 token=1");
    assert.equal(b.leases.validate(TASK, 2), true, "B 的新 token 有效");
    assert.deepEqual(b.leases.fencingObservation(TASK), { granted: 1, reserved: 2 });
  } finally {
    closeReplica(a);
    closeReplica(b);
  }
});

test("无观察值时首次 acquire 仍为 1；观察值取 max 幂等（不回退）；预留号被采用", () => {
  const a = openReplica(REPLICA_A);
  try {
    const first = a.leases.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in first);
    assert.equal(first.token, 1);
    a.leases.release(TASK, REPLICA_A, first.token);

    a.leases.observeGrantedToken(TASK, 5);
    a.leases.observeGrantedToken(TASK, 3); // 幂等：不回退
    assert.deepEqual(a.leases.fencingObservation(TASK), { granted: 5, reserved: 0 });

    const next = a.leases.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in next);
    assert.equal(next.token, 6, "取号 = max(本地 1, 观察 granted 5) + 1");
    a.leases.release(TASK, REPLICA_A, next.token);

    a.leases.observeReservedToken(TASK, 7);
    a.leases.observeReservedToken(TASK, 2); // 幂等：不回退
    assert.deepEqual(a.leases.fencingObservation(TASK), { granted: 5, reserved: 7 });
    assert.equal(a.leases.validate(TASK, 6), false, "低于预留值 7 的 token 被拒");

    const reserved = a.leases.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in reserved);
    assert.equal(reserved.token, 7, "转移预留的 token 被目标副本采用");
    assert.equal(a.leases.validate(TASK, 7), true);
  } finally {
    closeReplica(a);
  }
});
