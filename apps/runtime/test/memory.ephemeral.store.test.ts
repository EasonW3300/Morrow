// 记忆作用域迁移与检索语义（票 M7-A-T3 / Issue #60）：
// 旧库（无 scope / expired_at 列）重开即补列；scope 过滤的读语义
// （owner 只看全局；session:<id> 看全局 + 本会话）。存储层单元测试——HTTP 接缝
// 的全链路覆盖在 memory.ephemeral.api.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSqlite } from "../src/db.ts";
import { DB_FILE_NAME } from "../src/ledger.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const OLD_CANDIDATES_DDL = `
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
`;

const OLD_FACTS_DDL = `
CREATE TABLE memory_facts (
  fact_id     TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'profile', 'procedural')),
  sensitivity TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity IN ('public', 'private', 'locked')),
  version     INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  valid_from  TEXT NOT NULL,
  valid_until TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
`;

test("旧库重开：候选与事实表自动补 scope/expired_at（幂等，旧行 scope 缺省 owner）", () => {
  const dir = tmpDir("morrow-mem-migrate-");
  try {
    // 模拟 M1 旧库：只有 T1 形态的候选表（无 scope/expired_at/conflicted）与 T3 前的事实表
    const db = openSqlite(join(dir, DB_FILE_NAME));
    db.exec(OLD_CANDIDATES_DDL);
    db.exec(OLD_FACTS_DDL);
    db.close();

    const store = MemoryStore.open(dir);
    try {
      const { candidate } = store.createCandidate({
        content: "旧库自动补列的记忆",
        kind: "fact",
        confidence: 0.9,
        source: { kind: "message", eventId: "evt-old-1", sessionId: "s-1" },
      });
      assert.equal(candidate.scope, "owner", "旧库新写入行 scope 缺省 owner");
      assert.equal(candidate.expired_at, null);
      assert.equal(store.search("旧库自动补列").length, 1);
    } finally {
      store.close();
    }

    // 幂等：再开一次不抛错、不重复迁移
    const reopened = MemoryStore.open(dir);
    try {
      assert.equal(reopened.search("旧库自动补列").length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    removeDir(dir);
  }
});

test("scope 检索语义：owner 只查全局；session:<id> 查全局 + 本会话；expireScope 后退出检索面", () => {
  const dir = tmpDir("morrow-mem-scope-");
  try {
    const store = MemoryStore.open(dir);
    try {
      const global = store.createCandidate({
        content: "全局事实：咖啡机在厨房",
        kind: "fact",
        confidence: 0.9,
        scope: "owner",
        source: { kind: "message", eventId: "evt-g", sessionId: "s-owner" },
      });
      const sessionA = store.createCandidate({
        content: "会话事实：备用钥匙在书房",
        kind: "fact",
        confidence: 0.9,
        scope: "session:a",
        source: { kind: "message", eventId: "evt-a", sessionId: "a" },
      });
      const sessionB = store.createCandidate({
        content: "另一会话事实：备用钥匙在车库",
        kind: "fact",
        confidence: 0.9,
        scope: "session:b",
        source: { kind: "message", eventId: "evt-b", sessionId: "b" },
      });

      assert.deepEqual(
        store.search("备用钥匙").map((hit) => hit.id),
        [],
        "owner 作用域看不到任何会话写入",
      );
      assert.deepEqual(
        store.search("备用钥匙", { scope: "session:a" }).map((hit) => hit.id),
        [sessionA.candidate.candidate_id],
        "session:a 只看本会话（不含 session:b）",
      );
      assert.deepEqual(
        store.search("咖啡机", { scope: "session:a" }).map((hit) => hit.id),
        [global.candidate.candidate_id],
        "session:a 仍读得到全局记忆（只读全局继续成立）",
      );
      assert.equal(store.search("备用钥匙", { scope: "session:c" }).length, 0);

      const expired = store.expireScope("session:a", "2026-11-13T00:00:00.000Z");
      assert.deepEqual(expired.candidateIds, [sessionA.candidate.candidate_id]);
      assert.deepEqual(store.search("备用钥匙", { scope: "session:a" }), [], "过期后退出检索面");
      assert.equal(store.search("备用钥匙", { scope: "session:b" }).length, 1, "其他会话不受影响");
      assert.equal(store.search("咖啡机").length, 1, "全局记忆不受影响");
      assert.ok(sessionB.candidate.candidate_id);
    } finally {
      store.close();
    }
  } finally {
    removeDir(dir);
  }
});

test("promoteEntry：session scope → owner；非 session scope 由服务层拒绝（存储层如实返回原 scope）", () => {
  const dir = tmpDir("morrow-mem-promote-");
  try {
    const store = MemoryStore.open(dir);
    try {
      const created = store.createCandidate({
        content: "提升测试：周末去爬山",
        kind: "fact",
        confidence: 0.9,
        scope: "session:p",
        source: { kind: "message", eventId: "evt-p", sessionId: "p" },
      });
      const promoted = store.promoteToOwner(created.candidate.candidate_id);
      assert.deepEqual(promoted, { stage: "candidate", from_scope: "session:p" });
      assert.equal(store.getCandidate(created.candidate.candidate_id)?.scope, "owner");
      assert.equal(store.search("爬山").length, 1, "提升后进入 owner 检索面");
      assert.equal(store.promoteToOwner("missing"), null);
    } finally {
      store.close();
    }
  } finally {
    removeDir(dir);
  }
});
