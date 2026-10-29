/**
 * 架构测试（ADR-0001）：业务模块禁止直接 import Pi API。
 *
 * 扫描 packages/ 之下除 packages/pi-adapter 外的所有源文件，
 * 出现 @earendil-works/*（Pi 官方包 scope）即红。本测试自身在 pi-adapter
 * 包内运行——pi-adapter 是唯一被允许触达 Pi 的地方。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, "..", "..");
const ADAPTER_PACKAGE = "pi-adapter";

/** import 语句的宽松匹配：ESM static/dynamic、CommonJS require、类型导入一并覆盖 */
const PI_IMPORT_PATTERN = /@earendil-works\//;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("架构边界：业务模块不得 import Pi API（ADR-0001）", () => {
  it("packages/ 之下（除 pi-adapter）没有任何 @earendil-works/* import", () => {
    const violations: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      if (pkg === ADAPTER_PACKAGE) continue;
      const pkgDir = join(packagesDir, pkg);
      if (!statSync(pkgDir).isDirectory()) continue;
      for (const file of listSourceFiles(pkgDir)) {
        const content = readFileSync(file, "utf8");
        if (PI_IMPORT_PATTERN.test(content)) {
          violations.push(`${file}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `以下文件直接 import 了 Pi API，必须改走 @morrow/pi-adapter：\n${violations.join("\n")}`,
    );
  });
});
