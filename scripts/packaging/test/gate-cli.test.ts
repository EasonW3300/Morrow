/** 冒烟门 CLI 负向路径（T9 / Issue #10 AC 第 3 条的本地证据）：
 * 产物缺失 → gate.ts 退出码 1，报告落盘且 gate-result: fail，探针不执行（秒级返回）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const gateCli = fileURLToPath(new URL("../src/gate.ts", import.meta.url));
const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-gate-cli-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function runGate(extraArgs: string[], reportPath: string) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", gateCli, "--report", reportPath, ...extraArgs],
    { encoding: "utf8", timeout: 60_000 },
  );
}

describe("gate CLI 负向路径", () => {
  it("--binary 指向不存在的产物 → 退出码 1，报告 gate-result: fail 且列出缺失路径", () => {
    const outDir = makeTmp();
    const reportPath = join(outDir, "report-missing-binary.md");
    const missing = join(outDir, "morrow-runtime-nowhere");

    const result = runGate(["--binary", missing], reportPath);

    assert.equal(result.status, 1, `expected exit 1, stderr: ${result.stderr?.slice(-500)}`);
    const report = readFileSync(reportPath, "utf8");
    assert.ok(report.includes("gate-result: fail"));
    assert.ok(report.includes(missing), "report should list the missing binary path");
    // 负向路径不跑探针：报告里不应出现探针执行产物（standalone 探针的 detail 文案）
    assert.ok(!report.includes("ready JSON 握手"), "probes must not run when artifacts are missing");
  });

  it("--bundle-dir 指向不存在目录（桌面包 upload 步骤被移除的形态）→ 退出码 1 且列出 bundle 失败", () => {
    const outDir = makeTmp();
    const reportPath = join(outDir, "report-missing-bundle.md");
    // 用一个存在但内容无关的文件冒充二进制存在性——产物校验在探针之前，bundle 缺失即红
    const fakeBinary = join(outDir, "morrow-runtime-fake");
    writeFileSync(fakeBinary, "");

    const result = runGate(
      ["--binary", fakeBinary, "--bundle-dir", join(outDir, "no-such-bundle-dir")],
      reportPath,
    );

    assert.equal(result.status, 1, `expected exit 1, stderr: ${result.stderr?.slice(-500)}`);
    const report = readFileSync(reportPath, "utf8");
    assert.ok(report.includes("gate-result: fail"));
    assert.ok(report.includes("desktop bundle"));
    assert.ok(report.includes("no-such-bundle-dir"));
  });
});
