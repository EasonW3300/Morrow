import type { AgentRuntime, MorrowAgentEvent } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import { buildEventEnvelope } from "./envelope.ts";
import type { EventLedger, LedgerEntry } from "./ledger.ts";
import type { ProviderResolver, ResolvedProvider } from "./providers.ts";
import { uuidv7 } from "./uuid-v7.ts";

/**
 * 会话贯通（票 T4 / Issue #5）：SessionManager = 会话事件族 → 账本 + Agent Loop。
 * Provider 绑定（票 T5 / Issue #6）：会话创建可选 provider_id（显式绑定，落在
 * session.created payload），无绑定用当前默认 Provider（解析发生在发消息时——
 * 改默认只影响之后发送的无绑定会话）。Provider 解析与密钥解析由 ProviderResolver
 * 完成（ProviderRegistry 实现）；本模块只见 ResolvedProvider，不触凭据库。
 *
 * M0 会话事件族（event_type 清单只增不减，payload 约定见 README）：
 *   session.created   actor owner           建会话（payload 可含 provider_id 显式绑定）
 *   message.user      actor owner           用户输入（causation null）
 *   tool.started      actor agent:runtime   工具开始（causation → 触发运行的 message.user）
 *   tool.finished     actor agent:runtime   工具结束（causation → 对应 tool.started）
 *   agent.error       actor agent:runtime   供应商/运行错误（causation → message.user）
 *   message.assistant actor agent:runtime   助手消息，每轮恰好一条收尾
 *                     （error/aborted 轮也落盘，text 为已产出前缀，stop_reason 区分；
 *                      causation → message.user）
 *
 * 串行语义：同会话输入 FIFO 排队（POST 立即 202），Agent Loop 逐轮驱动，
 * 不并发、不丢事件。文本增量（text_delta）是易失的展示层事件，只进 SSE 不进账本；
 * 账本里 message.assistant 的 text 是权威全文。
 */

/** M0 会话事件族类型名（与 GLOSSARY Session/Message 对齐；点分风格同 runtime.* / PRD §6.3 tool.started） */
export const SESSION_EVENT_TYPES = {
  sessionCreated: "session.created",
  messageUser: "message.user",
  messageAssistant: "message.assistant",
  agentError: "agent.error",
  toolStarted: "tool.started",
  toolFinished: "tool.finished",
} as const;

/** 生产默认 createPiAdapter；测试注入 FakePi（同构 AgentRuntime 接口）。
 *  provider 为会话解析出的运行时配置（ProviderResolver 未配置时为 null）；
 *  注入工厂可忽略该参数（少参函数在 TS 中可赋值给多参签名，旧测试无需改动）。 */
export type AgentAdapterFactory = (sessionId: string, provider: ResolvedProvider | null) => Promise<AgentRuntime>;

/** 会话事件流上的一帧：账本事件（带序号，SSE 里作 id）/ 文本增量 / 本轮结束标记 */
export type SessionFrame =
  | { kind: "event"; sequence: number; envelope: EventEnvelope }
  | { kind: "delta"; delta: string }
  | { kind: "done" };

/** 会话列表条目（session.created 投影；provider_id 仅显式绑定时存在） */
export interface SessionSummary {
  session_id: string;
  event_id: string;
  sequence: number;
  occurred_at: string;
  title?: string;
  provider_id?: string;
}

/** 历史投影条目（message.user / message.assistant 投影） */
export interface MessageRecord {
  message_id: string;
  role: "user" | "assistant";
  text: string;
  /** 仅 assistant：一次运行的收尾原因（Pi StopReason 透传） */
  stop_reason?: string;
  event_id: string;
  sequence: number;
  occurred_at: string;
}

export interface SessionHistory {
  session_id: string;
  messages: MessageRecord[];
}

interface QueuedInput {
  userEventId: string;
  messageId: string;
  text: string;
}

interface SessionState {
  frames: Set<(frame: SessionFrame) => void>;
  runtime: AgentRuntime | null;
  running: boolean;
  queue: QueuedInput[];
}

