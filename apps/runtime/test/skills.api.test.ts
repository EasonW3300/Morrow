// Skill 域 HTTP 端到端测试（票 M2-T5 / Issue #26，PRD §6.2 能力端点扩展 + T6 合约）：
// 端点（票面路径族 /v1/capabilities/skills* + T6 api.ts 已编码别名 /v1/skills*，同 handler）：
//   GET  /v1/capabilities/skills[?match=]（=GET /v1/skills）      清单 / 检索复用
//   GET  /v1/capabilities/skills/proposals（=GET /v1/skills/proposals）
//   POST /v1/capabilities/skills                                  手动提案
//   POST /v1/capabilities/skills/cases                            案例上报
//   POST /v1/capabilities/skills/proposals/:id/{approve,reject}（T6 decide 合约）
//   POST /v1/capabilities/skills/:id/{approve,reject}（票面口径）
//   POST /v1/capabilities/skills/:id/invoke                       重用调用
// 响应形状按 T6 SkillSummary/SkillProposal 投影（status: proposed→pending）；能力调用经
// 注入 FakeSkillInvoker（零网络零 docker）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface SkillSummary {
  skill_id: string;
  title: string;
  version: string;
  capabilities: string[];
  enabled?: boolean;
  name?: string;
  description?: string;
}

interface SkillProposal {
  proposal_id: string;
  title: string;
  status: "pending" | "approved" | "rejected";
  capabilities: string[];
  missing_capabilities?: string[];
  reason?: string;
  created_at?: string;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

/** FakeSkillInvoker：记录调用并回声（ToolInvoker 结构接缝注入） */
function makeFakeInvoker() {
  const calls: Array<{ name: string; input: unknown; context: unknown }> = [];
  return {
    calls,
    invoker: {
      async invoke(name: string, input: unknown, context?: { actorId?: string }) {
        calls.push({ name, input, context });
        return { ok: true, result: { echoed: input }, via: "fake" };
      },
    },
  };
}

async function registerCapability(
  runtime: RuntimeHandle,
  manifest: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifest),
  });
  assert.equal(res.status, 201, `register capability failed: ${res.status}`);
}

function capabilityManifest(name: string): Record<string, unknown> {
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

async function postCase(
  runtime: RuntimeHandle,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> & ApiError }> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/skills/cases`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await json(res)) as Record<string, unknown> & ApiError };
}

// --- 清单与别名 ----------------------------------------------------------------

test("GET /v1/capabilities/skills 空清单；T6 别名 /v1/skills 同形状", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const runtime = await startRuntime(testConfig(dir), { skillInvoker: fake.invoker });
  try {
    for (const path of ["/v1/capabilities/skills", "/v1/skills"]) {
      const res = await fetch(`http://127.0.0.1:${runtime.port}${path}`);
      assert.equal(res.status, 200);
      const body = await json<{ skills: SkillSummary[] }>(res);
      assert.deepEqual(body.skills, []);
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- 演示链路（两次经验 → 提案 → 批准 → 第三次 invoke 重用）--------------------

test("演示链路：两次成功案例 → pending 提案 → 批准 → invoke 重用（T6 形状全链路）", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const runtime = await startRuntime(testConfig(dir), { skillInvoker: fake.invoker });
  try {
    await registerCapability(runtime, capabilityManifest("docx-to-markdown"));

    // 两次同类经验（案例上报）
    const first = await postCase(runtime, {
      capability: "docx-to-markdown",
      outcome: "success",
      source_event_id: "tool-finished-1",
      occurred_at: "2026-11-01T00:00:01.000Z",
    });
    assert.equal(first.status, 201);
    assert.equal((first.body.proposal as Record<string, unknown> | undefined) ?? null, null);

    const second = await postCase(runtime, {
      capability: "docx-to-markdown",
      outcome: "success",
      source_event_id: "tool-finished-2",
      occurred_at: "2026-11-01T00:00:02.000Z",
    });
    assert.equal(second.status, 201);
    const autoProposal = second.body.proposal as Record<string, string>;
    assert.equal(autoProposal.status, "pending"); // T6 投影：proposed → pending
    assert.deepEqual(autoProposal.capabilities, ["docx-to-markdown"]);

    // 不足阈值不产生（首个案例时提案列表为空——回看 first 响应）
    assert.equal((first.body.proposal as unknown) ?? null, null);

    // 提案列表可查（票面 + T6 别名同形状）
    const listRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/skills/proposals`);
    const list = await json<{ proposals: SkillProposal[] }>(listRes);
    assert.equal(list.proposals.length, 1);
    assert.equal(list.proposals[0].proposal_id, autoProposal.proposal_id);
    assert.equal(list.proposals[0].status, "pending");

    // 批准（票面路径族）
    const approveRes = await fetch(
      `http://127.0.0.1:${runtime.port}/v1/capabilities/skills/${autoProposal.proposal_id}/approve`,
      { method: "POST" },
    );
    assert.equal(approveRes.status, 200);
    const approved = (await json<SkillProposal>(approveRes));
    assert.equal(approved.status, "approved");

    // 已批准 Skill 出现在清单（T6 SkillSummary 形状）
    const skillsRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/skills`);
    const skills = await json<{ skills: SkillSummary[] }>(skillsRes);
    assert.equal(skills.skills.length, 1);
    assert.equal(skills.skills[0].skill_id, autoProposal.proposal_id);
    assert.equal(skills.skills[0].title, "docx-to-markdown");
    assert.equal(typeof skills.skills[0].version, "string");
    assert.deepEqual(skills.skills[0].capabilities, ["docx-to-markdown"]);
    assert.equal(skills.skills[0].enabled, true);

    // 第三次直接重用：invoke（参数透传——空 arg_mapping）
    const invokeRes = await fetch(
      `http://127.0.0.1:${runtime.port}/v1/capabilities/skills/${autoProposal.proposal_id}/invoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { input_path: "a.docx" } }),
      },
    );
    assert.equal(invokeRes.status, 200);
    const invoked = await json<{ ok: boolean; steps: Array<Record<string, unknown>> }>(invokeRes);
    assert.equal(invoked.ok, true);
    assert.deepEqual(fake.calls[0].input, { input_path: "a.docx" });
    assert.equal(fake.calls[0].name, "docx-to-markdown");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- 悬空引用与决策 ------------------------------------------------------------

