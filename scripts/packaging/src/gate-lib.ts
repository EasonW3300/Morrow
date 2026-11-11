/**
 * 冒烟门公共库（T9 / Issue #10）：门禁 CLI（gate.ts）与单测共用。
 *
 * 门禁判定口径（票面四项清单）：
 * - #1 启动、#2 健康探针、#3 sidecar 通信：CI 内以独立探针验证（standalone/sidecar 探针）；
 * - #4 麦克风捕获探针 + 桌面 GUI 真机启动：**真机门禁项**——CI runner 无音频设备与 GUI
 *   会话，由 T10 在真机执行，报告标注 deferred 且不计入 CI 门禁判定（gateVerdict）。
 *
 * 负向路径（AC 第 3 条）：产物校验失败（missing/empty）→ verdict fail → CLI 退出非 0。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// --- 产物校验 ---------------------------------------------------------------

export interface ArtifactCheck {
  /** 产物语义名（报告/错误信息用） */
  label: string;
  path: string;
  /** file = 必须存在的文件；dir-nonempty = 必须存在且至少含一个条目的目录（bundle 产物名带版本号，按目录校验） */
  kind: "file" | "dir-nonempty";
}

export interface ArtifactFailure {
  label: string;
  path: string;
  reason: string;
}

/** 校验产物清单；缺失/空目录进失败列表（不抛错，由调用方决定退出码） */
export function runArtifactChecks(checks: ArtifactCheck[]): ArtifactFailure[] {
  const failures: ArtifactFailure[] = [];
  for (const check of checks) {
    let stat: { isFile(): boolean; isDirectory(): boolean };
    try {
      stat = statSync(check.path);
    } catch {
      failures.push({ label: check.label, path: check.path, reason: `missing ${check.kind}: ${check.path}` });
      continue;
    }
    if (check.kind === "file" && !stat.isFile()) {
      failures.push({ label: check.label, path: check.path, reason: `not a file: ${check.path}` });
      continue;
    }
    if (check.kind === "dir-nonempty") {
      if (!stat.isDirectory()) {
        failures.push({ label: check.label, path: check.path, reason: `not a directory: ${check.path}` });
        continue;
      }
      if (readdirSync(check.path).length === 0) {
        failures.push({ label: check.label, path: check.path, reason: `empty directory: ${check.path}` });
      }
    }
  }
  return failures;
}

