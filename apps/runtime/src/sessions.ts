import type { AgentRuntime, MorrowAgentEvent, MorrowTool } from "@morrow/pi-adapter";
import type { ActorId, EventEnvelope } from "@morrow/protocol";
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
 * M7-A 会话元数据（票 T2 / Issue #59）：改名/归档/软删/恢复也走账本事件，
 * 会话列表仍是对账本的折叠（不引入 sessions 表——避免第二真相源）：
 *   session.renamed    actor owner   payload { title }
 *   session.archived   actor owner   归档（默认列表收起）
 *   session.unarchived actor owner   取消归档
 *   session.deleted    actor owner   软删（occurred_at 起 30 天可恢复）
 *   session.restored   actor owner   清除删除标记（归档态保留）
 * 折叠按事件 sequence 顺序施加（后写覆盖前写）；软删过期后从折叠结果剔除，
 * 但账本事件永久保留——折叠是投影，不是删除。
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
  // M7-A 元数据事件族（票 T2 / Issue #59）
  sessionRenamed: "session.renamed",
  sessionArchived: "session.archived",
  sessionUnarchived: "session.unarchived",
  sessionDeleted: "session.deleted",
  sessionRestored: "session.restored",
  /**
   * 临时会话关闭/恢复（票 M7-A-T3）：与 T2 的 session.restored（软删恢复）**分名**，
   * 避免同一 event_type 承载两种生命周期语义。payload 分别含 closed_at / restored_at。
   */
  sessionEphemeralClosed: "session.ephemeral_closed",
  sessionEphemeralRestored: "session.ephemeral_restored",
} as const;

/** 会话类型（票 M7-A-T3 / ADR-0010）：ephemeral = 临时会话（写入隔离 + 禁写入类能力 + 24h 生命周期） */
export type SessionKind = "normal" | "ephemeral";

/** 临时会话关闭后的保留窗口（24h；MemoryService 的到期清理与此同口径） */
export const EPHEMERAL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** 临时会话生命周期操作错误（HTTP 层映射：not_found → 404；其余 → 409） */
export type SessionLifecycleErrorCode = "not_found" | "not_ephemeral" | "invalid_state" | "session_expired";

export class SessionLifecycleError extends Error {
  code: SessionLifecycleErrorCode;

  constructor(code: SessionLifecycleErrorCode, message: string) {
    super(message);
    this.name = "SessionLifecycleError";
    this.code = code;
  }
}

/** 软删保留期（30 天）：deleted_at + 保留期后折叠剔除，账本事件保留 */
export const SESSION_DELETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 列表过滤：缺省只回活动会话；archived/deleted 在活动会话之外追加对应状态 */
export type SessionListInclude = "archived" | "deleted" | "all";

/** 元数据端点返回的变更摘要（event_id/sequence 为 null = 幂等 no-op，未追加事件） */
export interface SessionMetadataMutation {
  sessionId: string;
  eventId: string | null;
  sequence: number | null;
  changed: boolean;
  title?: string;
  archivedAt?: string;
  deletedAt?: string;
}

export type SessionRestoreResult =
  | { status: "unknown" }
  | { status: "not_deleted" }
  | { status: "expired" }
  | { status: "restored"; eventId: string; sequence: number; restoredAt: string };

/** 生产默认 createPiAdapter；测试注入 FakePi（同构 AgentRuntime 接口）。
 *  provider 为会话解析出的运行时配置（ProviderResolver 未配置时为 null）；
 *  extras.tools 为会话可用的工具（M1-T1：memory.write，经 PiAdapter tools 通道注册）；
 *  注入工厂可忽略该参数（少参函数在 TS 中可赋值给多参签名，旧测试无需改动）。 */
export interface AgentRuntimeExtras {
  /** 会话运行时可用的工具（缺省 []） */
  tools?: MorrowTool[];
  /**
   * 会话 system prompt（票 M7-A-T1 / Issue #58）：Persona 按固定顺序拼装后的文本。
   * 由工厂透传给 createPiAdapter（缺省不传 = 适配器空提示词）。
   */
  systemPrompt?: string;
}

export type AgentAdapterFactory = (
  sessionId: string,
  provider: ResolvedProvider | null,
  extras?: AgentRuntimeExtras,
) => Promise<AgentRuntime>;

