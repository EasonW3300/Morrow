// 能力域 HTTP 端到端测试（票 M2-T1 / Issue #22，PRD §6.2 能力端点）：
// POST/GET /v1/capabilities、GET/PUT /v1/capabilities/grants、
// GET /v1/capabilities/:id、POST /v1/capabilities/:id/{enable,disable,rollback}。
// Agent Loop 经 PiAdapter 接口注入 FakePi（零网络）；验收路径：注册越权（五维各一条
// 负样例）100% 拒绝、生命周期与 capability.* 审计、grants 读写审计。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityManifest, EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface RegisterBody {
  capability: {
    name: string;
    version: string;
    author: string;
    status: string;
    source_hash: string;
    manifest: CapabilityManifest;
    created_at: string;
    updated_at: string;
  };
  created: boolean;
  event_id?: string;
}

function apiConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

/** 最小合法 manifest（human、五维全空）：permissions 可整体覆盖 */
function makeManifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    name: "docx-to-markdown",
    version: "1.0.0",
    author: "human",
    runtime: "typescript",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "none", network: "none", filesystem: "none" },
    tests: [],
    ...overrides,
  };
}

async function register(runtime: RuntimeHandle, manifest: unknown): Promise<{ status: number; body: RegisterBody | ApiError }> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifest),
  });
  return { status: res.status, body: (await res.json()) as RegisterBody | ApiError };
}

async function putGrants(runtime: RuntimeHandle, grants: unknown): Promise<{ status: number; body: { grants?: unknown; event_id?: string } & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/grants`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(grants),
  });
  return { status: res.status, body: (await res.json()) as { grants?: unknown; event_id?: string } & ApiError };
}

async function lifecyclePost(runtime: RuntimeHandle, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function allEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

test("注册：201 + capability.registered 审计 + 版本历史；重复注册 200 created:false", async (t) => {
  const dir = tmpDir("morrow-cap-api-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir));
  try {
    const first = await register(runtime, makeManifest());
    assert.equal(first.status, 201);
    const body = first.body as RegisterBody;
    assert.equal(body.created, true);
    assert.equal(body.capability.status, "enabled", "human 注册即启用（Owner 批准即注册启用）");
    assert.match(body.capability.source_hash, /^sha256-[0-9a-f]{64}$/);
    assert.ok(body.event_id !== undefined);

    const events = await allEvents(runtime.port);
    const registered = events.filter((e) => e.event_type === "capability.registered");
    assert.equal(registered.filter((e) => e.payload.name === "docx-to-markdown").length, 1);

    const again = await register(runtime, makeManifest());
    assert.equal(again.status, 200);
    assert.equal((again.body as RegisterBody).created, false);
    const after = await allEvents(runtime.port);
    assert.equal(after.filter((e) => e.event_type === "capability.registered" && e.payload.name === "docx-to-markdown").length, 1);
  } finally {
    await runtime.close();
  }
});

test("注册越权：五维各一条负样例 100% 拒绝（400 escalation，逐维逐项指明超界）", async (t) => {
  const dir = tmpDir("morrow-cap-esc-api-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir));
  try {
    const grants = await putGrants(runtime, {
      filesystem: ["workspace://input/**"],
      network: ["api.example.com:443"],
      shell: ["read"],
      channels: ["desktop"],
      credentials: ["cred-1"],
    });
    assert.equal(grants.status, 200);

    const negative: Array<[string, CapabilityManifest["permissions"]]> = [
      ["filesystem", { filesystem: ["workspace://secrets/**"], network: [], shell: [], channels: [], credentials: [] }],
      ["network", { filesystem: [], network: ["evil.com:443"], shell: [], channels: [], credentials: [] }],
      ["shell", { filesystem: [], network: [], shell: ["arbitrary"], channels: [], credentials: [] }],
      ["channels", { filesystem: [], network: [], shell: [], channels: ["qq"], credentials: [] }],
      ["credentials", { filesystem: [], network: [], shell: [], channels: [], credentials: ["cred-9"] }],
    ];
    for (const [dimension, permissions] of negative) {
      const res = await register(runtime, makeManifest({ name: `escalate-${dimension}`, permissions }));
      assert.equal(res.status, 400, `${dimension} 越权必须 400`);
      const err = res.body as ApiError;
      assert.equal(err.error.code, "capability_escalation", dimension);
      assert.match(err.error.message, new RegExp(dimension), `${dimension} 的报错指明维度`);
      const events = await allEvents(runtime.port);
      assert.equal(
        events.filter((e) => e.event_type === "capability.registered" && e.payload.name === `escalate-${dimension}`).length,
        0,
        `${dimension} 越权不落 registered 事件`,
      );
    }
  } finally {
    await runtime.close();
  }
});

test("verified 标记（GLOSSARY 已验证）：human 带测试=1 / 无测试=0 / builtin=1 / ai 直注=0", async (t) => {
  const dir = tmpDir("morrow-cap-verified-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir));
  try {
    const verifiedOf = async (name: string): Promise<{ status: string; verified: boolean }> => {
      const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/${name}`);
      assert.equal(res.status, 200);
      return (await json<{ record: { status: string; verified: boolean } }>(res)).record;
    };

    assert.equal((await register(runtime, makeManifest({ name: "with-tests", tests: ["positive.yaml"] }))).status, 201);
    assert.equal((await register(runtime, makeManifest({ name: "without-tests" }))).status, 201);
    assert.equal(
      (
        await register(
          runtime,
          makeManifest({
            name: "ai-direct",
            author: "ai",
            tests: ["positive.yaml"],
            sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
          }),
        )
      ).status,
      201,
    );

    const withTests = await verifiedOf("with-tests");
    assert.equal(withTests.status, "enabled");
    assert.equal(withTests.verified, true, "human + tests → verified");

    const withoutTests = await verifiedOf("without-tests");
    assert.equal(withoutTests.verified, false, "无测试 human 注册 = 未验证");

    const aiDirect = await verifiedOf("ai-direct");
    assert.equal(aiDirect.status, "disabled");
    assert.equal(aiDirect.verified, false, "ai 直注未经工厂沙箱验证 = 未验证");

    const builtin = await verifiedOf("memory.write");
    assert.equal(builtin.verified, true, "builtin（Owner 交付 vetted）= verified");
  } finally {
    await runtime.close();
  }
});

