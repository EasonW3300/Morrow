// 抽取/巩固管线端到端测试（票 M1-T2 / Issue #14）：startRuntime 接线 + FakePi 注入（无网络）。
// 覆盖票面验收：会话结束异步抽取（候选带来源/置信度/sensitivity + 运行事件）、巩固产生
// 事实 + 版本链、偏好自动更新留历史、冲突进待确认队列 + resolve 三裁决、候选/冲突端点
// 全流程 curl 可演示、异步抽取失败不影响会话主链路。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import type { MemoryExtractor } from "../src/memory/extraction.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface CandidateView {
  candidate_id: string;
  content: string;
  kind: string;
  sensitivity: string;
  confidence: number;
  source_event_id: string;
  version: number;
  status: string;
  created_at: string;
}

interface ConflictView {
  conflict_id: string;
  candidate_id: string;
  fact_id: string;
  reason: string;
  existing_content: string;
  incoming_content: string;
  status: string;
  resolution: string | null;
}

interface FactHit {
  id: string;
  stage: string;
  type: string;
  content: string;
  sensitivity: string;
  confidence?: number;
  version: number;
  sources: string[];
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

async function waitMemoryEvent(port: number, eventType: string): Promise<EventEnvelope> {
  await waitFor(`memory event ${eventType}`, async () =>
    (await allEvents(port)).some((e) => e.event_type === eventType),
  );
  return (await allEvents(port)).filter((e) => e.event_type === eventType).at(-1) as EventEnvelope;
}

async function createSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
  return (await json<{ session_id: string }>(res)).session_id;
}

async function send(port: number, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
}

/** 发消息并等本轮收尾 + 后台管线落定：等 memory.extracted 且 causation 指向本轮
 *  message.assistant——抽取事件与其后的巩固在同一同步块内落账，看到 extracted 即整轮管线已落定 */
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

async function getCandidates(port: number, status?: string): Promise<{ status: number; body: { candidates: CandidateView[] } | ApiError }> {
  const url = status === undefined ? "/v1/memory/candidates" : `/v1/memory/candidates?status=${status}`;
  const res = await fetch(`http://127.0.0.1:${port}${url}`);
  return { status: res.status, body: (await res.json()) as { candidates: CandidateView[] } | ApiError };
}

async function getConflicts(port: number, status?: string): Promise<{ status: number; body: { conflicts: ConflictView[] } | ApiError }> {
  const url = status === undefined ? "/v1/memory/conflicts" : `/v1/memory/conflicts?status=${status}`;
  const res = await fetch(`http://127.0.0.1:${port}${url}`);
  return { status: res.status, body: (await res.json()) as { conflicts: ConflictView[] } | ApiError };
}

async function resolveConflict(
  port: number,
  conflictId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> & Partial<ApiError> }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/conflicts/${conflictId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & Partial<ApiError> };
}

async function decideCandidate(
  port: number,
  candidateId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> & Partial<ApiError> }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/candidates/${candidateId}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & Partial<ApiError> };
}

async function searchFacts(port: number, q: string): Promise<FactHit[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/facts?q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200);
  return (await json<{ facts: FactHit[] }>(res)).facts;
}

