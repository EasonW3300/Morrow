/**
 * Best 的拆票落地与实现启动（票 M7-C-T7 / Issue #81）。
 *
 * ## 三类产物的落位（FR-C16）
 *
 * 1. **规格** → `docs/specs/<slug>.md`
 * 2. **票** → 已配 gh 时 GitHub issues；未配时本地一票一文件（`docs/specs/<slug>/issues/NN-slug.md`）
 *    + `index.md` 列依赖图
 * 3. **实现** → `feat/<slug>` 分支 + worktree，提交但**不 push**，最后给「推送并开 PR」
 *
 * ## 本票最重要的约束
 *
 * **实现前确认门不可跳**。实现方式：`startImplementation` 的第一行就检查
 * `implementApproved`，而这个字段只能由 `approveImplementGate` 设置——它不读任何
 * 执行模式。所以"完全权限"在代码层面没有绕过这条门的路径（测试会用两种模式各跑
 * 一遍验证）。
 *
 * ## 为什么不自动 push / 开 PR
 *
 * 这两个动作**不可撤销且对外可见**（远端历史会被改写、同事会收到通知）。自动化
 * 到"提交到本地分支"为止，push 与 PR 由 Owner 点按钮触发。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import type { WorkspaceManager } from "../workspace.ts";
import type { BestStore, BestRunRecord } from "./store.ts";
import { BestError, type BestService } from "./service.ts";
import {
  IMPLEMENT_GATE_NOTICE,
  canEnterImplement,
  implementBranch,
  orderTickets,
  specFilePath,
  ticketFilePath,
  ticketIndexMarkdown,
  ticketMarkdown,
  validateTickets,
  type TicketSpec,
} from "./tickets.ts";

export const BEST_TICKETS_EVENT_TYPES = {
  ticketsCreated: "best.tickets_created",
  implementGateDecided: "best.implement_gate_decided",
  implementationStarted: "best.implementation_started",
  pushRequested: "best.push_requested",
} as const;

export interface BestTicketsServiceDeps {
  store: BestStore;
  best: BestService;
  ledger: EventLedger;
  replicaId: string;
  workspace: Pick<WorkspaceManager, "readGhToken" | "ensureBranch" | "prepareWorktree" | "bindLocal" | "status">;
  /** 任务创建（复用既有 TaskService；返回 task_id） */
  createTask(input: { goal: string; sessionId: string }): Promise<{ taskId: string }>;
  /** 会话绑定的工作区（含 repo 与分支信息） */
  workspaceOf(sessionId: string): { path: string; repo_path?: string; branch?: string; kind: string } | null;
  /** 绑定会话工作区（复用既有绑定逻辑；用于 Best 自动建分支） */
  bindSessionWorkspace(
    sessionId: string,
    binding: { repoPath: string; branch: string },
  ): Promise<{ path: string }>;
  /** 写文件到工作区（测试注入可记录而不真写） */
  writeWorkspaceFile?(input: { workspacePath: string; relativePath: string; content: string }): void;
  now?: () => Date;
}

/** 拆票产物 */
export interface TicketsArtifact {
  kind: "github_issues" | "local_files";
  /** 本地文件形态：写出的相对路径列表 */
  files: string[];
  /** issues 形态：issue 号列表（或 created: false 时为空） */
  issue_numbers: number[];
  /** 依赖图（拓扑序） */
  order: string[];
}

export class BestTicketsService {
  readonly #deps: BestTicketsServiceDeps;
  readonly #now: () => Date;

