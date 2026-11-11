// MemoryService 抽取/巩固管线测试（票 M1-T2 / Issue #14）：
// Extractor/Consolidator 注入 seam + 行/事件双面（memory.extracted / memory.consolidated /
// memory.fact_created / memory.fact_updated / memory.conflict_detected / memory.conflict_resolved）
// + 决端点语义（decide accept→巩固 / dismiss）+ 冲突裁决三种修订 + fire-and-forget 失败隔离。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import {
  AUTO_CONSOLIDATE_MIN_CONFIDENCE,
  MemoryControlError,
  MemoryService,
  MemoryWriteError,
  MEMORY_EVENT_TYPES,
} from "../src/memory/service.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { uuidv7 } from "../src/uuid-v7.ts";
import type {
  ConsolidationAction,
  ConsolidationCandidateView,
  MemoryConsolidator,
} from "../src/memory/consolidator.ts";
import type { MemoryExtractor } from "../src/memory/extraction.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SESSION = "01936b9d-8f7a-7abc-9f2e-000000000002";

interface ExtractedItem {
  content: string;
  kind?: MemoryEntryKind;
  confidence?: number;
  sensitivity?: SensitivityLevel;
  rule?: string;
}

function stubExtractor(items: ExtractedItem[]): MemoryExtractor {
  return {
    extract: () =>
      items.map((item) => ({
        content: item.content,
        kind: item.kind ?? "fact",
        confidence: item.confidence ?? 0.9,
        sensitivity: item.sensitivity ?? "private",
        rule: item.rule ?? "stub-rule",
      })),
  };
}

/** 顺序脚本式 consolidator 桩：第 n 次调用返回第 n 组动作（动作里的 id 用真实 id） */
function scriptConsolidator(script: ConsolidationAction[][]): MemoryConsolidator {
  let calls = 0;
  return {
    consolidate(input) {
      const actions = script[calls];
      calls += 1;
      if (actions === undefined) throw new Error("consolidator script exhausted");
      return actions;
    },
  };
}

interface Fixture {
  store: MemoryStore;
  ledger: EventLedger;
  service: MemoryService;
  userEventId: string;
  assistantEventId: string;
  dir: string;
}

function setup(deps: { extractor?: MemoryExtractor; consolidator?: MemoryConsolidator } = {}): Fixture {
  const dir = tmpDir("morrow-mem-pipe-");
  const store = MemoryStore.open(dir);
  const ledger = EventLedger.open(dir);
  const service = new MemoryService({
    store,
    ledger,
    replicaId: REPLICA,
    ...(deps.extractor !== undefined ? { extractor: deps.extractor } : {}),
    ...(deps.consolidator !== undefined ? { consolidator: deps.consolidator } : {}),
  });
  const user = buildEventEnvelope({
    replicaId: REPLICA,
    actorId: "owner",
    eventType: "message.user",
    sessionId: SESSION,
    payload: { message_id: "m-user", text: "本轮用户消息" },
  });
  ledger.append(user);
  const assistant = buildEventEnvelope({
    replicaId: REPLICA,
    actorId: "agent:runtime",
    eventType: "message.assistant",
    sessionId: SESSION,
    payload: { message_id: "m-assistant", text: "好的" },
    causationId: user.event_id,
  });
  ledger.append(assistant);
  return { store, ledger, service, userEventId: user.event_id, assistantEventId: assistant.event_id, dir };
}

function teardown(fx: Fixture): void {
  fx.store.close();
  fx.ledger.close();
  removeDir(fx.dir);
}

function eventsOf(fx: Fixture, eventType: string) {
  return fx.ledger.scan({ eventType });
}

/** 造一条 pending 候选（不经抽取路径），返回 candidate_id（来源事件 id 用真实 uuid，可作 causation） */
function makePendingCandidate(
  fx: Fixture,
  content: string,
  overrides: { kind?: MemoryEntryKind; confidence?: number } = {},
): string {
  const { candidate } = fx.store.createCandidate({
    content,
    kind: overrides.kind ?? "preference",
    confidence: overrides.confidence ?? 0.8,
    source: { kind: "message", eventId: uuidv7(), sessionId: SESSION },
  });
  return candidate.candidate_id;
}

