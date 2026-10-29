/**
 * 健康面板的呈现逻辑（票 T7 / Issue #8 验收核心）。
 *
 * 输入是 GET /v1/health 的载荷（apps/runtime/src/runtime.ts handleHealth）：
 *   { status, version, replica_id, sandbox: { status, detail }, ledger: { events } }
 * 输出 Owner 可读的字段行与沙箱态说明。M0 沙箱恒为 not-configured（桩），
 * 必须呈现得明白并提示 M2 接入后可用——这是验收的一部分。
 * 纯函数，无 DOM / fetch 依赖 —— node:test 直接跑（--experimental-strip-types）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { describeHealth, type HealthPayload } from "./health-ui.ts";

function payload(overrides: Partial<HealthPayload> = {}): HealthPayload {
  return {
    status: "ok",
    version: "0.1.0",
    replica_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    sandbox: { status: "not-configured", detail: "sandbox probe is a stub in M0" },
    ledger: { events: 42 },
    ...overrides,
  };
}

test("正常载荷：ok 态 + 版本/副本/账本事件数全部呈现", () => {
  const out = describeHealth(payload(), "just now");
  assert.equal(out.tone, "ok");
  const text = out.lines.map((l) => `${l.label}:${l.value}`).join("\n");
  assert.match(text, /0\.1\.0/);
  assert.match(text, /f47ac10b/);
  assert.match(text, /42/);
  assert.match(out.summary, /ok|正常/i);
});

test("沙箱 not-configured：明确说明是 M0 桩且提示 M2 接入后可用，不算故障色", () => {
  const out = describeHealth(payload(), "just now");
  const sandbox = out.lines.find((l) => l.label.includes("沙箱"));
  assert.ok(sandbox !== undefined, "应有沙箱行");
  assert.equal(sandbox.tone, "dim", "not-configured 是明确的第四态，不用错误色");
  assert.match(sandbox.value, /未接入/);
  const note = out.lines.find((l) => l.label.includes("沙箱"))?.note ?? "";
  assert.match(out.sandboxNote, /M2/);
  assert.match(note + out.sandboxNote, /M2 接入沙箱后可用/);
});

test("沙箱 available / unavailable：分别呈现为正常与警示", () => {
  const available = describeHealth(payload({ sandbox: { status: "available", detail: "docker ok" } }), "t");
  const sandboxOk = available.lines.find((l) => l.label.includes("沙箱"));
  assert.equal(sandboxOk?.tone, "ok");
  const unavailable = describeHealth(payload({ sandbox: { status: "unavailable", detail: "docker not running" } }), "t");
  const sandboxBad = unavailable.lines.find((l) => l.label.includes("沙箱"));
  assert.equal(sandboxBad?.tone, "warn");
});

test("status 非 ok：整体转警示调", () => {
  const out = describeHealth(payload({ status: "degraded" }), "t");
  assert.equal(out.tone, "warn");
});

test("刷新时间透出（轮询呈现的一部分）", () => {
  const out = describeHealth(payload(), "12:00:03");
  assert.match(out.refreshedAt, /12:00:03/);
});
