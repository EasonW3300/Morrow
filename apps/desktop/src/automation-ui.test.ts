// 阶段 C 的 UI 纯逻辑测试（票 M7-C-T8 / Issue #82）。
//
// 重点在"文案不能撒谎"：
//   - Plan 必须一眼看出只读；
//   - 完全权限不能跳实现门这件事必须写在按钮旁边；
//   - Goal 的 token 若是估算必须标注。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BEST_STAGE_LABELS,
  IMPLEMENT_GATE_UI_NOTICE,
  PLAN_CHOICES,
  PLAN_PHASE_LABELS,
  PLAN_READONLY_NOTE,
  SPEC_GATE_NOTICE,
  artifactsSummary,
  bestStageProgress,
  goalCreateDisabledReason,
  goalCreateNotice,
  goalNextStep,
  goalStatusBadge,
  goalUsageSummary,
  implementGateDisabledReason,
  planBadge,
  planParseFailureHint,
  pushConfirmText,
} from "./automation-ui.ts";

// --- Plan ---------------------------------------------------------------------------

test("Plan 徽标：未进入不显示；进入后标注只读或阶段", () => {
  assert.equal(planBadge(false, null), null);
  assert.deepEqual(planBadge(true, "explore"), { tone: "run", label: "计划模式 · 环境探查" });
  assert.deepEqual(planBadge(true, null), { tone: "run", label: "计划模式 · 只读" });
});

test("Plan 只读说明写明「写工具不在工具集里」", () => {
  assert.match(PLAN_READONLY_NOTE, /写工具不会出现在工具集里/);
  assert.match(PLAN_READONLY_NOTE, /留审计/);
});

test("三种实现选择的文案与决策值对应", () => {
  assert.deepEqual(
    PLAN_CHOICES.map((choice) => choice.decision),
    ["implement", "implement_clean", "continue"],
  );
  const clean = PLAN_CHOICES.find((choice) => choice.decision === "implement_clean");
  assert.match(clean?.detail ?? "", /只带计划全文/);
});

test("计划解析失败给出可读原因并引导继续规划（不弹空窗）", () => {
  const hint = planParseFailureHint("no_steps", "the plan block has no steps");
  assert.match(hint, /no_steps/);
  assert.match(hint, /继续规划/);
});

test("三阶段都有中文标签", () => {
  for (const phase of ["explore", "clarify", "detail"] as const) {
    assert.ok(PLAN_PHASE_LABELS[phase].length > 0);
  }
});

// --- Goal ---------------------------------------------------------------------------

function usage(overrides: Partial<Parameters<typeof goalUsageSummary>[0]> = {}) {
  return {
    tokens: 1200,
    tokens_estimated: false,
    elapsed_ms: 90_000,
    runs: 4,
    token_progress: null,
    time_progress: null,
    ...overrides,
  };
}

test("Goal 用量摘要：真实值不标估算", () => {
  const summary = goalUsageSummary(usage());
  assert.match(summary, /1200 tokens/);
  assert.equal(/估算/.test(summary), false);
  assert.match(summary, /90s/);
  assert.match(summary, /4 轮/);
});

test("**估算的 token 必须显式标注**（不让 Owner 误以为是精确值）", () => {
  assert.match(goalUsageSummary(usage({ tokens_estimated: true })), /1200 tokens（估算）/);
});

test("预算进度在摘要里体现", () => {
  const summary = goalUsageSummary(usage({ token_progress: 0.8, time_progress: 0.25 }));
  assert.match(summary, /token 预算已用 80%/);
  assert.match(summary, /时间预算已用 25%/);
});

test("六态徽标各有区分（blocked/usage_limited 不能混）", () => {
  assert.equal(goalStatusBadge("active").label, "进行中");
  assert.equal(goalStatusBadge("blocked").label, "受阻塞");
  assert.equal(goalStatusBadge("usage_limited").label, "上游配额受限");
  assert.equal(goalStatusBadge("budget_limited").tone, "error");
  assert.equal(goalStatusBadge("complete").tone, "ok");
  assert.notEqual(goalStatusBadge("blocked").label, goalStatusBadge("usage_limited").label);
});

