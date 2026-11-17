// Goal 续跑与错误映射（票 M7-C-T5 / Issue #79，FR-C8..C11）。
//
// 续跑决策是纯函数（可穷举），错误分类也是纯函数；真实运行由会话自己的发送路径
// 承担。测试同时覆盖两层：
//   1. 纯逻辑：条件组合 × 错误分类优先级；
//   2. 端到端：真实 tick 是否真的发起了轮次（以及 Plan 下是否**没有**发起）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { GoalDriver } from "../src/goals/driver.ts";
import {
  DEFAULT_RESUME_IDLE_MS,
  classifyRunOutcome,
  decideResume,
  resumePrompt,
} from "../src/goals/resume.ts";
import { errorSignature } from "../src/goals/state.ts";
import type { GoalRecord } from "../src/goals/store.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    goal_id: "g1",
    session_id: "s1",
    objective: "把所有测试补到覆盖率 80%",
    status: "active",
    token_limit: 100_000,
    time_limit_ms: null,
    tokens: 0,
    tokens_estimated: false,
    elapsed_ms: 0,
    runs: 0,
    blocked_streak: 0,
    blocked_signature: null,
    last_error: null,
    best_slug: null,
    created_at: "2026-11-17T00:00:00Z",
    updated_at: "2026-11-17T00:00:00Z",
    ...overrides,
  };
}

// --- 续跑决策（纯函数）-------------------------------------------------------------

test("全部条件满足才续跑", () => {
  const decision = decideResume({
    goal: goal(),
    sessionExecutable: true,
    sessionBusy: false,
    planModeActive: false,
    idleMs: DEFAULT_RESUME_IDLE_MS + 1,
    idleThresholdMs: DEFAULT_RESUME_IDLE_MS,
  });
  assert.equal(decision.resume, true);
  if (decision.resume) assert.equal(decision.reason, "idle_active_goal");
});

test("非 active 状态一律不续跑", () => {
  for (const status of ["paused", "blocked", "usage_limited", "budget_limited", "complete"] as const) {
    const decision = decideResume({
      goal: goal({ status }),
      sessionExecutable: true,
      sessionBusy: false,
      planModeActive: false,
      idleMs: 999_999,
      idleThresholdMs: 1,
    });
    assert.equal(decision.resume, false, status);
    if (!decision.resume) assert.equal(decision.reason, "not_active");
  }
});

test("**Plan 模式下不续跑**（FR-C10 的核心断言）", () => {
  const decision = decideResume({
    goal: goal(),
    sessionExecutable: true,
    sessionBusy: false,
    planModeActive: true,
    idleMs: 999_999,
    idleThresholdMs: 1,
  });
  assert.equal(decision.resume, false);
  if (!decision.resume) assert.equal(decision.reason, "plan_mode_active");
});

test("Plan 检查优先于「忙闲」：只读模式下无论忙闲都不续跑", () => {
  const busy = decideResume({
    goal: goal(),
    sessionExecutable: true,
    sessionBusy: true,
    planModeActive: true,
    idleMs: 999_999,
    idleThresholdMs: 1,
  });
  assert.equal(busy.resume, false);
  if (!busy.resume) assert.equal(busy.reason, "plan_mode_active", "报出的原因应是最根本的那个");

  const idle = decideResume({
    goal: goal(),
    sessionExecutable: true,
    sessionBusy: false,
    planModeActive: true,
    idleMs: 999_999,
    idleThresholdMs: 1,
  });
  assert.equal(idle.resume, false);
  if (!idle.resume) assert.equal(idle.reason, "plan_mode_active");
});

test("会话忙 / 未到静默阈值 / 不可执行 各自不续跑", () => {
  const base = {
    goal: goal(),
    sessionExecutable: true,
    sessionBusy: false,
    planModeActive: false,
    idleMs: 999_999,
    idleThresholdMs: DEFAULT_RESUME_IDLE_MS,
  };
  const busy = decideResume({ ...base, sessionBusy: true });
  assert.equal(busy.resume === false && busy.reason === "session_busy", true);

  const tooSoon = decideResume({ ...base, idleMs: 100 });
  assert.equal(tooSoon.resume === false && tooSoon.reason === "not_idle_long_enough", true);

  const closed = decideResume({ ...base, sessionExecutable: false });
  assert.equal(closed.resume === false && closed.reason === "session_not_executable", true);
});

