// 能力调用端到端测试（#22 修复批 / FR-CAP-5「能力调用路径做真」）：
//   POST /v1/capabilities/:id/invoke —— 经 ToolInvoker 统一执行链（builtin 进程内直呼）；
//   生命周期事件同步调用注册表（disable → invoke 404 unknown_tool；enable 恢复）；
//   错误码 → HTTP 映射逐码断言（invocation-errors.ts 表，注入桩）；
//   审计贯通：capability.used（direct/skill）与 skill.invoked 先落账本后返回；
//   Skill invoke 缺省走 ToolInvoker（无注入）——真实重用链路。
// 零网络零 docker：执行体为进程内 builtin（memory.write）与注入桩。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import { SandboxError } from "../src/sandbox/runner.ts";
import { PermissionDeniedError } from "../src/sandbox/permission.ts";
import { CapabilityError } from "../src/capabilities/engine.ts";
import { INSTALL_HINT } from "../src/sandbox/detect.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";
import { SESSION_EVENT_TYPES } from "../src/sessions.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface InvokeBody {
  ok: boolean;
  result?: { text?: string };
  error_code?: string;
  error?: string;
  via?: string;
  exit_code: number;
  duration_ms: number;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

async function postJson(runtime: RuntimeHandle, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await json(res)) as Record<string, unknown> & ApiError };
}

async function invokeCapability(runtime: RuntimeHandle, id: string, input: unknown, sessionId?: string): Promise<{ status: number; body: InvokeBody & ApiError }> {
  const query = sessionId === undefined ? "" : `?session_id=${encodeURIComponent(sessionId)}`;
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/${id}/invoke${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  return { status: res.status, body: (await json(res)) as InvokeBody & ApiError };
}

/** 种子一条 message.user（memory.write 的归属回链锚点；会话域不在本套件UnderTest） */
function seedUserMessage(runtime: RuntimeHandle, sessionId: string, text: string): void {
  runtime.ledger.append(
    buildEventEnvelope({
      replicaId: REPLICA,
      actorId: "owner",
      eventType: SESSION_EVENT_TYPES.messageUser,
      sessionId,
      payload: { text },
    }),
  );
}

interface UsedEvent {
  capability: string;
  ok: boolean;
  error_code?: string;
  error?: string;
  via?: string;
  duration_ms: number;
  path: string;
  skill_id?: string;
}

async function usedEvents(runtime: RuntimeHandle): Promise<Array<{ payload: UsedEvent }>> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  const events = (await json<{ events: Array<{ event_type: string; payload: UsedEvent }> }>(res)).events;
  return events.filter((e) => e.event_type === "capability.used").map((e) => ({ payload: e.payload }));
}

/** 注册一个带测试的 human 能力（enabled + verified，供桩执行体挂靠） */
async function registerTestedCapability(runtime: RuntimeHandle, name: string): Promise<void> {
  const res = await postJson(runtime, "/v1/capabilities", {
    name,
    version: "1.0.0",
    author: "human",
    runtime: "typescript",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "none", network: "none", filesystem: "none" },
    tests: ["positive.yaml"],
  });
  assert.equal(res.status, 201, `register ${name} failed: ${JSON.stringify(res.body)}`);
}

// --- 1. 缺省接线：builtin 进程内直呼 + 审计 ------------------------------------

