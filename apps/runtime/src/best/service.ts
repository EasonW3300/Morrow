/**
 * Best 模式服务（票 M7-C-T6 / Issue #80，FR-C12/C13）。
 *
 * 阶段推进：interview → spec（门）→ tickets → implement。本票只做到 **spec 门**；
 * 拆票与实现门在 C7。
 *
 * 两个设计要点：
 *
 * 1. **Best 由一个 Thread Goal 承载**（objective = 想法原文）。预算、续跑、状态
 *    观测全部复用 C4/C5，不重写一套。
 * 2. **门是状态机的一部分，不查任何权限开关**。规格门被拒停在 spec（不回退访谈）；
 *    实现门（C7）在完全权限下也拦得住——这是规格 #40 的硬要求，写死在转移表里。
 */

import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { uuidv7 } from "../uuid-v7.ts";
import type { GoalService } from "../goals/service.ts";
import {
  DEFAULT_INTERVIEW_MAX_TURNS,
  BestStageError,
  afterSpecGateApproved,
  afterSpecGateRejected,
  canAdvanceStage,
  convergenceNotice,
  specSlug,
  validateQuestion,
  validateSpec,
  type BestStage,
  type InterviewQuestion,
  type InterviewState,
} from "./stage.ts";
import { BestStore, type BestRunRecord, type InterviewExchange } from "./store.ts";

export const BEST_EVENT_TYPES = {
  started: "best.started",
  stageChanged: "best.stage_changed",
  gateDecided: "best.gate_decided",
  aborted: "best.aborted",
} as const;

export class BestError extends Error {
  readonly code:
    | "invalid_input"
    | "best_already_running"
    | "not_found"
    | "invalid_stage"
    | "interview_limit_reached"
    | "spec_incomplete"
    | "invalid_stage_transition"
    | "session_not_executable"
    | "ephemeral_session"
    | "goal_unavailable";
  constructor(code: BestError["code"], message: string) {
    super(message);
    this.name = "BestError";
    this.code = code;
  }
}

export interface BestServiceDeps {
  store: BestStore;
  ledger: EventLedger;
  replicaId: string;
  goals: GoalService;
  isSessionExecutable(sessionId: string): boolean;
  sessionKind(sessionId: string): "normal" | "ephemeral" | null;
  maxInterviewTurns?: number;
  now?: () => Date;
}

export class BestService {
  readonly #deps: BestServiceDeps;
  readonly #now: () => Date;
  readonly #maxTurns: number;

  constructor(deps: BestServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#maxTurns = deps.maxInterviewTurns ?? DEFAULT_INTERVIEW_MAX_TURNS;
  }