/**
 * 记忆观察面（票 M1-T1 / Issue #13）：message.user 落账后由 SessionManager 调用，
 * 命中高价值规则即写候选 + memory.* 事件。窄结构接口——SessionManager 不依赖
 * memory 模块内部（MemoryService 结构匹配），注入失败不阻断会话主流程。
 *
 * observeTurnEnd（票 M1-T2 / Issue #14）：message.assistant 落账后触发后台抽取
 * （会话轮次结束即触发点）。实现方自行 fire-and-forget；SessionManager 仍捕获
 * 同步异常记日志——记忆是增强路径，不得影响会话主链路。
 */
export interface MemoryObserver {
  observeUserMessage(input: { sessionId: string; userEventId: string; occurredAt: string; text: string }): void;
  observeTurnEnd?(input: {
    sessionId: string;
    userEventId: string;
    /** 本轮 message.assistant 账本事件 id（memory.extracted 的 causation 触发点） */
    assistantEventId: string;
    occurredAt: string;
    text: string;
  }): void;
}

/**
 * 工具完成观察面（票 M2-T5 / Issue #26）：tool.finished 落账后由 SessionManager 调用，
 * 是 Skill 案例收集（成功/失败经验计数）的推送入口。窄结构接口（同 MemoryObserver 模式），
 * 观察方异常不阻断会话主链路（SessionManager 捕获同步异常记日志）。
 */
export interface ToolObserver {
  observeToolFinished(input: {
    sessionId: string;
    /** tool.finished 账本事件 id（案例表的来源事件外键） */
    toolEventId: string;
    toolName: string;
    isError: boolean;
    occurredAt: string;
  }): void;
}

/** 会话事件流上的一帧：账本事件（带序号，SSE 里作 id）/ 文本增量 / 本轮结束标记 */
export type SessionFrame =
  | { kind: "event"; sequence: number; envelope: EventEnvelope }
  | { kind: "delta"; delta: string }
  | { kind: "done" };

/** 会话列表条目（session.created 投影 + 元数据事件折叠；provider_id 仅显式绑定时存在） */
export interface SessionSummary {
  session_id: string;
  event_id: string;
  sequence: number;
  occurred_at: string;
  title?: string;
  provider_id?: string;
  /** 会话类型（票 M7-A-T3）：normal 缺省；ephemeral = 临时会话 */
  kind: SessionKind;
  /** 归档时间（session.archived 的 occurred_at；取消归档后清除） */
  archived_at?: string;
  /** 软删时间（session.deleted 的 occurred_at；恢复后清除；30 天后折叠剔除） */
  deleted_at?: string;
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
  /** 记忆观察面（票 M1-T1 / Issue #13）；缺省 null = 不观察 */
  memory?: MemoryObserver | null;
  /** 工具完成观察面（票 M2-T5 / Issue #26：Skill 案例收集）；缺省 = 不观察 */
  toolObserver?: ToolObserver | null;
  /** 会话运行时的工具工厂（M1-T1：按会话构建 memory.write 工具，经工厂 extras 注入） */
  agentTools?: (sessionId: string) => MorrowTool[];
  /**
   * 会话 system prompt 读取面（票 M7-A-T1 / Issue #58）：返回 undefined = 不注入。
   * 在创建 AgentRuntime 时求值（会话复用一个运行时；改 Persona 影响后续新会话）。
   */
  systemPrompt?: ((sessionId: string) => string | undefined) | null;
  /**
   * 会话时钟（票 M7-A-T2 软删 30 天 / 票 M7-A-T3 临时会话 close/restore 与 24h 判定）：
   * 测试注入可拨快时钟（零 sleep）。缺省系统时间。
   */
  now?: () => Date;
}

export class SessionManager {
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #factory: AgentAdapterFactory | null;
  readonly #providers: ProviderResolver | null;
  readonly #providerRequired: boolean;
  readonly #factoryUnavailableReason: string;
  readonly #memory: MemoryObserver | null;
  readonly #toolObserver: ToolObserver | null;
  readonly #agentTools: ((sessionId: string) => MorrowTool[]) | null;
  readonly #systemPrompt: ((sessionId: string) => string | undefined) | null;
  readonly #now: () => Date;
  readonly #states = new Map<string, SessionState>();
  #disposed = false;

