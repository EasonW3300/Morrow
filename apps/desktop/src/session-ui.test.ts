// 会话元数据 UI 纯逻辑测试（票 M7-A-T2 / Issue #59）：菜单状态机、动作集合、
// 标题校验、删除确认文案与 30 天恢复窗口文案。交互组件本身走既有 UI 约定。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_TITLE_MAX,
  canRestore,
  closeSessionMenu,
  deleteSessionConfirmMessage,
  describeRestoreWindow,
  openSessionMenu,
  sessionActions,
  sessionState,
  toggleSessionMenu,
  validateSessionTitle,
  restoreDeadline,
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
    ["rename", "archive", "delete"],
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
  assert.equal(restoreDeadline(deletedAt).getTime(), deletedMs + 30 * DAY_MS);
  assert.equal(canRestore(deletedAt, deletedMs + 29 * DAY_MS), true);
  assert.equal(canRestore(deletedAt, deletedMs + 30 * DAY_MS), false);
  assert.equal(canRestore(deletedAt, deletedMs + 31 * DAY_MS), false);
  assert.match(describeRestoreWindow(deletedAt, deletedMs + 29 * DAY_MS), /还剩 1 天可恢复/);
  assert.equal(describeRestoreWindow(deletedAt, deletedMs + 31 * DAY_MS), "已过 30 天恢复期");
});
