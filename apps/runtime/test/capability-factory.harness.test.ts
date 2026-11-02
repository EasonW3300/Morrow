// 20 组样例 harness——本地桩路径（票 M2-T3 / Issue #24，AC-06 前置）：
// ≥18 组全链路走通（检索→规划→构建→四类用例沙箱验证→proposed→confirm→注册 disabled），
// 越权企图（3 组：1 代码越权 + 2 manifest 越权）100% 阻断，失败组日志可追踪。
// 零 docker / 零网络（LocalNodeRunner 以 esbuild + node 子进程 + preload fetch 桩执行真实生成代码）；
// 真实容器路径在 capability-factory.harness.container.test.ts（同样例集）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHarness, FACTORY_SAMPLES, runFactoryHarness } from "./capability-factory.samples.ts";
import { LocalNodeRunner } from "./factory-stub-runner.ts";

test("20 组样例（桩路径）：≥18 组走通 + 越权 100% 阻断 + 全部符合预期", { timeout: 300_000 }, async () => {
  assert.equal(FACTORY_SAMPLES.length, 20, "样例集必须是 20 组");
  const escalations = FACTORY_SAMPLES.filter((s) => s.expected === "blocked-plan-escalation").length;
  assert.ok(escalations >= 2, `manifest 越权样例 ≥2（另含 1 组代码越权），got ${escalations}`);

  const results = await runFactoryHarness(new LocalNodeRunner());
  const verdict = evaluateHarness(results);

  // 逐样例明细（失败组日志可追踪：HarnessResult.detail 携带诊断）
  for (const r of results) {
    assert.ok(r.ok, `${r.sampleId}: ${r.detail}`);
  }
  assert.ok(verdict.walked >= 18, `≥18 组走通，got ${verdict.walked}; failures: ${verdict.failures.map((f) => `${f.sampleId}(${f.detail})`).join("; ")}`);
  assert.equal(verdict.escalations.length, 3, "越权企图样例共 3 组（S18 代码 + S19/S20 manifest）");
  assert.equal(verdict.escalationsAllBlocked, true, `越权 100% 阻断: ${verdict.escalations.map((e) => `${e.sampleId}=${e.escalationBlocked}`).join(", ")}`);
  assert.equal(verdict.passed, true, "AC-06 前置阈值整体通过");
});

test("越权样例的具体阻断点：S18 沙箱内拦截、S19/S20 规划阶段拦截", async () => {
  // 说明：runFactoryHarness 每次全新 runtime；此断言复用上例语义，这里只锁样例集构成
  const s18 = FACTORY_SAMPLES.find((s) => s.id === "status-pinger");
  assert.ok(s18 !== undefined);
  assert.deepEqual(s18.plan.permissions, { filesystem: [], network: [], shell: [], channels: [], credentials: [] }, "代码越权样例 manifest 不申报网络（越权在代码里）");
  const escCase = s18.plan.test_cases.find((c) => c.kind === "privilege-escalation");
  assert.ok(escCase !== undefined && escCase.expect.outcome === "failure", "代码越权用例期望失败（=企图被阻断）");
  for (const id of ["secret-reader", "web-fetcher"]) {
    const sample = FACTORY_SAMPLES.find((s) => s.id === id);
    assert.ok(sample !== undefined);
    assert.equal(sample.expected, "blocked-plan-escalation");
  }
});
