// MemoryStore seam 测试（票 M1-T1 / Issue #13）：五表幂等迁移、候选+来源写入、
// FTS5 中英文检索与来源回链。表结构一次到位（facts/revisions 本票只建不写，T2 巩固用）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemorySearchHit } from "../src/memory/store.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const SESSION = "01936b9d-8f7a-7abc-9f2e-000000000001";
const SOURCE_EVENT = "01936b9d-8f7a-7abc-9f2e-000000000002";

function openStore(dir: string): MemoryStore {
  return MemoryStore.open(dir);
}

test("迁移可重复执行：写入→关闭→重开同目录，迁移不抛错且数据存活", () => {
  const dir = tmpDir("morrow-mem-migrate-");
  try {
    {
      const store = openStore(dir);
      store.createCandidate({
        content: "记住重启路由器的密码在抽屉里",
        kind: "fact",
        confidence: 0.9,
        source: { kind: "message", eventId: SOURCE_EVENT, sessionId: SESSION },
      });
      store.close();
    }
    {
      const store = openStore(dir); // 第二次迁移（CREATE IF NOT EXISTS）必须幂等
      const hits = store.search("路由器");
      assert.equal(hits.length, 1, "重开后 FTS 与行数据仍在");
      store.close();
    }
  } finally {
    removeDir(dir);
  }
});

test("createCandidate：候选带来源/观察时间/发生时间/置信度/sensitivity/版本，默认 private", () => {
  const dir = tmpDir("morrow-mem-fields-");
  try {
    const store = openStore(dir);
    const { source, candidate } = store.createCandidate({
      content: "Owner 的时区是 Asia/Shanghai",
      kind: "fact",
      confidence: 0.9,
      occurredAt: "2026-10-30T08:00:00.000Z",
      source: { kind: "message", eventId: SOURCE_EVENT, sessionId: SESSION },
    });

    assert.match(source.source_id, /^[0-9a-f-]{36}$/);
    assert.equal(source.kind, "message");
    assert.equal(source.event_id, SOURCE_EVENT, "来源回链原始事件");
    assert.equal(source.session_id, SESSION);

    assert.match(candidate.candidate_id, /^[0-9a-f-]{36}$/);
    assert.equal(candidate.content, "Owner 的时区是 Asia/Shanghai");
    assert.equal(candidate.kind, "fact");
    assert.equal(candidate.sensitivity, "private", "GLOSSARY：新记忆默认 private");
    assert.equal(candidate.confidence, 0.9);
    assert.equal(candidate.source_id, source.source_id);
    assert.equal(candidate.occurred_at, "2026-10-30T08:00:00.000Z", "发生时间 = 来源事件时间");
    assert.notEqual(candidate.observed_at, undefined, "观察时间（写入时刻）存在");
    assert.equal(candidate.version, 1);
    assert.equal(candidate.status, "pending", "未巩固状态，T2 巩固流转");
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("显式 sensitivity 透传；kind/sensitivity 越界值被 CHECK 拒绝", () => {
  const dir = tmpDir("morrow-mem-checks-");
  try {
    const store = openStore(dir);
    const { candidate } = store.createCandidate({
      content: "可以和 Trusted Contact 提到我的公开主页地址",
      kind: "profile",
      confidence: 0.7,
      sensitivity: "public",
      source: { kind: "message", eventId: SOURCE_EVENT, sessionId: SESSION },
    });
    assert.equal(candidate.sensitivity, "public");

    assert.throws(
      () =>
        store.createCandidate({
          content: "x",
          kind: "fact",
          confidence: 0.9,
          sensitivity: "secret" as never,
          source: { kind: "message", eventId: SOURCE_EVENT, sessionId: SESSION },
        }),
      "sensitivity 越界必须被表 CHECK 拒绝",
    );
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("FTS5 中文检索：短语命中连续子串，无关词不命中", () => {
  const dir = tmpDir("morrow-mem-zh-");
  try {
    const store = openStore(dir);
    store.createCandidate({
      content: "Owner 喜欢用 TypeScript 写脚本工具",
      kind: "preference",
      confidence: 0.8,
      source: { kind: "message", eventId: SOURCE_EVENT, sessionId: SESSION },
    });

    const hitLike = store.search("喜欢");
    assert.equal(hitLike.length, 1, "二字中文词应命中");
    assert.equal(hitLike[0].stage, "candidate");
    assert.equal(hitLike[0].type, "preference");
    assert.equal(hitLike[0].content, "Owner 喜欢用 TypeScript 写脚本工具");

    const hitScript = store.search("脚本");
    assert.equal(hitScript.length, 1, "跨中英边界的中文词应命中");

    const hitEn = store.search("typescript");
    assert.equal(hitEn.length, 1, "英文词大小写不敏感命中");

    assert.deepEqual(store.search("跑步"), [], "无关词不命中");
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("FTS5 英文检索：多词短语与英文长句", () => {
  const dir = tmpDir("morrow-mem-en-");
  try {
    const store = openStore(dir);
    store.createCandidate({
      content: "remember the milk",
      kind: "fact",
      confidence: 0.9,
      source: { kind: "message", eventId: SOURCE_EVENT, sessionId: SESSION },
    });
    const hits = store.search("remember the milk");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, "remember the milk");
    assert.deepEqual(store.search("remember the cheese"), []);
    store.close();
  } finally {
    removeDir(dir);
  }
});

test("search 命中带来源回链：sources 数组含原始事件 event_id", () => {
  const dir = tmpDir("morrow-mem-backlink-");
  try {
    const store = openStore(dir);
    store.createCandidate({
      content: "我住在杭州",
      kind: "profile",
      confidence: 0.7,
      source: { kind: "message", eventId: SOURCE_EVENT, sessionId: SESSION },
    });
    const hits = store.search("杭州") as MemorySearchHit[];
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].sources, [SOURCE_EVENT], "回链字段 = 原始 message 事件 id");
    assert.equal(hits[0].sensitivity, "private");
    assert.equal(hits[0].version, 1);
    assert.match(hits[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    store.close();
  } finally {
    removeDir(dir);
  }
});
