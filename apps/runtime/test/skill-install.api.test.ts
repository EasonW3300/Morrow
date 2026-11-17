// 智能安装四道门（票 M7-B-T4 / Issue #72，FR-B9/B12）。
//
// 接缝：HTTP 主接缝 + 脚本化提案生成器（零 LLM）+ 假抓取（零网络）。
// 锁定的验收项：
//   - 三种来源都能产提案；公网 URL 默认拒绝并说明如何开启
//   - 提案含权限清单与示例调用
//   - **未确认时无任何注册/代码落地**（这条是整张票的核心）
//   - 需要新工具 → 交工厂（不是直接注册能力）
//   - 坏文档给可读失败，且不留半成品提案
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import type { ProposalGenerator } from "../src/skills-package/proposal.ts";
import type { DocFetchResult } from "../src/skills-package/doc-fetch.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

/** 脚本化生成器：返回固定提案（可按需改），零网络 */
function scriptedGenerator(
  overrides: Partial<Awaited<ReturnType<ProposalGenerator["generate"]>>> = {},
): ProposalGenerator {
  return {
    async generate() {
      return {
        name: "pdf-summariser",
        title: "PDF 摘要",
        description: "读取 PDF 并生成摘要",
        capabilities: [{ capability: "memory.write", purpose: "把摘要存进记忆", example_args: { content: "..." } }],
        new_tools: [],
        permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
        examples: [{ request: "总结 report.pdf", expected: "返回三段摘要" }],
        uncertainties: [],
        ...overrides,
      };
    },
  };
}

interface Harness {
  handle: RuntimeHandle;
  port: number;
  close(): Promise<void>;
}

async function startProposalRuntime(options: {
  generator?: ProposalGenerator;
  allowPublicDocFetch?: boolean;
  fetch?: (url: string) => Promise<DocFetchResult>;
} = {}): Promise<Harness> {
  const dir = tmpDir("morrow-proposal-");
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    proposalGenerator: options.generator ?? scriptedGenerator(),
    ...(options.allowPublicDocFetch === true ? { allowPublicDocFetch: true } : {}),
    ...(options.fetch === undefined ? {} : { skillInstallFetch: options.fetch }),
  });
  return {
    handle,
    port: handle.port,
    async close() {
      await handle.close();
      removeDir(dir);
    },
  };
}

function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const DOC = "这是一份关于 PDF 处理的文档，说明了如何读取 PDF、提取文本并生成摘要。需要写入记忆能力。";

// --- 三种来源 -----------------------------------------------------------------------

test("paste 来源：产提案，含权限清单与示例调用", async () => {
  const h = await startProposalRuntime();
  try {
    const res = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    assert.equal(res.status, 201);
    const body = await json<{
      proposal: {
        proposal_id: string;
        status: string;
        permissions: Record<string, string[]>;
        examples: Array<{ request: string; expected: string }>;
        capabilities: Array<{ capability: string }>;
        uncertainties: string[];
      };
      materialized: boolean;
    }>(res);
    assert.equal(body.materialized, false, "提案阶段不得落地");
    assert.equal(body.proposal.status, "pending");
    assert.ok(body.proposal.examples.length > 0, "必须带示例调用");
    assert.ok(typeof body.proposal.permissions.filesystem !== "undefined");
    assert.deepEqual(body.proposal.capabilities.map((ref) => ref.capability), ["memory.write"]);
  } finally {
    await h.close();
  }
});

test("upload 来源：用文件名作为 source_ref", async () => {
  const h = await startProposalRuntime();
  try {
    const res = await post(h.port, "/v1/skill-install/propose", {
      source_kind: "upload",
      text: DOC,
      file_name: "pdf-guide.md",
    });
    assert.equal(res.status, 201);
    const body = await json<{ proposal: { source_kind: string; source_ref: string } }>(res);
    assert.equal(body.proposal.source_kind, "upload");
    assert.equal(body.proposal.source_ref, "pdf-guide.md");
  } finally {
    await h.close();
  }
});