export interface SessionManagerOptions {
  ledger: EventLedger;
  replicaId: string;
  /** null 表示未配置 Provider：发消息在 HTTP 层即 503（provider_not_configured） */
  factory: AgentAdapterFactory | null;
  /**
   * Provider 解析面（票 T5）：默认工厂路径注入 ProviderRegistry；注入工厂的测试/宿主
   * 可不传（null = 不解析 provider，工厂收到 null，行为与 T4 一致）。
   */
  providers?: ProviderResolver | null;
  /**
   * 发送前是否要求存在可解析的默认 Provider（HTTP 层 503 预检依据）。默认 false
   * （T4 注入工厂语义：factory 非 null 即可用）；startRuntime 的默认工厂路径设 true。
   */
  providerRequired?: boolean;
  /** factory 为 null 时给客户端的说明 */
  factoryUnavailableReason?: string;
}

export class SessionManager {
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #factory: AgentAdapterFactory | null;
  readonly #providers: ProviderResolver | null;
  readonly #providerRequired: boolean;
  readonly #factoryUnavailableReason: string;
  readonly #states = new Map<string, SessionState>();
  #disposed = false;

  constructor(options: SessionManagerOptions) {
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#factory = options.factory;
    this.#providers = options.providers ?? null;
    this.#providerRequired = options.providerRequired ?? false;
    this.#factoryUnavailableReason =
      options.factoryUnavailableReason ??
      "no model provider configured (register one via POST /v1/providers or set MORROW_PROVIDER_BASE_URL / MORROW_PROVIDER_API_KEY / MORROW_PROVIDER_MODEL)";
  }

  /** factory 是否可用（HTTP 层据此在记账前快速失败）。
   *  注入工厂路径（providerRequired=false）恒可用；默认工厂路径看是否存在可解析的默认 Provider。 */
  get agentAvailable(): boolean {
    if (this.#factory === null) return false;
    if (!this.#providerRequired) return true;
    return this.#providers !== null && this.#providers.hasDefault();
  }

  get agentUnavailableReason(): string {
    return this.#factoryUnavailableReason;
  }

  /**
   * 建会话：session.created 入账本（actor owner；session_id = 新 uuid v7）。
   * providerId（票 T5）：显式 Provider 绑定，存在性由 HTTP 层经 ProviderResolver 校验
   * （未知 id → 400 unknown_provider）；落进 payload，列表与重启后按账本重放投影。
   */
  createSession(title?: string, providerId?: string): { sessionId: string; eventId: string; sequence: number; occurredAt: string } {
    const sessionId = uuidv7();
    const payload: Record<string, unknown> = {
      ...(title === undefined ? {} : { title }),
      ...(providerId === undefined ? {} : { provider_id: providerId }),
    };
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "owner",
      eventType: SESSION_EVENT_TYPES.sessionCreated,
      sessionId,
      payload,
    });
    const { sequence } = this.#ledger.append(envelope);
    return { sessionId, eventId: envelope.event_id, sequence, occurredAt: envelope.occurred_at };
  }