test("默认静默阈值是 30 秒（太短会在 Owner 刚看完一轮就自跑）", () => {
  assert.equal(DEFAULT_RESUME_IDLE_MS, 30_000);
});

test("续跑提示词带轮次与目标，并要求「卡住就说卡在哪」", () => {
  const prompt = resumePrompt(goal({ runs: 3 }));
  assert.match(prompt, /第 4 轮/);
  assert.match(prompt, /覆盖率 80%/);
  assert.match(prompt, /目标已完成/);
  assert.match(prompt, /卡在哪里/);
});

// --- 结果分类（优先级）-------------------------------------------------------------

test("优先级：预算 > 完成 > 配额 > 阻塞", () => {
  const base = {
    error: null,
    budgetExceeded: false,
    budgetDetail: "",
    blockedThresholdReached: false,
    blockedDetail: "",
  };
  assert.equal(classifyRunOutcome({ ...base, budgetExceeded: true, budgetDetail: "x" }).action, "budget_limited");
  assert.equal(
    classifyRunOutcome({ ...base, budgetExceeded: true, budgetDetail: "x", error: "rate limit" }).action,
    "budget_limited",
    "预算压过配额：两者都停，但预算的处置更明确",
  );
  assert.equal(classifyRunOutcome({ ...base, completed: true }).action, "complete");
  assert.equal(
    classifyRunOutcome({ ...base, error: "429 Too Many Requests", status: 429 }).action,
    "usage_limited",
  );
  assert.equal(
    classifyRunOutcome({ ...base, error: "same failure", blockedThresholdReached: true, blockedDetail: "d" }).action,
    "blocked",
  );
  assert.equal(classifyRunOutcome({ ...base, error: "transient" }).action, "stay_active");
  assert.equal(classifyRunOutcome(base).action, "stay_active");
});

test("配额错误压过阻塞：429 不该先数到 3 轮才发现", () => {
  const action = classifyRunOutcome({
    error: "quota exceeded",
    status: 429,
    budgetExceeded: false,
    budgetDetail: "",
    blockedThresholdReached: true,
    blockedDetail: "3 same failures",
  });
  assert.equal(action.action, "usage_limited");
});

// --- 驱动器：纯逻辑层（假依赖）-----------------------------------------------------

function makeDriverHarness(options: {
  goals: GoalRecord[];
  busy?: Set<string>;
  plan?: Set<string>;
  now?: number;
  lastActivity?: Map<string, number>;
  idleThresholdMs?: number;
}) {
  const sent: Array<{ sessionId: string; text: string }> = [];
  const lastActivity = options.lastActivity ?? new Map<string, number>();
  let clock = options.now ?? 1_000_000;
  const driver = new GoalDriver({
    goals: {
      // 与真实 GoalService 一致：list({status}) 已按状态过滤（driver 只扫描 active）
      list: (filter?: { status?: string }) =>
        filter?.status === undefined
          ? options.goals
          : options.goals.filter((item) => item.status === filter.status),
      get: (id: string) => options.goals.find((item) => item.goal_id === id) ?? null,
      openForSession: () => null,
      recordRun: () => ({ goal: options.goals[0], budget: { exceeded: false }, statusChanged: false }),
      markUsageLimited: () => options.goals[0],
      markBlocked: () => options.goals[0],
      complete: () => options.goals[0],
    } as never,
    isSessionExecutable: () => true,
    isSessionBusy: (sessionId) => options.busy?.has(sessionId) === true,
    isPlanModeActive: (sessionId) => options.plan?.has(sessionId) === true,
    sendMessage: (sessionId, text) => sent.push({ sessionId, text }),
    lastActivityAt: (sessionId) => lastActivity.get(sessionId) ?? 0,
    now: () => clock,
    idleThresholdMs: options.idleThresholdMs ?? 1000,
  });
  return { driver, sent, advanceClock: (ms: number) => (clock += ms) };
}