  constructor(options: SessionManagerOptions) {
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#factory = options.factory;
    this.#providers = options.providers ?? null;
    this.#providerRequired = options.providerRequired ?? false;
    this.#memory = options.memory ?? null;
    this.#toolObserver = options.toolObserver ?? null;
    this.#agentTools = options.agentTools ?? null;
    this.#systemPrompt = options.systemPrompt ?? null;
    this.#now = options.now ?? (() => new Date());
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
   * kind（票 M7-A-T3）：normal（缺省）/ ephemeral；payload 恒记录 kind。
   */
  createSession(
    title?: string,
    providerId?: string,
    kind: SessionKind = "normal",
  ): { sessionId: string; eventId: string; sequence: number; occurredAt: string } {
    const sessionId = uuidv7();
    const payload: Record<string, unknown> = {
      ...(title === undefined ? {} : { title }),
      ...(providerId === undefined ? {} : { provider_id: providerId }),
      kind,
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

  /**
   * 会话列表：对账本的折叠（M7-A-T2）。先扫 session.created 建基座，再按 sequence
   * 顺序施加 renamed/archived/unarchived/deleted/restored（后写覆盖前写）。
   *
   * 默认只回活动会话（未归档、未软删）；include=archived 追加归档、include=deleted
   * 追加未过期的软删、include=all 两者都追加。软删超过 30 天（注入时钟判定）从所有
   * 视图剔除——账本事件仍在，重建/审计不受影响。
   */
  listSessions(options: { include?: SessionListInclude } = {}): SessionSummary[] {
    const include = options.include;
    const out: SessionSummary[] = [];
    for (const folded of this.#foldSessions()) {
      if (folded.expired) continue;
      const { summary } = folded;
      if (summary.deleted_at !== undefined) {
        if (include !== "deleted" && include !== "all") continue;
      } else if (summary.archived_at !== undefined) {
        if (include !== "archived" && include !== "all") continue;
      }
      out.push(summary);
    }
    return out;
  }

  /** 改名：session.renamed（actor owner）。未知会话返回 null（HTTP 层 404）。 */
  renameSession(sessionId: string, title: string): SessionMetadataMutation | null {
    if (this.#foldSession(sessionId) === null) return null;
    const entry = this.#appendMetadata(sessionId, SESSION_EVENT_TYPES.sessionRenamed, { title });
    return {
      sessionId,
      eventId: entry.envelope.event_id,
      sequence: entry.sequence,
      changed: true,
      title,
    };
  }

  /** 归档：session.archived。已归档为幂等 no-op（不追加事件）。 */
  archiveSession(sessionId: string): SessionMetadataMutation | null {
    const folded = this.#foldSession(sessionId);
    if (folded === null) return null;
    if (folded.summary.archived_at !== undefined) {
      return {
        sessionId,
        eventId: null,
        sequence: null,
        changed: false,
        archivedAt: folded.summary.archived_at,
      };
    }
    const entry = this.#appendMetadata(sessionId, SESSION_EVENT_TYPES.sessionArchived, {});
    return {
      sessionId,
      eventId: entry.envelope.event_id,
      sequence: entry.sequence,
      changed: true,
      archivedAt: entry.envelope.occurred_at,
    };
  }

  /** 取消归档：session.unarchived。未归档为幂等 no-op。 */
  unarchiveSession(sessionId: string): SessionMetadataMutation | null {
    const folded = this.#foldSession(sessionId);
    if (folded === null) return null;
    if (folded.summary.archived_at === undefined) {
      return { sessionId, eventId: null, sequence: null, changed: false };
    }
    const entry = this.#appendMetadata(sessionId, SESSION_EVENT_TYPES.sessionUnarchived, {});
    return { sessionId, eventId: entry.envelope.event_id, sequence: entry.sequence, changed: true };
  }

  /**
   * 软删：session.deleted。已删除为幂等 no-op——**不追加事件、不延长 30 天保留期**
   * （重复删除不能把到期日往后推）。删除只作用于会话投影，不动记忆。
   */
  deleteSession(sessionId: string): SessionMetadataMutation | null {
    const folded = this.#foldSession(sessionId);
    if (folded === null) return null;
    if (folded.summary.deleted_at !== undefined) {
      return {
        sessionId,
        eventId: null,
        sequence: null,
        changed: false,
        deletedAt: folded.summary.deleted_at,
      };
    }
    const entry = this.#appendMetadata(sessionId, SESSION_EVENT_TYPES.sessionDeleted, {});
    return {
      sessionId,
      eventId: entry.envelope.event_id,
      sequence: entry.sequence,
      changed: true,
      deletedAt: entry.envelope.occurred_at,
    };
  }

  /**
   * 恢复软删：session.restored（只清删除标记，此前的归档态保留）。
   * 未删除 → not_deleted；已过 30 天保留期 → expired（HTTP 409）；未知会话 → unknown。
   */
  restoreSession(sessionId: string): SessionRestoreResult {
    const folded = this.#foldSession(sessionId);
    if (folded === null) return { status: "unknown" };
    if (folded.summary.deleted_at === undefined) return { status: "not_deleted" };
    if (this.#isDeleteExpired(folded.summary.deleted_at)) return { status: "expired" };
    const entry = this.#appendMetadata(sessionId, SESSION_EVENT_TYPES.sessionRestored, {});
    return {
      status: "restored",
      eventId: entry.envelope.event_id,
      sequence: entry.sequence,
      restoredAt: entry.envelope.occurred_at,
    };
  }

  sessionExists(sessionId: string): boolean {
    return this.#ledger.scan({ sessionId }).length > 0;
  }

  /** 会话类型（票 M7-A-T3；未知会话 null）。由 session.created payload 折叠得出。 */
  sessionKind(sessionId: string): SessionKind | null {
    return this.#lifecycleOf(sessionId).kind;
  }

  /** 会话是否处于「已关闭且未恢复」（临时会话 24h 窗口内；普通会话恒 false） */
  isClosed(sessionId: string): boolean {
    return this.#lifecycleOf(sessionId).closedAt !== null;
  }

  /**
   * 关闭临时会话（票 M7-A-T3）：session.closed 入账本（payload 含 closed_at 与 kind）。
   * 幂等：已关闭且未恢复时返回既有 closed_at（不重复记账）。
   * 仅 ephemeral 分支——普通会话的关闭语义（未提交改动三选一）由 T5 的
   * POST /v1/sessions/:id/close 扩展，本票对其返回 not_ephemeral（见报告冲突点）。
   */
  closeEphemeralSession(sessionId: string): { closedAt: string; restorableUntil: string; eventId: string | null } {
    const lifecycle = this.#lifecycleOf(sessionId);
    if (lifecycle.kind === null) {
      throw new SessionLifecycleError("not_found", `session ${sessionId} does not exist`);
    }
    if (lifecycle.kind !== "ephemeral") {
      throw new SessionLifecycleError(
        "not_ephemeral",
        `session ${sessionId} is a normal session; ephemeral close/restore applies to kind=ephemeral only`,
      );
    }
    if (lifecycle.closedAt !== null) {
      return {
        closedAt: lifecycle.closedAt,
        restorableUntil: new Date(Date.parse(lifecycle.closedAt) + EPHEMERAL_SESSION_TTL_MS).toISOString(),
        eventId: null,
      };
    }
    const closedAt = this.#now().toISOString();
    const entry = this.#append(sessionId, SESSION_EVENT_TYPES.sessionEphemeralClosed, "owner", {
      kind: "ephemeral",
      closed_at: closedAt,
    }, null);
    return {
      closedAt,
      restorableUntil: new Date(Date.parse(closedAt) + EPHEMERAL_SESSION_TTL_MS).toISOString(),
      eventId: entry.envelope.event_id,
    };
  }

  /**
   * 恢复临时会话（票 M7-A-T3）：仅关闭中的 ephemeral 会话、且距 closed_at 未满 24h。
   * 过期 → session_expired（记忆清理已按作用域落定，不可复活）；未关闭 → invalid_state。
   */
  restoreEphemeralSession(sessionId: string): { restoredAt: string; eventId: string } {
    const lifecycle = this.#lifecycleOf(sessionId);
    if (lifecycle.kind === null) {
      throw new SessionLifecycleError("not_found", `session ${sessionId} does not exist`);
    }
    if (lifecycle.kind !== "ephemeral") {
      throw new SessionLifecycleError(
        "not_ephemeral",
        `session ${sessionId} is a normal session; ephemeral close/restore applies to kind=ephemeral only`,
      );
    }
    if (lifecycle.closedAt === null) {
      throw new SessionLifecycleError("invalid_state", `session ${sessionId} is not closed`);
    }
    const deadline = Date.parse(lifecycle.closedAt) + EPHEMERAL_SESSION_TTL_MS;
    if (this.#now().getTime() >= deadline) {
      throw new SessionLifecycleError(
        "session_expired",
        `session ${sessionId} was closed at ${lifecycle.closedAt} and the 24h restore window has ended`,
      );
    }
    const restoredAt = this.#now().toISOString();
    const entry = this.#append(sessionId, SESSION_EVENT_TYPES.sessionEphemeralRestored, "owner", {
      restored_at: restoredAt,
    }, null);
    return { restoredAt, eventId: entry.envelope.event_id };
  }

  /** 会话生命周期折叠（kind + 最后一次 close/restore 后的关闭态） */
  #lifecycleOf(sessionId: string): { kind: SessionKind | null; closedAt: string | null } {
    let kind: SessionKind | null = null;
    let closedAt: string | null = null;
    for (const { envelope } of this.#ledger.scan({ sessionId })) {
      if (envelope.event_type === SESSION_EVENT_TYPES.sessionCreated) {
        kind = envelope.payload.kind === "ephemeral" ? "ephemeral" : "normal";
      } else if (envelope.event_type === SESSION_EVENT_TYPES.sessionEphemeralClosed) {
        closedAt =
          typeof envelope.payload.closed_at === "string" ? envelope.payload.closed_at : envelope.occurred_at;
      } else if (envelope.event_type === SESSION_EVENT_TYPES.sessionEphemeralRestored) {
        closedAt = null;
      }
    }
    return { kind, closedAt };
  }

