import { canonicalJson, type EventEnvelope } from "@morrow/protocol";
import { buildEventEnvelope } from "../../envelope.ts";
import type { EventLedger } from "../../ledger.ts";
import { uuidv7 } from "../../uuid-v7.ts";
import { CAPABILITY_EVENT_TYPES } from "../engine.ts";
import { capabilityTokens } from "../factory/retriever.ts";
import { SkillStore, type SkillCaseRow, type SkillRow } from "./store.ts";

/**
 * SkillService（票 M2-T5 / Issue #26，FR-EVO-1「经验→Skill」、GLOSSARY Skill 口径、
 * M2 规格 #21「Skill = 声明式组合（引用 capability id + 参数映射），不生成新代码」）。
 *
 * 职责链（重复经验 → 提案 → Owner 批准 → 重用）：
 *   1. 案例收集   recordCase / ingestFromLedger：能力调用成功/失败案例计数（来源
 *                 tool.finished 账本事件——is_error 即失败；source_event 唯一，重放幂等）。
 *   2. 晋升流程   同一 capability 组合的连续成功 streak ≥ 阈值（默认 2，可配置）→
 *                 自动产生提案（status=proposed + skill.proposed 事件）；失败重置 streak
 *                 （失败过的经验不可靠）。已有同组合 proposed/approved 提案时去重不重复
 *                 提案；被拒后再次达标允许新提案（名称加序号后缀）。
 *   3. 校验       Skill 只能引用 enabled 且 verified 的已注册 capability（#22 修复批
 *                 升级：GLOSSARY「已验证」——工厂沙箱验证 / builtin vetted / human 带
 *                 测试；提案创建与批准时都校验，悬空/停用/未验证引用拒绝
 *                 409 skill_dangling_reference）。自动提案来自真实成功案例，天然有效；
 *                 手动提案与中途停用/收验证由本校验拦截。
 *   4. Owner 决策 approve（注册为可调用 Skill + skill.approved 事件）/ reject
 *                 （skill.rejected 事件；悬空引用被拒时记录 missing_capabilities）。
 *   5. 重用路径   invoke：参数模板填充（{{param}}）→ 逐步调用 steps 引用的 capability
 *                 经 ToolInvoker（M2-T2 统一调用接缝，执行前运行时复核——Skill 不绕过
 *                 安全边界）；match：描述检索命中已批准 Skill → 重用而非新建（FR-CAP-1）。
 *
 * 组合说明：自动晋升覆盖单 capability 组合（案例流的重复模式判定是确定性的：按能力
 * 分组计 streak）；多步组合经手动提案（propose）进入同一流程。arg_mapping 为空映射 =
 * invoke 参数整体透传给该步能力。
 */

/** skill.* 事件族（event_type 清单只增不减；点分风格同 capability.*） */
export const SKILL_EVENT_TYPES = {
  proposed: "skill.proposed",
  approved: "skill.approved",
  rejected: "skill.rejected",
  invoked: "skill.invoked",
} as const;

export type SkillErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "not_approved"
  | "dangling_reference"
  | "missing_params";

/** 模板变量：{{param}}（param 为 [A-Za-z0-9_.-]+，容忍两侧空白） */
const TEMPLATE_VARIABLE_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** invoke 的逐步结果投影 */
export interface SkillInvokeResult {
  skill_id: string;
  ok: boolean;
  steps: Array<{
    index: number;
    capability_id: string;
    args: unknown;
    ok: boolean;
    result?: unknown;
    error_code?: string;
    error?: string;
    via?: string;
  }>;
  /** 首个失败步骤序号；全部成功为 null */
  failed_step: number | null;
}

export class SkillError extends Error {
  code: SkillErrorCode;
  /** dangling_reference 附带缺失/停用的 capability id 清单（T6 悬空引用呈现的数据源） */
  missingCapabilities?: string[];

  constructor(code: SkillErrorCode, message: string, missingCapabilities?: string[]) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    if (missingCapabilities !== undefined) this.missingCapabilities = missingCapabilities;
  }
}

