// MemoryService + memory.write 工具 seam 测试（票 M1-T1 / Issue #13）：
// 候选落库 + memory.* 事件走统一信封入账本（causation 回链 message.user）+
// 工具契约（input schema 走 protocol MemoryWriteInput；非法入参 isError）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope } from "@morrow/protocol";
import { computeIntegrityHash } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import { MemoryService, MEMORY_EVENT_TYPES, MemoryWriteError } from "../src/memory/service.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { MEMORY_WRITE_TOOL_NAME, createMemoryWriteTool } from "../src/memory/tool.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SESSION = "01936b9d-8f7a-7abc-9f2e-000000000001";

interface Fixture {
  store: MemoryStore;
  ledger: EventLedger;
  service: MemoryService;
  userEventId: string;
  occurredAt: string;
  dir: string;
}

/** 造一条已入账本的 message.user 事件（候选来源回链目标） */
function appendUserMessage(ledger: EventLedger, text: string): { eventId: string; occurredAt: string } {
  const envelope = buildEventEnvelope({
    replicaId: REPLICA,
    actorId: "owner",
    eventType: "message.user",
    sessionId: SESSION,
    payload: { message_id: "01936b9d-8f7a-7abc-9f2e-00000000ffff", text },
  });
  ledger.append(envelope);
  return { eventId: envelope.event_id, occurredAt: envelope.occurred_at };
}

function setup(): Fixture {
  const dir = tmpDir("morrow-mem-svc-");
  const store = MemoryStore.open(dir);
  const ledger = EventLedger.open(dir);
  const service = new MemoryService({ store, ledger, replicaId: REPLICA });
  const { eventId, occurredAt } = appendUserMessage(ledger, "请记住：周五下午三点复盘");
  return { store, ledger, service, userEventId: eventId, occurredAt, dir };
}

function teardown(fx: Fixture): void {
  fx.store.close();
  fx.ledger.close();
  removeDir(fx.dir);
}

test("observeUserMessage：显式记住 → 候选落库 + memory.candidate_created 入账本（信封回链）", () => {
  const fx = setup();
  try {
    const result = fx.service.observeUserMessage({
      sessionId: SESSION,
      userEventId: fx.userEventId,
      occurredAt: "2026-10-30T08:00:00.000Z",
      text: "请记住：周五下午三点复盘",
    });
    assert.ok(result !== null, "显式记住必须命中");
    assert.equal(result.candidate.content, "周五下午三点复盘");
    assert.equal(result.candidate.sensitivity, "private");

    const entries = fx.ledger.scan({ eventType: MEMORY_EVENT_TYPES.candidateCreated });
    assert.equal(entries.length, 1, "恰好一条候选事件");
    const envelope = entries[0].envelope as EventEnvelope;
    assert.equal(envelope.session_id, SESSION);
    assert.equal(envelope.actor_id, "agent:runtime");
    assert.equal(envelope.causation_id, fx.userEventId, "causation 回链原始 message.user");
    assert.equal(envelope.integrity_hash, computeIntegrityHash(envelope), "信封 hash 可复算");
    assert.deepEqual(
      {
        candidate_id: envelope.payload.candidate_id,
        source_id: envelope.payload.source_id,
        source_event_id: envelope.payload.source_event_id,
        rule: envelope.payload.rule,
        sensitivity: envelope.payload.sensitivity,
        kind: envelope.payload.kind,
      },
      {
        candidate_id: result.candidate.candidate_id,
        source_id: result.source.source_id,
        source_event_id: fx.userEventId,
        rule: "explicit-remember",
        sensitivity: "private",
        kind: "fact",
      },
    );
  } finally {
    teardown(fx);
  }
});

test("observeUserMessage：闲聊不产生候选也不产生 memory.* 事件", () => {
  const fx = setup();
  try {
    const result = fx.service.observeUserMessage({
      sessionId: SESSION,
      userEventId: fx.userEventId,
      occurredAt: "2026-10-30T08:00:00.000Z",
      text: "今天天气怎么样？",
    });
    assert.equal(result, null);
    assert.deepEqual(fx.service.search("天气"), []);
    assert.equal(fx.ledger.scan({ eventType: MEMORY_EVENT_TYPES.candidateCreated }).length, 0);
  } finally {
    teardown(fx);
  }
});

test("writeFromTool：显式工具写入透传 sensitivity，来源 = 会话最新 message.user", () => {
  const fx = setup();
  try {
    const result = fx.service.writeFromTool(SESSION, {
      content: "Owner 的时区是 Asia/Shanghai",
      kind: "profile",
      sensitivity: "public",
    });
    assert.equal(result.candidate.sensitivity, "public");
    assert.equal(result.source.event_id, fx.userEventId, "来源回链最新 message.user");
    assert.equal(result.source.session_id, SESSION);
    assert.equal(result.candidate.confidence, 0.9, "显式写入默认置信度 0.9");

    const envelope = fx.ledger.scan({ eventType: MEMORY_EVENT_TYPES.candidateCreated })[0].envelope;
    assert.equal(envelope.payload.rule, "memory.write");
    assert.equal(envelope.payload.candidate_id, result.candidate.candidate_id);
  } finally {
    teardown(fx);
  }
});

test("writeFromTool：缺省 kind=fact、sensitivity=private；空内容抛 MemoryWriteError", () => {
  const fx = setup();
  try {
    const result = fx.service.writeFromTool(SESSION, { content: "记住明早买牛奶" });
    assert.equal(result.candidate.kind, "fact");
    assert.equal(result.candidate.sensitivity, "private");

    assert.throws(() => fx.service.writeFromTool(SESSION, { content: "   " }), MemoryWriteError);
    assert.throws(() => fx.service.writeFromTool(SESSION, { content: "x", sensitivity: "secret" as never }), MemoryWriteError);
    assert.throws(() => fx.service.writeFromTool(SESSION, { content: "x", confidence: 1.5 }), MemoryWriteError);
  } finally {
    teardown(fx);
  }
});

test("memory.write 工具契约：名称/schema 必填 content；成功返回候选 id；非法入参 isError", async () => {
  const fx = setup();
  try {
    const tool = createMemoryWriteTool({ service: fx.service, sessionId: SESSION });
    assert.equal(tool.name, MEMORY_WRITE_TOOL_NAME);
    assert.equal(tool.description.length > 0, true);
    const params = tool.parameters as { type: string; required: string[]; properties: Record<string, unknown> };
    assert.equal(params.type, "object");
    assert.deepEqual(params.required, ["content"]);
    assert.ok("content" in params.properties);
    assert.ok("sensitivity" in params.properties);

    const ok = await tool.execute("call-1", { content: "记住服务器在机房 B" });
    assert.equal(ok.isError ?? false, false);
    assert.match(ok.text, /candidate/);

    const empty = await tool.execute("call-2", { content: "" });
    assert.equal(empty.isError, true);

    const badArgs = await tool.execute("call-3", "not-an-object");
    assert.equal(badArgs.isError, true);
  } finally {
    teardown(fx);
  }
});