test("extractTurn：抽取输出落候选（rule/sensitivity/confidence 透传）+ memory.extracted 运行事件（causation → message.assistant）", async () => {
  const fx = setup({
    extractor: stubExtractor([
      { content: "我喜欢用 Rust 写脚本", kind: "preference", confidence: 0.8, rule: "preference-statement" },
      { content: "我住在上海浦东", kind: "profile", confidence: 0.7, rule: "fact-statement" },
    ]),
  });
  try {
    const summary = await fx.service.extractTurn({
      sessionId: SESSION,
      userEventId: fx.userEventId,
      assistantEventId: fx.assistantEventId,
      occurredAt: "2026-11-01T08:00:00.000Z",
      text: "我喜欢用 Rust 写脚本。我住在上海浦东。",
    });
    assert.equal(summary.extractedCount, 2);
    assert.equal(summary.skippedDuplicates, 0);
    assert.equal(summary.candidateIds.length, 2);

    const extractedEvents = eventsOf(fx, MEMORY_EVENT_TYPES.extracted);
    assert.equal(extractedEvents.length, 1, "一次抽取运行恰好一条 memory.extracted");
    const extracted = extractedEvents[0];
    assert.equal(extracted.envelope.causation_id, fx.assistantEventId, "运行事件回链触发点（轮次收尾）");
    assert.equal(extracted.envelope.session_id, SESSION);
    assert.deepEqual(
      { extracted_count: extracted.envelope.payload.extracted_count, skipped: extracted.envelope.payload.skipped_duplicates },
      { extracted_count: 2, skipped: 0 },
    );

    const candidateEvents = eventsOf(fx, MEMORY_EVENT_TYPES.candidateCreated);
    assert.equal(candidateEvents.length, 2);
    assert.deepEqual(
      candidateEvents.map((e) => e.envelope.payload.rule).sort(),
      ["fact-statement", "preference-statement"],
    );
    assert.ok(candidateEvents.every((e) => e.envelope.causation_id === fx.userEventId), "候选证据回链 message.user");

    // 默认巩固器 + 空事实表：0.8 候选达自动巩固准入线 → 新建事实；0.7 留 pending
    assert.ok(summary.consolidation !== null, "0.8 候选进自动巩固");
    assert.equal(summary.consolidation.createdFactIds.length, 1);
    assert.deepEqual(
      fx.store.listCandidates({ status: "pending" }).map((c) => c.content),
      ["我住在上海浦东"],
      "低于准入线的候选留 pending 等 Owner decide",
    );
  } finally {
    teardown(fx);
  }
});

test("extractTurn 去重：同来源事件 + 同内容（T1 即时写入先行）→ 跳过；不同内容仍写入", async () => {
  const fx = setup({
    extractor: stubExtractor([
      { content: "备份钥匙在门框上", confidence: 0.7 },
      { content: "新的记忆内容", confidence: 0.7 },
    ]),
  });
  try {
    fx.service.observeUserMessage({
      sessionId: SESSION,
      userEventId: fx.userEventId,
      occurredAt: "2026-11-01T08:00:00.000Z",
      text: "请记住：备份钥匙在门框上",
    });
    assert.ok(fx.store.hasCandidateFromSource(fx.userEventId, "备份钥匙在门框上"), "T1 即时写入已存在");

    const summary = await fx.service.extractTurn({
      sessionId: SESSION,
      userEventId: fx.userEventId,
      occurredAt: "2026-11-01T08:00:00.000Z",
      text: "请记住：备份钥匙在门框上",
    });
    assert.equal(summary.extractedCount, 1, "只有新内容成候选");
    assert.equal(summary.skippedDuplicates, 1, "同来源同内容被去重");
    const contents = fx.store.listCandidates().map((c) => c.content).sort();
    assert.deepEqual(contents, ["备份钥匙在门框上", "新的记忆内容"]);
  } finally {
    teardown(fx);
  }
});