/** 在产物目录中发现唯一的 runtime 单二进制（morrow-runtime-*）；0 个或多个都抛错 */
export function findRuntimeBinary(dir: string): string {
  const matches = readdirSync(dir).filter((name) => name.startsWith("morrow-runtime-"));
  if (matches.length === 0) {
    throw new Error(`no morrow-runtime-* binary in ${dir} (artifact upload step removed?)`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous morrow-runtime-* binaries in ${dir}: ${matches.join(", ")}`);
  }
  return join(dir, matches[0]);
}

// --- verdict 与报告 -----------------------------------------------------------

export type GateCheckStatus = "pass" | "fail" | "deferred";

export interface GateCheckItem {
  /** 票面四项清单 id */
  id: "startup" | "health" | "sidecar" | "microphone";
  label: string;
  status: GateCheckStatus;
  executor: "CI" | "真机（T10）";
  detail?: string;
}

export interface GateVerdictInput {
  checks: GateCheckItem[];
  artifactFailures?: ArtifactFailure[];
}

/**
 * CI 门禁判定：无产物失败，且所有 executor = "CI" 的清单项都 pass。
 * 真机项（executor = 真机（T10））的 deferred 不影响 CI 判定；
 * 但 CI 项不允许以 deferred 逃逸（探针步骤被移除时必须红）。
 */
export function gateVerdict(input: GateVerdictInput): "pass" | "fail" {
  if (input.artifactFailures !== undefined && input.artifactFailures.length > 0) return "fail";
  for (const check of input.checks) {
    if (check.executor === "真机（T10）") continue;
    if (check.status !== "pass") return "fail";
  }
  return "pass";
}

export interface GateReportInput extends GateVerdictInput {
  platform: string;
  arch: string;
  startedAt: string;
  elapsedMs: number;
  binaryPath?: string;
  bunVersion?: string;
  /** 本机快速门禁未提供 bundle 时的说明 */
  notes?: string[];
}

/** 门禁报告（markdown）：job summary 与归档 artifact 同源 */
export function buildGateReport(input: GateReportInput): string {
  const verdict = gateVerdict(input);
  const failures = input.artifactFailures ?? [];
  const lines: string[] = [];

  lines.push(`# Morrow M0 冒烟门报告（T9 / Issue #10）`);
  lines.push("");
  lines.push(`- 平台：\`${input.platform}-${input.arch}\``);
  lines.push(`- 时间：${input.startedAt}（耗时 ${(input.elapsedMs / 1000).toFixed(1)}s）`);
  if (input.binaryPath !== undefined) lines.push(`- runtime 二进制：\`${input.binaryPath}\``);
  if (input.bunVersion !== undefined) lines.push(`- bun：${input.bunVersion}`);
  lines.push(`- **结论：${verdict === "pass" ? "PASS" : "FAIL"}**`);
  lines.push("");

  lines.push("## 产物校验");
  if (failures.length === 0) {
    lines.push("全部就位。");
  } else {
    lines.push(`缺失 ${failures.length} 项：`);
    for (const failure of failures) lines.push(`- **${failure.label}**: ${failure.reason}`);
  }
  lines.push("");

  lines.push("## 清单（票面四项）");
  lines.push("");
  lines.push("| # | 清单项 | 结果 | 执行环境 | 说明 |");
  lines.push("|---|--------|------|----------|------|");
  const numbering: Record<GateCheckItem["id"], string> = {
    startup: "1",
    health: "2",
    sidecar: "3",
    microphone: "4",
  };
  for (const check of input.checks) {
    const status = check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "待真机";
    lines.push(
      `| ${numbering[check.id]} | ${check.label} | ${status} | ${check.executor} | ${check.detail ?? ""} |`,
    );
  }
  lines.push("");
  lines.push(
    "> **真机门禁项边界**：CI runner 无音频设备与 GUI 会话，桌面 GUI 真机启动与麦克风捕获探针" +
      "（#4 及桌面 GUI 启动）为真机门禁项，由 T10 在真机执行，本报告标注「待真机」且**不计入 CI 门禁判定**。",
  );
  if (input.notes !== undefined && input.notes.length > 0) {
    lines.push("");
    for (const note of input.notes) lines.push(`> 备注：${note}`);
  }
  lines.push("");
  lines.push(`gate-result: ${verdict}`);
  return lines.join("\n");
}

// --- 汇总报告（report job） -----------------------------------------------------

export interface AssembledGateReport {
  ok: boolean;
  markdown: string;
}

/**
 * 聚合各平台门禁报告（gate-report-<platform>.md）为最终报告。
 * 任一平台报告缺失或其 gate-result 非 pass → ok = false（门禁红）。
 * 真机门禁项边界注记随汇总报告传播。
 */
export function assembleGateReports(dir: string, expectedPlatforms: string[]): AssembledGateReport {
  const rows: string[] = [];
  let ok = true;
  for (const platform of expectedPlatforms) {
    const path = join(dir, `gate-report-${platform}.md`);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      rows.push(`| ${platform} | **MISSING** | 报告缺失（${path}）——产物或步骤被移除 |`);
      ok = false;
      continue;
    }
    const matches = [...content.matchAll(/^gate-result: (pass|fail)\s*$/gm)];
    const result = matches.length > 0 ? matches[matches.length - 1][1] : "fail";
    if (result !== "pass") ok = false;
    rows.push(`| ${platform} | ${result.toUpperCase()} | ${path} |`);
  }

  const lines: string[] = [];
  lines.push("# Morrow M0 冒烟门汇总报告（T9 / Issue #10）");
  lines.push("");
  lines.push("| 平台 | 判定 | 报告 |");
  lines.push("|------|------|------|");
  for (const row of rows) lines.push(row);
  lines.push("");
  lines.push(
    "> **真机门禁项边界**：CI runner 无音频设备与 GUI 会话，桌面 GUI 真机启动与麦克风捕获探针" +
      "为真机门禁项，由 T10 在真机执行，不计入 CI 门禁判定（见各平台报告清单 #4）。",
  );
  lines.push("");
  lines.push(`gate-result: ${ok ? "pass" : "fail"}`);
  return { ok, markdown: lines.join("\n") };
}