test("url 来源：抓取成功后产提案（抓取审计可查）", async () => {
  const h = await startProposalRuntime({
    // 注入假抓取：真实 DNS 在测试环境不可靠，且这里要测的是"抓取→提案"的编排
    fetch: async (url) => ({
      ok: true,
      url,
      host: "docs.example.com",
      addresses: ["1.1.1.1"],
      content_type: "text/markdown",
      bytes: DOC.length,
      text: DOC,
      duration_ms: 5,
    }),
  });
  try {
    const res = await post(h.port, "/v1/skill-install/propose", {
      source_kind: "url",
      url: "https://docs.example.com/guide.md",
    });
    assert.equal(res.status, 201, await res.clone().text());
    const body = await json<{ doc_fetch: { ok: boolean; host: string; bytes: number } | null }>(res);
    assert.equal(body.doc_fetch?.ok, true);
    assert.equal(body.doc_fetch?.host, "docs.example.com");

    const events = await json<{ events: Array<{ event_type: string; payload: Record<string, unknown> }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=100`),
    );
    const fetched = events.events.find((event) => event.event_type === "skill.doc_fetch");
    assert.ok(fetched !== undefined, "每次抓取必须有审计");
    assert.equal(fetched.payload.host, "docs.example.com");
    assert.equal(fetched.payload.ok, true);
  } finally {
    await h.close();
  }
});

test("url 来源：公网默认拒绝，错误可读且不产提案", async () => {
  // 不注入 fetch：走真实 fetchDocument，example.com 解析后是公网 → public_not_allowed
  const h = await startProposalRuntime();
  try {
    const res = await post(h.port, "/v1/skill-install/propose", {
      source_kind: "url",
      url: "https://example.com/doc.md",
    });
    assert.equal(res.status, 422);
    const body = await json<{ error: { code: string; message: string } }>(res);
    assert.equal(body.error.code, "bad_document");
    assert.match(body.error.message, /public|公网|allow public/i);

    // 不产半成品提案
    const list = await json<{ proposals: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals`));
    assert.equal(list.proposals.length, 0);

    // 抓取失败仍有审计
    const events = await json<{ events: Array<{ event_type: string; payload: Record<string, unknown> }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=100`),
    );
    const fetched = events.events.find((event) => event.event_type === "skill.doc_fetch");
    assert.ok(fetched !== undefined);
    assert.equal(fetched.payload.ok, false);
  } finally {
    await h.close();
  }
});

test("GET config：暴露公网开关与阻断网段（UI 可展示）", async () => {
  const h = await startProposalRuntime();
  try {
    const body = await json<{
      https_only: boolean;
      allow_public_network: boolean;
      blocked_ranges: string[];
      proposes_only: boolean;
    }>(await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/config`));
    assert.equal(body.https_only, true);
    assert.equal(body.allow_public_network, false, "公网默认关闭");
    assert.ok(body.blocked_ranges.some((range) => range.includes("169.254.169.254")));
    assert.equal(body.proposes_only, true);
  } finally {
    await h.close();
  }
});

// --- 四道门 -------------------------------------------------------------------------

test("未确认时无任何落地：提案 pending，无 skill、无 factory request", async () => {
  const h = await startProposalRuntime();
  try {
    const created = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    assert.equal(created.status, 201);
    const { proposal } = await json<{ proposal: { proposal_id: string; status: string } }>(created);
    assert.equal(proposal.status, "pending");

    // 没有 skill 被创建
    const skills = await json<{ skills: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/capabilities/skills`));
    assert.equal(skills.skills.length, 0, "未确认不得创建 skill");

    // 也没有 factory request
    const events = await json<{ events: Array<{ event_type: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=200`),
    );
    const types = events.events.map((event) => event.event_type);
    assert.equal(types.includes("skill.proposal_materialized"), false);
    assert.equal(types.includes("factory.requested"), false);
  } finally {
    await h.close();
  }
});

test("确认纯组合提案 → 创建声明式 skill（不含代码）", async () => {
  const h = await startProposalRuntime();
  try {
    const created = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    const { proposal } = await json<{ proposal: { proposal_id: string } }>(created);
    const res = await post(h.port, `/v1/skill-install/proposals/${proposal.proposal_id}/confirm`);
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json<{
      proposal: { status: string; materialized_as: { kind: string; id: string } | null };
      materialized: boolean;
    }>(res);
    assert.equal(body.materialized, true);
    assert.equal(body.proposal.status, "materialized");
    assert.equal(body.proposal.materialized_as?.kind, "skill");

    // 落地建的是 **proposed** skill：`skills` 列表只列 approved，所以这里查 proposals。
    // 这层区分是刻意的——提案落地不等于"可调用"，Owner 还要走 skill 批准这一道。
    const proposalsRes = await fetch(`http://127.0.0.1:${h.port}/v1/capabilities/skills/proposals`);
    const list = await json<{ proposals: Array<{ name: string; steps: Array<{ capability_id: string }>; status: string }> }>(
      proposalsRes,
    );
    const skill = list.proposals.find((item) => item.name === "pdf-summariser");
    assert.ok(
      skill !== undefined,
      `未找到 skill 提案；实际: ${JSON.stringify(list.proposals.map((item) => item.name))}`,
    );
    assert.equal(skill.status, "pending", "落地后仍是待批准（API 把 proposed 投影为 pending；需 Owner 批准才可调用）");
    assert.equal(skill.steps[0].capability_id, "memory.write", "声明式组合只引用能力，不含代码");
  } finally {
    await h.close();
  }
});

