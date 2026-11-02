import type { AgentRuntime, MorrowAgentEvent } from "@morrow/pi-adapter";
import { buildEventEnvelope } from "./envelope.ts";
import type { EventLedger } from "./ledger.ts";
import type { TaskNodeRecord } from "@morrow/protocol";
import { TASK_EVENT_TYPES, TaskError, type TaskService } from "./tasks.ts";
import { SESSION_EVENT_TYPES } from "./sessions.ts";

/**
 * 单机任务调度器（票 M1-T4 / Issue #16，FR-TASK-1 的调度半边）。
 *
 * 调度模型（M1 单机、单副本）：
 * - 就绪判定：节点 pending 且其全部依赖（task_edges 入边）completed——顺序由依赖
 *   拓扑保证；无资源冲突概念的 M1 版本即「就绪即可跑」，工作区隔离/资源锁是
 *   FR-TASK-8（P1）的事；
 * - 并行：同批就绪节点并发执行，在跑数受 concurrency 上限约束（可配置，默认 2，
 *   最小 1）；同批按 node_seq（规划序）优先派发，行为确定；
 * - 多任务：schedule() 入队 FIFO 逐任务驱动（同一时刻至多一个任务在派发）——
 *   concurrency 是调度器级上限，串行化让它跨任务成立，任务内节点并行不受影响；
 * - 节点执行 = 一次 Agent Loop（复用 sessions.ts 的驱动模式：subscribe 窄事件 →
 *   账本事件 + causation 链）。工具事件复用既有 tool.started/tool.finished 类型
 *   （只加演进：信封带 task_id），causation 链到 task.node_started；
 * - 失败：节点失败（error 事件 / stop_reason error|aborted / prompt 拒绝 / 工厂抛错）
 *   时 retriable 节点自动重试一次（attempts=2）；最终失败标记节点 failed，等在跑
 *   兄弟节点收尾后整任务迁 failed（task.failed payload 带 node_id 与原因）；
 * - 暂停：每次派发前检查任务状态，非 running（paused/cancelled）即停止派发新节点，
 *   在跑节点自然收尾；恢复调度是 FR-TASK-3 的接续工作。
 *
 * 事件 actor 一律 agent:runtime；全部事件 task_id 关联，可经
 * GET /v1/tasks/:id/events（账本 task_id 专列）查询。
 */

export const DEFAULT_TASK_CONCURRENCY = 2;
const MAX_ATTEMPTS_RETRIABLE = 2;

/** 节点执行输入（工厂 seam：生产按 Provider 构建 PiAdapter；测试注入 FakePi 脚本） */
export interface TaskNodeExecInput {
  taskId: string;
  nodeId: string;
  key: string;
  title: string;
  /** 执行指令：节点 goal，缺省 title */
  goal: string;
  agentRole?: string;
  model?: string;
  /** 第几次尝试（1 起；retriable 节点失败重试时为 2） */
  attempt: number;
}

export type NodeAgentFactory = (node: TaskNodeExecInput) => Promise<AgentRuntime>;

export interface TaskSchedulerOptions {
  tasks: TaskService;
  ledger: EventLedger;
  replicaId: string;
  /** null 时每个节点尝试即失败（error = 说明），任务以 failed 收尾——诚实留痕而非静默 */
  nodeAgentFactory: NodeAgentFactory | null;
  /** 同时在跑节点上限；默认 2，最小 1 */
  concurrency?: number;
}

interface NodeOutcome {
  ok: boolean;
  text: string;
  error?: string;
  stopReason?: string;
}

export class TaskScheduler {
  readonly #tasks: TaskService;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #factory: NodeAgentFactory | null;
  readonly #concurrency: number;
  readonly #active = new Set<AgentRuntime>();
  /** 待调度的任务 FIFO（schedule 串行化：并发上限按调度器全局记账，不按单任务） */
  readonly #queue: Array<{ taskId: string; resolve: () => void; reject: (err: unknown) => void }> = [];
  #draining = false;
  #disposed = false;

