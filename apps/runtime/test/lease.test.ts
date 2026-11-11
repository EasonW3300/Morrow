// 执行租约接缝测试（M3-T4 / Issue #33，FR-DEP-4「执行权单点化」）：
// LeaseStore 的 acquire/renew/release/validate/current 语义全部用注入时钟驱动（零 sleep）；
// fencing token 单调递增，过期可抢占、旧 token 立失效；同一 holder 重复 acquire 幂等。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { LeaseStore } from "../src/lease/store.ts";
import { FencingGuard, LeaseLostError } from "../src/lease/fencing.ts";
import { ToolInvoker } from "../src/sandbox/invoker.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const TASK = "01936b9d-8f7a-7abc-9f2e-000000000001";
const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
const TTL = 1_000;

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

/** 可拨快的时钟：租约过期/续租测试不依赖真实等待 */
function clock(startIso = "2026-01-01T00:00:00.000Z"): Clock {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function openStore(dir: string, c: Clock): LeaseStore {
  return new LeaseStore({ dataDir: dir, now: () => c.now() });
}

test("acquire 首次 token=1；同一 holder 重复 acquire 幂等返回同 token（未过期）", () => {
  const dir = tmpDir("morrow-lease-");
  const c = clock();
  const store = openStore(dir, c);
  try {
    const first = store.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in first);
    assert.equal(first.token, 1);

    c.advance(100);
    const again = store.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in again);
    assert.equal(again.token, 1, "同一 holder 未过期时不换 token");
    assert.equal(again.expires_at, first.expires_at);

    const lease = store.current(TASK);
    assert.equal(lease?.fencing_token, 1);
    assert.equal(lease?.holder_replica_id, REPLICA_A);
    assert.equal(lease?.active, true);
  } finally {
    store.close();
    removeDir(dir);
  }
});

test("并发 acquire 只有一个成功，其余被告知持有者（两副本模拟）", () => {
  const dir = tmpDir("morrow-lease-");
  const c = clock();
  const a = openStore(dir, c);
  const b = openStore(dir, c);
  try {
    const aFirst = a.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in aFirst);
    assert.equal(aFirst.token, 1);

    const bAttempt = b.acquire(TASK, REPLICA_B, TTL);
    assert.ok("heldBy" in bAttempt);
    assert.equal(bAttempt.heldBy, REPLICA_A);
    assert.equal(bAttempt.fencing_token, 1);
    assert.equal(b.current(TASK)?.holder_replica_id, REPLICA_A);
  } finally {
    a.close();
    b.close();
    removeDir(dir);
  }
});

test("renew 只延长 expires_at，不换 token；renew 后旧到期时间不再生效", () => {
  const dir = tmpDir("morrow-lease-");
  const c = clock();
  const store = openStore(dir, c);
  try {
    const acquired = store.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in acquired);
    const originalExpiry = Date.parse(acquired.expires_at);

    c.advance(900);
    assert.equal(store.renew(TASK, REPLICA_A, acquired.token), true);
    const lease = store.current(TASK);
    assert.equal(lease?.fencing_token, acquired.token, "renew 不换 token");
    assert.equal(lease?.active, true);
    assert.ok(Date.parse(lease!.expires_at) > originalExpiry, "expires_at 被延长");
    assert.equal(lease?.heartbeat_at, c.now().toISOString());

    c.advance(200);
    assert.equal(store.validate(TASK, acquired.token), true, "续租后覆盖了原到期点");
  } finally {
    store.close();
    removeDir(dir);
  }
});

test("租约过期可被抢占，token 严格 +1，旧持有者的 token 从此失效", () => {
  const dir = tmpDir("morrow-lease-");
  const c = clock();
  const a = openStore(dir, c);
  const b = openStore(dir, c);
  try {
    const first = a.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in first);
    c.advance(TTL); // 到期（>= expires_at）
    assert.equal(a.validate(TASK, first.token), false, "过期 token 无效");
    assert.equal(a.renew(TASK, REPLICA_A, first.token), false, "过期后 renew 失败");

    const takeover = b.acquire(TASK, REPLICA_B, TTL);
    assert.ok("token" in takeover);
    assert.equal(takeover.token, first.token + 1);
    assert.equal(a.validate(TASK, first.token), false, "旧 token 已被新 token 取代");
    assert.equal(b.validate(TASK, takeover.token), true);
  } finally {
    a.close();
    b.close();
    removeDir(dir);
  }
});

