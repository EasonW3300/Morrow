// MemoryStore 巩固写路径测试（票 M1-T2 / Issue #14）：
// facts/revisions/conflicts 表写入激活 + 候选状态机 + 同库模式迁移（候选 status 增 'conflicted'）。
// 每个方法 = 一个逻辑记忆操作 = 一个事务（行是可重建投影，账本事件在服务层记账）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { openSqlite } from "../src/db.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { removeDir, tmpDir } from "./helpers.ts";

interface Fixture {
  store: MemoryStore;
  dir: string;
}

function setup(prefix = "morrow-mem-store2-"): Fixture {
  const dir = tmpDir(prefix);
  return { store: MemoryStore.open(dir), dir };
}

function teardown(fx: Fixture): void {
  fx.store.close();
  removeDir(fx.dir);
}

/** 造一条候选（走 T1 既有 createCandidate，返回 candidate_id 与 source_id） */
function makeCandidate(store: MemoryStore, content: string, overrides = {}): { candidateId: string; sourceId: string } {
  const { source, candidate } = store.createCandidate({
    content,
    kind: "preference",
    confidence: 0.8,
    source: { kind: "message", eventId: `evt-${Math.random().toString(36).slice(2, 10)}`, sessionId: "sess-1" },
    ...overrides,
  });
  return { candidateId: candidate.candidate_id, sourceId: source.source_id };
}

test("createFact：事实 v1 落表 + 来源多对多 + FTS 索引（检索命中 stage=fact）+ 候选转 consolidated", () => {
  const fx = setup();
  try {
    const { candidateId, sourceId } = makeCandidate(fx.store, "我喜欢用 Rust 写脚本");
    const fact = fx.store.createFact({
      content: "我喜欢用 Rust 写脚本",
      kind: "preference",
      sensitivity: "private",
      candidateId,
      sourceId,
    });
    assert.equal(fact.version, 1);
    assert.equal(fact.valid_until, null);
    assert.ok(fact.fact_id.length > 0);

    // 候选已转 consolidated
    assert.equal(fx.store.getCandidate(candidateId)?.status, "consolidated");

    // FTS 检索命中事实（entry_kind=fact，与候选统一索引），来源回链到原始事件
    const hits = fx.store.search("Rust");
    const factHits = hits.filter((h) => h.stage === "fact");
    assert.equal(factHits.length, 1);
    assert.equal(factHits[0].id, fact.fact_id);
    assert.equal(factHits[0].sources.length, 1);
    assert.equal(hits.some((h) => h.stage === "candidate"), true, "原候选仍在统一索引中（stage=candidate）");

    // 事实列表（巩固器的匹配视图）：created_at 升序
    assert.deepEqual(fx.store.listFacts().map((f) => f.fact_id), [fact.fact_id]);
  } finally {
    teardown(fx);
  }
});

test("updateFact：版本+1 + MemoryRevision 落行（内容/敏感等级/原因/来源）+ updated_at 前移", () => {
  const fx = setup();
  try {
    const first = makeCandidate(fx.store, "我喜欢用 TypeScript 写脚本");
    const fact = fx.store.createFact({
      content: "我喜欢用 TypeScript 写脚本",
      kind: "preference",
      sensitivity: "private",
      candidateId: first.candidateId,
      sourceId: first.sourceId,
    });

    const second = makeCandidate(fx.store, "我现在偏好用 Go 写脚本");
    const { fact: revised, revision } = fx.store.updateFact({
      factId: fact.fact_id,
      content: "我现在偏好用 Go 写脚本",
      sensitivity: "private",
      reason: "preference_update",
      candidateId: second.candidateId,
      sourceId: second.sourceId,
    });

    assert.equal(revised.version, 2, "版本 +1");
    assert.equal(revised.content, "我现在偏好用 Go 写脚本");
    assert.ok(revised.updated_at >= fact.updated_at);

    assert.equal(revision.fact_id, fact.fact_id);
    assert.equal(revision.version, 2);
    assert.equal(revision.content, "我现在偏好用 Go 写脚本");
    assert.equal(revision.reason, "preference_update");
    assert.equal(revision.source_id, second.sourceId);

    // 第二条候选已 consolidated；FTS 检索新内容命中、旧内容不再命中该事实
    assert.equal(fx.store.getCandidate(second.candidateId)?.status, "consolidated");
    assert.equal(fx.store.search("Go 写脚本").some((h) => h.id === fact.fact_id), true);
    assert.equal(fx.store.search("TypeScript").some((h) => h.id === fact.fact_id), false);
  } finally {
    teardown(fx);
  }
});