/** 声明式组合的一步：引用的能力 id + 参数映射（值 = {{param}} 模板或字面量；空映射 = 透传） */
export interface SkillStep {
  capability_id: string;
  arg_mapping: Record<string, string>;
}

/** Skill/提案记录投影（skills 行 + 解析后的 steps/source） */
export interface SkillRecord {
  skill_id: string;
  name: string;
  title: string;
  description: string;
  steps: SkillStep[];
  status: "proposed" | "approved" | "rejected";
  origin: "auto" | "manual";
  capabilities: string[];
  /** 提案/决策源数据：composition_key、success_count、missing_capabilities、reason */
  source: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** 一条能力调用案例（案例表投影） */
export interface SkillCase {
  case_id: string;
  capability: string;
  outcome: "success" | "failure";
  source_event: string;
  session_id: string | null;
  occurred_at: string;
}

/** 能力注册表窄视图（PermissionEngine 结构匹配——校验引用存在、enabled 且 verified） */
export interface SkillCapabilityLookup {
  get(name: string): { record: { status: string; verified?: boolean } } | null;
}

/** 能力调用接缝（ToolInvoker 结构匹配——invoke(name, input, context)） */
export interface SkillInvoker {
  invoke(
    name: string,
    input: unknown,
    context?: { actorId?: string; sessionId?: string; taskId?: string; fencingToken?: number },
  ): Promise<{ ok: boolean; result?: unknown; error_code?: string; error?: string; via?: string; duration_ms?: number }>;
}

/** 任务租约上下文（M3-T4 / Issue #33）：skill 调用所属 Run 的 fencing token */
export interface SkillFencingContext {
  taskId?: string;
  fencingToken?: number;
}

export interface SkillServiceOptions {
  dataDir: string;
  ledger: EventLedger;
  replicaId: string;
  capabilities: SkillCapabilityLookup;
  /** 能力调用接缝（invoke 用）；缺省 = 未接（invoke 报 not_approved 之外的 500 由路由转译） */
  invoker?: SkillInvoker;
  /** 自动晋升阈值：同组合连续成功 ≥ N 产生提案（默认 2，最小 1） */
  promotionThreshold?: number;
  /**
   * 副作用提交前置校验（M3-T4 / Issue #33）：invoke 携带任务租约上下文时，逐步调用
   * 前校验 fencing token；无任务上下文的直接调用按设计跳过。
   */
  fencingGuard?: (context: SkillFencingContext) => void;
}

export interface RecordCaseInput {
  capability: string;
  outcome: "success" | "failure";
  sourceEventId: string;
  sessionId?: string;
  occurredAt: string;
}

export interface ProposeInput {
  name: string;
  description?: string;
  title?: string;
  steps: SkillStep[];
  actorId?: string;
  now?: Date;
}

export class SkillService {
  readonly #store: SkillStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #capabilities: SkillCapabilityLookup;
  readonly #invoker: SkillInvoker | undefined;
  readonly #fencingGuard: SkillServiceOptions["fencingGuard"];
  readonly #threshold: number;
  #closed = false;
  /** ingestFromLedger 水位（进程内；跨重启靠 source_event 唯一约束幂等） */
  #ingestedSeq = 0;

  constructor(options: SkillServiceOptions) {
    this.#store = SkillStore.open(options.dataDir);
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#capabilities = options.capabilities;
    this.#invoker = options.invoker;
    this.#fencingGuard = options.fencingGuard;
    const threshold = options.promotionThreshold ?? 2;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new SkillError("invalid_input", "promotionThreshold must be an integer >= 1");
    }
    this.#threshold = threshold;
  }

  // --- 1. 案例收集 -------------------------------------------------------------

