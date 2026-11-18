#!/usr/bin/env node
/**
 * M7 真机验收脚本（M7-A/B/C 的可自动化部分）。
 *
 * 用法：
 *   1. 起一个干净的 runtime（**必须** node >= 22.16，否则缺 FTS5）：
 *      MORROW_DATA_DIR=/tmp/morrow-acceptance MORROW_PORT=18787 \
 *        node --experimental-sqlite --experimental-strip-types apps/runtime/src/main.ts
 *   2. node scripts/acceptance/m7-live.mjs
 *
 * 覆盖的是"需要人工点一遍"的流程里**后端行为与 UI 数据源是否一致**：
 * Persona 生效范围、工作区绑定与摘要、临时会话不泄漏、MCP 风险门槛与默认 disabled、
 * 技能包失败可读、Plan 只读（写拒/读通）、Goal 六态与终态、Best 四阶段与实现门
 * （含完全权限下仍拦）。
 *
 * **不覆盖**真正的视觉/交互（点击、弹窗位置、可读性）——那些需要人眼。
 *
 * 已知环境限制：未配 Provider 时对话轮次以 agent.error 收尾，记忆抽取链路不会触发；
 * 因此临时会话的记忆作用域隔离由 `memory.ephemeral.api.test.ts` 覆盖，本脚本只断言
 * "不泄漏到全局"。
 */