  /** 会话列表：session.created 投影（seq 升序） */
  listSessions(): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const { sequence, envelope } of this.#ledger.scan({ eventType: SESSION_EVENT_TYPES.sessionCreated })) {
      const sessionId = envelope.session_id;
      if (sessionId === null || sessionId === undefined) continue;
      const title = envelope.payload.title;
      const providerId = envelope.payload.provider_id;
      out.push({
        session_id: sessionId,
        event_id: envelope.event_id,
        sequence,
        occurred_at: envelope.occurred_at,
        ...(typeof title === "string" && title.length > 0 ? { title } : {}),
        ...(typeof providerId === "string" ? { provider_id: providerId } : {}),
      });
    }
    return out;
  }

  sessionExists(sessionId: string): boolean {
    return this.#ledger.scan({ sessionId }).length > 0;
  }

  /** 会话内事件（seq > afterSeq，SSE Last-Event-ID 重放用） */
  sessionEvents(sessionId: string, afterSeq = 0): LedgerEntry[] {
    return this.#ledger
      .scan({ sessionId })
      .filter((entry) => entry.sequence > afterSeq);
  }

  /** 历史投影：message.user / message.assistant（seq 升序，完整对话） */
  history(sessionId: string): SessionHistory {
    const messages: MessageRecord[] = [];
    for (const { sequence, envelope } of this.#ledger.scan({ sessionId })) {
      if (envelope.event_type === SESSION_EVENT_TYPES.messageUser) {
        messages.push({
          message_id: String(envelope.payload.message_id ?? ""),
          role: "user",
          text: String(envelope.payload.text ?? ""),
          event_id: envelope.event_id,
          sequence,
          occurred_at: envelope.occurred_at,
        });
      } else if (envelope.event_type === SESSION_EVENT_TYPES.messageAssistant) {
        messages.push({
          message_id: String(envelope.payload.message_id ?? ""),
          role: "assistant",
          text: String(envelope.payload.text ?? ""),
          stop_reason: String(envelope.payload.stop_reason ?? "stop"),
          event_id: envelope.event_id,
          sequence,
          occurred_at: envelope.occurred_at,
        });
      }
    }
    return { session_id: sessionId, messages };
  }

  /**
   * 记账用户输入并入队。同会话串行：Agent Loop 空闲则立即驱动（"processing"），
   * 否则 FIFO 排队（"queued"）。消息本身已落盘，处理顺序由队列保证。
   */
  sendUserMessage(sessionId: string, text: string): {
    status: "processing" | "queued";
    messageId: string;
    eventId: string;
    sequence: number;
  } {
    const state = this.#stateOf(sessionId);
    const messageId = uuidv7();
    const envelope = this.#append(
      sessionId,
      SESSION_EVENT_TYPES.messageUser,
      "owner",
      { message_id: messageId, text },
      null,
    );
    state.queue.push({ userEventId: envelope.envelope.event_id, messageId, text });
    if (state.running) {
      return { status: "queued", messageId, eventId: envelope.envelope.event_id, sequence: envelope.sequence };
    }
    state.running = true;
    void this.#pump(sessionId, state);
    return { status: "processing", messageId, eventId: envelope.envelope.event_id, sequence: envelope.sequence };
  }

  /** 中止当前运行（agent_end(aborted) 收尾，已产出事件不丢失）；空闲时为 no-op */
  abort(sessionId: string): void {
    this.#states.get(sessionId)?.runtime?.abort();
  }

  /** 会话是否正有运行中的 Agent Loop 轮次 */
  isRunning(sessionId: string): boolean {
    return this.#states.get(sessionId)?.running === true;
  }

  /** 订阅会话事件帧（SSE）；返回退订函数。未知会话返回 null。 */
  subscribe(sessionId: string, listener: (frame: SessionFrame) => void): (() => void) | null {
    if (!this.sessionExists(sessionId)) return null;
    const state = this.#stateOf(sessionId);
    state.frames.add(listener);
    return () => state.frames.delete(listener);
  }

  /** 优雅退出：停新轮 → 中止在跑的运行 → 等待收尾（上限 2s）→ 释放运行时 */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const runtimes: AgentRuntime[] = [];
    for (const state of this.#states.values()) {
      state.frames.clear();
      state.queue.length = 0;
      if (state.runtime !== null) {
        state.runtime.abort();
        runtimes.push(state.runtime);
      }
    }
    if (runtimes.length > 0) {
      await Promise.race([
        Promise.allSettled(runtimes.map((runtime) => runtime.waitForIdle())),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    for (const runtime of runtimes) runtime.dispose();
  }

  // --- Agent Loop：逐轮驱动排队的输入 ---------------------------------------

  /**
   * 会话的运行时 Provider 解析（票 T5）：显式绑定（session.created payload）优先，
   * 否则用当前默认；未配置返回 null。默认工厂路径（providerRequired）解析失败抛错
   * → agent.error 收尾，不中断其他会话；注入工厂路径返回 null（工厂自行处置，
   * 与 T4 行为一致）。
   */
  async #providerFor(sessionId: string): Promise<ResolvedProvider | null> {
    if (this.#providers === null) return null;
    const binding = this.#bindingOf(sessionId);
    const resolved = await this.#providers.resolve(binding ?? undefined);
    if (resolved === null && this.#providerRequired) {
      throw new Error(
        binding !== undefined
          ? `provider "${binding}" is not available (deleted or unresolvable)`
          : "no model provider configured",
      );
    }
    return resolved;
  }

  /** 显式 Provider 绑定（session.created payload 的 provider_id；无绑定 → undefined） */
  #bindingOf(sessionId: string): string | undefined {
    for (const { envelope } of this.#ledger.scan({ sessionId })) {
      if (envelope.event_type === SESSION_EVENT_TYPES.sessionCreated) {
        const providerId = envelope.payload.provider_id;
        return typeof providerId === "string" ? providerId : undefined;
      }
    }
    return undefined;
  }

  async #pump(sessionId: string, state: SessionState): Promise<void> {
    try {
      while (state.queue.length > 0 && !this.#disposed) {
        const input = state.queue.shift() as QueuedInput;
        let runtime = state.runtime;
        if (runtime === null) {
          try {
            runtime = await (this.#factory as AgentAdapterFactory)(sessionId, await this.#providerFor(sessionId));
          } catch (err) {
            this.#append(sessionId, SESSION_EVENT_TYPES.agentError, "agent:runtime", { message: errorMessage(err) }, input.userEventId);
            this.#broadcast(state, { kind: "done" });
            continue;
          }
          state.runtime = runtime;
        }

        let text = "";
        const toolStarted = new Map<string, string>();
        const unsubscribe = runtime.subscribe((event: MorrowAgentEvent) => {
          this.#translate(sessionId, state, input, event, {
            getText: () => text,
            appendText: (delta) => {
              text += delta;
            },
            toolStarted,
          });
        });
        try {
          await runtime.prompt(input.text);
        } catch (err) {
          // 契约上 prompt 只在误用时 reject（并发/dispose 后）；防御性兜底也入账本
          this.#append(sessionId, SESSION_EVENT_TYPES.agentError, "agent:runtime", { message: errorMessage(err) }, input.userEventId);
        } finally {
          unsubscribe();
        }
        this.#broadcast(state, { kind: "done" });
      }
    } finally {
      state.running = false;
    }
  }

  /** 五类窄事件 → 会话事件族入账本 + SSE 帧（text_delta 只广播不落账本） */
  #translate(
    sessionId: string,
    state: SessionState,
    input: QueuedInput,
    event: MorrowAgentEvent,
    ctx: {
      getText(): string;
      appendText(delta: string): void;
      toolStarted: Map<string, string>;
    },
  ): void {
    switch (event.type) {
      case "text_delta": {
        ctx.appendText(event.delta);
        this.#broadcast(state, { kind: "delta", delta: event.delta });
        break;
      }
      case "tool_start": {
        const started = this.#append(
          sessionId,
          SESSION_EVENT_TYPES.toolStarted,
          "agent:runtime",
          { tool_call_id: event.toolCallId, tool_name: event.toolName, args: event.args ?? null },
          input.userEventId,
        );
        ctx.toolStarted.set(event.toolCallId, started.envelope.event_id);
        break;
      }
      case "tool_end": {
        const payload: Record<string, unknown> = {
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          text: event.text,
          is_error: event.isError,
        };
        if (event.durationMs !== undefined) payload.duration_ms = event.durationMs;
        this.#append(
          sessionId,
          SESSION_EVENT_TYPES.toolFinished,
          "agent:runtime",
          payload,
          ctx.toolStarted.get(event.toolCallId) ?? input.userEventId,
        );
        break;
      }
      case "error": {
        this.#append(sessionId, SESSION_EVENT_TYPES.agentError, "agent:runtime", { message: event.message }, input.userEventId);
        break;
      }
      case "agent_end": {
        this.#append(
          sessionId,
          SESSION_EVENT_TYPES.messageAssistant,
          "agent:runtime",
          { message_id: uuidv7(), text: ctx.getText(), stop_reason: event.stopReason },
          input.userEventId,
        );
        break;
      }
    }
  }

  #append(
    sessionId: string,
    eventType: string,
    actorId: "owner" | "agent:runtime",
    payload: Record<string, unknown>,
    causationId: string | null,
  ): LedgerEntry {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId,
      eventType,
      sessionId,
      payload,
      causationId,
    });
    const { sequence } = this.#ledger.append(envelope);
    const entry: LedgerEntry = { sequence, envelope };
    const state = this.#states.get(sessionId);
    if (state !== undefined) this.#broadcast(state, { kind: "event", sequence, envelope });
    return entry;
  }

  #broadcast(state: SessionState, frame: SessionFrame): void {
    for (const listener of [...state.frames]) listener(frame);
  }

  #stateOf(sessionId: string): SessionState {
    let state = this.#states.get(sessionId);
    if (state === undefined) {
      state = { frames: new Set(), runtime: null, running: false, queue: [] };
      this.#states.set(sessionId, state);
    }
    return state;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
