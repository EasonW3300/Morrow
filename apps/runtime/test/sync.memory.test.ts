// 记忆 / 删除 / 冲突同步语义集成测试（票 M3-T3 / Issue #32，PRD §4.2 FR-DEP-5、
// §4.1 FR-MEM-8，AC-05 前置）：两个真实 runtime 实例（独立 dataDir + 内存 SyncTransport，
// 零网络）——删除跨副本传播且离线副本不复活（双向）、locked 永不自动覆盖、
// preference 并发自动合并两端收敛、文件竞争保留双版本、冲突端点复用 M1 队列。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope, SensitivityLevel } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import type { ExtractionInput, MemoryExtractor } from "../src/memory/extraction.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { InMemorySyncTransport } from "../src/sync/transport.ts";
import { replicaShort } from "../src/sync/files.ts";
import { uuidv7 } from "../src/uuid-v7.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
const SESSION = "01936b9d-8f7a-7abc-9f2e-000000000020";

interface StubSensitivity {
  current: SensitivityLevel;
}

function stubExtractor(sensitivity: StubSensitivity): MemoryExtractor {
  return {
    extract: (input: ExtractionInput) => [
      {
        content: input.userText.trim(),
        kind: input.userText.includes("偏好") ? ("preference" as const) : ("fact" as const),
        confidence: 0.9,
        sensitivity: sensitivity.current,
        rule: "m3t3-stub",
      },
    ],
  };
}

function config(dir: string, replicaId: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId, provider: null };
}

interface Pair {
  a: RuntimeHandle;
  b: RuntimeHandle;
  dirA: string;
  dirB: string;
  sensitivityA: StubSensitivity;
  sensitivityB: StubSensitivity;
}

async function startPair(): Promise<Pair> {
  const dirA = tmpDir("morrow-sync-mem-a-");
  const dirB = tmpDir("morrow-sync-mem-b-");
  const sensitivityA: StubSensitivity = { current: "private" };
  const sensitivityB: StubSensitivity = { current: "private" };
  const a = await startRuntime(config(dirA, REPLICA_A), { memoryExtractor: stubExtractor(sensitivityA) });
  const b = await startRuntime(config(dirB, REPLICA_B), { memoryExtractor: stubExtractor(sensitivityB) });
  return { a, b, dirA, dirB, sensitivityA, sensitivityB };
}

async function closePair(pair: Pair): Promise<void> {
  await pair.a.close();
  await pair.b.close();
  removeDir(pair.dirA);
  removeDir(pair.dirB);
}

function connect(pair: Pair): void {
  const peers = new Map([
    [REPLICA_A, pair.a.sync],
    [REPLICA_B, pair.b.sync],
  ]);
  pair.a.sync.setTransport(new InMemorySyncTransport({ selfReplicaId: REPLICA_A, peers }));
  pair.b.sync.setTransport(new InMemorySyncTransport({ selfReplicaId: REPLICA_B, peers }));
}

/** 双向拉取直到账本收敛（合并/冲突审计事件可能需要多轮传播） */
async function syncAll(pair: Pair): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const aBefore = pair.a.ledger.count();
    const bBefore = pair.b.ledger.count();
    await pair.a.sync.pullFromPeer(REPLICA_B);
    await pair.b.sync.pullFromPeer(REPLICA_A);
    if (pair.a.ledger.count() === aBefore && pair.b.ledger.count() === bBefore) return;
  }
}

async function seedFact(runtime: RuntimeHandle, sensitivity: StubSensitivity, text: string, level: SensitivityLevel = "private"): Promise<string> {
  sensitivity.current = level;
  const user = buildEventEnvelope({
    replicaId: REPLICA_A,
    actorId: "owner",
    eventType: "message.user",
    sessionId: SESSION,
    payload: { text },
  });
  runtime.ledger.append(user);
  const run = await runtime.memory.extractTurn({ sessionId: SESSION, userEventId: user.event_id, occurredAt: user.occurred_at, text });
  sensitivity.current = "private";
  const factId = run.consolidation?.createdFactIds[0];
  assert.ok(factId !== undefined, `seedFact: no fact created for ${text}`);
  return factId;
}

/** 离线副本直接写一条事实修订事件（模拟断网期间本地编辑；不经过服务） */
function offlineFactUpdate(
  runtime: RuntimeHandle,
  replicaId: string,
  factId: string,
  version: number,
  content: string,
  options: { sensitivity?: SensitivityLevel; kind?: "fact" | "preference" | "profile" | "procedural"; reason?: string } = {},
): EventEnvelope {
  const envelope = buildEventEnvelope({
    replicaId,
    actorId: "owner",
    eventType: "memory.fact_updated",
    payload: {
      fact_id: factId,
      version,
      content,
      kind: options.kind ?? "fact",
      sensitivity: options.sensitivity ?? "private",
      revision_id: uuidv7(),
      reason: options.reason ?? "offline_edit",
    },
  });
  runtime.ledger.append(envelope);
  return envelope;
}

