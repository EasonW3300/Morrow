/**
 * 智能安装服务（票 M7-B-T4 / Issue #72）：四道门的编排。
 *
 * 服务只做编排与审计，三个外部副作用各自有接缝：
 *   - 文档抓取：`fetchDocument`（SSRF 防护在 doc-fetch.ts）
 *   - 提案生成：`ProposalGenerator`（生产 = Provider 一次 prompt；测试 = 脚本）
 *   - 落地：`materialize`（组合 → SkillService；新建工具 → Tool Factory）
 *
 * 「未确认不落地」的实现方式是**状态机 + 显式 confirm**：generate 只写一条
 * status=pending 的提案；confirm 把状态推到 confirmed 并调用落地；落地失败推
 * failed 并记原因（不留半成品：proposal 仍可见，但没有任何注册产物）。
 *
 * 审计事件：skill.proposal_created / skill.proposal_confirmed / skill.proposal_rejected /
 * skill.proposal_materialized / skill.doc_fetch（每次抓取一条，FR-B11）
 */

import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { assessDocument, fetchDocument, type DocFetchResult, type DocFetcherOptions } from "./doc-fetch.ts";
import {
  ProposalError,
  ProposalStore,
  newProposalId,
  normalizeProposalPermissions,
  permissionEscalations,
  validateProposalShape,
  type InstallProposal,
  type ProposalGenerator,
  type ProposalStatus,
} from "./proposal.ts";
import type { SkillPackagePermissions } from "./manifest.ts";

export const PROPOSAL_EVENT_TYPES = {
  docFetch: "skill.doc_fetch",
  created: "skill.proposal_created",
  confirmed: "skill.proposal_confirmed",
  rejected: "skill.proposal_rejected",
  materialized: "skill.proposal_materialized",
} as const;

/** 落地产物（由调用方决定走 Skill 还是 Tool Factory） */
export interface MaterializeOutcome {
  kind: "skill" | "factory_request";
  id: string;
}

export interface InstallProposalServiceDeps {
  store: ProposalStore;
  ledger: EventLedger;
  replicaId: string;
  generator: ProposalGenerator;
  /** 现有能力清单（供生成器判断能否纯组合，也用于校验编造的能力名） */
  existingCapabilities: () => Array<{ name: string; description: string | null }>;
  /** 当前五维授权面（提案权限的硬上界提示） */
  grants: () => SkillPackagePermissions;
  /**
   * 落地接缝：确认后把提案变成真实产物。
   * 组合 → SkillService 建声明式 skill；新工具 → Tool Factory 的 request 闭环。
   */
  materialize: (proposal: InstallProposal) => Promise<MaterializeOutcome>;
  /** 抓取接缝（测试注入，零网络） */
  fetchDocument?: (url: string) => Promise<DocFetchResult>;
  fetchOptions?: DocFetcherOptions;
  now?: () => Date;
}

export class InstallProposalService {
  readonly #deps: InstallProposalServiceDeps;
  readonly #now: () => Date;