test("manifest 形态非法 400；同版本不同内容 409；详情含版本历史", async (t) => {
  const dir = tmpDir("morrow-cap-shape-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir));
  try {
    const bad = await register(runtime, { name: "x" });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as ApiError).error.code, "capability_invalid_manifest");

    assert.equal((await register(runtime, makeManifest())).status, 201);
    const conflict = await register(runtime, makeManifest({ input_schema: { type: "object", required: ["f"] } }));
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as ApiError).error.code, "capability_version_conflict");

    const v2 = await register(runtime, makeManifest({ version: "1.1.0" }));
    assert.equal(v2.status, 201);

    const detail = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/docx-to-markdown`);
    assert.equal(detail.status, 200);
    const detailBody = (await json<{ record: { version: string }; versions: Array<{ version: string }> }>(detail)) as unknown as {
      record: { version: string };
      versions: Array<{ version: string }>;
    };
    assert.equal(detailBody.record.version, "1.1.0");
    assert.deepEqual(detailBody.versions.map((v) => v.version), ["1.0.0", "1.1.0"]);

    const missing = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/nope`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as ApiError).error.code, "capability_not_found");
  } finally {
    await runtime.close();
  }
});

test("清单与过滤：status/author/runtime；未知过滤值 400", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "morrow-cap-list-"));
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir));
  try {
    assert.equal((await register(runtime, makeManifest({ name: "tool-a" }))).status, 201);
    assert.equal(
      (
        await register(
          runtime,
          makeManifest({
            name: "tool-b",
            author: "ai",
            tests: ["t.yaml"],
            sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
          }),
        )
      ).status,
      201,
    );
    const all = await json<{ capabilities: Array<{ name: string }> }>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities`),
    );
    // builtin memory.write 也在注册表里
    assert.ok(all.capabilities.some((c) => c.name === "memory.write"));
    assert.ok(all.capabilities.some((c) => c.name === "tool-a"));
    assert.ok(all.capabilities.some((c) => c.name === "tool-b"));

    const disabled = await json<{ capabilities: Array<{ name: string; status: string }> }>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities?status=disabled`),
    );
    assert.deepEqual(disabled.capabilities.map((c) => c.name), ["tool-b"], "ai 注册默认 disabled");
    const ai = await json<{ capabilities: Array<{ name: string }> }>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities?author=ai`),
    );
    assert.deepEqual(ai.capabilities.map((c) => c.name), ["tool-b"]);
    const bad = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities?status=zzz`);
    assert.equal(bad.status, 400);
  } finally {
    await runtime.close();
  }
});

