/** 门禁报告聚合（T9 / Issue #10）：seam = assembleGateReports。
 *
 * report job 把三平台 gate-report 汇总成最终报告；任一平台报告缺失或 gate-result 非
 * pass → ok = false（门禁红）。真机边界注记必须随汇总报告传播。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { assembleGateReports } from "../src/gate-lib.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-assemble-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function writeReport(dir: string, platform: string, result: "pass" | "fail"): void {
  writeFileSync(
    join(dir, `gate-report-${platform}.md`),
    `# 冒烟门报告 ${platform}\n\n结论：${result.toUpperCase()}\n\ngate-result: ${result}\n`,
  );
}

describe("assembleGateReports", () => {
  const platforms = ["macos", "linux", "windows"];

  it("三平台全 pass → ok，汇总含各平台判定与真机边界注记", () => {
    const dir = makeTmp();
    for (const p of platforms) writeReport(dir, p, "pass");
    const out = assembleGateReports(dir, platforms);
    assert.equal(out.ok, true);
    assert.ok(out.markdown.includes("macos"));
    assert.ok(out.markdown.includes("windows"));
    assert.ok(out.markdown.includes("真机门禁项"));
    assert.ok(out.markdown.endsWith("gate-result: pass"));
  });

  it("任一平台 gate-result: fail → ok = false（汇总标红）", () => {
    const dir = makeTmp();
    for (const p of platforms) writeReport(dir, p, "pass");
    writeReport(dir, "linux", "fail");
    const out = assembleGateReports(dir, platforms);
    assert.equal(out.ok, false);
    assert.ok(out.markdown.endsWith("gate-result: fail"));
  });

  it("平台报告缺失 → ok = false（产物/步骤被移除时门禁红，AC 第 3 条）", () => {
    const dir = makeTmp();
    writeReport(dir, "macos", "pass");
    writeReport(dir, "linux", "pass");
    // windows 报告缺失
    const out = assembleGateReports(dir, platforms);
    assert.equal(out.ok, false);
    assert.ok(out.markdown.includes("windows"), "missing platform should be named in the report");
    assert.ok(out.markdown.endsWith("gate-result: fail"));
  });
});