  /**
   * 启动：建承载 goal + 进入访谈。
   *
   * 临时会话禁用（与 Goal 同理：一次性的会话不该挂会改仓库的自动化）。
   */
  start(input: { sessionId: string; idea: string }): BestRunRecord {
    if (typeof input.idea !== "string" || input.idea.trim().length === 0) {
      throw new BestError("invalid_input", "idea must be a non-empty string");
    }
    if (!this.#deps.isSessionExecutable(input.sessionId)) {
      throw new BestError("session_not_executable", `session ${input.sessionId} is not executable`);
    }
    if (this.#deps.sessionKind(input.sessionId) === "ephemeral") {
      throw new BestError(
        "ephemeral_session",
        "best mode is disabled in ephemeral sessions (it creates branches and writes files)",
      );
    }
    if (this.#deps.store.activeForSession(input.sessionId) !== null) {
      throw new BestError(
        "best_already_running",
        `session ${input.sessionId} already has a running best run; finish or abort it first`,
      );
    }

    // 承载 goal：objective 用想法原文。Best 的预算/续跑都靠它。
    // goal 创建**不需** Owner 二次确认——启动 best 本身就是那一次确认（idea 已明确）。
    let goalId: string | null = null;
    try {
      const goal = this.#deps.goals.create({
        sessionId: input.sessionId,
        objective: `[best] ${input.idea.trim()}`,
        confirm: true,
        // Best 的长跑用默认预算（不设限）；Owner 可在 goal 页调整
      });
      goalId = goal.goal_id;
    } catch (error) {
      // goal 建不成（例如已有未完成 goal）→ best 也不该继续：它是承载物
      throw new BestError(
        "goal_unavailable",
        `cannot start best mode: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const now = this.#now().toISOString();
    const record: BestRunRecord = {
      best_id: uuidv7(),
      session_id: input.sessionId,
      goal_id: goalId,
      idea: input.idea.trim(),
      stage: "interview",
      status: "running",
      slug: null,
      interview: [],
      spec_markdown: null,
      spec_path: null,
      tickets: [],
      branch: null,
      workspace_path: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    this.#deps.store.insert(record);
    this.#append(BEST_EVENT_TYPES.started, record.session_id, {
      best_id: record.best_id,
      goal_id: goalId,
      idea: record.idea,
      max_turns: this.#maxTurns,
    });
    return record;
  }

  get(bestId: string): BestRunRecord | null {
    return this.#deps.store.get(bestId);
  }

  activeForSession(sessionId: string): BestRunRecord | null {
    return this.#deps.store.activeForSession(sessionId);
  }

  list(options: { sessionId?: string } = {}): BestRunRecord[] {
    return this.#deps.store.list(options);
  }

  /** 访谈当前进度 */
  interviewState(bestId: string): InterviewState | null {
    const run = this.#deps.store.get(bestId);
    if (run === null) return null;
    const turns = run.interview.length;
    return { turns, remaining: Math.max(0, this.#maxTurns - turns) };
  }

  /**
   * 记录一问一答。
   *
   * 到达轮次上限时**仍接受这一问**（否则最后一问白问），并在响应里给出强制收束提示。
   */
  recordExchange(input: { bestId: string; question: unknown; answer: string }): {
    run: BestRunRecord;
    state: InterviewState;
    notice: string;
  } {
    const run = this.#requireRunning(input.bestId, "interview");
    if (typeof input.answer !== "string" || input.answer.trim().length === 0) {
      throw new BestError("invalid_input", "answer must be a non-empty string");
    }
    const validated = validateQuestion(input.question);
    if (!validated.ok) throw new BestError("invalid_input", validated.problem);

    const now = this.#now().toISOString();
    const exchange: InterviewExchange = {
      question: validated.question,
      answer: input.answer.trim(),
      asked_at: now,
      answered_at: now,
    };
    const updated = this.#deps.store.update(run.best_id, { interview: [...run.interview, exchange] }, now);
    if (updated === null) throw new BestError("not_found", `best run ${run.best_id} disappeared`);
    const state = { turns: updated.interview.length, remaining: Math.max(0, this.#maxTurns - updated.interview.length) };
    return { run: updated, state, notice: convergenceNotice(state, this.#maxTurns) };
  }

  /**
   * 提交规格（进入 spec 阶段并等门）。
   *
   * 允许从 `interview` **或** `spec` 提交：后者是「门被拒后改了规格再提」的正常
   * 路径（规格 #37 要求停在 spec 可编辑重提）。只要求状态仍是 running
   * （awaiting_gate 时不能重提——那时正等 Owner 点按钮）。
   */
  submitSpec(input: { bestId: string; markdown: string }): {
    run: BestRunRecord;
    gate: "spec_approval";
    missing: string[];
  } {
    const run = this.#deps.store.get(input.bestId);
    if (run === null) throw new BestError("not_found", `best run ${input.bestId} does not exist`);
    if (run.status === "awaiting_gate") {
      throw new BestError(
        "invalid_stage",
        "this spec is already awaiting your decision; approve or reject it before submitting a new one",
      );
    }
    if (run.status !== "running") {
      throw new BestError("invalid_stage", `best run ${input.bestId} is ${run.status}`);
    }
    if (run.stage !== "interview" && run.stage !== "spec") {
      throw new BestError(
        "invalid_stage",
        `spec can only be submitted from interview or spec stage (current: ${run.stage})`,
      );
    }
    if (typeof input.markdown !== "string" || input.markdown.trim().length === 0) {
      throw new BestError("invalid_input", "markdown must be a non-empty string");
    }
    const validation = validateSpec(input.markdown);
    if (!validation.ok) {
      throw new BestError(
        "spec_incomplete",
        `spec is missing content for: ${validation.missing.join(", ")} (every section must be present and non-empty)`,
      );
    }
    const slug = specSlug(extractTitle(input.markdown, run.idea));
    const now = this.#now().toISOString();
    const advanced = this.#advance(run, "spec", { spec_markdown: input.markdown, slug }, now);
    const awaiting = this.#deps.store.update(run.best_id, { status: "awaiting_gate" }, this.#now().toISOString());
    this.#append(BEST_EVENT_TYPES.gateDecided, advanced.session_id, {
      best_id: run.best_id,
      gate: "spec_approval",
      decision: "pending",
      slug,
    });
    return { run: awaiting ?? advanced, gate: "spec_approval", missing: [] };
  }

  /**
   * 规格门决策。
   *
   * `approve` → 进 tickets（不设门）；`reject` → **停在 spec**（可编辑重提）。
   * 两种都写 `best.gate_decided` 审计。
   */
  decideSpecGate(input: { bestId: string; decision: "approve" | "reject"; reason?: string }): BestRunRecord {
    const run = this.#deps.store.get(input.bestId);
    if (run === null) throw new BestError("not_found", `best run ${input.bestId} does not exist`);
    if (run.stage !== "spec") {
      throw new BestError("invalid_stage", `spec gate only applies at stage spec (current: ${run.stage})`);
    }
    const now = this.#now().toISOString();
    this.#append(BEST_EVENT_TYPES.gateDecided, run.session_id, {
      best_id: run.best_id,
      gate: "spec_approval",
      decision: input.decision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });

    if (input.decision === "reject") {
      // 停在 spec：状态回到 running（可编辑重提），阶段不变
      const rejected = afterSpecGateRejected();
      const updated = this.#deps.store.update(run.best_id, { status: rejected.status }, now);
      return updated ?? run;
    }

    const approved = afterSpecGateApproved();
    const advanced = this.#advance(run, "tickets", {}, now);
    const updated = this.#deps.store.update(run.best_id, { status: approved.status }, this.#now().toISOString());
    return updated ?? advanced;
  }

  /** 中止（任一门被拒后放弃，或 Owner 主动停） */
  abort(bestId: string, reason?: string): BestRunRecord {
    const run = this.#deps.store.get(bestId);
    if (run === null) throw new BestError("not_found", `best run ${bestId} does not exist`);
    const now = this.#now().toISOString();
    const updated = this.#deps.store.update(bestId, { status: "aborted", last_error: reason ?? null }, now);
    this.#append(BEST_EVENT_TYPES.aborted, run.session_id, {
      best_id: bestId,
      reason: reason ?? null,
      stage: run.stage,
      /** 遗留物：已建分支不自动删（删错东西比留空分支危险） */
      leftovers: {
        branch: run.branch,
        workspace_path: run.workspace_path,
        spec_path: run.spec_path,
      },
    });
    return updated ?? run;
  }

  /** 阶段推进（含审计）。非法转换抛错。 */
  #advance(
    run: BestRunRecord,
    to: BestStage,
    patch: Partial<Parameters<BestStore["update"]>[1]> = {},
    now: string,
  ): BestRunRecord {
    if (!canAdvanceStage(run.stage, to)) {
      const error = new BestStageError(run.stage, to);
      throw new BestError(error.code, error.message);
    }
    const updated = this.#deps.store.update(run.best_id, { stage: to, ...patch }, now);
    if (updated === null) throw new BestError("not_found", `best run ${run.best_id} disappeared`);
    this.#append(BEST_EVENT_TYPES.stageChanged, updated.session_id, {
      best_id: run.best_id,
      from: run.stage,
      to,
    });
    return updated;
  }

  #requireRunning(bestId: string, expectedStage: BestStage): BestRunRecord {
    const run = this.#deps.store.get(bestId);
    if (run === null) throw new BestError("not_found", `best run ${bestId} does not exist`);
    if (run.status !== "running" && run.status !== "awaiting_gate") {
      throw new BestError("invalid_stage", `best run ${bestId} is ${run.status}`);
    }
    if (run.stage !== expectedStage) {
      throw new BestError(
        "invalid_stage",
        `expected stage "${expectedStage}" but the run is at "${run.stage}"`,
      );
    }
    return run;
  }

  #append(eventType: string, sessionId: string, payload: Record<string, unknown>): void {
    const envelope = buildEventEnvelope({
      replicaId: this.#deps.replicaId,
      actorId: "owner",
      eventType,
      sessionId,
      payload,
    });
    this.#deps.ledger.append(envelope);
  }
}

/** 从规格 Markdown 抽第一个一级标题作为 slug 来源（没有则退回 idea） */
function extractTitle(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match === null ? fallback : match[1].trim();
}
