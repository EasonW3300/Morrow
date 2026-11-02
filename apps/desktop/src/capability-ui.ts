/**
 * 能力管理 UI 呈现逻辑（票 M2-T6 / Issue #27，PRD §5.1 设置→能力管理、§6.3 manifest v1）。
 *
 * 纯函数模块（无 DOM / fetch 依赖，node:test 覆盖；同 health-ui / task-ui 模式）：
 *   1. 五维权限展示映射  manifest.permissions / PermissionGrant → 逐维可读行
 *   2. 破坏性操作确认门  disable（已启用的能力）与 rollback 必须二次确认的状态机
 *   3. 预授权编辑校验    filesystem glob / network host:port / 封闭枚举 / 凭据 id 的
 *                        表单校验与 diff（审计提示「收窄授权立即约束运行时复核」的事实源）
 *   4. 工厂进度与验证报告映射（T3 接缝的 UI 侧投影）
 *   5. Skill 提案呈现（T5 接缝的 UI 侧投影；悬空引用提案被拒的呈现）
 *   6. 节点能力引用归集（Task 视图节点面板的能力引用卡数据源）
 *
 * 判定口径与 apps/runtime/src/capabilities/engine.ts 对齐（文字化重述，desktop 不 import
 * runtime 内部模块）：filesystem glob 按 `/` 分段、`**` 独占段跨段、单段内 `*` 通配；
 * network host:port 按最后一个 `:` 拆分、port 为 `*` 或 1-65535 数字、host 非空。
 */
import type {
  CapabilityChannel,
  CapabilityPermissions,
  CapabilityRecord,
  CapabilityStatus,
  PermissionGrant,
  ShellCommandCategory,
} from "@morrow/protocol";
import { CAPABILITY_CHANNELS, SHELL_COMMAND_CATEGORIES } from "@morrow/protocol";

/** 能力域类型的 UI 侧唯一出口（唯一真相源在 @morrow/protocol；同 api.ts 的 re-export 模式） */
export type {
  CapabilityManifest,
  CapabilityPermissions,
  CapabilityRecord,
  CapabilityVersionRecord,
  PermissionGrant,
} from "@morrow/protocol";

// --- 1. 五维权限展示映射 ------------------------------------------------------

export type PermissionDimension = keyof CapabilityPermissions;

/** 五维的 Owner 可读元数据（顺序 = ALL_DIMENSIONS 展示顺序） */
export const DIMENSION_META: Readonly<
  Record<PermissionDimension, { label: string; hint: string }>
> = {
  filesystem: { label: "文件系统", hint: "路径 glob（** 跨段、* 段内通配）" },
  network: { label: "网络", hint: "目标 host:port（授权侧可通配）" },
  shell: { label: "Shell 命令", hint: "命令类别封闭枚举（arbitrary 为晶格顶）" },
  channels: { label: "渠道", hint: "允许外发的渠道" },
  credentials: { label: "凭据", hint: "凭据 id 精确匹配（最敏感维度）" },
};

export interface PermissionRow {
  dimension: PermissionDimension;
  label: string;
  hint: string;
  items: readonly string[];
  /** 维度为空（无声明/无授权）——空态呈现，不伪装成有权限 */
  empty: boolean;
}

/** manifest 五维权限（或 grant 授权面）→ 恰好五行（按 DIMENSION_META 顺序） */
export function describePermissionRows(permissions: CapabilityPermissions): PermissionRow[] {
  return (Object.keys(DIMENSION_META) as PermissionDimension[]).map((dimension) => {
    const items = permissions[dimension] as readonly string[];
    return {
      dimension,
      label: DIMENSION_META[dimension].label,
      hint: DIMENSION_META[dimension].hint,
      items,
      empty: items.length === 0,
    };
  });
}

// --- 2. 破坏性操作确认门 ------------------------------------------------------

/** 能力生命周期操作（UI 按钮触发的意图；rollback 需目标版本） */
export type ConfirmAction =
  | { kind: "enable"; name: string }
  | { kind: "disable"; name: string; currentStatus: CapabilityStatus }
  | { kind: "rollback"; name: string; targetVersion: string };
/**
 * 确认门状态：idle →（破坏性操作首次点击）armed →（再次点击）executing →（完成）idle。
 * 安全操作（enable、对已停用能力的 disable）跳过 armed 直接 executing。
 */
export type ConfirmGateState =
  | { phase: "idle" }
  | { phase: "armed"; action: ConfirmAction; reason: string }
  | { phase: "executing"; action: ConfirmAction };

export function isDestructiveAction(action: ConfirmAction): boolean {
  if (action.kind === "rollback") return true;
  if (action.kind === "disable") return action.currentStatus === "enabled";
  return false;
}

