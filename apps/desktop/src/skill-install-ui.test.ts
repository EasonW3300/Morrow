// 智能安装 UI 纯逻辑测试（票 M7-B-T4 / Issue #72）。
//
// 重点：Owner 必须在确认前看懂"要什么权限 / 要不要新建工具 / 来源是什么"，
// 以及"确认"必须显式（不能自动落地）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmDisabledReason,
  docSourceDisabledReason,
  escalationWarnings,
  formatBytes,
  materializePathHint,
  proposalPermissionLines,
  proposalStatusBadge,
  publicFetchExplanation,
  sourceKindLabel,
  type ProposalView,
} from "./skill-install-ui.ts";

function proposal(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    proposal_id: "prop_1",
    source_kind: "paste",
    source_ref: "pasted text",
    source_bytes: 200,
    name: "pdf-summariser",
    title: "PDF 摘要",
    description: "读取 PDF 并生成摘要",
    capabilities: [{ capability: "memory.write", purpose: "存摘要" }],
    new_tools: [],
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    examples: [{ request: "总结 a.pdf", expected: "三段摘要" }],
    uncertainties: [],
    status: "pending",
    materialized_as: null,
    error: null,
    ...overrides,
  };
}

// --- 来源 ---------------------------------------------------------------------------

test("来源标签覆盖三种形态", () => {
  assert.equal(sourceKindLabel("upload"), "上传文件");
  assert.equal(sourceKindLabel("paste"), "粘贴正文");
  assert.equal(sourceKindLabel("url"), "URL 抓取");
});

// --- 权限清单 -----------------------------------------------------------------------

test("权限清单：空时明确写「不请求任何权限」", () => {
  const lines = proposalPermissionLines({ filesystem: [], network: [], shell: [], channels: [], credentials: [] });
  assert.deepEqual(lines, ["不请求任何权限"]);
});

test("权限清单：逐维展示非空维度", () => {
  const lines = proposalPermissionLines({
    filesystem: ["/tmp/**"],
    network: ["api.example.com:443"],
    shell: [],
    channels: [],
    credentials: [],
  });
  assert.deepEqual(lines, ["文件系统：/tmp/**", "网络：api.example.com:443"]);
});

// --- 归途说明 -----------------------------------------------------------------------

test("纯组合：说明会建待批准 Skill（还需再批准才可调用）", () => {
  const hint = materializePathHint(proposal());
  assert.match(hint, /现有能力组合/);
  assert.match(hint, /待批准/);
  assert.match(hint, /批准后才可调用/);
});

test("需要新工具：说明会走工厂且不会立即得到可执行能力", () => {
  const hint = materializePathHint(
    proposal({
      new_tools: [{ suggested_name: "pdf.extract_text", description: "提取文本", rationale: "现有不够" }],
    }),
  );
  assert.match(hint, /pdf\.extract_text/);
  assert.match(hint, /能力工厂/);
  assert.match(hint, /沙箱/);
  assert.match(hint, /不会因为这次确认就直接得到可执行能力/);
});

// --- 状态 ---------------------------------------------------------------------------

test("状态徽标覆盖五态", () => {
  assert.equal(proposalStatusBadge("pending").label, "待确认");
  assert.equal(proposalStatusBadge("materialized").tone, "ok");
  assert.equal(proposalStatusBadge("rejected").tone, "muted");
  assert.equal(proposalStatusBadge("failed").tone, "error");
});

test("非 pending 提案不能再确认（防重复落地）", () => {
  for (const status of ["confirmed", "materialized", "rejected", "failed"]) {
    const reason = confirmDisabledReason(proposal({ status }), false);
    assert.notEqual(reason, null, status);
    assert.match(reason ?? "", /不能再确认/);
  }
  assert.equal(confirmDisabledReason(proposal(), false), null);
});

test("无提案 / 处理中时确认不可点", () => {
  assert.match(confirmDisabledReason(null, false) ?? "", /先生成提案/);
  assert.match(confirmDisabledReason(proposal(), true) ?? "", /处理中/);
});

// --- 超权与出网 ---------------------------------------------------------------------

test("超权警告从 uncertainties 里抽出来（醒目展示）", () => {
  const warnings = escalationWarnings(
    proposal({
      uncertainties: [
        "文档有歧义",
        "提案权限超出当前授权面：filesystem(/etc/**)——需先在「能力授权」里放行，否则落地会被拒。",
      ],
    }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /超出当前授权面/);
});

test("出网说明：关闭时给出开启方式，开启时说明仍禁私网", () => {
  const off = publicFetchExplanation(false);
  assert.match(off, /默认关闭/);
  assert.match(off, /MORROW_ALLOW_PUBLIC_DOC_FETCH=1/, "必须告诉用户怎么开");
  const on = publicFetchExplanation(true);
  assert.match(on, /仍禁止回环\/私网\/云元数据/);
});

// --- 来源表单 -----------------------------------------------------------------------

test("URL 来源：空与 http 都被拦，https 放行", () => {
  assert.match(docSourceDisabledReason({ sourceKind: "url", text: "", url: "", busy: false }) ?? "", /填写文档 URL/);
  assert.match(
    docSourceDisabledReason({ sourceKind: "url", text: "", url: "http://x.com/a", busy: false }) ?? "",
    /只支持 https/,
  );
  assert.equal(docSourceDisabledReason({ sourceKind: "url", text: "", url: "https://x.com/a", busy: false }), null);
});

test("粘贴/上传来源：空正文被拦", () => {
  for (const kind of ["paste", "upload"] as const) {
    assert.notEqual(docSourceDisabledReason({ sourceKind: kind, text: "  ", url: "", busy: false }), null);
    assert.equal(docSourceDisabledReason({ sourceKind: kind, text: "内容", url: "", busy: false }), null);
  }
});

test("formatBytes 人读格式", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.00 MB");
});
