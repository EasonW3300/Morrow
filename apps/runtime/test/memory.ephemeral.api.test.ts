// 临时会话与记忆作用域端到端测试（票 M7-A-T3 / Issue #60，ADR-0010）：
//   - POST /v1/sessions kind=ephemeral → session.created payload 记录 kind
//   - 临时会话写入 scope=session:<id>：全局检索不到、会话作用域检索得到
//   - POST /v1/memory/:id/promote（candidate 与 fact）→ owner + memory.promoted
//   - 关闭后 24h 内可恢复；到期后作用域检索不到而账本事件仍在（注入时钟，零 sleep）
//   - 临时会话调用写入类能力 → 403（权限网关判定，非 UI 单点）
// 接缝：HTTP 控制 API（与既有 memory.*.api.test.ts 同款黑盒口径）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { CapabilityManifest, EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface FactHit {
  id: string;
  stage: string;
  type: string;
  content: string;
  sensitivity: string;
  scope: string;
  version: number;
  sources: string[];
}

interface SessionSummaryView {
  session_id: string;
  kind?: string;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function fakeFactory(script: FakeStep[]) {
  return async (_sessionId: string, _provider: unknown, extras?: { tools?: MorrowTool[] }) =>
    createFakePi({ script, tools: extras?.tools ?? [] });
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function allEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

async function createSession(
  port: number,
  body: Record<string, unknown> = {},
): Promise<{ session_id: string; kind?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await json<{ session_id: string; kind?: string }>(res));
}

async function send(port: number, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
}

/** 发消息并等本轮收尾 + 后台管线落定（看到 memory.extracted 即整轮完成） */
async function sendAndSettle(port: number, sessionId: string, text: string): Promise<void> {
  await send(port, sessionId, text);
  await waitFor("message.assistant", async () =>
    (await allEvents(port)).some((e) => e.event_type === "message.assistant"),
  );
  const assistantId = (await allEvents(port))
    .filter((e) => e.event_type === "message.assistant")
    .at(-1)?.event_id;
  await waitFor("memory.extracted for this turn", async () =>
    (await allEvents(port)).some((e) => e.event_type === "memory.extracted" && e.causation_id === assistantId),
  );
}

async function searchFacts(
  port: number,
  q: string,
  scope?: string,
  includeCandidates = false,
): Promise<{ status: number; body: { facts: FactHit[] } | ApiError }> {
  const params = new URLSearchParams({ q });
  if (scope !== undefined) params.set("scope", scope);
  if (includeCandidates) params.set("include", "candidates");
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/facts?${params.toString()}`);
  return { status: res.status, body: (await res.json()) as { facts: FactHit[] } | ApiError };
}

async function postJson(
  port: number,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await json(res)) as Record<string, unknown> & ApiError };
}

test("kind：缺省 normal，ephemeral 记录进 session.created payload 与会话列表", async () => {
  const dir = tmpDir("morrow-eph-kind-");
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["ok"] }]) });
  try {
    const normal = await createSession(runtime.port, { title: "日常" });
    assert.equal(normal.kind, "normal");
    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    assert.equal(ephemeral.kind, "ephemeral");

    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`);
    const list = (await json<{ sessions: SessionSummaryView[] }>(res)).sessions;
    assert.equal(list.find((s) => s.session_id === normal.session_id)?.kind, "normal");
    assert.equal(list.find((s) => s.session_id === ephemeral.session_id)?.kind, "ephemeral");

    const created = (await allEvents(runtime.port)).filter(
      (e) => e.event_type === "session.created" && e.session_id === ephemeral.session_id,
    );
    assert.equal(created.length, 1);
    assert.equal(created[0].payload.kind, "ephemeral");

