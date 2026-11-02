// 工厂 HTTP 端点端到端测试（票 M2-T3 / Issue #24，PRD §6.2 能力端点扩展）：
//   POST /v1/capabilities/request        触发全流程（fire-and-forget 阶段执行）
//   GET  /v1/capabilities/requests/:id   进度/阶段/报告
//   POST /v1/capabilities/:id/confirm    Owner 确认门（proposed → 注册，author=ai disabled）
// Generator 经注入 seam 脚本化（零网络）；沙箱经 LocalNodeRunner（无 docker 桩路径）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle, type RuntimeOptions } from "../src/runtime.ts";
import type { CapabilityGenerator } from "../src/capabilities/factory/generator.ts";
import type { GeneratorOutput } from "../src/capabilities/factory/types.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";
import { LocalNodeRunner } from "./factory-stub-runner.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

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

interface RequestView {
  request_id: string;
  description: string;
  status: string;
  stage: string;
  manifest?: { name: string; author: string };
  test_cases?: Array<{ case_id: string; kind: string }>;
  report?: { ok: boolean; cases: Array<{ case_id: string; pass: boolean; detail: string }> };
  error?: { stage: string; code: string; detail: string };
  capability_name?: string;
  reuse_matches?: Array<{ source: string; name?: string; score: number }>;
}

function apiConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function optionsWith(generator: CapabilityGenerator): RuntimeOptions {
  return { capabilityGenerator: generator, sandboxRunner: new LocalNodeRunner() };
}

async function post(runtime: RuntimeHandle, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await json<Record<string, unknown>>(res)) };
}

async function getView(runtime: RuntimeHandle, requestId: string): Promise<{ status: number; body: RequestView }> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/requests/${requestId}`);
  return { status: res.status, body: (await json<RequestView>(res)) };
}

async function allEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

/** 轮询直到状态进入期望集合（fire-and-forget 阶段执行的观察口径） */
async function waitForStatus(runtime: RuntimeHandle, requestId: string, statuses: string[], maxMs = 15000): Promise<RequestView> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const { status, body } = await getView(runtime, requestId);
    assert.equal(status, 200);
    if (statuses.includes(body.status)) return body;
    if (Date.now() > deadline) {
      assert.fail(`request ${requestId} did not reach ${statuses.join("|")} within ${maxMs}ms (last: ${body.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("工厂端到端：POST request 201 → 轮询到 proposed → confirm 注册 disabled；事件族齐全", async (t) => {
  const dir = tmpDir("morrow-factory-api-");
  t.after(() => removeDir(dir));
  const generator: CapabilityGenerator = {
    async generate() {
      return { ok: true, output: goodOutput(), raw: "{}" };
    },
  };
  const runtime = await startRuntime(apiConfig(dir), optionsWith(generator));
  try {
    const grants = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRANTS),
    });
    assert.equal(grants.status, 200);
    const submitted = await post(runtime, "/v1/capabilities/request", { description: "slugify text for URLs" });
    assert.equal(submitted.status, 201);
    const requestId = submitted.body.request_id as string;
    assert.ok(typeof requestId === "string" && requestId.length > 0);
    assert.equal(submitted.body.status, "submitted");

    const proposed = await waitForStatus(runtime, requestId, ["proposed"]);
    assert.equal(proposed.stage, "verified");
    assert.equal(proposed.manifest?.name, "text-slugify");
    assert.equal(proposed.manifest?.author, "ai");
    assert.equal(proposed.test_cases?.length, 4);
    assert.equal(proposed.report?.ok, true);

    // 注册表还没有该能力（验证通过 ≠ 自动注册）
    const list = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities`);
    const capabilities = (await json<{ capabilities: Array<{ name: string }> }>(list)).capabilities;
    assert.ok(!capabilities.some((c) => c.name === "text-slugify"));

    const confirmed = await post(runtime, `/v1/capabilities/${requestId}/confirm`);
    assert.equal(confirmed.status, 200);
    const capability = confirmed.body.capability as { name: string; author: string; status: string };
    assert.equal(capability.name, "text-slugify");
    assert.equal(capability.author, "ai");
    assert.equal(capability.status, "disabled", "Owner 确认注册后 author=ai 默认 disabled");
    assert.equal((await getView(runtime, requestId)).body.capability_name, "text-slugify");

    const events = await allEvents(runtime.port);
    const factoryTypes = events.filter((e) => e.event_type.startsWith("capability.factory_")).map((e) => e.event_type);
    assert.deepEqual(factoryTypes, [
      "capability.factory_retrieved",
      "capability.factory_planned",
      "capability.factory_built",
      "capability.factory_verified",
      "capability.factory_confirmed",
    ]);
    // 注册事件 author=ai（PermissionEngine 语义不变）
    const registered = events.find((e) => e.event_type === "capability.registered" && e.payload.name === "text-slugify");
    assert.ok(registered !== undefined);
    assert.equal(registered.payload.author, "ai");

    // 重复 confirm → 409
    const again = await post(runtime, `/v1/capabilities/${requestId}/confirm`);
    assert.equal(again.status, 409);
    assert.equal((again.body as { error: { code: string } }).error.code, "capability_invalid_state");
  } finally {
    await runtime.close();
  }
});

test("复用路径端到端：检索命中 → status reused，无 planned 事件", async (t) => {
  const dir = tmpDir("morrow-factory-api-reuse-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir), optionsWith({ async generate() { throw new Error("must not be called"); } }));
  try {
    // 先授权面，再注册一个可命中的能力
    const grants = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRANTS),
    });
    assert.equal(grants.status, 200);
    await post(runtime, "/v1/capabilities", {
      name: "text-slugify",
      version: "1.0.0",
      author: "human",
      runtime: "typescript",
      permissions: GRANTS,
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: { type: "none", network: "none", filesystem: "none" },
      tests: [],
    });
    const submitted = await post(runtime, "/v1/capabilities/request", { description: "please slugify text for URLs" });
    assert.equal(submitted.status, 201);
    const view = await waitForStatus(runtime, submitted.body.request_id as string, ["reused"]);
    assert.ok((view.reuse_matches ?? []).some((m) => m.name === "text-slugify"));
    const events = await allEvents(runtime.port);
    assert.equal(events.filter((e) => e.event_type === "capability.factory_planned").length, 0);
    assert.equal(events.filter((e) => e.event_type === "capability.factory_retrieved" && e.payload.reused === true).length, 1);
  } finally {
    await runtime.close();
  }
});

test("越权端到端：生成 manifest 超出 grant → failed(stage=plan, escalation)，confirm 409", async (t) => {
  const dir = tmpDir("morrow-factory-api-esc-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir), optionsWith({
    async generate() {
      return {
        ok: true,
        output: goodOutput({
          name: "secret-reader",
          permissions: { filesystem: ["workspace://secrets/**"], network: [], shell: [], channels: [], credentials: [] },
        }),
        raw: "{}",
      };
    },
  }));
  try {
    // grant 只覆盖 workspace://notes/**
    const put = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRANTS),
    });
    assert.equal(put.status, 200);

    const submitted = await post(runtime, "/v1/capabilities/request", { description: "read my secrets" });
    assert.equal(submitted.status, 201);
    const view = await waitForStatus(runtime, submitted.body.request_id as string, ["failed"]);
    assert.equal(view.error?.stage, "plan");
    assert.equal(view.error?.code, "escalation");
    const confirm = await post(runtime, `/v1/capabilities/${submitted.body.request_id as string}/confirm`);
    assert.equal(confirm.status, 409);
    const events = await allEvents(runtime.port);
    const failed = events.find((e) => e.event_type === "capability.factory_failed");
    assert.ok(failed !== undefined);
    assert.equal(failed.payload.code, "escalation");
    assert.ok(Array.isArray(failed.payload.violations));
    // 注册表无痕
    const list = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities`);
    const capabilities = (await json<{ capabilities: Array<{ name: string }> }>(list)).capabilities;
    assert.ok(!capabilities.some((c) => c.name === "secret-reader"));
  } finally {
    await runtime.close();
  }
});

