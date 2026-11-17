// 执行模式 UI 纯逻辑测试（票 M7-B-T6 / Issue #70）。
//
// 重点不在"函数返回什么"，而在**文案不能撒谎**：完全权限的说明必须写明危险命令
// 仍被拒、快照仍做、审计仍记；待确认必须给完整脚本；无快照时撤销不可点。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EXEC_MODE,
  FULL_ACCESS_NOTICE,
  MODE_NOT_PERSISTED_HINT,
  SNAPSHOT_SCOPE_TEXT,
  deniedView,
  execResultSummary,
  modeLabel,
  modeSummary,
  modeSwitchWarning,
  pendingConfirmView,
  readonlyExemptHint,
  revertDisabledReason,
} from "./exec-ui.ts";

// --- 模式文案 -----------------------------------------------------------------------

test("默认是每次确认，标签与说明准确", () => {
  assert.equal(DEFAULT_EXEC_MODE, "confirm_each");
  assert.equal(modeLabel("confirm_each"), "每次命令确认");
  assert.equal(modeLabel("full_access"), "完全权限");
  assert.match(modeSummary("full_access"), /危险命令仍会被拒绝/);
});

test("切到完全权限必须弹风险告知（切回默认不需要）", () => {
  assert.equal(modeSwitchWarning("confirm_each"), null);
  assert.notEqual(modeSwitchWarning("full_access"), null);
});

test("完全权限告知写明「危险命令照样被拒」——不能暗示「什么都不问了」", () => {
  assert.match(FULL_ACCESS_NOTICE, /危险命令/);
  assert.match(FULL_ACCESS_NOTICE, /被拒绝执行|照样被拒/);
  assert.match(FULL_ACCESS_NOTICE, /快照/);
  assert.match(FULL_ACCESS_NOTICE, /审计/);
  assert.match(FULL_ACCESS_NOTICE, /关闭这个会话后模式立即失效/);
  // 禁止出现"不再有任何限制"这类误导表述
  assert.equal(/没有任何限制|不再有任何|完全自由/.test(FULL_ACCESS_NOTICE), false);
});

test("快照范围文案必须列出不在保护范围的路径", () => {
  assert.match(SNAPSHOT_SCOPE_TEXT, /~\//.source === "~\\/" ? /~\/\.ssh/ : /~\//);
  assert.match(SNAPSHOT_SCOPE_TEXT, /\.ssh/);
  assert.match(SNAPSHOT_SCOPE_TEXT, /\/etc/);
  assert.match(SNAPSHOT_SCOPE_TEXT, /无法撤销/);
});

test("常驻提示说明模式不持久化", () => {
  assert.match(MODE_NOT_PERSISTED_HINT, /关闭会话后回到默认/);
});

// --- 待确认展示 ---------------------------------------------------------------------

test("待确认：脚本原样展示（不截断），并给出主按钮文案", () => {
  const longScript = ['for i in $(seq 1 100); do', '  echo "line $i";', "done"].join("\n");
  const view = pendingConfirmView({ script: longScript, why: "write_command", mode: "confirm_each" });
  assert.equal(view.script, longScript, "必须逐字展示，截断等于让用户盲签");
  assert.equal(view.readonlyFirstTime, false);
  assert.equal(view.confirmLabel, "确认并执行");
  assert.match(view.detail, /仅本次有效/);
});

test("只读首次确认：说明「以后只读免确认、写命令仍需确认」", () => {
  const view = pendingConfirmView({ script: "ls -la", why: "readonly_first_time", mode: "confirm_each" });
  assert.equal(view.readonlyFirstTime, true);
  assert.match(view.detail, /只读命令/);
  assert.match(view.detail, /不再询问/);
  assert.match(view.detail, /写命令仍需每次确认/);
});

test("多行脚本的换行与缩进完整保留", () => {
  const script = "cd /workspace\n  pnpm test \\\n    --reporter=dot";
  assert.equal(pendingConfirmView({ script, why: "write_command", mode: "confirm_each" }).script, script);
});

// --- 拒绝展示 -----------------------------------------------------------------------

test("拒绝展示：逐条列出命中规则，并标明是硬拒绝", () => {
  const view = deniedView([
    { id: "rm-protected-path", level: "critical", reason: "递归强制删除系统关键路径" },
    { id: "rm-recursive-force", level: "high", reason: "递归强制删除" },
  ]);
  assert.equal(view.hardBlock, true);
  assert.equal(view.reasons.length, 2, "规则要逐条列，不能合并成一句");
  assert.match(view.reasons[0], /rm-protected-path/);
  assert.match(view.reasons[1], /rm-recursive-force/);
});

test("空命中列表不崩（防御性）", () => {
  const view = deniedView([]);
  assert.equal(view.reasons.length, 0);
  assert.equal(view.hardBlock, true);
});

// --- 只读豁免提示 -------------------------------------------------------------------

test("只读豁免提示：确认后才出现，完全权限下不显示", () => {
  assert.equal(readonlyExemptHint({ mode: "confirm_each", readonlyConfirmed: false }), null);
  assert.notEqual(readonlyExemptHint({ mode: "confirm_each", readonlyConfirmed: true }), null);
  assert.equal(readonlyExemptHint({ mode: "full_access", readonlyConfirmed: true }), null);
});

// --- 执行结果摘要 -------------------------------------------------------------------

test("结果摘要：成功/失败/超时/截断都能看出来", () => {
  const ok = execResultSummary({ ok: true, exit_code: 0, timed_out: false, truncated: false, duration_ms: 1200 });
  assert.match(ok, /执行成功/);
  assert.match(ok, /1\.2s/);

  const failed = execResultSummary({ ok: false, exit_code: 2, timed_out: false, truncated: false, duration_ms: 500 });
  assert.match(failed, /执行失败/);
  assert.match(failed, /退出码 2/);

  const timeout = execResultSummary({ ok: false, exit_code: 137, timed_out: true, truncated: false, duration_ms: 30000 });
  assert.match(timeout, /超时/);
  assert.match(timeout, /强制终止/);

  const truncated = execResultSummary({ ok: true, exit_code: 0, timed_out: false, truncated: true, duration_ms: 100 });
  assert.match(truncated, /截断/, "截断必须显式告知，否则用户以为看全了");
});

// --- 撤销 ---------------------------------------------------------------------------

test("无快照时撤销不可点并说明原因", () => {
  assert.notEqual(revertDisabledReason(null), null);
  assert.match(revertDisabledReason(null) ?? "", /没有快照/);
  assert.equal(revertDisabledReason("snap_abc"), null);
});
