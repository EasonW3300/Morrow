// 20 组样例 harness——真实容器路径（票 M2-T3 / Issue #24，AC-06 主证据）。
// 同一样例集跑 DockerRunner（--network none / 只读根 + workspace 挂载 / 资源限额），
// 断言与桩路径一致：≥18 组走通 + 越权 100% 阻断。零 LLM / 零外部网络（FakePi 脚本化；
// 容器 network none）。
// 环境门槛：本机/CI 需可用容器运行时（docker/podman/OrbStack）；无运行时自动 skip
// （sandbox.docker.test.ts 同款门槛）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectContainerRuntime } from "../src/sandbox/detect.ts";
import { DockerRunner } from "../src/sandbox/docker-runner.ts";
import { evaluateHarness, FACTORY_SAMPLES, runFactoryHarness } from "./capability-factory.samples.ts";

// 探测有界（#23 修复批）：docker CLI 挂起（而非快速失败）时探测 10s 内归类为超时，
// harness 诚实 skip 并注明理由——绝不无限等待探测。
const availability = await detectContainerRuntime({ timeoutMs: 10_000 });
const SKIP_REASON: string | false = availability.available
  ? false
  : availability.probeTimedOut === true
    ? "容器运行时探测超时（docker CLI 挂起，10s 无响应）——真实容器 harness 诚实跳过而非挂死 " +
      "（CI 仅 ubuntu 腿跑真实容器；本机 docker 恢复后重跑）"
    : "本 runner 无可用容器运行时——真实容器 harness 跳过（CI 仅 ubuntu 腿跑；" +
      `install-hint: ${availability.installHint ?? "n/a"}）`;

// skip 守卫（#23 修复批）：无运行时/探测超时 → 诚实 skip 并注明理由。修复前本测试
// 只计算了 SKIP_REASON 却从未挂到 test 上——无 docker 的 runner 上会跑真容器并失败。
test("20 组样例（真实容器路径）：≥18 组走通 + 越权 100% 阻断", { skip: SKIP_REASON, timeout: 600_000 }, async () => {
  assert.equal(FACTORY_SAMPLES.length, 20);
  const results = await runFactoryHarness(new DockerRunner());
  const verdict = evaluateHarness(results);
  for (const r of results) {
    assert.ok(r.ok, `${r.sampleId}: ${r.detail}`);
  }
  assert.ok(verdict.walked >= 18, `≥18 组走通，got ${verdict.walked}`);
  assert.equal(verdict.escalations.length, 3);
  assert.equal(verdict.escalationsAllBlocked, true, "越权 100% 阻断（容器 network none 拦截代码越权）");
  assert.equal(verdict.passed, true);
});
