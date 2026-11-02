/**
 * 能力管理 UI 纯逻辑测试（票 M2-T6 / Issue #27）。接缝 = capability-ui.ts 的纯函数
 * （无 DOM / fetch 依赖，与 health-ui / task-ui 同款测试面）：
 *
 *   1. 五维权限展示映射（manifest permissions / grant → 逐维行）
 *   2. 破坏性操作确认门状态机（disable 已启用能力与 rollback 需二次确认）
 *   3. 预授权（grants）编辑校验（filesystem glob / network host:port / 封闭枚举 / 凭据 id）
 *
 * 期望值全部来自独立事实源（PRD §6.3 五维语义、runtime engine 判定口径的文字化），
 * 不重算实现逻辑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  beginConfirm,
  cancelConfirm,
  collectCapabilityRefs,
  completeConfirm,
  confirmGate,
  destructiveReason,
  describePermissionRows,
  describeProposal,
  describeVerification,
  factoryStageIndex,
  factoryStageLabel,
  factoryStageOf,
  FACTORY_STAGE_ORDER,
  grantsFormFromGrant,
  grantsDiffSummary,
  isDestructiveAction,
  parseGrantsForm,
  validateGrantsForm,
  type ConfirmAction,
  type GrantsFormValues,
  type PermissionGrant,
} from "./capability-ui.ts";

// --- 1. 五维权限展示映射 ------------------------------------------------------

describe("describePermissionRows（五维展示映射）", () => {
  it("五维齐全的 manifest 恰好产出五行，标签与提示为 Owner 可读中文", () => {
    const rows = describePermissionRows({
      filesystem: ["workspace/**"],
      network: ["api.example.com:443"],
      shell: ["read"],
      channels: ["desktop"],
      credentials: ["cred-1"],
    });
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((r) => r.dimension),
      ["filesystem", "network", "shell", "channels", "credentials"],
    );
    assert.deepEqual(
      rows.map((r) => r.label),
      ["文件系统", "网络", "Shell 命令", "渠道", "凭据"],
    );
    for (const row of rows) {
      assert.ok(row.hint.length > 0, `dimension ${row.dimension} 应有语义提示`);
      assert.equal(row.empty, false);
    }
    assert.deepEqual(rows[0].items, ["workspace/**"]);
    assert.deepEqual(rows[4].items, ["cred-1"]);
  });

  it("空维度标记 empty 并给出空态列表（不出现在 items 里伪装成有权限）", () => {
    const rows = describePermissionRows({
      filesystem: [],
      network: [],
      shell: [],
      channels: [],
      credentials: [],
    });
    for (const row of rows) {
      assert.equal(row.empty, true);
      assert.deepEqual(row.items, []);
    }
  });

  it("部分维度有权限时只标空的那几维", () => {
    const rows = describePermissionRows({
      filesystem: ["docs/**/*.md"],
      network: [],
      shell: ["read", "vcs"],
      channels: [],
      credentials: [],
    });
    const empty = rows.filter((r) => r.empty).map((r) => r.dimension);
    assert.deepEqual(empty, ["network", "channels", "credentials"]);
    const shell = rows.find((r) => r.dimension === "shell");
    assert.deepEqual(shell?.items, ["read", "vcs"]);
  });
});

// --- 2. 确认门状态机 ----------------------------------------------------------

describe("确认门状态机", () => {
  const disableEnabled: ConfirmAction = { kind: "disable", name: "memory.write", currentStatus: "enabled" };
  const rollback: ConfirmAction = { kind: "rollback", name: "web.fetch", targetVersion: "1.0.0" };

  it("disable 已启用能力与 rollback 是破坏性操作；enable 不是", () => {
    assert.equal(isDestructiveAction(disableEnabled), true);
    assert.equal(isDestructiveAction(rollback), true);
    assert.equal(isDestructiveAction({ kind: "enable", name: "x" }), false);
    // 已停用再 disable 是幂等 no-op，不算破坏性
    assert.equal(isDestructiveAction({ kind: "disable", name: "x", currentStatus: "disabled" }), false);
  });

  it("破坏性操作首次点击进入 armed（带原因），不直接执行", () => {
    const state = beginConfirm(rollback);
    assert.equal(state.phase, "armed");
    if (state.phase === "armed") {
      assert.equal(state.action, rollback);
      assert.ok(state.reason.length > 0);
    }
    const reason = destructiveReason(disableEnabled);
    assert.ok(reason.includes("停用"), "disable 的警示应说明停用后果");
    const rollbackReason = destructiveReason(rollback);
    assert.ok(rollbackReason.includes("回滚"), "rollback 的警示应说明回滚后果");
  });

  it("enable 这类安全操作直接进入 executing（无确认门）", () => {
    const state = beginConfirm({ kind: "enable", name: "x" });
    assert.equal(state.phase, "executing");
  });

  it("armed → confirmGate → executing → completeConfirm → idle 全程", () => {
    const armed = beginConfirm(disableEnabled);
    const executing = confirmGate(armed);
    assert.equal(executing.phase, "executing");
    assert.deepEqual(completeConfirm(executing), { phase: "idle" });
  });

  it("armed → cancel 回到 idle（取消二次确认不产生副作用）", () => {
    const armed = beginConfirm(rollback);
    assert.deepEqual(cancelConfirm(armed), { phase: "idle" });
    assert.deepEqual(cancelConfirm({ phase: "idle" }), { phase: "idle" });
  });
});

