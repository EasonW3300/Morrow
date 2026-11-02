/**
 * CapabilityFactory —— 生成闭环编排（票 M2-T3 / Issue #24，PRD §4.2 FR-CAP-1..5）。
 *
 * 七步闭环（每步一事件，失败不抛——结构化落 status=failed + factory_failed 诊断）：
 *   1. 检索  capability.factory_retrieved   复用路径（reused:true）到此收束，不重建
 *   2. 规划  capability.factory_planned     Generator 输出经 plan-schema 校验 +
 *                                           permissions ⊆ grant 越权预检（fail fast）
 *   3. 构建  capability.factory_built       Builder：源码 + 依赖锁 + esbuild 编译验证
 *   4. 验证  capability.factory_verified    Verifier：SandboxRunner 逐条四类测试用例
 *      （失败 → factory_failed 携带逐用例报告 / sandbox_error——无沙箱整体禁用）
 *   5. 提案  （无事件；status=proposed）     验证通过 ≠ 自动注册——注册门语义
 *   6. 确认  capability.factory_confirmed   Owner confirm → PermissionEngine.register
 *                                           （author=ai 默认 disabled 语义不变；注册器
 *                                           的 escalation 复核是第二道闸，竞态安全）
 *   失败    capability.factory_failed       stage + code + detail（+violations/report/
 *                                           raw_tail），失败日志全程可追踪（AC-06）
 *
 * fire-and-forget：submitRequest 落行后后台驱动；runRequest 可被调用方 await（测试与
 * 宿主的确定性入口），in-flight 去重保证同一请求只跑一遍管线。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "../../uuid-v7.ts";
import { buildEventEnvelope } from "../../envelope.ts";
import type { EventLedger } from "../../ledger.ts";
import type { CapabilityRecord } from "@morrow/protocol";
import { CapabilityError, checkPermissionsWithinGrants, type PermissionEngine } from "../engine.ts";
import {
  DefaultCapabilityRetriever,
  type CapabilityRetriever,
  type RetrievalResult,
} from "./retriever.ts";
import { CapabilityBuilder } from "./builder.ts";
import { CapabilityVerifier } from "./verifier.ts";
import { CapabilityFactoryStore, type FactoryRequestRow } from "./store.ts";
import { validateGeneratorOutput } from "./plan-schema.ts";
import type {
  CapabilityGenerator,
  CapabilityGeneratorContext,
} from "./generator.ts";
import type { FactoryRequestError, FactoryRequestStage, FactoryRequestStatus, FactoryRequestView, ValidatedPlan, VerifyReport } from "./types.ts";

/** capability.factory_* 事件族（event_type 清单只增不减） */
export const CAPABILITY_FACTORY_EVENT_TYPES = {
  retrieved: "capability.factory_retrieved",
  planned: "capability.factory_planned",
  built: "capability.factory_built",
  verified: "capability.factory_verified",
  confirmed: "capability.factory_confirmed",
  failed: "capability.factory_failed",
} as const;

const DETAIL_LIMIT = 2000;

export interface CapabilityFactoryOptions {
  dataDir: string;
  ledger: EventLedger;
  replicaId: string;
  capabilities: PermissionEngine;
  /** 生成器接缝（无默认——生产经 PiCapabilityGenerator，测试注入脚本化实现） */
  generator: CapabilityGenerator;
  /** 沙箱 Runner（生产 DockerRunner / 测试 LocalNodeRunner；无沙箱 → 验证整体禁用） */
  runner: import("../../sandbox/runner.ts").SandboxRunner;
  /** 检索器缺省 = DefaultCapabilityRetriever（注册表 + 工厂描述索引 + 记忆注入） */
  retriever?: CapabilityRetriever;
  /** FTS 记忆检索接线（缺省 = 无记忆域；wiring 传 MemoryService.search 投影） */
  memorySearch?: (query: string) => Array<{ content: string; entry_kind: string }>;
  /** 验证 workspace 根（声明 filesystem 的用例挂载；默认 dataDir/workspace） */
  workspaceRoot?: string;
  /** 审计 actor（默认 agent:runtime；confirm 是 Owner 动作固定 actor=owner） */
  actorId?: string;
}

