// Factory 服务编排测试（票 M2-T3 / Issue #24）：检索 → 规划 → 构建 → 沙箱验证 → proposed
// → Owner confirm 注册门。全程 capability.factory_* 事件留痕；失败不抛、逐阶段可诊断。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityManifest, EventEnvelope } from "@morrow/protocol";
import { tmpDir, removeDir, REPLICA_A } from "./helpers.ts";
import { EventLedger } from "../src/ledger.ts";
import { PermissionEngine } from "../src/capabilities/engine.ts";
import { CapabilityFactory } from "../src/capabilities/factory/service.ts";
import { LocalNodeRunner } from "./factory-stub-runner.ts";
import { SandboxUnavailableError, type SandboxRunner, type SandboxToolPackage } from "../src/sandbox/runner.ts";
import type { SandboxContract } from "../src/sandbox/contract.ts";
import type { CapabilityGenerator, CapabilityGeneratorContext } from "../src/capabilities/factory/generator.ts";
import type { GeneratorOutput, GeneratorResult } from "../src/capabilities/factory/types.ts";

const GRANTS = {
  filesystem: ["workspace://notes/**"],
  network: [],
  shell: [],
  channels: ["desktop"],
  credentials: [],
};

const GOOD_SOURCE = `import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
export async function run(input: { text?: string; escape?: boolean }): Promise<{ slug: string }> {
  if (input.escape === true) throw new Error("refused: escalation attempt");
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  const slug = input.text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("empty text: nothing to slugify");
  await mkdir("notes", { recursive: true });
  await appendFile(join("notes", "factory-log.txt"), slug + "\\n");
  return { slug };
}`;

function goodOutput(overrides: Partial<GeneratorOutput> = {}): GeneratorOutput {
  return {
    name: "text-slugify",
    version: "1.0.0",
    description: "Slugify free text into a URL-safe slug",
    permissions: { filesystem: ["workspace://notes/**"], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output_schema: { type: "object", properties: { slug: { type: "string" } } },
    sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
    dependencies: {},
    source: GOOD_SOURCE,
    test_cases: [
      { case_id: "pos-basic", kind: "positive", input: { text: "Hello World" }, expect: { outcome: "success", result: { slug: "hello-world" } } },
      { case_id: "neg-empty", kind: "negative", input: { text: "  " }, expect: { outcome: "failure", errorContains: "empty" } },
      { case_id: "esc-1", kind: "privilege-escalation", input: { text: "x", escape: true }, expect: { outcome: "failure" } },
      { case_id: "fault-1", kind: "fault", input: { text: 42 }, expect: { outcome: "failure" } },
    ],
    ...overrides,
  } as GeneratorOutput;
}

/** 脚本化 Fake 生成器：按队列吐出预置结果（不触 LLM） */
function scriptedGenerator(queue: Array<GeneratorResult>): CapabilityGenerator {
  let call = 0;
  return {
    async generate(ctx: CapabilityGeneratorContext): Promise<GeneratorResult> {
      const item = queue[Math.min(call, queue.length - 1)];
      call += 1;
      if (typeof item === "object" && item !== null && item.ok) {
        // 记录检索上下文是否传入（供检索注入断言）
        (item.output as GeneratorOutput & { __seen_description?: string }).__seen_description = ctx.description;
      }
      return item;
    },
  };
}

interface FactoryFixture {
  factory: CapabilityFactory;
  engine: PermissionEngine;
  ledger: EventLedger;
  dataDir: string;
}

function makeFactory(generator: CapabilityGenerator, runner: SandboxRunner = new LocalNodeRunner(), grants: unknown = GRANTS): FactoryFixture {
  const dataDir = tmpDir("morrow-factory-svc-");
  const ledger = EventLedger.open(dataDir);
  const engine = new PermissionEngine({ dataDir, ledger, replicaId: REPLICA_A });
  engine.setGrants(grants);
  const factory = new CapabilityFactory({
    dataDir,
    ledger,
    replicaId: REPLICA_A,
    capabilities: engine,
    generator,
    runner,
  });
  return { factory, engine, ledger, dataDir };
}

function cleanup(fixture: FactoryFixture): void {
  fixture.factory.close();
  fixture.engine.close();
  fixture.ledger.close();
  rmSync(fixture.dataDir, { recursive: true, force: true });
}

function factoryEvents(ledger: EventLedger): EventEnvelope[] {
  return ledger.list({ limit: 200 }).events.filter((e) => e.event_type.startsWith("capability.factory_"));
}

function manifestOf(name: string): CapabilityManifest {
  return {
    name,
    version: "1.0.0",
    author: "human",
    runtime: "typescript",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "none", network: "none", filesystem: "none" },
    tests: [],
  };
}