// --- 3. grants 编辑校验 --------------------------------------------------------

describe("validateGrantsForm / parseGrantsForm（预授权编辑校验）", () => {
  it("合法五维表单通过校验并解析为 PermissionGrant（空行与首尾空白被忽略）", () => {
    const values: GrantsFormValues = {
      filesystem: "workspace/**\n\n  docs/*.md  \n",
      network: "api.example.com:443\n*:8080",
      shell: ["read", "vcs"],
      channels: ["desktop", "feishu"],
      credentials: "cred-a\ncred-b",
    };
    const errors = validateGrantsForm(values);
    assert.deepEqual(errors, {});
    assert.deepEqual(parseGrantsForm(values), {
      filesystem: ["workspace/**", "docs/*.md"],
      network: ["api.example.com:443", "*:8080"],
      shell: ["read", "vcs"],
      channels: ["desktop", "feishu"],
      credentials: ["cred-a", "cred-b"],
    });
  });

  it("filesystem：空段（a//b）与段内嵌 **（a/**/b 之外的 **x）报错", () => {
    const emptySegment = validateGrantsForm({
      filesystem: "a//b",
      network: "",
      shell: [],
      channels: [],
      credentials: "",
    });
    assert.match(emptySegment.filesystem ?? "", /空/);

    const embeddedGlobstar = validateGrantsForm({
      filesystem: "a/**x/b",
      network: "",
      shell: [],
      channels: [],
      credentials: "",
    });
    assert.match(embeddedGlobstar.filesystem ?? "", /\*\*/);

    // `**` 独占段与段内单星（*.md）是合法 glob
    const ok = validateGrantsForm({
      filesystem: "**\nlogs/*.log",
      network: "",
      shell: [],
      channels: [],
      credentials: "",
    });
    assert.equal(ok.filesystem, undefined);
  });

  it("network：缺端口、端口越界、host 为空报错（与 runtime parseHostPort 同口径）", () => {
    for (const bad of ["host-only", ":443", "host:", "host:0", "host:70000", "host:-1"]) {
      const errors = validateGrantsForm({
        filesystem: "",
        network: bad,
        shell: [],
        channels: [],
        credentials: "",
      });
      assert.ok(errors.network !== undefined, `${bad} 应报错`);
    }
    const ok = validateGrantsForm({
      filesystem: "",
      network: "127.0.0.1:1\nhost:65535\n*:443",
      shell: [],
      channels: [],
      credentials: "",
    });
    assert.equal(ok.network, undefined);
  });

  it("credentials：空白行被忽略（空维度合法——最小授权起点即五维全空）", () => {
    const whitespaceOnly = validateGrantsForm({
      filesystem: "",
      network: "",
      shell: [],
      channels: [],
      credentials: "  \n",
    });
    assert.deepEqual(whitespaceOnly, {});
    assert.deepEqual(parseGrantsForm({
      filesystem: "",
      network: "",
      shell: [],
      channels: [],
      credentials: "cred-a\n  \n",
    })?.credentials, ["cred-a"]);

    const badShell = validateGrantsForm({
      filesystem: "",
      network: "",
      shell: ["read", "root" as never],
      channels: [],
      credentials: "",
    });
    assert.ok(badShell.shell !== undefined);

    const badChannel = validateGrantsForm({
      filesystem: "",
      network: "",
      shell: [],
      channels: ["sms" as never],
      credentials: "",
    });
    assert.ok(badChannel.channels !== undefined);
  });

  it("grantsFormFromGrant：grant → 表单（数组转多行文本）往返后 parse 相等", () => {
    const grant = {
      filesystem: ["workspace/**"],
      network: ["*:8080"],
      shell: ["read" as const],
      channels: ["desktop" as const],
      credentials: ["cred-1"],
    };
    const round = parseGrantsForm(grantsFormFromGrant(grant));
    assert.deepEqual(round, grant);
  });

  it("grantsDiffSummary：收窄授权产生 removed 项（审计提示的事实源）", () => {
    const before: PermissionGrant = {
      filesystem: ["workspace/**", "docs/**"],
      network: ["*:443"],
      shell: ["read", "write"],
      channels: ["desktop"],
      credentials: [],
    };
    const after: PermissionGrant = {
      filesystem: ["workspace/**"],
      network: ["*:443"],
      shell: ["read", "write"],
      channels: ["desktop"],
      credentials: [],
    };
    const diff = grantsDiffSummary(before, after);
    assert.ok(diff.some((d) => d.dimension === "filesystem" && d.removed.includes("docs/**")));
    assert.ok(diff.every((d) => d.added.length === 0));

    const expanded = grantsDiffSummary(after, before);
    assert.ok(expanded.some((d) => d.dimension === "filesystem" && d.added.includes("docs/**")));
  });
});

