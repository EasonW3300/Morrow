/**
 * Generator 输出 schema 校验（票 M2-T3 / Issue #24，FR-CAP-2/3/4）。
 *
 * 模型输出不可信：本模块是 factory 计划阶段的第一道闸——逐字段校验并把**全部**问题
 * 一次性列为诊断（模型/调用方可据此整批修复），绝不抛异常（坏输出 → factory 阶段
 * 失败事件 capability.factory_failed(stage=plan)，流程继续而非进程崩溃）。
 *
 * manifest 域校验复用 M2-T1 的 validateManifest（name/version 形态、五维齐全、
 * sandbox 枚举、author=ai 政策：tests 非空 + sandbox.type 不得为 none）——单一真相源，
 * 工厂产物与手工注册走同一套规则。
 *
 * 工厂追加的三条政策：
 *   1. 四类测试用例各至少一条（FR-CAP-4：单元/反向/越权/故障）；
 *   2. 期望方向固定：positive→success，negative/privilege-escalation/fault→failure
 *      （越权用例即「拒绝断言」——期望失败是 100% 阻断的可验证形态）；
 *   3. 依赖版本锁死精确 semver（FR-CAP-3；^ ~ * latest 范围一律拒绝）。
 */

import { validateManifest } from "../engine.ts";
import type { ValidatedPlan, FactoryTestCaseKind, GeneratorOutput } from "./types.ts";
import { FACTORY_TEST_CASE_KINDS } from "./types.ts";

const NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** 依赖锁：精确 semver（不含 ^ ~ * x 区间；prerelease/buildmetadata 允许） */
const PINNED_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CASE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** 生成源码打包契约：默认导出 run 函数（entry/verify 模板都 import 它） */
const RUN_EXPORT_RE = /export\s+(?:async\s+)?function\s+run\b/;

export type PlanValidationResult = { ok: true; plan: ValidatedPlan } | { ok: false; errors: string[] };

export function validateGeneratorOutput(input: unknown): PlanValidationResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["generator output must be a single JSON object"] };
  }
  const body = input as Partial<GeneratorOutput> & Record<string, unknown>;

  const name = body.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    errors.push("name must be a lowercase dotted identifier like `docx-to-markdown`");
  }
  const version = body.version;
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    errors.push("version must be semantic version like `1.0.0`");
  }
  const description = body.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push("description must be a non-empty string (one line: what the tool does)");
  }
  if (typeof body.permissions !== "object" || body.permissions === null || Array.isArray(body.permissions)) {
    errors.push("permissions must be an object with all five dimensions");
  }
  if (!isPlainObject(body.input_schema)) errors.push("input_schema must be a JSON Schema object");
  if (!isPlainObject(body.output_schema)) errors.push("output_schema must be a JSON Schema object");
  if (typeof body.sandbox !== "object" || body.sandbox === null || Array.isArray(body.sandbox)) {
    errors.push("sandbox must be an object with type/network/filesystem");
  }
  if (typeof body.source !== "string" || body.source.trim().length === 0) {
    errors.push("source must be a non-empty TypeScript module string");
  } else if (!RUN_EXPORT_RE.test(body.source)) {
    errors.push('source must export a run function: "export async function run(input: T): Promise<R>"');
  }

  // 依赖锁（FR-CAP-3）：每一条都必须是精确版本
  const dependencies: Record<string, string> = {};
  if (!isPlainObject(body.dependencies)) {
    errors.push("dependencies must be an object mapping package name to exact version (use {} for zero deps)");
  } else {
    for (const [dep, ver] of Object.entries(body.dependencies)) {
      if (dep.trim().length === 0) {
        errors.push("dependencies keys must be non-empty package names");
        continue;
      }
      if (typeof ver !== "string" || !PINNED_VERSION_RE.test(ver)) {
        errors.push(`dependency "${dep}" must be pinned to an exact version like "1.2.3" (got "${String(ver)}"); ranges (^ ~ * x latest) are rejected`);
        continue;
      }
      dependencies[dep] = ver;
    }
  }

  // 测试用例（FR-CAP-2/4）：case_id 唯一 + 方向固定 + 四类齐全
  const rawCases = body.test_cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    errors.push("test_cases must be a non-empty array with at least one case of each kind (positive/negative/privilege-escalation/fault)");
  } else {
    const seen = new Set<string>();
    const kinds = new Set<FactoryTestCaseKind>();
    rawCases.forEach((raw, index) => {
      const label = `test_cases[${index}]`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        errors.push(`${label} must be an object`);
        return;
      }
      const c = raw as unknown as Record<string, unknown>;
      const caseId = c.case_id;
      if (typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) {
        errors.push(`${label}.case_id must match /^[A-Za-z0-9._-]{1,128}$/`);
      } else if (seen.has(caseId)) {
        errors.push(`${label}.case_id "${caseId}" is duplicated; case_id must be unique`);
      } else {
        seen.add(caseId);
      }
      const kind = c.kind;
      if (typeof kind !== "string" || !(FACTORY_TEST_CASE_KINDS as readonly string[]).includes(kind)) {
        errors.push(`${label}.kind must be one of ${FACTORY_TEST_CASE_KINDS.join(" | ")}`);
        return;
      }
      kinds.add(kind as FactoryTestCaseKind);
      if (!("input" in c)) {
        errors.push(`${label}.input is required (the value fed to the tool; use null for none)`);
      }
      const expect = c.expect;
      if (typeof expect !== "object" || expect === null || Array.isArray(expect)) {
        errors.push(`${label}.expect must be an object with outcome ("success" | "failure")`);
        return;
      }
      const outcome = (expect as Record<string, unknown>).outcome;
      if (outcome !== "success" && outcome !== "failure") {
        errors.push(`${label}.expect.outcome must be "success" or "failure"`);
        return;
      }
      const required = kind === "positive" ? "success" : "failure";
      if (outcome !== required) {
        errors.push(
          `${label} (${kind}): expect.outcome must be "${required}" — ` +
            (kind === "positive"
              ? "positive cases assert the tool succeeds"
              : `${kind} cases assert refusal (escalation must be blocked, never succeed)`),
        );
      }
      const errorContains = (expect as Record<string, unknown>).errorContains;
      if (errorContains !== undefined && typeof errorContains !== "string") {
        errors.push(`${label}.expect.errorContains must be a string when present`);
      }
    });
    for (const requiredKind of FACTORY_TEST_CASE_KINDS) {
      if (!kinds.has(requiredKind)) {
        errors.push(`test_cases must include at least one "${requiredKind}" case (FR-CAP-4 four-kind suite)`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // manifest 域复用 M2-T1 单一校验入口（author=ai 政策在内：tests 非空 + sandbox≠none）
  let manifest;
  try {
    manifest = validateManifest({
      name,
      version,
      author: "ai",
      runtime: "typescript",
      permissions: body.permissions,
      input_schema: body.input_schema,
      output_schema: body.output_schema,
      sandbox: body.sandbox,
      tests: (rawCases as Array<{ case_id: string }>).map((c) => c.case_id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`manifest rejected by validateManifest: ${message}`] };
  }

  return {
    ok: true,
    plan: {
      manifest,
      description: (description as string).trim(),
      dependencies,
      source: body.source as string,
      testCases: rawCases as GeneratorOutput["test_cases"],
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
