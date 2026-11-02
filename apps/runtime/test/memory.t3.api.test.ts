// 受控导入 / 删除标记 / 投影命令 API 测试（票 M1-T3 / Issue #15，FR-MEM-6/8）：
// startRuntime 接线（零网络，无会话——直接经 handle.ledger + memory.extractTurn 种事实）。
// 覆盖票面验收：导入合法编辑生成版本化修订（fact_updated + MemoryRevision + 投影刷新）、
// locked/敏感冲突进待确认队列不直写、stale_version 409 防覆盖、删除生成 tombstone 事件
// 且投影文件移除、重投影不复活已删记忆、locked 删除需 confirm、投影命令 curl 可演示。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SensitivityLevel } from "@morrow/protocol";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import type { MemoryExtractor, ExtractionInput } from "../src/memory/extraction.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SESSION = "01936b9d-8f7a-7abc-9f2e-000000000003";

interface ApiError {
  error: { code: string; message: string };
}

interface ImportResult {
  status: "updated" | "conflict" | "unchanged";
  fact_id: string;
  version: number;
  revision_id?: string | null;
  conflict_id?: string;
  reason?: string;
  import_event_id: string;
  event_id?: string;
}

interface ProjectResult {
  directory: string;
  written: string[];
  unchanged: string[];
  removed: string[];
}

/** 抽取桩：本轮用户文本原样成候选（confidence 0.9 → 自动巩固），sensitivity 可控 */
function stubExtractor(sensitivity: { current: SensitivityLevel }): MemoryExtractor {
  return {
    extract: (input: ExtractionInput) => [
      {
        content: input.userText.trim(),
        kind: "fact" as const,
        confidence: 0.9,
        sensitivity: sensitivity.current,
        rule: "t3-stub",
      },
    ],
  };
}

interface Fixture {
  handle: RuntimeHandle;
  dir: string;
  memoryDir: string;
  sensitivity: { current: SensitivityLevel };
}

async function setup(): Promise<Fixture> {
  const dir = tmpDir("morrow-mem-t3-");
  const sensitivity = { current: "private" as SensitivityLevel };
  const handle = await startRuntime(
    { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null },
    { memoryExtractor: stubExtractor(sensitivity) },
  );
  return { handle, dir, memoryDir: join(dir, "memory"), sensitivity };
}

async function teardown(fx: Fixture): Promise<void> {
  await fx.handle.close();
  removeDir(fx.dir);
}

/** 种一条事实（message.user 入账 → 抽取 → 自动巩固），返回 fact_id */
async function seedFact(fx: Fixture, content: string): Promise<string> {
  const user = buildEventEnvelope({
    replicaId: REPLICA,
    actorId: "owner",
    eventType: "message.user",
    sessionId: SESSION,
    payload: { text: content },
  });
  fx.handle.ledger.append(user);
  const run = await fx.handle.memory.extractTurn({
    sessionId: SESSION,
    userEventId: user.event_id,
    occurredAt: user.occurred_at,
    text: content,
  });
  const factId = run.consolidation?.createdFactIds[0];
  assert.ok(factId !== undefined, `seedFact: expected one consolidated fact for ${content}`);
  return factId;
}