test("确认需要新工具的提案 → 交 Tool Factory（不直接注册能力）", async () => {
  const h = await startProposalRuntime({
    generator: scriptedGenerator({
      new_tools: [
        {
          suggested_name: "pdf.extract_text",
          description: "从 PDF 提取文本",
          permissions: { filesystem: [] },
          rationale: "现有能力不能读 PDF",
        },
      ],
    }),
  });
  try {
    const created = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    const { proposal } = await json<{ proposal: { proposal_id: string } }>(created);
    const res = await post(h.port, `/v1/skill-install/proposals/${proposal.proposal_id}/confirm`);
    assert.equal(res.status, 200, await res.clone().text());
    const body = await json<{ proposal: { materialized_as: { kind: string; id: string } } }>(res);
    assert.equal(body.proposal.materialized_as.kind, "factory_request", "新工具必须走工厂");

    // 该能力**没有**被直接注册
    const caps = await json<{ capabilities: Array<{ name: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/capabilities`),
    );
    assert.equal(
      caps.capabilities.some((capability) => capability.name === "pdf.extract_text"),
      false,
      "提案不产码：能力必须经工厂验证后才注册",
    );
  } finally {
    await h.close();
  }
});

test("重复确认 → 409（不重复落地）", async () => {
  const h = await startProposalRuntime();
  try {
    const created = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    const { proposal } = await json<{ proposal: { proposal_id: string } }>(created);
    await post(h.port, `/v1/skill-install/proposals/${proposal.proposal_id}/confirm`);
    const again = await post(h.port, `/v1/skill-install/proposals/${proposal.proposal_id}/confirm`);
    assert.equal(again.status, 409);
  } finally {
    await h.close();
  }
});

test("拒绝提案 → rejected，且不产生任何产物", async () => {
  const h = await startProposalRuntime();
  try {
    const created = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    const { proposal } = await json<{ proposal: { proposal_id: string } }>(created);
    const res = await post(h.port, `/v1/skill-install/proposals/${proposal.proposal_id}/reject`, {
      reason: "不需要这个技能",
    });
    assert.equal(res.status, 200);
    const body = await json<{ proposal: { status: string; error: string | null } }>(res);
    assert.equal(body.proposal.status, "rejected");
    assert.equal(body.proposal.error, "不需要这个技能");

    const skills = await json<{ skills: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/capabilities/skills`));
    assert.equal(skills.skills.length, 0);
  } finally {
    await h.close();
  }
});

// --- 提案校验：编造的能力名要被挡 ------------------------------------------------

test("LLM 引用不存在的能力 → 400 invalid_proposal（不静默接受）", async () => {
  const h = await startProposalRuntime({
    generator: scriptedGenerator({
      capabilities: [{ capability: "totally.made.up", purpose: "编的" }],
    }),
  });
  try {
    const res = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    assert.equal(res.status, 400);
    const body = await json<{ error: { code: string; message: string } }>(res);
    assert.equal(body.error.code, "invalid_proposal");
    assert.match(body.error.message, /totally\.made\.up/);
    assert.match(body.error.message, /new_tools/);

    const list = await json<{ proposals: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals`));
    assert.equal(list.proposals.length, 0, "无效提案不该留行");
  } finally {
    await h.close();
  }
});

test("提案无示例调用 → 拒绝（Owner 无法判断这是不是他要的）", async () => {
  const h = await startProposalRuntime({ generator: scriptedGenerator({ examples: [] }) });
  try {
    const res = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    assert.equal(res.status, 400);
    const body = await json<{ error: { message: string } }>(res);
    assert.match(body.error.message, /example/);
  } finally {
    await h.close();
  }
});

test("提案权限超出授权面 → 提案仍生成，但 uncertainties 里如实标注", async () => {
  const h = await startProposalRuntime({
    generator: scriptedGenerator({
      permissions: { filesystem: ["/etc/**"], network: ["example.com:443"], shell: [], channels: [], credentials: [] },
    }),
  });
  try {
    const res = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    assert.equal(res.status, 201);
    const body = await json<{ proposal: { uncertainties: string[] } }>(res);
    assert.ok(
      body.proposal.uncertainties.some((item) => item.includes("超出当前授权面")),
      "超权必须在确认前让 Owner 看见",
    );
  } finally {
    await h.close();
  }
});

// --- 坏输入 -------------------------------------------------------------------------

test("坏文档：过短 → 422 可读失败，不留半成品提案", async () => {
  const h = await startProposalRuntime();
  try {
    const res = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: "装" });
    assert.equal(res.status, 422);
    const body = await json<{ error: { code: string; message: string } }>(res);
    assert.equal(body.error.code, "bad_document");
    assert.match(body.error.message, /过短/);
    const list = await json<{ proposals: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals`));
    assert.equal(list.proposals.length, 0);
  } finally {
    await h.close();
  }
});

