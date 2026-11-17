/**
 * 动态 bash 执行服务（票 M7-B-T6 / Issue #70）：判定 → 确认 → 快照 → 容器执行 → 审计。
 *
 * 端到端次序是这张票的安全语义，任何一步都不能省：
 *
 *   1. `ExecModeRegistry.decide` → allow / confirm / **deny**
 *      deny 是**硬拒绝**：危险模式在完全权限下也拒绝，且**不**降级成 confirm
 *      （规格：「命中即拒绝，不是确认」）。
 *   2. 需要确认时**不执行**：把完整脚本回传，等 Owner 带 `confirmation_id` 再来。
 *      确认记录有 id、一次性、绑定脚本哈希——换脚本必须重新确认（防 TOCTOU）。
 *   3. 放行后（无论在哪种模式）**先快照**，再执行。快照失败 → 不执行（fail-closed）。
 *   4. 执行走 `LocalExecRunner`（生产唯一实现是容器）。
 *   5. **审计照做**：`exec.requested`（含被拒的尝试）/ `exec.finished` / `exec.reverted`
 *      全部落账本，`actor_id=owner`（是 Owner 授权触发的动作）。
 *
 * 关于"沙箱预演不能作为放行依据"（访谈 Q18 的技术澄清）：本服务**没有**"先跑一遍
 * 沙箱看看"的步骤，也**不会**因为某条命令在沙箱里成功就放宽宿主侧判定。危险与否
 * 只由静态规则集判断（见 danger-rules.ts 的文件头）。
 */

import { createHash } from "node:crypto";
import type { EventEnvelope } from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { screenScript, isReadOnlyScript } from "./danger-rules.ts";
import type { ExecDecision, ExecMode, ExecModeRegistry } from "./mode.ts";
import {
  DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  type ExecRequest,
  type ExecResultView,
  type LocalExecRunner,
} from "./runner.ts";
import {
  SNAPSHOT_SCOPE_NOTICE,
  type SnapshotManager,
  type SnapshotRecord,
  type RevertResult,
} from "./snapshot.ts";

/** exec.* 事件族（只增不减） */
export const EXEC_EVENT_TYPES = {
  /** 一次执行请求的判定结果（含被拦/待确认——拦截尝试必须可查） */
  requested: "exec.requested",
  /** 执行结束（成功/失败/超时/截断） */
  finished: "exec.finished",
  /** 撤销完成 */
  reverted: "exec.reverted",
  /** 模式切换（审计；不是状态源） */
  modeChanged: "exec.mode_changed",
} as const;

/** 待确认的执行请求（一次性，绑定脚本内容） */
export interface PendingExec {
  confirmationId: string;
  sessionId: string;
  /** 完整脚本（原样回传展示） */
  script: string;
  /** 脚本哈希：确认时必须与之一致（防 TOCTOU 换脚本） */
  scriptHash: string;
  mode: ExecMode;
  createdAt: string;
  /** 该脚本是否是只读（决定确认后是否获得只读豁免） */
  readonly: boolean;
  expiresAt: string;
}

/** 待确认过期时间（5 分钟：够 Owner 读完脚本，又不至于留一个长期有效的放行票） */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export class ExecError extends Error {
  readonly code:
    | "invalid_script"
    | "exec_forbidden"
    | "confirmation_not_found"
    | "confirmation_expired"
    | "confirmation_mismatch"
    | "session_not_executable"
    | "exec_unavailable";
  constructor(code: ExecError["code"], message: string) {
    super(message);
    this.name = "ExecError";
    this.code = code;
  }
}

/** 脚本哈希（sha256 前 16 hex；只做"还是不是同一段脚本"的比对，不是内容指纹承诺） */
export function scriptHash(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex").slice(0, 16);
}

/** 请求执行的输出（HTTP 响应体同源） */
export type ExecSubmitOutcome =
  | {
      status: "denied";
      session_id: string;
      mode: ExecMode;
      /** 命中的规则（UI 逐条展示原因） */
      hits: Array<{ id: string; level: string; reason: string }>;
      /** 明确标注：这是拒绝，不是"待确认" */
      decision: "deny";
    }
  | {
      status: "needs_confirmation";
      session_id: string;
      mode: ExecMode;
      confirmation_id: string;
      /** 完整未截断脚本 */
      script: string;
      why: string;
      expires_at: string;
      readonly: boolean;
    }
  | {
      status: "executed";
      session_id: string;
      mode: ExecMode;
      /** 快照 id；**null = 没有可保护的工作区**（不是"快照成功但 id 为空"） */
      snapshot_id: string | null;
      snapshot_strategy: "git" | "copy" | null;
      scope_notice: string;
      result: ExecResultView;
      event_id: string;
      sequence: number;
    };

