// Generator 输出 schema 校验测试（票 M2-T3 / Issue #24，FR-CAP-2）：
// 坏输出 → 结构化诊断（errors 全量列出），绝不抛——factory 把它落成 factory_failed(stage=plan)。
// 正样例：ValidatedPlan 形态（manifest author=ai + 四类测试用例 + 依赖锁）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGeneratorOutput } from "../src/capabilities/factory/plan-schema.ts";
import type { GeneratorOutput } from "../src/capabilities/factory/types.ts";

/** 最小合法 generator 输出（四类测试用例各一、零依赖） */
function goodOutput(overrides: Partial<GeneratorOutput> = {}): GeneratorOutput {
  return {
    name: "text-slugify",
    version: "1.0.0",
    description: "Slugify free text into a URL-safe slug",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output_schema: { type: "object", properties: { slug: { type: "string" } } },
    sandbox: { type: "container", network: "none", filesystem: "none" },
    dependencies: {},
    source: `export async function run(input: { text: string }): Promise<{ slug: string }> {
  const slug = input.text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("empty text: nothing to slugify");
  return { slug };
}`,
    test_cases: [
      { case_id: "pos-basic", kind: "positive", input: { text: "Hello World" }, expect: { outcome: "success", result: { slug: "hello-world" } } },
      { case_id: "neg-empty", kind: "negative", input: { text: "   " }, expect: { outcome: "failure", errorContains: "empty" } },
      { case_id: "esc-path", kind: "privilege-escalation", input: { text: "ok", path: "/etc/passwd" }, expect: { outcome: "failure" } },
      { case_id: "fault-num", kind: "fault", input: { text: 42 }, expect: { outcome: "failure" } },
    ],
    ...overrides,
  } as GeneratorOutput;
}

test("合法输出：通过校验，产出 ValidatedPlan（manifest author=ai + tests=case id 列表 + 四类用例保留）", () => {
  const result = validateGeneratorOutput(goodOutput());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.manifest.name, "text-slugify");
  assert.equal(result.plan.manifest.author, "ai");
  assert.equal(result.plan.manifest.runtime, "typescript");
  assert.deepEqual(result.plan.manifest.tests, ["pos-basic", "neg-empty", "esc-path", "fault-num"]);
  assert.equal(result.plan.manifest.sandbox.type, "container");
  assert.deepEqual(result.plan.testCases.map((c) => c.case_id), ["pos-basic", "neg-empty", "esc-path", "fault-num"]);
  assert.deepEqual(result.plan.dependencies, {});
  assert.match(result.plan.source, /^export async function run/);
  assert.equal(result.plan.description, "Slugify free text into a URL-safe slug");
});

test("坏输出：非对象 / 缺字段 → errors 全量诊断，不抛", () => {
  for (const bad of [null, undefined, "text", 42, [], {}]) {
    const result = validateGeneratorOutput(bad);
    assert.equal(result.ok, false, `input ${JSON.stringify(bad)} must fail`);
    if (result.ok) continue;
    assert.ok(result.errors.length > 0, "diagnostics must be non-empty");
  }
  const result = validateGeneratorOutput({});
  assert.equal(result.ok, false);
  if (result.ok) return;
  const joined = result.errors.join("\n");
  for (const field of ["name", "version", "description", "permissions", "input_schema", "output_schema", "sandbox", "source", "test_cases", "dependencies"]) {
    assert.match(joined, new RegExp(field), `missing field "${field}" must be reported`);
  }
});

test("坏输出：非法 name / version 形态 → 指名诊断", () => {
  const badName = validateGeneratorOutput(goodOutput({ name: "Bad Name!" }));
  assert.equal(badName.ok, false);
  if (!badName.ok) assert.match(badName.errors.join("\n"), /name/);

  const badVersion = validateGeneratorOutput(goodOutput({ version: "v1" }));
  assert.equal(badVersion.ok, false);
  if (!badVersion.ok) assert.match(badVersion.errors.join("\n"), /version/);
});