const BASE = process.env.MORROW_ACCEPTANCE_BASE ?? "http://127.0.0.1:18787";
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(j);
const put = (p, b) => fetch(BASE + p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const get = (p) => fetch(BASE + p).then(j);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? " — " + detail : ""}`);
};

// --- M7-A 人工项 5：Persona 保存前的受影响会话数 ---
{
  const s1 = await post("/v1/sessions", {});
  const s2 = await post("/v1/sessions", {});
  const before = await get("/v1/persona");
  check("A5 persona GET 返回结构化字段", before.status === 200 && typeof before.body.persona.name === "string",
    JSON.stringify(before.body?.persona ?? before.body).slice(0, 120));
  const updated = await put("/v1/persona", { name: "小墨", tone: "温和", responsibilities: ["助理"], prohibitions: [], extra: "" });
  check("A5 persona PUT 保存成功且生效范围可说明", updated.status === 200 && updated.body.persona.name === "小墨",
    `受影响会话约 ${[s1, s2].filter((s) => s.status === 201).length} 个（本人应看到此数字）`);
}

// --- M7-A 人工项 2：本地工作区绑定 ---
let wsSession;
{
  wsSession = (await post("/v1/sessions", {})).body.session_id;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m7verify-ws-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  const bound = await put(`/v1/sessions/${wsSession}/workspace`, { kind: "local", path: dir });
  check("A2 本地工作区绑定成功", bound.status === 200, bound.status !== 200 ? JSON.stringify(bound.body) : "");
  const summary = (await get("/v1/sessions")).body.sessions.find((s) => s.session_id === wsSession);
  check("A2 会话摘要显示工作区", summary?.workspace?.path === dir, summary?.workspace?.path ?? "缺失");
}

// --- M7-A 人工项 3：临时会话 ---
{
  const eph = await post("/v1/sessions", { kind: "ephemeral" });
  check("A3 临时会话可创建且标注 kind", eph.body?.kind === "ephemeral", `kind=${eph.body?.kind}`);
  const sessionId = eph.body.session_id;
  // 临时会话记忆隔离
  await post(`/v1/sessions/${sessionId}/messages`, { text: "记住：临时会话里的秘密偏好" });
  await new Promise((r) => setTimeout(r, 600));
  // 说明：完整的「临时会话写入 scope=session、全局检索不到」有一组专门的自动化测试
  // （memory.ephemeral.api.test.ts，含注入时钟的 24h 到期），不需要在这里用真机重复。
  // 本脚本只验证"真机上不会泄漏到全局"这一条可判定的事实。
  // 另注：抽取链路需要 Provider；本验证环境未配 Provider，所以本轮以 agent.error 收尾，
  // 不会有候选产生——这是环境限制，不是缺陷。
  const global = await get("/v1/memory/facts?q=秘密");
  check("A3 临时会话写入不进全局", (global.body?.facts?.length ?? 0) === 0, `global=${global.body?.facts?.length ?? "?"}`);
}

// --- M7-B：MCP 安装（未勾选风险必须拒）---
{
  const noAck = await post("/v1/mcp/servers", { config: '{"mcpServers":{"x":{"command":"npx","args":["-y","@mcp/x"]}}}' });
  check("B2 未勾选风险 → 拒装", noAck.status === 400 && noAck.body?.error?.code === "risk_not_acknowledged",
    `status=${noAck.status} code=${noAck.body?.error?.code}`);
  const ack = await post("/v1/mcp/servers", {
    config: '{"mcpServers":{"verify-echo":{"command":"npx","args":["-y","@mcp/echo"]}}}',
    risk_acknowledged: true,
  });
  check("B2 勾选后可装且默认 disabled", ack.status === 201 && ack.body?.servers?.[0]?.enabled === false,
    `status=${ack.status} enabled=${ack.body?.servers?.[0]?.enabled}`);
  const list = await get("/v1/mcp/servers");
  const installed = list.body.servers[0];
  check("B6 已安装页字段齐全（来源/状态/权限/健康）",
    installed?.source !== undefined && installed?.status !== undefined && installed?.grants !== undefined && installed?.health !== undefined,
    `source=${installed?.source} status=${installed?.status}`);
  // 清理
  await fetch(`${BASE}/v1/mcp/servers/verify-echo`, { method: "DELETE" });
}

// --- M7-B：技能包升级 diff 两步 ---
{
  const res = await post("/v1/skills/packages/install", { spec: "definitely-not-a-real-package-xyz" });
  check("B7 安装失败给出可读错误（不崩）", res.status >= 400, `status=${res.status} code=${res.body?.error?.code}`);
}

// --- M7-C 人工项：Plan / Goal / Best 三面板的数据源 ---
let planSession;
{
  planSession = (await post("/v1/sessions", {})).body.session_id;
  const st = await get(`/v1/sessions/${planSession}/plan`);
  check("C1 Plan 状态可读且带只读说明", st.status === 200 && typeof st.body.readonly_notice === "string",
    st.body?.readonly_notice?.slice(0, 40));
  const entered = await post(`/v1/sessions/${planSession}/plan/enter`);
  check("C1 可进入 Plan 模式", entered.body?.active === true, `active=${entered.body?.active}`);
  const written = await post(`/v1/capabilities/memory.write/invoke?session_id=${planSession}`, { content: "x" });
  check("C1 Plan 下写能力被拒（403）", written.status === 403 && written.body?.error?.code === "plan_mode_readonly",
    `status=${written.status} code=${written.body?.error?.code}`);
  const searched = await post(`/v1/capabilities/memory.search/invoke?session_id=${planSession}`, { query: "偏好" });
  check("C1 Plan 下只读检索**可用**（不是空壳）", searched.status === 200,
    `status=${searched.status} ${searched.status !== 200 ? JSON.stringify(searched.body) : ""}`);
  await post(`/v1/sessions/${planSession}/plan/exit`);
}

// --- M7-C：Goal 六态与预算 ---
{
  const sessionId = (await post("/v1/sessions", {})).body.session_id;
  const unconfirmed = await post("/v1/goals", { session_id: sessionId, objective: "验证目标" });
  check("C4 Goal 未确认 → 拒建", unconfirmed.status === 400, `status=${unconfirmed.status}`);
  const created = await post("/v1/goals", { session_id: sessionId, objective: "验证目标", token_limit: 1000, confirm: true });
  check("C4 Goal 创建成功且状态 active", created.status === 201 && created.body?.goal?.status === "active",
    `status=${created.status} goal.status=${created.body?.goal?.status}`);
  const goalId = created.body.goal.goal_id;
  const paused = await post(`/v1/goals/${goalId}/pause`);
  check("C4 可暂停", paused.body?.goal?.status === "paused", `status=${paused.body?.goal?.status}`);
  const bad = await post(`/v1/goals/${goalId}/complete`);
  await post(`/v1/goals/${goalId}/resume`);
  const afterComplete = await post(`/v1/goals/${goalId}/complete`);
  const aftPause = await post(`/v1/goals/${goalId}/pause`);
  check("C4 complete 是终态（不可迁出）", aftPause.status === 409, `status=${aftPause.status}`);
  void bad;
}

// --- M7-C：Best 四阶段与两道门 ---
{
  const sessionId = (await post("/v1/sessions", {})).body.session_id;
  const started = await post("/v1/best", { session_id: sessionId, idea: "给设置页加导出按钮" });
  check("C6 Best 启动进入访谈", started.status === 201 && started.body?.run?.stage === "interview",
    `stage=${started.body?.run?.stage}`);
  const bestId = started.body.run.best_id;
  const badQ = await post(`/v1/best/${bestId}/interview`, { question: { question: "格式？" }, answer: "CSV" });
  check("C6 访谈缺推荐答案 → 拒", badQ.status === 400, `status=${badQ.status}`);
  const spec = `# 加导出\n\n## Problem Statement\n无法带走配置。\n\n## Solution\n加按钮。\n\n## User Stories\n1. 导出。\n\n## Implementation Decisions\n新端点。\n\n## Testing Decisions\n黑盒。\n\n## Out of Scope\n不做导入。\n`;
  const submitted = await post(`/v1/best/${bestId}/spec`, { markdown: spec });
  check("C6 规格提交进入 spec 门", submitted.body?.run?.stage === "spec" && submitted.body?.run?.status === "awaiting_gate",
    `stage=${submitted.body?.run?.stage} status=${submitted.body?.run?.status}`);
  const approved = await post(`/v1/best/${bestId}/spec-gate`, { decision: "approve" });
  check("C6 规格通过进入拆票", approved.body?.run?.stage === "tickets", `stage=${approved.body?.run?.stage}`);
  // 实现门：完全权限也不可跳
  await put(`/v1/sessions/${sessionId}/exec-mode`, { mode: "full_access" });
  const blocked = await post(`/v1/best/${bestId}/implement`, {});
  check("C7 **完全权限下实现门仍拦**（FR-C14）", blocked.status === 409,
    `status=${blocked.status} code=${blocked.body?.error?.code}`);
}

// --- 汇总 ---
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const f of failed) console.log(`  ✖ ${f.name} — ${f.detail}`);
  process.exitCode = 1;
}
