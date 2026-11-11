/**
 * 能力工厂共享类型（票 M2-T3 / Issue #24，PRD §4.2 FR-CAP-1..5 七步闭环）。
 *
 * 工厂四阶段（Generator → Builder → Verifier → 注册门）之间只传本文件的类型：
 *   GeneratorOutput  模型输出的原始计划（未校验）
 *   ValidatedPlan    schema 校验后的计划（manifest v1 + 四类测试用例 + 依赖锁）
 *   TestCaseSpec     测试用例即容器内断言脚本的 stdin 契约（Verifier 逐条注入）
 * 失败一律结构化（不抛）——各阶段失败经 CapabilityFactory 落 capability.factory_failed。
 */

import type { CapabilityManifest, CapabilityPermissions } from "@morrow/protocol";

/** 四类测试用例（FR-CAP-4：单元/反向/越权/故障——正样例之外全为「必须失败」断言） */
export type FactoryTestCaseKind = "positive" | "negative" | "privilege-escalation" | "fault";

export const FACTORY_TEST_CASE_KINDS: readonly FactoryTestCaseKind[] = [
  "positive",
  "negative",
  "privilege-escalation",
  "fault",
];

/**
 * 单条测试用例 = Verifier 容器内断言脚本的 stdin 规格：
 *   positive              期望成功（result 可选深比对）
 *   negative              期望失败（反向：非法输入必须被拒）
 *   privilege-escalation  期望失败（越权企图必须被拒——工具自拒或沙箱阻断，二任即阻断）
 *   fault                 期望失败（故障注入：依赖出错时必须结构化失败而非挂死）
 */
export interface FactoryTestCaseSpec {
  case_id: string;
  kind: FactoryTestCaseKind;
  input: unknown;
  expect: {
    outcome: "success" | "failure";
    /** outcome=success 时的期望结果（缺省 = 只要求成功，不比对内容） */
    result?: unknown;
    /** outcome=failure 时错误消息必须包含的子串（缺省 = 只要求失败） */
    errorContains?: string;
  };
}

/** 容器内断言脚本的 stdout 结果（协议信封 result 字段） */
export interface TestCaseVerdict {
  case_id: string;
  pass: boolean;
  detail: string;
}

/**
 * Generator 原始输出（未校验）。沙箱声明放宽到 CapabilitySandboxSpec 全集——
 * author=ai 的 sandbox.type=none 由 plan-schema / validateManifest 拒绝。
 */
export interface GeneratorOutput {
  name: string;
  version: string;
  /** 工厂侧能力描述（注册表 manifest 无此字段；存入工厂描述索引供 FR-CAP-1 检索复用） */
  description: string;
  permissions: CapabilityPermissions;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  sandbox: CapabilityManifest["sandbox"];
  /** 依赖锁：精确版本（FR-CAP-3；范围/^~/* 一律拒绝） */
  dependencies: Record<string, string>;
  /** 生成的 TS 源码：必须 `export async function run(input)`（Builder/Verifier 打包契约） */
  source: string;
  test_cases: FactoryTestCaseSpec[];
}

export type GeneratorFailureCode = "no_output" | "invalid_output" | "runtime_error";

/** generate 的结构化结果：失败不抛（工厂落 factory_failed 事件） */
export type GeneratorResult =
  | { ok: true; output: GeneratorOutput; raw: string }
  | { ok: false; code: GeneratorFailureCode; detail: string; raw?: string };

/** schema 校验通过的计划（Builder/Verifier/注册门的唯一输入形态） */
export interface ValidatedPlan {
  /** author=ai + runtime=typescript 的 manifest v1（tests = case id 有序列表） */
  manifest: CapabilityManifest;
  description: string;
  dependencies: Record<string, string>;
  source: string;
  testCases: FactoryTestCaseSpec[];
}

// --- 请求生命周期 -------------------------------------------------------------

/** 请求状态（proposed = 验证通过待 Owner 确认；确认门语义见 service.ts） */
export type FactoryRequestStatus = "submitted" | "reused" | "proposed" | "failed" | "confirmed";

/** 进度阶段（stage 与 status 正交：failed 时 stage 指失败发生点） */
export type FactoryRequestStage = "submitted" | "retrieved" | "planned" | "built" | "verified";

/** capability.factory_failed 的结构化诊断 */
export interface FactoryRequestError {
  stage: "plan" | "build" | "verify" | "confirm";
  code: string;
  detail: string;
  /** plan 阶段越权时的逐维逐项超界原因 */
  violations?: Array<{ dimension: string; requested: string; reason: string }>;
  /** verify 阶段的逐用例结果（AC-06 失败日志可追踪） */
  report?: VerifyReport;
  /** 模型原始输出尾段（invalid_output / no_output 时辅助诊断） */
  raw_tail?: string;
}

/** Verifier 报告（factory_verified / factory_failed payload 投影） */
export interface VerifyReport {
  ok: boolean;
  cases: Array<{
    case_id: string;
    kind: FactoryTestCaseKind;
    pass: boolean;
    detail: string;
    exit_code: number;
    timed_out: boolean;
    duration_ms: number;
    error_code?: string;
  }>;
  duration_ms: number;
  /** 沙箱环境故障（sandbox_unavailable / image_pull_failed 等）——无沙箱整体禁用（FR-CAP-4） */
  sandbox_error?: string;
}

/** GET /v1/capabilities/requests/:id 投影 */
export interface FactoryRequestView {
  request_id: string;
  description: string;
  status: FactoryRequestStatus;
  stage: FactoryRequestStage;
  created_at: string;
  updated_at: string;
  manifest?: CapabilityManifest;
  description_of_capability?: string;
  test_cases?: Array<{ case_id: string; kind: FactoryTestCaseKind }>;
  report?: VerifyReport;
  error?: FactoryRequestError;
  dependencies?: Record<string, string>;
  /** confirmed 后的注册能力名（== manifest.name） */
  capability_name?: string;
  /** reused 时的命中摘要 */
  reuse_matches?: Array<{ source: string; name?: string; score: number }>;
}