async function project(fx: Fixture): Promise<ProjectResult> {
  const res = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/project`, { method: "POST" });
  assert.equal(res.status, 200);
  return (await json<ProjectResult>(res));
}

async function importMarkdown(fx: Fixture, markdown: string): Promise<{ status: number; body: ImportResult | ApiError }> {
  const res = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  return { status: res.status, body: (await res.json()) as ImportResult | ApiError };
}

async function deleteFact(fx: Fixture, factId: string, confirm?: boolean): Promise<{ status: number; body: Record<string, unknown> | ApiError }> {
  const url = `http://127.0.0.1:${fx.handle.port}/v1/memory/facts/${factId}${confirm === undefined ? "" : `?confirm=${confirm}`}`;
  const res = await fetch(url, { method: "DELETE" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> | ApiError };
}

async function allEvents(fx: Fixture): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

function fileOf(fx: Fixture, factId: string): string {
  return join(fx.memoryDir, `${factId}.md`);
}

/** 导入用的编辑版 Markdown：frontmatter 原样保留（id/version/sensitivity），正文替换 */
function editBody(original: string, newContent: string, overrides: Record<string, string> = {}): string {
  const lines = original.split("\n");
  const close = lines.indexOf("---", 1);
  const edited = lines.slice(0, close + 1).map((line) => {
    for (const [key, value] of Object.entries(overrides)) {
      if (line.startsWith(`${key}:`)) return `${key}: ${value}`;
    }
    return line;
  });
  return `${edited.join("\n")}\n\n${newContent}\n`;
}

test("POST /v1/memory/project：投影 curl 可演示，frontmatter 带 §6.4 字段，再跑幂等", async () => {
  const fx = await setup();
  try {
    await seedFact(fx, "Kilo-alpha 集群每天凌晨备份索引");
    const first = await project(fx);
    assert.equal(first.written.length, 1);
    assert.equal(first.removed.length, 0);
    const file = fileOf(fx, first.written[0]);
    assert.ok(existsSync(file));
    const md = readFileSync(file, "utf8");
    assert.ok(md.startsWith("---\nid: "), `frontmatter must start with id, got: ${md.slice(0, 40)}`);
    for (const key of ["type:", "sensitivity:", "confidence:", "valid_from:", "valid_until:", "sources:", "created_at:", "updated_at:", "version:"]) {
      assert.ok(md.includes(`\n${key} `) || md.includes(`\n${key}`), `frontmatter missing ${key}`);
    }
    const second = await project(fx);
    assert.equal(second.written.length, 0, "regeneration must be idempotent");
    assert.equal(second.unchanged.length, 1);
  } finally {
    await teardown(fx);
  }
});

test("受控导入：正文编辑 → 版本化修订（fact_updated + revision）+ 投影文件刷新", async () => {
  const fx = await setup();
  try {
    const factId = await seedFact(fx, "Lima-bravo 报表在每月一日出账");
    await project(fx);
    const original = readFileSync(fileOf(fx, factId), "utf8");
    const edited = editBody(original, "Lima-bravo 报表改在每季度首日出账");

    const result = await importMarkdown(fx, edited);
    assert.equal(result.status, 200);
    const body = result.body as ImportResult;
    assert.equal(body.status, "updated");
    assert.equal(body.fact_id, factId);
    assert.equal(body.version, 2);
    assert.ok(body.revision_id, "revision id must be returned");
    assert.ok(body.import_event_id, "import evidence event id must be returned");

    // 版本链推进落账：memory.fact_updated（reason=manual_import）+ tombstone 无
    const events = await allEvents(fx);
    const updated = events.find((e) => e.event_type === "memory.fact_updated");
    assert.ok(updated !== undefined, "memory.fact_updated must be appended");
    assert.equal((updated.payload as Record<string, unknown>).reason, "manual_import");
    assert.equal((updated.payload as Record<string, unknown>).fact_id, factId);
    // 导入证据事件在账本上存在（回链）
    assert.ok(events.some((e) => e.event_id === body.import_event_id && e.event_type === "memory.import_received"));

    // 检索面跟随新内容
    const searchRes = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/facts?q=季度`);
    assert.equal(searchRes.status, 200);
    const hits = (await json<{ facts: Array<{ id: string; content: string; version: number }> }>(searchRes)).facts;
    assert.ok(hits.some((h) => h.id === factId && h.content === "Lima-bravo 报表改在每季度首日出账" && h.version === 2));

    // 投影文件同步刷新（导入后单事实 writeFact）
    const refreshed = readFileSync(fileOf(fx, factId), "utf8");
    assert.ok(refreshed.includes("version: 2"));
    assert.ok(refreshed.includes("Lima-bravo 报表改在每季度首日出账"));
  } finally {
    await teardown(fx);
  }
});

test("受控导入：内容与分级都未变 → unchanged（不推进版本、不写修订）", async () => {
  const fx = await setup();
  try {
    const factId = await seedFact(fx, "Mike-charlie 构建用 Node 24 LTS");
    await project(fx);
    const original = readFileSync(fileOf(fx, factId), "utf8");
    const result = await importMarkdown(fx, original);
    assert.equal(result.status, 200);
    const body = result.body as ImportResult;
    assert.equal(body.status, "unchanged");
    assert.equal(body.version, 1);
    assert.equal((await allEvents(fx)).filter((e) => e.event_type === "memory.fact_updated").length, 0);
  } finally {
    await teardown(fx);
  }
});

test("受控导入：frontmatter version 与库内不一致 → 409 stale_version（防覆盖）", async () => {
  const fx = await setup();
  try {
    const factId = await seedFact(fx, "November-delta 发布窗口在周二");
    await project(fx);
    const original = readFileSync(fileOf(fx, factId), "utf8");
    // 先合法编辑一次 → 库内 version 2；再用旧 frontmatter（version 1）导入必须被拒
    const first = await importMarkdown(fx, editBody(original, "November-delta 发布窗口改到周三"));
    assert.equal(first.status, 200);
    const stale = await importMarkdown(fx, original);
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ApiError).error.code, "memory_stale_version");
    const searchRes = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/facts?q=周三`);
    const hits = (await json<{ facts: Array<{ content: string; version: number }> }>(searchRes)).facts;
    assert.ok(hits.some((h) => h.content === "November-delta 发布窗口改到周三" && h.version === 2), "stale import must not overwrite");
  } finally {
    await teardown(fx);
  }
});

