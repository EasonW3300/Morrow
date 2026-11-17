/**
 * 执行模式 UI 的纯逻辑（票 M7-B-T6 / Issue #70，FR-B14/B15/B16）。
 *
 * 单独的纯模块而不是塞进组件：这些判定是"用户看到的承诺"，必须能被 node:test
 * 直接锁住——尤其是「完全权限不是无边界」这条文案，绝不能让 UI 说成"不再询问
 * 任何确认，包括危险命令"。
 *
 * 三条文案纪律（都对应真实的安全语义）：
 *   1. 完全权限的说明必须写明**危险命令仍会被拒**，且快照/审计照做；
 *   2. 快照范围说明必须列出**不在保护范围**的路径（`~/.ssh`、`/etc` 等）；
 *   3. 待确认时必须展示**完整脚本**，不做省略号截断。
 */

/** 执行模式（与 runtime 的 ExecMode 同字面量） */
export type ExecMode = "confirm_each" | "full_access";

export const DEFAULT_EXEC_MODE: ExecMode = "confirm_each";

/** 模式的中文标签（UI 按钮文案） */
export function modeLabel(mode: ExecMode): string {
  return mode === "full_access" ? "完全权限" : "每次命令确认";
}

/** 模式的简短说明（按钮副标题） */
export function modeSummary(mode: ExecMode): string {
  return mode === "full_access"
    ? "自动执行脚本，但危险命令仍会被拒绝"
    : "每次执行脚本前都要你确认";
}

/**
 * 完全权限的完整风险告知（切换前必须展示）。
 *
 * 刻意逐条写清"不变的部分"：这条文案是 Owner 做决定的唯一依据，含糊其辞等于
 * 把他往"以为不问了就什么都能跑"的方向误导。
 */
export const FULL_ACCESS_NOTICE = [
  "完全权限只跳过「逐次确认」这一步，其余保护不变：",
  "· 危险命令（删除系统目录、写 ~/.ssh、读凭据库、curl|sh、eval、强制推送、改 /etc 等）照样被拒绝执行；",
  "· 每次执行前仍会为会话工作区创建快照；",
  "· 每次执行仍会写审计事件，事后可查；",
  "· 关闭这个会话后模式立即失效，不会带到下一个会话。",
].join("\n");

/**
 * 快照保护范围声明（与 runtime 的 SNAPSHOT_SCOPE_NOTICE 同口径）。
 *
 * 双处文案的理由：runtime 的那份会随响应回传（权威），前端这份用于"执行前"就
 * 先告知——不能等执行完才让用户知道哪些路径不受保护。
 */
export const SNAPSHOT_SCOPE_TEXT =
  "撤销只覆盖会话工作区。" +
  "~/.ssh、/etc、其他项目目录、OS 凭据库与远端仓库不在保护范围内，脚本对它们的改动无法撤销。";

/** 切换模式的确认内容（null = 无需额外确认，例如切回默认） */
export function modeSwitchWarning(next: ExecMode): string | null {
  return next === "full_access" ? FULL_ACCESS_NOTICE : null;
}

/** 待确认条目的展示模型 */
export interface PendingConfirmView {
  /** 完整脚本（**不做截断**，UI 直接渲染） */
  script: string;
  /** 是否为只读脚本的首次确认（据此解释"以后免确认"） */
  readonlyFirstTime: boolean;
  /** 主按钮文案 */
  confirmLabel: string;
  /** 说明文字 */
  detail: string;
}

export function pendingConfirmView(input: {
  script: string;
  why: string;
  mode: ExecMode;
}): PendingConfirmView {
  const readonlyFirstTime = input.why === "readonly_first_time";
  return {
    script: input.script,
    readonlyFirstTime,
    confirmLabel: readonlyFirstTime ? "确认并允许多次执行" : "确认并执行",
    detail: readonlyFirstTime
      ? "这是只读命令的首次确认。确认后，本会话内的只读命令（ls/cat/grep/git status 等）将不再询问；写命令仍需每次确认。"
      : "该脚本会修改文件或执行变更操作，仅本次有效。",
  };
}

/** 拒绝（危险规则命中）的展示模型 */
export interface DeniedView {
  title: string;
  /** 逐条命中的规则说明（不合并成一句，用户要能看出具体哪条） */
  reasons: string[];
  /** 是否需要提示"这是硬拒绝，不能通过确认绕过" */
  hardBlock: boolean;
}

export function deniedView(hits: Array<{ id: string; level: string; reason: string }>): DeniedView {
  return {
    title: "命令被拒绝执行",
    reasons: hits.map((hit) => `${hit.reason}（${hit.id}）`),
    hardBlock: true,
  };
}

/** 只读豁免状态的行内提示（null = 不展示，避免噪音） */
export function readonlyExemptHint(args: { mode: ExecMode; readonlyConfirmed: boolean }): string | null {
  if (args.mode === "full_access") return null; // 完全权限下这条提示没有意义
  return args.readonlyConfirmed ? "本会话的只读命令已免确认" : null;
}

/**
 * 执行结果的摘要行（用于聊天流里的内联卡片）。
 *
 * 强调"截断"与"超时"：让用户知道看到的输出不完整，而不是以为脚本只输出了这么多。
 */
export function execResultSummary(result: {
  ok: boolean;
  exit_code: number;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
}): string {
  const parts: string[] = [];
  parts.push(result.ok ? "执行成功" : `执行失败（退出码 ${result.exit_code}）`);
  if (result.timed_out) parts.push("已超时被强制终止");
  if (result.truncated) parts.push("输出过长已截断");
  parts.push(`${(result.duration_ms / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

/**
 * 撤销按钮的可用性（null = 可点）。
 *
 * 无快照时不可点：没有快照就没有可回滚的状态，让按钮可点会变成"点了没反应"。
 */
export function revertDisabledReason(snapshotId: string | null): string | null {
  return snapshotId === null ? "本次执行没有快照（会话未绑定工作区），无法撤销" : null;
}

/** 会话关闭后模式失效的提示（UI 常驻说明，避免用户以为设置会留存） */
export const MODE_NOT_PERSISTED_HINT = "执行模式只在本会话内有效，关闭会话后回到默认（每次命令确认）。";