test("校验失败端到端：生成器坏输出 → failed(stage=plan, invalid_output) + 原始输出尾段可追踪", async (t) => {
  const dir = tmpDir("morrow-factory-api-bad-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir), optionsWith({
    async generate() {
      return { ok: false, code: "no_output", detail: "model produced no JSON", raw: "sorry, I cannot" };
    },
  }));
  try {
    const submitted = await post(runtime, "/v1/capabilities/request", { description: "anything" });
    assert.equal(submitted.status, 201);
    const view = await waitForStatus(runtime, submitted.body.request_id as string, ["failed"]);
    assert.equal(view.error?.code, "no_output");
    const events = await allEvents(runtime.port);
    const failed = events.find((e) => e.event_type === "capability.factory_failed")!;
    assert.match(String(failed.payload.raw_tail ?? ""), /cannot/);
  } finally {
    await runtime.close();
  }
});

test("请求校验：description 缺失/空 → 400；未知请求 404", async (t) => {
  const dir = tmpDir("morrow-factory-api-valid-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir), optionsWith({ async generate() { throw new Error("unreachable"); } }));
  try {
    const missing = await post(runtime, "/v1/capabilities/request", {});
    assert.equal(missing.status, 400);
    const empty = await post(runtime, "/v1/capabilities/request", { description: "   " });
    assert.equal(empty.status, 400);
    const unknown = await getView(runtime, "01ARDZ00000000000000000000");
    assert.equal(unknown.status, 404);
  } finally {
    await runtime.close();
  }
});

test("默认生成器接线：无注入、无 Provider → 请求失败（runtime_error，诊断可追踪）而非 500", async (t) => {
  const dir = tmpDir("morrow-factory-api-default-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir), { sandboxRunner: new LocalNodeRunner() });
  try {
    const submitted = await post(runtime, "/v1/capabilities/request", { description: "slugify" });
    assert.equal(submitted.status, 201, "fire-and-forget：POST 接受请求，失败在后台阶段落账");
    const view = await waitForStatus(runtime, submitted.body.request_id as string, ["failed"]);
    assert.equal(view.error?.stage, "plan");
    assert.equal(view.error?.code, "runtime_error");
    assert.match(view.error?.detail ?? "", /no model provider configured/);
  } finally {
    await runtime.close();
  }
});
