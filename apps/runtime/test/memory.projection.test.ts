// Markdown 投影测试（票 M1-T3 / Issue #15，FR-MEM-6）：
// §6.4 frontmatter 字段集与顺序、再生成幂等（同状态同字节）、删除事实不投影且重投影
// 不复活、孤儿 uuid 文件清理但外来文件不动、parse/render 往返、deleteFact 软删保留审计行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SensitivityLevel } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { MemoryStore } from "../src/memory/store.ts";
import {
  MarkdownParseError,
  MemoryProjector,
  parseFactMarkdown,
  renderFactMarkdown,
} from "../src/memory/projection.ts";
import { uuidv7 } from "../src/uuid-v7.ts";
import { removeDir, tmpDir } from "./helpers.ts";

interface Fixture {
  store: MemoryStore;
  projector: MemoryProjector;
  dir: string;
  memoryDir: string;
}

function setup(): Fixture {
  const dir = tmpDir("morrow-mem-proj-");
  const store = MemoryStore.open(dir);
  const projector = new MemoryProjector({ store, dataDir: dir });
  return { store, projector, dir, memoryDir: join(dir, "memory") };
}

function teardown(fx: Fixture): void {
  fx.store.close();
  removeDir(fx.dir);
}

/** 经 store 公开路径种一条事实（候选 + 事实 v1），返回事实行与来源账本事件 id */
function seedFact(
  fx: Fixture,
  content: string,
  overrides: { sensitivity?: SensitivityLevel; kind?: "fact" | "preference" | "profile" | "procedural" } = {},
): { factId: string; sourceEventId: string } {
  const sourceEventId = uuidv7();
  const { source, candidate } = fx.store.createCandidate({
    content: `${content}（候选原文）`,
    kind: overrides.kind ?? "fact",
    confidence: 0.9,
    sensitivity: overrides.sensitivity ?? "private",
    source: { kind: "message", eventId: sourceEventId },
  });
  const fact = fx.store.createFact({
    content,
    kind: overrides.kind ?? "fact",
    sensitivity: overrides.sensitivity ?? "private",
    candidateId: candidate.candidate_id,
    sourceId: source.source_id,
  });
  return { factId: fact.fact_id, sourceEventId };
}

test("renderFactMarkdown：frontmatter 严格按 PRD §6.4 字段集与顺序，正文 = 人类可读内容", () => {
  const fact = {
    fact_id: "01936b9d-8f7a-7abc-9f2e-0000000000f1",
    content: "Owner 偏好使用 TypeScript 编写脚本工具。",
    kind: "fact" as const,
    sensitivity: "private" as const,
    version: 3,
    valid_from: "2026-10-29T12:00:00.000Z",
    valid_until: null,
    created_at: "2026-10-29T12:00:00.000Z",
    updated_at: "2026-10-30T08:30:00.000Z",
    deleted_at: null,
    scope: "owner",
    expired_at: null,
  };
  const sources = ["evt-0193-a", "evt-0194-b"];
  const md = renderFactMarkdown(fact, sources);

  const lines = md.split("\n");
  assert.equal(lines[0], "---");
  const close = lines.indexOf("---", 1);
  assert.ok(close > 0, "closing --- delimiter must exist");
  const keys = lines.slice(1, close).map((line) => line.slice(0, line.indexOf(":")));
  // PRD §6.4 字段集（票面固定清单），独立于实现的期望来源
  assert.deepEqual(keys, [
    "id",
    "type",
    "sensitivity",
    "confidence",
    "valid_from",
    "valid_until",
    "sources",
    "created_at",
    "updated_at",
    "version",
  ]);
  const field = (name: string): string => {
    const line = lines.slice(1, close).find((l) => l.startsWith(`${name}:`));
    assert.ok(line !== undefined, `frontmatter field ${name} missing`);
    return line.slice(name.length + 1).trim();
  };
  assert.equal(field("id"), fact.fact_id);
  assert.equal(field("type"), "fact");
  assert.equal(field("sensitivity"), "private");
  assert.equal(field("confidence"), "null"); // 事实无置信度：字段保留、值为 null
  assert.equal(field("valid_from"), fact.valid_from);
  assert.equal(field("valid_until"), "null");
  assert.deepEqual(JSON.parse(field("sources")), sources);
  assert.equal(field("created_at"), fact.created_at);
  assert.equal(field("updated_at"), fact.updated_at);
  assert.equal(field("version"), "3");
  // 正文：分隔符后的空行 + 内容 + 尾随换行
  assert.equal(md.slice(md.indexOf("---", close) + 4), `\n${fact.content}\n`);
});