test("全链路走通：检索→规划→构建→验证→proposed，事件逐阶段留痕", async () => {
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: goodOutput(), raw: "{}" }]));
  try {
    const submitted = fixture.factory.submitRequest("slugify text for URLs");
    const view = await fixture.factory.runRequest(submitted.requestId);
    assert.equal(view.status, "proposed");
    assert.equal(view.stage, "verified");
    assert.equal(view.manifest?.name, "text-slugify");
    assert.equal(view.manifest?.author, "ai");
    assert.deepEqual(view.test_cases?.map((c) => c.case_id), ["pos-basic", "neg-empty", "esc-1", "fault-1"]);

    const types = factoryEvents(fixture.ledger).map((e) => e.event_type);
    assert.deepEqual(types, [
      "capability.factory_retrieved",
      "capability.factory_planned",
      "capability.factory_built",
      "capability.factory_verified",
    ]);
    const retrieved = factoryEvents(fixture.ledger)[0];
    assert.equal(retrieved.payload.reused, false);
    assert.equal(retrieved.payload.request_id, submitted.requestId);
    const verified = factoryEvents(fixture.ledger)[3];
    assert.equal(verified.payload.ok, true);
    assert.equal(verified.payload.cases, 4);

    // 注册表还没有该能力（验证通过 ≠ 自动注册）
    assert.equal(fixture.engine.get("text-slugify"), null);
  } finally {
    cleanup(fixture);
  }
});

test("复用路径：注册表已有同名能力 → reused 事件后收束，不规划不构建不验证", async (t) => {
  const dataDir = tmpDir("morrow-factory-reuse-");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const ledger = EventLedger.open(dataDir);
  const engine = new PermissionEngine({ dataDir, ledger, replicaId: REPLICA_A });
  engine.setGrants(GRANTS);
  engine.register(manifestOf("text-slugify"), { actorId: "owner" });
  const factory = new CapabilityFactory({
    dataDir,
    ledger,
    replicaId: REPLICA_A,
    capabilities: engine,
    generator: scriptedGenerator([{ ok: true, output: goodOutput(), raw: "{}" }]),
    runner: new LocalNodeRunner(),
  });
  t.after(() => {
    factory.close();
    engine.close();
    ledger.close();
  });
  const submitted = factory.submitRequest("please slugify text for URLs");
  const view = await factory.runRequest(submitted.requestId);
  assert.equal(view.status, "reused");
  assert.equal(view.manifest, undefined, "复用路径不产出新 manifest");
  const types = factoryEvents(ledger).map((e) => e.event_type);
  assert.deepEqual(types, ["capability.factory_retrieved"]);
  const retrieved = factoryEvents(ledger)[0];
  assert.equal(retrieved.payload.reused, true);
  assert.ok((retrieved.payload.matches as Array<{ name?: string }>).some((m) => m.name === "text-slugify"));
});

test("复用路径（描述索引）：确认后的历史产物 description 命中 → 后续请求复用（FR-CAP-1 闭环）", async (t) => {
  const fixture = makeFactory(scriptedGenerator([
    { ok: true, output: goodOutput(), raw: "{}" },
    { ok: true, output: goodOutput(), raw: "{}" },
  ]));
  try {
    const first = await fixture.factory.runRequest(fixture.factory.submitRequest("create a text slug for me").requestId);
    assert.equal(first.status, "proposed");
    assert.deepEqual(fixture.factory.describeCapabilities(), [], "proposed 未确认不入索引（未注册的能力不算已有能力）");
    fixture.factory.confirm(first.request_id);
    // 第二次请求换说法但语义相近 → 命中描述索引（Jaccard ≥ 0.5）→ 复用
    const second = await fixture.factory.runRequest(fixture.factory.submitRequest("please slugify free text for me").requestId);
    assert.equal(second.status, "reused", `expected reuse, got ${second.status}${second.error ? ` (${second.error.code}: ${second.error.detail})` : ""}`);
    const types = factoryEvents(fixture.ledger).map((e) => e.event_type);
    assert.equal(types.filter((t) => t === "capability.factory_planned").length, 1, "第二次请求不再规划");
  } finally {
    cleanup(fixture);
  }
});

test("坏输出：生成器 no_output → failed(stage=plan) + 诊断 + raw_tail；不抛", async () => {
  const fixture = makeFactory(scriptedGenerator([{ ok: false, code: "no_output", detail: "no parsable JSON", raw: "I refuse." }]));
  try {
    const view = await fixture.factory.runRequest(fixture.factory.submitRequest("anything").requestId);
    assert.equal(view.status, "failed");
    assert.equal(view.stage, "retrieved", "stage 停在最后一个成功阶段");
    assert.equal(view.error?.stage, "plan");
    assert.equal(view.error?.code, "no_output");
    assert.match(view.error?.raw_tail ?? "", /refuse/);
    const types = factoryEvents(fixture.ledger).map((e) => e.event_type);
    assert.deepEqual(types, ["capability.factory_retrieved", "capability.factory_failed"]);
  } finally {
    cleanup(fixture);
  }
});

