/**
 * 智能安装 UI 纯逻辑（票 M7-B-T4 / Issue #72）。
 *
 * 这一层的职责是让 Owner **在确认前**看懂三件事：
 *   1. 这份提案要动哪些权限（超权的部分必须醒目）；
 *   2. 需不需要新建工具（需要 → 会走工厂，还会再确认一次，不是立即生效）；
 *   3. 来源是什么（上传的文件名 / 粘贴 / 哪个 URL）。
 *
 * 以及一条硬纪律：**「确认」按钮必须显式点**，不能因为起草成功就自动落地。
 */

/** 提案的视图模型（与服务端 InstallProposal 同形） */
export interface ProposalView {
  proposal_id: string;
  source_kind: "upload" | "paste" | "url";
  source_ref: string;
  source_bytes: number;
  name: string;
  title: string;
  description: string;
  capabilities: Array<{ capability: string; purpose: string; example_args?: Record<string, unknown> }>;
  new_tools: Array<{ suggested_name: string; description: string; rationale: string }>;
  permissions: Record<string, string[]>;
  examples: Array<{ request: string; expected: string }>;
  uncertainties: string[];
  status: string;
  materialized_as: { kind: "skill" | "factory_request"; id: string } | null;
  error: string | null;
}

const DIMENSION_LABELS: Record<string, string> = {
  filesystem: "文件系统",
  network: "网络",
  shell: "Shell",
  channels: "渠道",
  credentials: "凭据",
};

/** 来源标签（"这份提案是从哪来的"） */
export function sourceKindLabel(kind: string): string {
  switch (kind) {
    case "upload":
      return "上传文件";
    case "paste":
      return "粘贴正文";
    case "url":
      return "URL 抓取";
    default:
      return kind;
  }
}

/** 权限清单：逐维展示，空维度不出现；全空时明确说明 */
export function proposalPermissionLines(permissions: Record<string, string[]>): string[] {
  const lines: string[] = [];
  for (const [dimension, label] of Object.entries(DIMENSION_LABELS)) {
    const values = permissions[dimension] ?? [];
    if (values.length > 0) lines.push(`${label}：${values.join(", ")}`);
  }
  return lines.length === 0 ? ["不请求任何权限"] : lines;
}

/** 归途说明：纯组合 vs 需要新工具（后者要再经工厂确认） */
export function materializePathHint(proposal: ProposalView): string {
  if (proposal.new_tools.length > 0) {
    return (
      `该提案需要 ${proposal.new_tools.length} 个新工具（${proposal.new_tools
        .map((tool) => tool.suggested_name)
        .join(", ")}）。确认后会提交给能力工厂：先生成、再在沙箱里验证，` +
      "通过后再由你确认注册——不会因为这次确认就直接得到可执行能力。"
    );
  }
  return "该提案只用现有能力组合，确认后会创建一个待批准的 Skill（还需要你在技能页批准后才可调用）。";
}

/** 状态徽标 */
export function proposalStatusBadge(status: string): { tone: string; label: string } {
  switch (status) {
    case "pending":
      return { tone: "warn", label: "待确认" };
    case "confirmed":
      return { tone: "run", label: "已确认" };
    case "materialized":
      return { tone: "ok", label: "已落地" };
    case "rejected":
      return { tone: "muted", label: "已拒绝" };
    case "failed":
      return { tone: "error", label: "落地失败" };
    default:
      return { tone: "dim", label: status };
  }
}

/** 确认按钮的禁用原因（null = 可点） */
export function confirmDisabledReason(proposal: ProposalView | null, busy: boolean): string | null {
  if (busy) return "处理中…";
  if (proposal === null) return "请先生成提案";
  if (proposal.status !== "pending") return `该提案状态为「${proposalStatusBadge(proposal.status).label}」，不能再确认`;
  return null;
}

/** 超权提示（提案权限已在服务端标注进 uncertainties；这里单独抽出来做醒目提示） */
export function escalationWarnings(proposal: ProposalView): string[] {
  return proposal.uncertainties.filter((item) => item.includes("超出当前授权面"));
}

/**
 * 出网开关的说明（公网默认关闭时的提示）。
 *
 * 明确写"如何开启"与"开启意味着什么"，而不是只说"不允许"——否则 Owner 只会
 * 困惑为什么贴了自己的博客链接也不行。
 */
export function publicFetchExplanation(allowPublic: boolean): string {
  return allowPublic
    ? "公网抓取已开启：任何 https URL 都会被尝试抓取（仍禁止回环/私网/云元数据地址）。"
    : "公网抓取默认关闭：只能抓内网/私有网络地址。如需抓公网文档，请用 MORROW_ALLOW_PUBLIC_DOC_FETCH=1 启动 Runtime。";
}

/** 文档来源表单的可用性（三种来源各自必填什么） */
export function docSourceDisabledReason(input: {
  sourceKind: "upload" | "paste" | "url";
  text: string;
  url: string;
  busy: boolean;
}): string | null {
  if (input.busy) return "正在生成提案…";
  if (input.sourceKind === "url") {
    if (input.url.trim().length === 0) return "请填写文档 URL";
    if (!/^https:\/\//.test(input.url.trim())) return "只支持 https URL";
    return null;
  }
  if (input.text.trim().length === 0) return "请粘贴文档内容";
  return null;
}

/** 文件大小的人读格式（附上限说明用） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