test("corroborate：只补来源关系并把候选转 consolidated，不产生修订（locked 事实也可印证）", () => {
  const fx = setup();
  try {
    const first = makeCandidate(fx.store, "我住在上海");
    const fact = fx.store.createFact({
      content: "我住在上海",
      kind: "profile",
      sensitivity: "locked",
      candidateId: first.candidateId,
      sourceId: first.sourceId,
    });
    const second = makeCandidate(fx.store, "我住在上海");
    fx.store.corroborateFact({ factId: fact.fact_id, candidateId: second.candidateId, sourceId: second.sourceId });

    const fresh = fx.store.getFact(fact.fact_id);
    assert.equal(fresh?.version, 1, "版本不变");
    assert.equal(fx.store.getCandidate(second.candidateId)?.status, "consolidated");
    // 事实来源回链现为两条
    const hits = fx.store.search("上海");
    const hit = hits.find((h) => h.id === fact.fact_id);
    assert.equal(hit?.sources.length, 2);
  } finally {
    teardown(fx);
  }
});

test("escalateConflict：冲突行落表 + 候选转 conflicted（待确认队列，候选不再被巩固扫到）", () => {
  const fx = setup();
  try {
    const first = makeCandidate(fx.store, "我住在北京朝阳");
    const fact = fx.store.createFact({
      content: "我住在北京朝阳",
      kind: "profile",
      sensitivity: "private",
      candidateId: first.candidateId,
      sourceId: first.sourceId,
    });
    const second = makeCandidate(fx.store, "我住在上海浦东");
    const conflict = fx.store.escalateConflict({
      candidateId: second.candidateId,
      factId: fact.fact_id,
      reason: "fact_conflict",
      existingContent: "我住在北京朝阳",
      incomingContent: "我住在上海浦东",
      existingSensitivity: "private",
      incomingSensitivity: "private",
      sourceId: second.sourceId,
    });

    assert.equal(conflict.status, "open");
    assert.equal(conflict.resolution, null);
    assert.equal(fx.store.getCandidate(second.candidateId)?.status, "conflicted");
    assert.deepEqual(fx.store.listConflicts().map((c) => c.conflict_id), [conflict.conflict_id]);
    assert.deepEqual(fx.store.listCandidates({ status: "pending" }), [], "conflicted 候选不进 pending 列表");
  } finally {
    teardown(fx);
  }
});

test("resolveConflict：keep_new → 事实版本+1 留修订 + 候选 consolidated；keep_old → 候选 dismissed 事实不动；merge → 修订内容为合并文本", () => {
  const fx = setup("morrow-mem-store2-resolve-");
  try {
    // --- keep_new ---
    const a = makeCandidate(fx.store, "我住在北京朝阳");
    const fact = fx.store.createFact({
      content: "我住在北京朝阳",
      kind: "profile",
      sensitivity: "private",
      candidateId: a.candidateId,
      sourceId: a.sourceId,
    });
    const b = makeCandidate(fx.store, "我住在上海浦东");
    const conflict = fx.store.escalateConflict({
      candidateId: b.candidateId,
      factId: fact.fact_id,
      reason: "fact_conflict",
      existingContent: "我住在北京朝阳",
      incomingContent: "我住在上海浦东",
      existingSensitivity: "private",
      incomingSensitivity: "private",
      sourceId: b.sourceId,
    });
    const keepNew = fx.store.resolveConflict({
      conflictId: conflict.conflict_id,
      resolution: "keep_new",
      resolvedContent: null,
      factUpdate: { content: "我住在上海浦东", sensitivity: "private", reason: "conflict_resolved", sourceId: b.sourceId },
      candidateStatus: "consolidated",
    });
    assert.equal(keepNew.conflict.status, "resolved");
    assert.equal(keepNew.conflict.resolution, "keep_new");
    assert.equal(keepNew.fact.version, 2);
    assert.equal(keepNew.revision?.reason, "conflict_resolved");
    assert.equal(fx.store.getCandidate(b.candidateId)?.status, "consolidated");

    // --- keep_old：事实不动、候选 dismissed、裁决留痕 ---
    const c = makeCandidate(fx.store, "我住在杭州西湖");
    const conflict2 = fx.store.escalateConflict({
      candidateId: c.candidateId,
      factId: fact.fact_id,
      reason: "fact_conflict",
      existingContent: "我住在上海浦东",
      incomingContent: "我住在杭州西湖",
      existingSensitivity: "private",
      incomingSensitivity: "private",
      sourceId: c.sourceId,
    });
    const keepOld = fx.store.resolveConflict({
      conflictId: conflict2.conflict_id,
      resolution: "keep_old",
      resolvedContent: null,
      factUpdate: null,
      candidateStatus: "dismissed",
    });
    assert.equal(keepOld.fact.version, 2, "keep_old 不推进版本");
    assert.equal(keepOld.revision, null);
    assert.equal(fx.store.getCandidate(c.candidateId)?.status, "dismissed");
    assert.equal(fx.store.getConflict(conflict2.conflict_id)?.resolution, "keep_old");

    // --- merge：Owner 提供的合并文本进版本链 ---
    const d = makeCandidate(fx.store, "我住在上海静安");
    const conflict3 = fx.store.escalateConflict({
      candidateId: d.candidateId,
      factId: fact.fact_id,
      reason: "fact_conflict",
      existingContent: "我住在上海浦东",
      incomingContent: "我住在上海静安",
      existingSensitivity: "private",
      incomingSensitivity: "private",
      sourceId: d.sourceId,
    });
    const merged = fx.store.resolveConflict({
      conflictId: conflict3.conflict_id,
      resolution: "merge",
      resolvedContent: "我住在上海，工作日在浦东、周末在静安",
      factUpdate: { content: "我住在上海，工作日在浦东、周末在静安", sensitivity: "private", reason: "conflict_merged", sourceId: d.sourceId },
      candidateStatus: "consolidated",
    });
    assert.equal(merged.fact.version, 3);
    assert.equal(merged.revision?.content, "我住在上海，工作日在浦东、周末在静安");
    assert.equal(fx.store.getConflict(conflict3.conflict_id)?.resolved_content, "我住在上海，工作日在浦东、周末在静安");
  } finally {
    teardown(fx);
  }
});