test("POST skills：悬空引用（未注册能力）→ 409 skill_dangling_reference", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const runtime = await startRuntime(testConfig(dir), { skillInvoker: fake.invoker });
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "chain",
        steps: [{ capability_id: "ghost-capability", arg_mapping: {} }],
      }),
    });
    assert.equal(res.status, 409);
    const err = await json<ApiError>(res);
    assert.equal(err.error.code, "skill_dangling_reference");
    assert.match(err.error.message, /ghost-capability/);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("批准时引用已停用 → 409 + 提案转 rejected（missing_capabilities 留痕，T6 悬空呈现）", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const runtime = await startRuntime(testConfig(dir), { skillInvoker: fake.invoker });
  try {
    await registerCapability(runtime, capabilityManifest("docx-to-markdown"));
    await postCase(runtime, { capability: "docx-to-markdown", outcome: "success", source_event_id: "e1", occurred_at: "2026-11-01T00:00:01.000Z" });
    const second = await postCase(runtime, { capability: "docx-to-markdown", outcome: "success", source_event_id: "e2", occurred_at: "2026-11-01T00:00:02.000Z" });
    const proposal = second.body.proposal as Record<string, string>;

    const disableRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/docx-to-markdown/disable`, { method: "POST" });
    assert.equal(disableRes.status, 200);

    const approveRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/skills/proposals/${proposal.proposal_id}/approve`, { method: "POST" });
    assert.equal(approveRes.status, 409);
    const err = await json<ApiError>(approveRes);
    assert.equal(err.error.code, "skill_dangling_reference");

    const list = await json<{ proposals: SkillProposal[] }>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/skills/proposals`),
    );
    assert.equal(list.proposals[0].status, "rejected");
    assert.deepEqual(list.proposals[0].missing_capabilities, ["docx-to-markdown"]);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("T6 decide reject 别名：/v1/skills/proposals/:id/reject → rejected（reason 留痕）", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const runtime = await startRuntime(testConfig(dir), { skillInvoker: fake.invoker });
  try {
    await registerCapability(runtime, capabilityManifest("docx-to-markdown"));
    await postCase(runtime, { capability: "docx-to-markdown", outcome: "success", source_event_id: "e1", occurred_at: "2026-11-01T00:00:01.000Z" });
    const second = await postCase(runtime, { capability: "docx-to-markdown", outcome: "success", source_event_id: "e2", occurred_at: "2026-11-01T00:00:02.000Z" });
    const proposal = second.body.proposal as Record<string, string>;

    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/skills/proposals/${proposal.proposal_id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "组合粒度不对" }),
    });
    assert.equal(res.status, 200);
    const decided = await json<SkillProposal>(res);
    assert.equal(decided.status, "rejected");
    assert.equal(decided.reason, "组合粒度不对");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- 检索复用与错误映射 --------------------------------------------------------

test("GET skills?match= 命中已批准 Skill → reused=true（FR-CAP-1 重用路径）", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const runtime = await startRuntime(testConfig(dir), { skillInvoker: fake.invoker });
  try {
    await registerCapability(runtime, capabilityManifest("docx-to-markdown"));
    await postCase(runtime, { capability: "docx-to-markdown", outcome: "success", source_event_id: "e1", occurred_at: "2026-11-01T00:00:01.000Z" });
    const second = await postCase(runtime, { capability: "docx-to-markdown", outcome: "success", source_event_id: "e2", occurred_at: "2026-11-01T00:00:02.000Z" });
    const proposal = second.body.proposal as Record<string, string>;
    await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/skills/${proposal.proposal_id}/approve`, { method: "POST" });

    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/skills?match=${encodeURIComponent("convert docx to markdown please")}`);
    const body = await json<{ skills: SkillSummary[]; reused: boolean }>(res);
    assert.equal(body.reused, true);
    assert.equal(body.skills.length, 1);
    assert.equal(body.skills[0].name, "docx-to-markdown");

    const miss = await json<{ reused: boolean; skills: unknown[] }>(
      await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/skills?match=${encodeURIComponent("render pdf charts")}`),
    );
    assert.equal(miss.reused, false);
    assert.deepEqual(miss.skills, []);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("错误映射：invoke 未批准 409 skill_not_approved；未知 404 skill_not_found；案例非法 400", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const runtime = await startRuntime(testConfig(dir), { skillInvoker: fake.invoker });
  try {
    await registerCapability(runtime, capabilityManifest("docx-to-markdown"));
    await postCase(runtime, { capability: "docx-to-markdown", outcome: "success", source_event_id: "e1", occurred_at: "2026-11-01T00:00:01.000Z" });
    const second = await postCase(runtime, { capability: "docx-to-markdown", outcome: "success", source_event_id: "e2", occurred_at: "2026-11-01T00:00:02.000Z" });
    const proposal = second.body.proposal as Record<string, string>;

    const notApproved = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/skills/${proposal.proposal_id}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: {} }),
    });
    assert.equal(notApproved.status, 409);
    assert.equal((await json<ApiError>(notApproved)).error.code, "skill_not_approved");

    const unknown = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/skills/01936b9d-0000-7abc-9f2e-000000000000/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: {} }),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await json<ApiError>(unknown)).error.code, "skill_not_found");

    const badCase = await postCase(runtime, { capability: "docx-to-markdown", outcome: "meh", source_event_id: "e4" });
    assert.equal(badCase.status, 400);
    assert.equal(badCase.body.error?.code, "skill_invalid_input");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- 会话贯通（tool.finished → 案例收集）与重启回填 -----------------------------
