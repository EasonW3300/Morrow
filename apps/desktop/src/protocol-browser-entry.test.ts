/**
 * 浏览器入口守卫（CI 三平台 build 腿回归的防再犯闸，Issue #27 根因 / #24 发现）。
 *
 * 规则：desktop（浏览器 bundle）对 @morrow/protocol 的一切引用必须走
 * `@morrow/protocol/browser` 子路径——默认出口含 integrity.ts（node:crypto），
 * 被运行时值导入拖进 vite bundle 会让三平台 build 全红（tsc 只查类型、
 * vite build 不在测试链里，故在此用 node:test 拦截）。
 *
 * 形态：静态扫描 src 下所有 .ts/.tsx 的导入/导出子句，主入口引用（精确匹配
 * 引号边界，不误伤 /browser 子路径）即红；白名单仅留给「确认安全且短期无法
 * 迁移」的文件，新增条目须在 PR 说明理由。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

/** 允许从主入口导入的文件（相对 src/ 的 POSIX 路径）；当前为空——保持为空 */
const MAIN_ENTRY_WHITELIST: readonly string[] = [];

/** 主入口引用形态：from 或裸 import 后接主包名（引号边界精确匹配） */
const MAIN_ENTRY_RE = /(?:\bfrom\s+|\bimport\s+)["']@morrow\/protocol["']/g;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("desktop 只从 @morrow/protocol/browser 引用协议包（浏览器入口守卫）", () => {
  const srcDir = join(import.meta.dirname, "..", "src");
  const violations: string[] = [];

  for (const file of collectSourceFiles(srcDir)) {
    const rel = relative(srcDir, file).split("\\").join("/");
    if (MAIN_ENTRY_WHITELIST.includes(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      MAIN_ENTRY_RE.lastIndex = 0;
      if (MAIN_ENTRY_RE.test(lines[i])) {
        violations.push(`${rel}:${i + 1}  ${lines[i].trim()}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    [
      "desktop 的浏览器 bundle 不得引用 @morrow/protocol 主入口",
      "（默认出口含 node:crypto 依赖，会拖垮 vite build）。请改用",
      '"@morrow/protocol/browser"；如确需主入口，先确认无 node 依赖再进白名单：',
      ...violations.map((v) => `  - ${v}`),
    ].join("\n"),
  );
});