test("受控导入：locked 事实的内容编辑 → 冲突进待确认队列，不直写；裁决 keep_new 后生效", async () => {
  const fx = await setup();
  try {
    fx.sensitivity.current = "locked";
    const factId = await seedFact(fx, "Oscar-echo 审计保留期是十年");
    fx.sensitivity.current = "private";
    await project(fx);
    const original = readFileSync(fileOf(fx, factId), "utf8");
    const edited = editBody(original, "Oscar-echo 审计保留期改为七年");

    const result = await importMarkdown(fx, edited);
    assert.equal(result.status, 200);
    const body = result.body as ImportResult;
    assert.equal(body.status, "conflict");
    assert.equal(body.reason, "locked");
    assert.ok(body.conflict_id);
    assert.equal(body.version, 1, "locked edit must not write directly");

    // 待确认队列可见
    const conflictsRes = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/conflicts?status=open`);
    const conflicts = (await json<{ conflicts: Array<{ conflict_id: string; reason: string; fact_id: string }> }>(conflictsRes)).conflicts;
    assert.ok(conflicts.some((c) => c.conflict_id === body.conflict_id && c.reason === "locked" && c.fact_id === factId));

    // 裁决 keep_new → 采纳编辑值，版本链推进
    const resolveRes = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/conflicts/${body.conflict_id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "keep_new" }),
    });
    assert.equal(resolveRes.status, 200);
    const searchRes = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/facts?q=七年`);
    const hits = (await json<{ facts: Array<{ id: string; content: string; version: number }> }>(searchRes)).facts;
    assert.ok(hits.some((h) => h.id === factId && h.version === 2));
  } finally {
    await teardown(fx);
  }
});

test("受控导入：敏感等级变更（private → public）→ 冲突 sensitivity_change，不静默放行", async () => {
  const fx = await setup();
  try {
    const factId = await seedFact(fx, "Papa-foxtrot 的内网地址是 10.0.0.7");
    await project(fx);
    const original = readFileSync(fileOf(fx, factId), "utf8");
    const edited = editBody(original, "Papa-foxtrot 的内网地址改成 10.0.0.9", { sensitivity: "public" });

    const result = await importMarkdown(fx, edited);
    assert.equal(result.status, 200);
    const body = result.body as ImportResult;
    assert.equal(body.status, "conflict");
    assert.equal(body.reason, "sensitivity_change");
    const searchRes = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/facts?q=10.0.0.7`);
    const hits = (await json<{ facts: Array<{ sensitivity: string; version: number }> }>(searchRes)).facts;
    assert.ok(hits.some((h) => h.sensitivity === "private" && h.version === 1), "sensitivity must not change silently");
  } finally {
    await teardown(fx);
  }
});

test("受控导入：未知事实 404 / 缺 frontmatter 400 / 缺 markdown 字段 400 / 非 JSON 415", async () => {
  const fx = await setup();
  try {
    const unknown = await importMarkdown(fx, "---\nid: 01936b9d-8f7a-7abc-9f2e-00000000beef\nversion: 1\n---\n\n正文\n");
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body as ApiError).error.code, "memory_not_found");

    const malformed = await importMarkdown(fx, "没有 frontmatter 的普通文本");
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as ApiError).error.code, "memory_invalid_input");

    const missing = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fact_id: "x", content: "y" }),
    });
    assert.equal(missing.status, 400);

    const wrongType = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/import`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "---\nid: x\n---\n\ny\n",
    });
    assert.equal(wrongType.status, 415);
  } finally {
    await teardown(fx);
  }
});

