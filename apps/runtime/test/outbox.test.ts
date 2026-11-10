// Outbox 外发接缝测试（M4-T2 / Issue #39，PRD §4.3 FR-TASK-6/7 / §4.4 FR-CH-7）：
// - 先落库再投递；幂等键冲突只入队一次；
// - 投递成功按回执更新；明确失败指数退避；超时/回执未知不自动重发；
// - 崩溃恢复语义（真实子进程：发请求后 SIGKILL）；
// - 人工 retry / mark-sent 审计、批量并发上限、租约 fencing。
// 全部注入 ChannelAdapter 桩与时钟：零网络、零真实等待。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLedger } from "../src/ledger.ts";
import { LeaseStore } from "../src/lease/store.ts";
import {
  OutboxChannelError,
  OutboxError,
  OutboxService,
  OUTBOX_EVENT_TYPES,
  type OutboxChannelAdapter,
  type OutboxSendOutcome,
  type OutboxSendRequest,
} from "../src/outbox/service.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const TASK = "01936b9d-8f7a-7abc-9f2e-0000000000aa";

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

function clock(startIso = "2026-01-01T00:00:00.000Z"): Clock {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

/** 计数的 ChannelAdapter 桩：按预设脚本返回结果，并记录每次请求（平台侧收到的次数）。 */
class StubAdapter implements OutboxChannelAdapter {
  readonly requests: OutboxSendRequest[] = [];
  #script: Array<OutboxSendOutcome | (() => Promise<OutboxSendOutcome>)>;
  #fallback: OutboxSendOutcome;
  active = 0;
  maxActive = 0;

  constructor(
    script: Array<OutboxSendOutcome | (() => Promise<OutboxSendOutcome>)> = [],
    fallback: OutboxSendOutcome = { kind: "sent", receipt: { platform_message_id: "om_default" } },
  ) {
    this.#script = [...script];
    this.#fallback = fallback;
  }

  async send(request: OutboxSendRequest): Promise<OutboxSendOutcome> {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const next = this.#script.shift();
      if (next === undefined) return this.#fallback;
      return typeof next === "function" ? await next() : next;
    } finally {
      this.active -= 1;
    }
  }
}

function openService(
  dir: string,
  c: Clock,
  adapter: OutboxChannelAdapter | null,
  overrides: Partial<ConstructorParameters<typeof OutboxService>[0]> = {},
): { service: OutboxService; ledger: EventLedger } {
  const ledger = EventLedger.open(dir);
  const service = new OutboxService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    adapter,
    now: () => c.now(),
    ...overrides,
  });
  return { service, ledger };
}

function outbound(key: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key,
    channelId: "feishu",
    accountId: "bot-1",
    target: { kind: "conversation" as const, id: "oc_group_1" },
    payload: { text: `hello ${key}` },
    ...overrides,
  };
}

test("幂等键冲突只入队一次；投递成功后平台侧只收到一次并落 receipt", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const adapter = new StubAdapter();
  const { service, ledger } = openService(dir, c, adapter);
  try {
    const first = service.enqueue(outbound("idem-1"));
    assert.equal(first.deduped, false);
    const second = service.enqueue(outbound("idem-1", { payload: { text: "different" } }));
    assert.equal(second.deduped, true);
    assert.equal(second.message.id, first.message.id, "同一幂等键返回既有行");
    assert.equal(service.list({}).total, 1, "重复提交不新增行");

    const summary = await service.dispatchOnce();
    assert.equal(summary.sent, 1);
    assert.equal(adapter.requests.length, 1, "平台侧只收到一次");

    const record = service.get(first.message.id);
    assert.ok(record);
    assert.equal(record.status, "sent");
    assert.equal(record.attempts, 1);
    assert.equal(record.receipt?.platform_message_id, "om_default");
    assert.ok(record.receipt?.sent_at, "回执带平台确认时间");

    const events = ledger.list({ limit: 200 }).events;
    const outboundEvents = events.filter((e) => e.event_type.startsWith("outbound."));
    assert.deepEqual(
      outboundEvents.map((e) => e.event_type),
      [OUTBOX_EVENT_TYPES.queued, OUTBOX_EVENT_TYPES.sent],
      "queued 与 sent 各一次（去重不重复记 queued）",
    );
    const sent = outboundEvents[1];
    assert.equal(sent.idempotency_key, "idem-1", "外发事件信封携带幂等键");
    assert.equal(sent.receipt?.channel, "feishu");
  } finally {
    service.close();
    ledger.close();
    removeDir(dir);
  }
});

