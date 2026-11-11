// 记忆投影重建测试（票 M3-T3 / Issue #32，PRD §4.2 / §4.1 FR-MEM-8）：
// facts / revisions / FTS 可由 memory.* 事件按序重放重建——新副本只拿到事件账本时，
// rebuildMemoryProjection() 产出与源副本一致的记忆视图；已删事实不复活；重建后与
// 事件流一致（一致性校验通过）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { EventEnvelope, SensitivityLevel } from "@morrow/protocol";
import { buildEventEnvelope } from "../src/envelope.ts";
import { EventLedger } from "../src/ledger.ts";
import type { MemoryExtractor } from "../src/memory/extraction.ts";
import {
  checkMemoryProjectionConsistency,
  rebuildMemoryProjection,
} from "../src/memory/rebuild.ts";
import { MemoryService } from "../src/memory/service.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { renderFactMarkdown } from "../src/memory/projection.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
const SESSION = "01936b9d-8f7a-7abc-9f2e-000000000010";
const PREF_A = "Owner 偏好使用 vim 编辑器。";
const PREF_A_V2 = "Owner 偏好使用 emacs 编辑器。";
const PREF_B = "暗色界面看着舒服。";

function extractor(): MemoryExtractor {
  return {
    extract: (input) => [
      {
        content: input.userText.trim(),
        kind: "preference" as const,
        confidence: 0.9,
        sensitivity: "private" as SensitivityLevel,
        rule: "rebuild-stub",
      },
    ],
  };
}

interface Fixture {
  dir: string;
  ledger: EventLedger;
  store: MemoryStore;
  memory: MemoryService;
}

function openFixture(replicaId: string, dir = tmpDir("morrow-mem-rebuild-")): Fixture {
  const ledger = EventLedger.open(dir);
  const store = MemoryStore.open(dir);
  const memory = new MemoryService({ store, ledger, replicaId, extractor: extractor() });
  return { dir, ledger, store, memory };
}

async function seedFact(fx: Fixture, text: string): Promise<string> {
  const user = buildEventEnvelope({
    replicaId: REPLICA_A,
    actorId: "owner",
    eventType: "message.user",
    sessionId: SESSION,
    payload: { text },
  });
  fx.ledger.append(user);
  const run = await fx.memory.extractTurn({ sessionId: SESSION, userEventId: user.event_id, occurredAt: user.occurred_at, text });
  const factId = run.consolidation?.createdFactIds[0];
  assert.ok(factId !== undefined);
  return factId;
}

function copyLedger(source: EventLedger, target: EventLedger): EventEnvelope[] {
  const envelopes = source.scan().map((entry) => entry.envelope);
  for (const envelope of envelopes) target.append(envelope);
  return envelopes;
}

test("rebuildMemoryProjection：新副本从事件账本重建 facts/revisions/FTS，与源副本一致", async () => {
  const source = openFixture(REPLICA_A);
  let replica: Fixture | null = null;
  try {
    const preferenceA = await seedFact(source, PREF_A);
    const preferenceB = await seedFact(source, PREF_B);

    // 源副本经受控导入推进到 v2（生成 memory.fact_updated + MemoryRevision）
    const fact = source.store.getFact(preferenceA);
    assert.ok(fact !== null);
    const markdown = renderFactMarkdown(fact, source.store.factSourceEventIds(fact.fact_id)).replace(PREF_A, PREF_A_V2);
    const imported = source.memory.importMarkdown(markdown);
    assert.equal(imported.status, "updated");
    assert.equal(imported.version, 2);

    // 删除其中一条（tombstone）
    const deleted = source.memory.deleteFact(preferenceA);
    assert.equal(deleted.deleted, true);

    // 新副本：独立 dataDir，只拿到事件账本（模拟跨副本同步后的空投影）
    replica = openFixture(REPLICA_B);
    copyLedger(source.ledger, replica.ledger);
    const before = checkMemoryProjectionConsistency({ store: replica.store, ledger: replica.ledger });
    assert.equal(before.ok, false, "空投影与事件流不一致");

    const result = rebuildMemoryProjection({ store: replica.store, ledger: replica.ledger });
    assert.ok(result.facts >= 2);
    assert.ok(result.revisions >= 1);

    const rebuilt = replica.store.getFact(preferenceA);
    assert.ok(rebuilt !== null);
    assert.equal(rebuilt.deleted_at !== null, true, "删除标记重建");
    assert.equal(rebuilt.version, 2);
    assert.equal(rebuilt.content, PREF_A_V2, "版本链头部内容");

    const revisions = replica.store.listRevisions(preferenceA);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].version, 2);
    assert.equal(revisions[0].content, PREF_A_V2);
    assert.equal(revisions[0].reason, "manual_import");

    const live = replica.store.getFact(preferenceB);
    assert.ok(live !== null);
    assert.equal(live.deleted_at, null);
    assert.equal(live.content, PREF_B);

    // FTS：活事实可检索，已删事实退出检索面
    const hits = replica.store.search("暗色");
    assert.ok(hits.some((hit) => hit.stage === "fact" && hit.content === PREF_B));
    assert.equal(replica.store.search("emacs").filter((hit) => hit.stage === "fact").length, 0);

    const after = checkMemoryProjectionConsistency({ store: replica.store, ledger: replica.ledger });
    assert.equal(after.ok, true, JSON.stringify(after));
  } finally {
    source.store.close();
    source.ledger.close();
    removeDir(source.dir);
    if (replica !== null) {
      replica.store.close();
      replica.ledger.close();
      removeDir(replica.dir);
    }
  }
});

test("重放以删除为终态：删除后到达的旧版本/新版本修订都不复活事实", async () => {
  const fx = openFixture(REPLICA_A);
  try {
    const factId = await seedFact(fx, PREF_A);
    fx.memory.deleteFact(factId);
    const deletedAt = fx.store.getFact(factId)?.deleted_at;
    assert.ok(deletedAt !== null && deletedAt !== undefined);

    // 模拟离线副本带来的陈旧修订（事件 id 新、版本更旧）与新修订（版本更高）
    for (const version of [1, 3]) {
      const stale = buildEventEnvelope({
        replicaId: REPLICA_B,
        actorId: "agent:runtime",
        eventType: "memory.fact_updated",
        payload: {
          fact_id: factId,
          version,
          content: `复活尝试 v${version}`,
          sensitivity: "private",
          revision_id: `revision-${version}`,
          reason: "sync_merge",
        },
      });
      fx.ledger.append(stale);
    }
    rebuildMemoryProjection({ store: fx.store, ledger: fx.ledger });
    const fact = fx.store.getFact(factId);
    assert.ok(fact !== null);
    assert.equal(fact.deleted_at, deletedAt, "删除标记保持");
    assert.equal(fact.content, PREF_A, "内容不被删除后修订改写");
    assert.equal(fact.version, 1);
    assert.equal(fx.store.search("复活").length, 0);
  } finally {
    fx.store.close();
    fx.ledger.close();
    removeDir(fx.dir);
  }
});