test("越权企图：manifest 超出 grant → failed(stage=plan, code=escalation) + 逐维 violations；确认门兜底拒绝", async () => {
  const escalation = goodOutput({
    name: "fs-stealer",
    permissions: { filesystem: ["workspace://secrets/**"], network: [], shell: [], channels: [], credentials: [] },
  });
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: escalation, raw: "{}" }]));
  try {
    const submitted = fixture.factory.submitRequest("steal my secrets");
    const view = await fixture.factory.runRequest(submitted.requestId);
    assert.equal(view.status, "failed");
    assert.equal(view.error?.stage, "plan");
    assert.equal(view.error?.code, "escalation");
    assert.ok((view.error?.violations ?? []).some((v) => v.dimension === "filesystem"));
    // 确认门兜底：即便有人对 failed 请求调 confirm → 409 invalid_state
    assert.throws(() => fixture.factory.confirm(submitted.requestId), (err: unknown) =>
      err instanceof Error && /not proposed/i.test(err.message),
    );
    // 注册表无痕
    assert.equal(fixture.engine.get("fs-stealer"), null);
  } finally {
    cleanup(fixture);
  }
});

test("构建失败：源码语法错误 → failed(stage=build) + tool_build_failed + 诊断", async () => {
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: goodOutput({ source: "export async function run( { bad ((" }), raw: "{}" }]));
  try {
    const view = await fixture.factory.runRequest(fixture.factory.submitRequest("slugify").requestId);
    assert.equal(view.status, "failed");
    assert.equal(view.error?.stage, "build");
    assert.equal(view.error?.code, "tool_build_failed");
    assert.ok((view.error?.detail ?? "").length > 0);
    const types = factoryEvents(fixture.ledger).map((e) => e.event_type);
    assert.ok(!types.includes("capability.factory_verified"), "构建失败不产生验证事件");
  } finally {
    cleanup(fixture);
  }
});

test("验证失败：用例断言不过 → failed(stage=verify) + 逐用例报告（AC-06 失败日志可追踪）", async () => {
  const badResult = goodOutput({
    test_cases: [
      { case_id: "pos-basic", kind: "positive", input: { text: "Hello World" }, expect: { outcome: "success", result: { slug: "WRONG" } } },
      ...goodOutput().test_cases.slice(1),
    ],
  });
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: badResult, raw: "{}" }]));
  try {
    const view = await fixture.factory.runRequest(fixture.factory.submitRequest("slugify").requestId);
    assert.equal(view.status, "failed");
    assert.equal(view.error?.stage, "verify");
    assert.equal(view.error?.code, "verification_failed");
    const report = view.error?.report;
    assert.ok(report !== undefined);
    assert.equal(report.ok, false);
    const failed = report.cases.find((c) => c.case_id === "pos-basic");
    assert.equal(failed?.pass, false);
    assert.match(failed?.detail ?? "", /mismatch/);
    assert.equal(view.status, "failed");
  } finally {
    cleanup(fixture);
  }
});

test("无沙箱：runner 抛 SandboxUnavailableError → failed(stage=verify) + sandbox_error（FR-CAP-4 整体禁用）", async () => {
  const unavailable: SandboxRunner = {
    async run(_pkg: SandboxToolPackage, _input: unknown, _contract: SandboxContract) {
      throw new SandboxUnavailableError("install docker");
    },
  };
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: goodOutput(), raw: "{}" }]), unavailable);
  try {
    const view = await fixture.factory.runRequest(fixture.factory.submitRequest("slugify").requestId);
    assert.equal(view.status, "failed");
    assert.equal(view.error?.stage, "verify");
    assert.match(view.error?.detail ?? "", /sandbox_unavailable/);
    assert.match(view.error?.detail ?? "", /install docker/);
  } finally {
    cleanup(fixture);
  }
});

test("确认门：proposed → Owner confirm → 注册（author=ai 默认 disabled）+ factory_confirmed 事件", async () => {
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: goodOutput(), raw: "{}" }]));
  try {
    const submitted = fixture.factory.submitRequest("slugify");
    await fixture.factory.runRequest(submitted.requestId);
    const confirmed = fixture.factory.confirm(submitted.requestId);
    assert.equal(confirmed.request.status, "confirmed");
    assert.equal(confirmed.capability.name, "text-slugify");
    assert.equal(confirmed.capability.author, "ai");
    assert.equal(confirmed.capability.status, "disabled", "author=ai 注册默认 disabled（允许生成 ≠ 允许扩权）");

    const registered = fixture.ledger.list({ limit: 200 }).events.find((e) => e.event_type === "capability.registered");
    assert.ok(registered !== undefined);
    assert.equal(registered.payload.author, "ai");
    const confirmedEvents = factoryEvents(fixture.ledger).filter((e) => e.event_type === "capability.factory_confirmed");
    assert.equal(confirmedEvents.length, 1);
    assert.equal(confirmedEvents[0].payload.name, "text-slugify");

    // 注册后运行时调用被拒（disabled）
    assert.throws(() => fixture.engine.assertRuntimeUse("text-slugify"), /disabled/);
    // 详情视图携带能力名
    const view = fixture.factory.getRequest(submitted.requestId);
    assert.equal(view?.capability_name, "text-slugify");
  } finally {
    cleanup(fixture);
  }
});

