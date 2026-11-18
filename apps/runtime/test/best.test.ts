// Best 访谈与规格确认门（票 M7-C-T6 / Issue #80，FR-C12/C13）。
//
// 重点：
//   1. 访谈每题**必须**带推荐答案（否则 Owner 得从零描述，那就失去意义）；
//   2. 轮次上限到了强制收束并提示信息可能不足；
//   3. 规格门被拒**停在 spec**，不回退访谈；
//   4. 规格缺任何一个小节都不算完成（空小节比缺小节更危险）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePi } from "@morrow/pi-adapter";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import {
  BEST_STAGE_LABELS,
  DEFAULT_INTERVIEW_MAX_TURNS,
  SPEC_SECTIONS,
  afterSpecGateApproved,
  afterSpecGateRejected,
  canAdvanceStage,
  convergenceNotice,
  shouldForceConvergence,
  specSlug,
  validateQuestion,
  validateSpec,
} from "../src/best/stage.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const GOOD_SPEC = `# 给设置页加导出

## Problem Statement
用户无法把配置带走。

## Solution
加一个导出按钮。

## User Stories
1. 作为 Owner，我要导出配置，以便备份。

## Implementation Decisions
新增导出端点。

## Testing Decisions
HTTP 黑盒测试。

## Out of Scope
不做导入。
`;

// --- 阶段转换 -----------------------------------------------------------------------

test("阶段只能按 interview → spec → tickets → implement 前进", () => {
  assert.equal(canAdvanceStage("interview", "spec"), true);
  assert.equal(canAdvanceStage("spec", "tickets"), true);
  assert.equal(canAdvanceStage("tickets", "implement"), true);
  assert.equal(canAdvanceStage("interview", "implement"), false, "不能跳阶段");
});

test("**不允许退回访谈**（规格门被拒时停在 spec）", () => {
  assert.equal(canAdvanceStage("spec", "interview"), false, "退回访谈会丢掉访谈结论");
  assert.equal(canAdvanceStage("tickets", "spec"), false);
});

test("门被拒后的去向是「停在 spec」而非回退", () => {
  const rejected = afterSpecGateRejected();
  assert.equal(rejected.stage, "spec");
  assert.equal(rejected.status, "running");
  assert.match(rejected.note, /停在规格/);
});

test("门通过后进入 tickets（拆票）", () => {
  const approved = afterSpecGateApproved();
  assert.equal(approved.stage, "tickets");
  assert.match(approved.note, /不设确认门/);
});

test("四阶段都有中文标签", () => {
  for (const stage of ["interview", "spec", "tickets", "implement"] as const) {
    assert.ok(BEST_STAGE_LABELS[stage].length > 0);
  }
});

// --- 访谈 ---------------------------------------------------------------------------

test("**每题必须带推荐答案**（缺推荐的问题直接拒绝）", () => {
  const missing = validateQuestion({ question: "要不要支持 CSV？" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.problem, /recommendation/);

  const emptyRecommendation = validateQuestion({ question: "格式？", recommendation: "  " });
  assert.equal(emptyRecommendation.ok, false);

  const ok = validateQuestion({ question: "格式？", recommendation: "CSV", options: ["CSV", "JSON"] });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.question.recommendation, "CSV");
    assert.deepEqual(ok.question.options, ["CSV", "JSON"]);
  }
});

test("问题文本必填", () => {
  assert.equal(validateQuestion({ recommendation: "x" }).ok, false);
  assert.equal(validateQuestion("not an object").ok, false);
});

test("轮次上限：默认 12；到 0 时强制收束并提示信息可能不足", () => {
  assert.equal(DEFAULT_INTERVIEW_MAX_TURNS, 12);
  assert.equal(shouldForceConvergence({ turns: 11, remaining: 1 }), false);
  assert.equal(shouldForceConvergence({ turns: 12, remaining: 0 }), true);

  const notice = convergenceNotice({ turns: 12, remaining: 0 }, 12);
  assert.match(notice, /上限 12 轮/);
  assert.match(notice, /信息可能不足/);

  const normal = convergenceNotice({ turns: 3, remaining: 9 }, 12);
  assert.match(normal, /信息看起来够了/);
  assert.equal(/信息可能不足/.test(normal), false);
});

// --- 规格校验 -----------------------------------------------------------------------

test("完整规格通过校验", () => {
  assert.deepEqual(validateSpec(GOOD_SPEC), { ok: true, missing: [] });
});

test("缺小节 → 报出具体缺哪些", () => {
  const partial = GOOD_SPEC.replace("## Testing Decisions\nHTTP 黑盒测试。\n", "");
  const result = validateSpec(partial);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.missing, ["Testing Decisions"]);
});

test("**空小节也算缺失**（看起来写了，其实没有）", () => {
  const emptySection = GOOD_SPEC.replace("## Testing Decisions\nHTTP 黑盒测试。", "## Testing Decisions\n");
  const result = validateSpec(emptySection);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.missing, ["Testing Decisions"]);
});

test("六个小节全缺时逐一列出", () => {
  const result = validateSpec("# 标题\n\n随便写点东西。");
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.missing, [...SPEC_SECTIONS]);
});

test("specSlug：英文标题转 kebab；中文标题用稳定哈希", () => {
  assert.equal(specSlug("Add Export Button"), "add-export-button");
  assert.equal(specSlug("给设置页加导出"), specSlug("给设置页加导出"), "同标题必须同 slug");
  assert.match(specSlug("给设置页加导出"), /^spec-[0-9a-f]{8}$/);
});

// --- HTTP 端到端 --------------------------------------------------------------------

interface Harness {
  handle: RuntimeHandle;
  port: number;
  close(): Promise<void>;
}

async function startBestRuntime(options: { maxTurns?: number } = {}): Promise<Harness> {
  const dir = tmpDir("morrow-best-");
  const handle = await startRuntime(
    { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null } as RuntimeConfig,
    {
      notificationDrainIntervalMs: 0,
      mcpReclaimIntervalMs: 0,
      goalResumeIntervalMs: 0,
      agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ok"] }] }),
      ...(options.maxTurns === undefined ? {} : { bestInterviewMaxTurns: options.maxTurns }),
    },
  );
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

test("HTTP：启动 best 建承载 goal 并进入访谈", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const res = await post(h.port, "/v1/best", { session_id: sessionId, idea: "给设置页加导出按钮" });
    assert.equal(res.status, 201, await res.clone().text());
    const body = await json<{
      run: { best_id: string; stage: string; stage_label: string; goal_id: string; status: string; interview_count: number };
    }>(res);
    assert.equal(body.run.stage, "interview");
    assert.equal(body.run.stage_label, "访谈");
    assert.equal(body.run.status, "running");
    assert.ok(body.run.goal_id.length > 0, "应由一个 Thread Goal 承载");

    // 承载的 goal 真的存在
    const goal = await json<{ goal: { objective: string } }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/goals/${body.run.goal_id}`),
    );
    assert.match(goal.goal.objective, /\[best\] 给设置页加导出按钮/);
  } finally {
    await h.close();
  }
});