function eventIds(runtime: RuntimeHandle, eventType: string): string[] {
  return runtime.ledger.scan({ eventType }).map((entry) => entry.envelope.event_id);
}

test("删除跨副本传播且不复活：A 删除 / B 离线旧修订被跳过；反向同理", async () => {
  const pair = await startPair();
  try {
    connect(pair);
    const factA = await seedFact(pair.a, pair.sensitivityA, "服务监听端口 8787。");
    const factB = await seedFact(pair.a, pair.sensitivityA, "部署目标是 Ubuntu 24.04。");
    await syncAll(pair);
    assert.ok(pair.b.memory.getFact(factA) !== null, "B 已同步到 A 的事实");

    // A 删除 factA；B 离线期间继续编辑（旧修订）
    pair.a.memory.deleteFact(factA);
    const staleA = offlineFactUpdate(pair.b, REPLICA_B, factA, 2, "服务监听端口 9000。");

    // B 删除 factB；A 离线期间继续编辑（反向）
    pair.b.memory.deleteFact(factB);
    const staleB = offlineFactUpdate(pair.a, REPLICA_A, factB, 2, "部署目标是 Debian 12。");

    await syncAll(pair);

    // 双向：删除方的导入路径都跳过了旧修订并留审计
    assert.equal(pair.a.ledger.hasEvent(staleA.event_id), false, "A 不导入已删事实的旧修订");
    assert.equal(pair.b.ledger.hasEvent(staleB.event_id), false, "B 不导入已删事实的旧修订");
    const skippedA = pair.a.ledger.scan({ eventType: "sync.tombstone_skipped" });
    const skippedB = pair.b.ledger.scan({ eventType: "sync.tombstone_skipped" });
    assert.ok(skippedA.some((entry) => entry.envelope.payload.event_id === staleA.event_id));
    assert.ok(skippedB.some((entry) => entry.envelope.payload.event_id === staleB.event_id));

    // 删除集合两层次都生效：事实 tombstone + 该事实相关事件 id
    assert.equal(pair.a.tombstones.isFactDeleted(factA), true);
    assert.equal(pair.b.tombstones.isFactDeleted(factB), true);
    assert.ok(pair.a.tombstones.list("event").length >= 2, "删除事实的事件 id 入删除集合");
    assert.ok(pair.b.tombstones.list("event").length >= 2);

    // 删除传播到对端：两侧事实都是软删，重放不复活
    for (const [runtime, factId] of [
      [pair.a, factA],
      [pair.b, factA],
      [pair.a, factB],
      [pair.b, factB],
    ] as const) {
      const fact = runtime.memory.getFact(factId);
      assert.ok(fact !== null);
      assert.ok(fact.deleted_at !== null, `${factId} 在副本中保持删除`);
    }
    assert.equal(pair.a.memoryRebuilder.check().ok, true, "A 投影与事件一致");
    assert.equal(pair.b.memoryRebuilder.check().ok, true, "B 投影与事件一致");
  } finally {
    await closePair(pair);
  }
});