test("确认门：未到 proposed 就 confirm → 409 invalid_state；重复 confirm → 409", async () => {
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: goodOutput(), raw: "{}" }]));
  try {
    const submitted = fixture.factory.submitRequest("slugify text for URLs");
    assert.throws(
      () => fixture.factory.confirm(submitted.requestId),
      (err: unknown) => err instanceof Error && /not proposed|not found/i.test(err.message),
    );
    await fixture.factory.runRequest(submitted.requestId);
    fixture.factory.confirm(submitted.requestId);
    assert.throws(
      () => fixture.factory.confirm(submitted.requestId),
      (err: unknown) => err instanceof Error && /not proposed/i.test(err.message),
    );
  } finally {
    cleanup(fixture);
  }
});

test("检索上下文注入：非复用请求把现有能力 + 记忆命中带给生成器", async () => {
  const seen: CapabilityGeneratorContext[] = [];
  const fixture = makeFactory({
    async generate(ctx) {
      seen.push(ctx);
      return { ok: true, output: goodOutput(), raw: "{}" };
    },
  });
  try {
    await fixture.factory.runRequest(fixture.factory.submitRequest("slugify text").requestId);
    assert.equal(seen.length, 1, "generator must receive retrieval context");
    const captured = seen[0];
    assert.equal(captured.description, "slugify text");
    assert.deepEqual(captured.grants, GRANTS);
    assert.ok(Array.isArray(captured.existing));
  } finally {
    cleanup(fixture);
  }
});

test("fire-and-forget：submitRequest 立即返回 submitted；并发 runRequest 幂等（in-flight 去重）", async () => {
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: goodOutput(), raw: "{}" }]));
  try {
    const submitted = fixture.factory.submitRequest("slugify text for URLs");
    assert.equal(submitted.requestId.length > 0, true);
    const initial = fixture.factory.getRequest(submitted.requestId);
    assert.ok(initial !== null);
    assert.equal(initial.status, "submitted");
    // 并发调用 runRequest 只跑一次管线
    const [a, b] = await Promise.all([fixture.factory.runRequest(submitted.requestId), fixture.factory.runRequest(submitted.requestId)]);
    assert.equal(a.status, "proposed");
    assert.equal(b.status, "proposed");
    const planned = factoryEvents(fixture.ledger).filter((e) => e.event_type === "capability.factory_planned");
    assert.equal(planned.length, 1);
  } finally {
    cleanup(fixture);
  }
});

test("工厂描述索引：confirm 后 describeCapabilities 带出 name+description（检索闭环）", async () => {
  const fixture = makeFactory(scriptedGenerator([{ ok: true, output: goodOutput(), raw: "{}" }]));
  try {
    const submitted = fixture.factory.submitRequest("slugify");
    await fixture.factory.runRequest(submitted.requestId);
    assert.deepEqual(fixture.factory.describeCapabilities(), [], "proposed 未确认不入索引（未注册的能力不算已有能力）");
    fixture.factory.confirm(submitted.requestId);
    const described = fixture.factory.describeCapabilities();
    assert.equal(described.length, 1);
    assert.equal(described[0].name, "text-slugify");
    assert.match(described[0].description ?? "", /slug/i);
  } finally {
    cleanup(fixture);
  }
});

test("检索重定向：retrieve 命中时 submitRequest → reused（端到端再保险）", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "morrow-factory-retr-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const ledger = EventLedger.open(dataDir);
  const engine = new PermissionEngine({ dataDir, ledger, replicaId: REPLICA_A });
  engine.setGrants(GRANTS);
  engine.register(manifestOf("docx-to-markdown"), { actorId: "owner" });
  const factory = new CapabilityFactory({
    dataDir,
    ledger,
    replicaId: REPLICA_A,
    capabilities: engine,
    generator: scriptedGenerator([{ ok: true, output: goodOutput(), raw: "{}" }]),
    runner: new LocalNodeRunner(),
  });
  t.after(() => {
    factory.close();
    engine.close();
    ledger.close();
  });
  const submitted = factory.submitRequest("convert docx files to markdown");
  const view = await factory.runRequest(submitted.requestId);
  assert.equal(view.status, "reused");
});
