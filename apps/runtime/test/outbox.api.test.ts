// Outbox HTTP 控制面测试（M4-T2 / Issue #39）：
// GET /v1/outbox（状态过滤/分页）、POST /v1/outbox/:id/retry（确认门）、
// POST /v1/outbox/:id/mark-sent（人工回执）。注入 ChannelAdapter 计数桩，零真实网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutboxListPage, OutboxMessageRecord } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import {
  OUTBOX_EVENT_TYPES,
  type OutboxChannelAdapter,
  type OutboxSendOutcome,
  type OutboxSendRequest,
} from "../src/outbox/service.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

/** 可切换行为的适配器桩：成功 / 明确失败 / 永不返回（超时） */
class SwitchAdapter implements OutboxChannelAdapter {
  readonly requests: OutboxSendRequest[] = [];
  mode: "sent" | "failed" | "hang" = "sent";

  async send(request: OutboxSendRequest): Promise<OutboxSendOutcome> {
    this.requests.push(request);
    if (this.mode === "failed") return { kind: "failed", error: "403 blocked by platform" };
    if (this.mode === "hang") return new Promise<OutboxSendOutcome>(() => {});
    return { kind: "sent", receipt: { platform_message_id: `om_${request.idempotency_key}` } };
  }
}

async function openRuntime(dir: string, adapter: OutboxChannelAdapter): Promise<{ runtime: RuntimeHandle; base: string }> {
  const runtime = await startRuntime(testConfig(dir), {
    outboxAdapter: adapter,
    outboxSendTimeoutMs: 20,
    outboxBackoffBaseMs: 100,
  });
  return { runtime, base: `http://127.0.0.1:${runtime.port}` };
}

function outbound(key: string) {
  return {
    idempotencyKey: key,
    channelId: "feishu",
    accountId: "bot-1",
    target: { kind: "conversation" as const, id: "oc_api" },
    payload: { text: key },
  };
}

test("Outbox 端点：列表过滤分页、failed 重试、needs_review 确认门、人工 mark-sent 审计", async () => {
  const dir = tmpDir("morrow-outbox-api-");
  const adapter = new SwitchAdapter();
  const { runtime, base } = await openRuntime(dir, adapter);
  try {
    // 1) 成功投递 → sent 可查
    const a = runtime.outbox.enqueue(outbound("api-ok"));
    await runtime.outbox.dispatchOnce();
    const sentList = await fetch(`${base}/v1/outbox?status=sent&limit=10`);
    assert.equal(sentList.status, 200);
    const sentPage = await json<OutboxListPage>(sentList);
    assert.equal(sentPage.total, 1);
    assert.equal(sentPage.limit, 10);
    assert.equal(sentPage.messages[0].id, a.id);
    assert.equal(sentPage.messages[0].receipt?.platform_message_id, "om_api-ok");

    // 2) 明确失败 → failed；POST retry（无需确认）→ pending；再投递成功
    adapter.mode = "failed";
    const b = runtime.outbox.enqueue(outbound("api-failed"));
    await runtime.outbox.dispatchOnce();
    assert.equal(runtime.outbox.get(b.id)!.status, "failed");
    const retryFailed = await fetch(`${base}/v1/outbox/${b.id}/retry`, { method: "POST" });
    assert.equal(retryFailed.status, 200);
    const retried = await json<{ message: OutboxMessageRecord }>(retryFailed);
    assert.equal(retried.message.status, "pending");
    adapter.mode = "sent";
    await runtime.outbox.dispatchOnce();
    assert.equal(runtime.outbox.get(b.id)!.status, "sent");

    // 3) 超时 → needs_review；未确认的 retry 被 409；确认后 pending
    adapter.mode = "hang";
    const c = runtime.outbox.enqueue(outbound("api-unknown"));
    await runtime.outbox.dispatchOnce();
    assert.equal(runtime.outbox.get(c.id)!.status, "needs_review");
    assert.equal(adapter.requests.filter((r) => r.id === c.id).length, 1);

    const unconfirmed = await fetch(`${base}/v1/outbox/${c.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(unconfirmed.status, 409);
    const unconfirmedBody = await json<{ error: { code: string } }>(unconfirmed);
    assert.equal(unconfirmedBody.error.code, "outbox_confirmation_required");
    assert.equal(runtime.outbox.get(c.id)!.status, "needs_review");

    const confirmed = await fetch(`${base}/v1/outbox/${c.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal((await json<{ message: OutboxMessageRecord }>(confirmed)).message.status, "pending");

    // 4) 人工标记已送达（例如在平台后台核对过）
    const marked = await fetch(`${base}/v1/outbox/${c.id}/mark-sent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform_message_id: "om_manual", note: "verified in console" }),
    });
    assert.equal(marked.status, 200);
    const markedBody = await json<{ message: OutboxMessageRecord }>(marked);
    assert.equal(markedBody.message.status, "sent");
    assert.equal(markedBody.message.receipt?.raw?.manual, true);
    assert.equal(adapter.requests.filter((r) => r.id === c.id).length, 1, "人工出口不触发平台请求");

    // 5) 错误路径：非法 status、未知 id
    const badStatus = await fetch(`${base}/v1/outbox?status=bogus`);
    assert.equal(badStatus.status, 400);
    const missing = await fetch(`${base}/v1/outbox/does-not-exist/retry`, { method: "POST" });
    assert.equal(missing.status, 404);
    const badBody = await fetch(`${base}/v1/outbox/${b.id}/mark-sent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform_message_id: "" }),
    });
    assert.equal(badBody.status, 400);

    // 6) 审计：retried / manual sent 以 owner 记账
    const events = runtime.ledger.list({ limit: 200 }).events.filter((e) => e.event_type.startsWith("outbound."));
    const retriedEvent = events.find((e) => e.event_type === OUTBOX_EVENT_TYPES.retried);
    assert.ok(retriedEvent);
    assert.equal(retriedEvent.actor_id, "owner");
    const manualSent = events.filter((e) => e.event_type === OUTBOX_EVENT_TYPES.sent && e.payload.manual === true);
    assert.equal(manualSent.length, 1);
    assert.equal(manualSent[0].actor_id, "owner");
    assert.equal(manualSent[0].idempotency_key, "api-unknown");
    const unknownEvents = events.filter((e) => e.event_type === OUTBOX_EVENT_TYPES.deliveryUnknown);
    assert.equal(unknownEvents.length, 1);
    assert.equal(unknownEvents[0].delivery_unknown, true);

    // 7) 外发事件随同步传播：导出批次包含 outbound.* 与幂等键（跨副本审计可回链）
    const batch = runtime.sync.exportBatch(0, 1000);
    const exported = batch.envelopes.find((e) => e.envelope.event_type === OUTBOX_EVENT_TYPES.queued)?.envelope;
    assert.ok(exported, "outbound.queued 在同步导出批次中");
    assert.equal(exported.idempotency_key, "api-ok");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