test("tick：只对符合条件的 goal 发起轮次", () => {
  const activeIdle = goal({ goal_id: "a", session_id: "s_a" });
  const activeBusy = goal({ goal_id: "b", session_id: "s_b" });
  const paused = goal({ goal_id: "c", session_id: "s_c", status: "paused" });
  const harness = makeDriverHarness({
    goals: [activeIdle, activeBusy, paused],
    busy: new Set(["s_b"]),
    now: 10_000,
  });
  const result = harness.driver.tick();
  assert.deepEqual(result.started, ["a"]);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].sessionId, "s_a");
  assert.match(harness.sent[0].text, /继续推进这个目标/);
  // 决策里有三条（每个 active goal 一条；paused 不参与扫描）
  assert.equal(result.decisions.length, 2);
});

test("tick：Plan 模式下的会话一个都不发起（端到端断言）", () => {
  const harness = makeDriverHarness({
    goals: [goal({ goal_id: "a", session_id: "s_a" })],
    plan: new Set(["s_a"]),
    now: 10_000,
  });
  const result = harness.driver.tick();
  assert.deepEqual(result.started, []);
  assert.equal(harness.sent.length, 0, "Plan 模式下不该有任何续跑");
  assert.equal(result.decisions[0].resume === false && result.decisions[0].reason === "plan_mode_active", true);
});

test("tick：刚活动过（未到静默阈值）不发起；等够了再发起", () => {
  const lastActivity = new Map([["s_a", 10_000]]);
  const harness = makeDriverHarness({
    goals: [goal({ goal_id: "a", session_id: "s_a" })],
    now: 10_500, // 只过了 500ms
    lastActivity,
    idleThresholdMs: 1000,
  });
  assert.deepEqual(harness.driver.tick().started, []);
  harness.advanceClock(600); // 现在过了 1100ms
  assert.deepEqual(harness.driver.tick().started, ["a"]);
});

// --- 端到端：真实 runtime ------------------------------------------------------------

interface Harness {
  handle: RuntimeHandle;
  port: number;
  close(): Promise<void>;
}