  constructor(options: TaskSchedulerOptions) {
    this.#tasks = options.tasks;
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#factory = options.nodeAgentFactory;
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_TASK_CONCURRENCY));
  }

  /**
   * 驱动一个 planned 任务到终端态（或被外部暂停/取消而停止）。
   * 入队 FIFO 逐个驱动（同一时刻至多一个任务在 #drive）：并发上限是调度器级资源，
   * 串行化让「同时在跑节点 ≤ concurrency」跨任务成立；任务内的节点并行不受影响。
   * 只接受 planned 状态（否则 invalid_transition——running/planned 之外的迁移由
   * 状态机拒绝）；resolve 表示本轮调度结束（任务 completed/failed 或暂停让位）。
   */
  schedule(taskId: string): Promise<void> {
    const task = this.#tasks.getTask(taskId);
    if (task === null) {
      return Promise.reject(new TaskError("not_found", `task ${taskId} does not exist`));
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ taskId, resolve, reject });
      void this.#drain();
    });
  }

  /** 优雅退出：拒绝未开跑的排队任务、中止在跑节点运行时并等待收尾（上限 2s） */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const entry of this.#queue.splice(0)) {
      entry.reject(new Error("task scheduler disposed before the task started"));
    }
    const runtimes = [...this.#active];
    for (const runtime of runtimes) runtime.abort();
    if (runtimes.length > 0) {
      await Promise.race([
        Promise.allSettled(runtimes.map((runtime) => runtime.waitForIdle())),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  }

  // --- 调度主循环 --------------------------------------------------------------

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0 && !this.#disposed) {
        const next = this.#queue.shift() as { taskId: string; resolve: () => void; reject: (err: unknown) => void };
        try {
          await this.#scheduleOne(next.taskId);
          next.resolve();
        } catch (err) {
          next.reject(err);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #scheduleOne(taskId: string): Promise<void> {
    const task = this.#tasks.getTask(taskId);
    if (task === null) {
      throw new TaskError("not_found", `task ${taskId} does not exist`);
    }
    if (task.status !== "planned") {
      throw new TaskError(
        "invalid_transition",
        `task ${taskId} is ${task.status}, expected planned before scheduling`,
        { from: task.status, to: "running" },
      );
    }
    // causation 链：task.started 由规划完成触发 → 指向 task.planned 事件
    const plannedEvent = this.#ledger
      .scan({ taskId, eventType: TASK_EVENT_TYPES.taskPlanned })
      .at(-1);
    const started = this.#tasks.transition(taskId, "running", {
      causeEventId: plannedEvent?.envelope.event_id ?? null,
    });
    await this.#drive(taskId, started.eventId);
  }

  // --- 调度主循环 --------------------------------------------------------------

  async #drive(taskId: string, startedEventId: string): Promise<void> {
    const inflight = new Map<string, { promise: Promise<void>; entry: { done: boolean } }>();
    while (!this.#disposed) {
      const task = this.#tasks.getTask(taskId);
      if (task === null || task.status !== "running") return; // 被外部 paused/cancelled/failed

      const nodes = task.nodes;
      const completedKeys = new Set(nodes.filter((n) => n.status === "completed").map((n) => n.key));
      const ready = nodes.filter(
        (n) => n.status === "pending" && n.depends_on.every((dep) => completedKeys.has(dep)),
      );
      for (const node of ready) {
        if (inflight.size >= this.#concurrency) break;
        const entry = { done: false };
        const promise = this.#runNode(taskId, node, startedEventId)
          .catch((err: unknown) => {
            // runNode 不应抛（节点失败已留痕）；兜底防未处理拒绝中断调度
            console.error("[morrow] task node runner crashed:", err);
          })
          .finally(() => {
            entry.done = true;
          });
        inflight.set(node.node_id, { promise, entry });
      }

      if (inflight.size === 0) {
        const fresh = this.#tasks.getTask(taskId);
        if (fresh === null || fresh.status !== "running") return;
        const nodesNow = fresh.nodes;
        const failedNode = nodesNow.find((n) => n.status === "failed");
        if (failedNode !== undefined) {
          this.#tasks.transition(taskId, "failed", {
            causeEventId: startedEventId,
            payload: {
              reason: "node_failed",
              node_id: failedNode.node_id,
              key: failedNode.key,
              message: failedNode.error ?? "node failed",
            },
            error: `node "${failedNode.key}" failed: ${failedNode.error ?? "unknown"}`,
          });
          return;
        }
        if (nodesNow.length > 0 && nodesNow.every((n) => n.status === "completed")) {
          this.#tasks.transition(taskId, "completed", {
            causeEventId: startedEventId,
            payload: {
              nodes_completed: nodesNow.length,
              nodes_total: nodesNow.length,
            },
          });
          return;
        }
        // 无就绪、无在跑、未完成：合法 DAG（规划期已拒环）不会到达；防御性收尾
        this.#tasks.transition(taskId, "failed", {
          causeEventId: startedEventId,
          payload: { reason: "stalled" },
          error: "scheduler stalled: no runnable nodes",
        });
        return;
      }

      await Promise.race([...inflight.values()].map((running) => running.promise));
      for (const [nodeId, running] of [...inflight]) {
        if (running.entry.done) inflight.delete(nodeId);
      }
    }
  }

  // --- 节点执行（一次 Agent Loop；失败按 retriable 重试一次）--------------------

  async #runNode(taskId: string, node: TaskNodeRecord, startedEventId: string): Promise<void> {
    const totalAttempts = node.retriable ? MAX_ATTEMPTS_RETRIABLE : 1;
    let outcome: NodeOutcome = { ok: false, text: "", error: "node did not run" };
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      this.#tasks.setNodeRunning(node.node_id, attempt);
      const nodeStarted = this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeStarted, {
        node_id: node.node_id,
        key: node.key,
        title: node.title,
        goal: node.goal ?? node.title,
        attempt,
      }, startedEventId);

      outcome = await this.#attemptNode(taskId, node, attempt, nodeStarted.eventId);

      const status = outcome.ok ? "completed" : "failed";
      const payload: Record<string, unknown> = {
        node_id: node.node_id,
        key: node.key,
        status,
        attempt,
      };
      if (outcome.text.length > 0) payload.result = outcome.text;
      if (!outcome.ok && outcome.error !== undefined) payload.error = outcome.error;
      if (outcome.stopReason !== undefined) payload.stop_reason = outcome.stopReason;
      this.#appendTaskEvent(taskId, TASK_EVENT_TYPES.taskNodeFinished, payload, nodeStarted.eventId);

      if (outcome.ok) {
        this.#tasks.setNodeFinished(node.node_id, "completed", { result: outcome.text });
        return;
      }
      this.#tasks.setNodeFinished(node.node_id, "failed", { error: outcome.error });
      // retriable 且未用尽尝试 → 继续循环重试；否则保持 failed 由主循环收敛任务状态
    }
  }

  /** 单次尝试：取运行时（工厂抛错即失败）→ 驱动 Agent Loop → 产出结果 */
  async #attemptNode(
    taskId: string,
    node: TaskNodeRecord,
    attempt: number,
    nodeStartedEventId: string,
  ): Promise<NodeOutcome> {
    const input: TaskNodeExecInput = {
      taskId,
      nodeId: node.node_id,
      key: node.key,
      title: node.title,
      goal: node.goal ?? node.title,
      ...(node.agent_role === undefined ? {} : { agentRole: node.agent_role }),
      ...(node.model === undefined ? {} : { model: node.model }),
      attempt,
    };
    let runtime: AgentRuntime;
    try {
      if (this.#factory === null) {
        throw new Error("no node agent factory configured (taskNodeFactory missing)");
      }
      runtime = await this.#factory(input);
    } catch (err) {
      return { ok: false, text: "", error: errorMessage(err) };
    }
    return this.#driveRuntime(taskId, node, attempt, runtime, nodeStartedEventId);
  }

  /** Agent Loop 驱动（复用 sessions.ts 的窄事件翻译模式，事件挂 task_id） */
  async #driveRuntime(
    taskId: string,
    node: TaskNodeRecord,
    attempt: number,
    runtime: AgentRuntime,
    nodeStartedEventId: string,
  ): Promise<NodeOutcome> {
    this.#active.add(runtime);
    // 累积值收在 holder 对象里：闭包内赋值 + await 后读取，避免 TS CFA 过窄收窄
    const run: { text: string; error: string | null; stopReason: string | null } = {
      text: "",
      error: null,
      stopReason: null,
    };
    const toolStarted = new Map<string, string>();
    const appendAgentError = (message: string): void => {
      run.error = message;
      this.#appendTaskEvent(taskId, SESSION_EVENT_TYPES.agentError, {
        message,
        node_id: node.node_id,
        key: node.key,
        attempt,
      }, nodeStartedEventId);
    };
    const unsubscribe = runtime.subscribe((event: MorrowAgentEvent) => {
      switch (event.type) {
        case "text_delta": {
          run.text += event.delta;
          break;
        }
        case "tool_start": {
          const started = this.#appendTaskEvent(taskId, SESSION_EVENT_TYPES.toolStarted, {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            args: event.args ?? null,
            node_id: node.node_id,
            key: node.key,
            attempt,
          }, nodeStartedEventId);
          toolStarted.set(event.toolCallId, started.eventId);
          break;
        }
        case "tool_end": {
          const payload: Record<string, unknown> = {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            text: event.text,
            is_error: event.isError,
            node_id: node.node_id,
            key: node.key,
            attempt,
          };
          if (event.durationMs !== undefined) payload.duration_ms = event.durationMs;
          this.#appendTaskEvent(taskId, SESSION_EVENT_TYPES.toolFinished, payload, toolStarted.get(event.toolCallId) ?? nodeStartedEventId);
          break;
        }
        case "error": {
          appendAgentError(event.message);
          break;
        }
        case "agent_end": {
          run.stopReason = event.stopReason;
          break;
        }
      }
    });
    try {
      await runtime.prompt(node.goal ?? node.title);
    } catch (err) {
      // 契约上 prompt 只在误用/中止时 reject；防御性兜底落 agent.error 留痕
      if (run.error === null) {
        appendAgentError(errorMessage(err));
      }
    } finally {
      unsubscribe();
      this.#active.delete(runtime);
      runtime.dispose();
    }

    const aborted = run.stopReason === "aborted";
    const ok = run.error === null && !aborted && run.stopReason !== "error";
    const error = ok
      ? undefined
      : run.error ?? (aborted ? "agent loop aborted" : "agent loop ended with stop_reason error");
    return {
      ok,
      text: run.text,
      ...(error === undefined ? {} : { error }),
      ...(run.stopReason === null ? {} : { stopReason: run.stopReason }),
    };
  }

  #appendTaskEvent(
    taskId: string,
    eventType: string,
    payload: Record<string, unknown>,
    causationId: string | null,
  ): { eventId: string; sequence: number } {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType,
      taskId,
      payload,
      causationId,
    });
    const { sequence } = this.#ledger.append(envelope);
    return { eventId: envelope.event_id, sequence };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
