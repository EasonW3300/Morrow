// Skill 包 manifest 校验测试（票 M7-B-T3 / Issue #68）。
// 重点：entry 的三条伴随约束（sandbox 必填且只允许 container / tests 非空 / 路径不得越界），
// 以及 canonical JSON 与哈希口径。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  canonicalManifestJson,
  isEscapingPath,
  npmInstallArgs,
  validateSkillManifest,
} from "../src/skills-package/manifest.ts";

const BASE = {
  name: "docx-tools",
  version: "1.0.0",
  description: "处理 docx 的技能包",
  permissions: { filesystem: ["workspace://**"], network: [], shell: [], channels: [], credentials: [] },
  steps: [{ capability: "docx.toMarkdown" }],
};

function withEntry(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE,
    steps: undefined,
    entry: { path: "dist/tool.js", runtime: "typescript" },
    sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
    tests: ["tests/positive.yaml"],
    ...overrides,
  };
}

test("纯声明式包（只有 steps）通过，且不需要 sandbox/tests", () => {
  assert.deepEqual(validateSkillManifest(BASE), []);
});

test("含 entry 的包在 sandbox/tests 齐备时通过", () => {
  assert.deepEqual(validateSkillManifest(withEntry()), []);
});

test("含 entry 但缺 sandbox → 拒绝，并指名 sandbox", () => {
  const problems = validateSkillManifest(withEntry({ sandbox: undefined }));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, "sandbox");
  assert.ok(problems[0].message.includes("宿主"), "错误信息要说明后果");
});

test("sandbox.type 为 process/none → 拒绝（entry 只能 container）", () => {
  for (const type of ["process", "none"]) {
    const problems = validateSkillManifest(withEntry({ sandbox: { type, network: "none", filesystem: "none" } }));
    assert.equal(problems.length, 1, `${type} 应被拒`);
    assert.equal(problems[0].field, "sandbox.type");
  }
});

test("含 entry 但缺 tests 或 tests 为空 → 拒绝", () => {
  for (const tests of [undefined, []]) {
    const problems = validateSkillManifest(withEntry({ tests }));
    assert.equal(problems.length, 1);
    assert.equal(problems[0].field, "tests");
  }
});

test("entry.path 越界（绝对路径 / .. / 盘符 / UNC）→ 拒绝", () => {
  for (const path of ["/etc/passwd", "../outside.js", "a/../../b.js", "C:\\x.js", "\\\\host\\share\\x.js"]) {
    const problems = validateSkillManifest(withEntry({ entry: { path, runtime: "typescript" } }));
    assert.equal(problems.length, 1, `${path} 应被拒`);
    assert.equal(problems[0].field, "entry.path");
  }
});

test("既无 steps 也无 entry → 拒绝（包必须声明它做什么）", () => {
  const problems = validateSkillManifest({ ...BASE, steps: undefined });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].message.includes("至少需要"));
});

test("必填字段缺失各报一条，字段名精确", () => {
  const problems = validateSkillManifest({});
  const fields = problems.map((p) => p.field);
  assert.ok(fields.includes("name"));
  assert.ok(fields.includes("version"));
  assert.ok(fields.includes("description"));
  assert.ok(fields.includes("permissions"));
});

test("name/version 格式校验：大写名、非法版本被拒", () => {
  assert.equal(validateSkillManifest({ ...BASE, name: "DocxTools" }).length, 1);
  assert.equal(validateSkillManifest({ ...BASE, name: "-bad" }).length, 1);
  assert.equal(validateSkillManifest({ ...BASE, version: "1.0" }).length, 1);
  assert.equal(validateSkillManifest({ ...BASE, version: "1.0.0-beta.1" }).length, 0);
});

test("permissions 五维少一维或缺数组 → 逐维报错", () => {
  const problems = validateSkillManifest({
    ...BASE,
    permissions: { filesystem: ["a"], network: [], shell: [] }, // 缺 channels/credentials
  });
  const fields = problems.map((p) => p.field);
  assert.deepEqual(fields, ["permissions.channels", "permissions.credentials"]);
});

test("permissions 某维不是字符串数组 → 报该维", () => {
  const problems = validateSkillManifest({
    ...BASE,
    permissions: { ...BASE.permissions, network: "all" },
  });
  assert.equal(problems[0].field, "permissions.network");
});

test("isEscapingPath：正常相对路径与含点的合法文件名不算越界", () => {
  assert.equal(isEscapingPath("dist/tool.js"), false);
  assert.equal(isEscapingPath("./dist/tool.js"), false);
  assert.equal(isEscapingPath("a.b/c.d.js"), false);
  assert.equal(isEscapingPath("nested/deep/path.js"), false);
});

test("canonicalJson：键顺序无关，数组顺序保留", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.notEqual(canonicalJson({ list: [1, 2] }), canonicalJson({ list: [2, 1] }));
  assert.equal(canonicalJson({ a: [1, { z: 1, y: 2 }] }), '{"a":[1,{"y":2,"z":1}]}');
});

test("canonicalManifestJson 排除 source_hash（同一包带不带声明得到同一哈希）", () => {
  const declared = { ...BASE, source_hash: "sha256-deadbeef" };
  assert.equal(canonicalManifestJson(declared), canonicalManifestJson(BASE));
  assert.notEqual(canonicalManifestJson(BASE), canonicalManifestJson({ ...BASE, description: "改了" }));
});

test("npmInstallArgs：含 --ignore-scripts 且关闭审计/锁文件", () => {
  const args = npmInstallArgs("docx-tools@1.0.0", "/tmp/target");
  assert.ok(args.includes("--ignore-scripts"), "必须禁止安装脚本");
  assert.ok(args.includes("--no-audit"));
  assert.ok(args.includes("--no-package-lock"));
  assert.equal(args.at(-1), "docx-tools@1.0.0", "包 spec 在最后");
  assert.ok(args.includes("--prefix"));
});