test("projectAll：每条事实一个 {fact_id}.md，再生成幂等（同状态产出同字节）", () => {
  const fx = setup();
  try {
    const a = seedFact(fx, "Alpha 项目使用 pnpm 管理依赖");
    const b = seedFact(fx, "Beta 服务器部署在 Frankfurt 机房");

    const first = fx.projector.projectAll();
    assert.equal(first.written.length, 2);
    assert.equal(first.removed.length, 0);
    assert.ok(existsSync(join(fx.memoryDir, `${a.factId}.md`)));
    assert.ok(existsSync(join(fx.memoryDir, `${b.factId}.md`)));

    const before = new Map(readdirSync(fx.memoryDir).map((name) => [name, readFileSync(join(fx.memoryDir, name))]));
    const second = fx.projector.projectAll();
    assert.equal(second.written.length, 0, "identical state must not rewrite files");
    assert.equal(second.unchanged.length, 2);
    assert.equal(second.removed.length, 0);
    for (const [name, bytes] of before) {
      assert.ok(readFileSync(join(fx.memoryDir, name)).equals(bytes), `${name} must be byte-identical`);
    }
  } finally {
    teardown(fx);
  }
});

test("删除标记后不投影，重投影不复活已删记忆；检索不再命中", () => {
  const fx = setup();
  try {
    const kept = seedFact(fx, "Gamma 团队每周四发布版本");
    const doomed = seedFact(fx, "Delta 网关的维护窗口在周日");
    fx.projector.projectAll();
    assert.ok(existsSync(join(fx.memoryDir, `${doomed.factId}.md`)));

    fx.store.deleteFact(doomed.factId);
    const run = fx.projector.projectAll();
    assert.deepEqual(run.removed, [doomed.factId]);
    assert.ok(!existsSync(join(fx.memoryDir, `${doomed.factId}.md`)));
    assert.ok(existsSync(join(fx.memoryDir, `${kept.factId}.md`)));

    // 重投影不复活
    const again = fx.projector.projectAll();
    assert.equal(again.written.length, 0);
    assert.ok(!existsSync(join(fx.memoryDir, `${doomed.factId}.md`)));

    // FTS 索引同步移除：检索面不再命中已删事实（保留事实仍可检索）
    const hits = fx.store.search("维护窗口");
    assert.ok(!hits.some((h) => h.id === doomed.factId));
    assert.ok(fx.store.search("发布版本").some((h) => h.id === kept.factId));
  } finally {
    teardown(fx);
  }
});

test("deleteFact：软删（行保留 deleted_at）——不物理删，保留回链审计", () => {
  const fx = setup();
  try {
    const { factId } = seedFact(fx, "Epsilon 偏好深色主题");
    fx.store.deleteFact(factId);
    const fact = fx.store.getFact(factId);
    assert.ok(fact !== null, "row must be retained for audit");
    assert.ok(fact.deleted_at !== null, "deleted_at must be set");
    assert.equal(fx.store.listFacts().length, 0, "live view must exclude deleted facts");
  } finally {
    teardown(fx);
  }
});

test("projectAll：清理孤儿 uuid 投影文件，不动外来文件", () => {
  const fx = setup();
  try {
    seedFact(fx, "Zeta 记忆条目内容");
    fx.projector.projectAll();
    mkdirSync(fx.memoryDir, { recursive: true });
    const orphan = join(fx.memoryDir, "01936b9d-8f7a-7abc-9f2e-00000000dead.md");
    const foreign = join(fx.memoryDir, "notes.md");
    writeFileSync(orphan, "stale projection");
    writeFileSync(foreign, "user's own notes");
    const run = fx.projector.projectAll();
    assert.deepEqual(run.removed, ["01936b9d-8f7a-7abc-9f2e-00000000dead"]);
    assert.ok(!existsSync(orphan));
    assert.ok(existsSync(foreign), "non-projection files must not be touched");
  } finally {
    teardown(fx);
  }
});

test("parseFactMarkdown：render → parse 往返恢复 id/version/sensitivity/sources/正文", () => {
  const fact = {
    fact_id: "01936b9d-8f7a-7abc-9f2e-0000000000f2",
    content: "Owner 的时区是 Asia/Shanghai。",
    kind: "profile" as const,
    sensitivity: "locked" as const,
    version: 2,
    valid_from: "2026-10-29T12:00:00.000Z",
    valid_until: null,
    created_at: "2026-10-29T12:00:00.000Z",
    updated_at: "2026-10-30T08:30:00.000Z",
    deleted_at: null,
    scope: "owner",
    expired_at: null,
  };
  const sources = ["evt-0193-x"];
  const parsed = parseFactMarkdown(renderFactMarkdown(fact, sources));
  assert.equal(parsed.fields.id, fact.fact_id);
  assert.equal(parsed.fields.type, "profile");
  assert.equal(parsed.fields.sensitivity, "locked");
  assert.equal(parsed.fields.version, "2");
  assert.deepEqual(JSON.parse(parsed.fields.sources), sources);
  assert.equal(parsed.body, fact.content);
});

test("parseFactMarkdown：缺 frontmatter / 缺闭合分隔符 → MarkdownParseError", () => {
  assert.throws(() => parseFactMarkdown("没有 frontmatter 的普通文本"), MarkdownParseError);
  assert.throws(() => parseFactMarkdown("---\nid: x\n正文没有闭合"), MarkdownParseError);
});

test("projectAll：memory 目录不存在时自动创建", () => {
  const fx = setup();
  try {
    seedFact(fx, "Eta 记忆条目内容");
    const run = fx.projector.projectAll();
    assert.equal(run.written.length, 1);
    assert.ok(existsSync(fx.memoryDir));
  } finally {
    teardown(fx);
  }
});