test("明确失败按指数退避重试，退避未到期不再投递；成功后 attempts 累计且平台只成功一次", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const adapter = new StubAdapter([
    { kind: "failed", error: "429 rate limited" },
    { kind: "sent", receipt: { platform_message_id: "om_2" } },
  ]);
  const { service, ledger } = openService(dir, c, adapter, { backoffBaseMs: 1000, backoffMaxMs: 4000 });
  try {
    const { id } = service.enqueue(outbound("idem-backoff"));
    const first = await service.dispatchOnce();
    assert.equal(first.failed, 1);
    const failed = service.get(id)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error ?? "", /429/);
    assert.equal(failed.next_attempt_at, "2026-01-01T00:00:01.000Z", "首次失败退避 1×base");

    const tooEarly = await service.dispatchOnce();
    assert.equal(tooEarly.attempted, 0, "退避未到期不取行");
    assert.equal(adapter.requests.length, 1);

    c.advance(1000);
    const second = await service.dispatchOnce();
    assert.equal(second.sent, 1);
    assert.equal(adapter.requests.length, 2);
    const sent = service.get(id)!;
    assert.equal(sent.status, "sent");
    assert.equal(sent.attempts, 2);
    assert.equal(sent.receipt?.platform_message_id, "om_2");
    assert.equal(sent.next_attempt_at, null);

    const types = ledger.list({ limit: 50 }).events.map((e) => e.event_type);
    assert.deepEqual(types, [
      OUTBOX_EVENT_TYPES.queued,
      OUTBOX_EVENT_TYPES.failed,
      OUTBOX_EVENT_TYPES.sent,
    ]);
  } finally {
    service.close();
    ledger.close();
    removeDir(dir);
  }
});

test("明确失败达上限转 needs_review：不再自动投递，平台只收到 maxAttempts 次", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const adapter = new StubAdapter([], { kind: "failed", error: "400 bad request" });
  const { service, ledger } = openService(dir, c, adapter, {
    maxAttempts: 2,
    backoffBaseMs: 100,
  });
  try {
    const { id } = service.enqueue(outbound("idem-cap"));
    await service.dispatchOnce();
    assert.equal(service.get(id)!.status, "failed");
    c.advance(100);
    const summary = await service.dispatchOnce();
    assert.equal(summary.needs_review, 1);
    assert.equal(summary.failed, 0, "达到上限那一次直接转人工核对");

    const record = service.get(id)!;
    assert.equal(record.status, "needs_review");
    assert.equal(record.attempts, 2);
    assert.match(record.last_error ?? "", /max attempts 2 exhausted/);

    c.advance(60_000);
    const later = await service.dispatchOnce();
    assert.equal(later.attempted, 0, "needs_review 不在待投递集合");
    assert.equal(adapter.requests.length, 2);

    const types = ledger.list({ limit: 50 }).events.map((e) => e.event_type);
    assert.deepEqual(types, [
      OUTBOX_EVENT_TYPES.queued,
      OUTBOX_EVENT_TYPES.failed,
      OUTBOX_EVENT_TYPES.failed,
      OUTBOX_EVENT_TYPES.reviewed,
    ]);
    const reviewed = ledger.list({ limit: 50 }).events.at(-1)!;
    assert.equal(reviewed.payload.review_reason, "max_attempts_exhausted");
  } finally {
    service.close();
    ledger.close();
    removeDir(dir);
  }
});