  /** 记录一次能力调用案例；晋升检查随写随判（达标即提案，返回值携带） */
  recordCase(input: RecordCaseInput): { recorded: boolean; case: SkillCase | null; proposal: SkillRecord | null } {
    this.#assertOpen();
    if (typeof input.capability !== "string" || input.capability.trim().length === 0) {
      throw new SkillError("invalid_input", "capability must be a non-empty string");
    }
    if (input.outcome !== "success" && input.outcome !== "failure") {
      throw new SkillError("invalid_input", "outcome must be \"success\" or \"failure\"");
    }
    if (typeof input.sourceEventId !== "string" || input.sourceEventId.trim().length === 0) {
      throw new SkillError("invalid_input", "sourceEventId must be a non-empty string");
    }
    const recorded = this.#store.insertCase({
      case_id: uuidv7(),
      capability: input.capability,
      outcome: input.outcome,
      source_event: input.sourceEventId,
      session_id: input.sessionId ?? null,
      occurred_at: input.occurredAt,
    });
    if (!recorded) {
      return { recorded: false, case: null, proposal: null };
    }
    const proposal = this.#checkPromotion(input.capability, input.occurredAt);
    const row = this.#store.listCases({ capability: input.capability }).at(-1) as SkillCaseRow;
    return { recorded: true, case: this.#projectCase(row), proposal };
  }

  /**
   * 账本回放（重启回填/兜底）：扫描 tool.finished 事件（seq 升序，从上次水位起），
   * tool_name → capability、is_error → outcome。返回新入库案例数（幂等）。
   */
  ingestFromLedger(): number {
    this.#assertOpen();
    let ingested = 0;
    for (const entry of this.#ledger.scan({ eventType: "tool.finished" })) {
      if (entry.sequence <= this.#ingestedSeq) continue;
      this.#ingestedSeq = entry.sequence;
      const payload = entry.envelope.payload as { tool_name?: unknown; is_error?: unknown };
      if (typeof payload.tool_name !== "string" || payload.tool_name.trim().length === 0) continue;
      const outcome = payload.is_error === true ? "failure" : "success";
      const recorded = this.#store.insertCase({
        case_id: uuidv7(),
        capability: payload.tool_name,
        outcome,
        source_event: entry.envelope.event_id,
        session_id: entry.envelope.session_id ?? null,
        occurred_at: entry.envelope.occurred_at,
      });
      if (recorded) {
        ingested += 1;
        this.#checkPromotion(payload.tool_name, entry.envelope.occurred_at);
      }
    }
    return ingested;
  }

  listCases(filter: { capability?: string } = {}): SkillCase[] {
    this.#assertOpen();
    return this.#store
      .listCases(filter.capability === undefined ? {} : { capability: filter.capability })
      .map((row) => this.#projectCase(row));
  }

  // --- 2. 提案清单（T6 投影口径：proposed → pending） ---------------------------

  /** 全部提案（含已决策的历史——T6 提案列表呈现 pending/approved/rejected 三态） */
  listProposals(): SkillRecord[] {
    this.#assertOpen();
    return this.#store.listSkills().map((row) => this.#projectSkill(row));
  }

  /** 已批准 Skill（可调用注册表——T6 SkillSummary 的数据源） */
  listSkills(): SkillRecord[] {
    this.#assertOpen();
    return this.#store.listSkills().filter((row) => row.status === "approved").map((row) => this.#projectSkill(row));
  }

  getSkill(skillId: string): SkillRecord | null {
    this.#assertOpen();
    const row = this.#store.getSkill(skillId);
    return row === null ? null : this.#projectSkill(row);
  }

  // --- 3. 手动提案 + Owner 决策 --------------------------------------------------

  /**
   * 手动提案（Owner/Agent 显式）：steps 形态校验 → 悬空引用校验（409 skill_dangling_reference，
   * 未注册 ∪ 停用）→ 同名冲突 409 → 落行 + skill.proposed 审计（actor owner）。
   */
  propose(input: ProposeInput): SkillRecord {
    this.#assertOpen();
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new SkillError("invalid_input", "name must be a non-empty string");
    }
    if (input.description !== undefined && typeof input.description !== "string") {
      throw new SkillError("invalid_input", "description must be a string when present");
    }
    const steps = this.#validateSteps(input.steps);
    const missing = this.#danglingReferences(steps);
    if (missing.length > 0) {
      throw new SkillError(
        "dangling_reference",
        `skill "${input.name}" references unknown, disabled, or unverified capabilities: ${missing.join(", ")} (skills may only reference enabled, verified, registered capabilities)`,
        missing,
      );
    }
    if (this.#store.getSkillByName(input.name) !== null) {
      throw new SkillError("conflict", `skill "${input.name}" already exists (names are unique across proposals and approved skills)`);
    }
    return this.#insertSkill(
      {
        name: input.name,
        title: input.title?.trim() || input.name,
        description: input.description?.trim() ?? "",
        steps,
        origin: "manual",
        source: { composition_key: compositionKey(steps) },
      },
      { actorId: input.actorId ?? "owner", now: input.now ?? new Date(), status: "proposed", eventType: SKILL_EVENT_TYPES.proposed },
    );
  }

  /**
   * Owner 决策：approve = 注册为可调用 Skill（status approved + skill.approved 事件）；
   * reject = 显式拒绝（skill.rejected 事件，reason 留痕）。批准前复检悬空引用（提案与
   * 批准之间能力可能被停用）：违规时提案转 rejected（missing_capabilities 留痕，T6 呈现
   * 数据源）并抛 409 skill_dangling_reference。仅 proposed 可决策（重复决策 409）。
   */
  decide(proposalId: string, decision: "approve" | "reject", options: { reason?: string; actorId?: string; now?: Date } = {}): SkillRecord {
    this.#assertOpen();
    const row = this.#store.getSkill(proposalId);
    if (row === null) {
      throw new SkillError("not_found", `skill proposal "${proposalId}" does not exist`);
    }
    if (row.status !== "proposed") {
      throw new SkillError("invalid_state", `skill "${row.name}" is ${row.status} (only proposed skills can be decided)`);
    }
    const actorId = options.actorId ?? "owner";
    const now = this.#now(options.now);
    if (decision === "reject") {
      const reason = typeof options.reason === "string" && options.reason.trim().length > 0 ? options.reason.trim() : "rejected by owner";
      return this.#applyDecision(row, "rejected", { ...JSON.parse(row.source_json) as Record<string, unknown>, reason }, actorId, now, { reason });
    }
    const steps = JSON.parse(row.steps_json) as SkillStep[];
    const missing = this.#danglingReferences(steps);
    if (missing.length > 0) {
      const reason = `dangling reference: ${missing.join(", ")} (capability unregistered, disabled, or unverified since proposal)`;
      this.#applyDecision(row, "rejected", { ...JSON.parse(row.source_json) as Record<string, unknown>, reason, missing_capabilities: missing }, actorId, now, {
        reason,
        missingCapabilities: missing,
      });
      throw new SkillError(
        "dangling_reference",
        `cannot approve skill "${row.name}": ${reason}`,
        missing,
      );
    }
    return this.#applyDecision(row, "approved", JSON.parse(row.source_json) as Record<string, unknown>, actorId, now, {});
  }

  // --- 4. 重用路径：invoke（参数模板填充 → 逐步调用经 invoker 接缝） --------------

  /**
   * 调用已批准 Skill：参数模板填充（{{param}} 先解析调用参数，再解析 `{{result}}` =
   * 上一步结果）→ 逐步调用 steps 引用的 capability 经 invoker（ToolInvoker——执行前
   * 运行时复核，Skill 不绕过安全边界）。arg_mapping 为空映射 = 参数整体透传（自动
   * 提案的默认重用形态）。步骤失败即停（后续不调用），结果按步投影。
   * 审计（#26/威胁模型域 2，修复批贯通）：每步尝试落 capability.used、整链收尾落
   * skill.invoked（先落事件后返回，与仓库「行先于事件/账本可追踪」口径一致）。
   */
  async invoke(
    skillId: string,
    params: unknown,
    options: { actorId?: string; sessionId?: string; taskId?: string; fencingToken?: number } = {},
  ): Promise<SkillInvokeResult> {
    this.#assertOpen();
    const row = this.#store.getSkill(skillId);
    if (row === null) {
      throw new SkillError("not_found", `skill "${skillId}" does not exist`);
    }
    if (row.status !== "approved") {
      throw new SkillError("not_approved", `skill "${row.name}" is ${row.status} (only approved skills are callable)`);
    }
    if (this.#invoker === undefined) {
      throw new SkillError("invalid_state", "no capability invoker wired into the skill service");
    }
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new SkillError("invalid_input", "params must be a JSON object when present");
    }
    // 副作用提交前置校验（M3-T4 / Issue #33）：任何一步执行前先校验租约 token。
    // 无 taskId/fencingToken 的直接调用按设计跳过（不在任一 Run 租约下）。
    this.#fencingGuard?.({
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      ...(options.fencingToken === undefined ? {} : { fencingToken: options.fencingToken }),
    });
    const actorId = options.actorId ?? "agent:skill";
    const input = params as Record<string, unknown>;
    const steps = JSON.parse(row.steps_json) as SkillStep[];
    const startedAt = Date.now();

    // 前置缺失检查：{{result}} 之外的变量必须已在 params 里（任何调用发出前 400）
    const upfrontMissing = new Set<string>();
    for (const step of steps) {
      for (const variable of this.#templateVariables(step.arg_mapping)) {
        if (variable !== "result" && !(variable in input)) upfrontMissing.add(variable);
      }
    }
    if (upfrontMissing.size > 0) {
      throw new SkillError(
        "missing_params",
        `skill "${row.name}" is missing params: ${[...upfrontMissing].sort().join(", ")} (template variables must be provided by the caller)`,
      );
    }

    const projected: SkillInvokeResult["steps"] = [];
    let previousResult: unknown;
    let failedStep: number | null = null;
    for (const [index, step] of steps.entries()) {
      const fill = this.#fillArgs(step.arg_mapping, input, previousResult);
      if (fill.missing.length > 0) {
        throw new SkillError("missing_params", `skill "${row.name}" step ${index} is missing params: ${fill.missing.join(", ")}`);
      }
      try {
        const call = await this.#invoker.invoke(step.capability_id, fill.args, {
          actorId,
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
          ...(options.fencingToken === undefined ? {} : { fencingToken: options.fencingToken }),
        });
        projected.push({
          index,
          capability_id: step.capability_id,
          args: fill.args,
          ok: call.ok === true,
          ...(call.result !== undefined ? { result: call.result } : {}),
          ...(call.error_code !== undefined ? { error_code: call.error_code } : {}),
          ...(call.error !== undefined ? { error: call.error } : {}),
          ...(call.via !== undefined ? { via: call.via } : {}),
        });
        this.#appendCapabilityUsed(step.capability_id, actorId, call, row.skill_id);
        if (call.ok !== true) {
          failedStep = index;
          break;
        }
        previousResult = call.result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorCode = err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : undefined;
        projected.push({ index, capability_id: step.capability_id, args: fill.args, ok: false, error: message });
        this.#appendCapabilityUsed(step.capability_id, actorId, { ok: false, ...(errorCode !== undefined ? { error_code: errorCode } : {}), error: message }, row.skill_id);
        failedStep = index;
        break;
      }
    }
    const ok = failedStep === null;
    this.#append(SKILL_EVENT_TYPES.invoked, actorId, {
      skill_id: row.skill_id,
      name: row.name,
      ok,
      steps: steps.length,
      executed: projected.length,
      failed_step: failedStep,
      duration_ms: Date.now() - startedAt,
    });
    return { skill_id: row.skill_id, ok, steps: projected, failed_step: failedStep };
  }

  // --- 5. 检索复用（FR-CAP-1：缺能力查询命中已有 Skill → 重用路径而非新建） -------

  /**
   * 描述检索已批准 Skill（T3 retriever 同款确定性词元口径，无 LLM）：
   *   名称全分词被需求提及（coverage=1）或 名称+描述 词元 Jaccard ≥ 0.5 → 命中。
   * 仅 approved（可调用的才算"已有 Skill 可重用"）；score 降序。
   */
  matchSkills(description: string): { reused: boolean; skills: Array<SkillRecord & { score: number }> } {
    this.#assertOpen();
    const requestTokens = new Set(capabilityTokens(description));
    const matches: Array<SkillRecord & { score: number }> = [];
    for (const row of this.#store.listSkills()) {
      if (row.status !== "approved") continue;
      const record = this.#projectSkill(row);
      const nameTokens = capabilityTokens(record.name);
      const coverage =
        nameTokens.length === 0 ? 0 : nameTokens.filter((token) => requestTokens.has(token)).length / nameTokens.length;
      const textTokens = capabilityTokens(`${record.name} ${record.title} ${record.description}`);
      const overlap = textTokens.filter((token) => requestTokens.has(token)).length;
      const union = new Set([...requestTokens, ...textTokens]).size;
      const jaccard = union === 0 ? 0 : overlap / union;
      if (coverage >= 1 || jaccard >= 0.5) {
        matches.push({ ...record, score: Math.max(coverage, jaccard) });
      }
    }
    matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { reused: matches.length > 0, skills: matches };
  }

  // --- 内部 -------------------------------------------------------------------

  /** arg_mapping 值里出现的全部模板变量名 */
  #templateVariables(mapping: Record<string, string>): string[] {
    const names = new Set<string>();
    for (const value of Object.values(mapping)) {
      for (const match of value.matchAll(TEMPLATE_VARIABLE_RE)) {
        names.add(match[1]);
      }
    }
    return [...names];
  }

  /**
   * 模板填充：`{{var}}` 先解析 params，`{{result}}` 解析上一步结果；整体恰好是单个
   * 变量时透传原值（保类型），嵌入形态字符串替换（String 化）。空映射 = 参数整体透传。
   */
  #fillArgs(
    mapping: Record<string, string>,
    params: Record<string, unknown>,
    previousResult: unknown,
  ): { args: Record<string, unknown>; missing: string[] } {
    if (Object.keys(mapping).length === 0) {
      return { args: { ...params }, missing: [] };
    }
    const args: Record<string, unknown> = {};
    const missing: string[] = [];
    const resolve = (variable: string): { found: boolean; value?: unknown } => {
      if (variable in params) return { found: true, value: params[variable] };
      if (variable === "result" && previousResult !== undefined) return { found: true, value: previousResult };
      return { found: false };
    };
    for (const [key, template] of Object.entries(mapping)) {
      const single = new RegExp(`^${TEMPLATE_VARIABLE_RE.source}$`).exec(template);
      if (single !== null) {
        const value = resolve(single[1]);
        if (!value.found) missing.push(single[1]);
        else args[key] = value.value;
        continue;
      }
      args[key] = template.replace(TEMPLATE_VARIABLE_RE, (_all, variable: string) => {
        const value = resolve(variable);
        if (!value.found) {
          missing.push(variable);
          return "";
        }
        return String(value.value);
      });
    }
    return { args, missing: [...new Set(missing)] };
  }

  /** 决策落库 + 审计（行先于事件） */
  #applyDecision(
    row: SkillRow,
    status: "approved" | "rejected",
    source: Record<string, unknown>,
    actorId: string,
    now: string,
    event: { reason?: string; missingCapabilities?: string[] },
  ): SkillRecord {
    this.#store.setSkillStatus(row.skill_id, status, now);
    this.#store.setSkillSource(row.skill_id, canonicalJson(source), now);
    this.#append(status === "approved" ? SKILL_EVENT_TYPES.approved : SKILL_EVENT_TYPES.rejected, actorId, {
      skill_id: row.skill_id,
      name: row.name,
      capabilities: [...new Set((JSON.parse(row.steps_json) as SkillStep[]).map((step) => step.capability_id))],
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      ...(event.missingCapabilities !== undefined ? { missing_capabilities: event.missingCapabilities } : {}),
    });
    return this.#projectSkill(this.#store.getSkill(row.skill_id) as SkillRow);
  }

  /** steps 形态校验：非空数组、capability_id 非空、arg_mapping 键值均为字符串 */
  #validateSteps(input: unknown): SkillStep[] {
    if (!Array.isArray(input) || input.length === 0) {
      throw new SkillError("invalid_input", "steps must be a non-empty array of {capability_id, arg_mapping}");
    }
    const steps: SkillStep[] = [];
    for (const raw of input) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new SkillError("invalid_input", "each step must be an object {capability_id, arg_mapping}");
      }
      const step = raw as Record<string, unknown>;
      if (typeof step.capability_id !== "string" || step.capability_id.trim().length === 0) {
        throw new SkillError("invalid_input", "step.capability_id must be a non-empty string");
      }
      if (typeof step.arg_mapping !== "object" || step.arg_mapping === null || Array.isArray(step.arg_mapping)) {
        throw new SkillError("invalid_input", "step.arg_mapping must be an object (string → string)");
      }
      for (const [key, value] of Object.entries(step.arg_mapping)) {
        if (typeof key !== "string" || key.length === 0 || typeof value !== "string") {
          throw new SkillError("invalid_input", "step.arg_mapping must map string keys to string values ({{param}} templates or literals)");
        }
      }
      steps.push({ capability_id: step.capability_id, arg_mapping: step.arg_mapping as Record<string, string> });
    }
    return steps;
  }

  /** 单能力组合的连续成功 streak（失败重置）；按入库序（rowid） */
  #successStreak(capability: string): number {
    const cases = this.#store.listCases({ capability });
    let streak = 0;
    for (let i = cases.length - 1; i >= 0; i -= 1) {
      if (cases[i].outcome !== "success") break;
      streak += 1;
    }
    return streak;
  }

  /**
   * 晋升检查（单能力组合）：连续成功 streak ≥ 阈值且无同组合 proposed/approved 提案时
   * 自动创建提案（skill.proposed 事件，actor agent:runtime）。悬空引用（能力被停用）
   * 跳过不提案——自动路径不产生非法提案。
   */
  #checkPromotion(capability: string, occurredAt: string): SkillRecord | null {
    const streak = this.#successStreak(capability);
    if (streak < this.#threshold) return null;
    const key = compositionKey([{ capability_id: capability, arg_mapping: {} }]);
    const existing = this.#store
      .listSkills()
      .filter((row) => (JSON.parse(row.source_json) as Record<string, unknown>).composition_key === key)
      .filter((row) => row.status === "proposed" || row.status === "approved");
    if (existing.length > 0) return null;
    // 提案前校验引用（能力可能已被停用）：悬空跳过，自动路径不报错只不产生
    const missing = this.#danglingReferences([{ capability_id: capability, arg_mapping: {} }]);
    if (missing.length > 0) return null;
    const name = this.#freeAutoName(capability);
    return this.#insertSkill(
      {
        name,
        title: name,
        description: `自动晋升：${capability} 连续成功 ${streak} 次（案例沉淀）`,
        steps: [{ capability_id: capability, arg_mapping: {} }],
        origin: "auto",
        source: { composition_key: key, success_count: streak, threshold: this.#threshold },
      },
      { actorId: "agent:runtime", now: new Date(occurredAt), status: "proposed", eventType: SKILL_EVENT_TYPES.proposed },
    );
  }

  /** 自动提案命名：能力名即名；被占用（历史 rejected）时追加减量后缀 */
  #freeAutoName(base: string): string {
    if (this.#store.getSkillByName(base) === null) return base;
    for (let i = 2; ; i += 1) {
      const candidate = `${base}-${i}`;
      if (this.#store.getSkillByName(candidate) === null) return candidate;
    }
  }

  /** 步级审计：capability.used（actor/结果/耗时/via 随行；来源 Skill id 留链） */
  #appendCapabilityUsed(
    capabilityId: string,
    actorId: string,
    call: { ok: boolean; result?: unknown; error_code?: string; error?: string; via?: string; duration_ms?: number },
    skillId: string,
  ): void {
    this.#append(CAPABILITY_EVENT_TYPES.used, actorId, {
      capability: capabilityId,
      ok: call.ok === true,
      ...(call.error_code !== undefined ? { error_code: call.error_code } : {}),
      ...(call.error !== undefined ? { error: call.error } : {}),
      ...(call.via !== undefined ? { via: call.via } : {}),
      ...(call.duration_ms !== undefined ? { duration_ms: call.duration_ms } : {}),
      skill_id: skillId,
      path: "skill",
    });
  }

  /**
   * 悬空/停用/未验证引用检测（#22 修复批：GLOSSARY「已验证」升级）：steps 引用的能力
   * 必须已注册、enabled 且 verified（工厂沙箱验证 / builtin vetted / human 带测试）；
   * 返回不合规的能力 id。
   */
  #danglingReferences(steps: SkillStep[]): string[] {
    const missing: string[] = [];
    for (const capabilityId of new Set(steps.map((step) => step.capability_id))) {
      const record = this.#capabilities.get(capabilityId);
      if (record === null || record.record.status !== "enabled" || record.record.verified !== true) {
        missing.push(capabilityId);
      }
    }
    return missing;
  }

  #insertSkill(
    input: { name: string; title: string; description: string; steps: SkillStep[]; origin: "auto" | "manual"; source: Record<string, unknown> },
    options: { actorId: string; now: Date; status: "proposed"; eventType: string },
  ): SkillRecord {
    const now = this.#now(options.now);
    const skillId = uuidv7();
    this.#store.insertSkill({
      skill_id: skillId,
      name: input.name,
      title: input.title,
      description: input.description,
      steps_json: canonicalJson(input.steps),
      status: options.status,
      origin: input.origin,
      source_json: canonicalJson(input.source),
      created_at: now,
      updated_at: now,
    });
    this.#append(options.eventType, options.actorId, {
      skill_id: skillId,
      name: input.name,
      title: input.title,
      capabilities: [...new Set(input.steps.map((step) => step.capability_id))],
      origin: input.origin,
    });
    const row = this.#store.getSkill(skillId) as SkillRow;
    return this.#projectSkill(row);
  }

  #projectCase(row: SkillCaseRow): SkillCase {
    return {
      case_id: row.case_id,
      capability: row.capability,
      outcome: row.outcome === "failure" ? "failure" : "success",
      source_event: row.source_event,
      session_id: row.session_id,
      occurred_at: row.occurred_at,
    };
  }

  #projectSkill(row: SkillRow): SkillRecord {
    return {
      skill_id: row.skill_id,
      name: row.name,
      title: row.title,
      description: row.description,
      steps: JSON.parse(row.steps_json) as SkillStep[],
      status: row.status as SkillRecord["status"],
      origin: row.origin as SkillRecord["origin"],
      capabilities: [...new Set((JSON.parse(row.steps_json) as SkillStep[]).map((step) => step.capability_id))],
      source: JSON.parse(row.source_json) as Record<string, unknown>,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  #append(eventType: string, actorId: string, payload: Record<string, unknown>): EventEnvelope {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: actorId as never,
      eventType,
      payload,
    });
    this.#ledger.append(envelope);
    return envelope;
  }

  #now(date?: Date): string {
    return (date ?? new Date()).toISOString();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("skill service is closed");
  }
}

/** 组合键（去重/匹配口径）：steps 引用的能力 id 排序后拼接 */
export function compositionKey(steps: SkillStep[]): string {
  return [...new Set(steps.map((step) => step.capability_id))].sort().join("+");
}

/** canonicalJson 的本地重导出（store 层 source_json 生成用） */
export { canonicalJson };
