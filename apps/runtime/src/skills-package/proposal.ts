/**
 * 智能安装提案（票 M7-B-T4 / Issue #72，FR-B9/B12）。
 *
 * 四道门（缺一不可，顺序固定）：
 *   1. **提案**：文档 → LLM 产「安装提案」（需要哪些现有能力、是否需要新建工具、
 *      权限清单、示例调用）。此时**不产生任何注册、不产生任何代码**。
 *   2. **预览**：Owner 看到完整提案（含权限清单与示例调用）。
 *   3. **确认**：Owner 显式 `confirm`。
 *   4. **落地**：确认后才把提案交给既有路径——
 *        - 只需组合现有能力 → 建 Skill（声明式 steps，不含代码）；
 *        - 需要新工具 → **转交 Tool Factory**（POST /v1/capabilities/request 的同一
 *          闭环：生成 → 沙箱验证 → Owner 确认 → 注册），而不是在这里直接注册。
 *      这正是规格「若是，走 Tool Factory 而非直接注册」的落地。
 *
 * 为什么 LLM 只产提案不产代码：文档是不可信输入。让 LLM 直接产出可执行代码并注册，
 * 等于把"贴一份文档"变成"远程代码执行"。提案是**数据**（权限清单+引用），可以审查；
 * 代码必须走工厂的沙箱验证闭环。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import type { SkillPackagePermissions } from "./manifest.ts";

/** 提案状态机（PENDING → CONFIRMED → MATERIALIZED / REJECTED / FAILED） */
export type ProposalStatus = "pending" | "confirmed" | "materialized" | "rejected" | "failed";

/** 提案里对某个现有能力的引用 */
export interface ProposalCapabilityRef {
  /** 现有 capability 名（已注册） */
  capability: string;
  /** 用途说明（为什么需要它） */
  purpose: string;
  /** 示例调用参数（给 Owner 看"实际会怎么用"） */
  example_args?: Record<string, unknown>;
}

/** 提案里"需要新建工具"的声明（不在此处生成代码） */
export interface ProposalNewTool {
  /** 期望的能力名 */
  suggested_name: string;
  /** 需求描述（原样交给 Tool Factory 的 description） */
  description: string;
  /** 期望权限（工厂会再次校验 ⊆ grants） */
  permissions: Partial<SkillPackagePermissions>;
  /** 为什么现有能力不够 */
  rationale: string;
}

