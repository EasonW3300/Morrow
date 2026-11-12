// 会话元数据 seam 测试（票 M7-A-T2 / Issue #59）：
// 改名/归档/软删/恢复全部走账本事件，列表是对账本的折叠（无 sessions 表）。
// 30 天保留期用注入时钟拨快（零 sleep）；删除不影响记忆（同一 Runtime 内断言）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const DAY_MS = 24 * 60 * 60 * 1000;

interface ApiError {
  error: { code: string; message: string };
}

interface SessionSummary {
  session_id: string;
  event_id: string;
  sequence: number;
  occurred_at: string;
  title?: string;
  archived_at?: string;
  deleted_at?: string;
}

interface SessionMutation {
  session_id: string;
  event_id: string | null;
  sequence: number | null;
  changed: boolean;
  title?: string;
  archived_at?: string | null;
  deleted_at?: string | null;
}

interface FactHit {
  id: string;
  stage: string;
  content: string;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function fakeFactory(script: FakeStep[]) {
  return async () => createFakePi({ script });
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function createSession(port: number, title?: string): Promise<SessionSummary> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
  assert.equal(res.status, 201);
  return json<SessionSummary>(res);
}

async function listSessions(port: number, include?: string): Promise<{ status: number; body: SessionSummary[] | ApiError }> {
  const query = include === undefined ? "" : `?include=${encodeURIComponent(include)}`;
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions${query}`);
  const body = (await res.json()) as { sessions: SessionSummary[] } | ApiError;
  return { status: res.status, body: "sessions" in body ? body.sessions : body };
}

async function mutate(port: number, sessionId: string, action: string, body?: object): Promise<{ status: number; body: SessionMutation | ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as SessionMutation | ApiError };
}

async function softDelete(port: number, sessionId: string): Promise<{ status: number; body: SessionMutation | ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}`, { method: "DELETE" });
  return { status: res.status, body: (await res.json()) as SessionMutation | ApiError };
}

async function allEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

async function searchFacts(port: number, q: string): Promise<FactHit[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/facts?q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200);
  return (await json<{ facts: FactHit[] }>(res)).facts;
}