export class CapabilityFactory {
  readonly #store: CapabilityFactoryStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #capabilities: PermissionEngine;
  readonly #generator: CapabilityGenerator;
  readonly #retriever: CapabilityRetriever;
  readonly #builder: CapabilityBuilder;
  readonly #verifier: CapabilityVerifier;
  readonly #workspaceRoot: string;
  readonly #actorId: string;
  readonly #inFlight = new Map<string, Promise<FactoryRequestView>>();
  #closed = false;

  constructor(options: CapabilityFactoryOptions) {
    this.#store = CapabilityFactoryStore.open(options.dataDir);
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#capabilities = options.capabilities;
    this.#generator = options.generator;
    this.#builder = new CapabilityBuilder({ dataDir: options.dataDir });
    this.#verifier = new CapabilityVerifier({ runner: options.runner });
    this.#workspaceRoot = options.workspaceRoot ?? join(options.dataDir, "workspace");
    // workspace 根预创建：容器路径由 docker 自动创建挂载点，本地桩路径需要真实目录作 cwd
    mkdirSync(this.#workspaceRoot, { recursive: true });
    this.#actorId = options.actorId ?? "agent:runtime";
    this.#retriever =
      options.retriever ??
      new DefaultCapabilityRetriever({
        capabilities: options.capabilities,
        describeCapabilities: () => this.describeCapabilities(),
        ...(options.memorySearch !== undefined ? { memorySearch: options.memorySearch } : {}),
      });
  }

  // --- 公共接口 ----------------------------------------------------------------

  /** 提交请求（fire-and-forget）：落行 submitted → 后台驱动管线 → 立即返回 id。 */
  submitRequest(description: string): { requestId: string } {
    this.#assertOpen();
    const trimmed = description.trim();
    if (trimmed.length === 0) {
      throw new CapabilityError("invalid_input", "description must be a non-empty string");
    }
    const requestId = uuidv7();
    const now = new Date().toISOString();
    this.#store.insert({ request_id: requestId, description: trimmed, status: "submitted", stage: "submitted", created_at: now, updated_at: now });
    // fire-and-forget：管线失败全部落 factory_failed 事件与行状态，这里的 catch 只防未处理拒绝
    void this.runRequest(requestId).catch((err: unknown) => {
      console.error("[morrow] capability factory request crashed:", requestId, err);
    });
    return { requestId };
  }

  /** 驱动管线到终态（提交后的后台驱动与测试/宿主的确定性等待共用同一入口）。 */
  async runRequest(requestId: string): Promise<FactoryRequestView> {
    this.#assertOpen();
    const inflight = this.#inFlight.get(requestId);
    if (inflight !== undefined) return inflight;
    const promise = this.#runPipeline(requestId).finally(() => {
      this.#inFlight.delete(requestId);
    });
    this.#inFlight.set(requestId, promise);
    return promise;
  }

  getRequest(requestId: string): FactoryRequestView | null {
    this.#assertOpen();
    const row = this.#store.get(requestId);
    return row === null ? null : projectRow(row);
  }

  /**
   * 注册门（Owner 确认）：proposed → PermissionEngine.register（manifest 全量校验 +
   * permissions ⊆ grant 复核）→ capability.registered（author=ai 默认 disabled）+
   * capability.factory_confirmed。未到 proposed / 已确认 → invalid_state 409；
   * 注册器拒绝（越权竞态）→ 请求转 failed(stage=confirm) 后原样抛出（HTTP 400）。
   */
  confirm(requestId: string, options: { actorId?: "owner" | `contact:${string}`; now?: Date } = {}): {
    request: FactoryRequestView;
    capability: CapabilityRecord;
    eventId: string;
  } {
    this.#assertOpen();
    const row = this.#store.get(requestId);
    if (row === null) {
      throw new CapabilityError("not_found", `factory request "${requestId}" does not exist`);
    }
    if (row.status !== "proposed") {
      throw new CapabilityError(
        "invalid_state",
        `factory request "${requestId}" is ${row.status}, not proposed: verification must pass before Owner confirmation`,
      );
    }
    const plan = parsePlan(row.plan_json);
    if (plan === null) {
      throw new CapabilityError("invalid_state", `factory request "${requestId}" has no validated plan (data corruption)`);
    }
    try {
      const registered = this.#capabilities.register(plan.manifest, { actorId: options.actorId ?? "owner", now: options.now });
      this.#store.update(requestId, {
        status: "confirmed",
        capability_name: registered.record.name,
        updated_at: (options.now ?? new Date()).toISOString(),
      });
      const eventId = this.#append(CAPABILITY_FACTORY_EVENT_TYPES.confirmed, options.actorId ?? "owner", {
        request_id: requestId,
        name: registered.record.name,
        version: registered.record.version,
        author: registered.record.author,
        status: registered.record.status,
        created: registered.created,
      });
      return { request: this.getRequest(requestId) as FactoryRequestView, capability: registered.record, eventId };
    } catch (err) {
      if (err instanceof CapabilityError && err.code !== "invalid_input") {
        // 注册器复核失败（越权竞态/manifest 被篡改）：请求转 failed 并留痕，再抛给 HTTP 层
        const error: FactoryRequestError = { stage: "confirm", code: err.code, detail: err.message.slice(0, DETAIL_LIMIT) };
        if (err.violations !== undefined) error.violations = err.violations;
        this.#store.update(requestId, { status: "failed", error_json: JSON.stringify(error), updated_at: new Date().toISOString() });
        this.#append(CAPABILITY_FACTORY_EVENT_TYPES.failed, options.actorId ?? "owner", {
          request_id: requestId,
          stage: "confirm",
          code: err.code,
          detail: err.message.slice(0, DETAIL_LIMIT),
          ...(err.violations !== undefined ? { violations: err.violations } : {}),
        });
      }
      throw err;
    }
  }

  /** 工厂描述索引（FR-CAP-1：历史产物的 description，确认后才算"已有能力"） */
  describeCapabilities(): Array<{ name: string; description: string | null }> {
    if (this.#closed) return [];
    return this.#store.listConfirmedDescriptions();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  // --- 管线 ---------------------------------------------------------------------

  async #runPipeline(requestId: string): Promise<FactoryRequestView> {
    const row = this.#store.get(requestId);
    if (row === null) {
      throw new CapabilityError("not_found", `factory request "${requestId}" does not exist`);
    }
    if (row.status !== "submitted") {
      return projectRow(row); // 幂等：终态请求不重跑
    }
    try {
      // 1. 检索（FR-CAP-1）
      const retrieval = this.#retriever.retrieve(row.description);
      const retrievalSummary = {
        reused: retrieval.reused,
        matches: retrieval.matches.slice(0, 3),
        memory_hits: retrieval.memoryHits.length,
        considered: retrieval.considered,
      };
      this.#append(CAPABILITY_FACTORY_EVENT_TYPES.retrieved, this.#actorId, { request_id: requestId, ...retrievalSummary });
      if (retrieval.reused) {
        // 复用路径：命中已有能力 → 收束，不重建
        this.#store.update(requestId, {
          status: "reused",
          stage: "retrieved",
          retrieved_json: JSON.stringify(retrievalSummary),
          updated_at: new Date().toISOString(),
        });
        return this.getRequest(requestId) as FactoryRequestView;
      }
      this.#store.update(requestId, {
        stage: "retrieved",
        retrieved_json: JSON.stringify(retrievalSummary),
        updated_at: new Date().toISOString(),
      });

      // 2. 规划（FR-CAP-2）：生成 → schema 校验 → 越权预检
      const grants = this.#capabilities.getGrants();
      const existing = [
        ...this.#capabilities.list().map((record) => ({ name: record.name, description: null as string | null })),
        ...this.describeCapabilities(),
      ];
      const seen = new Set<string>();
      const existingDeduped = existing.filter((item) => (seen.has(item.name) ? false : (seen.add(item.name), true)));
      const generated = await this.#generator.generate({
        description: row.description,
        grants,
        existing: existingDeduped,
        memoryHits: retrieval.memoryHits.map((hit) => ({ content: hit.content, entry_kind: hit.entry_kind })),
      });
      if (!generated.ok) {
        return this.#fail(requestId, "plan", generated.code, generated.detail, {
          ...(generated.raw !== undefined ? { raw_tail: generated.raw.slice(-DETAIL_LIMIT) } : {}),
        });
      }
      const validated = validateGeneratorOutput(generated.output);
      if (!validated.ok) {
        return this.#fail(requestId, "plan", "invalid_output", validated.errors.join("; ").slice(0, DETAIL_LIMIT), {
          raw_tail: generated.raw.slice(-DETAIL_LIMIT),
        });
      }
      const plan = validated.plan;
      const violations = checkPermissionsWithinGrants(plan.manifest.permissions, grants);
      if (violations.length > 0) {
        return this.#fail(
          requestId,
          "plan",
          "escalation",
          `manifest permissions exceed the PermissionGrant (${violations.length} violation(s)): ` +
            violations.map((v) => `${v.dimension}: ${v.reason}`).join("; "),
          { violations },
        );
      }
      this.#store.update(requestId, {
        stage: "planned",
        plan_json: JSON.stringify(plan),
        updated_at: new Date().toISOString(),
      });
      this.#append(CAPABILITY_FACTORY_EVENT_TYPES.planned, this.#actorId, {
        request_id: requestId,
        name: plan.manifest.name,
        version: plan.manifest.version,
        description: plan.description,
        test_counts: countByKind(plan),
        dependencies: plan.dependencies,
      });

      // 3. 构建（FR-CAP-3）
      const built = await this.#builder.build({ requestId, plan });
      if (!built.ok) {
        return this.#fail(requestId, "build", built.code, built.detail, {
          ...(built.diagnostics !== undefined && built.diagnostics.length > 0 ? { raw_tail: built.diagnostics.slice(-DETAIL_LIMIT) } : {}),
        });
      }
      this.#store.update(requestId, { stage: "built", updated_at: new Date().toISOString() });
      this.#append(CAPABILITY_FACTORY_EVENT_TYPES.built, this.#actorId, {
        request_id: requestId,
        package_dir: built.packageDir,
        tool_entry: built.toolEntry,
        dependencies: built.dependencies,
      });

      // 4. 验证（FR-CAP-4）：声明 filesystem 才挂 workspace（同 ToolInvoker 接线口径）
      const needsWorkspace = plan.manifest.permissions.filesystem.length > 0;
      const report = await this.#verifier.verify(
        {
          name: plan.manifest.name,
          verifyEntry: built.verifyEntry,
          ...(needsWorkspace ? { workspaceDir: this.#workspaceRoot, workspaceMode: "rw" as const } : {}),
        },
        plan.testCases,
      );
      this.#store.update(requestId, { report_json: JSON.stringify(report), updated_at: new Date().toISOString() });
      if (!report.ok) {
        const failedCases = report.cases.filter((c) => !c.pass);
        return this.#fail(
          requestId,
          "verify",
          report.sandbox_error !== undefined ? "sandbox_unavailable" : "verification_failed",
          report.sandbox_error ??
            `${failedCases.length}/${report.cases.length} test case(s) failed: ` +
              failedCases.map((c) => `${c.case_id}(${c.kind}): ${c.detail}`).join("; ").slice(0, 800),
          { report },
        );
      }
      this.#append(CAPABILITY_FACTORY_EVENT_TYPES.verified, this.#actorId, {
        request_id: requestId,
        ok: true,
        cases: report.cases.length,
        passed: report.cases.filter((c) => c.pass).length,
        duration_ms: report.duration_ms,
      });

      // 5. 提案：验证通过 ≠ 自动注册——等 Owner confirm
      this.#store.update(requestId, { status: "proposed", stage: "verified", updated_at: new Date().toISOString() });
      return this.getRequest(requestId) as FactoryRequestView;
    } catch (err) {
      // 防御兜底：管线任何未预期异常 → 结构化失败（不向上抛，fire-and-forget 安全）
      const message = err instanceof Error ? err.message : String(err);
      const current = this.#store.get(requestId);
      const lastStage = current?.stage === "submitted" || current === null ? "plan" : (current.stage as FactoryRequestStage);
      const stage: FactoryRequestError["stage"] =
        lastStage === "retrieved" || lastStage === "planned" ? "plan" : lastStage === "built" ? "verify" : "plan";
      return this.#fail(requestId, stage, "internal_error", `unexpected pipeline error: ${message}`.slice(0, DETAIL_LIMIT));
    }
  }

  #fail(
    requestId: string,
    stage: FactoryRequestError["stage"],
    code: string,
    detail: string,
    extra: Pick<FactoryRequestError, "violations" | "report" | "raw_tail"> = {},
  ): FactoryRequestView {
    const error: FactoryRequestError = { stage, code, detail: detail.slice(0, DETAIL_LIMIT), ...extra };
    this.#store.update(requestId, {
      status: "failed",
      error_json: JSON.stringify(error),
      updated_at: new Date().toISOString(),
    });
    this.#append(CAPABILITY_FACTORY_EVENT_TYPES.failed, this.#actorId, {
      request_id: requestId,
      stage,
      code,
      detail: error.detail,
      ...(extra.violations !== undefined ? { violations: extra.violations } : {}),
      ...(extra.report !== undefined ? { report: extra.report } : {}),
      ...(extra.raw_tail !== undefined ? { raw_tail: extra.raw_tail } : {}),
    });
    return this.getRequest(requestId) as FactoryRequestView;
  }

  #append(eventType: string, actorId: string, payload: Record<string, unknown>): string {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: actorId as "owner" | `agent:${string}` | `contact:${string}`,
      eventType,
      payload,
    });
    this.#ledger.append(envelope);
    return envelope.event_id;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("capability factory is closed");
  }
}