test("三种「停下来」的状态都给出明确下一步", () => {
  assert.match(goalNextStep("blocked") ?? "", /连续出现 3 轮/);
  assert.match(goalNextStep("usage_limited") ?? "", /不会再自动续跑/);
  assert.match(goalNextStep("budget_limited") ?? "", /提高 token 预算/);
  assert.match(goalNextStep("complete") ?? "", /不能复活/);
  assert.equal(goalNextStep("active"), null);
});

test("创建 Goal 的确认文案写明自动续跑与预算", () => {
  const notice = goalCreateNotice({ tokenLimit: 100_000, timeLimitMs: 3_600_000 });
  assert.match(notice, /自动继续推进/);
  assert.match(notice, /token 上限 100000/);
  assert.match(notice, /60 分钟/);
  assert.match(notice, /Plan 模式下不会自动续跑/);
});

test("创建按钮：未勾选确认时禁用并说明原因", () => {
  assert.match(
    goalCreateDisabledReason({ objective: "x", confirmed: false, busy: false }) ?? "",
    /自动续跑并消耗预算/,
  );
  assert.equal(goalCreateDisabledReason({ objective: "x", confirmed: true, busy: false }), null);
  assert.notEqual(goalCreateDisabledReason({ objective: "  ", confirmed: true, busy: false }), null);
});

// --- Best ---------------------------------------------------------------------------

test("四阶段进度：当前阶段之前的算完成", () => {
  const progress = bestStageProgress("tickets");
  assert.deepEqual(
    progress.map((item) => item.stage),
    ["interview", "spec", "tickets", "implement"],
  );
  assert.equal(progress.find((item) => item.current)?.stage, "tickets");
  assert.equal(progress.filter((item) => item.done).length, 2);
});

test("四阶段都有中文标签", () => {
  for (const stage of ["interview", "spec", "tickets", "implement"] as const) {
    assert.ok(BEST_STAGE_LABELS[stage].length > 0);
  }
});

test("规格门文案：被拒停在规格、不必重新访谈", () => {
  assert.match(SPEC_GATE_NOTICE, /停在规格阶段/);
  assert.match(SPEC_GATE_NOTICE, /不需要重新访谈/);
  assert.match(SPEC_GATE_NOTICE, /拆票不设确认门/);
});

test("**实现门文案必须明说「完全权限也不能跳」**", () => {
  assert.match(IMPLEMENT_GATE_UI_NOTICE, /完全权限/);
  assert.match(IMPLEMENT_GATE_UI_NOTICE, /不能跳过/);
  assert.match(IMPLEMENT_GATE_UI_NOTICE, /不会推送/);
});

test("实现门按钮：非 tickets 阶段禁用；已批准后不再可点", () => {
  assert.match(implementGateDisabledReason({ stage: "spec", approved: false, busy: false }) ?? "", /先完成拆票/);
  assert.match(implementGateDisabledReason({ stage: "tickets", approved: true, busy: false }) ?? "", /已确认/);
  assert.equal(implementGateDisabledReason({ stage: "tickets", approved: false, busy: false }), null);
});

test("产物清单只列已存在的项", () => {
  const empty = artifactsSummary({ spec_path: null, tickets: [], branch: null, status: "running" });
  assert.deepEqual(empty, []);

  const full = artifactsSummary({
    spec_path: "docs/specs/x.md",
    tickets: [{ title: "a" }, { title: "b" }],
    branch: "feat/x",
    status: "running",
  });
  assert.deepEqual(full, [
    { label: "规格", value: "docs/specs/x.md" },
    { label: "票", value: "2 张" },
    { label: "分支", value: "feat/x" },
  ]);
});

test("中止后产物清单明示遗留物未自动清理", () => {
  const summary = artifactsSummary({
    spec_path: "docs/specs/x.md",
    tickets: [{ title: "a" }],
    branch: "feat/x",
    status: "aborted",
  });
  assert.ok(summary.some((item) => item.value.includes("遗留物未自动清理")));
});

test("推送确认文案写明对外可见且不易撤回", () => {
  const text = pushConfirmText({ branch: "feat/x" });
  assert.match(text, /feat\/x/);
  assert.match(text, /对外可见/);
  assert.match(text, /必须由你确认/);
});
