/**
 * Plan 模式的阻塞式提问（票 M7-C-T3 / Issue #77，FR-C2）。
 *
 * ## 为什么"阻塞"不能靠 await 工具
 *
 * 天真的实现是让 `request_user_input` 工具 `await` 一个 Promise，等 Owner 回答后
 * resolve。问题：这会**卡住整个 agent 运行**，且若 Owner 不回答（关掉窗口、走开），
 * 那个 Promise 永远挂着，runtime 里就多一个不会结束的轮次——既占内存，也让
 * "这一轮结束了吗"变成不可判定。
 *
 * 正确形态是**两段式**：
 *   1. 工具调用立即返回一个结构化的"我已提问，等待回答"结果（模型本轮就此收尾）；
 *   2. 会话被标记为 `awaiting_input`，SSE 里推一个 question 帧给 UI；
 *   3. Owner 的回答通过**下一轮** `POST /messages` 送达，工具结果里带上它。
 *
 * 对模型来说这就是"提问 → 得到回答"；对进程来说没有任何悬挂的 Promise。语义没变，
 * 但可观测性、可中断性、可持久化性全部变好。
 *
 * ## 状态放哪
 *
 * 待回答的问题放**内存**（与 Plan 模式本身同款：会话级、不持久化）。重启后待回答的
 * 问题消失是合理的——重启意味着这次计划会话被打断了，Owner 重新进 Plan 即可。
 */

/** 一个待回答的问题 */
export interface PendingQuestion {
  /** 稳定 id（回答时要带上，防串轮） */
  question_id: string;
  session_id: string;
  /** 问题原文 */
  question: string;
  /** 模型建议的选项（可为空 = 开放式问题） */
  options?: string[];
  /** 模型推荐的答案（Best 模式必填；Plan 模式可选） */
  recommendation?: string;
  asked_at: string;
  /** 第几轮（对话轮次计数，便于 UI 显示"已问 3 轮"） */
  turn: number;
}

/** 提问结果（工具返回值 ↔ 会话状态共用） */
export interface QuestionOutcome {
  /** 已登记为待回答 */
  pending: PendingQuestion;
  /** 工具返回给模型的文本（模型据此收尾本轮） */
  toolText: string;
}

export class PlanQuestionRegistry {
  readonly #pending = new Map<string, PendingQuestion>();
  readonly #turns = new Map<string, number>();
  readonly #deps: { isOpen(sessionId: string): boolean };

  constructor(deps: { isOpen(sessionId: string): boolean }) {
    this.#deps = deps;
  }

  /**
   * 登记一个问题（替换同一会话先前未回答的问题）。
   *
   * 替换而非排队：一个会话同时只能等一个回答——排队会让 Owner 回答一个之后
   * 立刻看到下一个，节奏失控；而且模型一次问多个问题时本来就该合并。
   */
  ask(input: {
    sessionId: string;
    question: string;
    options?: string[];
    recommendation?: string;
    questionId: string;
    now: Date;
  }): PendingQuestion | null {
    if (!this.#deps.isOpen(input.sessionId)) return null;
    const turn = (this.#turns.get(input.sessionId) ?? 0) + 1;
    this.#turns.set(input.sessionId, turn);
    const pending: PendingQuestion = {
      question_id: input.questionId,
      session_id: input.sessionId,
      question: input.question,
      ...(input.options === undefined ? {} : { options: input.options }),
      ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
      asked_at: input.now.toISOString(),
      turn,
    };
    this.#pending.set(input.sessionId, pending);
    return pending;
  }

  /** 当前待回答的问题（没有则 null） */
  pendingOf(sessionId: string): PendingQuestion | null {
    if (!this.#deps.isOpen(sessionId)) {
      this.#pending.delete(sessionId);
      return null;
    }
    return this.#pending.get(sessionId) ?? null;
  }

  /**
   * 消费回答。
   *
   * `questionId` 必须匹配——防止"上一轮的问题被这一轮的回答误消费"（用户可能连按
   * 两次发送，或 UI 重放）。不匹配返回 null，调用方据此报 409。
   */
  answer(sessionId: string, questionId: string): PendingQuestion | null {
    const pending = this.pendingOf(sessionId);
    if (pending === null || pending.question_id !== questionId) return null;
    this.#pending.delete(sessionId);
    return pending;
  }

  /** 工具给出的回答提示（模型看到的"我提了问，等回答"） */
  static toolTextFor(pending: PendingQuestion): string {
    const optionLine =
      pending.options === undefined || pending.options.length === 0
        ? ""
        : `\n可选：${pending.options.join(" / ")}`;
    const recommendLine =
      pending.recommendation === undefined ? "" : `\n我倾向：${pending.recommendation}`;
    return [
      "我已向使用者提问，正在等待回答。",
      `问题：${pending.question}${optionLine}${recommendLine}`,
      "",
      "这一轮到此结束；收到回答后继续。不要自行假设答案。",
    ].join("\n");
  }

  forget(sessionId: string): void {
    this.#pending.delete(sessionId);
    this.#turns.delete(sessionId);
  }

  /** 已问轮次（Best 模式的访谈上限用它） */
  turnsOf(sessionId: string): number {
    return this.#turns.get(sessionId) ?? 0;
  }

  get size(): number {
    return this.#pending.size;
  }
}