// FakePi 注入：agent 工具调用真实走 SessionManager → tool.finished 落账 → SkillService
// 观测入案例表（票面「经验收集」主路径）；skill 调用接缝另测（FakeInvoker）。

import { createFakePi, type FakeStep } from "@morrow/pi-adapter";

function agentTool(name: string, result: string, isError = false) {
  return {
    name,
    description: `fake tool ${name}`,
    parameters: { type: "object" },
    async execute() {
      return { text: result, ...(isError ? { isError: true } : {}) };
    },
  };
}

function scriptedAgentFactory(script: FakeStep[], extraTools: ReturnType<typeof agentTool>[]) {
  return async (_sessionId: string, _provider: unknown, extras?: { tools?: unknown[] }) =>
    createFakePi({
      script,
      // FakePi 工具实现 = runtime 注入的 builtin（memory.write）+ 本测试的 fake 能力工具
      tools: [...((extras?.tools ?? []) as ReturnType<typeof agentTool>[]), ...extraTools],
    });
}

async function sendMessage(runtime: RuntimeHandle, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function casesOf(runtime: RuntimeHandle): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/capabilities/skills/cases`);
  assert.equal(res.status, 200);
  return (await json<{ cases: Array<Record<string, unknown>> }>(res)).cases;
}

test("会话贯通：FakePi 工具调用成功两次 → tool.finished 观测入案例 → 自动提案", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const script: FakeStep[] = [{ kind: "tool", toolName: "docx-to-markdown", args: { input: "a.docx" }, result: "ok" }];
  const runtime = await startRuntime(testConfig(dir), {
    skillInvoker: fake.invoker,
    agentAdapterFactory: scriptedAgentFactory([...script], [agentTool("docx-to-markdown", "converted")]),
  });
  try {
    await registerCapability(runtime, capabilityManifest("docx-to-markdown"));
    const sessionRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { session_id: sessionId } = await json<{ session_id: string }>(sessionRes);

    await sendMessage(runtime, sessionId, "转换第一个文档");
    await sendMessage(runtime, sessionId, "转换第二个文档");
    await waitFor("自动提案", async () => {
      const list = await json<{ proposals: Array<Record<string, unknown>> }>(
        await fetch(`http://127.0.0.1:${runtime.port}/v1/skills/proposals`),
      );
      return list.proposals.length === 1;
    });

    const cases = await casesOf(runtime);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].outcome, "success");
    assert.equal(cases[0].capability, "docx-to-markdown");
    assert.equal(typeof cases[0].source_event, "string");
    assert.equal(cases[0].session_id, sessionId);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("会话贯通：工具失败 → failure 案例（streak 重置——失败/成功/成功 不产生提案）", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  // 单轮三步脚本：失败 → 成功 → 成功（FakePi runtime 按会话缓存、脚本每轮重放——
  // 单轮内的次序才是确定的经验序列）
  const script: FakeStep[] = [
    { kind: "tool", toolName: "docx-to-markdown", args: {}, result: "ok" },
    { kind: "tool", toolName: "docx-to-markdown", args: {}, error: "boom" },
    { kind: "tool", toolName: "docx-to-markdown", args: {}, result: "ok" },
  ];
  const runtime = await startRuntime(testConfig(dir), {
    skillInvoker: fake.invoker,
    agentAdapterFactory: scriptedAgentFactory([...script], [agentTool("docx-to-markdown", "converted")]),
  });
  try {
    await registerCapability(runtime, capabilityManifest("docx-to-markdown"));
    const sessionRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { session_id: sessionId } = await json<{ session_id: string }>(sessionRes);
    await sendMessage(runtime, sessionId, "转换文档");

    await waitFor("三个案例", async () => (await casesOf(runtime)).length === 3);

    const outcomes = (await casesOf(runtime)).map((c) => c.outcome);
    assert.deepEqual(outcomes, ["success", "failure", "success"]);
    const list = await json<{ proposals: unknown[] }>(await fetch(`http://127.0.0.1:${runtime.port}/v1/skills/proposals`));
    assert.deepEqual(list.proposals, []); // 失败重置 streak：仅连续 2 次成功
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("重启回填：tool.finished 案例经 ingestFromLedger 回填幂等（不重复计数/不重复提案）", async () => {
  const dir = tmpDir("morrow-skills-api-");
  const fake = makeFakeInvoker();
  const config = testConfig(dir);
  const first = await startRuntime(config, {
    skillInvoker: fake.invoker,
    agentAdapterFactory: scriptedAgentFactory(
      [{ kind: "tool", toolName: "docx-to-markdown", args: {}, result: "ok" }],
      [agentTool("docx-to-markdown", "converted")],
    ),
  });
  try {
    await registerCapability(first, capabilityManifest("docx-to-markdown"));
    const sessionRes = await fetch(`http://127.0.0.1:${first.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { session_id: sessionId } = await json<{ session_id: string }>(sessionRes);
    for (const text of ["一", "二"]) await sendMessage(first, sessionId, text);
    await waitFor("两案例", async () => (await casesOf(first)).length === 2);
    await first.close();

    // 重启（同 dataDir）：回填 + 幂等
    const second = await startRuntime(config, { skillInvoker: fake.invoker });
    try {
      await waitFor("回填完成", async () => (await casesOf(second)).length === 2);
      const cases = await casesOf(second);
      assert.equal(cases.length, 2); // 不重复
      const list = await json<{ proposals: unknown[] }>(await fetch(`http://127.0.0.1:${second.port}/v1/skills/proposals`));
      assert.equal(list.proposals.length, 1); // 不重复提案
    } finally {
      await second.close();
    }
  } finally {
    removeDir(dir);
  }
});