/** 完整提案 */
export interface InstallProposal {
  proposal_id: string;
  source_kind: "upload" | "paste" | "url";
  /** 来源标识：文件名 / URL / "pasted text" */
  source_ref: string;
  /** 文档字节数（审计） */
  source_bytes: number;
  /** 建议的技能名（slug） */
  name: string;
  title: string;
  description: string;
  /** 用到的现有能力 */
  capabilities: ProposalCapabilityRef[];
  /** 需要新建的能力（空数组 = 纯组合） */
  new_tools: ProposalNewTool[];
  /** 权限清单（五维；来源是 new_tools 的并集 + 文档里声明的需求） */
  permissions: SkillPackagePermissions;
  /** 示例调用（自然语言 + 期望结果，给 Owner 判断"这是不是我要的"） */
  examples: Array<{ request: string; expected: string }>;
  /** LLM 的不确定点（诚实标注，不假装确定） */
  uncertainties: string[];
  status: ProposalStatus;
  created_at: string;
  updated_at: string;
  /** 落地后产物：skill_id 或 factory request_id */
  materialized_as: { kind: "skill" | "factory_request"; id: string } | null;
  /** 失败/拒绝原因 */
  error: string | null;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS skill_install_proposals (
  proposal_id     TEXT PRIMARY KEY,
  source_kind     TEXT NOT NULL,
  source_ref      TEXT NOT NULL,
  source_bytes    INTEGER NOT NULL,
  name            TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL,
  materialized_kind TEXT,
  materialized_id   TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
`;

interface ProposalRow {
  proposal_id: string;
  source_kind: string;
  source_ref: string;
  source_bytes: number;
  name: string;
  title: string;
  description: string;
  payload_json: string;
  status: string;
  materialized_kind: string | null;
  materialized_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** 提案内容（不落冗余列的部分，整体存 payload_json） */
interface ProposalPayload {
  capabilities: ProposalCapabilityRef[];
  new_tools: ProposalNewTool[];
  permissions: SkillPackagePermissions;
  examples: Array<{ request: string; expected: string }>;
  uncertainties: string[];
}

function projectProposal(row: ProposalRow): InstallProposal {
  const payload = JSON.parse(row.payload_json) as ProposalPayload;
  return {
    proposal_id: row.proposal_id,
    source_kind: row.source_kind as InstallProposal["source_kind"],
    source_ref: row.source_ref,
    source_bytes: row.source_bytes,
    name: row.name,
    title: row.title,
    description: row.description,
    capabilities: payload.capabilities,
    new_tools: payload.new_tools,
    permissions: payload.permissions,
    examples: payload.examples,
    uncertainties: payload.uncertainties,
    status: row.status as ProposalStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    materialized_as:
      row.materialized_kind === null || row.materialized_id === null
        ? null
        : { kind: row.materialized_kind as "skill" | "factory_request", id: row.materialized_id },
    error: row.error,
  };
}

export class ProposalStore {
  readonly #db: SqliteDatabase;
  readonly #ownsConnection: boolean;

  constructor(options: { dataDir?: string; db?: SqliteDatabase } = {}) {
    if (options.db !== undefined) {
      this.#db = options.db;
      this.#ownsConnection = false;
    } else {
      if (options.dataDir === undefined) throw new Error("ProposalStore requires dataDir or db");
      this.#db = openSqlite(join(options.dataDir, DB_FILE_NAME));
      this.#ownsConnection = true;
    }
    this.#db.exec(CREATE_SQL);
  }

  insert(proposal: InstallProposal): void {
    const payload: ProposalPayload = {
      capabilities: proposal.capabilities,
      new_tools: proposal.new_tools,
      permissions: proposal.permissions,
      examples: proposal.examples,
      uncertainties: proposal.uncertainties,
    };
    this.#db
      .prepare(
        `INSERT INTO skill_install_proposals (
          proposal_id, source_kind, source_ref, source_bytes, name, title, description,
          payload_json, status, materialized_kind, materialized_id, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.proposal_id,
        proposal.source_kind,
        proposal.source_ref,
        proposal.source_bytes,
        proposal.name,
        proposal.title,
        proposal.description,
        JSON.stringify(payload),
        proposal.status,
        proposal.materialized_as?.kind ?? null,
        proposal.materialized_as?.id ?? null,
        proposal.error,
        proposal.created_at,
        proposal.updated_at,
      );
  }

  get(proposalId: string): InstallProposal | null {
    const row = this.#db
      .prepare("SELECT * FROM skill_install_proposals WHERE proposal_id = ?")
      .get(proposalId) as ProposalRow | undefined;
    return row === undefined ? null : projectProposal(row);
  }

  list(options: { status?: ProposalStatus } = {}): InstallProposal[] {
    const rows =
      options.status === undefined
        ? (this.#db
            .prepare("SELECT * FROM skill_install_proposals ORDER BY created_at DESC, proposal_id DESC")
            .all() as ProposalRow[])
        : (this.#db
            .prepare(
              "SELECT * FROM skill_install_proposals WHERE status = ? ORDER BY created_at DESC, proposal_id DESC",
            )
            .all(options.status) as ProposalRow[]);
    return rows.map(projectProposal);
  }

  updateStatus(
    proposalId: string,
    status: ProposalStatus,
    options: { materialized?: { kind: "skill" | "factory_request"; id: string }; error?: string | null; now: string },
  ): InstallProposal | null {
    const existing = this.get(proposalId);
    if (existing === null) return null;
    this.#db
      .prepare(
        `UPDATE skill_install_proposals SET
          status = ?,
          materialized_kind = ?,
          materialized_id = ?,
          error = ?,
          updated_at = ?
         WHERE proposal_id = ?`,
      )
      .run(
        status,
        options.materialized?.kind ?? existing.materialized_as?.kind ?? null,
        options.materialized?.id ?? existing.materialized_as?.id ?? null,
        options.error === undefined ? existing.error : options.error,
        options.now,
        proposalId,
      );
    return this.get(proposalId);
  }