test("自动巩固：高置信候选 → create_fact → memory.fact_created + memory.consolidated（causation → memory.extracted）", async () => {
  const fx = setup({
    extractor: stubExtractor([{ content: "我喜欢用 Rust 写脚本", kind: "preference", confidence: AUTO_CONSOLIDATE_MIN_CONFIDENCE }]),
  });
  try {
    const summary = await fx.service.extractTurn({
      sessionId: SESSION,
      userEventId: fx.userEventId,
      occurredAt: "2026-11-01T08:00:00.000Z",
      text: "我喜欢用 Rust 写脚本",
    });
    assert.ok(summary.consolidation !== null, "达准入线的候选自动巩固");
    assert.equal(summary.consolidation.createdFactIds.length, 1);

    const fact = fx.store.listFacts()[0];
    assert.equal(fact.content, "我喜欢用 Rust 写脚本");
    assert.equal(fact.version, 1);

    const factEvents = eventsOf(fx, MEMORY_EVENT_TYPES.factCreated);
    assert.equal(factEvents.length, 1);
    assert.equal(factEvents[0].envelope.payload.fact_id, fact.fact_id);
    assert.equal(factEvents[0].envelope.payload.version, 1);

    const consolidatedEvents = eventsOf(fx, MEMORY_EVENT_TYPES.consolidated);
    assert.equal(consolidatedEvents.length, 1);
    assert.equal(
      consolidatedEvents[0].envelope.causation_id,
      summary.extractedEventId,
      "巩固运行回链同轮的抽取运行事件",
    );
    assert.deepEqual(consolidatedEvents[0].envelope.payload.created_fact_ids, [fact.fact_id]);
    assert.deepEqual(consolidatedEvents[0].envelope.payload.conflict_ids, []);
    assert.deepEqual(fx.store.listCandidates({ status: "pending" }), [], "候选已转 consolidated");
  } finally {
    teardown(fx);
  }
});

test("巩固 corroborate：同内容候选印证既有事实——不推进版本、不落 fact 事件，只补来源并计数", async () => {
  const fx = setup({ extractor: stubExtractor([{ content: "我喜欢用 Rust 写脚本", kind: "preference", confidence: 0.8 }]) });
  try {
    const first = await fx.service.extractTurn({
      sessionId: SESSION,
      userEventId: fx.userEventId,
      occurredAt: "2026-11-01T08:00:00.000Z",
      text: "我喜欢用 Rust 写脚本",
    });
    const factId = first.consolidation?.createdFactIds[0];
    assert.ok(factId !== undefined);

    assert.equal(fx.service.consolidatePending(), null, "无 pending 候选时不产生巩固运行");

    // 同内容新候选（新来源）→ 印证
    makePendingCandidate(fx, "我喜欢用 Rust 写脚本", { kind: "preference", confidence: 0.8 });
    const run = fx.service.consolidatePending();
    assert.ok(run !== null);
    assert.deepEqual(run.corroboratedFactIds, [factId]);
    assert.equal(run.createdFactIds.length, 0);
    assert.equal(fx.store.getFact(factId)?.version, 1, "印证不推进版本");
    assert.equal(eventsOf(fx, MEMORY_EVENT_TYPES.factCreated).length, 1, "无新 fact 事件");
    assert.equal(fx.store.search("Rust").filter((h) => h.stage === "fact").flatMap((h) => h.sources).length, 2, "事实来源回链现为两条");
  } finally {
    teardown(fx);
  }
});

test("巩固 update_fact：同主题偏好自动更新 → 事实版本+1 + memory.fact_updated 事件（版本链留历史）", async () => {
  const fx = setup();
  try {
    const first = makePendingCandidate(fx, "我喜欢用 TypeScript 写脚本");
    const fact = fx.store.createFact({
      content: "我喜欢用 TypeScript 写脚本",
      kind: "preference",
      sensitivity: "private",
      candidateId: first,
      sourceId: fx.store.getCandidate(first)!.source_id,
    });
    const second = makePendingCandidate(fx, "我现在偏好用 Go 写脚本");
    const consolidator = scriptConsolidator([
      [{ action: "update_fact", factId: fact.fact_id, candidateId: second, content: "我现在偏好用 Go 写脚本", sensitivity: "private", reason: "preference_update" }],
    ]);
    const updater = new MemoryService({ store: fx.store, ledger: fx.ledger, replicaId: REPLICA, consolidator });
    const summary = updater.consolidatePending();
    assert.ok(summary !== null);
    assert.deepEqual(summary.updatedFactIds, [fact.fact_id]);

    const updated = fx.store.getFact(fact.fact_id);
    assert.equal(updated?.version, 2, "版本 +1");
    assert.equal(updated?.content, "我现在偏好用 Go 写脚本");
    const revisions = eventsOf(fx, MEMORY_EVENT_TYPES.factUpdated);
    assert.equal(revisions.length, 1);
    assert.equal(String(revisions[0].envelope.payload.revision_id).length > 0, true);
    assert.equal(revisions[0].envelope.payload.version, 2);
    assert.equal(revisions[0].envelope.payload.reason, "preference_update");
    assert.equal(fx.store.getCandidate(second)?.status, "consolidated");
  } finally {
    teardown(fx);
  }
});