test("超时 → delivery_unknown → needs_review，且任何自动 dispatch 都不重发（平台只收到一次）", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const never = () => new Promise<OutboxSendOutcome>(() => {});
  const adapter = new StubAdapter([never]);
  const { service, ledger } = openService(dir, c, adapter, { sendTimeoutMs: 20 });
  try {
    const { id } = service.enqueue(outbound("idem-timeout"));
    const summary = await service.dispatchOnce();
    assert.equal(summary.delivery_unknown, 1);
    assert.equal(adapter.requests.length, 1, "平台侧恰好收到一次请求");

    const record = service.get(id)!;
    assert.equal(record.status, "needs_review");
    assert.equal(record.attempts, 1);
    assert.match(record.last_error ?? "", /timeout/);

    c.advance(10 * 60_000);
    const later = await service.dispatchOnce();
    assert.equal(later.attempted, 0, "未知状态永不自动重发");
    assert.equal(adapter.requests.length, 1, "平台侧仍只有一次");

    const events = ledger.list({ limit: 50 }).events;
    const types = events.map((e) => e.event_type);
    assert.deepEqual(types, [
      OUTBOX_EVENT_TYPES.queued,
      OUTBOX_EVENT_TYPES.deliveryUnknown,
      OUTBOX_EVENT_TYPES.reviewed,
    ]);
    assert.equal(events[1].delivery_unknown, true, "未知状态在事件信封上显式标记");
    assert.equal(events[2].payload.previous_status, "delivery_unknown");
  } finally {
    service.close();
    ledger.close();
    removeDir(dir);
  }
});

test("未分类异常按网络中断处理（结果未知），不当作可重试失败", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const adapter = new StubAdapter([
    () => Promise.reject(new Error("ECONNRESET")),
  ]);
  const { service } = openService(dir, c, adapter);
  try {
    const { id } = service.enqueue(outbound("idem-network"));
    await service.dispatchOnce();
    const record = service.get(id)!;
    assert.equal(record.status, "needs_review");
    assert.match(record.last_error ?? "", /network: ECONNRESET/);
    const again = await service.dispatchOnce();
    assert.equal(again.attempted, 0);
    assert.equal(adapter.requests.length, 1);
  } finally {
    service.close();
    removeDir(dir);
  }
});

test("人工 retry：needs_review 必须显式 confirmed；重试后 pending → 投递成功，审计留痕", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const adapter = new StubAdapter([
    () => new Promise<OutboxSendOutcome>(() => {}),
    { kind: "sent", receipt: { platform_message_id: "om_retry" } },
  ]);
  const { service, ledger } = openService(dir, c, adapter, { sendTimeoutMs: 20 });
  try {
    const { id } = service.enqueue(outbound("idem-retry"));
    await service.dispatchOnce();
    assert.equal(service.get(id)!.status, "needs_review");

    assert.throws(
      () => service.retry(id),
      (err: unknown) => err instanceof OutboxError && err.code === "confirmation_required",
      "needs_review 未确认不得重试",
    );
    assert.equal(service.get(id)!.status, "needs_review", "拒绝后状态不变");

    const retried = service.retry(id, { confirmed: true });
    assert.equal(retried.status, "pending");
    assert.equal(retried.attempts, 0, "人工重试开启新的尝试周期");
    const retryEvent = ledger.list({ limit: 50 }).events.at(-1)!;
    assert.equal(retryEvent.event_type, OUTBOX_EVENT_TYPES.retried);
    assert.equal(retryEvent.actor_id, "owner", "人工动作 actor 必须是 owner");
    assert.equal(retryEvent.payload.previous_status, "needs_review");
    assert.equal(retryEvent.payload.confirmed, true);

    const summary = await service.dispatchOnce();
    assert.equal(summary.sent, 1);
    assert.equal(adapter.requests.length, 2, "人工重试才发生第二次平台请求");
    assert.equal(service.get(id)!.receipt?.platform_message_id, "om_retry");
  } finally {
    service.close();
    ledger.close();
    removeDir(dir);
  }
});