test("DELETE /v1/memory/facts/:id：tombstone 事件 + 投影文件移除 + 检索退出 + 重投影不复活", async () => {
  const fx = await setup();
  try {
    const kept = await seedFact(fx, "Quebec-golf 团站会在周一");
    const doomed = await seedFact(fx, "Romeo-hotel 的证书九月到期");
    await project(fx);
    assert.ok(existsSync(fileOf(fx, doomed)));

    const result = await deleteFact(fx, doomed);
    assert.equal(result.status, 200);
    const body = result.body as Record<string, unknown>;
    assert.equal(body.deleted, true);
    assert.equal(body.fact_id, doomed);
    const tombstoneId = body.event_id as string;

    // tombstone 事件入账本（信封完整，payload 带事实终态供 M3 传播）
    const events = await allEvents(fx);
    const tombstone = events.find((e) => e.event_id === tombstoneId);
    assert.ok(tombstone !== undefined, "memory.fact_deleted must be in the ledger");
    assert.equal(tombstone.event_type, "memory.fact_deleted");
    assert.equal((tombstone.payload as Record<string, unknown>).fact_id, doomed);
    assert.ok(typeof (tombstone.payload as Record<string, unknown>).content === "string");

    // 投影文件移除 + 重投影不复活
    assert.ok(!existsSync(fileOf(fx, doomed)));
    const rerun = await project(fx);
    assert.ok(!rerun.written.includes(doomed), "re-projection must not resurrect deleted memory");
    assert.ok(!existsSync(fileOf(fx, doomed)));
    assert.ok(existsSync(fileOf(fx, kept)), "unrelated projections stay");

    // 检索面退出
    const searchRes = await fetch(`http://127.0.0.1:${fx.handle.port}/v1/memory/facts?q=证书`);
    const hits = (await json<{ facts: Array<{ id: string }> }>(searchRes)).facts;
    assert.ok(!hits.some((h) => h.id === doomed));
  } finally {
    await teardown(fx);
  }
});

test("DELETE locked 事实：默认拒绝（409 memory_locked_confirm），?confirm=true 后删除", async () => {
  const fx = await setup();
  try {
    fx.sensitivity.current = "locked";
    const factId = await seedFact(fx, "Sierra-juliet 的根口令每季度轮换");
    fx.sensitivity.current = "private";
    await project(fx);

    const refused = await deleteFact(fx, factId);
    assert.equal(refused.status, 409);
    assert.equal((refused.body as ApiError).error.code, "memory_locked_confirm");
    assert.ok(existsSync(fileOf(fx, factId)), "projection must stay after refusal");

    const confirmed = await deleteFact(fx, factId, true);
    assert.equal(confirmed.status, 200);
    assert.ok(!existsSync(fileOf(fx, factId)));
    assert.ok((await allEvents(fx)).some((e) => e.event_type === "memory.fact_deleted"));
  } finally {
    await teardown(fx);
  }
});

test("DELETE 未知或已删事实 → 404", async () => {
  const fx = await setup();
  try {
    const missing = await deleteFact(fx, "01936b9d-8f7a-7abc-9f2e-00000000beef");
    assert.equal(missing.status, 404);
    assert.equal((missing.body as ApiError).error.code, "memory_not_found");

    const factId = await seedFact(fx, "Tango-kilo 临时目录每周清理");
    await deleteFact(fx, factId);
    const again = await deleteFact(fx, factId);
    assert.equal(again.status, 404, "already-deleted fact is gone from the API surface");
  } finally {
    await teardown(fx);
  }
});