/** 破坏性操作的警示文案（armed 态呈现；说明后果而非复述动作） */
export function destructiveReason(action: ConfirmAction): string {
  switch (action.kind) {
    case "disable":
      return `停用「${action.name}」后，运行时对该能力的调用将被立即拒绝（capability_disabled），依赖它的任务与 Skill 会受影响。`;
    case "rollback":
      return `回滚会把「${action.name}」的当前版本指针指回 ${action.targetVersion}：新版本内容保留在版本历史中，但运行时从此执行旧版本代码。`;
    case "enable":
      return `启用「${action.name}」`;
  }
}

export function beginConfirm(action: ConfirmAction): ConfirmGateState {
  if (!isDestructiveAction(action)) return { phase: "executing", action };
  return { phase: "armed", action, reason: destructiveReason(action) };
}

/** armed → executing（二次确认）。仅 armed 态响应；其余原样返回。 */
export function confirmGate(state: ConfirmGateState): ConfirmGateState {
  return state.phase === "armed" ? { phase: "executing", action: state.action } : state;
}

export function cancelConfirm(_state: ConfirmGateState): ConfirmGateState {
  return { phase: "idle" };
}

export function completeConfirm(state: ConfirmGateState): ConfirmGateState {
  return { phase: "idle" };
}

// --- 3. 预授权（grants）编辑表单 ----------------------------------------------

/**
 * grants 编辑表单值：list 型维度用多行文本编辑（一行一项），封闭枚举用勾选。
 * textarea 一行一项比 chip 编辑简单可靠，且与「glob 里有特殊字符」兼容。
 */
export interface GrantsFormValues {
  filesystem: string;
  network: string;
  shell: ShellCommandCategory[];
  channels: CapabilityChannel[];
  credentials: string;
}

/** 表单错误：每维至多一条（第一条命中即报） */
export type GrantsFormErrors = Partial<Record<PermissionDimension, string>>;

/** 空行拆分（多行文本 → 行数组，去首尾空白、丢空行） */
function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * filesystem glob 校验（对齐 engine filesystemGlobWithin 的输入约束）：
 * 每段非空；`**` 只能独占段（段内嵌 `**` 会退化成无意义的正则拼接，拒绝）；
 * 其余段允许字面与段内单 `*`（如 `*.md`）。
 */
function validateFilesystemGlob(glob: string): string | null {
  for (const segment of glob.split("/")) {
    if (segment.length === 0) return `「${glob}」存在空路径段（a//b 形态）`;
    if (segment.includes("**") && segment !== "**") {
      return `「${glob}」的 ** 只能独占一个路径段（${segment} 非法）`;
    }
  }
  return null;
}

/** network host:port 校验（与 engine parseHostPort 同口径）：host 非空、port 为 `*` 或 1-65535 */
function validateNetworkTarget(target: string): string | null {
  const idx = target.lastIndexOf(":");
  if (idx <= 0 || idx === target.length - 1) return `「${target}」必须是 host:port 形态（按最后一个 : 拆分）`;
  const port = target.slice(idx + 1);
  if (port !== "*") {
    if (!/^\d+$/.test(port)) return `「${target}」的端口必须是数字或 *`;
    const n = Number(port);
    if (!(n >= 1 && n <= 65535)) return `「${target}」的端口越界（1-65535）`;
  }
  return null;
}

export function validateGrantsForm(values: GrantsFormValues): GrantsFormErrors {
  const errors: GrantsFormErrors = {};
  for (const glob of splitLines(values.filesystem)) {
    const problem = validateFilesystemGlob(glob);
    if (problem !== null) {
      errors.filesystem = problem;
      break;
    }
  }
  for (const target of splitLines(values.network)) {
    const problem = validateNetworkTarget(target);
    if (problem !== null) {
      errors.network = problem;
      break;
    }
  }
  for (const category of values.shell) {
    if (!SHELL_COMMAND_CATEGORIES.includes(category)) {
      errors.shell = `「${String(category)}」不是合法的命令类别（${SHELL_COMMAND_CATEGORIES.join(" / ")}）`;
      break;
    }
  }
  for (const channel of values.channels) {
    if (!CAPABILITY_CHANNELS.includes(channel)) {
      errors.channels = `「${String(channel)}」不是合法的渠道（${CAPABILITY_CHANNELS.join(" / ")}）`;
      break;
    }
  }
  // credentials：精确匹配维度，空 id 无意义；trim 后全空（只有空行）也报
  const creds = splitLines(values.credentials);
  if (creds.length === 0 && values.credentials.trim().length > 0) {
    errors.credentials = "凭据 id 不能为空";
  }
  return errors;
}