/** 确认并执行 */
export type ExecApproveOutcome =
  | {
      status: "executed";
      session_id: string;
      mode: ExecMode;
      /** 快照 id；**null = 无可保护工作区** */
      snapshot_id: string | null;
      snapshot_strategy: "git" | "copy" | null;
      scope_notice: string;
      result: ExecResultView;
      event_id: string;
      sequence: number;
    }
  | {
      status: "denied";
      session_id: string;
      mode: ExecMode;
      hits: Array<{ id: string; level: string; reason: string }>;
      decision: "deny";
    };

export interface ExecServiceDeps {
  ledger: EventLedger;
  replicaId: string;
  modes: ExecModeRegistry;
  runner: LocalExecRunner;
  snapshots: SnapshotManager;
  /** 会话可执行判定（存在、未关闭、未删除） */
  isSessionExecutable(sessionId: string): boolean;
  /** 会话工作区（无工作区 → 不挂载，脚本在 /tmp 里跑） */
  workspaceOf(sessionId: string): { path: string } | null;
  now?: () => Date;
  maxTimeoutMs?: number;
}

export class ExecService {
  readonly #deps: ExecServiceDeps;
  readonly #pending = new Map<string, PendingExec>();
  readonly #now: () => Date;

  constructor(deps: ExecServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * 提交一次执行请求。
   *
   * `approvedScript` 非空表示"这是 Owner 点了确认之后再来的"——此时跳过确认环节，
   * 但仍然重跑危险规则（不信任客户端的确认标记：从 confirm 到 approve 之间
   * 规则集可能有变，且客户端可能被篡改）。
   */
  async submit(input: {
    sessionId: string;
    script: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    confirmationId?: string;
  }): Promise<ExecSubmitOutcome> {
    const sessionId = input.sessionId;
    if (!this.#deps.isSessionExecutable(sessionId)) {
      throw new ExecError("session_not_executable", `session ${sessionId} is not executable (closed, deleted or unknown)`);
    }
    const script = input.script;
    if (typeof script !== "string" || script.trim().length === 0) {
      throw new ExecError("invalid_script", "script must be a non-empty string");
    }

    const decision = this.#deps.modes.decide(sessionId, script);
    if (decision.kind === "deny") {
      this.#auditDenied(sessionId, script, decision);
      return {
        status: "denied",
        session_id: sessionId,
        mode: decision.mode,
        hits: decision.verdict.hits.map((hit) => ({ id: hit.id, level: hit.level, reason: hit.reason })),
        decision: "deny",
      };
    }

    if (input.confirmationId !== undefined) {
      // 确认路径：校验一次性票（内容/过期）+ 重跑规则（上面已跑过，开头就拦了）
      const pending = this.#consumeConfirmation(input.confirmationId);
      if (pending.sessionId !== sessionId) {
        throw new ExecError("confirmation_mismatch", "confirmation belongs to a different session");
      }
      if (pending.scriptHash !== scriptHash(script)) {
        throw new ExecError("confirmation_mismatch", "script changed since it was confirmed; confirm again");
      }
      this.#deps.modes.recordConfirmation(sessionId, script);
      return await this.#execute(sessionId, script, decision.mode, input);
    }

    if (decision.kind === "confirm") {
      const pending = this.#createPending(sessionId, script, decision.mode);
      // 审计：待确认也要记（事后要能看出"Owner 被要求确认了什么"）
      this.#append(sessionId, EXEC_EVENT_TYPES.requested, {
        phase: "awaiting_confirmation",
        script,
        script_hash: pending.scriptHash,
        mode: decision.mode,
        why: decision.why,
        confirmation_id: pending.confirmationId,
      });
      return {
        status: "needs_confirmation",
        session_id: sessionId,
        mode: decision.mode,
        confirmation_id: pending.confirmationId,
        script,
        why: decision.why,
        expires_at: pending.expiresAt,
        readonly: pending.readonly,
      };
    }