async function startGoalRuntime(script: FakeStep[], options: { plan?: boolean } = {}): Promise<Harness> {
  const dir = tmpDir("morrow-goal-driver-");
  const handle = await startRuntime(
    { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null } as RuntimeConfig,
    {
      notificationDrainIntervalMs: 0,
      mcpReclaimIntervalMs: 0,
      // 不启定时器：测试手动 tick（避免时序不确定）
      goalResumeIntervalMs: 0,
      goalResumeIdleMs: 0,
      agentAdapterFactory: async () => createFakePi({ script }),
    },
  );
  void options.plan;
  return {
    handle,
    port: handle.port,
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

async function createSession(port: number, body: Record<string, unknown> = {}): Promise<string> {
  return (await json<{ session_id: string }>(await post(port, "/v1/sessions", body))).session_id;
}

test("端到端：tick 真的发起一轮（走会话的发送路径，不是另起运行链）", async () => {
  const h = await startGoalRuntime([{ kind: "text", deltas: ["进行中"] }]);
  try {
    const sessionId = await createSession(h.port);
    const created = await post(h.port, "/v1/goals", {
      session_id: sessionId,
      objective: "写测试",
      token_limit: 1_000_000,
      confirm: true,
    });
    assert.equal(created.status, 201);

    const result = h.handle.goalDriver.tick();
    assert.deepEqual(result.started.length, 1, "应发起一轮");

    // 等这一轮真的落账（proves 走的是会话发送路径）
    await new Promise((resolve) => setTimeout(resolve, 400));
    const events = await json<{ events: Array<{ event_type: string; session_id?: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=200`),
    );
    const userMessages = events.events.filter(
      (event) => event.event_type === "message.user" && event.session_id === sessionId,
    );
    assert.ok(userMessages.length >= 1, "续跑应产生一条 message.user");
  } finally {
    await h.close();
  }
});

test("端到端：Plan 模式下 tick 不发起任何轮次", async () => {
  const h = await startGoalRuntime([{ kind: "text", deltas: ["不该跑"] }]);
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, "/v1/goals", {
      session_id: sessionId,
      objective: "计划模式下不许自跑",
      token_limit: 1_000_000,
      confirm: true,
    });
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);

    const result = h.handle.goalDriver.tick();
    assert.deepEqual(result.started, []);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const events = await json<{ events: Array<{ event_type: string; session_id?: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=200`),
    );
    assert.equal(
      events.events.filter((event) => event.event_type === "message.user" && event.session_id === sessionId).length,
      0,
      "Plan 模式下不该有任何续跑消息",
    );
  } finally {
    await h.close();
  }
});

test("端到端：一轮结束后 goal 的 runs/tokens/elapsed 被推进", async () => {
  const h = await startGoalRuntime([
    { kind: "text", deltas: ["做完一部分"] },
    { kind: "usage", input: 500, output: 100 },
  ]);
  try {
    const sessionId = await createSession(h.port);
    const created = await post(h.port, "/v1/goals", {
      session_id: sessionId,
      objective: "推进",
      token_limit: 1_000_000,
      confirm: true,
    });
    const goalId = (await json<{ goal: { goal_id: string } }>(created)).goal.goal_id;

    h.handle.goalDriver.tick();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const view = await json<{
      goal: { runs: number; usage: { tokens: number; elapsed_ms: number; tokens_estimated: boolean } };
    }>(await fetch(`http://127.0.0.1:${h.port}/v1/goals/${goalId}`));
    assert.ok(view.goal.runs >= 1, `runs 应推进；实际 ${view.goal.runs}`);
    assert.ok(view.goal.usage.tokens > 0, "tokens 应被累加（来自 C1 的 usage 事件）");
  } finally {
    await h.close();
  }
});

test("端到端：429 错误 → usage_limited（不再自动续跑）", async () => {
  const h = await startGoalRuntime([{ kind: "error", message: "429 Too Many Requests" }]);
  try {
    const sessionId = await createSession(h.port);
    const created = await post(h.port, "/v1/goals", {
      session_id: sessionId,
      objective: "配额受限",
      token_limit: 1_000_000,
      confirm: true,
    });
    const goalId = (await json<{ goal: { goal_id: string } }>(created)).goal.goal_id;

    h.handle.goalDriver.tick();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const view = await json<{ goal: { status: string } }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/goals/${goalId}`),
    );
    assert.equal(view.goal.status, "usage_limited", `实际 ${view.goal.status}`);

    // 受限后 tick 不该再发起
    assert.deepEqual(h.handle.goalDriver.tick().started, []);
  } finally {
    await h.close();
  }
});

test("端到端：同一阻塞连续 3 轮 → blocked", async () => {
  const h = await startGoalRuntime([{ kind: "error", message: "connection refused" }]);
  try {
    const sessionId = await createSession(h.port);
    const created = await post(h.port, "/v1/goals", {
      session_id: sessionId,
      objective: "会卡住的目标",
      token_limit: 1_000_000,
      confirm: true,
    });
    const goalId = (await json<{ goal: { goal_id: string } }>(created)).goal.goal_id;

    // 三轮（每轮 tick + 等落账）
    for (let round = 1; round <= 3; round += 1) {
      h.handle.goalDriver.tick();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const view = await json<{ goal: { status: string; blocked_streak: number } }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/goals/${goalId}`),
    );
    assert.equal(view.goal.status, "blocked", `实际 ${view.goal.status}（streak=${view.goal.blocked_streak}）`);
  } finally {
    await h.close();
  }
});

test("错误签名归一化在真实错误上一致（同错不同数字算同一阻塞）", () => {
  assert.equal(
    errorSignature("connect ECONNREFUSED 127.0.0.1:8080"),
    errorSignature("connect ECONNREFUSED 127.0.0.1:9999"),
  );
});