test("生命周期：enable/disable 幂等审计、rollback 指回历史版本、审计事件全留", async (t) => {
  const dir = tmpDir("morrow-cap-life-api-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir));
  try {
    assert.equal((await register(runtime, makeManifest())).status, 201);
    assert.equal((await register(runtime, makeManifest({ version: "1.1.0" }))).status, 201);

    const disable = await lifecyclePost(runtime, "/v1/capabilities/docx-to-markdown/disable");
    assert.equal(disable.status, 200);
    assert.equal((disable.body.capability as { status: string }).status, "disabled");
    assert.equal((disable.body.changed as boolean), true);
    const disableAgain = await lifecyclePost(runtime, "/v1/capabilities/docx-to-markdown/disable");
    assert.equal(disableAgain.status, 200);
    assert.equal(disableAgain.body.changed, false, "幂等：重复 disable 不重复审计");

    const enable = await lifecyclePost(runtime, "/v1/capabilities/docx-to-markdown/enable");
    assert.equal((enable.body.capability as { status: string }).status, "enabled");

    const rollback = await lifecyclePost(runtime, "/v1/capabilities/docx-to-markdown/rollback", { version: "1.0.0" });
    assert.equal(rollback.status, 200);
    assert.equal(rollback.body.from_version, "1.1.0");
    assert.equal(rollback.body.to_version, "1.0.0");
    assert.equal((rollback.body.capability as { version: string }).version, "1.0.0");

    const noVersion = await lifecyclePost(runtime, "/v1/capabilities/docx-to-markdown/rollback", {});
    assert.equal(noVersion.status, 400);
    const badVersion = await lifecyclePost(runtime, "/v1/capabilities/docx-to-markdown/rollback", { version: "9.9.9" });
    assert.equal(badVersion.status, 404);
    assert.equal((badVersion.body as unknown as ApiError).error.code, "capability_version_not_found");
    const sameVersion = await lifecyclePost(runtime, "/v1/capabilities/docx-to-markdown/rollback", { version: "1.0.0" });
    assert.equal(sameVersion.status, 409);
    assert.equal((sameVersion.body as unknown as ApiError).error.code, "capability_invalid_state");

    const names = (await allEvents(runtime.port)).map((e) => e.event_type);
    for (const expected of ["capability.registered", "capability.enabled", "capability.disabled", "capability.rolled_back"]) {
      assert.ok(names.includes(expected), `${expected} 审计在账本`);
    }
  } finally {
    await runtime.close();
  }
});

test("grants：GET 默认全空；PUT 校验 + capability.grants_updated 审计；收窄后注册越权拒绝", async (t) => {
  const dir = tmpDir("morrow-cap-grants-api-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(apiConfig(dir));
  try {
    const initial = await json<{ grants: { filesystem: string[] } }>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/grants`),
    );
    assert.deepEqual(initial.grants.filesystem, []);

    const put = await putGrants(runtime, { filesystem: ["workspace://**"], network: [], shell: ["read"], channels: [], credentials: [] });
    assert.equal(put.status, 200);
    assert.ok((put.body.event_id as string | undefined) !== undefined);
    const events = await allEvents(runtime.port);
    const updated = events.filter((e) => e.event_type === "capability.grants_updated");
    assert.equal(updated.length, 1);
    assert.deepEqual((updated[0].payload.grants as { filesystem: string[] }).filesystem, ["workspace://**"]);

    const reread = await json<{ grants: { filesystem: string[] } }>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/grants`),
    );
    assert.deepEqual(reread.grants.filesystem, ["workspace://**"]);

    const malformed = await putGrants(runtime, { filesystem: "not-an-array" });
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as ApiError).error.code, "capability_invalid_input");

    // 收窄后：授权面外的注册 400
    const escalate = await register(runtime, makeManifest({ name: "wide", permissions: { filesystem: ["/**"], network: [], shell: [], channels: [], credentials: [] } }));
    assert.equal(escalate.status, 400);
    const inside = await register(runtime, makeManifest({ name: "narrow", permissions: { filesystem: ["workspace://in/**"], network: [], shell: [], channels: [], credentials: [] } }));
    assert.equal(inside.status, 201);
  } finally {
    await runtime.close();
  }
});
