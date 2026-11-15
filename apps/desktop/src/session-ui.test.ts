// 会话元数据 UI 纯逻辑测试（票 M7-A-T2 / Issue #59）：菜单状态机、动作集合、
// 标题校验、删除确认文案与 30 天恢复窗口文案。交互组件本身走既有 UI 约定。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_TITLE_MAX,
  canRestoreSession,
  closeSessionMenu,
  closeUncommittedMessage,
  closeUncommittedTitle,
  deleteSessionConfirmMessage,
  describeRestoreWindow,
  discardConfirmTitle,
  discardUnsupportedReason,
  discardWarning,
  isUncommittedConflict,
  openSessionMenu,
  sessionActions,
  sessionState,
  toggleSessionMenu,
  uncommittedFiles,
  uncommittedOptions,
  validateSessionTitle,
  sessionRestoreDeadline,
} from "./session-ui.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

test("sessionState：删除优先于归档", () => {
  assert.equal(sessionState({}), "active");
  assert.equal(sessionState({ archived_at: "2026-01-01T00:00:00.000Z" }), "archived");
  assert.equal(
    sessionState({ archived_at: "2026-01-01T00:00:00.000Z", deleted_at: "2026-01-02T00:00:00.000Z" }),
    "deleted",
  );
});

test("sessionActions：活动/归档/已删三种状态的动作集合", () => {
  assert.deepEqual(
    sessionActions({}).map((action) => action.id),
    ["rename", "archive", "close", "delete"],
  );
  assert.deepEqual(
    sessionActions({ archived_at: "2026-01-01T00:00:00.000Z" }).map((action) => action.id),
    ["rename", "unarchive", "delete"],
  );
  assert.deepEqual(
    sessionActions({ deleted_at: "2026-01-01T00:00:00.000Z" }).map((action) => action.id),
    ["restore"],
  );
  const deleteAction = sessionActions({}).find((action) => action.id === "delete");
  assert.equal(deleteAction?.danger, true);
  assert.equal(deleteAction?.label, "删除");
});

test("菜单状态机：toggle 同项关闭、换项切换、显式关闭", () => {
  const opened = openSessionMenu({ openFor: null }, "s1");
  assert.equal(opened.openFor, "s1");
  assert.equal(toggleSessionMenu(opened, "s1").openFor, null);
  assert.equal(toggleSessionMenu(opened, "s2").openFor, "s2");
  assert.equal(closeSessionMenu().openFor, null);
});

test("标题校验：trim 后非空且 ≤120", () => {
  assert.deepEqual(validateSessionTitle("  周报草稿  "), { ok: true, title: "周报草稿" });
  assert.equal(SESSION_TITLE_MAX, 120);
  assert.deepEqual(validateSessionTitle("a".repeat(120)), { ok: true, title: "a".repeat(120) });
  assert.equal(validateSessionTitle("").ok, false);
  assert.equal(validateSessionTitle("   ").ok, false);
  assert.equal(validateSessionTitle("a".repeat(121)).ok, false);
  assert.equal(validateSessionTitle("x".repeat(100) + " ".repeat(30)).ok, true, "长度按 trim 后计");
});

test("删除确认文案写明记忆不受影响与 30 天可恢复", () => {
  const message = deleteSessionConfirmMessage();
  assert.match(message, /记忆不受影响/);
  assert.match(message, /30 天内/);
  assert.match(message, /恢复/);
});

test("恢复窗口：30 天内可恢复，到期不可恢复，文案给出剩余天数", () => {
  const deletedAt = "2026-01-01T00:00:00.000Z";
  const deletedMs = Date.parse(deletedAt);
  assert.equal(sessionRestoreDeadline(deletedAt).getTime(), deletedMs + 30 * DAY_MS);
  assert.equal(canRestoreSession(deletedAt, deletedMs + 29 * DAY_MS), true);
  assert.equal(canRestoreSession(deletedAt, deletedMs + 30 * DAY_MS), false);
  assert.equal(canRestoreSession(deletedAt, deletedMs + 31 * DAY_MS), false);
  assert.match(describeRestoreWindow(deletedAt, deletedMs + 29 * DAY_MS), /还剩 1 天可恢复/);
  assert.equal(describeRestoreWindow(deletedAt, deletedMs + 31 * DAY_MS), "已过 30 天恢复期");
});