    return await this.#execute(sessionId, script, decision.mode, input);
  }

  /** 显式确认并执行（等价于带 confirmationId 的 submit，语义更清晰） */
  async approve(input: {
    sessionId: string;
    confirmationId: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }): Promise<ExecApproveOutcome> {
    const pending = this.#peekConfirmation(input.confirmationId);
    const outcome = await this.submit({
      sessionId: input.sessionId,
      script: pending.script,
      confirmationId: input.confirmationId,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    });
    if (outcome.status === "executed") return outcome;
    if (outcome.status === "denied") return outcome;
    // submit 在确认路径上不该再要求确认
    throw new ExecError("confirmation_mismatch", "approved script unexpectedly required confirmation again");
  }

  /** 待确认详情（GET 端点；过期或不存在 → null） */
  pendingOf(confirmationId: string): PendingExec | null {
    const pending = this.#pending.get(confirmationId);
    if (pending === undefined) return null;
    if (Date.parse(pending.expiresAt) <= this.#now().getTime()) {
      this.#pending.delete(confirmationId);
      return null;
    }
    return pending;
  }

  /** 撤销某会话最近一次快照（或指定快照） */
  async revert(input: { sessionId: string; snapshotId?: string }): Promise<{
    session_id: string;
    snapshot_id: string;
    strategy: "git" | "copy";
    restored: number;
    removed: number;
    scope_notice: string;
    event_id: string;
    sequence: number;
  }> {
    const record =
      input.snapshotId === undefined
        ? this.#deps.snapshots.latest(input.sessionId)
        : this.#deps.snapshots.load(input.sessionId, input.snapshotId);
    if (record === null) {
      throw new ExecError("confirmation_not_found", `no snapshot found for session ${input.sessionId}`);
    }
    const result: RevertResult = await this.#deps.snapshots.revert(record);
    const entry = this.#append(input.sessionId, EXEC_EVENT_TYPES.reverted, {
      snapshot_id: record.snapshot_id,
      strategy: result.strategy,
      restored: result.restored,
      removed: result.removed,
      workspace_dir: record.workspace_dir,
      scope_notice: SNAPSHOT_SCOPE_NOTICE,
    });
    return {
      session_id: input.sessionId,
      snapshot_id: result.snapshot_id,
      strategy: result.strategy,
      restored: result.restored,
      removed: result.removed,
      scope_notice: SNAPSHOT_SCOPE_NOTICE,
      event_id: entry.envelope.event_id,
      sequence: entry.sequence,
    };
  }

  /** 模式切换 + 审计（状态仍在内存注册表；这里只记"谁在何时切换过"） */
  setMode(sessionId: string, mode: ExecMode): { mode: ExecMode; changed: boolean; event_id: string | null; sequence: number | null } {
    const result = this.#deps.modes.setMode(sessionId, mode);
    if (result === null) {
      throw new ExecError("session_not_executable", `session ${sessionId} is not executable (closed, deleted or unknown)`);
    }
    if (!result.changed) return { ...result, event_id: null, sequence: null };
    const entry = this.#append(sessionId, EXEC_EVENT_TYPES.modeChanged, {
      mode,
      // 明确记录"不持久化"这一事实，避免事后看账本误以为重启后仍是完全权限
      persisted: false,
    });
    return { ...result, event_id: entry.envelope.event_id, sequence: entry.sequence };
  }

  /** 会话结束时清理（待确认票 + 模式） */
  forgetSession(sessionId: string): void {
    this.#deps.modes.forget(sessionId);
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId === sessionId) this.#pending.delete(id);
    }
  }

  /** 仅测试/诊断：待确认条目数 */
  get pendingCount(): number {
    return this.#pending.size;
  }

  async #execute(
    sessionId: string,
    script: string,
    mode: ExecMode,
    input: { timeoutMs?: number; maxOutputBytes?: number },
  ): Promise<Extract<ExecSubmitOutcome, { status: "executed" }>> {
    const workspace = this.#deps.workspaceOf(sessionId);

    // 快照在**执行前**，失败则不执行（fail-closed）。
    // 无工作区时不快照（没有可保护的对象），并在审计里如实记录。
    let snapshot: SnapshotRecord | null = null;
    if (workspace !== null) {
      snapshot = await this.#deps.snapshots.create({ sessionId, workspaceDir: workspace.path });
    }

    const request: ExecRequest = {
      sessionId,
      script,
      ...(workspace === null ? {} : { workspaceDir: workspace.path, workspaceMode: "rw" as const }),
      timeoutMs: input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      maxOutputBytes: input.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES,
    };

    let result: ExecResultView;
    try {
      result = await this.#deps.runner.run(request);
    } catch (error) {
      // 无容器运行时 → sandbox_unavailable（503）：这条路径也要留下审计
      const message = error instanceof Error ? error.message : String(error);
      this.#append(sessionId, EXEC_EVENT_TYPES.requested, {
        phase: "execution_unavailable",
        script,
        mode,
        error: message,
      });
      throw new ExecError("exec_unavailable", message);
    }

    const entry = this.#append(sessionId, EXEC_EVENT_TYPES.finished, {
      script,
      mode,
      snapshot_id: snapshot?.snapshot_id ?? null,
      snapshot_strategy: snapshot?.strategy ?? null,
      ok: result.ok,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      truncated: result.truncated,
      duration_ms: result.duration_ms,
      engine: result.engine,
      image: result.image,
      container: result.container,
      // stdout/stderr 只留尾部（账本不是日志仓库；主机环境里可能有敏感内容进 stdout）
      stdout_tail: result.stdout.slice(-2000),
      stderr_tail: result.stderr.slice(-2000),
      ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
      ...(result.error === undefined ? {} : { error: result.error }),
    });

    return {
      status: "executed",
      session_id: sessionId,
      mode,
      snapshot_id: snapshot?.snapshot_id ?? null,
      snapshot_strategy: snapshot?.strategy ?? null,
      scope_notice: SNAPSHOT_SCOPE_NOTICE,
      result,
      event_id: entry.envelope.event_id,
      sequence: entry.sequence,
    };
  }

  /** 危险规则命中 → 审计（含被拒脚本原文，事后可归因"Agent 想干什么"） */
  #auditDenied(sessionId: string, script: string, decision: Extract<ExecDecision, { kind: "deny" }>): void {
    this.#append(sessionId, EXEC_EVENT_TYPES.requested, {
      phase: "denied",
      script,
      script_hash: scriptHash(script),
      mode: decision.mode,
      hits: decision.verdict.hits.map((hit) => ({ id: hit.id, level: hit.level, reason: hit.reason })),
    });
  }

  #createPending(sessionId: string, script: string, mode: ExecMode): PendingExec {
    const now = this.#now();
    const hash = scriptHash(script);
    // 同毫秒同脚本重复请求也要拿到不同的票：否则第二次请求会覆盖第一次的待确认，
    // 而 Owner 手里的票指向的可能已经是被替换的那条。
    let confirmationId = `conf_${hash}_${now.getTime().toString(36)}`;
    let attempt = 0;
    while (this.#pending.has(confirmationId)) {
      attempt += 1;
      confirmationId = `conf_${hash}_${now.getTime().toString(36)}_${attempt}`;
    }
    const pending: PendingExec = {
      confirmationId,
      sessionId,
      script,
      scriptHash: hash,
      mode,
      createdAt: now.toISOString(),
      readonly: isReadOnlyScript(script),
      expiresAt: new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString(),
    };
    this.#pending.set(pending.confirmationId, pending);
    return pending;
  }

  /** 窥视（不消费）：approve 需要先拿到脚本原文再走 submit */
  #peekConfirmation(confirmationId: string): PendingExec {
    const pending = this.pendingOf(confirmationId);
    if (pending === null) {
      throw new ExecError("confirmation_not_found", `confirmation ${confirmationId} is unknown or expired`);
    }
    return pending;
  }

  /** 消费（一次性）：先取再删，避免双击重复执行 */
  #consumeConfirmation(confirmationId: string): PendingExec {
    const pending = this.#peekConfirmation(confirmationId);
    this.#pending.delete(confirmationId);
    return pending;
  }

  /**
   * 写审计事件。账本 `append` 只返回 `{ sequence }`（信封是我们自己构造的），
   * 所以这里把两者一起返回——调用方要 event_id（响应）也要 sequence（回链）。
   */
  #append(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): { envelope: EventEnvelope; sequence: number } {
    const envelope = buildEventEnvelope({
      replicaId: this.#deps.replicaId,
      actorId: "owner",
      eventType,
      sessionId,
      payload,
    });
    const { sequence } = this.#deps.ledger.append(envelope);
    return { envelope, sequence };
  }
}

/** 危险规则命中列表（供路由层把 verdict 转成响应） */
export function denyHits(script: string): Array<{ id: string; level: string; reason: string }> {
  return screenScript(script).hits.map((hit) => ({ id: hit.id, level: hit.level, reason: hit.reason }));
}