test("折叠按事件顺序：rename → archive → unarchive → delete → restore 后状态正确（后写覆盖前写）", async () => {
  const dir = tmpDir("morrow-sess-fold-");
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory([]) });
  try {
    const created = await createSession(runtime.port, "原始标题");

    const renamed = await mutate(runtime.port, created.session_id, "rename", { title: "  改过的标题  " });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.body as SessionMutation).title, "改过的标题");

    let list = await listSessions(runtime.port);
    assert.equal(list.status, 200);
    assert.equal((list.body as SessionSummary[])[0].title, "改过的标题", "改名后列表即时反映");

    const archived = await mutate(runtime.port, created.session_id, "archive");
    assert.equal(archived.status, 200);
    assert.ok((archived.body as SessionMutation).archived_at);
    assert.equal((await listSessions(runtime.port)).body instanceof Array, true);
    assert.equal(((await listSessions(runtime.port)).body as SessionSummary[]).length, 0, "归档后默认列表收起");

    const archivedList = await listSessions(runtime.port, "archived");
    assert.equal((archivedList.body as SessionSummary[]).length, 1);
    assert.equal((archivedList.body as SessionSummary[])[0].title, "改过的标题");
    assert.ok((archivedList.body as SessionSummary[])[0].archived_at);

    const unarchived = await mutate(runtime.port, created.session_id, "unarchive");
    assert.equal(unarchived.status, 200);
    list = await listSessions(runtime.port);
    assert.equal((list.body as SessionSummary[]).length, 1, "取消归档后回到主列表");
    assert.equal((list.body as SessionSummary[])[0].archived_at, undefined);

    // 归档后删除：两个维度互不覆盖；恢复后回到归档态（archive 事件仍在）
    await mutate(runtime.port, created.session_id, "archive");
    const deleted = await softDelete(runtime.port, created.session_id);
    assert.equal(deleted.status, 200);
    assert.ok((deleted.body as SessionMutation).deleted_at);
    assert.equal((await listSessions(runtime.port)).body instanceof Array, true);
    assert.equal(((await listSessions(runtime.port)).body as SessionSummary[]).length, 0, "软删后主列表消失");
    assert.equal(((await listSessions(runtime.port, "all")).body as SessionSummary[]).length, 1, "include=all 可见已删");

    const restored = await mutate(runtime.port, created.session_id, "restore");
    assert.equal(restored.status, 200);
    const all = await listSessions(runtime.port, "all");
    assert.equal((all.body as SessionSummary[]).length, 1);
    assert.equal((all.body as SessionSummary[])[0].deleted_at, undefined);
    assert.ok((all.body as SessionSummary[])[0].archived_at, "恢复只清删除标记，归档态保留");

    // 事件族 actor=owner、带 session_id、payload 记录标题
    const events = (await allEvents(runtime.port)).filter((e) => e.session_id === created.session_id);
    assert.deepEqual(
      events.map((e) => e.event_type),
      [
        "session.created",
        "session.renamed",
        "session.archived",
        "session.unarchived",
        "session.archived",
        "session.deleted",
        "session.restored",
      ],
    );
    for (const event of events.slice(1)) assert.equal(event.actor_id, "owner");
    assert.equal(events.find((e) => e.event_type === "session.renamed")?.payload.title, "改过的标题");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("软删 30 天到期：注入时钟拨快后从所有折叠视图剔除，账本事件保留；恢复返回 409", async () => {
  const dir = tmpDir("morrow-sess-expiry-");
  let nowMs = Date.now();
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([]),
    sessionsNow: () => new Date(nowMs),
  });
  try {
    const created = await createSession(runtime.port, "会过期的会话");
    const deleted = await softDelete(runtime.port, created.session_id);
    assert.equal(deleted.status, 200);

    assert.equal(((await listSessions(runtime.port, "all")).body as SessionSummary[]).length, 1);
    assert.equal(((await listSessions(runtime.port, "deleted")).body as SessionSummary[]).length, 1);

    nowMs += 30 * DAY_MS + 1000;
    assert.equal(((await listSessions(runtime.port)).body as SessionSummary[]).length, 0);
    assert.equal(((await listSessions(runtime.port, "deleted")).body as SessionSummary[]).length, 0);
    assert.equal(((await listSessions(runtime.port, "all")).body as SessionSummary[]).length, 0, "过期删除从折叠结果剔除");

    const restore = await mutate(runtime.port, created.session_id, "restore");
    assert.equal(restore.status, 409);
    assert.equal((restore.body as ApiError).error.code, "restore_window_expired");

    const events = (await allEvents(runtime.port)).filter((e) => e.session_id === created.session_id);
    assert.ok(events.some((e) => e.event_type === "session.deleted"), "账本事件保留");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("删除不影响记忆：会话产生的事实删会话后仍可检索", async () => {
  const dir = tmpDir("morrow-sess-memory-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["好的，已记录"] }]),
  });
  try {
    const created = await createSession(runtime.port);
    const send = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${created.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "我喜欢用 TypeScript 写脚本。" }),
    });
    assert.equal(send.status, 202);

    await waitFor("memory.extracted", async () =>
      (await allEvents(runtime.port)).some((e) => e.event_type === "memory.extracted"),
    );
    const before = await searchFacts(runtime.port, "TypeScript");
    assert.ok(before.some((fact) => fact.stage === "fact"), "删除前事实可检索");

    const deleted = await softDelete(runtime.port, created.session_id);
    assert.equal(deleted.status, 200);

    const after = await searchFacts(runtime.port, "TypeScript");
    assert.ok(after.some((fact) => fact.stage === "fact" && fact.content.includes("TypeScript")), "删除会话后记忆仍可检索");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("端点守卫：未知会话 404、重复删除幂等、标题校验、非删除态恢复 409、非法 include 400", async () => {
  const dir = tmpDir("morrow-sess-guards-");
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory([]) });
  try {
    const ghost = "01936b9d-0000-7000-8000-000000000000";
    for (const action of ["rename", "archive", "unarchive", "restore"]) {
      const res = await mutate(runtime.port, ghost, action, action === "rename" ? { title: "x" } : undefined);
      assert.equal(res.status, 404, `${action} 未知会话 404`);
    }
    assert.equal((await softDelete(runtime.port, ghost)).status, 404);

    const created = await createSession(runtime.port);
    assert.equal((await mutate(runtime.port, created.session_id, "rename", { title: "" })).status, 400);
    assert.equal((await mutate(runtime.port, created.session_id, "rename", { title: "   " })).status, 400);
    assert.equal((await mutate(runtime.port, created.session_id, "rename", { title: "a".repeat(121) })).status, 400);
    const maxTitle = await mutate(runtime.port, created.session_id, "rename", { title: "a".repeat(120) });
    assert.equal(maxTitle.status, 200, "120 字上限可用");

    const nonDeletedRestore = await mutate(runtime.port, created.session_id, "restore");
    assert.equal(nonDeletedRestore.status, 409);
    assert.equal((nonDeletedRestore.body as ApiError).error.code, "session_not_deleted");

    const first = await softDelete(runtime.port, created.session_id);
    assert.equal(first.status, 200);
    const second = await softDelete(runtime.port, created.session_id);
    assert.equal(second.status, 200, "重复删除幂等");
    assert.equal((second.body as SessionMutation).changed, false);
    assert.equal(
      (second.body as SessionMutation).deleted_at,
      (first.body as SessionMutation).deleted_at,
      "重复删除不延长保留期",
    );
    const deleteEvents = (await allEvents(runtime.port)).filter(
      (e) => e.session_id === created.session_id && e.event_type === "session.deleted",
    );
    assert.equal(deleteEvents.length, 1, "幂等删除不追加新事件");

    assert.equal((await listSessions(runtime.port, "bogus")).status, 400);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