  constructor(deps: InstallProposalServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * 由文档生成提案（第一道门）。**不产生任何注册**。
   *
   * 三种来源在这里归一成 (sourceKind, sourceRef, text)：
   *   - upload：fileName + 文件内容（内容已由 HTTP 层读入）
   *   - paste： "pasted text" + 正文
   *   - url：URL + 抓取结果（抓取失败直接报错，不产半成品提案）
   */
  async propose(input: {
    sourceKind: "upload" | "paste" | "url";
    sourceRef: string;
    text?: string;
    url?: string;
  }): Promise<{ proposal: InstallProposal; doc_fetch: DocFetchResult | null }> {
    let text = input.text ?? "";
    let sourceRef = input.sourceRef;
    let docFetch: DocFetchResult | null = null;

    if (input.url !== undefined && input.url.trim().length > 0) {
      const fetcher =
        this.#deps.fetchDocument ??
        ((url: string) => fetchDocument(url, this.#deps.fetchOptions ?? {}));
      docFetch = await fetcher(input.url.trim());
      // 每次抓取都写审计（成功与失败都写：失败原因本身就是安全信号）
      this.#append(PROPOSAL_EVENT_TYPES.docFetch, {
        url: input.url.trim(),
        host: docFetch.host,
        ok: docFetch.ok,
        ...(docFetch.ok
          ? {
              bytes: docFetch.bytes,
              content_type: docFetch.content_type,
              addresses: docFetch.addresses,
              duration_ms: docFetch.duration_ms,
            }
          : { code: docFetch.code, message: docFetch.message, duration_ms: docFetch.duration_ms }),
      });
      if (!docFetch.ok) {
        throw new ProposalError("bad_document", `文档抓取失败（${docFetch.code}）：${docFetch.message}`);
      }
      text = docFetch.text;
      sourceRef = docFetch.url;
    }

    const assessment = assessDocument(text);
    if (!assessment.usable) {
      // 坏输入：可读失败，且**不**写提案行（不留半成品）
      throw new ProposalError("bad_document", assessment.reason);
    }

    const existing = this.#deps.existingCapabilities();
    const grants = this.#deps.grants();
    let generated: Awaited<ReturnType<ProposalGenerator["generate"]>>;
    try {
      generated = await this.#deps.generator.generate({
        document: text,
        sourceKind: input.sourceKind,
        sourceRef,
        existingCapabilities: existing,
        grants,
      });
    } catch (error) {
      throw new ProposalError(
        "generation_failed",
        `提案生成失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const validation = validateProposalShape(generated, existing.map((capability) => capability.name));
    if (!validation.ok) {
      throw new ProposalError("invalid_proposal", `LLM 输出不是可用的提案：${validation.problems.join("; ")}`);
    }

    const permissions = normalizeProposalPermissions(generated.permissions);
    const escalations = permissionEscalations(permissions, grants);
    // 超权**不**在提案阶段拒绝（Owner 可能正是想先扩授权），但必须如实记录在
    // uncertainties 里，否则确认时就是"静默扩权"。
    const uncertainties = [...(generated.uncertainties ?? [])];
    if (escalations.length > 0) {
      uncertainties.push(
        `提案权限超出当前授权面：${escalations
          .map((item) => `${item.dimension}(${item.requested.join(", ")})`)
          .join("; ")}——需先在「能力授权」里放行，否则落地会被拒。`,
      );
    }

    const now = this.#now().toISOString();
    const proposal: InstallProposal = {
      proposal_id: newProposalId(),
      source_kind: input.sourceKind,
      source_ref: sourceRef,
      source_bytes: Buffer.byteLength(text, "utf8"),
      name: generated.name,
      title: generated.title,
      description: generated.description,
      capabilities: generated.capabilities,
      new_tools: generated.new_tools,
      permissions,
      examples: generated.examples,
      uncertainties,
      status: "pending",
      created_at: now,
      updated_at: now,
      materialized_as: null,
      error: null,
    };
    this.#deps.store.insert(proposal);
    this.#append(PROPOSAL_EVENT_TYPES.created, {
      proposal_id: proposal.proposal_id,
      source_kind: proposal.source_kind,
      source_ref: proposal.source_ref,
      source_bytes: proposal.source_bytes,
      name: proposal.name,
      // 账本里只记**摘要**：提案全文可能很长，且含文档片段
      capabilities: proposal.capabilities.map((ref) => ref.capability),
      new_tools: proposal.new_tools.map((tool) => tool.suggested_name),
      permissions: proposal.permissions,
      escalations: escalations.map((item) => item.dimension),
    });
    return { proposal, doc_fetch: docFetch };
  }

  get(proposalId: string): InstallProposal | null {
    return this.#deps.store.get(proposalId);
  }

  list(options: { status?: ProposalStatus } = {}): InstallProposal[] {
    return this.#deps.store.list(options);
  }

  /**
   * Owner 确认并落地（第三、四道门）。
   *
   * 幂等口径：已 confirmed/materialized 的提案再 confirm → 409 not_confirmable
   * （不重复落地，避免建出两个同名 skill）。
   */
  async confirm(proposalId: string, options: { actorId?: string } = {}): Promise<InstallProposal> {
    const proposal = this.#deps.store.get(proposalId);
    if (proposal === null) throw new ProposalError("proposal_not_found", `proposal ${proposalId} does not exist`);
    if (proposal.status !== "pending") {
      throw new ProposalError(
        "not_confirmable",
        `proposal ${proposalId} is ${proposal.status}; only pending proposals can be confirmed`,
      );
    }
    const now = this.#now().toISOString();
    this.#deps.store.updateStatus(proposalId, "confirmed", { now });
    this.#append(PROPOSAL_EVENT_TYPES.confirmed, {
      proposal_id: proposalId,
      name: proposal.name,
      new_tools: proposal.new_tools.map((tool) => tool.suggested_name),
    });

    try {
      const outcome = await this.#deps.materialize(proposal);
      const materialized = this.#deps.store.updateStatus(proposalId, "materialized", {
        materialized: outcome,
        error: null,
        now: this.#now().toISOString(),
      });
      this.#append(PROPOSAL_EVENT_TYPES.materialized, {
        proposal_id: proposalId,
        kind: outcome.kind,
        id: outcome.id,
      });
      return materialized ?? { ...proposal, status: "materialized", materialized_as: outcome };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.#deps.store.updateStatus(proposalId, "failed", {
        error: message,
        now: this.#now().toISOString(),
      });
      // 落地失败也留审计（这是"确认过但没做成"，与"从没确认"是两件事）
      this.#append(PROPOSAL_EVENT_TYPES.materialized, { proposal_id: proposalId, ok: false, error: message });
      return failed ?? { ...proposal, status: "failed", error: message };
    }
  }

  /** 拒绝提案（Owner 明确不要）：只改状态，不产生任何产物 */
  reject(proposalId: string, options: { reason?: string } = {}): InstallProposal {
    const proposal = this.#deps.store.get(proposalId);
    if (proposal === null) throw new ProposalError("proposal_not_found", `proposal ${proposalId} does not exist`);
    if (proposal.status !== "pending") {
      throw new ProposalError(
        "not_confirmable",
        `proposal ${proposalId} is ${proposal.status}; only pending proposals can be rejected`,
      );
    }
    const updated = this.#deps.store.updateStatus(proposalId, "rejected", {
      error: options.reason ?? null,
      now: this.#now().toISOString(),
    });
    this.#append(PROPOSAL_EVENT_TYPES.rejected, {
      proposal_id: proposalId,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    return updated ?? proposal;
  }

  #append(eventType: string, payload: Record<string, unknown>) {
    const envelope = buildEventEnvelope({
      replicaId: this.#deps.replicaId,
      actorId: "owner",
      eventType,
      payload,
    });
    this.#deps.ledger.append(envelope);
  }
}