test("关闭三选一：选项顺序/文案，discard 标 danger", () => {
  const options = uncommittedOptions();
  assert.deepEqual(
    options.map((option) => option.id),
    ["commit", "keep", "discard"],
  );
  assert.equal(options[0]?.label, "提交到本分支");
  assert.equal(options[1]?.label, "保留工作区");
  assert.equal(options[2]?.label, "丢弃改动");
  assert.equal(options[0]?.danger, undefined);
  assert.equal(options[1]?.danger, undefined);
  assert.equal(options[2]?.danger, true);
});

test("409 uncommitted_changes：识别 code 并从 details 提取文件列表", () => {
  assert.equal(isUncommittedConflict("uncommitted_changes"), true);
  assert.equal(isUncommittedConflict("branch_in_use"), false);
  assert.equal(isUncommittedConflict(undefined), false);
  assert.deepEqual(uncommittedFiles({ files: ["a.ts", "b/c.ts"] }), ["a.ts", "b/c.ts"]);
  assert.deepEqual(uncommittedFiles({ files: ["a.ts", 42, null] }), ["a.ts"]);
  assert.deepEqual(uncommittedFiles({ files: "a.ts" }), []);
  assert.deepEqual(uncommittedFiles(undefined), []);
});

test("关闭对话框文案：展示文件数，绝不静默丢弃", () => {
  assert.equal(closeUncommittedTitle(), "会话有未提交改动");
  const message = closeUncommittedMessage(["README.md", "src/a.ts"]);
  assert.match(message, /2 个改动文件/);
  assert.match(message, /未提供选择时不会关闭/);
});

test("discard 二次确认：红字警示「将丢弃这些改动」并列出文件（超长截断）", () => {
  assert.equal(discardConfirmTitle(), "丢弃这些改动？");
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts", "j.ts"];
  const warning = discardWarning(files);
  assert.match(warning, /将丢弃这些改动（10 个文件）/);
  assert.match(warning, /不可撤销/);
  assert.match(warning, /• a\.ts/);
  assert.doesNotMatch(warning, /• i\.ts/);
  assert.match(warning, /还有 2 个文件/);
});

test("A5：local 工作区的 discard 选项被禁用并给出理由；github 三个都可点", () => {
  const localOptions = uncommittedOptions("local");
  const localDiscard = localOptions.find((option) => option.id === "discard");
  assert.ok(localDiscard?.disabledReason, "local 的 discard 必须有 disabledReason");
  assert.match(localDiscard.disabledReason, /本地工作区不支持丢弃/);
  assert.match(localDiscard.disabledReason, /提交或保留/);
  assert.equal(localOptions.find((option) => option.id === "commit")?.disabledReason, undefined);
  assert.equal(localOptions.find((option) => option.id === "keep")?.disabledReason, undefined);

  const githubOptions = uncommittedOptions("github");
  assert.equal(githubOptions.every((option) => option.disabledReason === undefined), true);

  // 未知来源（缺省）：三个都可用，由服务端兜底
  assert.equal(uncommittedOptions().every((option) => option.disabledReason === undefined), true);
});

test("A5：discard_not_supported_for_local 有专用用户可读文案（不显示为 not_isolated）", () => {
  assert.match(discardUnsupportedReason("discard_not_supported_for_local") ?? "", /本地工作区不支持丢弃/);
  assert.equal(discardUnsupportedReason("not_isolated"), null);
  assert.equal(discardUnsupportedReason(undefined), null);
});

test("B3：30 天软删窗口与 24h 临时会话窗口的辅助函数名字不冲突", async () => {
  // 两个模块同文件 import 时必须能共存（同名异义会在调用点看错）
  const sessionUi = await import("./session-ui.ts");
  const ephemeralUi = await import("./ephemeral-ui.ts");
  assert.equal(typeof sessionUi.sessionRestoreDeadline, "function");
  assert.equal(typeof sessionUi.canRestoreSession, "function");
  assert.equal(typeof ephemeralUi.ephemeralRestoreDeadline, "function");
  assert.equal(typeof ephemeralUi.canRestoreEphemeral, "function");
  // 旧名必须不存在（避免残留调用点）
  assert.equal((sessionUi as Record<string, unknown>).restoreDeadline, undefined);
  assert.equal((sessionUi as Record<string, unknown>).canRestore, undefined);
  assert.equal((ephemeralUi as Record<string, unknown>).restoreDeadline, undefined);
  assert.equal((ephemeralUi as Record<string, unknown>).canRestore, undefined);
});
