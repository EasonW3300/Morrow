/**
 * 健康面板的呈现逻辑（票 T7 / Issue #8 验收核心）。
 *
 * 输入是 GET /v1/health 的载荷（apps/runtime/src/runtime.ts handleHealth）：
 *   { status, version, replica_id, sandbox: { status, detail, engine?, version?,
 *     install_hint? }, ledger: { events } }
 * 输出 Owner 可读的字段行与沙箱态说明。票 M2-T1 探针真实化后沙箱为四态状态机
 * （ready / daemon_down / missing / not_configured）：ready 呈现引擎与版本，
 * daemon_down / missing 警示并透出 install_hint，not_configured 是探测显式关闭的
 * 中性第四态。纯函数，无 DOM / fetch 依赖 —— node:test 直接跑（--experimental-strip-types）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { describeHealth, type HealthPayload } from "./health-ui.ts";

function payload(overrides: Partial<HealthPayload> = {}): HealthPayload {
  return {
    status: "ok",
    version: "0.1.0",
    replica_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    sandbox: { status: "ready", detail: "docker daemon reachable (version 29.4.0)", engine: "docker", version: "29.4.0", install_hint: null },
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

test("沙箱 ready：呈现可用与引擎版本，正常色", () => {
  const out = describeHealth(payload(), "just now");
  const sandbox = out.lines.find((l) => l.label.includes("沙箱"));
  assert.ok(sandbox !== undefined, "应有沙箱行");
  assert.equal(sandbox.tone, "ok");
  assert.match(sandbox.value, /可用/);
  assert.match(sandbox.value, /docker 29\.4\.0/);
});

test("沙箱 daemon_down / missing：警示色并透出 install_hint", () => {
  const down = describeHealth(
    payload({ sandbox: { status: "daemon_down", detail: "docker: daemon unreachable (exit 1)", engine: null, version: null, install_hint: "start Docker Desktop and retry" } }),
    "t",
  );
  const downLine = down.lines.find((l) => l.label.includes("沙箱"));
  assert.equal(downLine?.tone, "warn");
  assert.match(downLine?.value ?? "", /守护进程不可达/);
  assert.match(down.sandboxNote, /Docker Desktop/);

  const missing = describeHealth(
    payload({ sandbox: { status: "missing", detail: "no container runtime found in PATH", engine: null, version: null, install_hint: "Install Docker Desktop or OrbStack" } }),
    "t",
  );
  const missingLine = missing.lines.find((l) => l.label.includes("沙箱"));
  assert.equal(missingLine?.tone, "warn");
  assert.match(missingLine?.value ?? "", /未安装/);
  assert.match(missing.sandboxNote, /OrbStack/);
});

test("沙箱 not_configured：探测显式关闭是中性第四态，不用错误色", () => {
  const out = describeHealth(
    payload({ sandbox: { status: "not_configured", detail: "sandbox probe is disabled (MORROW_SANDBOX_PROBE=off)", engine: null, version: null, install_hint: null } }),
    "just now",
  );
  const sandbox = out.lines.find((l) => l.label.includes("沙箱"));
  assert.equal(sandbox?.tone, "dim", "not_configured 不算故障色");
  assert.match(sandbox?.value ?? "", /not_configured/);
  assert.match(out.sandboxNote, /MORROW_SANDBOX_PROBE/);
});

test("status 非 ok：整体转警示调", () => {
  const out = describeHealth(payload({ status: "degraded" }), "t");
  assert.equal(out.tone, "warn");
});

test("刷新时间透出（轮询呈现的一部分）", () => {
  const out = describeHealth(payload(), "12:00:03");
  assert.match(out.refreshedAt, /12:00:03/);
});
