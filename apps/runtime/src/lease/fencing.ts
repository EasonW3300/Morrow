import type { LeaseStore } from "./store.ts";

/**
 * Fencing guard（M3-T4 / Issue #33，FR-DEP-4）。
 *
 * 所有「对外副作用提交」在真正执行前调用 `assertCanCommit(taskId, token)`：租约仍由
 * 本副本持有、token 未被抢占、未过期。旧 token（租约被抢占/转移后）抛 LeaseLostError，
 * 调用方必须中止并记 task.lease_lost——不得把副作用算到新持有者头上。
 *
 * 当前落点（见 scheduler.ts 与 sandbox/invoker.ts）：
 * 1. 调度器节点完成提交（setNodeFinished completed / task.node_finished）前；
 * 2. worktree 变更合回主区（真实文件副作用）前；
 * 3. capability / Skill 调用携带 {taskId, fencingToken} 上下文时，执行体运行前。
 * 边界：不带任务上下文的直接 Owner 调用（/v1/capabilities/:id/invoke 无 taskId）不在
 * 任一 Run 的租约下，按设计不受 fencing 约束；工具通道当前未默认注入节点执行，
 * 因此第 3 点是给宿主/后续票接线用的前置 hook。
 */

export class LeaseLostError extends Error {
  readonly code = "lease_lost";
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "LeaseLostError";
    this.details = details;
  }
}

/** 调用上下文里的任务租约字段（与 sandbox InvokeContext / skill invoke 选项同构） */
export interface FencingContext {
  taskId?: string;
  fencingToken?: number;
}

export class FencingGuard {
  readonly #store: LeaseStore;

  constructor(store: LeaseStore) {
    this.#store = store;
  }

  /** 副作用提交前校验：token 失效即抛 LeaseLostError。 */
  assertCanCommit(taskId: string, token: number): void {
    if (!this.#store.validate(taskId, token)) {
      throw new LeaseLostError(
        `execution lease for task ${taskId} is no longer held by this replica (fencing token ${token} is stale)`,
        { task_id: taskId, fencing_token: token },
      );
    }
  }

  /**
   * 调用上下文适配：无 taskId/fencingToken 的调用 = 任务租约范围外（直接 Owner 调用），
   * 跳过；只带其一的上下文是接线错误，静默放行会破坏单点执行 → 直接拒绝。
   */
  assertContext(context: FencingContext | undefined): void {
    if (context === undefined) return;
    const { taskId, fencingToken } = context;
    if (taskId === undefined && fencingToken === undefined) return;
    if (taskId === undefined || fencingToken === undefined) {
      throw new LeaseLostError("execution fencing context requires both taskId and fencingToken", {
        task_id: taskId ?? null,
        fencing_token: fencingToken ?? null,
      });
    }
    this.assertCanCommit(taskId, fencingToken);
  }
}