    const bad = await postJson(runtime.port, "/v1/sessions", { kind: "forever" });
    assert.equal(bad.status, 400);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("作用域写入：临时会话『记住 X』→ 全局搜不到、会话上下文搜得到；promote 后全局可见并留 memory.promoted", async () => {
  const dir = tmpDir("morrow-eph-scope-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["记住了"] }]),
  });
  try {
    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    const scope = `session:${ephemeral.session_id}`;
    await sendAndSettle(runtime.port, ephemeral.session_id, "请记住 我的备用钥匙放在书房抽屉");

    const global = await searchFacts(runtime.port, "备用钥匙");
    assert.equal(global.status, 200);
    assert.deepEqual((global.body as { facts: FactHit[] }).facts, [], "全局检索看不到临时会话写入");

    const scoped = await searchFacts(runtime.port, "备用钥匙", scope);
    assert.equal(scoped.status, 200);
    const scopedFacts = (scoped.body as { facts: FactHit[] }).facts;
    assert.equal(scopedFacts.length, 1, "会话作用域检索得到");
    assert.equal(scopedFacts[0].scope, scope);
    assert.equal(scopedFacts[0].stage, "fact");

    // memory.write 工具路径同样落在 session 作用域（#persist 统一推导）
    const toolWrite = await postJson(
      runtime.port,
      `/v1/capabilities/memory.write/invoke?session_id=${encodeURIComponent(ephemeral.session_id)}`,
      { content: "临时工具写入：备用钥匙的备用位置在鞋柜", kind: "fact" },
    );
    assert.equal(toolWrite.status, 200, JSON.stringify(toolWrite.body));
    const toolGlobal = await searchFacts(runtime.port, "鞋柜");
    assert.equal((toolGlobal.body as { facts: FactHit[] }).facts.length, 0, "工具写入不进全局");
    const toolScoped = await searchFacts(runtime.port, "鞋柜", scope, true);
    assert.equal((toolScoped.body as { facts: FactHit[] }).facts.length, 1, "工具写入在会话作用域可见");
    assert.equal((toolScoped.body as { facts: FactHit[] }).facts[0].scope, scope);

    // 全局（owner）作用域仍读得到既有长期记忆，且不受临时写入影响
    const ownerScope = await searchFacts(runtime.port, "备用钥匙", "owner");
    assert.deepEqual((ownerScope.body as { facts: FactHit[] }).facts, []);

    const promote = await postJson(runtime.port, `/v1/memory/${scopedFacts[0].id}/promote`);
    assert.equal(promote.status, 200, JSON.stringify(promote.body));
    assert.equal(promote.body.from_scope, scope);
    assert.equal(promote.body.to_scope, "owner");

    const promotedGlobal = await searchFacts(runtime.port, "备用钥匙");
    const promotedFacts = (promotedGlobal.body as { facts: FactHit[] }).facts;
    assert.equal(promotedFacts.length, 1, "提升后全局可见");
    assert.equal(promotedFacts[0].scope, "owner");

    const promotedEvents = (await allEvents(runtime.port)).filter((e) => e.event_type === "memory.promoted");
    assert.equal(promotedEvents.length, 1);
    assert.equal(promotedEvents[0].payload.from_scope, scope);
    assert.equal(promotedEvents[0].payload.entry_kind, "fact");

    // 非 session scope 再提升 → 409
    const again = await postJson(runtime.port, `/v1/memory/${scopedFacts[0].id}/promote`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "memory_invalid_state");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("promote candidate：pending 候选转 owner，accept 后事实进全局（低置信候选留 pending）", async () => {
  const dir = tmpDir("morrow-eph-candidate-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["好的"] }]),
  });
  try {
    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    const scope = `session:${ephemeral.session_id}`;
    // procedure 规则置信度 0.7 < 自动巩固线 0.8 → 留 pending
    await sendAndSettle(runtime.port, ephemeral.session_id, "以后每次部署前先跑完整测试");

    const scoped = await searchFacts(runtime.port, "部署前", scope, true);
    const hits = (scoped.body as { facts: FactHit[] }).facts;
    const candidate = hits.find((hit) => hit.stage === "candidate");
    assert.ok(candidate, "临时会话候选可检索");
    assert.equal(candidate.scope, scope);

    const globalAll = await searchFacts(runtime.port, "部署前", undefined, true);
    assert.equal(
      (globalAll.body as { facts: FactHit[] }).facts.some((hit) => hit.stage === "candidate"),
      false,
      "全局禁用视图看不到临时候选",
    );

    const promote = await postJson(runtime.port, `/v1/memory/${candidate.id}/promote`);
    assert.equal(promote.status, 200, JSON.stringify(promote.body));
    assert.equal(promote.body.entry_kind, "candidate");

    const decided = await postJson(runtime.port, `/v1/memory/candidates/${candidate.id}/decide`, { decision: "accept" });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));

    const global = await searchFacts(runtime.port, "部署前");
    const facts = (global.body as { facts: FactHit[] }).facts;
    assert.equal(facts.length, 1, "提升候选后巩固出的事实属于 owner 作用域");
    assert.equal(facts[0].scope, "owner");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("24h：关闭后可恢复；到期后作用域检索不到而账本事件仍在（注入时钟，零 sleep）", async () => {
  const dir = tmpDir("morrow-eph-ttl-");
  let now = new Date("2026-11-12T00:00:00.000Z");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["记住了"] }]),
    sessionNow: () => new Date(now),
  });
  try {
    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    const scope = `session:${ephemeral.session_id}`;
    await sendAndSettle(runtime.port, ephemeral.session_id, "请记住 我的航班是周三上午十点");

    // 关闭：24h 内作用域内仍可见（可恢复窗口）
    const closed = await postJson(runtime.port, `/v1/sessions/${ephemeral.session_id}/close`);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.closed_at, now.toISOString());
    assert.equal(closed.body.restorable_until, new Date(now.getTime() + 24 * 3600 * 1000).toISOString());

    const during = await searchFacts(runtime.port, "航班", scope);
    assert.equal((during.body as { facts: FactHit[] }).facts.length, 1, "关闭但未到期：作用域仍可见");

    const closeEvent = (await allEvents(runtime.port)).find((e) => e.event_type === "session.ephemeral_closed");
    assert.ok(closeEvent, "session.ephemeral_closed 入账本");
    assert.equal(closeEvent.payload.kind, "ephemeral");

    // 已关闭的会话不能再发消息（恢复后才可继续）
    const rejected = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${ephemeral.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "还在吗" }),
    });
    assert.equal(rejected.status, 409);

    now = new Date(now.getTime() + 25 * 3600 * 1000);
    const expired = await searchFacts(runtime.port, "航班", scope);
    assert.deepEqual((expired.body as { facts: FactHit[] }).facts, [], "到期后作用域检索不到");

    const events = await allEvents(runtime.port);
    assert.ok(events.some((e) => e.event_type === "memory.candidate_created"), "账本候选事件仍在");
    assert.ok(events.some((e) => e.event_type === "memory.fact_created"), "账本事实事件仍在");

    const lateRestore = await postJson(runtime.port, `/v1/sessions/${ephemeral.session_id}/restore`);
    assert.equal(lateRestore.status, 409);
    assert.equal(lateRestore.body.error.code, "session_expired");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("24h 内恢复：作用域记忆重新可见", async () => {
  const dir = tmpDir("morrow-eph-restore-");
  let now = new Date("2026-11-12T08:00:00.000Z");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["记住了"] }]),
    sessionNow: () => new Date(now),
  });
  try {
    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    const scope = `session:${ephemeral.session_id}`;
    await sendAndSettle(runtime.port, ephemeral.session_id, "请记住 备用钥匙在玄关柜");
    assert.equal((await postJson(runtime.port, `/v1/sessions/${ephemeral.session_id}/close`)).status, 200);

    now = new Date(now.getTime() + 60 * 60 * 1000);
    const restored = await postJson(runtime.port, `/v1/sessions/${ephemeral.session_id}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));

    const after = await searchFacts(runtime.port, "备用钥匙", scope);
    assert.equal((after.body as { facts: FactHit[] }).facts.length, 1, "恢复后作用域记忆可见");

    const restoreEvent = (await allEvents(runtime.port)).find((e) => e.event_type === "session.ephemeral_restored");
    assert.ok(restoreEvent, "session.ephemeral_restored 入账本");

    // 普通会话关闭走 T5 语义（session.closed），不产生 ephemeral 的 24h 恢复窗口
    const normal = await createSession(runtime.port, {});
    const normalClosed = await postJson(runtime.port, `/v1/sessions/${normal.session_id}/close`);
    assert.equal(normalClosed.status, 200, JSON.stringify(normalClosed.body));
    assert.equal(normalClosed.body.restorable_until, undefined);
    assert.ok(
      (await allEvents(runtime.port)).some(
        (e) => e.event_type === "session.closed" && e.session_id === normal.session_id,
      ),
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("禁写入类能力：临时会话 invoke 写入类能力 403；无会话上下文不受该门影响", async () => {
  const dir = tmpDir("morrow-eph-cap-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["ok"] }]),
  });
  try {
    const grants = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filesystem: ["**"], network: [], shell: [], channels: [], credentials: [] }),
    });
    assert.equal(grants.status, 200, JSON.stringify(await grants.clone().json()));

    const manifest: CapabilityManifest = {
      name: "fs.writer",
      version: "1.0.0",
      author: "human",
      runtime: "typescript",
      permissions: { filesystem: ["**"], network: [], shell: [], channels: [], credentials: [] },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: { type: "none", network: "none", filesystem: "none" },
      tests: [],
    };
    const registered = await postJson(runtime.port, "/v1/capabilities", manifest);
    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    const denied = await postJson(
      runtime.port,
      `/v1/capabilities/fs.writer/invoke?session_id=${encodeURIComponent(ephemeral.session_id)}`,
      {},
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "capability_forbidden");

    // 同一能力在无会话上下文时不会被临时会话门拦（随后由执行链按 unknown_tool 处理）
    const withoutSession = await postJson(runtime.port, "/v1/capabilities/fs.writer/invoke", {});
    assert.notEqual(withoutSession.status, 403);

    // 读类能力（五维全空）在临时会话内不被该门拒绝
    const readManifest: CapabilityManifest = { ...manifest, name: "pure.reader", permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] } };
    assert.equal((await postJson(runtime.port, "/v1/capabilities", readManifest)).status, 201);
    const allowedThrough = await postJson(
      runtime.port,
      `/v1/capabilities/pure.reader/invoke?session_id=${encodeURIComponent(ephemeral.session_id)}`,
      {},
    );
    assert.notEqual(allowedThrough.status, 403);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
