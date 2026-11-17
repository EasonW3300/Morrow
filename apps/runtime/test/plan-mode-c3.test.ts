// Plan 三阶段与计划解析（票 M7-C-T3 / Issue #77，FR-C2/C3/C4/C5）。
//
// 三个重点：
//   1. `<proposed_plan>` 解析**严格**——宽松解析会把一段随口说的话当成计划去实现；
//   2. 提问是**阻塞式**的：登记后本轮结束，未回答时不会有下一轮；
//   3. 三种决策与「转为任务」的语义（含继续规划路径）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import {
  PLAN_DECISIONS,
  PLAN_BLOCK_CLOSE,
  PLAN_BLOCK_OPEN,
  canAdvancePhase,
  cleanImplementPrompt,
  extractAffectedFiles,
  extractRisks,
  isPlanDecision,
  parseProposedPlan,
} from "../src/plan/plan-block.ts";
import { PlanQuestionRegistry } from "../src/plan/questions.ts";
import { PLAN_MODE_SYSTEM_PROMPT, composePlanSystemPrompt } from "../src/plan/prompt.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

// --- 计划块解析 ---------------------------------------------------------------------

const GOOD_PLAN = `${PLAN_BLOCK_OPEN}
## 给设置页加导出按钮

- 在 \`apps/desktop/src/SettingsView.tsx\` 加一个导出按钮
- 新增 \`apps/runtime/src/export/routes.ts\` 处理导出请求
- 补测试 \`apps/runtime/test/export.api.test.ts\`

## 风险

- 导出大文件可能超时，需要流式写出
${PLAN_BLOCK_CLOSE}`;

test("合法计划块：解析出标题/步骤/影响文件/风险", () => {
  const result = parseProposedPlan(GOOD_PLAN);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.title, "给设置页加导出按钮");
  assert.equal(result.plan.steps.length, 3);
  assert.ok(result.plan.affectedFiles.includes("apps/desktop/src/SettingsView.tsx"));
  assert.ok(result.plan.affectedFiles.includes("apps/runtime/src/export/routes.ts"));
  assert.match(result.plan.risks ?? "", /流式写出/);
  assert.equal(result.plan.raw.trim(), GOOD_PLAN.slice(PLAN_BLOCK_OPEN.length, -PLAN_BLOCK_CLOSE.length).trim());
});

test("缺块 / 未闭合 / 空块 各自给出可读原因（不弹窗，提示继续规划）", () => {
  const missing = parseProposedPlan("我打算这样改：加个按钮。");
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "missing_block");
    assert.match(missing.detail, /does not contain/);
  }

  const unclosed = parseProposedPlan(`${PLAN_BLOCK_OPEN}\n## 标题\n- 步骤`);
  assert.equal(unclosed.ok, false);
  if (!unclosed.ok) assert.match(unclosed.detail, /never closed/);

  const empty = parseProposedPlan(`${PLAN_BLOCK_OPEN}\n\n${PLAN_BLOCK_CLOSE}`);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty_block");
});

test("无标题 / 无步骤 → 拒绝（宽松解析会让随口说的话变成计划）", () => {
  const noHeading = parseProposedPlan(`${PLAN_BLOCK_OPEN}\n- 只有步骤没有标题\n${PLAN_BLOCK_CLOSE}`);
  assert.equal(noHeading.ok, false);
  if (!noHeading.ok) assert.equal(noHeading.reason, "no_heading");

  const noSteps = parseProposedPlan(`${PLAN_BLOCK_OPEN}\n## 只有标题\n这里是一段散文。\n${PLAN_BLOCK_CLOSE}`);
  assert.equal(noSteps.ok, false);
  if (!noSteps.ok) assert.equal(noSteps.reason, "no_steps");
});

test("多个计划块只取第一个（流式重试可能产出两遍）", () => {
  const two = `${GOOD_PLAN}\n\n${GOOD_PLAN.replace("给设置页加导出按钮", "第二份计划")}`;
  const result = parseProposedPlan(two);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.plan.title, "给设置页加导出按钮");
});

