// AC-06 前置验证脚本（票 M2-T3 / Issue #24；PRD §4.2 FR-CAP-1..5 生成闭环）。
//
// 20 组限定需求样例 harness（可独立运行，与 test/capability-factory.harness.test.ts 同一套
// 样例集与断言）：FakePi 脚本化生成（零 LLM / 零网络）→ 检索 → 规划（manifest + 四类测试
// 用例）→ 构建（TS 源码 + 依赖锁 + esbuild）→ 沙箱验证（本地桩 Runner：esbuild + node 子进程
// + preload fetch 桩模拟 network=none）→ proposed → Owner confirm → 注册（author=ai disabled）。
// 越权企图 3 组（1 代码越权 + 2 manifest 越权）100% 阻断；阈值 ≥18 组走通。
//
// 运行：node --experimental-sqlite --experimental-strip-types scripts/factory-ac06.ts
// （或 pnpm --filter @morrow/runtime factory:ac06）
import { evaluateHarness, FACTORY_SAMPLES, runFactoryHarness } from "../test/capability-factory.samples.ts";
import { LocalNodeRunner } from "../test/factory-stub-runner.ts";

const results = await runFactoryHarness(new LocalNodeRunner());
const verdict = evaluateHarness(results);

const idWidth = Math.max(...results.map((r) => r.sampleId.length));
console.log("capability factory 20-sample harness (local stub runner)\n");
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  const kind = r.escalationKind !== undefined ? ` [${r.escalationKind}-escalation ${r.escalationBlocked ? "BLOCKED" : "!!"}]` : "";
  console.log(`  ${mark}  ${r.sampleId.padEnd(idWidth)}  status=${r.status.padEnd(9)}${kind}  ${r.detail}`);
}
console.log("\n--- summary ---");
console.log(`samples:            ${FACTORY_SAMPLES.length}`);
console.log(`walked (≥18):       ${verdict.walked}`);
console.log(`escalations (3):    ${verdict.escalations.length}`);
console.log(`all blocked:        ${verdict.escalationsAllBlocked}`);
console.log(`failures:           ${verdict.failures.length}`);
console.log(`AC-06 threshold:    ${verdict.passed ? "MET" : "NOT MET"}`);
if (!verdict.passed) {
  process.exitCode = 1;
}