test("HTTP：临时会话禁用 Best（409）", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port, { kind: "ephemeral" });
    const res = await post(h.port, "/v1/best", { session_id: sessionId, idea: "x" });
    assert.equal(res.status, 409);
    assert.equal((await json<{ error: { code: string } }>(res)).error.code, "ephemeral_session");
  } finally {
    await h.close();
  }
});

test("HTTP：同一会话不能并行两个 best（409）", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    assert.equal((await post(h.port, "/v1/best", { session_id: sessionId, idea: "第一件" })).status, 201);
    const again = await post(h.port, "/v1/best", { session_id: sessionId, idea: "第二件" });
    assert.equal(again.status, 409);
    assert.equal((await json<{ error: { code: string } }>(again)).error.code, "best_already_running");
  } finally {
    await h.close();
  }
});

test("HTTP：访谈记录一问一答；缺推荐答案被拒", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const started = await post(h.port, "/v1/best", { session_id: sessionId, idea: "导出" });
    const bestId = (await json<{ run: { best_id: string } }>(started)).run.best_id;

    const missing = await post(h.port, `/v1/best/${bestId}/interview`, {
      question: { question: "格式？" },
      answer: "CSV",
    });
    assert.equal(missing.status, 400);
    assert.match((await json<{ error: { message: string } }>(missing)).error.message, /recommendation/);

    const recorded = await post(h.port, `/v1/best/${bestId}/interview`, {
      question: { question: "导出格式？", recommendation: "CSV", options: ["CSV", "JSON"] },
      answer: "CSV 就好",
    });
    assert.equal(recorded.status, 200, await recorded.clone().text());
    const body = await json<{
      run: { interview_count: number };
      state: { turns: number; remaining: number };
      notice: string;
    }>(recorded);
    assert.equal(body.state.turns, 1);
    assert.equal(body.run.interview_count, 1);
    assert.match(body.notice, /访谈已完成 1 轮/);
  } finally {
    await h.close();
  }
});