test("人工 mark-sent：未知状态转已送达并落 manual receipt，审计 actor=owner", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const adapter = new StubAdapter([() => new Promise<OutboxSendOutcome>(() => {})]);
  const { service, ledger } = openService(dir, c, adapter, { sendTimeoutMs: 20 });
  try {
    const { id } = service.enqueue(outbound("idem-manual"));
    await service.dispatchOnce();
    c.advance(5000);
    const marked = service.markSent(id, { platformMessageId: "om_manual", note: "checked in platform console" });
    assert.equal(marked.status, "sent");
    assert.equal(marked.receipt?.platform_message_id, "om_manual");
    assert.equal(marked.receipt?.raw?.manual, true);
    assert.equal(marked.receipt?.sent_at, "2026-01-01T00:00:05.000Z");

    const event = ledger.list({ limit: 50 }).events.at(-1)!;
    assert.equal(event.event_type, OUTBOX_EVENT_TYPES.sent);
    assert.equal(event.actor_id, "owner");
    assert.equal(event.payload.manual, true);
    assert.equal(event.receipt?.channel, "feishu");
    assert.equal(event.receipt?.remote_message_id, "om_manual");

    const again = await service.dispatchOnce();
    assert.equal(again.attempted, 0);
    assert.equal(adapter.requests.length, 1);
  } finally {
    service.close();
    ledger.close();
    removeDir(dir);
  }
});

test("租约 fencing：活跃租约 token 失效时拒绝投递（不发请求）并保留待投递", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const adapter = new StubAdapter();
  const leases = new LeaseStore({ dataDir: dir, now: () => c.now() });
  const { service, ledger } = openService(dir, c, adapter, {
    leases,
    backoffBaseMs: 100,
  });
  try {
    const acquired = leases.acquire(TASK, REPLICA, 1000);
    assert.ok("token" in acquired);
    const token = acquired.token;

    const ok = service.enqueue(outbound("idem-lease-ok", { taskId: TASK, fencingToken: token }));
    assert.equal((await service.dispatchOnce()).sent, 1);
    assert.equal(adapter.requests.length, 1);

    // 租约过期后另一副本接管 → token+1；旧 token 从此失效。
    c.advance(1500);
    const taken = leases.acquire(TASK, "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f", 1000);
    assert.ok("token" in taken);
    assert.ok(taken.token > token);

    const stale = service.enqueue(outbound("idem-lease-stale", { taskId: TASK, fencingToken: token }));
    const summary = await service.dispatchOnce();
    assert.equal(summary.deferred, 1);
    assert.equal(summary.attempted, 0);
    assert.equal(adapter.requests.length, 1, "fencing 失败不发请求");

    const record = service.get(stale.id)!;
    assert.equal(record.status, "pending", "仍等待投递，不冒充失败");
    assert.match(record.last_error ?? "", /lease_lost/);
    assert.ok(record.next_attempt_at !== null);

    const event = ledger.list({ limit: 50 }).events.at(-1)!;
    assert.equal(event.event_type, OUTBOX_EVENT_TYPES.failed);
    assert.equal(event.payload.code, "lease_lost");
    assert.equal(event.task_id, TASK, "任务关联随事件传播");
  } finally {
    service.close();
    leases.close();
    ledger.close();
    removeDir(dir);
  }
});

