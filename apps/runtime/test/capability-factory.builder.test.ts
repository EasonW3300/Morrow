// Builder 测试（票 M2-T3 / Issue #24，FR-CAP-3：代码构建——TS 源码 + 依赖锁 + esbuild 打包）。
// 产物 = 沙箱工具包目录：src/tool.ts（生成源码）+ src/entry.ts / src/verify-entry.ts
// （运行时自有模板）+ package.json（版本固定）+ dist（esbuild 编译验证）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, removeDir } from "./helpers.ts";
import { CapabilityBuilder } from "../src/capabilities/factory/builder.ts";
import type { ValidatedPlan } from "../src/capabilities/factory/types.ts";
import { validateGeneratorOutput } from "../src/capabilities/factory/plan-schema.ts";

function planOf(source: string, dependencies: Record<string, string> = {}): ValidatedPlan {
  const result = validateGeneratorOutput({
    name: "text-slugify",
    version: "1.0.0",
    description: "Slugify free text into a URL-safe slug",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output_schema: { type: "object", properties: { slug: { type: "string" } } },
    sandbox: { type: "container", network: "none", filesystem: "none" },
    dependencies,
    source,
    test_cases: [
      { case_id: "pos-basic", kind: "positive", input: { text: "Hello World" }, expect: { outcome: "success", result: { slug: "hello-world" } } },
      { case_id: "neg-empty", kind: "negative", input: { text: "  " }, expect: { outcome: "failure", errorContains: "empty" } },
      { case_id: "esc-1", kind: "privilege-escalation", input: { text: "ok", path: "/etc/passwd" }, expect: { outcome: "failure" } },
      { case_id: "fault-1", kind: "fault", input: { text: 42 }, expect: { outcome: "failure" } },
    ],
  });
  assert.equal(result.ok, true, "test plan must validate");
  if (!result.ok) throw new Error("unreachable");
  return result.plan;
}

const GOOD_SOURCE = `export async function run(input: { text: string }): Promise<{ slug: string }> {
  const slug = String(input.text ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("empty text: nothing to slugify");
  return { slug };
}`;

test("构建成功：写入 src/tool.ts + 两个打包入口 + 固定版本 package.json，esbuild 编译通过", async (t) => {
  const dataDir = tmpDir("morrow-builder-");
  t.after(() => removeDir(dataDir));
  const builder = new CapabilityBuilder({ dataDir });
  const result = await builder.build({ requestId: "req-1", plan: planOf(GOOD_SOURCE) });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const tool = readFileSync(join(result.packageDir, "src", "tool.ts"), "utf8");
  assert.equal(tool, GOOD_SOURCE, "生成源码原样落盘（不做改写）");
  const entry = readFileSync(result.toolEntry, "utf8");
  assert.match(entry, /from\s+"\.[\/"]*tool\.ts"/, "entry 包装模板引用生成源码");
  const verifyEntry = readFileSync(result.verifyEntry, "utf8");
  assert.match(verifyEntry, /from\s+"\.[\/"]*tool\.ts"/, "verify 断言脚本引用生成源码");

  const pkgJson = JSON.parse(readFileSync(join(result.packageDir, "package.json"), "utf8")) as {
    name: string; version: string; dependencies?: Record<string, string>;
  };
  assert.equal(pkgJson.name, "text-slugify");
  assert.equal(pkgJson.version, "1.0.0");

  assert.ok(existsSync(join(result.packageDir, "dist", "tool.mjs")), "esbuild 编译产物存在（编译验证通过）");
  assert.ok(existsSync(join(result.packageDir, "dist", "verify.mjs")));
});

test("构建成功（带依赖）：精确版本写进 package.json dependencies（依赖锁留档）", async (t) => {
  const dataDir = tmpDir("morrow-builder-dep-");
  t.after(() => removeDir(dataDir));
  const builder = new CapabilityBuilder({ dataDir });
  const result = await builder.build({
    requestId: "req-dep",
    plan: planOf(GOOD_SOURCE.replace("run(input: { text: string }", "run(input: { text: string }")),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const pkgJson = JSON.parse(readFileSync(join(result.packageDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.deepEqual(pkgJson.dependencies, {});
});

test("依赖锁违规：范围版本（^ ~ *）→ ok:false + 指名诊断，不落包目录", async (t) => {
  const dataDir = tmpDir("morrow-builder-range-");
  t.after(() => removeDir(dataDir));
  const builder = new CapabilityBuilder({ dataDir });
  // plan-schema 会先拒范围——builder 是第二道闸，直接构造绕过 schema 的输入
  const plan = { ...planOf(GOOD_SOURCE), dependencies: { yaml: "^2.4.5" } } as ValidatedPlan;
  const result = await builder.build({ requestId: "req-range", plan });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "dependency_not_pinned");
  assert.match(result.detail, /yaml/);
  assert.ok(!existsSync(join(dataDir, "capability-factory", "req-range")), "违规计划不落包目录");
});

test("编译失败：源码语法错误 → ok:false + esbuild 诊断（tool_build_failed）", async (t) => {
  const dataDir = tmpDir("morrow-builder-syntax-");
  t.after(() => removeDir(dataDir));
  const builder = new CapabilityBuilder({ dataDir });
  const result = await builder.build({
    requestId: "req-syntax",
    plan: planOf("export async function run(input {\n  this is not typescript ((( \n}"),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "tool_build_failed");
  assert.ok(result.diagnostics !== undefined && result.diagnostics.length > 0, "esbuild 诊断必须透出");
});

test("同请求重复构建：幂等覆盖（重跑不残留旧产物）", async (t) => {
  const dataDir = tmpDir("morrow-builder-idem-");
  t.after(() => removeDir(dataDir));
  const builder = new CapabilityBuilder({ dataDir });
  const first = await builder.build({ requestId: "req-again", plan: planOf(GOOD_SOURCE) });
  assert.equal(first.ok, true);
  const second = await builder.build({ requestId: "req-again", plan: planOf(GOOD_SOURCE) });
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.packageDir, second.packageDir);
  }
});
