// 记忆双写端到端（Issue #56）。
//
// 复现票面的真实场景：同一句用户消息，`memory.write` 工具写一条（fact、近原文），
// 轮次抽取器再写一条（preference、改写版）。修复后长期记忆里应只有**一条**。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import { EventLedger } from "../src/ledger.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { MemoryService } from "../src/memory/service.ts";
import { DefaultConsolidator } from "../src/memory/consolidator.ts";
import { LlmMemoryExtractor } from "../src/memory/extraction.ts";
import { uuidv7 } from "../src/uuid-v7.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import { removeDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SESSION = "01936b9d-8f7a-7abc-9f2e-000000000002";
const USER_TEXT = "记住：我偏好用 TypeScript 写脚本工具，不喜欢 Python。";

/** 造一个真实的 ledger + store + service（与 runtime 装配同构，只是不启 HTTP） */
function makeHarness(extractorSteps: FakeStep[]) {
  const dir = mkdtempSync(join(tmpdir(), "morrow-dedup-e2e-"));
  const ledger = EventLedger.open(dir);
  const store = MemoryStore.open(dir);
  const service = new MemoryService({
    store,
    ledger,
    replicaId: REPLICA,
    extractor: new LlmMemoryExtractor(async () => createFakePi({ script: extractorSteps })),
    consolidator: new DefaultConsolidator(),
  });
  return {
    dir,
    ledger,
    store,
    service,
    cleanup: () => {
      store.close();
      ledger.close();
      removeDir(dir);
    },
  };
}

/** 写一条 user message 事件，返回其 event_id（充当 source 回链） */
function seedUserMessage(ledger: EventLedger, text: string): string {
  const envelope = buildEventEnvelope({
    replicaId: REPLICA,
    actorId: "owner",
    eventType: "message.user",
    sessionId: SESSION,
    payload: { message_id: uuidv7(), text },
  });
  ledger.append(envelope);
  return envelope.event_id;
}

test("票面场景：工具写 fact + 抽取器写 preference → 长期记忆只有一条", async () => {
  // 抽取器回一条改写版（kind=preference，与票面证据一致）
  const h = makeHarness([
    {
      kind: "text",
      deltas: [
        JSON.stringify([
          {
            content: "Owner 偏好用 TypeScript 写脚本工具，不喜欢 Python。",
            kind: "preference",
            confidence: 0.95,
            sensitivity: "private",
            rule: "llm-extractor",
          },
        ]),
      ],
    },
  ]);
  try {
    const userEventId = seedUserMessage(h.ledger, USER_TEXT);

    // ① 工具路径先写一条（fact、近原文）
    h.service.writeFromTool(SESSION, { content: "我偏好用 TypeScript 写脚本工具，不喜欢 Python" });

    // ② 轮次抽取（同一 source_event）
    const result = await h.service.extractTurn({
      sessionId: SESSION,
      userEventId,
      occurredAt: new Date().toISOString(),
      text: USER_TEXT,
    });

    // 入口去重应拦下改写版（不与工具写的那条重复）
    assert.equal(result.skippedDuplicates, 1, `应跳过 1 条近似重复；实际 ${result.skippedDuplicates}`);
    assert.equal(result.extractedCount, 0);

    // 长期记忆（事实）只有一条
    const facts = h.service.listFacts();
    assert.equal(facts.length, 1, `长期记忆应只有一条；实际 ${facts.length}：${JSON.stringify(facts.map((f) => f.content))}`);
  } finally {
    h.cleanup();
  }
});

test("对照：语义不同的两条陈述**不**被合并", async () => {
  const h = makeHarness([
    {
      kind: "text",
      deltas: [
        JSON.stringify([
          {
            content: "周末计划去爬香山",
            kind: "fact",
            confidence: 0.9,
            sensitivity: "private",
            rule: "llm-extractor",
          },
        ]),
      ],
    },
  ]);
  try {
    const userEventId = seedUserMessage(h.ledger, "记住：我偏好 TypeScript。另外周末计划去爬香山。");
    h.service.writeFromTool(SESSION, { content: "我偏好用 TypeScript 写脚本工具" });

    const result = await h.service.extractTurn({
      sessionId: SESSION,
      userEventId,
      occurredAt: new Date().toISOString(),
      text: "记住：我偏好 TypeScript。另外周末计划去爬香山。",
    });

    assert.equal(result.skippedDuplicates, 0, "语义不同的陈述不该被去重");
    assert.equal(result.extractedCount, 1);
    const facts = h.service.listFacts();
    assert.equal(
      facts.length,
      2,
      `两条不同事实都应存在；实际 ${facts.length}：${JSON.stringify(facts.map((f) => [f.content, f.kind]))}；` +
        `consolidation=${JSON.stringify(result.consolidation)}`,
    );
  } finally {
    h.cleanup();
  }
});

test("跨 kind 的同一陈述在巩固层也被认出（入口未拦时的第二道防线）", () => {
  // 直接造两条候选（绕过入口），验证巩固器不会各自 create_fact
  const h = makeHarness([]);
  try {
    const consolidator = new DefaultConsolidator();
    const actions = consolidator.consolidate({
      candidates: [
        {
          candidateId: "c1",
          content: "Owner 偏好用 TypeScript 写脚本工具，不喜欢 Python。",
          kind: "preference",
          sensitivity: "private",
          confidence: 0.95,
          sourceId: "s1",
          scope: "owner",
        },
      ],
      facts: [
        {
          factId: "f1",
          content: "我偏好用 TypeScript 写脚本工具，不喜欢 Python",
          kind: "fact",
          sensitivity: "private",
          version: 1,
        },
      ],
    });
    assert.equal(actions[0].action, "corroborate", "跨 kind 的同一陈述应按印证处理，不新建事实");
  } finally {
    h.cleanup();
  }
});