test("坏输出：author=ai 无测试用例 / 缺任一类别 → 拒绝（FR-CAP-2/4 四类测试强制）", () => {
  const empty = validateGeneratorOutput(goodOutput({ test_cases: [] }));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.errors.join("\n"), /positive/);

  const missingEscalation = validateGeneratorOutput(
    goodOutput({ test_cases: goodOutput().test_cases.filter((c) => c.kind !== "privilege-escalation") }),
  );
  assert.equal(missingEscalation.ok, false);
  if (!missingEscalation.ok) assert.match(missingEscalation.errors.join("\n"), /privilege-escalation/);
});

test("坏输出：positive 用例必须期望成功、其余三类必须期望失败（越权用例即拒绝断言）", () => {
  const wrongPositive = validateGeneratorOutput(
    goodOutput({
      test_cases: [
        { case_id: "p1", kind: "positive", input: { text: "ok" }, expect: { outcome: "failure" } },
        ...goodOutput().test_cases.slice(1),
      ],
    }),
  );
  assert.equal(wrongPositive.ok, false);
  if (!wrongPositive.ok) assert.match(wrongPositive.errors.join("\n"), /positive/);

  const wrongEscalation = validateGeneratorOutput(
    goodOutput({
      test_cases: [
        goodOutput().test_cases[0],
        ...goodOutput().test_cases.slice(1).map((c) =>
          c.kind === "privilege-escalation" ? { ...c, expect: { outcome: "success" as const } } : c,
        ),
      ],
    }),
  );
  assert.equal(wrongEscalation.ok, false);
  if (!wrongEscalation.ok) assert.match(wrongEscalation.errors.join("\n"), /privilege-escalation/);
});

test("坏输出：case_id 重复或缺失 input/expect → 指名诊断", () => {
  const dup = goodOutput();
  dup.test_cases = [dup.test_cases[0], { ...dup.test_cases[0] }, ...dup.test_cases.slice(1)];
  const result = validateGeneratorOutput(dup);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join("\n"), /dup|unique|case_id/i);

  const noInput = validateGeneratorOutput(
    goodOutput({
      test_cases: [{ case_id: "a", kind: "positive", expect: { outcome: "success" } } as unknown as GeneratorOutput["test_cases"][number], ...goodOutput().test_cases.slice(1)],
    }),
  );
  assert.equal(noInput.ok, false);
  if (!noInput.ok) assert.match(noInput.errors.join("\n"), /input/);
});

test("坏输出：依赖版本必须锁死精确版本（^ ~ * 范围即拒，FR-CAP-3 依赖锁定）", () => {
  for (const range of ["^1.2.3", "~1.2.3", "*", "latest", "1.x"]) {
    const result = validateGeneratorOutput(goodOutput({ dependencies: { yaml: range } }));
    assert.equal(result.ok, false, `range "${range}" must be rejected`);
    if (!result.ok) assert.match(result.errors.join("\n"), /yaml/);
  }
  const pinned = validateGeneratorOutput(goodOutput({ dependencies: { yaml: "2.4.5" } }));
  assert.equal(pinned.ok, true);
});

test("坏输出：source 必须导出 run 函数；sandbox.type=none 被拒（author=ai 无沙箱不得注册）", () => {
  const noRun = validateGeneratorOutput(goodOutput({ source: "const hidden = 1;" }));
  assert.equal(noRun.ok, false);
  if (!noRun.ok) assert.match(noRun.errors.join("\n"), /run/);

  const noSandbox = validateGeneratorOutput(goodOutput({ sandbox: { type: "none", network: "none", filesystem: "none" } }));
  assert.equal(noSandbox.ok, false);
  if (!noSandbox.ok) assert.match(noSandbox.errors.join("\n"), /sandbox/);
});

test("坏输出：manifest 域非法（network 通配 / shell 未知类别）→ 经 validateManifest 的诊断透出", () => {
  const wildcardNetwork = validateGeneratorOutput(
    goodOutput({ permissions: { filesystem: [], network: ["*:443"], shell: [], channels: [], credentials: [] } }),
  );
  assert.equal(wildcardNetwork.ok, false);
  if (!wildcardNetwork.ok) assert.match(wildcardNetwork.errors.join("\n"), /network/);
});