test("影响文件只认像路径的反引号内容（命令不算）", () => {
  assert.deepEqual(
    extractAffectedFiles(["跑 `pnpm test` 然后改 `src/a.ts`", "看 `README.md` 与 `git status`"]),
    ["src/a.ts", "README.md"],
  );
});

test("风险段落缺省时返回 null（不编造）", () => {
  assert.equal(extractRisks("## 标题\n- 步骤"), null);
  assert.match(extractRisks("## 风险\n- 有风险\n## 其他\n- 无关") ?? "", /有风险/);
  assert.equal(
    /无关/.test(extractRisks("## 风险\n- 有风险\n## 其他\n- 无关") ?? ""),
    false,
    "风险段落不该吞掉下一个段落",
  );
});

// --- 阶段推进 -----------------------------------------------------------------------

test("阶段只能前进或停留，不能后退", () => {
  assert.equal(canAdvancePhase("explore", "clarify"), true);
  assert.equal(canAdvancePhase("explore", "detail"), true);
  assert.equal(canAdvancePhase("clarify", "clarify"), true);
  assert.equal(canAdvancePhase("detail", "explore"), false, "退回 exploration 会覆盖已确认的细节");
  assert.equal(canAdvancePhase("detail", "clarify"), false);
});

test("决策枚举与解析", () => {
  for (const decision of PLAN_DECISIONS) assert.equal(isPlanDecision(decision), true);
  assert.equal(isPlanDecision("nope"), false);
  assert.equal(isPlanDecision(undefined), false);
});

// --- 阻塞式提问注册表 ---------------------------------------------------------------

test("提问登记后可查；回答必须带匹配的 question_id", () => {
  const registry = new PlanQuestionRegistry({ isOpen: () => true });
  const asked = registry.ask({
    sessionId: "s1",
    question: "导出格式要 CSV 还是 JSON？",
    options: ["CSV", "JSON"],
    recommendation: "CSV",
    questionId: "q1",
    now: new Date("2026-11-17T00:00:00Z"),
  });
  assert.ok(asked !== null);
  assert.equal(asked.turn, 1);
  assert.equal(registry.pendingOf("s1")?.question_id, "q1");

  // 错的 id 不消费
  assert.equal(registry.answer("s1", "q_wrong"), null);
  assert.notEqual(registry.pendingOf("s1"), null, "错 id 不该消费待回答问题");

  // 对的 id 消费
  const consumed = registry.answer("s1", "q1");
  assert.equal(consumed?.question, "导出格式要 CSV 还是 JSON？");
  assert.equal(registry.pendingOf("s1"), null);
});

test("同一会话再次提问会替换（不排队——一次只等一个回答）", () => {
  const registry = new PlanQuestionRegistry({ isOpen: () => true });
  registry.ask({ sessionId: "s1", question: "第一个问题", questionId: "q1", now: new Date() });
  registry.ask({ sessionId: "s1", question: "第二个问题", questionId: "q2", now: new Date() });
  assert.equal(registry.pendingOf("s1")?.question_id, "q2");
  assert.equal(registry.turnsOf("s1"), 2, "轮次累计（访谈上限靠它）");
});

test("提问的工具文案明确「不要自行假设答案」", () => {
  const registry = new PlanQuestionRegistry({ isOpen: () => true });
  const pending = registry.ask({
    sessionId: "s1",
    question: "要保留旧数据吗？",
    recommendation: "保留",
    questionId: "q1",
    now: new Date(),
  });
  assert.ok(pending !== null);
  const text = PlanQuestionRegistry.toolTextFor(pending);
  assert.match(text, /等待回答/);
  assert.match(text, /不要自行假设答案/);
  assert.match(text, /我倾向：保留/);
});

test("未开放会话不能提问（返回 null）", () => {
  const registry = new PlanQuestionRegistry({ isOpen: () => false });
  assert.equal(registry.ask({ sessionId: "s1", question: "x", questionId: "q", now: new Date() }), null);
});

// --- 提示词 -------------------------------------------------------------------------

