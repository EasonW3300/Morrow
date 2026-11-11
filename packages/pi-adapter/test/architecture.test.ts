/**
 * 架构测试（ADR-0001）：业务模块禁止直接 import Pi API。
 *
 * 扫描 packages/（除 packages/pi-adapter 自身）与 apps/（desktop / runtime）之下的
 * 源文件，出现 @earendil-works/*（Pi 官方包 scope）即红。本测试自身在 pi-adapter
 * 包内运行——pi-adapter 是唯一被允许触达 Pi 的地方。
 * 测试文件不扫：本文件自己的源码就含该 pattern 字符串，且测试对 Pi 包名的引用
 * （如断言错误信息）不构成运行时边界破坏（M0 code-review / Issue #11：扫描面从
 * packages/ 扩到 apps/）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const ADAPTER_PACKAGE = "pi-adapter";
const SCAN_ROOTS = ["packages", "apps"] as const;

/** import 语句的宽松匹配：ESM static/dynamic、CommonJS require、类型导入一并覆盖 */
const PI_IMPORT_PATTERN = /@earendil-works\//;

const SKIP_DIRS = new Set(["node_modules", "dist", "target", "gen"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/.test(entry) && !TEST_FILE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("架构边界：业务模块不得 import Pi API（ADR-0001）", () => {
  it("packages/（除 pi-adapter）与 apps/ 之下没有任何 @earendil-works/* import", () => {
    const violations: string[] = [];
    for (const root of SCAN_ROOTS) {
      const rootDir = join(repoRoot, root);
      for (const pkg of readdirSync(rootDir)) {
        if (root === "packages" && pkg === ADAPTER_PACKAGE) continue;
        const pkgDir = join(rootDir, pkg);
        if (!statSync(pkgDir).isDirectory()) continue;
        for (const file of listSourceFiles(pkgDir)) {
          const content = readFileSync(file, "utf8");
          if (PI_IMPORT_PATTERN.test(content)) {
            violations.push(`${file}`);
          }
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