test("locked 事实跨设备永不自动覆盖：并发修订进待审核队列，本地值保持不变", async () => {
  const pair = await startPair();
  try {
    connect(pair);
    const factId = await seedFact(pair.a, pair.sensitivityA, "Owner 的护照号是 E12345678。", "locked");
    await syncAll(pair);
    assert.equal(pair.b.memory.getFact(factId)?.content, "Owner 的护照号是 E12345678。");

    // B 离线强制写出一条 locked 修订（模拟旧客户端/直写）；A 导入时不得自动覆盖
    offlineFactUpdate(pair.b, REPLICA_B, factId, 2, "Owner 的护照号是 E87654321。", {
      sensitivity: "locked",
      kind: "profile",
    });
    await syncAll(pair);

    const local = pair.a.memory.getFact(factId);
    assert.ok(local !== null);
    assert.equal(local.content, "Owner 的护照号是 E12345678。", "locked 本地值不被自动覆盖");
    assert.equal(local.version, 1);
    const conflicts = pair.a.memory.listConflicts({ status: "open" });
    const locked = conflicts.find((conflict) => conflict.fact_id === factId);
    assert.ok(locked !== undefined);
    assert.equal(locked.reason, "locked");
    assert.equal(eventIds(pair.a, "sync.merged").length, 0, "locked 不产生自动合并事件");
    const conflictEvents = pair.a.ledger.scan({ eventType: "sync.conflict" });
    assert.ok(conflictEvents.some((entry) => entry.envelope.payload.fact_id === factId));
    // 重放跳过被判定冲突的远端事件 → 记忆视图仍是本地值
    assert.equal(pair.a.memoryRebuilder.check().ok, true);

    const listing = await fetch(`http://127.0.0.1:${pair.a.port}/v1/sync/conflicts?status=open`);
    assert.equal(listing.status, 200);
    const body = await json<{ conflicts: Array<Record<string, unknown>> }>(listing);
    const view = body.conflicts.find((conflict) => conflict.fact_id === factId);
    assert.ok(view !== undefined);
    assert.equal(view.origin, "sync");
    assert.equal(view.remote_replica_id, REPLICA_B);
    assert.equal(view.local_replica_id, REPLICA_A);
    assert.equal(view.remote_version, 2);
    assert.equal(view.local_version, 1);

    const resolved = await fetch(
      `http://127.0.0.1:${pair.a.port}/v1/sync/conflicts/${String(view.conflict_id)}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "keep_old" }),
      },
    );
    assert.equal(resolved.status, 200);
    const resolvedBody = await json<{ resolution: string; sync: { resolved_at: string | null } }>(resolved);
    assert.equal(resolvedBody.resolution, "keep_old");
    assert.ok(resolvedBody.sync.resolved_at !== null);

    // 同一队列：M1 端点也看到 resolved
    const m1 = await fetch(`http://127.0.0.1:${pair.a.port}/v1/memory/conflicts?status=resolved`);
    const m1Body = await json<{ conflicts: Array<{ conflict_id: string }> }>(m1);
    assert.ok(m1Body.conflicts.some((conflict) => conflict.conflict_id === view.conflict_id));
  } finally {
    await closePair(pair);
  }
});

test("两端并发修改同一 preference：自动合并，两端收敛到同一内容与版本", async () => {
  const pair = await startPair();
  try {
    connect(pair);
    const factId = await seedFact(pair.a, pair.sensitivityA, "Owner 偏好使用 vim 编辑器。");
    await syncAll(pair);
    assert.equal(pair.b.memory.getFact(factId)?.version, 1);

    // 两端离线各自推进到 v2（不同内容），随后重连
    offlineFactUpdate(pair.a, REPLICA_A, factId, 2, "Owner 偏好使用 emacs 编辑器。", {
      kind: "preference",
      reason: "preference_update",
    });
    offlineFactUpdate(pair.b, REPLICA_B, factId, 2, "Owner 偏好使用 helix 编辑器。", {
      kind: "preference",
      reason: "preference_update",
    });
    await syncAll(pair);

    const aFact = pair.a.memory.getFact(factId);
    const bFact = pair.b.memory.getFact(factId);
    assert.ok(aFact !== null && bFact !== null);
    assert.equal(aFact.content, bFact.content, "两端收敛到同一合并文本");
    assert.equal(aFact.version, bFact.version, "两端收敛到同一结果版本");
    assert.equal(aFact.version, 3);
    assert.equal(pair.a.memory.listConflicts({ status: "open" }).length, 0, "偏好自动合并不进待审核");
    assert.equal(pair.b.memory.listConflicts({ status: "open" }).length, 0);
    assert.ok(eventIds(pair.a, "sync.merged").length >= 1);
    const merged = pair.a.ledger.scan({ eventType: "sync.merged" }).at(-1)!;
    const payload = merged.envelope.payload as Record<string, unknown>;
    assert.equal(payload.local_version, 1);
    assert.equal(payload.remote_version, 2);
    assert.equal(payload.result_version, 3);
    assert.equal(pair.a.memoryRebuilder.check().ok, true);
    assert.equal(pair.b.memoryRebuilder.check().ok, true);
  } finally {
    await closePair(pair);
  }
});

test("文件竞争：保留本地文件与来件双版本 + sync.file_conflict 事件", async () => {
  const pair = await startPair();
  try {
    const memoryDir = join(pair.dirA, "memory");
    const relative = "memory/note.md";
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "note.md"), "A 本地的内容", "utf8");
    const incoming = "B 设备写的内容";

    const result = pair.a.syncFiles.receive(relative, incoming, { sourceReplicaId: REPLICA_B });
    assert.equal(result.status, "conflict");
    assert.equal(result.path, relative);
    const expected = `memory/note.conflict-${replicaShort(REPLICA_B)}.md`;
    assert.equal(result.conflict_path, expected);
    assert.equal(readFileSync(join(pair.dirA, "memory", "note.md"), "utf8"), "A 本地的内容", "本地版本原样保留");
    assert.equal(existsSync(join(pair.dirA, expected)), true);
    assert.equal(readFileSync(join(pair.dirA, expected), "utf8"), incoming, "来件另存不丢");
    assert.notEqual(result.existing_sha256, result.incoming_sha256);

    const events = pair.a.ledger.scan({ eventType: "sync.file_conflict" });
    assert.equal(events.length, 1);
    const payload = events[0].envelope.payload as Record<string, unknown>;
    assert.equal(payload.relative_path, relative);
    assert.equal(payload.conflict_path, expected);
    assert.equal(payload.source_replica_id, REPLICA_B);

    // 字节相同再来一次 → unchanged（幂等，不产生第二个冲突文件/事件）
    const again = pair.a.syncFiles.receive(relative, "A 本地的内容");
    assert.equal(again.status, "unchanged");
    assert.equal(pair.a.ledger.scan({ eventType: "sync.file_conflict" }).length, 1);
  } finally {
    await closePair(pair);
  }
});
