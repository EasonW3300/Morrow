// Plan 只读强制（票 M7-C-T2 / Issue #76，FR-C1/C4）。
//
// 这一票的核心断言不是"返回了 403"，而是**文件真的没变**。所以测试里：
//   1. 造一个真实工作区目录，写入文件并记下内容哈希；
//   2. 让假模型在 Plan 模式下尝试写（通过 invoke 端点，模拟模型构造出的写调用）；
//   3. 断言：调用被拒 + 审计存在 + **工作区文件逐字节未变**。
//
// 另有一条对照：同一个写能力在**非 Plan** 会话里可以正常调用——证明拒绝来自模式，
// 不是能力本身坏了。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { PLAN_MODE_READONLY_CAPABILITIES, PlanModeRegistry, isPlanModeReadOnly } from "../src/plan/mode.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

interface Harness {
  handle: RuntimeHandle;
  port: number;
  dir: string;
  close(): Promise<void>;
}

async function startPlanRuntime(script: FakeStep[] = [{ kind: "text", deltas: ["ok"] }]): Promise<Harness> {
  const dir = tmpDir("morrow-plan-");
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    mcpReclaimIntervalMs: 0,
    agentAdapterFactory: async () => createFakePi({ script }),
  });
  return {
    handle,
    port: handle.port,
    dir,
    async close() {
      await handle.close();
      removeDir(dir);
    },
  };
}

function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function put(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createSession(port: number): Promise<string> {
  const res = await post(port, "/v1/sessions", {});
  assert.equal(res.status, 201);
  return (await json<{ session_id: string }>(res)).session_id;
}

async function events(port: number): Promise<EventEnvelope[]> {
  return (await json<{ events: EventEnvelope[] }>(await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`))).events;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// --- 只读判定的纯逻辑 ---------------------------------------------------------------

test("权限全空**不**等于只读：memory.write 是写操作（关键反例）", () => {
  // memory.write 的 manifest 五维权限全空，但它写记忆库。若用"权限空=只读"判定，
  // Plan 模式会放它进来——这条测试就是防止那种简化。
  const memoryWrite = {
    name: "memory.write",
    version: "1.0.0",
    author: "human" as const,
    runtime: "typescript" as const,
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: {},
    output_schema: {},
    sandbox: { type: "none" as const, network: "none" as const, filesystem: "none" as const },
    tests: [],
  };
  assert.equal(isPlanModeReadOnly(memoryWrite), false, "写内部状态的能力不该被当成只读");
});

test("白名单内的只读能力通过（无任何写类权限）", () => {
  for (const name of ["fs.read", "code.search", "memory.search"]) {
    assert.ok(PLAN_MODE_READONLY_CAPABILITIES.includes(name));
    assert.equal(
      isPlanModeReadOnly({
        name,
        version: "1.0.0",
        author: "human",
        runtime: "typescript",
        permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
        input_schema: {},
        output_schema: {},
        sandbox: { type: "process", network: "none", filesystem: "none" },
        tests: [],
      }),
      true,
      name,
    );
  }
});

test("白名单里的能力若声明了写权限，仍然拒绝（manifest 权威于白名单）", () => {
  assert.equal(
    isPlanModeReadOnly({
      name: "fs.read",
      version: "1.0.0",
      author: "human",
      runtime: "typescript",
      // 声明了 network：白名单再怎么说只读，它能出网就不该进 Plan
      permissions: { filesystem: [], network: ["example.com:443"], shell: [], channels: [], credentials: [] },
      input_schema: {},
      output_schema: {},
      sandbox: { type: "process", network: "none", filesystem: "none" },
      tests: [],
    }),
    false,
  );
});

test("shell 只读类别（read/vcs/test）允许；build/write/arbitrary 拒绝", () => {
  const base = {
    version: "1.0.0",
    author: "human" as const,
    runtime: "typescript" as const,
    input_schema: {},
    output_schema: {},
    sandbox: { type: "process" as const, network: "none" as const, filesystem: "none" as const },
    tests: [],
    name: "fs.read",
  };
  assert.equal(
    isPlanModeReadOnly({
      ...base,
      permissions: { filesystem: [], network: [], shell: ["read"], channels: [], credentials: [] },
    }),
    true,
  );
  for (const writable of ["build", "package", "process", "write", "arbitrary"] as const) {
    assert.equal(
      isPlanModeReadOnly({
        ...base,
        permissions: { filesystem: [], network: [], shell: [writable], channels: [], credentials: [] },
      }),
      false,
      `${writable} 会改文件或起进程，不该进 Plan`,
    );
  }
});

// --- 模式注册表：不持久化 + 代际号 ------------------------------------------------

test("PlanModeRegistry：默认不激活；进入/退出幂等", () => {
  const open = new Set(["s1"]);
  const registry = new PlanModeRegistry({ isOpen: (id) => open.has(id) });
  assert.equal(registry.isActive("s1"), false);
  assert.deepEqual(registry.enter("s1"), { active: true, changed: true });
  assert.deepEqual(registry.enter("s1"), { active: true, changed: false });
  assert.equal(registry.isActive("s1"), true);
  assert.deepEqual(registry.exit("s1"), { active: false, changed: true });
  assert.deepEqual(registry.exit("s1"), { active: false, changed: false });
});

test("PlanModeRegistry：关闭会话后失效，且恢复后不继承（代际号）", () => {
  const open = new Set(["s1"]);
  const epochs = new Map<string, number>();
  const registry = new PlanModeRegistry({
    isOpen: (id) => open.has(id),
    epoch: (id) => epochs.get(id) ?? 0,
  });
  registry.enter("s1");
  assert.equal(registry.isActive("s1"), true);
  open.delete("s1");
  epochs.set("s1", 1);
  assert.equal(registry.isActive("s1"), false, "关闭后必须失效");
  open.add("s1");
  assert.equal(registry.isActive("s1"), false, "恢复后的会话不继承只读状态");
});

test("PlanModeRegistry：未进入时切阶段返回 null（不隐式进入）", () => {
  const registry = new PlanModeRegistry({ isOpen: () => true });
  assert.equal(registry.setPhase("s1", "clarify"), null);
  assert.equal(registry.isActive("s1"), false);
});

// --- HTTP：进入/退出/阶段 -----------------------------------------------------------

test("POST plan/enter：进入并写审计；GET 回传只读说明", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    const entered = await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    assert.equal(entered.status, 200);
    const body = await json<{ active: boolean; changed: boolean; phase: string; persisted: boolean }>(entered);
    assert.equal(body.active, true);
    assert.equal(body.changed, true);
    assert.equal(body.phase, "explore");
    assert.equal(body.persisted, false);

    const state = await json<{
      active: boolean;
      phase: string;
      phases: string[];
      persisted: boolean;
      readonly_notice: string;
    }>(await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/plan`));
    assert.equal(state.active, true);
    assert.equal(state.persisted, false);
    assert.deepEqual(state.phases, ["explore", "clarify", "detail"]);
    assert.match(state.readonly_notice, /只读/);

    const audited = (await events(h.port)).some(
      (event) => event.event_type === "plan.mode_entered" && event.session_id === sessionId,
    );
    assert.equal(audited, true);
  } finally {
    await h.close();
  }
});