test("批量投递遵守并发上限", async () => {
  const dir = tmpDir("morrow-outbox-");
  const c = clock();
  const slow: OutboxChannelAdapter = {
    async send(request) {
      adapter.requests.push(request);
      adapter.active += 1;
      adapter.maxActive = Math.max(adapter.maxActive, adapter.active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      adapter.active -= 1;
      return { kind: "sent", receipt: { platform_message_id: `om_${request.idempotency_key}` } };
    },
  };
  const adapter = new StubAdapter();
  const { service } = openService(dir, c, slow, { concurrency: 2 });
  try {
    for (let i = 0; i < 5; i += 1) service.enqueue(outbound(`idem-batch-${i}`));
    const summary = await service.dispatchOnce();
    assert.equal(summary.sent, 5);
    assert.equal(adapter.requests.length, 5);
    assert.equal(adapter.maxActive, 2, "并发上限 2 生效");
    assert.equal(service.list({ status: "sent" }).total, 5);
  } finally {
    service.close();
    removeDir(dir);
  }
});

test("崩溃恢复（真实进程 SIGKILL）：已发请求无回执 → 重启后 needs_review，绝不重发", async () => {
  const dir = tmpDir("morrow-outbox-crash-");
  const childPath = fileURLToPath(new URL("./fixtures/outbox-crash-child.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-sqlite", "--experimental-strip-types", childPath, dir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForLine(child, "SENT", 15_000);
    assert.ok(existsSync(join(dir, "platform-received")), "平台侧已收到请求（先于崩溃）");

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const marker = JSON.parse(readFileSync(join(dir, "platform-received"), "utf8")) as { key: string };
    assert.equal(marker.key, "crash-key-1");

    // 重启：新进程只做恢复与再次 dispatch —— 新的适配器计数必须为 0。
    const c = clock("2026-01-01T00:10:00.000Z");
    const adapter = new StubAdapter();
    const { service, ledger } = openService(dir, c, adapter);
    try {
      const list = service.list({});
      assert.equal(list.total, 1);
      const before = list.messages[0];
      assert.equal(before.status, "pending", "崩溃时未及更新状态");
      assert.ok(before.last_attempt_at !== null, "请求已发出（attempts/last_attempt_at 先落库）");
      assert.equal(before.attempts, 1);

      const recovery = service.recoverStartup();
      assert.deepEqual(recovery, { recovered: 1, reviewed: 1 });

      const after = service.get(before.id);
      assert.ok(after);
      assert.equal(after.status, "needs_review");
      assert.match(after.last_error ?? "", /process_interrupted_after_dispatch_start/);

      const dispatch = await service.dispatchOnce();
      assert.equal(dispatch.attempted, 0, "恢复后不自动重发");
      assert.equal(adapter.requests.length, 0, "平台侧没有第二次请求");

      const types = ledger.list({ limit: 50 }).events.map((e) => e.event_type);
      assert.deepEqual(types, [
        OUTBOX_EVENT_TYPES.queued,
        OUTBOX_EVENT_TYPES.deliveryUnknown,
        OUTBOX_EVENT_TYPES.reviewed,
      ]);
      const unknown = ledger.list({ limit: 50 }).events[1];
      assert.equal(unknown.delivery_unknown, true);
      assert.equal(unknown.payload.recovered_from, "pending");
    } finally {
      service.close();
      ledger.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    removeDir(dir);
  }
});

/** 等待子进程 stdout 出现指定行；子进程提前退出则失败。 */
function waitForLine(child: ReturnType<typeof spawn>, needle: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${needle}; stdout=${buffer}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.split("\n").some((line) => line.trim() === needle)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      reject(new Error(`child exited before ${needle} (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

test("迁移幂等：同一 dataDir 重复打开不丢行、不重复建表；重启后仍可继续投递", async () => {
  const dir = tmpDir("morrow-outbox-migrate-");
  const c = clock();
  const first = openService(dir, c, new StubAdapter());
  try {
    first.service.enqueue(outbound("idem-migrate"));
    assert.equal(first.service.list({}).total, 1);
  } finally {
    first.service.close();
    first.ledger.close();
  }

  const adapter = new StubAdapter();
  const second = openService(dir, c, adapter);
  try {
    assert.equal(second.service.list({}).total, 1, "重启后行仍在");
    const summary = await second.service.dispatchOnce();
    assert.equal(summary.sent, 1);
  } finally {
    second.service.close();
    second.ledger.close();
    removeDir(dir);
  }
});

test("指数退避按 2^n 增长且有上限（base 100ms / max 250ms）", async () => {
  const dir = tmpDir("morrow-outbox-backoff-");
  const c = clock();
  const adapter = new StubAdapter([], { kind: "failed", error: "503 unavailable" });
  const { service } = openService(dir, c, adapter, {
    maxAttempts: 10,
    backoffBaseMs: 100,
    backoffMaxMs: 250,
  });
  try {
    const { id } = service.enqueue(outbound("idem-backoff-cap"));
    const nextTimes: Array<string | null> = [];
    for (const advance of [0, 100, 200, 250]) {
      if (advance > 0) c.advance(advance);
      await service.dispatchOnce();
      nextTimes.push(service.get(id)!.next_attempt_at);
    }
    assert.deepEqual(nextTimes, [
      "2026-01-01T00:00:00.100Z",
      "2026-01-01T00:00:00.300Z",
      "2026-01-01T00:00:00.550Z",
      "2026-01-01T00:00:00.800Z",
    ]);
    assert.equal(service.get(id)!.attempts, 4);
    assert.equal(service.get(id)!.status, "failed");
  } finally {
    service.close();
    removeDir(dir);
  }
});