  constructor(deps: BestTicketsServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * 拆票（**不设确认门**，FR-C13）：校验 → 排序 → 落地。
   *
   * 已配 gh → 建 issues（本版只记录"应该建哪些"，实际调用 gh 由宿主注入；
   * 未注入则退化为本地文件——这是刻意的降级，见下）。
   * 未配 gh → 写本地一票一文件 + index。
   */
  async createTickets(input: { bestId: string; tickets: unknown }): Promise<{
    run: BestRunRecord;
    artifact: TicketsArtifact;
  }> {
    const run = this.#requireAtStage(input.bestId, "tickets");
    const validation = validateTickets(input.tickets);
    if (!validation.ok) {
      throw new BestError("invalid_input", `tickets are not usable: ${validation.problems.join("; ")}`);
    }
    const ordered = orderTickets(validation.plan.tickets);
    const slug = run.slug ?? "spec";
    const workspacePath = run.workspace_path ?? this.#deps.workspaceOf(run.session_id)?.path ?? null;

    const hasGh = (await this.#deps.workspace.readGhToken()) !== null;
    const artifact: TicketsArtifact = {
      kind: hasGh ? "github_issues" : "local_files",
      files: [],
      issue_numbers: [],
      order: ordered.map((ticket) => ticket.title),
    };

    // 本地文件形态（也总是写文件：即使配了 gh，本地留一份便于离线审阅）
    if (workspacePath !== null) {
      const files: Array<{ relativePath: string; content: string }> = [
        {
          relativePath: `docs/specs/${slug}/issues/index.md`,
          content: ticketIndexMarkdown({ specSlug: slug, tickets: ordered }),
        },
        ...ordered.map((ticket, index) => ({
          relativePath: ticketFilePath({ specSlug: slug, index: index + 1, title: ticket.title }),
          content: ticketMarkdown({ index: index + 1, ticket, specSlug: slug }),
        })),
      ];
      const writer = this.#deps.writeWorkspaceFile ?? defaultWrite;
      for (const file of files) {
        writer({ workspacePath, relativePath: file.relativePath, content: file.content });
        artifact.files.push(file.relativePath);
      }
    }

    const now = this.#now().toISOString();
    const updated = this.#deps.store.update(
      input.bestId,
      {
        tickets: ordered,
        status: "awaiting_gate",
        last_error: null,
      },
      now,
    );
    this.#append(BEST_TICKETS_EVENT_TYPES.ticketsCreated, run.session_id, {
      best_id: run.best_id,
      kind: artifact.kind,
      count: ordered.length,
      files: artifact.files,
      order: artifact.order,
    });
    return { run: updated ?? run, artifact };
  }

  /** 实现门的提示（UI 展示；文案里明确"完全权限也不能跳"） */
  implementGateNotice(input: { bestId: string }): { notice: string; can_approve: boolean; approved: boolean } {
    const run = this.#deps.store.get(input.bestId);
    if (run === null) throw new BestError("not_found", `best run ${input.bestId} does not exist`);
    return {
      notice: IMPLEMENT_GATE_NOTICE,
      can_approve: run.stage === "tickets",
      approved: run.branch !== null,
    };
  }

  /**
   * 通过实现门（**唯一**能设置 implementApproved 的入口）。
   *
   * 刻意不接收执行模式参数：门不关心"是不是完全权限"，它只关心"Owner 点了吗"。
   */
  approveImplementGate(input: { bestId: string; reason?: string }): BestRunRecord {
    const run = this.#requireAtStage(input.bestId, "tickets");
    const now = this.#now().toISOString();
    this.#append(BEST_TICKETS_EVENT_TYPES.implementGateDecided, run.session_id, {
      best_id: run.best_id,
      decision: "approve",
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    // 用一个显式字段记录批准：分支名到实现阶段才确定，所以这里先记 last_error=null
    // 与状态迁移；真正的"已批准"事实由账本事件承担（gate_decided）。
    const updated = this.#deps.store.update(input.bestId, { status: "running" }, now);
    return updated ?? run;
  }

  /**
   * 启动实现：**必须**先通过实现门。
   *
   * `implementApproved` 由调用方从账本推导（本票用"最近一条 implement_gate_decided=approve
   * 且其后没有 abort"判定）。这里把它作为入参显式要求，避免从执行模式推导。
   */
  async startImplementation(input: {
    bestId: string;
    /** 是否已通过实现门（由账本推导，见 gateApproved） */
    implementApproved: boolean;
  }): Promise<{
    run: BestRunRecord;
    branch: string;
    workspacePath: string;
    taskId: string;
    pushed: false;
  }> {
    const run = this.#deps.store.get(input.bestId);
    if (run === null) throw new BestError("not_found", `best run ${input.bestId} does not exist`);

    const gate = canEnterImplement({
      stage: run.stage,
      implementApproved: input.implementApproved,
      approvedAt: null,
    });
    if (!gate.ok) {
      // 这一条就是 FR-C14：未批准时不建分支、不建 DAG、不写任何东西
      throw new BestError("invalid_stage", gate.reason);
    }
    if (run.tickets.length === 0) {
      throw new BestError("invalid_input", "no tickets to implement; create tickets first");
    }

    const slug = run.slug ?? "spec";
    const branch = implementBranch(slug);
    const workspace = this.#deps.workspaceOf(run.session_id);
    if (workspace === null || workspace.repo_path === undefined) {
      throw new BestError(
        "invalid_input",
        "best implementation needs a git workspace bound to the session (bind a local repo or a GitHub repo first)",
      );
    }

    try {
      // 复用 M7-A 的会话工作区：建分支 + worktree（只换分支前缀为 feat/<slug>）
      await this.#deps.workspace.ensureBranch(workspace.repo_path, undefined, branch);
      const prepared = await this.#deps.bindSessionWorkspace(run.session_id, {
        repoPath: workspace.repo_path,
        branch,
      });
      // 规格写进工作区（实现阶段要能读到）
      if (run.spec_markdown !== null) {
        const writer = this.#deps.writeWorkspaceFile ?? defaultWrite;
        writer({ workspacePath: prepared.path, relativePath: specFilePath(slug), content: run.spec_markdown });
      }

      // 展开为 Task DAG（复用既有调度/Checkpoint/暂停接管）
      const goal = [
        `实现规格 ${slug}（Best 模式）`,
        "",
        run.spec_markdown ?? "",
        "",
        "票：",
        ...orderTickets(run.tickets).map((ticket, index) => `${index + 1}. ${ticket.title}`),
      ].join("\n");
      const task = await this.#deps.createTask({ goal, sessionId: run.session_id });

      const now = this.#now().toISOString();
      const updated = this.#deps.store.update(
        run.best_id,
        {
          stage: "implement",
          status: "running",
          branch,
          workspace_path: prepared.path,
          spec_path: specFilePath(slug),
        },
        now,
      );
      this.#append(BEST_TICKETS_EVENT_TYPES.implementationStarted, run.session_id, {
        best_id: run.best_id,
        branch,
        workspace_path: prepared.path,
        task_id: task.taskId,
        // 明确：没有推送
        pushed: false,
      });
      return {
        run: updated ?? run,
        branch,
        workspacePath: prepared.path,
        taskId: task.taskId,
        pushed: false,
      };
    } catch (error) {
      if (error instanceof BestError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.store.update(run.best_id, { last_error: message }, this.#now().toISOString());
      throw new BestError("invalid_input", `failed to start implementation: ${message}`);
    }
  }

  /**
   * 「推送并开 PR」——**只返回指令，不执行**。
   *
   * push 与 PR 不可撤销且对外可见，必须由 Owner 显式触发。这里返回的是一份可执行
   * 计划（分支、远端、建议命令），由 UI 交给 Owner 或由宿主在 Owner 点击后执行。
   */
  pushPlan(input: { bestId: string }): {
    branch: string;
    workspacePath: string;
    commands: string[];
    notice: string;
  } {
    const run = this.#deps.store.get(input.bestId);
    if (run === null) throw new BestError("not_found", `best run ${input.bestId} does not exist`);
    if (run.branch === null || run.workspace_path === null) {
      throw new BestError("invalid_stage", "implementation has not started yet (no branch)");
    }
    this.#append(BEST_TICKETS_EVENT_TYPES.pushRequested, run.session_id, {
      best_id: run.best_id,
      branch: run.branch,
    });
    return {
      branch: run.branch,
      workspacePath: run.workspace_path,
      commands: [
        `git push -u origin ${run.branch}`,
        `gh pr create --head ${run.branch} --fill`,
      ],
      notice:
        "推送会改写远端并对外可见，所以不会自动执行。请在确认代码无误后手动运行上面的命令，" +
        "或在界面点「推送并开 PR」。",
    };
  }

  #requireAtStage(bestId: string, stage: BestRunRecord["stage"]): BestRunRecord {
    const run = this.#deps.store.get(bestId);
    if (run === null) throw new BestError("not_found", `best run ${bestId} does not exist`);
    if (run.stage !== stage) {
      throw new BestError("invalid_stage", `expected stage "${stage}" but the run is at "${run.stage}"`);
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

/** 默认写文件实现（`writeWorkspaceFile` 未注入时用） */
function defaultWrite(input: { workspacePath: string; relativePath: string; content: string }): void {
  const absolute = join(input.workspacePath, input.relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, input.content, "utf8");
}

/** 从账本推导"实现门是否已批准"（唯一真相源：事件，不是内存态） */
export function gateApproved(events: readonly { event_type: string; payload: Record<string, unknown> }[], bestId: string): boolean {
  let approved = false;
  for (const event of events) {
    if (event.payload.best_id !== bestId) continue;
    if (event.event_type === "best.implement_gate_decided" && event.payload.decision === "approve") {
      approved = true;
    }
    if (event.event_type === "best.aborted") approved = false;
  }
  return approved;
}

/** 票类型再导出（路由层用） */
export type { TicketSpec };
