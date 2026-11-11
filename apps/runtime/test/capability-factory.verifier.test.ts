// Verifier 测试（票 M2-T3 / Issue #24，FR-CAP-4 隔离验证）：SandboxRunner 依次跑四类
// 测试用例（用例即容器内断言脚本），全部通过 → 验证报告；任一失败 → 报告 + 失败详情。
// 本文件用 LocalNodeRunner（无 docker 桩路径）；真实容器路径在 capability-factory.harness.container.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tmpDir, removeDir } from "./helpers.ts";
import { CapabilityBuilder } from "../src/capabilities/factory/builder.ts";
import { CapabilityVerifier } from "../src/capabilities/factory/verifier.ts";
import { SandboxUnavailableError, type SandboxResult, type SandboxRunner, type SandboxToolPackage } from "../src/sandbox/runner.ts";
import { normalizeSandboxContract, type SandboxContract } from "../src/sandbox/contract.ts";
import { LocalNodeRunner } from "./factory-stub-runner.ts";
import type { FactoryTestCaseSpec, ValidatedPlan } from "../src/capabilities/factory/types.ts";
import { validateGeneratorOutput } from "../src/capabilities/factory/plan-schema.ts";

function planOf(source: string): ValidatedPlan {
  const result = validateGeneratorOutput({
    name: "text-slugify",
    version: "1.0.0",
    description: "Slugify free text into a URL-safe slug",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output_schema: { type: "object", properties: { slug: { type: "string" } } },
    sandbox: { type: "container", network: "none", filesystem: "none" },
    dependencies: {},
    source,
    test_cases: [
      { case_id: "pos-basic", kind: "positive", input: { text: "Hello World" }, expect: { outcome: "success", result: { slug: "hello-world" } } },
      { case_id: "neg-empty", kind: "negative", input: { text: "  " }, expect: { outcome: "failure", errorContains: "empty" } },
      { case_id: "esc-1", kind: "privilege-escalation", input: { text: "ok", escape: true }, expect: { outcome: "failure" } },
      { case_id: "fault-1", kind: "fault", input: { text: 42 }, expect: { outcome: "failure" } },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.plan;
}

const SLUGIFY_SOURCE = `export async function run(input: { text: string; escape?: boolean }): Promise<{ slug: string }> {
  if (input.escape === true) {
    throw new Error("refused: input asks to escape the slugify contract");
  }
  if (typeof input.text !== "string") {
    throw new Error("fault: text must be a string");
  }
  const slug = input.text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("empty text: nothing to slugify");
  return { slug };
}`;

async function builtEntry(dataDir: string, requestId: string, plan: ValidatedPlan): Promise<string> {
  const built = await new CapabilityBuilder({ dataDir }).build({ requestId, plan });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.verifyEntry;
}

test("全部通过：四类用例依次执行 → 报告 ok:true + 每用例 pass/detail/exit_code", async (t) => {
  const dataDir = tmpDir("morrow-verifier-ok-");
  t.after(() => removeDir(dataDir));
  const verifyEntry = await builtEntry(dataDir, "req-ok", planOf(SLUGIFY_SOURCE));
  const verifier = new CapabilityVerifier({ runner: new LocalNodeRunner() });
  const report = await verifier.verify({ name: "text-slugify", verifyEntry }, planOf(SLUGIFY_SOURCE).testCases);
  assert.equal(report.ok, true);
  assert.equal(report.cases.length, 4);
  assert.deepEqual(report.cases.map((c) => c.case_id), ["pos-basic", "neg-empty", "esc-1", "fault-1"]);
  for (const c of report.cases) assert.equal(c.pass, true, `${c.case_id}: ${c.detail}`);
  assert.ok(report.duration_ms >= 0);
});

test("断言失败：期望结果不匹配 → 该用例 pass=false + 明细；报告 ok:false", async (t) => {
  const dataDir = tmpDir("morrow-verifier-mismatch-");
  t.after(() => removeDir(dataDir));
  const plan = planOf(SLUGIFY_SOURCE);
  const cases = plan.testCases.map((c) =>
    c.case_id === "pos-basic"
      ? ({ ...c, expect: { outcome: "success", result: { slug: "WRONG" } } } as FactoryTestCaseSpec)
      : c,
  );
  const verifyEntry = await builtEntry(dataDir, "req-mismatch", plan);
  const report = await new CapabilityVerifier({ runner: new LocalNodeRunner() }).verify({ name: "text-slugify", verifyEntry }, cases);
  assert.equal(report.ok, false);
  const failed = report.cases.find((c) => c.case_id === "pos-basic");
  assert.ok(failed !== undefined);
  assert.equal(failed.pass, false);
  assert.match(failed.detail, /mismatch/);
  assert.equal(report.cases.filter((c) => c.pass).length, 3, "其余用例不受影响（逐用例结果齐全）");
});

test("沙箱阻断：network=none 下越权 fetch（代码越权）被模拟拦截 → 越权用例 pass=true", async (t) => {
  const dataDir = tmpDir("morrow-verifier-esc-");
  t.after(() => removeDir(dataDir));
  const fetchTool = `export async function run(input: { url?: string } | null): Promise<{ text: string }> {
    if (input === null || typeof input !== "object") {
      throw new Error("fault: input must be an object");
    }
    if (input.url !== undefined) {
      const res = await fetch(input.url);
      return { text: await res.text() };
    }
    return { text: "ok" };
  }`;
  const plan = validateGeneratorOutput({
    name: "note-fetcher",
    version: "1.0.0",
    description: "Fetch a note over the network (undeclared capability)",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "container", network: "none", filesystem: "none" },
    dependencies: {},
    source: fetchTool,
    test_cases: [
      { case_id: "pos-1", kind: "positive", input: {}, expect: { outcome: "success", result: { text: "ok" } } },
      { case_id: "neg-1", kind: "negative", input: { url: 42 }, expect: { outcome: "failure" } },
      { case_id: "esc-net", kind: "privilege-escalation", input: { url: "http://morrow-escalation-probe.invalid/" }, expect: { outcome: "failure" } },
      { case_id: "fault-1", kind: "fault", input: null, expect: { outcome: "failure", errorContains: "object" } },
    ],
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error("unreachable");
  const verifyEntry = await builtEntry(dataDir, "req-esc", plan.plan);
  const report = await new CapabilityVerifier({ runner: new LocalNodeRunner() }).verify({ name: "note-fetcher", verifyEntry }, plan.plan.testCases);
  assert.equal(report.ok, true, report.cases.filter((c) => !c.pass).map((c) => `${c.case_id}: ${c.detail}`).join("; "));
  const esc = report.cases.find((c) => c.case_id === "esc-net");
  assert.ok(esc !== undefined);
  assert.equal(esc.pass, true, "越权企图必须被阻断（network none 模拟）");
  assert.match(esc.detail, /blocked/i);
});

test("沙箱不可用：runner 抛 SandboxUnavailableError → 报告 ok:false + sandbox_error（无沙箱整体禁用）", async (t) => {
  const dataDir = tmpDir("morrow-verifier-nosb-");
  t.after(() => removeDir(dataDir));
  const verifyEntry = await builtEntry(dataDir, "req-nosb", planOf(SLUGIFY_SOURCE));
  const unavailable: SandboxRunner = {
    async run(): Promise<SandboxResult> {
      throw new SandboxUnavailableError("install docker");
    },
  };
  const report = await new CapabilityVerifier({ runner: unavailable }).verify({ name: "text-slugify", verifyEntry }, planOf(SLUGIFY_SOURCE).testCases);
  assert.equal(report.ok, false);
  assert.match(report.sandbox_error ?? "", /sandbox_unavailable/);
  assert.match(report.sandbox_error ?? "", /install docker/);
  assert.equal(report.cases.length, 0, "无沙箱时不产生用例结果（整体禁用）");
});

test("工具崩溃：process.exit 类故障 → 用例失败且报告逐用例可追踪", async (t) => {
  const dataDir = tmpDir("morrow-verifier-crash-");
  t.after(() => removeDir(dataDir));
  const crashTool = `import { exit } from "node:process";
export async function run(input: { mode?: string }): Promise<{ ok: boolean }> {
  if (input.mode === "boom") { exit(3); }
  if (input.mode === "escalate") { throw new Error("refused: escalation input"); }
  return { ok: true };
}`;
  const plan = validateGeneratorOutput({
    name: "crash-prone",
    version: "1.0.0",
    description: "Tool that exits hard on fault input",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "container", network: "none", filesystem: "none" },
    dependencies: {},
    source: crashTool,
    test_cases: [
      { case_id: "pos-1", kind: "positive", input: {}, expect: { outcome: "success", result: { ok: true } } },
      { case_id: "neg-1", kind: "negative", input: { mode: "boom" }, expect: { outcome: "failure" } },
      { case_id: "esc-1", kind: "privilege-escalation", input: { mode: "escalate" }, expect: { outcome: "failure" } },
      { case_id: "fault-1", kind: "fault", input: { mode: "boom" }, expect: { outcome: "failure" } },
    ],
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error("unreachable");
  const verifyEntry = await builtEntry(dataDir, "req-crash", plan.plan);
  const report = await new CapabilityVerifier({ runner: new LocalNodeRunner() }).verify({ name: "crash-prone", verifyEntry }, plan.plan.testCases);
  assert.equal(report.ok, false);
  const fault = report.cases.find((c) => c.case_id === "fault-1");
  assert.ok(fault !== undefined);
  assert.equal(fault.pass, false, "crash 不是结构化失败——断言脚本被连带杀掉，判失败");
  assert.match(fault.detail, /exit|protocol|nonzero/i);
});

test("workspace 接线：声明 filesystem 的用例在挂载目录内读写成功（stub 路径直用宿主目录）", async (t) => {
  const dataDir = tmpDir("morrow-verifier-ws-");
  t.after(() => removeDir(dataDir));
  const workspace = mkdtempSync(join(tmpdir(), "morrow-verifier-wsdir-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const noteTool = `import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export async function run(input: { op: string; name?: string; content?: string }): Promise<{ echo?: string }> {
  if (typeof input.name !== "string" || !/^[a-z0-9-]+$/.test(input.name)) {
    throw new Error("refused: note name must be a simple lowercase id (no traversal)");
  }
  if (input.op === "write") {
    if (typeof input.content !== "string") throw new Error("fault: content must be a string");
    await mkdir("notes", { recursive: true });
    await appendFile(join("notes", \`\${input.name}.txt\`), input.content);
    return {};
  }
  if (input.op === "read") {
    const text = await readFile(join("notes", \`\${input.name}.txt\`), "utf8");
    return { echo: text };
  }
  throw new Error(\`fault: unknown op \${String(input.op)}\`);
}`;
  const plan = validateGeneratorOutput({
    name: "note-append",
    version: "1.0.0",
    description: "Append and echo workspace notes",
    permissions: { filesystem: ["workspace://notes/**"], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
    dependencies: {},
    source: noteTool,
    test_cases: [
      { case_id: "pos-write", kind: "positive", input: { op: "write", name: "a", content: "hello" }, expect: { outcome: "success" } },
      { case_id: "neg-noname", kind: "negative", input: { op: "write" }, expect: { outcome: "failure" } },
      { case_id: "esc-1", kind: "privilege-escalation", input: { op: "write", name: "../evil" }, expect: { outcome: "failure" } },
      { case_id: "fault-1", kind: "fault", input: { op: "write", name: "b", content: 42 }, expect: { outcome: "failure" } },
    ],
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error("unreachable");
  const verifyEntry = await builtEntry(dataDir, "req-ws", plan.plan);
  const report = await new CapabilityVerifier({ runner: new LocalNodeRunner() }).verify(
    { name: "note-append", verifyEntry, workspaceDir: workspace, workspaceMode: "rw" },
    plan.plan.testCases,
  );
  assert.equal(report.ok, true, report.cases.filter((c) => !c.pass).map((c) => `${c.case_id}: ${c.detail}`).join("; "));
});