  // --- M7-A 会话元数据折叠 --------------------------------------------------

  /**
   * 折叠全部会话状态：created 建基座，元数据事件按 sequence 施加。
   * expired 在最后按注入时钟统一判定（deleted_at + 30d）。
   */
  #foldSessions(): Array<{ summary: SessionSummary; expired: boolean }> {
    const entries: LedgerEntry[] = [];
    for (const eventType of [
      SESSION_EVENT_TYPES.sessionCreated,
      SESSION_EVENT_TYPES.sessionRenamed,
      SESSION_EVENT_TYPES.sessionArchived,
      SESSION_EVENT_TYPES.sessionUnarchived,
      SESSION_EVENT_TYPES.sessionDeleted,
      SESSION_EVENT_TYPES.sessionRestored,
    ]) {
      entries.push(...this.#ledger.scan({ eventType }));
    }
    entries.sort((a, b) => a.sequence - b.sequence);

    const byId = new Map<string, SessionSummary>();
    for (const { sequence, envelope } of entries) {
      const sessionId = envelope.session_id;
      if (sessionId === null || sessionId === undefined) continue;
      switch (envelope.event_type) {
        case SESSION_EVENT_TYPES.sessionCreated: {
          if (byId.has(sessionId)) break; // 重复 created 不覆盖既有投影
          const title = envelope.payload.title;
          const providerId = envelope.payload.provider_id;
          byId.set(sessionId, {
            session_id: sessionId,
            event_id: envelope.event_id,
            sequence,
            occurred_at: envelope.occurred_at,
            kind: envelope.payload.kind === "ephemeral" ? "ephemeral" : "normal",
            ...(typeof title === "string" && title.length > 0 ? { title } : {}),
            ...(typeof providerId === "string" ? { provider_id: providerId } : {}),
          });
          break;
        }
        case SESSION_EVENT_TYPES.sessionRenamed: {
          const summary = byId.get(sessionId);
          if (summary === undefined) break;
          const title = envelope.payload.title;
          if (typeof title === "string" && title.length > 0) summary.title = title;
          break;
        }
        case SESSION_EVENT_TYPES.sessionArchived: {
          const summary = byId.get(sessionId);
          if (summary !== undefined) summary.archived_at = envelope.occurred_at;
          break;
        }
        case SESSION_EVENT_TYPES.sessionUnarchived: {
          const summary = byId.get(sessionId);
          if (summary !== undefined) delete summary.archived_at;
          break;
        }
        case SESSION_EVENT_TYPES.sessionDeleted: {
          const summary = byId.get(sessionId);
          if (summary !== undefined) summary.deleted_at = envelope.occurred_at;
          break;
        }
        case SESSION_EVENT_TYPES.sessionRestored: {
          const summary = byId.get(sessionId);
          if (summary !== undefined) delete summary.deleted_at;
          break;
        }
      }
    }

    return [...byId.values()].map((summary) => ({
      summary,
      expired: summary.deleted_at !== undefined && this.#isDeleteExpired(summary.deleted_at),
    }));
  }