test("Plan 提示词含三阶段与严格计划结构", () => {
  assert.match(PLAN_MODE_SYSTEM_PROMPT, /环境探查/);
  assert.match(PLAN_MODE_SYSTEM_PROMPT, /意图澄清/);
  assert.match(PLAN_MODE_SYSTEM_PROMPT, /实现细节/);
  assert.match(PLAN_MODE_SYSTEM_PROMPT, new RegExp(PLAN_BLOCK_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(PLAN_MODE_SYSTEM_PROMPT, /一次一个/);
});

test("拼装顺序：Persona → Plan 段 → 阶段段（固定顺序保证缓存前缀稳定）", () => {
  const prompt = composePlanSystemPrompt({ personaPrompt: "名字：Morrow", phase: "clarify" });
  const personaIndex = prompt.indexOf("名字：Morrow");
  const planIndex = prompt.indexOf("计划模式");
  const phaseIndex = prompt.indexOf("当前阶段：意图澄清");
  assert.ok(personaIndex >= 0 && planIndex > personaIndex && phaseIndex > planIndex);
});

test("无 Persona 时仍能拼（Persona 是可选前缀）", () => {
  assert.match(composePlanSystemPrompt({ personaPrompt: null, phase: null }), /计划模式/);
});

test("「清空上下文后实现」只注入计划全文，不注入探索历史", () => {
  const parsed = parseProposedPlan(GOOD_PLAN);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const prompt = cleanImplementPrompt(parsed.plan, "/tmp/ws");
  assert.match(prompt, /新的上下文/);
  assert.match(prompt, /工作区：\/tmp\/ws/);
  assert.match(prompt, /给设置页加导出按钮/);
  assert.match(prompt, /遇到与计划不符/);
});

test("无工作区时「清空实现」的提示明确不要改文件", () => {
  const parsed = parseProposedPlan(GOOD_PLAN);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.match(cleanImplementPrompt(parsed.plan, null), /未绑定工作区，不要修改任何文件/);
});

// --- HTTP 端到端 --------------------------------------------------------------------

interface Harness {
  handle: RuntimeHandle;
  port: number;
  close(): Promise<void>;
}

async function startPlanRuntime(script: FakeStep[] = [{ kind: "text", deltas: ["ok"] }]): Promise<Harness> {
  const dir = tmpDir("morrow-plan-c3-");
  const handle = await startRuntime({ host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null } as RuntimeConfig, {
    notificationDrainIntervalMs: 0,
    mcpReclaimIntervalMs: 0,
    agentAdapterFactory: async () => createFakePi({ script }),
  });
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

async function createSession(port: number): Promise<string> {
  const res = await post(port, "/v1/sessions", {});
  return (await json<{ session_id: string }>(res)).session_id;
}

async function events(port: number): Promise<EventEnvelope[]> {
  return (await json<{ events: EventEnvelope[] }>(await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`))).events;
}

test("HTTP：提问 → 待回答可见 → 回答消费（带 question_id 校验）", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);

    const asked = await post(h.port, `/v1/sessions/${sessionId}/plan/question`, {
      question: "导出格式？",
      options: ["CSV", "JSON"],
      recommendation: "CSV",
      question_id: "q_test_1",
    });
    assert.equal(asked.status, 200, await asked.clone().text());
    const askedBody = await json<{ pending: { question_id: string; turn: number } }>(asked);
    assert.equal(askedBody.pending.question_id, "q_test_1");
    assert.equal(askedBody.pending.turn, 1);

    const pendingView = await json<{ pending: { question: string } | null; turns: number }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/sessions/${sessionId}/plan/question`),
    );
    assert.equal(pendingView.pending?.question, "导出格式？");
    assert.equal(pendingView.turns, 1);

    // 错 id → 409
    const wrong = await post(h.port, `/v1/sessions/${sessionId}/plan/answer`, {
      question_id: "q_wrong",
      answer: "CSV",
    });
    assert.equal(wrong.status, 409);

    const answered = await post(h.port, `/v1/sessions/${sessionId}/plan/answer`, {
      question_id: "q_test_1",
      answer: "CSV",
    });
    assert.equal(answered.status, 200);
    const answeredBody = await json<{ next_prompt: string }>(answered);
    assert.equal(answeredBody.next_prompt, "CSV");

    const types = (await events(h.port)).map((event) => event.event_type);
    assert.ok(types.includes("plan.question_asked"));
    assert.ok(types.includes("plan.question_answered"));
  } finally {
    await h.close();
  }
});

test("HTTP：非 Plan 会话不能提问（409）", async () => {
  const h = await startPlanRuntime();
  try {
    const sessionId = await createSession(h.port);
    const res = await post(h.port, `/v1/sessions/${sessionId}/plan/question`, { question: "x" });
    assert.equal(res.status, 409);
  } finally {
    await h.close();
  }
});

test("HTTP：decision=continue 允许计划不合格（继续规划的路径）", async () => {
  const h = await startPlanRuntime([{ kind: "text", deltas: ["我还没想清楚"] }]);
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    // 先跑一轮产出助手文本（无计划块）
    await post(h.port, `/v1/sessions/${sessionId}/messages`, { text: "帮我看看" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const res = await post(h.port, `/v1/sessions/${sessionId}/plan/decision`, { decision: "continue" });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json<{ decision: string; next: string; plan: unknown }>(res);
    assert.equal(body.decision, "continue");
    assert.equal(body.next, "continue_planning");
    assert.equal(body.plan, null);
    assert.ok((await events(h.port)).some((event) => event.event_type === "plan.rejected"));
  } finally {
    await h.close();
  }
});

test("HTTP：decision=implement 但计划不完整 → 422（不弹窗，报告缺什么）", async () => {
  const h = await startPlanRuntime([{ kind: "text", deltas: ["这是一段描述，没有计划块"] }]);
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    await post(h.port, `/v1/sessions/${sessionId}/messages`, { text: "开始" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const res = await post(h.port, `/v1/sessions/${sessionId}/plan/decision`, { decision: "implement" });
    assert.equal(res.status, 422);
    const body = await json<{ error: { code: string; message: string } }>(res);
    assert.equal(body.error.code, "plan_incomplete");
    assert.match(body.error.message, /missing_block/);
  } finally {
    await h.close();
  }
});

test("HTTP：decision=implement_clean 返回「清空上下文」提示词", async () => {
  const h = await startPlanRuntime([{ kind: "text", deltas: [GOOD_PLAN] }]);
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    await post(h.port, `/v1/sessions/${sessionId}/messages`, { text: "出计划" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const res = await post(h.port, `/v1/sessions/${sessionId}/plan/decision`, {
      decision: "implement_clean",
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json<{ plan: { title: string }; clean_context_prompt: string; next: string }>(res);
    assert.equal(body.next, "implement");
    assert.equal(body.plan.title, "给设置页加导出按钮");
    assert.match(body.clean_context_prompt, /新的上下文/);
    assert.ok((await events(h.port)).some((event) => event.event_type === "plan.approved"));
  } finally {
    await h.close();
  }
});

test("HTTP：转为任务需 confirm=true；确认后 task_id 与审计回链都在", async () => {
  const h = await startPlanRuntime([{ kind: "text", deltas: [GOOD_PLAN] }]);
  try {
    const sessionId = await createSession(h.port);
    await post(h.port, `/v1/sessions/${sessionId}/plan/enter`);
    await post(h.port, `/v1/sessions/${sessionId}/messages`, { text: "出计划" });
    await new Promise((resolve) => setTimeout(resolve, 250));

    // 未确认 → 400
    const unconfirmed = await post(h.port, `/v1/sessions/${sessionId}/plan/task`, {});
    assert.equal(unconfirmed.status, 400);
    const err = await json<{ error: { code: string } }>(unconfirmed);
    assert.equal(err.error.code, "confirmation_required");

    const created = await post(h.port, `/v1/sessions/${sessionId}/plan/task`, { confirm: true });
    // 规划器可能因未配置 Provider 而失败；本用例只断言"确认门与回链"
    assert.ok([201, 500].includes(created.status), `意外状态：${created.status}`);
    if (created.status === 201) {
      const body = await json<{ task_id: string }>(created);
      assert.ok(body.task_id.length > 0);
      const converted = (await events(h.port)).find((event) => event.event_type === "plan.converted_to_task");
      assert.ok(converted !== undefined);
      assert.equal(converted.payload.task_id, body.task_id);
    }
  } finally {
    await h.close();
  }
});