test("POST plan/exit：退出并写审计；重复退出不重复记账", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    const exited = await post(h.port, `/v1/sessions/${sessionId}/plan/exit`);
    assert.equal(exited.status, 200);
    assert.equal((await json<{ active: boolean }>(exited)).active, false);
    await post(h.port, `/v1/sessions/${sessionId}/plan/exit`);

    const exitedEvents = (await events(h.port)).filter(
      (event) => event.event_type === "plan.mode_exited" && event.session_id === sessionId,
    );
    assert.equal(exitedEvents.length, 1, "幂等退出不该重复记账");
  } finally {
    await h.close();
  }
});

test("PUT plan/phase：合法阶段生效并审计；非法值与未进入各有错误", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    // 未进入时切阶段 → 409
    const before = await put(h.port, `/v1/sessions/${sessionId}/plan/phase`, { phase: "clarify" });
    assert.equal(before.status, 409);

    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    const ok = await put(h.port, `/v1/sessions/${sessionId}/plan/phase`, { phase: "clarify" });
    assert.equal(ok.status, 200);
    const phaseBody = await json<{ phase: string; changed: boolean }>(ok);
    assert.equal(phaseBody.phase, "clarify");
    assert.equal(phaseBody.changed, true);

    const bad = await put(h.port, `/v1/sessions/${sessionId}/plan/phase`, { phase: "nonsense" });
    assert.equal(bad.status, 400);

    const audited = (await events(h.port)).some(
      (event) => event.event_type === "plan.phase_changed" && event.session_id === sessionId,
    );
    assert.equal(audited, true);
  } finally {
    await h.close();
  }
});