test("HTTP：到访谈上限时提示「信息可能不足」", async () => {
  const h = await startBestRuntime({ maxTurns: 2 });
  try {
    const sessionId = await createSession(h.port);
    const bestId = (await json<{ run: { best_id: string } }>(
      await post(h.port, "/v1/best", { session_id: sessionId, idea: "x" }),
    )).run.best_id;

    for (let index = 1; index <= 2; index += 1) {
      const res = await post(h.port, `/v1/best/${bestId}/interview`, {
        question: { question: `问题 ${index}`, recommendation: `推荐 ${index}` },
        answer: `答案 ${index}`,
      });
      assert.equal(res.status, 200);
      const body = await json<{ notice: string; state: { remaining: number } }>(res);
      if (index === 2) {
        assert.equal(body.state.remaining, 0);
        assert.match(body.notice, /信息可能不足/, "到上限必须明确提示");
      }
    }
  } finally {
    await h.close();
  }
});

test("HTTP：提交规格 → 进入 spec 门（awaiting_gate）", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const bestId = (await json<{ run: { best_id: string } }>(
      await post(h.port, "/v1/best", { session_id: sessionId, idea: "导出" }),
    )).run.best_id;

    const res = await post(h.port, `/v1/best/${bestId}/spec`, { markdown: GOOD_SPEC });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json<{
      run: { stage: string; status: string; slug: string };
      gate: string;
      decisions: string[];
    }>(res);
    assert.equal(body.run.stage, "spec");
    assert.equal(body.run.status, "awaiting_gate");
    assert.equal(body.gate, "spec_approval");
    assert.deepEqual(body.decisions, ["approve", "reject"]);
    assert.ok(body.run.slug.length > 0);
  } finally {
    await h.close();
  }
});

test("HTTP：规格不完整 → 422 并列出缺的小节", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const bestId = (await json<{ run: { best_id: string } }>(
      await post(h.port, "/v1/best", { session_id: sessionId, idea: "x" }),
    )).run.best_id;

    const res = await post(h.port, `/v1/best/${bestId}/spec`, { markdown: "# 只是标题\n\n随便写点。" });
    assert.equal(res.status, 422);
    const body = await json<{ error: { code: string; message: string } }>(res);
    assert.equal(body.error.code, "spec_incomplete");
    assert.match(body.error.message, /Problem Statement/);
  } finally {
    await h.close();
  }
});

test("HTTP：规格门被拒 → **停在 spec**（不回退访谈），可再提交", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const bestId = (await json<{ run: { best_id: string } }>(
      await post(h.port, "/v1/best", { session_id: sessionId, idea: "导出" }),
    )).run.best_id;
    await post(h.port, `/v1/best/${bestId}/spec`, { markdown: GOOD_SPEC });

    const rejected = await post(h.port, `/v1/best/${bestId}/spec-gate`, {
      decision: "reject",
      reason: "Out of Scope 写窄了",
    });
    assert.equal(rejected.status, 200);
    const body = await json<{ run: { stage: string; status: string } }>(rejected);
    assert.equal(body.run.stage, "spec", "被拒必须停在规格阶段");
    assert.equal(body.run.status, "running", "可以编辑重提");

    // 还能再次提交规格
    const again = await post(h.port, `/v1/best/${bestId}/spec`, {
      markdown: GOOD_SPEC.replace("不做导入。", "不做导入，也不做同步。"),
    });
    assert.equal(again.status, 200);
  } finally {
    await h.close();
  }
});