  close(): void {
    if (this.#ownsConnection) this.#db.close();
  }
}

/**
 * LLM 提案生成器接缝。
 *
 * 输入是**文档原文**与**当前可用的能力清单**；输出必须是提案（不可是代码）。
 * 生产实现走 Provider（一次 prompt）；测试注入脚本化生成器（零网络）。
 */
export interface ProposalGenerator {
  generate(input: {
    document: string;
    sourceKind: InstallProposal["source_kind"];
    sourceRef: string;
    /** 现有能力（供 LLM 判断"能不能纯组合"） */
    existingCapabilities: Array<{ name: string; description: string | null }>;
    /** 当前五维授权面（提案权限不得超出的硬上界提示） */
    grants: SkillPackagePermissions;
  }): Promise<{
    name: string;
    title: string;
    description: string;
    capabilities: ProposalCapabilityRef[];
    new_tools: ProposalNewTool[];
    permissions: Partial<SkillPackagePermissions>;
    examples: Array<{ request: string; expected: string }>;
    uncertainties?: string[];
  }>;
}

/** 提案校验失败（可读、可展示给 Owner） */
export class ProposalError extends Error {
  readonly code:
    | "bad_document"
    | "generation_failed"
    | "invalid_proposal"
    | "permission_escalation"
    | "proposal_not_found"
    | "not_confirmable"
    | "materialization_failed";
  constructor(code: ProposalError["code"], message: string) {
    super(message);
    this.name = "ProposalError";
    this.code = code;
  }
}

const EMPTY_PERMISSIONS: SkillPackagePermissions = {
  filesystem: [],
  network: [],
  shell: [],
  channels: [],
  credentials: [],
};

/** 权限规范化（缺失维度补空；未知维度丢弃） */
export function normalizeProposalPermissions(
  input: Partial<SkillPackagePermissions> | undefined,
): SkillPackagePermissions {
  const read = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  if (input === undefined) return { ...EMPTY_PERMISSIONS };
  return {
    filesystem: read(input.filesystem),
    network: read(input.network),
    shell: read(input.shell),
    channels: read(input.channels),
    credentials: read(input.credentials),
  };
}

/**
 * 校验 LLM 输出的提案形状。
 *
 * 除了形状，还要挡住一类真实的错误：**LLM 编造不存在的能力名**。若提案引用了
 * 未注册的 capability，落地时必然失败——在提案阶段就报出来，比让 Owner 确认后
 * 才发现要好。
 */
export function validateProposalShape(
  raw: Awaited<ReturnType<ProposalGenerator["generate"]>>,
  existingCapabilities: readonly string[],
): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (typeof raw.name !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(raw.name)) {
    problems.push("name must be a lowercase slug (letters/digits/._-, 1-64 chars)");
  }
  if (typeof raw.title !== "string" || raw.title.trim().length === 0) problems.push("title is required");
  if (typeof raw.description !== "string" || raw.description.trim().length === 0) {
    problems.push("description is required");
  }
  if (!Array.isArray(raw.capabilities)) problems.push("capabilities must be an array");
  if (!Array.isArray(raw.new_tools)) problems.push("new_tools must be an array");
  if (!Array.isArray(raw.examples)) problems.push("examples must be an array");
  if (problems.length > 0) return { ok: false, problems };

  const known = new Set(existingCapabilities);
  for (const ref of raw.capabilities) {
    if (typeof ref.capability !== "string" || ref.capability.trim().length === 0) {
      problems.push("every capability reference needs a capability name");
      continue;
    }
    if (!known.has(ref.capability)) {
      // 不静默接受：编造的能力名会让确认后的落地必然失败
      problems.push(
        `capability "${ref.capability}" is not registered; list it under new_tools instead of capabilities`,
      );
    }
  }
  for (const tool of raw.new_tools) {
    if (typeof tool.suggested_name !== "string" || tool.suggested_name.trim().length === 0) {
      problems.push("every new tool needs a suggested_name");
    }
    if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
      problems.push(`new tool "${tool.suggested_name}" needs a description`);
    }
  }
  if (raw.examples.length === 0) {
    // 没示例调用，Owner 无法判断"这是不是我要的"
    problems.push("at least one example call is required");
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** 提案的权限是否超出当前授权面（超出的部分必须在确认前就让 Owner 看见） */
export function permissionEscalations(
  permissions: SkillPackagePermissions,
  grants: SkillPackagePermissions,
): Array<{ dimension: keyof SkillPackagePermissions; requested: string[]; granted: string[] }> {
  const out: Array<{ dimension: keyof SkillPackagePermissions; requested: string[]; granted: string[] }> = [];
  for (const dimension of ["filesystem", "network", "shell", "channels", "credentials"] as const) {
    const requested = permissions[dimension];
    if (requested.length === 0) continue;
    const granted = grants[dimension];
    // 逐项判：authorization 语义是"请求的每一项都得在 grant 里"
    const missing = requested.filter((item) => !granted.includes(item));
    if (missing.length > 0) out.push({ dimension, requested: missing, granted });
  }
  return out;
}

/** 生成提案 id（前缀便于日志识别） */
export function newProposalId(): string {
  return `prop_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