  #foldSession(sessionId: string): { summary: SessionSummary; expired: boolean } | null {
    return this.#foldSessions().find((folded) => folded.summary.session_id === sessionId) ?? null;
  }

  #isDeleteExpired(deletedAt: string): boolean {
    const deletedMs = Date.parse(deletedAt);
    if (Number.isNaN(deletedMs)) return false;
    return this.#now().getTime() - deletedMs >= SESSION_DELETE_RETENTION_MS;
  }

  #appendMetadata(sessionId: string, eventType: string, payload: Record<string, unknown>): LedgerEntry {
    return this.#append(sessionId, eventType, "owner", payload, null);
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
   *
   * options.actorId（M4-T1 / Issue #38）：渠道入站按本地解析出的主体归因
   * （owner / contact:<id>）；缺省 owner（桌面/语音入口语义不变）。
   */
  sendUserMessage(
    sessionId: string,
    text: string,
    options: { actorId?: ActorId } = {},
  ): {
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
      options.actorId ?? "owner",
      { message_id: messageId, text },
      null,
    );
    // 记忆即时写入（票 M1-T1 / Issue #13）：用户消息已落账本，命中高价值规则即写候选。
    // 失败只记日志：候选是增强路径，不得吞掉已持久化的用户消息或打断本轮。
    if (this.#memory !== null) {
      try {
        this.#memory.observeUserMessage({
          sessionId,
          userEventId: envelope.envelope.event_id,
          occurredAt: envelope.envelope.occurred_at,
          text,
        });
      } catch (err) {
        console.error("[morrow] memory observe failed:", err);
      }
    }
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
            const systemPrompt = this.#systemPrompt?.(sessionId);
            runtime = await (this.#factory as AgentAdapterFactory)(
              sessionId,
              await this.#providerFor(sessionId),
              {
                tools: this.#agentTools?.(sessionId) ?? [],
                ...(systemPrompt === undefined ? {} : { systemPrompt }),
              },
            );
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
        const finished = this.#append(
          sessionId,
          SESSION_EVENT_TYPES.toolFinished,
          "agent:runtime",
          payload,
          ctx.toolStarted.get(event.toolCallId) ?? input.userEventId,
        );
        // 工具完成观察（票 M2-T5：Skill 案例收集）。观察是增强路径：同步异常记日志，
        // 不阻断会话主链路（MemoryObserver 同款口径）。
        if (this.#toolObserver !== null) {
          try {
            this.#toolObserver.observeToolFinished({
              sessionId,
              toolEventId: finished.envelope.event_id,
              toolName: event.toolName,
              isError: event.isError,
              occurredAt: finished.envelope.occurred_at,
            });
          } catch (err) {
            console.error("[morrow] tool observer failed:", err);
          }
        }
        break;
      }
      case "error": {
        this.#append(sessionId, SESSION_EVENT_TYPES.agentError, "agent:runtime", { message: event.message }, input.userEventId);
        break;
      }
      case "agent_end": {
        const assistant = this.#append(
          sessionId,
          SESSION_EVENT_TYPES.messageAssistant,
          "agent:runtime",
          { message_id: uuidv7(), text: ctx.getText(), stop_reason: event.stopReason },
          input.userEventId,
        );
        // 后台抽取触发（票 M1-T2）：轮次收尾（message.assistant 已落账）→ fire-and-forget。
        // 失败只记日志：记忆是增强路径，不得吞掉本轮已持久化的会话事件。
        if (this.#memory?.observeTurnEnd !== undefined) {
          try {
            this.#memory.observeTurnEnd({
              sessionId,
              userEventId: input.userEventId,
              assistantEventId: assistant.envelope.event_id,
              occurredAt: assistant.envelope.occurred_at,
              text: input.text,
            });
          } catch (err) {
            console.error("[morrow] memory turn-end observe failed:", err);
          }
        }
        break;
      }
    }
  }

  #append(
    sessionId: string,
    eventType: string,
    actorId: ActorId,
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