test("巩固 escalate：冲突进待确认队列（memory.conflict_detected + 候选 conflicted），内容不被覆盖", async () => {
  const fx = setup();
  try {
    const first = makePendingCandidate(fx, "我住在北京朝阳", { kind: "profile", confidence: 0.7 });
    const fact = fx.store.createFact({
      content: "我住在北京朝阳",
      kind: "profile",
      sensitivity: "private",
      candidateId: first,
      sourceId: fx.store.getCandidate(first)!.source_id,
    });
    const second = makePendingCandidate(fx, "我住在上海浦东", { kind: "profile", confidence: 0.7 });
    const consolidator = scriptConsolidator([
      [{ action: "escalate", factId: fact.fact_id, candidateId: second, reason: "fact_conflict", existingContent: "我住在北京朝阳", incomingContent: "我住在上海浦东" }],
    ]);
    const escalator = new MemoryService({ store: fx.store, ledger: fx.ledger, replicaId: REPLICA, consolidator });
    const summary = escalator.consolidatePending();
    assert.ok(summary !== null);
    assert.equal(summary.conflictIds.length, 1);

    assert.equal(fx.store.getFact(fact.fact_id)?.content, "我住在北京朝阳", "事实不被静默覆盖");
    assert.equal(fx.store.getCandidate(second)?.status, "conflicted");

    const detected = eventsOf(fx, MEMORY_EVENT_TYPES.conflictDetected);
    assert.equal(detected.length, 1);
    assert.equal(detected[0].envelope.payload.reason, "fact_conflict");
    assert.equal(detected[0].envelope.payload.conflict_id, summary.conflictIds[0]);

    assert.equal(fx.service.listConflicts({ status: "open" }).length, 1);
  } finally {
    teardown(fx);
  }
});

test("decideCandidate：accept 把低置信候选送进巩固；dismiss 更新状态；conflicted/未知 → 领域错误", async () => {
  const fx = setup({
    extractor: stubExtractor([{ content: "我住在上海浦东", kind: "profile", confidence: 0.7, rule: "fact-statement" }]),
  });
  try {
    const summary = await fx.service.extractTurn({
      sessionId: SESSION,
      userEventId: fx.userEventId,
      occurredAt: "2026-11-01T08:00:00.000Z",
      text: "我住在上海浦东",
    });
    const candidateId = summary.candidateIds[0];
    assert.equal(fx.store.getCandidate(candidateId)?.status, "pending", "0.7 候选等待 Owner 决定");

    const decided = fx.service.decideCandidate(candidateId, "accept");
    assert.ok(decided.result !== null, "accept 触发巩固");
    assert.equal(decided.result.createdFactIds.length, 1);
    assert.equal(fx.store.getCandidate(candidateId)?.status, "consolidated");
    // decide 触发的巩固运行 causation → 候选来源事件（证据链）
    const consolidated = eventsOf(fx, MEMORY_EVENT_TYPES.consolidated).at(-1);
    assert.equal(consolidated?.envelope.causation_id, fx.userEventId);

    // dismiss
    const another = makePendingCandidate(fx, "临时想法", { confidence: 0.5 });
    const dismissed = fx.service.decideCandidate(another, "dismiss");
    assert.equal(dismissed.result, null);
    assert.equal(fx.store.getCandidate(another)?.status, "dismissed");

    assert.throws(() => fx.service.decideCandidate("no-such", "accept"), (err: unknown) =>
      err instanceof MemoryControlError && err.code === "not_found",
    );
    assert.throws(() => fx.service.decideCandidate(another, "accept"), (err: unknown) =>
      err instanceof MemoryControlError && err.code === "invalid_state",
    );
  } finally {
    teardown(fx);
  }
});