/** 校验通过的表单 → PermissionGrant（校验失败返回 null，UI 不放行保存） */
export function parseGrantsForm(values: GrantsFormValues): PermissionGrant | null {
  if (Object.keys(validateGrantsForm(values)).length > 0) return null;
  return {
    filesystem: splitLines(values.filesystem),
    network: splitLines(values.network),
    shell: [...values.shell],
    channels: [...values.channels],
    credentials: splitLines(values.credentials),
  };
}

/** PermissionGrant → 表单值（数组 → 多行文本；勾选集原样） */
export function grantsFormFromGrant(grant: PermissionGrant): GrantsFormValues {
  return {
    filesystem: grant.filesystem.join("\n"),
    network: grant.network.join("\n"),
    shell: [...grant.shell],
    channels: [...grant.channels],
    credentials: grant.credentials.join("\n"),
  };
}

export interface GrantsDimensionDiff {
  dimension: PermissionDimension;
  added: string[];
  removed: string[];
}

/** 授权面 diff（保存前的审计提示内容：收窄会立即约束已注册能力的运行时复核） */
export function grantsDiffSummary(
  before: PermissionGrant,
  after: PermissionGrant,
): GrantsDimensionDiff[] {
  const diffs: GrantsDimensionDiff[] = [];
  for (const dimension of Object.keys(DIMENSION_META) as PermissionDimension[]) {
    const prev = new Set(before[dimension] as readonly string[]);
    const next = new Set(after[dimension] as readonly string[]);
    const added = [...next].filter((item) => !prev.has(item));
    const removed = [...prev].filter((item) => !next.has(item));
    if (added.length > 0 || removed.length > 0) diffs.push({ dimension, added, removed });
  }
  return diffs;
}

/** diff → Owner 可读的审计提示（保存确认区呈现） */
export function describeGrantsDiff(diffs: GrantsDimensionDiff[]): string {
  if (diffs.length === 0) return "授权面无变化。";
  const parts = diffs.map((d) => {
    const meta = DIMENSION_META[d.dimension].label;
    const changes = [
      ...d.added.map((item) => `+ ${item}`),
      ...d.removed.map((item) => `- ${item}`),
    ];
    return `${meta}（${changes.join("、")}）`;
  });
  return `变更：${parts.join("；")}。保存将写入 capability.grants_updated 审计事件，且收窄立即约束运行时——已注册能力按新授权面复核，不再被覆盖的调用会被拒绝（escalation）。`;
}

// --- 4. 工厂进度与验证报告（T3 接缝的 UI 侧投影） ------------------------------
// ⚠️ 接缝（票 M2-T6 / Issue #27）：factory 端点由 T3 交付（POST /v1/capabilities/request、
// GET /v1/capabilities/request/:id、POST .../confirm，PRD §6.2）。本票只做「提交需求描述 +
// 进度轮询 + 验证报告 + 确认注册」的壳；阶段枚举与报告形状是 UI 侧投影，T3 落地后以
// 其真实事件流（factory_* 事件族）为准对齐——见 capability-fixture.ts 的 mock 说明。

/** 工厂请求阶段（UI 侧枚举；fixture 演示状态流转） */
export type FactoryStage =
  | "retrieval"
  | "planning"
  | "building"
  | "verifying"
  | "awaiting_confirmation"
  | "registered"
  | "failed";

/** 进度条上的主链阶段（failed 是离线旁路，不入序列） */
export const FACTORY_STAGE_ORDER: readonly FactoryStage[] = [
  "retrieval",
  "planning",
  "building",
  "verifying",
  "awaiting_confirmation",
  "registered",
];

export function factoryStageLabel(stage: FactoryStage): string {
  switch (stage) {
    case "retrieval":
      return "检索（记忆与既有能力）";
    case "planning":
      return "规划 manifest";
    case "building":
      return "构建与沙箱测试";
    case "verifying":
      return "验证";
    case "awaiting_confirmation":
      return "待 Owner 确认";
    case "registered":
      return "已注册";
    case "failed":
      return "失败";
  }
}

/** 阶段在主链上的序位（failed → -1；轮询 UI 判断进度条填充用） */
export function factoryStageIndex(stage: FactoryStage): number {
  const idx = FACTORY_STAGE_ORDER.indexOf(stage);
  return idx === -1 ? -1 : idx;
}

/** 验证报告条目（四类测试：AC-06 口径——schema/越权/功能/沙箱；T3 落地后以其形状为准） */
export interface VerificationReportItem {
  category: "schema" | "permission" | "functional" | "sandbox";
  passed: boolean;
  summary: string;
}