test("端到端（M1-T2）：轮次收尾异步抽取 + 高置信候选自动巩固成事实 + memory.extracted/consolidated 运行事件", async () => {
  const dir = tmpDir("morrow-mem-t2-e2e-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["好的，已记录"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port);
    // 两句高价值：T1 即时路径只取首命中（偏好），后台抽取补上第二句（画像，0.7 留 pending）
    await sendAndSettle(runtime.port, sessionId, "我喜欢用 TypeScript 写脚本。我住在上海。");

    // 抽取运行事件：首句被去重（即时路径先写），第二句新写；causation 链 message.assistant
    const events = await allEvents(runtime.port);
    const extracted = events.find((e) => e.event_type === "memory.extracted");
    assert.ok(extracted !== undefined, "memory.extracted 已入账本");
    assert.equal(extracted.payload.extracted_count, 1);
    assert.equal(extracted.payload.skipped_duplicates, 1);
    const assistant = events.find((e) => e.event_type === "message.assistant");
    assert.equal(extracted.causation_id, assistant?.event_id, "抽取运行回链轮次收尾事件");

    const candidateEvent = events.find((e) => e.event_type === "memory.candidate_created" && e.payload.rule === "preference-statement");
    assert.ok(candidateEvent !== undefined);
    assert.equal(candidateEvent.payload.sensitivity, "private");
    assert.equal(candidateEvent.payload.confidence, 0.8);
    const userEvent = events.find((e) => e.event_id === candidateEvent.causation_id);
    assert.equal(userEvent?.event_type, "message.user", "候选证据回链 message.user");

    // 巩固运行事件 + 事实产生（即时路径写的 0.8 候选由轮次收尾的巩固批次补齐）
    const consolidated = events.find((e) => e.event_type === "memory.consolidated");
    assert.ok(consolidated !== undefined, "memory.consolidated 已入账本");
    assert.equal(consolidated.causation_id, extracted?.event_id, "巩固运行回链同轮抽取运行");
    assert.equal((consolidated.payload.created_fact_ids as string[]).length, 1);
    const factEvents = events.filter((e) => e.event_type === "memory.fact_created");
    assert.equal(factEvents.length, 1);
    assert.equal(factEvents[0].payload.content, "我喜欢用 TypeScript 写脚本");

    const hits = await searchFacts(runtime.port, "TypeScript");
    const factHit = hits.find((h) => h.stage === "fact");
    assert.ok(factHit !== undefined, "巩固后事实可检索");
    assert.equal(factHit.type, "preference");
    assert.equal(factHit.version, 1);
    assert.deepEqual(factHit.sources, [candidateEvent.causation_id], "事实来源回链原始 message.user");

    // 0.7 的画像候选留 pending（candidates 端点可见，带置信度与来源）
    const pending = (await getCandidates(runtime.port, "pending")).body as { candidates: CandidateView[] };
    assert.equal(pending.candidates.length, 1);
    assert.equal(pending.candidates[0].content, "我住在上海");
    assert.equal(pending.candidates[0].confidence, 0.7);
    assert.ok(pending.candidates[0].source_event_id.length > 0);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("端到端（M1-T2）：同主题偏好自动更新 → 版本链（memory.fact_updated + 修订留历史）", async () => {
  const dir = tmpDir("morrow-mem-t2-update-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["ok"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port);
    await sendAndSettle(runtime.port, sessionId, "我喜欢用 TypeScript 写脚本");
    await sendAndSettle(runtime.port, sessionId, "我偏好用 Go 写脚本");

    const events = await allEvents(runtime.port);
    const updates = events.filter((e) => e.event_type === "memory.fact_updated");
    assert.equal(updates.length, 1, "恰好一次版本链推进");
    assert.equal(updates[0].payload.version, 2);
    assert.equal(updates[0].payload.reason, "preference_update");
    assert.ok(updates[0].payload.revision_id !== null);

    const hits = await searchFacts(runtime.port, "Go 写脚本");
    const factHit = hits.find((h) => h.stage === "fact");
    assert.ok(factHit !== undefined);
    assert.equal(factHit.content, "我偏好用 Go 写脚本");
    assert.equal(factHit.version, 2);
    assert.equal(factHit.sources.length, 2, "版本链头部聚合两条来源证据");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("端到端（M1-T2）：低置信候选留 pending → candidates 端点 → decide accept/dismiss", async () => {
  const dir = tmpDir("morrow-mem-t2-decide-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["ok"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port);
    await sendAndSettle(runtime.port, sessionId, "我住在上海浦东");

    // 0.7 候选未达准入线：pending 列表可见，带来源 event_id / 置信度 / sensitivity
    const pending = await getCandidates(runtime.port, "pending");
    assert.equal(pending.status, 200);
    const rows = (pending.body as { candidates: CandidateView[] }).candidates;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "我住在上海浦东");
    assert.equal(rows[0].confidence, 0.7);
    assert.equal(rows[0].sensitivity, "private");
    assert.ok(rows[0].source_event_id.length > 0);
    const candidateId = rows[0].candidate_id;

    // 入参校验
    assert.equal((await getCandidates(runtime.port, "bogus")).status, 400);
    const badDecide = await decideCandidate(runtime.port, candidateId, { decision: "maybe" });
    assert.equal(badDecide.status, 400);

    // dismiss：拒绝 → status 更新，不进事实
    const secondTurn = await createSession(runtime.port);
    await sendAndSettle(runtime.port, secondTurn, "我住在杭州西湖");
    const pending2 = (await getCandidates(runtime.port, "pending")).body as { candidates: CandidateView[] };
    const dismissId = pending2.candidates.find((c) => c.content === "我住在杭州西湖")?.candidate_id as string;
    const dismissed = await decideCandidate(runtime.port, dismissId, { decision: "dismiss" });
    assert.equal(dismissed.status, 200);
    const afterDismiss = (await getCandidates(runtime.port, "dismissed")).body as { candidates: CandidateView[] };
    assert.equal(afterDismiss.candidates.some((c) => c.candidate_id === dismissId), true);

    // accept：采纳 → 进巩固（低置信候选也可由 Owner 显式转正）
    const accepted = await decideCandidate(runtime.port, candidateId, { decision: "accept" });
    assert.equal(accepted.status, 200);
    assert.equal((accepted.body.outcome as { kind: string }).kind, "fact_created");
    assert.ok((accepted.body.outcome as { fact_id?: string }).fact_id !== undefined);
    await waitFor("fact searchable", async () =>
      (await searchFacts(runtime.port, "上海浦东")).some((h) => h.stage === "fact"),
    );

    // 已决策候选再次 decide → 409
    const again = await decideCandidate(runtime.port, candidateId, { decision: "accept" });
    assert.equal(again.status, 409);
    // 未知候选 → 404
    assert.equal((await decideCandidate(runtime.port, "no-such-id", { decision: "accept" })).status, 404);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("端到端（M1-T2）：重大事实冲突自动进待确认队列 → keep_new / keep_old / merge 三裁决各自产生正确修订", async () => {
  const dir = tmpDir("morrow-mem-t2-conflict-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["ok"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port);
    // 显式记住（0.9）→ 事实 v1；后续同主题不同值 → 每轮自动冲突上报
    await sendAndSettle(runtime.port, sessionId, "请记住：我住在北京朝阳区");
    const factV1 = (await searchFacts(runtime.port, "北京朝阳")).find((h) => h.stage === "fact");
    assert.ok(factV1 !== undefined, "第一条事实已巩固");
    const factId = factV1.id;

    await sendAndSettle(runtime.port, sessionId, "请记住：我住在上海浦东新区");
    let conflicts = (await getConflicts(runtime.port, "open")).body as { conflicts: ConflictView[] };
    assert.equal(conflicts.conflicts.length, 1, "事实冲突自动进待确认队列");
    const first = conflicts.conflicts[0];
    assert.equal(first.reason, "fact_conflict");
    assert.equal(first.existing_content, "我住在北京朝阳区");
    assert.equal(first.incoming_content, "我住在上海浦东新区");
    assert.equal(first.fact_id, factId);
    assert.equal(first.status, "open");

    // 冲突期间事实不被静默覆盖；冲突候选不可 decide（409）
    const kept = (await searchFacts(runtime.port, "北京朝阳")).find((h) => h.stage === "fact");
    assert.equal(kept?.content, "我住在北京朝阳区");
    const conflictedCandidates = (await getCandidates(runtime.port, "conflicted")).body as { candidates: CandidateView[] };
    assert.equal(conflictedCandidates.candidates.length, 1);
    const decideBlocked = await decideCandidate(runtime.port, conflictedCandidates.candidates[0].candidate_id, { decision: "accept" });
    assert.equal(decideBlocked.status, 409);

    // 裁决 1：keep_new → 采纳新值，版本+1 修订
    const keepNew = await resolveConflict(runtime.port, first.conflict_id, { resolution: "keep_new" });
    assert.equal(keepNew.status, 200);
    assert.equal(keepNew.body.version, 2);
    assert.ok(keepNew.body.revision_id !== null);
    assert.ok(keepNew.body.factUpdatedEventId !== null);
    const v2 = (await searchFacts(runtime.port, "上海浦东")).find((h) => h.stage === "fact");
    assert.equal(v2?.content, "我住在上海浦东新区");
    assert.equal(v2?.version, 2);

    // 冲突 2 → keep_old：事实不动、候选 dismissed、只留 conflict_resolved
    await sendAndSettle(runtime.port, sessionId, "请记住：我住在杭州西湖区");
    conflicts = (await getConflicts(runtime.port, "open")).body as { conflicts: ConflictView[] };
    assert.equal(conflicts.conflicts.length, 1);
    const second = conflicts.conflicts[0];
    const keepOld = await resolveConflict(runtime.port, second.conflict_id, { resolution: "keep_old" });
    assert.equal(keepOld.status, 200);
    assert.equal(keepOld.body.version, 2, "keep_old 不推进版本");
    assert.equal(keepOld.body.factUpdatedEventId, null);
    const still = (await searchFacts(runtime.port, "上海浦东")).find((h) => h.stage === "fact");
    assert.equal(still?.content, "我住在上海浦东新区", "保留旧值");

    // 冲突 3 → merge：Owner 合并文本进版本链
    await sendAndSettle(runtime.port, sessionId, "请记住：我住在上海静安区");
    conflicts = (await getConflicts(runtime.port, "open")).body as { conflicts: ConflictView[] };
    assert.equal(conflicts.conflicts.length, 1);
    const third = conflicts.conflicts[0];
    const mergeNoContent = await resolveConflict(runtime.port, third.conflict_id, { resolution: "merge" });
    assert.equal(mergeNoContent.status, 400, "merge 必须携带合并文本");
    const merged = await resolveConflict(runtime.port, third.conflict_id, {
      resolution: "merge",
      content: "我住在上海，工作日在浦东、周末在静安",
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.version, 3);
    const v3 = (await searchFacts(runtime.port, "静安")).find((h) => h.stage === "fact");
    assert.equal(v3?.content, "我住在上海，工作日在浦东、周末在静安");

    // 裁决事件留账本：3 条 conflict_resolved + 2 条 fact_updated；重复裁决 409；未知 404
    const events = await allEvents(runtime.port);
    assert.equal(events.filter((e) => e.event_type === "memory.conflict_resolved").length, 3);
    assert.equal(events.filter((e) => e.event_type === "memory.fact_updated").length, 2);
    assert.equal(events.filter((e) => e.event_type === "memory.conflict_detected").length, 3);
    assert.equal((await resolveConflict(runtime.port, third.conflict_id, { resolution: "keep_new" })).status, 409);
    assert.equal((await resolveConflict(runtime.port, "no-such", { resolution: "keep_new" })).status, 404);
    assert.equal((await getConflicts(runtime.port, "resolved")).status, 200);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("端到端（M1-T2）：locked 事实的冲突永不自动改写，只能经 Owner 裁决变更", async () => {
  const dir = tmpDir("morrow-mem-t2-locked-");
  const toolScript = (content: string): FakeStep[] => [
    { kind: "tool", toolName: "memory.write", args: { content, kind: "fact", sensitivity: "locked" } },
    { kind: "text", deltas: ["已记录"] },
  ];
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(toolScript("保险箱密码在书房第三格")),
  });
  try {
    const sessionId = await createSession(runtime.port);
    await sendAndSettle(runtime.port, sessionId, "记一下这个");

    const locked = (await searchFacts(runtime.port, "保险箱")).find((h) => h.stage === "fact");
    assert.ok(locked !== undefined, "locked 事实已巩固");
    assert.equal(locked.sensitivity, "locked");

    // 同主题不同值的 locked 候选（0.9，工具路径）在轮次收尾被巩固 → 冲突上报而非自动改写
    await runtime.close();
    const reopened = await startRuntime(testConfig(dir), {
      agentAdapterFactory: fakeFactory(toolScript("保险箱密码在卧室抽屉")),
    });
    try {
      const sessionId2 = await createSession(reopened.port);
      await sendAndSettle(reopened.port, sessionId2, "换地方了");

      const untouched = (await searchFacts(reopened.port, "保险箱")).find((h) => h.stage === "fact");
      assert.equal(untouched?.content, "保险箱密码在书房第三格", "locked 事实不被自动改写");
      const open = (await getConflicts(reopened.port, "open")).body as { conflicts: ConflictView[] };
      assert.equal(open.conflicts.length, 1);
      assert.equal(open.conflicts[0].reason, "locked");

      // Owner 裁决 keep_new：locked 内容也只能经此路径变更
      const resolved = await resolveConflict(reopened.port, open.conflicts[0].conflict_id, { resolution: "keep_new" });
      assert.equal(resolved.status, 200);
      const updated = (await searchFacts(reopened.port, "保险箱")).find((h) => h.stage === "fact");
      assert.equal(updated?.content, "保险箱密码在卧室抽屉");
      assert.equal(updated?.sensitivity, "locked");
    } finally {
      await reopened.close();
    }
  } finally {
    removeDir(dir);
  }
});

test("端到端（M1-T2）：抽取器失败（fire-and-forget）不影响会话主链路——assistant 正常收尾、无半截状态", async () => {
  const failing: MemoryExtractor = {
    extract: () => Promise.reject(new Error("LLM 抽取服务不可用")),
  };
  const dir = tmpDir("morrow-mem-t2-fail-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["今天多云"] }]),
    memoryExtractor: failing,
  });
  try {
    const sessionId = await createSession(runtime.port);
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "今天天气怎么样？" }),
    });
    assert.equal(res.status, 202);
    await waitFor("message.assistant", async () =>
      (await allEvents(runtime.port)).some((e) => e.event_type === "message.assistant"),
    );
    const events = await allEvents(runtime.port);
    assert.equal(events.some((e) => e.event_type === "memory.extracted"), false, "失败的运行不留运行事件");
    assert.equal(events.some((e) => e.event_type === "agent.error"), false, "记忆失败不产生会话错误事件");
    assert.equal(events.some((e) => e.event_type === "message.user"), true, "用户消息正常落账");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