test("resolveConflict：keep_new / keep_old / merge 三种裁决各自产生正确修订与事件", async () => {
  const fx = setup();
  try {
    const first = makePendingCandidate(fx, "我住在北京朝阳", { kind: "profile", confidence: 0.7 });
    const fact = fx.store.createFact({
      content: "我住在北京朝阳",
      kind: "profile",
      sensitivity: "private",
      candidateId: first,
      sourceId: fx.store.getCandidate(first)!.source_id,
    });
    const second = makePendingCandidate(fx, "我住在上海浦东", { kind: "profile", confidence: 0.7 });
    const conflict = fx.store.escalateConflict({
      candidateId: second,
      factId: fact.fact_id,
      reason: "fact_conflict",
      existingContent: "我住在北京朝阳",
      incomingContent: "我住在上海浦东",
      existingSensitivity: "private",
      incomingSensitivity: "private",
      sourceId: fx.store.getCandidate(second)!.source_id,
    });

    // keep_new：采纳新值 → 版本+1 修订 + fact_updated + conflict_resolved
    const keepNew = fx.service.resolveConflict(conflict.conflict_id, { resolution: "keep_new" });
    assert.equal(keepNew.version, 2);
    assert.ok(keepNew.revisionId !== null);
    assert.equal(fx.store.getFact(fact.fact_id)?.content, "我住在上海浦东");
    assert.equal(fx.store.getCandidate(second)?.status, "consolidated");
    assert.equal(eventsOf(fx, MEMORY_EVENT_TYPES.factUpdated).length, 1);
    assert.equal(eventsOf(fx, MEMORY_EVENT_TYPES.conflictResolved).length, 1);

    // keep_old：事实不动、候选 dismissed、只有 conflict_resolved（修订事件记录"不改"）
    const third = makePendingCandidate(fx, "我住在杭州西湖", { kind: "profile", confidence: 0.7 });
    const conflict2 = fx.store.escalateConflict({
      candidateId: third,
      factId: fact.fact_id,
      reason: "fact_conflict",
      existingContent: "我住在上海浦东",
      incomingContent: "我住在杭州西湖",
      existingSensitivity: "private",
      incomingSensitivity: "private",
      sourceId: fx.store.getCandidate(third)!.source_id,
    });
    const keepOld = fx.service.resolveConflict(conflict2.conflict_id, { resolution: "keep_old" });
    assert.equal(keepOld.version, 2, "keep_old 不推进版本");
    assert.equal(keepOld.revisionId, null);
    assert.equal(keepOld.factUpdatedEventId, null);
    assert.equal(fx.store.getCandidate(third)?.status, "dismissed");
    assert.equal(eventsOf(fx, MEMORY_EVENT_TYPES.conflictResolved).length, 2);
    assert.equal(eventsOf(fx, MEMORY_EVENT_TYPES.factUpdated).length, 1);

    // merge：Owner 合并文本进版本链（敏感性维持既有事实分级）
    const fourth = makePendingCandidate(fx, "我住在上海静安", { kind: "profile", confidence: 0.7 });
    const conflict3 = fx.store.escalateConflict({
      candidateId: fourth,
      factId: fact.fact_id,
      reason: "fact_conflict",
      existingContent: "我住在上海浦东",
      incomingContent: "我住在上海静安",
      existingSensitivity: "private",
      incomingSensitivity: "private",
      sourceId: fx.store.getCandidate(fourth)!.source_id,
    });
    const merged = fx.service.resolveConflict(conflict3.conflict_id, {
      resolution: "merge",
      content: "我住在上海，工作日在浦东、周末在静安",
    });
    assert.equal(merged.version, 3);
    assert.equal(fx.store.getFact(fact.fact_id)?.content, "我住在上海，工作日在浦东、周末在静安");
    assert.equal(eventsOf(fx, MEMORY_EVENT_TYPES.factUpdated).length, 2);
    assert.equal(eventsOf(fx, MEMORY_EVENT_TYPES.conflictResolved).length, 3);

    // 已裁决冲突不可重复 resolve；未知 id → not_found
    assert.throws(
      () => fx.service.resolveConflict(conflict3.conflict_id, { resolution: "keep_new" }),
      (err: unknown) => err instanceof MemoryControlError && err.code === "invalid_state",
    );
    assert.throws(
      () => fx.service.resolveConflict("no-such", { resolution: "keep_new" }),
      (err: unknown) => err instanceof MemoryControlError && err.code === "not_found",
    );
  } finally {
    teardown(fx);
  }
});

