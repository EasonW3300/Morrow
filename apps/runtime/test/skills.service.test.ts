// Skill 服务测试（票 M2-T5 / Issue #26，FR-EVO-1 / GLOSSARY Skill 口径）：
// 案例收集（tool.finished 成功/失败 → skill_cases）、晋升（streak ≥ 阈值 → 自动提案）、
// 悬空引用校验（409 skill_dangling_reference）、approve/reject、invoke 模板填充、match 检索。
// 账本/注册表真实（临时目录同库），能力调用经 FakeSkillInvoker 注入（零网络）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillService, SkillError, type SkillRecord } from "../src/capabilities/skills/service.ts";
import { PermissionEngine } from "../src/capabilities/engine.ts";
import { EventLedger } from "../src/ledger.ts";
import { makeEvent, removeDir, REPLICA_A, tmpDir } from "./helpers.ts";

// --- 夹具 ---------------------------------------------------------------------

interface FakeCall {
  name: string;
  input: unknown;
  context: { actorId?: string } | undefined;
}

function makeService(
  options: { promotionThreshold?: number; invokerBehavior?: (call: { name: string; input: unknown }) => { ok: boolean; result?: unknown; error_code?: string; error?: string } } = {},
): {
  service: SkillService;
  capabilities: PermissionEngine;
  ledger: EventLedger;
  dir: string;
  calls: FakeCall[];
} {
  const dir = tmpDir("morrow-skills-");
  const ledger = EventLedger.open(dir);
  const capabilities = new PermissionEngine({ dataDir: dir, ledger, replicaId: REPLICA_A });
  const calls: FakeCall[] = [];
  const invoker = {
    async invoke(name: string, input: unknown, context?: { actorId?: string }) {
      calls.push({ name, input, context });
      return (options.invokerBehavior ?? ((call: { name: string; input: unknown }) => ({ ok: true, result: { echo: call.input } })))({ name, input });
    },
  };
  const service = new SkillService({
    dataDir: dir,
    ledger,
    replicaId: REPLICA_A,
    capabilities,
    invoker,
    ...(options.promotionThreshold !== undefined ? { promotionThreshold: options.promotionThreshold } : {}),
  });
  return { service, capabilities, ledger, dir, calls };
}

function closeAll(...closers: Array<{ close(): void }>): void {
  for (const closer of closers) closer.close();
}

/** 注册一个 enabled 的 human 能力（permissions ⊆ 全空 grant：五维全空合法） */
function registerCapability(capabilities: PermissionEngine, name: string): void {
  capabilities.register({
    name,
    version: "1.0.0",
    author: "human",
    runtime: "typescript",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "none", network: "none", filesystem: "none" },
    tests: [],
  });
}

// --- 1. 案例收集 ---------------------------------------------------------------

