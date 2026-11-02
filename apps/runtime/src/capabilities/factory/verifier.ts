/**
 * Verifier（票 M2-T3 / Issue #24，FR-CAP-4 隔离验证）：SandboxRunner 依次跑四类测试用例
 * （positive / negative / privilege-escalation / fault），全部通过 → 验证报告；任一失败 →
 * 报告 + 失败详情（AC-06 失败日志可追踪）。
 *
 * 「测试用例即容器内断言脚本」：每条用例经 SandboxRunner 注入 verify-entry 断言脚本
 * （运行时自有模板，Builder 写入包目录），容器/本地桩执行同一脚本并按 expect 裁决
 * pass/fail——Verifier 只聚合裁决，不复刻断言逻辑（双路径零漂移）。
 *
 * 执行次序固定（检索上下文的可复现性）：用例按生成顺序逐条跑；SandboxError（沙箱
 * 不可用/镜像拉取失败等**环境**故障）短路返回 sandbox_error——无沙箱则整体禁用，
 * 不产生半份用例报告冒充验证结果。工具侧失败（tool_error/exit nonzero/超时）是
 * **用例**失败：记入 cases 后继续，报告逐用例可追踪。
 */

import { normalizeSandboxContract, type SandboxContract } from "../../sandbox/contract.ts";
import { SandboxError, type SandboxResult, type SandboxRunner } from "../../sandbox/runner.ts";
import type { FactoryTestCaseSpec, TestCaseVerdict, VerifyReport } from "./types.ts";

export interface VerifyInput {
  /** 目标能力名（断言脚本包名后缀 -verify） */
  name: string;
  /** Builder 产出的断言脚本入口（src/verify-entry.ts） */
  verifyEntry: string;
  /** workspace 目录（声明 filesystem 权限时挂载；缺省不挂载） */
  workspaceDir?: string;
  workspaceMode?: "rw" | "ro";
}

export interface CapabilityVerifierOptions {
  runner: SandboxRunner;
  /** 沙箱资源限额（缺省 = T2 默认：1 CPU / 256MB / 30s） */
  cpus?: number;
  memoryMb?: number;
  timeoutMs?: number;
}

export class CapabilityVerifier {
  readonly #runner: SandboxRunner;
  readonly #cpus?: number;
  readonly #memoryMb?: number;
  readonly #timeoutMs?: number;

  constructor(options: CapabilityVerifierOptions) {
    this.#runner = options.runner;
    this.#cpus = options.cpus;
    this.#memoryMb = options.memoryMb;
    this.#timeoutMs = options.timeoutMs;
  }

  async verify(input: VerifyInput, cases: readonly FactoryTestCaseSpec[]): Promise<VerifyReport> {
    const started = Date.now();
    const contract: SandboxContract = normalizeSandboxContract({
      type: "container",
      resources: {
        ...(this.#cpus !== undefined ? { cpus: this.#cpus } : {}),
        ...(this.#memoryMb !== undefined ? { memoryMb: this.#memoryMb } : {}),
        ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
      },
    });
    const pkg = {
      name: `${input.name}-verify`,
      kind: "typescript" as const,
      entry: input.verifyEntry,
      ...(input.workspaceDir !== undefined ? { workspaceDir: input.workspaceDir } : {}),
      ...(input.workspaceMode !== undefined ? { workspaceMode: input.workspaceMode } : {}),
    };

    const outcomes: VerifyReport["cases"] = [];
    for (const spec of cases) {
      try {
        const result = await this.#runner.run(pkg, buildCaseInput(spec), contract);
        outcomes.push(projectCase(spec, result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof SandboxError) {
          // 环境故障短路：无沙箱整体禁用（FR-CAP-4），不冒充用例结果
          return { ok: false, cases: outcomes, duration_ms: Date.now() - started, sandbox_error: `${err.code}: ${message}` };
        }
        // 非沙箱异常（防御）：按用例失败记录后继续
        outcomes.push({
          case_id: spec.case_id,
          kind: spec.kind,
          pass: false,
          detail: `verifier execution error: ${message}`,
          exit_code: -1,
          timed_out: false,
          duration_ms: 0,
        });
      }
    }
    return {
      ok: outcomes.length === cases.length && outcomes.every((c) => c.pass),
      cases: outcomes,
      duration_ms: Date.now() - started,
    };
  }
}

/** 断言脚本 stdin 规格（case_id/kind 供裁决明细回链） */
function buildCaseInput(spec: FactoryTestCaseSpec): unknown {
  return { case_id: spec.case_id, kind: spec.kind, input: spec.input, expect: spec.expect };
}

function projectCase(spec: FactoryTestCaseSpec, result: SandboxResult): VerifyReport["cases"][number] {
  const base = {
    case_id: spec.case_id,
    kind: spec.kind,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    duration_ms: result.duration_ms,
    ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
  };
  if (!result.ok) {
    return {
      ...base,
      pass: false,
      detail: `sandbox run failed (${result.error_code ?? "unknown"}): ${result.error ?? result.stderr.slice(-300)}`,
    };
  }
  const verdict = result.result as Partial<TestCaseVerdict> | undefined;
  if (
    typeof verdict !== "object" ||
    verdict === null ||
    typeof verdict.case_id !== "string" ||
    typeof verdict.pass !== "boolean" ||
    typeof verdict.detail !== "string"
  ) {
    return { ...base, pass: false, detail: `assertion script returned malformed verdict: ${JSON.stringify(result.result)?.slice(0, 200)}` };
  }
  if (verdict.case_id !== spec.case_id) {
    return { ...base, pass: false, detail: `verdict case_id "${verdict.case_id}" does not match requested "${spec.case_id}" (protocol confusion)` };
  }
  return { ...base, pass: verdict.pass, detail: verdict.detail };
}