test("坏输入：缺 url / 缺 text / 非法 source_kind 各有 400", async () => {
  const h = await startProposalRuntime();
  try {
    const cases: Array<[unknown, string]> = [
      [{ source_kind: "url" }, "requires a"],
      [{ source_kind: "paste" }, "requires non-empty"],
      [{ source_kind: "upload" }, "requires non-empty"],
      [{ source_kind: "weird", text: DOC }, "source_kind must be"],
      [{ text: DOC }, "source_kind must be"],
    ];
    for (const [body, pattern] of cases) {
      const res = await post(h.port, "/v1/skill-install/propose", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const error = await json<{ error: { message: string } }>(res);
      assert.match(error.error.message, new RegExp(pattern));
    }
  } finally {
    await h.close();
  }
});

test("生成器抛错 → 502 类可读失败（不崩、不留提案行）", async () => {
  const h = await startProposalRuntime({
    generator: {
      async generate() {
        throw new Error("provider returned 500");
      },
    },
  });
  try {
    const res = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    assert.equal(res.status, 400);
    const body = await json<{ error: { code: string; message: string } }>(res);
    assert.equal(body.error.code, "generation_failed");
    assert.match(body.error.message, /provider returned 500/);
    const list = await json<{ proposals: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals`));
    assert.equal(list.proposals.length, 0);
  } finally {
    await h.close();
  }
});

// --- 列表与详情 ---------------------------------------------------------------------

test("列表可按 status 过滤；详情含完整提案", async () => {
  const h = await startProposalRuntime();
  try {
    const created = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    const { proposal } = await json<{ proposal: { proposal_id: string } }>(created);
    await post(h.port, `/v1/skill-install/proposals/${proposal.proposal_id}/reject`, {});

    const pending = await json<{ proposals: unknown[] }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals?status=pending`),
    );
    assert.equal(pending.proposals.length, 0);
    const rejected = await json<{ proposals: unknown[] }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals?status=rejected`),
    );
    assert.equal(rejected.proposals.length, 1);

    const detail = await json<{ proposal: { proposal_id: string; permissions: unknown; examples: unknown[] } }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals/${proposal.proposal_id}`),
    );
    assert.equal(detail.proposal.proposal_id, proposal.proposal_id);
    assert.ok(detail.proposal.examples.length > 0);
  } finally {
    await h.close();
  }
});

test("详情 404 与 status 过滤非法值 400", async () => {
  const h = await startProposalRuntime();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals/missing`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/v1/skill-install/proposals?status=weird`)).status, 400);
  } finally {
    await h.close();
  }
});

// --- 审计 ---------------------------------------------------------------------------

test("审计：created / confirmed / materialized 依次可查", async () => {
  const h = await startProposalRuntime();
  try {
    const created = await post(h.port, "/v1/skill-install/propose", { source_kind: "paste", text: DOC });
    const { proposal } = await json<{ proposal: { proposal_id: string } }>(created);
    await post(h.port, `/v1/skill-install/proposals/${proposal.proposal_id}/confirm`);

    const events = await json<{ events: Array<{ event_type: string; payload: Record<string, unknown> }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=200`),
    );
    const types = events.events.map((event) => event.event_type);
    for (const expected of ["skill.proposal_created", "skill.proposal_confirmed", "skill.proposal_materialized"]) {
      assert.ok(types.includes(expected), `缺少审计事件 ${expected}`);
    }
    const materialized = events.events.find((event) => event.event_type === "skill.proposal_materialized");
    assert.equal(materialized?.payload.kind, "skill");
  } finally {
    await h.close();
  }
});
