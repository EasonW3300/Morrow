/**
 * 门禁报告聚合 CLI（T9 / Issue #10）：report job 用。核心逻辑在 gate-lib.assembleGateReports
 * （单测覆盖：缺失/失败平台 → ok=false）。
 *
 * 用法：
 *   node --experimental-strip-types src/assemble-gate-report.ts \
 *     --dir gate-reports --platforms macos,linux,windows --out m0-gate-report.md [--summary]
 *
 * 退出码：任一平台报告缺失或 gate-result 非 pass → 1。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assembleGateReports } from "./gate-lib.ts";

function fail(message: string): never {
  console.error(`[assemble] FAIL: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const dir = argValue("--dir") ?? fail("must pass --dir <reports dir>");
const platforms = (argValue("--platforms") ?? "macos,linux,windows").split(",");
const out = argValue("--out") ?? fail("must pass --out <file>");

const { ok, markdown } = assembleGateReports(dir, platforms);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, markdown);
console.log(`[assemble] report: ${out}`);

if (argv.includes("--summary")) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined && existsSync(dirname(summaryPath))) {
    const existing = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
    writeFileSync(summaryPath, `${existing}${markdown}\n`);
    console.log("[assemble] appended to GITHUB_STEP_SUMMARY");
  } else {
    console.log("[assemble] --summary set but GITHUB_STEP_SUMMARY absent (local run): skipped");
  }
}

console.log(`[assemble] verdict: ${ok ? "PASS" : "FAIL"}`);
if (!ok) process.exit(1);