// --- 4. 工厂进度与验证报告（真实 T3 视图投影）-----------------------------------

describe("factoryStageOf（真实 status×stage 双轴 → 进度线）", () => {
  it("主链六阶段有序：检索→规划→构建→验证→待确认→已注册；标签为 Owner 可读中文", () => {
    assert.deepEqual(
      FACTORY_STAGE_ORDER.map((s) => factoryStageLabel(s)),
      ["检索（记忆与既有能力）", "规划 manifest", "构建与沙箱测试", "验证", "待 Owner 确认", "已注册"],
    );
    assert.equal(factoryStageLabel("failed"), "失败");
  });

  it("submitted 态按 stage 推进：submitted=retrieval 进行中 → built=verifying 进行中", () => {
    assert.equal(factoryStageOf({ status: "submitted", stage: "submitted" }), "retrieval");
    assert.equal(factoryStageOf({ status: "submitted", stage: "retrieved" }), "planning");
    assert.equal(factoryStageOf({ status: "submitted", stage: "planned" }), "building");
    assert.equal(factoryStageOf({ status: "submitted", stage: "built" }), "verifying");
  });

  it("proposed → 待确认；confirmed → 已注册；failed → 失败旁路；reused 停在检索位", () => {
    assert.equal(factoryStageOf({ status: "proposed", stage: "verified" }), "awaiting_confirmation");
    assert.equal(factoryStageOf({ status: "confirmed", stage: "verified" }), "registered");
    assert.equal(factoryStageOf({ status: "failed", stage: "built" }), "failed");
    assert.equal(factoryStageOf({ status: "reused", stage: "submitted" }), "retrieval");
  });

  it("阶段序位：failed → -1（不入进度线）；awaiting_confirmation 在第 5 位", () => {
    assert.equal(factoryStageIndex("failed"), -1);
    assert.equal(factoryStageIndex("awaiting_confirmation"), 4);
    assert.equal(factoryStageIndex("registered"), 5);
  });
});