test("心跳停止后租约过期：不再 renew 即 validate=false，他人可抢占 token+1", () => {
  const dir = tmpDir("morrow-lease-");
  const c = clock();
  const a = openStore(dir, c);
  const b = openStore(dir, c);
  try {
    const first = a.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in first);
    // 模拟心跳停止：拨过 TTL，不调用 renew
    c.advance(TTL + 1);
    assert.equal(a.current(TASK)?.active, false);
    assert.equal(a.validate(TASK, first.token), false);
    const takeover = b.acquire(TASK, REPLICA_B, TTL);
    assert.ok("token" in takeover);
    assert.equal(takeover.token, 2);
  } finally {
    a.close();
    b.close();
    removeDir(dir);
  }
});

test("release 后他人可抢，token 继续 +1（不重置）", () => {
  const dir = tmpDir("morrow-lease-");
  const c = clock();
  const a = openStore(dir, c);
  const b = openStore(dir, c);
  try {
    const first = a.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in first);
    assert.equal(a.release(TASK, REPLICA_B, first.token), false, "非持有者 release 被拒");
    assert.equal(a.release(TASK, REPLICA_A, first.token), true);
    const released = a.current(TASK);
    assert.equal(released?.holder_replica_id, null);
    assert.equal(released?.active, false);
    assert.equal(released?.fencing_token, first.token, "释放保留 token 计数");

    const next = b.acquire(TASK, REPLICA_B, TTL);
    assert.ok("token" in next);
    assert.equal(next.token, first.token + 1);
  } finally {
    a.close();
    b.close();
    removeDir(dir);
  }
});

test("fencing guard 在租约被抢占后拒绝旧 token 的副作用提交", () => {
  const dir = tmpDir("morrow-lease-");
  const c = clock();
  const a = openStore(dir, c);
  const b = openStore(dir, c);
  try {
    const first = a.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in first);
    const guard = new FencingGuard(a);
    assert.doesNotThrow(() => guard.assertCanCommit(TASK, first.token));

    c.advance(TTL);
    const takeover = b.acquire(TASK, REPLICA_B, TTL);
    assert.ok("token" in takeover);
    assert.throws(
      () => guard.assertCanCommit(TASK, first.token),
      (err: unknown) => err instanceof LeaseLostError && (err as LeaseLostError).code === "lease_lost",
    );
  } finally {
    a.close();
    b.close();
    removeDir(dir);
  }
});

test("ToolInvoker 写操作前置校验：旧 token 在能力执行前被拒，执行体不运行", async () => {
  const dir = tmpDir("morrow-lease-");
  const c = clock();
  const store = openStore(dir, c);
  let executed = 0;
  const invoker = new ToolInvoker({
    runner: { run: async () => { throw new Error("runner must not be used"); } },
    permissionEngine: { assertRuntimeUse: async () => undefined },
    workspaceRoot: dir,
    fencingGuard: (context) => new FencingGuard(store).assertContext(context),
  });
  invoker.register({
    manifest: {
      name: "write",
      version: "1.0.0",
      author: "human",
      runtime: "typescript",
      permissions: {},
      sandbox: { type: "process", network: "none", filesystem: "none" },
    } as never,
    package: { name: "write", kind: "typescript" },
    inProcess: async () => {
      executed += 1;
      return { ok: true, result: { wrote: true } };
    },
  });
  try {
    const first = store.acquire(TASK, REPLICA_A, TTL);
    assert.ok("token" in first);
    const ok = await invoker.invoke("write", {}, { taskId: TASK, fencingToken: first.token });
    assert.equal(ok.ok, true);
    assert.equal(executed, 1);

    // 过期后另一副本抢占 → 旧 token 的执行请求在执行体前被拒
    c.advance(TTL);
    const takeover = store.acquire(TASK, REPLICA_B, TTL);
    assert.ok("token" in takeover);
    await assert.rejects(
      () => invoker.invoke("write", {}, { taskId: TASK, fencingToken: first.token }),
      (err: unknown) => err instanceof LeaseLostError,
    );
    assert.equal(executed, 1, "执行体未运行");
  } finally {
    store.close();
    removeDir(dir);
  }
});

test("acquire 拒绝非正 TTL（诚实参数错误）", () => {
  const dir = tmpDir("morrow-lease-");
  const store = openStore(dir, clock());
  try {
    assert.throws(() => store.acquire(TASK, REPLICA_A, 0), /ttlMs/);
    assert.throws(() => store.acquire(TASK, REPLICA_A, -5), /ttlMs/);
    assert.throws(() => store.acquire(TASK, REPLICA_A, 1.5), /ttlMs/);
  } finally {
    store.close();
    removeDir(dir);
  }
});