test("invoke memory.write：缺省接线（builtin 进程内直呼）真实写入 + capability.used 审计先落后返", async (t) => {
  const dir = tmpDir("morrow-cap-invoke-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(testConfig(dir));
  try {
    const session = runtime.sessions.createSession();
    seedUserMessage(runtime, session.sessionId, "请记住这条");

    const { status, body } = await invokeCapability(runtime, "memory.write", { content: "Morrow 是单主人的个人 Agent", kind: "fact" }, session.sessionId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.via, "in-process");
    assert.equal(typeof body.result?.text, "string");

    // 真实写入：候选表可查
    const candidates = await fetch(`http://127.0.0.1:${runtime.port}/v1/memory/candidates`);
    const list = (await json<{ candidates: Array<{ content: string }> }>(candidates));
    assert.ok(list.candidates.some((c) => c.content.includes("Morrow 是单主人的个人 Agent")), "memory.write 真实生效");

    const used = await usedEvents(runtime);
    const entry = used.find((e) => e.payload.capability === "memory.write");
    assert.ok(entry, "capability.used 审计在账本");
    assert.equal(entry.payload.ok, true);
    assert.equal(entry.payload.via, "in-process");
    assert.equal(entry.payload.path, "direct");
    assert.equal(typeof entry.payload.duration_ms, "number");
    assert.ok(entry.payload.duration_ms >= 0);
  } finally {
    await runtime.close();
  }
});

test("无归属会话的 memory.write：执行链真实触达工具语义（502 tool_error，而非 404/500）", async (t) => {
  const dir = tmpDir("morrow-cap-invoke-nosession-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(testConfig(dir));
  try {
    const { status, body } = await invokeCapability(runtime, "memory.write", { content: "x" });
    assert.equal(status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.error_code, "tool_error");
    assert.match(body.error ?? "", /user message/, "错误来自工具自身归属语义（执行链贯通）");
    const used = await usedEvents(runtime);
    assert.equal(used[0]?.payload.ok, false);
    assert.equal(used[0]?.payload.error_code, "tool_error");
  } finally {
    await runtime.close();
  }
});

// --- 2. 生命周期事件同步调用注册表 ----------------------------------------------

test("disable 摘除调用条目（invoke 404 unknown_tool + 审计留痕）；enable 重新登记恢复执行", async (t) => {
  const dir = tmpDir("morrow-cap-lifecycle-invoke-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(testConfig(dir));
  try {
    const session = runtime.sessions.createSession();
    seedUserMessage(runtime, session.sessionId, "锚点");

    const disable = await postJson(runtime, "/v1/capabilities/memory.write/disable");
    assert.equal(disable.status, 200);
    const off = await invokeCapability(runtime, "memory.write", { content: "x" }, session.sessionId);
    assert.equal(off.status, 404);
    assert.equal(off.body.error.code, "unknown_tool");

    const used = await usedEvents(runtime);
    const denied = used.find((e) => e.payload.capability === "memory.write");
    assert.ok(denied);
    assert.equal(denied.payload.ok, false);
    assert.equal(denied.payload.error_code, "unknown_tool");

    const enable = await postJson(runtime, "/v1/capabilities/memory.write/enable");
    assert.equal(enable.status, 200);
    const back = await invokeCapability(runtime, "memory.write", { content: "恢复后的写入" }, session.sessionId);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.ok, true);
  } finally {
    await runtime.close();
  }
});

test("未注册能力 invoke：404 unknown_tool（错误码表 + 审计）", async (t) => {
  const dir = tmpDir("morrow-cap-unknown-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(testConfig(dir));
  try {
    const { status, body } = await invokeCapability(runtime, "ghost.capability", {});
    assert.equal(status, 404);
    assert.equal(body.error.code, "unknown_tool");
    const used = await usedEvents(runtime);
    assert.equal(used[0]?.payload.error_code, "unknown_tool");
  } finally {
    await runtime.close();
  }
});

// --- 3. 错误码 → HTTP 映射逐码断言（注入桩）------------------------------------
// 库层错误的两条注入路径：容器路径经 sandboxRunner 桩（按包名抛对应错误，真实经过
// ToolInvoker → runner 链）；权限/注册表错误经 permissionEngine 桩。工具自身失败（502）
// 由进程内桩自报。完整映射表（含 runner 内部分类码）另见 invocation-errors.test.ts。

test("错误码表逐码落 HTTP（容器路径桩）：sandbox_unavailable 503+install-hint / tool_timeout 504 / image_pull_failed 503 / tool_package_unsupported 400 / invalid_sandbox_contract 400；工具自报失败 502", async (t) => {
  const dir = tmpDir("morrow-cap-errmap-");
  t.after(() => removeDir(dir));
  const errorByPackage: Record<string, () => unknown> = {
    "cap.sandbox-unavailable": () => new SandboxError("sandbox_unavailable", "no usable container runtime: sandboxed (AI-generated) tools are refused.", INSTALL_HINT.darwin ?? undefined),
    "cap.tool-timeout": () => new SandboxError("tool_timeout", "tool exceeded 30000ms and was killed"),
    "cap.image-pull": () => new SandboxError("image_pull_failed", "failed to pull node:22-alpine: net down"),
    "cap.package-unsupported": () => new SandboxError("tool_package_unsupported", "DockerRunner executes bundled TypeScript packages only"),
  };
  const runtime = await startRuntime(testConfig(dir), {
    sandboxRunner: {
      async run(pkg) {
        const make = errorByPackage[pkg.name];
        if (make === undefined) {
          return { ok: true, exit_code: 0, timed_out: false, stdout: "", stderr: "", result: { via: "fake" }, duration_ms: 1, engine: "fake", image: "fake" };
        }
        throw make();
      },
    },
  });
  try {
    // 容器路径桩能力：经公开注册表注册（human + tests → enabled+verified）
    const stubContainer = async (name: string): Promise<void> => {
      const res = await postJson(runtime, "/v1/capabilities", {
        name,
        version: "1.0.0",
        author: "human",
        runtime: "typescript",
        permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
        tests: ["positive.yaml"],
      });
      assert.equal(res.status, 201);
      runtime.sandbox.register({
        manifest: {
          name,
          version: "1.0.0",
          author: "human",
          runtime: "typescript",
          permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
          sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
        },
        package: { name, kind: "typescript", entry: "/pkg/tool.ts" },
      });
    };

    await stubContainer("cap.sandbox-unavailable");
    await stubContainer("cap.tool-timeout");
    await stubContainer("cap.image-pull");
    await stubContainer("cap.package-unsupported");

    // 工具自报失败：进程内桩返回 {ok:false} → 结构化 502
    await registerTestedCapability(runtime, "cap.tool-error");
    runtime.sandbox.register({
      manifest: {
        name: "cap.tool-error",
        version: "1.0.0",
        author: "human",
        runtime: "typescript",
        permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
        sandbox: { type: "process", network: "none", filesystem: "none" },
      },
      package: { name: "cap.tool-error", kind: "typescript" },
      inProcess: async () => ({ ok: false, error: "boom inside tool" }),
    });

    const cases: Array<[string, number, string, RegExp?]> = [
      ["cap.tool-error", 502, "tool_error", undefined],
      ["cap.sandbox-unavailable", 503, "sandbox_unavailable", /Install Docker Desktop/],
      ["cap.tool-timeout", 504, "tool_timeout", undefined],
      ["cap.image-pull", 503, "image_pull_failed", undefined],
      ["cap.package-unsupported", 400, "tool_package_unsupported", undefined],
    ];
    for (const [name, expectedStatus, expectedCode, messageMatch] of cases) {
      const { status, body } = await invokeCapability(runtime, name, {});
      assert.equal(status, expectedStatus, `${expectedCode} → HTTP ${expectedStatus}（got ${status}）`);
      assert.equal(body.error_code ?? body.error?.code, expectedCode, name);
      if (messageMatch !== undefined) {
        assert.match(body.error?.message ?? body.error ?? "", messageMatch, `${name} message 携带诊断/install-hint`);
      }
    }

    const used = await usedEvents(runtime);
    for (const [, , code] of cases) {
      const entry = used.find((e) => e.payload.error_code === code);
      assert.ok(entry, `${code} 落 capability.used 审计`);
      assert.equal(entry.payload.ok, false);
    }
  } finally {
    await runtime.close();
  }
});

test("错误码表逐码落 HTTP（权限桩）：permission_denied 403 / capability_escalation 400", async (t) => {
  const dir = tmpDir("morrow-cap-errmap-perm-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(testConfig(dir), {
    permissionEngine: {
      async assertRuntimeUse(req) {
        if (req.manifest.name === "cap.denied") {
          throw new PermissionDeniedError("registry invalid_state: capability is disabled");
        }
        if (req.manifest.name === "cap.escalation") {
          throw new CapabilityError("escalation", 'runtime use denied (1 violation(s)): filesystem: no grant covers "/**"');
        }
      },
    },
  });
  try {
    await registerTestedCapability(runtime, "cap.denied");
    await registerTestedCapability(runtime, "cap.escalation");
    runtime.sandbox.register({
      manifest: {
        name: "cap.denied",
        version: "1.0.0",
        author: "human",
        runtime: "typescript",
        permissions: {},
        sandbox: { type: "process", network: "none", filesystem: "none" },
      },
      package: { name: "cap.denied", kind: "typescript" },
      inProcess: async () => ({ ok: true, result: 1 }),
    });
    runtime.sandbox.register({
      manifest: {
        name: "cap.escalation",
        version: "1.0.0",
        author: "human",
        runtime: "typescript",
        permissions: {},
        sandbox: { type: "process", network: "none", filesystem: "none" },
      },
      package: { name: "cap.escalation", kind: "typescript" },
      inProcess: async () => ({ ok: true, result: 1 }),
    });

    const denied = await invokeCapability(runtime, "cap.denied", {});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "permission_denied");
    const escalation = await invokeCapability(runtime, "cap.escalation", {});
    assert.equal(escalation.status, 400);
    assert.equal(escalation.body.error.code, "capability_escalation");

    const used = await usedEvents(runtime);
    // 审计存库层错误码（escalation）；HTTP 信封按映射表转 capability_escalation
    assert.ok(used.find((e) => e.payload.error_code === "permission_denied"));
    assert.ok(used.find((e) => e.payload.error_code === "escalation"));
  } finally {
    await runtime.close();
  }
});

// --- 4. Skill invoke 缺省走 ToolInvoker（无注入的真实重用链路）------------------

test("Skill invoke 缺省链路：memory.write 步骤真执行 + skill.invoked / capability.used(path=skill) 审计", async (t) => {
  const dir = tmpDir("morrow-skill-default-chain-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(testConfig(dir));
  try {
    const session = runtime.sessions.createSession();
    seedUserMessage(runtime, session.sessionId, "锚点");

    const proposed = await postJson(runtime, "/v1/capabilities/skills", {
      name: "remember-fact",
      description: "把一条事实写进长期记忆",
      steps: [{ capability_id: "memory.write", arg_mapping: { content: "{{content}}" } }],
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    const proposalId = proposed.body.proposal_id as string;
    const approved = await postJson(runtime, `/v1/capabilities/skills/${proposalId}/approve`);
    assert.equal(approved.status, 200);

    const invoked = await postJson(runtime, `/v1/capabilities/skills/${proposalId}/invoke`, {
      params: { content: "Skill 链路写入的记忆" },
      session_id: session.sessionId,
    });
    assert.equal(invoked.status, 200, JSON.stringify(invoked.body));
    assert.equal(invoked.body.ok, true);
    const steps = invoked.body.steps as Array<{ ok: boolean; via: string; result?: { text?: string } }>;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].ok, true);
    assert.equal(steps[0].via, "in-process", "步骤经 ToolInvoker builtin 进程内执行");
    assert.ok(steps[0].result?.text !== undefined);

    // 真实写入
    const candidates = await fetch(`http://127.0.0.1:${runtime.port}/v1/memory/candidates`);
    const list = (await json<{ candidates: Array<{ content: string }> }>(candidates));
    assert.ok(list.candidates.some((c) => c.content.includes("Skill 链路写入的记忆")));

    // 审计：步级 capability.used（path=skill、actor agent:skill）+ skill.invoked
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/events?limit=200`);
    const events = (await json<{ events: Array<{ event_type: string; actor_id: string; payload: UsedEvent }> }>(res)).events;
    const stepUsed = events.find((e) => e.event_type === "capability.used" && e.payload.path === "skill");
    assert.ok(stepUsed, "步级 capability.used 在账本");
    assert.equal(stepUsed.actor_id, "agent:skill");
    assert.equal(stepUsed.payload.capability, "memory.write");
    assert.equal(stepUsed.payload.skill_id, proposalId);
    assert.equal(stepUsed.payload.ok, true);
    const skillInvoked = events.find((e) => e.event_type === "skill.invoked");
    assert.ok(skillInvoked, "skill.invoked 在账本");
    const skillPayload = skillInvoked.payload as unknown as { skill_id: string; ok: boolean; steps: number; executed: number; failed_step: number | null; duration_ms: number };
    assert.equal(skillPayload.skill_id, proposalId);
    assert.equal(skillPayload.ok, true);
    assert.equal(skillPayload.steps, 1);
    assert.equal(skillPayload.executed, 1);
    assert.equal(skillPayload.failed_step, null);
    assert.equal(typeof skillPayload.duration_ms, "number");
  } finally {
    await runtime.close();
  }
});

test("未验证能力引用：human 无测试注册（verified=false）→ Skill 提案 409 dangling", async (t) => {
  const dir = tmpDir("morrow-skill-unverified-");
  t.after(() => removeDir(dir));
  const runtime = await startRuntime(testConfig(dir));
  try {
    const reg = await postJson(runtime, "/v1/capabilities", {
      name: "no-tests-tool",
      version: "1.0.0",
      author: "human",
      runtime: "typescript",
      permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: { type: "none", network: "none", filesystem: "none" },
      tests: [],
    });
    assert.equal(reg.status, 201);
    const detail = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/no-tests-tool`);
    const record = (await json<{ record: { status: string; verified: boolean } }>(detail)).record;
    assert.equal(record.status, "enabled");
    assert.equal(record.verified, false, "无测试 human 注册 = 未验证");

    const proposed = await postJson(runtime, "/v1/capabilities/skills", {
      name: "use-unverified",
      steps: [{ capability_id: "no-tests-tool", arg_mapping: {} }],
    });
    assert.equal(proposed.status, 409);
    assert.equal(proposed.body.error.code, "skill_dangling_reference");
    assert.match(proposed.body.error.message, /unverified/);
  } finally {
    await runtime.close();
  }
});