test("HTTP：规格门通过 → 进入 tickets 阶段", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const bestId = (await json<{ run: { best_id: string } }>(
      await post(h.port, "/v1/best", { session_id: sessionId, idea: "导出" }),
    )).run.best_id;
    await post(h.port, `/v1/best/${bestId}/spec`, { markdown: GOOD_SPEC });

    const approved = await post(h.port, `/v1/best/${bestId}/spec-gate`, { decision: "approve" });
    assert.equal(approved.status, 200);
    const body = await json<{ run: { stage: string; status: string; next: string } }>(approved);
    assert.equal(body.run.stage, "tickets");
    assert.equal(body.run.status, "running");
    assert.match(body.run.next, /不设确认门/);
  } finally {
    await h.close();
  }
});

test("HTTP：门决策非法值 400；非 spec 阶段调门 409", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const bestId = (await json<{ run: { best_id: string } }>(
      await post(h.port, "/v1/best", { session_id: sessionId, idea: "x" }),
    )).run.best_id;

    // 还在 interview 阶段就调门 → 409
    const tooEarly = await post(h.port, `/v1/best/${bestId}/spec-gate`, { decision: "approve" });
    assert.equal(tooEarly.status, 409);
    assert.equal((await json<{ error: { code: string } }>(tooEarly)).error.code, "invalid_stage");

    await post(h.port, `/v1/best/${bestId}/spec`, { markdown: GOOD_SPEC });
    const bad = await post(h.port, `/v1/best/${bestId}/spec-gate`, { decision: "maybe" });
    assert.equal(bad.status, 400);
  } finally {
    await h.close();
  }
});

test("HTTP：中止 → aborted，遗留物明示", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const bestId = (await json<{ run: { best_id: string } }>(
      await post(h.port, "/v1/best", { session_id: sessionId, idea: "x" }),
    )).run.best_id;

    const aborted = await post(h.port, `/v1/best/${bestId}/abort`, { reason: "不做了" });
    assert.equal(aborted.status, 200);
    const body = await json<{
      run: { status: string };
      leftovers: { branch: string | null; spec_path: string | null };
    }>(aborted);
    assert.equal(body.run.status, "aborted");
    // 现阶段还没有分支，但字段必须在（UI 统一渲染）
    assert.equal(body.leftovers.branch, null);
    assert.equal(body.leftovers.spec_path, null);
  } finally {
    await h.close();
  }
});

test("HTTP：审计记录 stage_changed 与 gate_decided", async () => {
  const h = await startBestRuntime();
  try {
    const sessionId = await createSession(h.port);
    const bestId = (await json<{ run: { best_id: string } }>(
      await post(h.port, "/v1/best", { session_id: sessionId, idea: "x" }),
    )).run.best_id;
    await post(h.port, `/v1/best/${bestId}/spec`, { markdown: GOOD_SPEC });
    await post(h.port, `/v1/best/${bestId}/spec-gate`, { decision: "approve" });

    const events = await json<{ events: Array<{ event_type: string; payload: Record<string, unknown> }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=200`),
    );
    const types = events.events.map((event) => event.event_type);
    assert.ok(types.includes("best.started"));
    assert.ok(types.includes("best.stage_changed"));
    assert.ok(types.includes("best.gate_decided"));

    const stageChange = events.events.find(
      (event) => event.event_type === "best.stage_changed" && event.payload.to === "spec",
    );
    assert.ok(stageChange !== undefined);
    assert.equal(stageChange.payload.from, "interview");

    const gate = events.events.find(
      (event) =>
        event.event_type === "best.gate_decided" &&
        event.payload.gate === "spec_approval" &&
        event.payload.decision === "approve",
    );
    assert.ok(gate !== undefined, "门的决策必须留审计");
  } finally {
    await h.close();
  }
});
