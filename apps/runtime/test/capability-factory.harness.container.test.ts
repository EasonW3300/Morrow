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

const availability = await detectContainerRuntime();
const SKIP_REASON = availability.available
  ? false
  : "本 runner 无可用容器运行时——真实容器 harness 跳过（CI 仅 ubuntu 腿跑；" +
    `install-hint: ${availability.installHint ?? "n/a"}）`;

test("20 组样例（真实容器路径）：≥18 组走通 + 越权 100% 阻断", { timeout: 600_000 }, async () => {
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