test("listCandidates：status 过滤 + 来源 event_id 回链 + created_at 升序", () => {
  const fx = setup();
  try {
    const keep = makeCandidate(fx.store, "候选甲");
    makeCandidate(fx.store, "候选乙");
    fx.store.setCandidateStatus(keep.candidateId, "dismissed");

    const pending = fx.store.listCandidates({ status: "pending" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].content, "候选乙");
    assert.ok(pending[0].source_event_id.startsWith("evt-"), "来源 event_id 回链");

    const dismissed = fx.store.listCandidates({ status: "dismissed" });
    assert.deepEqual(dismissed.map((c) => c.candidate_id), [keep.candidateId]);
  } finally {
    teardown(fx);
  }
});

test("hasCandidateFromSource：同来源事件 + 同内容 → true（抽取去重）；不同来源或内容 → false", () => {
  const fx = setup();
  try {
    const { source } = fx.store.createCandidate({
      content: "请记住：周五下午三点复盘",
      kind: "fact",
      confidence: 0.9,
      source: { kind: "message", eventId: "evt-user-1", sessionId: "sess-1" },
    });
    assert.equal(fx.store.hasCandidateFromSource("evt-user-1", "请记住：周五下午三点复盘"), true);
    assert.equal(fx.store.hasCandidateFromSource("evt-user-1", "另一条内容"), false);
    assert.equal(fx.store.hasCandidateFromSource("evt-user-2", "请记住：周五下午三点复盘"), false);
    assert.ok(source.source_id.length > 0);
  } finally {
    teardown(fx);
  }
});

test("迁移：T1 旧库（status 无 'conflicted'）重开时重建候选表，既有行保留且新状态可用", () => {
  const dir = tmpDir("morrow-mem-store2-mig-");
  try {
    // 用 T1 的旧 DDL 造一个"历史库"
    const legacy = openSqlite(`${dir}/events.sqlite`);
    legacy.exec(`
      CREATE TABLE memory_sources (
        source_id  TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        event_id   TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE memory_candidates (
        candidate_id TEXT PRIMARY KEY,
        content      TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'profile', 'procedural')),
        sensitivity  TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity IN ('public', 'private', 'locked')),
        confidence   REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source_id    TEXT NOT NULL REFERENCES memory_sources (source_id),
        observed_at  TEXT NOT NULL,
        occurred_at  TEXT NOT NULL,
        version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consolidated', 'dismissed')),
        created_at   TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        "INSERT INTO memory_sources (source_id, kind, event_id, session_id, created_at) VALUES ('src-legacy', 'message', 'evt-legacy', 'sess-legacy', '2026-10-30T08:00:00.000Z')",
      )
      .run();
    legacy
      .prepare(
        "INSERT INTO memory_candidates (candidate_id, content, kind, sensitivity, confidence, source_id, observed_at, occurred_at, version, status, created_at) VALUES ('cand-legacy', '旧候选内容', 'fact', 'private', 0.9, 'src-legacy', '2026-10-30T08:00:00.000Z', '2026-10-30T08:00:00.000Z', 1, 'pending', '2026-10-30T08:00:00.000Z')",
      )
      .run();
    legacy.close();

    const store = MemoryStore.open(dir);
    try {
      const carried = store.getCandidate("cand-legacy");
      assert.equal(carried?.content, "旧候选内容", "迁移保留既有行");
      assert.equal(carried?.status, "pending");

      // 新状态 'conflicted' 可用（旧 CHECK 会拒绝）
      store.setCandidateStatus("cand-legacy", "conflicted");
      assert.equal(store.getCandidate("cand-legacy")?.status, "conflicted");
      store.setCandidateStatus("cand-legacy", "pending");

      // 新表完整性：巩固写路径正常
      const fact = store.createFact({
        content: "迁移后新建事实",
        kind: "fact",
        sensitivity: "private",
        candidateId: "cand-legacy",
        sourceId: "src-legacy",
      });
      assert.equal(fact.version, 1);
    } finally {
      store.close();
    }
  } finally {
    removeDir(dir);
  }
});