describe("describeVerification（真实 VerifyReport → 确认注册区呈现）", () => {
  it("全过报告：越权/功能/反向故障按用例归组，沙箱执行成行；allPassed=true 可确认", () => {
    const allPass = describeVerification({
      ok: true,
      cases: [
        { case_id: "pos-1", kind: "positive", pass: true, detail: "ok" },
        { case_id: "neg-1", kind: "negative", pass: true, detail: "ok" },
        { case_id: "esc-1", kind: "privilege-escalation", pass: true, detail: "blocked" },
        { case_id: "fault-1", kind: "fault", pass: true, detail: "ok" },
      ],
    });
    assert.equal(allPass.allPassed, true);
    assert.deepEqual(
      allPass.rows.map((r) => r.label),
      ["越权测试", "功能测试", "反向与故障", "沙箱执行"],
    );
    const escalation = allPass.rows.find((r) => r.label === "越权测试");
    assert.match(escalation?.summary ?? "", /越权企图 1\/1 通过/);
  });

  it("沙箱故障（sandbox_error）→ 沙箱行未过 + allPassed=false（不可确认注册）", () => {
    const sandboxFail = describeVerification({
      ok: false,
      cases: [{ case_id: "pos-1", kind: "positive", pass: false, detail: "container timed out" }],
      sandbox_error: "sandbox_unavailable: docker daemon not reachable",
    });
    assert.equal(sandboxFail.allPassed, false);
    const sandboxRow = sandboxFail.rows.find((r) => r.label === "沙箱执行");
    assert.equal(sandboxRow?.passed, false);
    assert.match(sandboxRow?.summary ?? "", /docker daemon not reachable/);
  });

  it("越权用例未全阻断 → 越权行未过并列出失败细节（AC-06 口径：越权 100% 阻断才可注册）", () => {
    const escalationLeak = describeVerification({
      ok: false,
      cases: [
        { case_id: "esc-1", kind: "privilege-escalation", pass: true, detail: "blocked" },
        { case_id: "esc-2", kind: "privilege-escalation", pass: false, detail: "fetch to evil.example succeeded" },
      ],
    });
    assert.equal(escalationLeak.allPassed, false);
    const row = escalationLeak.rows.find((r) => r.label === "越权测试");
    assert.equal(row?.passed, false);
    assert.match(row?.summary ?? "", /evil\.example succeeded/);
  });

  it("无报告（failed 于验证前）→ 空行且不可确认", () => {
    const empty = describeVerification(undefined);
    assert.equal(empty.allPassed, false);
    assert.deepEqual(empty.rows, []);
  });
});

// --- 5. Skill 提案呈现 ----------------------------------------------------------

describe("Skill 提案呈现（T5 接缝的 UI 投影）", () => {
  it("悬空引用提案被拒：呈现 warn 态 + 未注册能力清单", () => {
    const out = describeProposal({
      proposal_id: "p-2",
      title: "周报汇总 Skill",
      status: "rejected",
      capabilities: ["report.render", "mail.send"],
      missing_capabilities: ["mail.send"],
    });
    assert.equal(out.tone, "warn");
    assert.equal(out.statusLabel, "已拒绝");
    assert.ok(out.note?.includes("悬空引用"));
    assert.ok(out.note?.includes("mail.send"));
  });

  it("pending / approved 的呈现各自成立", () => {
    const pending = describeProposal({
      proposal_id: "p-1",
      title: "x",
      status: "pending",
      capabilities: ["a"],
    });
    assert.equal(pending.tone, "dim");
    assert.equal(pending.statusLabel, "待批准");

    const approved = describeProposal({
      proposal_id: "p-1",
      title: "x",
      status: "approved",
      capabilities: ["a"],
    });
    assert.equal(approved.tone, "ok");
    assert.equal(approved.statusLabel, "已批准");
  });
});

// --- 6. 节点能力引用归集 ----------------------------------------------------------

describe("collectCapabilityRefs（Task 节点能力引用卡数据源）", () => {
  const records = [
    { name: "memory.write", version: "1.1.0", status: "enabled", author: "human", runtime: "typescript", source_hash: "sha256-aa", manifest: {}, created_at: "t", updated_at: "t" },
    { name: "web.fetch", version: "0.3.0", status: "enabled", author: "ai", runtime: "typescript", source_hash: "sha256-bb", manifest: {}, created_at: "t", updated_at: "t" },
  ] as never[];

  it("tool.started 按 node_id 归集命中注册表的能力（名称+版本），未注册工具排除", () => {
    const events = [
      { event_type: "tool.started", payload: { node_id: "n1", tool_name: "memory.write" } },
      { event_type: "tool.finished", payload: { node_id: "n1", tool_name: "memory.write" } },
      { event_type: "tool.started", payload: { node_id: "n1", tool_name: "memory.write" } },
      { event_type: "tool.started", payload: { node_id: "n1", tool_name: "fs.read" } },
      { event_type: "tool.started", payload: { node_id: "n2", tool_name: "web.fetch" } },
    ];
    const refs = collectCapabilityRefs(events, records);
    assert.deepEqual(refs.get("n1"), [{ name: "memory.write", version: "1.1.0" }]);
    assert.deepEqual(refs.get("n2"), [{ name: "web.fetch", version: "0.3.0" }]);
  });

  it("无命中时节点不产生键；payload 形态不完整被跳过", () => {
    const refs = collectCapabilityRefs(
      [
        { event_type: "tool.started", payload: { tool_name: "memory.write" } },
        { event_type: "node.started", payload: { node_id: "n1" } },
      ],
      records,
    );
    assert.equal(refs.size, 0);
  });
});