test("案例收集：recordCase 落 skill_cases（capability/结果/时间/来源事件），listCases 可查", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    const source = makeEvent({ event_type: "tool.finished", payload: { tool_name: "docx-to-markdown", is_error: false } });
    ledger.append(source);

    const result = service.recordCase({
      capability: "docx-to-markdown",
      outcome: "success",
      sourceEventId: source.event_id,
      occurredAt: source.occurred_at,
    });
    assert.equal(result.recorded, true);
    assert.equal(result.proposal, null); // 单次成功不足阈值（默认 2）

    const cases = service.listCases();
    assert.equal(cases.length, 1);
    assert.equal(cases[0].capability, "docx-to-markdown");
    assert.equal(cases[0].outcome, "success");
    assert.equal(cases[0].source_event, source.event_id);
    assert.equal(cases[0].occurred_at, source.occurred_at);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("案例收集：同 source_event 幂等去重（ledger 重放不重复计数）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    const source = makeEvent({ event_type: "tool.finished", payload: { tool_name: "docx-to-markdown", is_error: false } });
    ledger.append(source);

    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: source.event_id, occurredAt: source.occurred_at });
    const replay = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: source.event_id, occurredAt: source.occurred_at });
    assert.equal(replay.recorded, false);

    assert.equal(service.listCases().length, 1);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("案例收集：失败案例与成功案例按能力分开计数（listCases 按 capability 过滤）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    registerCapability(capabilities, "pdf-extract");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    service.recordCase({ capability: "docx-to-markdown", outcome: "failure", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    service.recordCase({ capability: "pdf-extract", outcome: "success", sourceEventId: "evt-3", occurredAt: "2026-11-01T00:00:03.000Z" });

    assert.equal(service.listCases().length, 3);
    const docxCases = service.listCases({ capability: "docx-to-markdown" });
    assert.equal(docxCases.length, 2);
    assert.deepEqual(docxCases.map((c) => c.outcome), ["success", "failure"]);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("案例收集：ledger 回放 ingestFromLedger 把 tool.finished 转成案例（is_error → failure）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    const ok = makeEvent({ event_type: "tool.finished", payload: { tool_name: "docx-to-markdown", is_error: false } });
    const bad = makeEvent({ event_type: "tool.finished", payload: { tool_name: "docx-to-markdown", is_error: true } });
    ledger.append(ok);
    ledger.append(bad);

    const ingested = service.ingestFromLedger();
    assert.equal(ingested, 2);
    const cases = service.listCases({ capability: "docx-to-markdown" });
    assert.deepEqual(cases.map((c) => c.outcome), ["success", "failure"]);
    assert.equal(cases[1].source_event, bad.event_id);

    // 二次回放幂等
    assert.equal(service.ingestFromLedger(), 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

// --- 2. 晋升流程（streak ≥ 阈值 → 自动提案）-----------------------------------

test("晋升：同能力连续 2 次成功 → 自动提案（skill.proposed 事件 + 列表可查 pending）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const second = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });

    assert.notEqual(second.proposal, null);
    const proposal = second.proposal as SkillRecord;
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.origin, "auto");
    assert.equal(proposal.name, "docx-to-markdown");
    assert.deepEqual(proposal.capabilities, ["docx-to-markdown"]);
    assert.equal(proposal.steps[0].capability_id, "docx-to-markdown");
    assert.deepEqual(proposal.steps[0].arg_mapping, {}); // 空映射 = invoke 透传

    // 事件审计
    const events = ledger.scan({ eventType: "skill.proposed" });
    assert.equal(events.length, 1);
    assert.equal((events[0].envelope.payload as Record<string, unknown>).name, "docx-to-markdown");

    // 列表可查（HTTP 层再做 T6 pending 投影——见 skills.api.test.ts）
    const proposals = service.listProposals();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].status, "proposed");
    assert.equal(proposals[0].skill_id, proposal.skill_id);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("晋升：单次成功不足阈值（默认 2）不产生提案", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    const first = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    assert.equal(first.proposal, null);
    assert.equal(ledger.scan({ eventType: "skill.proposed" }).length, 0);
    assert.equal(service.listProposals().length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("晋升：失败重置 streak（成功-失败-成功 不产生提案）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    service.recordCase({ capability: "docx-to-markdown", outcome: "failure", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    const third = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-3", occurredAt: "2026-11-01T00:00:03.000Z" });
    assert.equal(third.proposal, null);
    assert.equal(service.listProposals().length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("晋升：已有同组合提案时去重（继续成功不重复提案）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    const third = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-3", occurredAt: "2026-11-01T00:00:03.000Z" });
    assert.equal(third.proposal, null);
    assert.equal(service.listProposals().length, 1);
    assert.equal(ledger.scan({ eventType: "skill.proposed" }).length, 1);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("晋升：阈值可配置（threshold=3：2 次不产生，3 次产生）", () => {
  const { service, capabilities, ledger, dir } = makeService({ promotionThreshold: 3 });
  try {
    registerCapability(capabilities, "pdf-extract");
    for (const [i, outcome] of ["success", "success", "success"].entries()) {
      const r = service.recordCase({ capability: "pdf-extract", outcome: outcome as "success", sourceEventId: `evt-${i}`, occurredAt: `2026-11-01T00:00:0${i + 1}.000Z` });
      if (i < 2) assert.equal(r.proposal, null);
      else assert.notEqual(r.proposal, null);
    }
    assert.equal(ledger.scan({ eventType: "skill.proposed" }).length, 1);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

// --- 3. 手动提案 + 悬空引用校验 + Owner 决策 -----------------------------------

test("propose：悬空引用（未注册能力）拒绝 409 skill_dangling_reference，不落行", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    assert.throws(
      () =>
        service.propose({
          name: "compose-docx-pdf",
          description: "组合能力",
          steps: [
            { capability_id: "docx-to-markdown", arg_mapping: {} },
            { capability_id: "pdf-render", arg_mapping: {} }, // 未注册
          ],
        }),
      (err: unknown) => err instanceof SkillError && err.code === "dangling_reference" && err.missingCapabilities?.includes("pdf-render") === true,
    );
    assert.equal(service.listProposals().length, 0);
    assert.equal(ledger.scan({ eventType: "skill.proposed" }).length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("propose：停用能力引用同样拒绝（悬空 = 未注册 ∪ 停用）", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    capabilities.disable("docx-to-markdown");
    assert.throws(
      () => service.propose({ name: "s1", steps: [{ capability_id: "docx-to-markdown", arg_mapping: {} }] }),
      (err: unknown) => err instanceof SkillError && err.code === "dangling_reference" && err.missingCapabilities?.includes("docx-to-markdown") === true,
    );
    assert.equal(ledger.scan({ eventType: "skill.proposed" }).length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("propose：合法多步组合创建提案（origin=manual，actor owner 审计）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    registerCapability(capabilities, "markdown-to-html");
    const proposal = service.propose({
      name: "docx-to-html",
      description: "docx 转 html",
      steps: [
        { capability_id: "docx-to-markdown", arg_mapping: { input: "{{input}}" } },
        { capability_id: "markdown-to-html", arg_mapping: { markdown: "{{result}}" } },
      ],
    });
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.origin, "manual");
    assert.deepEqual(proposal.capabilities, ["docx-to-markdown", "markdown-to-html"]);
    const events = ledger.scan({ eventType: "skill.proposed" });
    assert.equal(events.length, 1);
    assert.equal(events[0].envelope.actor_id, "owner");
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("propose：steps 形态非法（空数组/缺 capability_id/映射值非字符串）→ invalid_input", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    assert.throws(() => service.propose({ name: "s1", steps: [] }), (err: unknown) => err instanceof SkillError && err.code === "invalid_input");
    assert.throws(
      () => service.propose({ name: "s2", steps: [{ capability_id: "", arg_mapping: {} }] }),
      (err: unknown) => err instanceof SkillError && err.code === "invalid_input",
    );
    assert.throws(
      () => service.propose({ name: "s3", steps: [{ capability_id: "docx-to-markdown", arg_mapping: { a: 1 as never } }] }),
      (err: unknown) => err instanceof SkillError && err.code === "invalid_input",
    );
    assert.equal(service.listProposals().length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("propose：同名冲突 409", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.propose({ name: "dup", steps: [{ capability_id: "docx-to-markdown", arg_mapping: {} }] });
    assert.throws(
      () => service.propose({ name: "dup", steps: [{ capability_id: "docx-to-markdown", arg_mapping: {} }] }),
      (err: unknown) => err instanceof SkillError && err.code === "conflict",
    );
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("decide approve：提案 → approved（skill.approved 事件 + listSkills 出现且可调用）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    const approved = service.decide((proposal as SkillRecord).skill_id, "approve");
    assert.equal(approved.status, "approved");

    const events = ledger.scan({ eventType: "skill.approved" });
    assert.equal(events.length, 1);
    assert.equal(events[0].envelope.actor_id, "owner");

    // 注册为可调用 Skill：listSkills 只含 approved
    const skills = service.listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].skill_id, approved.skill_id);
    assert.equal(skills[0].status, "approved");
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("decide approve：批准时引用已停用 → 提案转 rejected（missing_capabilities 留痕）+ 409 口径", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    capabilities.disable("docx-to-markdown"); // 提案与批准之间被停用

    assert.throws(
      () => service.decide((proposal as SkillRecord).skill_id, "approve"),
      (err: unknown) => err instanceof SkillError && err.code === "dangling_reference" && err.missingCapabilities?.includes("docx-to-markdown") === true,
    );
    // 提案被拒留痕（T6 悬空引用呈现的数据源）
    const after = service.listProposals()[0];
    assert.equal(after.status, "rejected");
    assert.deepEqual(after.source.missing_capabilities, ["docx-to-markdown"]);
    assert.equal(ledger.scan({ eventType: "skill.rejected" }).length, 1);
    assert.equal(service.listSkills().length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("decide reject：Owner 显式拒绝（reason 留痕 + skill.rejected 事件）", () => {
  const { service, capabilities, ledger, dir } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    const rejected = service.decide((proposal as SkillRecord).skill_id, "reject", { reason: "组合粒度不对" });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.source.reason, "组合粒度不对");
    const events = ledger.scan({ eventType: "skill.rejected" });
    assert.equal(events.length, 1);
    assert.equal((events[0].envelope.payload as Record<string, unknown>).reason, "组合粒度不对");
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("decide：未知 id 404 not_found；已决策提案再决策 409 invalid_state", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    service.decide((proposal as SkillRecord).skill_id, "approve");

    assert.throws(() => service.decide("01936b9d-0000-7abc-9f2e-000000000000", "approve"), (err: unknown) => err instanceof SkillError && err.code === "not_found");
    assert.throws(
      () => service.decide((proposal as SkillRecord).skill_id, "reject"),
      (err: unknown) => err instanceof SkillError && err.code === "invalid_state",
    );
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("晋升：被拒提案后再次达标 → 新提案（名称后缀避让）", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    service.decide((proposal as SkillRecord).skill_id, "reject", { reason: "暂不需要" });

    const again = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-3", occurredAt: "2026-11-01T00:00:03.000Z" });
    assert.notEqual(again.proposal, null);
    assert.equal((again.proposal as SkillRecord).name, "docx-to-markdown-2");
    assert.equal(ledger.scan({ eventType: "skill.proposed" }).length, 2);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

// --- 4. invoke 重用路径（模板填充 + 逐步调用经 invoker 接缝）--------------------

test("invoke：参数模板填充 + 逐步调用（顺序与映射正确，{{result}} 引用上步结果）", async () => {
  const { service, capabilities, dir, ledger, calls } = makeService({
    invokerBehavior: ({ input }) => ({ ok: true, result: { out: input } }),
  });
  try {
    registerCapability(capabilities, "cap-a");
    registerCapability(capabilities, "cap-b");
    const proposal = service.propose({
      name: "chain",
      steps: [
        { capability_id: "cap-a", arg_mapping: { input: "{{text}}" } },
        { capability_id: "cap-b", arg_mapping: { raw: "{{result}}" } },
      ],
    });
    const approved = service.decide(proposal.skill_id, "approve");

    const result = await service.invoke(approved.skill_id, { text: "hi" });
    assert.equal(result.ok, true);
    assert.equal(result.failed_step, null);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, "cap-a");
    assert.deepEqual(calls[0].input, { input: "hi" });
    assert.equal(calls[1].name, "cap-b");
    // {{result}} = 上一步的 result（模板变量先解析调用参数，再解析前步结果）
    assert.deepEqual(calls[1].input, { raw: { out: { input: "hi" } } });
    // 步骤投影
    assert.equal(result.steps[0].capability_id, "cap-a");
    assert.deepEqual(result.steps[0].args, { input: "hi" });
    assert.equal(result.steps[0].ok, true);
    assert.deepEqual(result.steps[0].result, { out: { input: "hi" } });
    // 调用上下文 actor（审计口径）
    assert.equal(calls[0].context?.actorId, "agent:skill");
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("invoke：空 arg_mapping = 参数整体透传（自动提案的重用路径）", async () => {
  const { service, capabilities, dir, ledger, calls } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    service.decide((proposal as SkillRecord).skill_id, "approve");

    const result = await service.invoke((proposal as SkillRecord).skill_id, { input_path: "a.docx" });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].input, { input_path: "a.docx" });
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("invoke：缺模板参数 → missing_params（列出缺失变量名，不发调用）", async () => {
  const { service, capabilities, dir, ledger, calls } = makeService();
  try {
    registerCapability(capabilities, "cap-a");
    const proposal = service.propose({ name: "needs-param", steps: [{ capability_id: "cap-a", arg_mapping: { input: "{{input_path}}", mode: "{{mode}}" } }] });
    service.decide(proposal.skill_id, "approve");
    await assert.rejects(
      () => service.invoke(proposal.skill_id, { input_path: "a.docx" }),
      (err: unknown) => err instanceof SkillError && err.code === "missing_params" && err.message.includes("mode"),
    );
    assert.equal(calls.length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("invoke：proposed（未批准）拒绝 not_approved；未知 skill → not_found", async () => {
  const { service, capabilities, dir, ledger, calls } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    await assert.rejects(
      () => service.invoke((proposal as SkillRecord).skill_id, {}),
      (err: unknown) => err instanceof SkillError && err.code === "not_approved",
    );
    await assert.rejects(
      () => service.invoke("01936b9d-0000-7abc-9f2e-000000000000", {}),
      (err: unknown) => err instanceof SkillError && err.code === "not_found",
    );
    assert.equal(calls.length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("invoke：步骤失败即停（failed_step 记录、后续步骤不调用、ok=false）", async () => {
  const { service, capabilities, dir, ledger, calls } = makeService({
    invokerBehavior: ({ name }) =>
      name === "cap-b" ? { ok: false, error_code: "tool_failed", error: "boom" } : { ok: true, result: { step: 1 } },
  });
  try {
    registerCapability(capabilities, "cap-a");
    registerCapability(capabilities, "cap-b");
    registerCapability(capabilities, "cap-c");
    const proposal = service.propose({
      name: "chain-fail",
      steps: [
        { capability_id: "cap-a", arg_mapping: {} },
        { capability_id: "cap-b", arg_mapping: {} },
        { capability_id: "cap-c", arg_mapping: {} },
      ],
    });
    const approved = service.decide(proposal.skill_id, "approve");
    const result = await service.invoke(approved.skill_id, { x: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.failed_step, 1);
    assert.equal(calls.length, 2); // cap-c 不被调用
    assert.equal(result.steps[1].ok, false);
    assert.equal(result.steps[1].error_code, "tool_failed");
    assert.equal(result.steps[1].error, "boom");
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("invoke：invoker 抛异常（unknown_tool 等）按步骤失败处理，不炸服务", async () => {
  const { service, capabilities, dir, ledger } = makeService();
  const calls: FakeCall[] = [];
  const throwing = {
    async invoke(name: string, input: unknown, context?: { actorId?: string }) {
      calls.push({ name, input, context });
      throw new Error('unknown capability "cap-x" (not registered)');
    },
  };
  void calls;
  try {
    registerCapability(capabilities, "cap-a");
    const serviceWithThrowing = new SkillService({
      dataDir: dir,
      ledger,
      replicaId: REPLICA_A,
      capabilities,
      invoker: throwing,
    });
    // 同库两个 service 实例共享表——用原 service 建，另一个调
    const proposal = service.propose({ name: "throws", steps: [{ capability_id: "cap-a", arg_mapping: {} }] });
    serviceWithThrowing.decide(proposal.skill_id, "approve");
    const result = await serviceWithThrowing.invoke(proposal.skill_id, {});
    assert.equal(result.ok, false);
    assert.equal(result.failed_step, 0);
    assert.equal(result.steps[0].ok, false);
    assert.match(String(result.steps[0].error), /unknown capability/);
    serviceWithThrowing.close();
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

// --- 5. 检索复用（FR-CAP-1：缺能力请求命中已有 Skill → 重用路径而非新建）---------

test("match：名称全分词命中已批准 Skill → reused=true（含 score）", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    service.decide((proposal as SkillRecord).skill_id, "approve");

    const match = service.matchSkills("please convert my docx to markdown");
    assert.equal(match.reused, true);
    assert.equal(match.skills.length, 1);
    assert.equal(match.skills[0].name, "docx-to-markdown");
    assert.equal(match.skills[0].score, 1);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("match：仅返回已批准 Skill（proposed 提案不算可重用）", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    // 提案存在但未批准
    const match = service.matchSkills("convert docx to markdown");
    assert.equal(match.reused, false);
    assert.equal(match.skills.length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("match：无命中 → reused=false", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "docx-to-markdown");
    service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-1", occurredAt: "2026-11-01T00:00:01.000Z" });
    const { proposal } = service.recordCase({ capability: "docx-to-markdown", outcome: "success", sourceEventId: "evt-2", occurredAt: "2026-11-01T00:00:02.000Z" });
    service.decide((proposal as SkillRecord).skill_id, "approve");

    const match = service.matchSkills("render pdf charts");
    assert.equal(match.reused, false);
    assert.equal(match.skills.length, 0);
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});

test("match：描述词元 Jaccard 命中（能力名不含请求词时仍可复用）", () => {
  const { service, capabilities, dir, ledger } = makeService();
  try {
    registerCapability(capabilities, "table-extractor");
    registerCapability(capabilities, "csv-writer");
    const proposal = service.propose({
      name: "pdf-tables-to-csv",
      description: "extract tables from pdf documents and write csv rows",
      steps: [{ capability_id: "table-extractor", arg_mapping: {} }],
    });
    service.decide(proposal.skill_id, "approve");

    const match = service.matchSkills("extract tables from pdf documents");
    assert.equal(match.reused, true);
    assert.equal(match.skills[0].name, "pdf-tables-to-csv");
  } finally {
    service.close();
    capabilities.close();
    ledger.close();
    removeDir(dir);
  }
});