test("resolveConflict：merge 缺 content / 非法 resolution → invalid_input", () => {
  const fx = setup();
  try {
    const first = makePendingCandidate(fx, "我住在北京朝阳", { kind: "profile", confidence: 0.7 });
    const fact = fx.store.createFact({
      content: "我住在北京朝阳",
      kind: "profile",
      sensitivity: "private",
      candidateId: first,
      sourceId: fx.store.getCandidate(first)!.source_id,
    });
    const second = makePendingCandidate(fx, "我住在上海浦东", { kind: "profile", confidence: 0.7 });
    const conflict = fx.store.escalateConflict({
      candidateId: second,
      factId: fact.fact_id,
      reason: "fact_conflict",
      existingContent: "我住在北京朝阳",
      incomingContent: "我住在上海浦东",
      existingSensitivity: "private",
      incomingSensitivity: "private",
      sourceId: fx.store.getCandidate(second)!.source_id,
    });
    assert.throws(
      () => fx.service.resolveConflict(conflict.conflict_id, { resolution: "merge" }),
      (err: unknown) => err instanceof MemoryControlError && err.code === "invalid_input",
    );
    assert.throws(
      () => fx.service.resolveConflict(conflict.conflict_id, { resolution: "destroy" as never }),
      (err: unknown) => err instanceof MemoryControlError && err.code === "invalid_input",
    );
    assert.equal(fx.store.getConflict(conflict.conflict_id)?.status, "open", "校验失败不落裁决");
  } finally {
    teardown(fx);
  }
});

test("observeTurnEnd：fire-and-forget——抽取失败不冒泡、不留半截状态；成功路径异步完成并落事件", async () => {
  const failing: MemoryExtractor = { extract: () => Promise.reject(new Error("LLM 打瞌睡")) };
  const fx = setup({ extractor: failing });
  try {
    assert.doesNotThrow(() =>
      fx.service.observeTurnEnd({
        sessionId: SESSION,
        userEventId: fx.userEventId,
        assistantEventId: fx.assistantEventId,
        occurredAt: "2026-11-01T08:00:00.000Z",
        text: "随便聊聊",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(eventsOf(fx, MEMORY_EVENT_TYPES.extracted).length, 0, "失败的运行不留运行事件");
    assert.equal(fx.store.listCandidates().length, 0);
  } finally {
    teardown(fx);
  }

  const ok = setup({ extractor: stubExtractor([{ content: "记住备份钥匙位置", confidence: 0.9 }]) });
  try {
    ok.service.observeTurnEnd({
      sessionId: SESSION,
      userEventId: ok.userEventId,
      assistantEventId: ok.assistantEventId,
      occurredAt: "2026-11-01T08:00:00.000Z",
      text: "记住备份钥匙位置",
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && eventsOf(ok, MEMORY_EVENT_TYPES.extracted).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(eventsOf(ok, MEMORY_EVENT_TYPES.extracted).length, 1, "异步抽取完成并留运行事件");
    assert.equal(eventsOf(ok, MEMORY_EVENT_TYPES.factCreated).length, 1, "高置信候选随后自动巩固成事实");
  } finally {
    teardown(ok);
  }
});

test("extractTurn：抽取输出非法（空内容 / 越界置信度）→ 拒绝且不写半截候选", async () => {
  const fx = setup({ extractor: stubExtractor([{ content: "   " }, { content: "正常内容" }, { content: "越界", confidence: 1.5 }]) });
  try {
    await assert.rejects(
      () =>
        fx.service.extractTurn({
          sessionId: SESSION,
          userEventId: fx.userEventId,
          occurredAt: "2026-11-01T08:00:00.000Z",
          text: "x",
        }),
      MemoryWriteError,
    );
    assert.equal(fx.store.listCandidates().length, 0, "坏输出不落任何候选");
  } finally {
    teardown(fx);
  }
});