// --- 投影辅助 -------------------------------------------------------------------

function projectRow(row: FactoryRequestRow): FactoryRequestView {
  const plan = parsePlan(row.plan_json);
  const retrieved = parseJson<RetrievalResult & { memory_hits?: number; considered?: number }>(row.retrieved_json);
  return {
    request_id: row.request_id,
    description: row.description,
    status: row.status as FactoryRequestStatus,
    stage: row.stage as FactoryRequestStage,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(plan !== null
      ? {
          manifest: plan.manifest,
          description_of_capability: plan.description,
          dependencies: plan.dependencies,
          test_cases: plan.testCases.map((c) => ({ case_id: c.case_id, kind: c.kind })),
        }
      : {}),
    ...(parseJson<VerifyReport>(row.report_json) !== null ? { report: parseJson<VerifyReport>(row.report_json) as VerifyReport } : {}),
    ...(parseJson<FactoryRequestError>(row.error_json) !== null
      ? { error: parseJson<FactoryRequestError>(row.error_json) as FactoryRequestError }
      : {}),
    ...(row.capability_name !== null ? { capability_name: row.capability_name } : {}),
    ...(retrieved !== null && retrieved.reused === true
      ? { reuse_matches: (retrieved.matches ?? []).map((m) => ({ source: m.source, ...(m.name !== undefined ? { name: m.name } : {}), score: m.score })) }
      : {}),
  };
}

function parsePlan(planJson: string | null): ValidatedPlan | null {
  return parseJson<ValidatedPlan>(planJson);
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function countByKind(plan: ValidatedPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of plan.testCases) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  return counts;
}