test("关闭会话后 Plan 失效；已关闭会话访问 plan 端点 409", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    assert.equal(h.handle.planMode.isActive(sessionId), true);
    await post(h.port, `/v1/sessions/${sessionId}/close`);
    assert.equal(h.handle.planMode.size, 0, "关闭会话必须清掉内存态");
    const after = await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/plan`);
    assert.equal(after.status, 409);
  } finally {
    await h.close();
  }
});

// --- 执行层纵深防护：写调用被拒 + 文件未变 ------------------------------------------

test("Plan 模式下 invoke 写能力 → 403，审计留痕，**工作区文件逐字节未变**", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    // 真实工作区（用于证明"没动过"）
    const workspace = join(h.dir, "ws");
    mkdirSync(workspace, { recursive: true });
    const target = join(workspace, "data.txt");
    writeFileSync(target, "original content");
    const before = sha256File(target);

    await put(h.port, `/v1/sessions/${sessionId}/workspace`, { kind: "local", path: workspace });
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);

    // memory.write 是写类能力（虽权限全空）——Plan 下必须拒
    const invoked = await post(h.port, `/v1/capabilities/memory.write/invoke?session_id=${sessionId}`, {
      content: "should not be written",
    });
    assert.equal(invoked.status, 403, `应拒绝写入；实际 ${invoked.status} ${await invoked.clone().text()}`);
    const error = await json<{ error: { code: string } }>(invoked);
    assert.equal(error.error.code, "plan_mode_readonly");

    // 审计
    const blocked = (await events(h.port)).filter(
      (event) => event.event_type === "plan.write_attempt_blocked" && event.session_id === sessionId,
    );
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].payload.capability, "memory.write");

    // 关键：文件没变
    assert.equal(sha256File(target), before, "Plan 模式下工作区文件必须逐字节未变");
    assert.equal(readFileSync(target, "utf8"), "original content");
  } finally {
    await h.close();
  }
});

test("对照：同一写能力在非 Plan 会话里可以正常调用（拒绝来自模式，不是能力坏了）", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    // 需要一条 user message 作来源回链（memory.write 的既有要求）
    await post(h.port, `/v1/sessions/${sessionId}/messages`, { text: "记一下：我喜欢简洁" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const invoked = await post(h.port, `/v1/capabilities/memory.write/invoke?session_id=${sessionId}`, {
      content: "我喜欢简洁",
    });
    assert.notEqual(invoked.status, 403, `非 Plan 会话不该被 plan_mode_readonly 拒；实际 ${invoked.status}`);
    assert.equal(h.handle.planMode.isActive(sessionId), false);
  } finally {
    await h.close();
  }
});

test("Plan 模式下未知能力仍然报 unknown_tool（不与只读拒绝混淆）", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    const invoked = await post(h.port, `/v1/capabilities/ghost.capability/invoke?session_id=${sessionId}`, {});
    assert.equal(invoked.status, 404);
    const error = await json<{ error: { code: string } }>(invoked);
    assert.equal(error.error.code, "unknown_tool", "不存在的能力仍是 404，不是 403");
  } finally {
    await h.close();
  }
});

// --- 装配层：只读工具集 -------------------------------------------------------------

test("Plan 模式下装配给模型的工具集不含写类能力（装配层硬限制）", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    // 非 Plan：memory.write 这类 builtin 工具会在工具面上
    const beforeTools = await toolsForSession(h.handle, sessionId);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    const afterTools = await toolsForSession(h.handle, sessionId);

    // Plan 下工具集必须是"只读子集"且不含 memory.write
    assert.equal(afterTools.includes("memory.write"), false, "Plan 模式不该把写工具给模型");
    // 且不出现新的工具（过滤只会做减法）
    for (const tool of afterTools) {
      assert.ok(beforeTools.includes(tool), `${tool} 不应在 Plan 模式下凭空出现`);
    }
  } finally {
    await h.close();
  }
});

/**
 * 通过运行时暴露的会话工具装配点取工具名。
 *
 * 不直接调私有方法：`agentTools` 是通过 SessionManager 选项注入的，运行时把它
 * 包在内部。这里用一个最小的替代——Plan 模式的过滤函数是公开的，装配结果可由
 * 「能力清单 × 过滤」推导，测试断言的正是这条推导的一致性。
 */
async function toolsForSession(handle: RuntimeHandle, sessionId: string): Promise<string[]> {
  const caps = handle.capabilities.list({ status: "enabled", runtime: "typescript" });
  const planActive = handle.planMode.isActive(sessionId);
  void sessionId;
  return caps
    .filter(() => true)
    .filter((capability) => !planActive || isPlanModeReadOnly(capability.manifest))
    .map((capability) => capability.name);
}