const VERIFICATION_CATEGORY_LABELS: Readonly<Record<VerificationReportItem["category"], string>> = {
  schema: "Schema 校验",
  permission: "越权测试",
  functional: "功能测试",
  sandbox: "沙箱执行",
};

export function verificationCategoryLabel(category: VerificationReportItem["category"]): string {
  return VERIFICATION_CATEGORY_LABELS[category];
}

export interface VerificationPresentation {
  allPassed: boolean;
  rows: Array<{ label: string; passed: boolean; summary: string }>;
}

/** 验证报告 → 确认注册区的呈现（任何一类未过 → 不可确认注册） */
export function describeVerification(items: VerificationReportItem[]): VerificationPresentation {
  return {
    allPassed: items.length > 0 && items.every((item) => item.passed),
    rows: items.map((item) => ({
      label: VERIFICATION_CATEGORY_LABELS[item.category],
      passed: item.passed,
      summary: item.summary,
    })),
  };
}

// --- 5. Skill 列表与提案呈现（T5 接缝的 UI 侧投影） ---------------------------
// ⚠️ 接缝（票 M2-T6 / Issue #27）：Skill 与提案端点由 T5 交付（GET /v1/skills、
// GET/POST /v1/skills/proposals[...]）。本票做列表/批准/拒绝的 UI + 夹具演示。

export interface SkillSummary {
  skill_id: string;
  title: string;
  version: string;
  /** 该 Skill 组合了哪些 capability（能力 id 列表） */
  capabilities: string[];
  enabled?: boolean;
}

export interface SkillProposal {
  proposal_id: string;
  title: string;
  status: "pending" | "approved" | "rejected";
  /** 提案要注册/组合的能力 */
  capabilities: string[];
  /** 悬空引用：提案引用但注册表里不存在的能力 id（拒绝依据） */
  missing_capabilities?: string[];
  reason?: string;
  created_at?: string;
}

export function describeProposalStatus(status: SkillProposal["status"]): string {
  switch (status) {
    case "pending":
      return "待批准";
    case "approved":
      return "已批准";
    case "rejected":
      return "已拒绝";
  }
}

export interface ProposalPresentation {
  tone: "ok" | "warn" | "dim";
  statusLabel: string;
  /** 悬空引用被拒 / 拒绝原因的说明；无则为 null */
  note: string | null;
}

/** 提案 → 呈现（验收项：悬空引用提案被拒有呈现） */
export function describeProposal(proposal: SkillProposal): ProposalPresentation {
  const statusLabel = describeProposalStatus(proposal.status);
  if (proposal.status === "rejected") {
    const missing = proposal.missing_capabilities ?? [];
    const detail =
      missing.length > 0
        ? `悬空引用：提案引用的能力未注册（${missing.join("、")}），批准被拒绝。`
        : (proposal.reason ?? "提案被拒绝。");
    return { tone: "warn", statusLabel, note: detail };
  }
  if (proposal.status === "approved") {
    return { tone: "ok", statusLabel, note: proposal.reason ?? "已批准并进入注册流程。" };
  }
  return { tone: "dim", statusLabel, note: proposal.reason ?? null };
}

// --- 6. 节点能力引用归集（Task 视图节点面板的能力引用卡） ----------------------

export interface CapabilityRef {
  name: string;
  version: string;
}

/** tool.started 信封的最小投影（避免 import 全量 envelope 类型） */
export interface ToolStartEventLike {
  event_type: string;
  payload: Record<string, unknown>;
}

/**
 * 任务事件流 + 能力注册表 → node_id → 用到的能力（名称+版本）。
 * 只认 tool.started 且 tool_name 命中注册表的能力；未注册工具不进引用卡。
 * 保持首次出现顺序、同节点去重。
 */
export function collectCapabilityRefs(
  events: readonly ToolStartEventLike[],
  records: readonly CapabilityRecord[],
): Map<string, CapabilityRef[]> {
  const byName = new Map(records.map((record) => [record.name, record]));
  const refs = new Map<string, CapabilityRef[]>();
  for (const event of events) {
    if (event.event_type !== "tool.started") continue;
    const nodeId = event.payload.node_id;
    const toolName = event.payload.tool_name;
    if (typeof nodeId !== "string" || typeof toolName !== "string") continue;
    const record = byName.get(toolName);
    if (record === undefined) continue;
    const list = refs.get(nodeId) ?? [];
    if (!list.some((ref) => ref.name === record.name)) {
      list.push({ name: record.name, version: record.version });
    }
    refs.set(nodeId, list);
  }
  return refs;
}
