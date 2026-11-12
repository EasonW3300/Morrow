import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EPHEMERAL_TTL_MS,
  canRestore,
  closeNotice,
  createEphemeralSessionBody,
  ephemeralCapabilityGate,
  ephemeralScope,
  isEphemeralScope,
  promoteDisabledReason,
  restoreDeadline,
} from "./ephemeral-ui.ts";

test("临时会话作用域：session:<id> 形态与判定", () => {
  assert.equal(ephemeralScope("abc"), "session:abc");
  assert.equal(isEphemeralScope("session:abc"), true);
  assert.equal(isEphemeralScope("owner"), false);
  assert.equal(isEphemeralScope("session:"), false);
});

test("创建临时会话请求体：kind=ephemeral（缺省 normal 时不带 kind）", () => {
  assert.deepEqual(createEphemeralSessionBody(), { kind: "ephemeral" });
});

test("提升按钮：只有 session 作用域可提升，owner 给出禁用原因", () => {
  assert.equal(promoteDisabledReason("session:abc"), null);
  assert.match(promoteDisabledReason("owner") ?? "", /长期记忆/);
});

test("24h 恢复窗口：截止时间 = 关闭时刻 + 24h，窗口内可恢复、到点即过期", () => {
  const closedAt = "2026-11-12T00:00:00.000Z";
  assert.equal(EPHEMERAL_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(restoreDeadline(closedAt), "2026-11-13T00:00:00.000Z");

  assert.equal(canRestore(closedAt, new Date("2026-11-12T23:59:59.999Z")), true);
  assert.equal(canRestore(closedAt, new Date("2026-11-13T00:00:00.000Z")), false);
  assert.equal(canRestore(closedAt, new Date("2026-11-14T00:00:00.000Z")), false);
});

test("关闭提示：明确写出 24 小时可恢复与截止时刻", () => {
  const notice = closeNotice("2026-11-12T00:00:00.000Z");
  assert.match(notice, /24/);
  assert.match(notice, /恢复/);
  assert.match(notice, /2026-11-13T00:00:00.000Z/);
});

test("禁写入类能力：注册/生成代码/写操作在临时会话内禁用并给出可读原因", () => {
  const gate = ephemeralCapabilityGate();
  assert.match(gate.register, /禁用|不可/);
  assert.match(gate.generate, /禁用|不可/);
  assert.match(gate.write, /禁用|不可/);
  assert.match(gate.write, /403/);
});
