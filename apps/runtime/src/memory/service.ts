import type { MemoryEntryKind, MemoryWriteInput, SensitivityLevel } from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { SESSION_EVENT_TYPES } from "../sessions.ts";
import {
  type CreateCandidateInput,
  type MemoryCandidateRow,
  type MemorySearchHit,
  type MemorySourceRow,
  MemoryStore,
} from "./store.ts";
import { detectHighValue } from "./heuristics.ts";

/**
 * 记忆服务（票 M1-T1 / Issue #13）：候选即时写入的两条路径共用一个落库+记账出口。
 *
 *   1. observeUserMessage —— 对话中命中高价值规则（heuristics.ts，确定性启发式）时，
 *      SessionManager 在 message.user 入账本后立即调用；来源 = 刚落账的 message.user 事件。
 *   2. writeFromTool —— 模型经 PiAdapter tools 通道显式调用 memory.write 工具；
 *      来源 = 会话最新一条 message.user（工具执行必然发生在某轮用户消息触发的运行内）。
 *
 * memory.* 事件族（event_type 清单只增不减）：
 *   memory.candidate_created  actor agent:runtime  候选落库后记账
 *                             （causation → 来源 message.user；payload.rule 标注写入路径）
 *   memory.fact_created       T2 巩固产出事实时启用（本票只登记类型名，不写入）
 *
 * 顺序约定：先落行（来源+候选+FTS，同一事务），后记账本事件；账本 append 失败会
 * 向调用方抛错（工具路径 → isError；观察路径由 SessionManager 捕获记日志）——
 * 行是可重建投影，事件缺失即本次记忆写入未生效，不静默吞掉。
 */

export const MEMORY_EVENT_TYPES = {
  candidateCreated: "memory.candidate_created",
  factCreated: "memory.fact_created",
} as const;

/** memory.write 工具路径在事件 payload.rule 里的标注值 */
export const MEMORY_WRITE_RULE = "memory.write";

/** 工具入参非法（空内容 / 越界 confidence / 未知 sensitivity 或 kind） */
export class MemoryWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryWriteError";
  }
}

export interface ObserveUserMessageInput {
  sessionId: string;
  /** 触发本轮的 message.user 账本事件 id（来源回链目标） */
  userEventId: string;
  /** 来源事件发生时间（信封 occurred_at，候选的发生时间） */
  occurredAt: string;
  text: string;
}

export interface MemoryWriteResult {
  source: MemorySourceRow;
  candidate: MemoryCandidateRow;
  /** memory.candidate_created 事件 */
  eventId: string;
  sequence: number;
}

const MEMORY_KINDS: readonly MemoryEntryKind[] = ["fact", "preference", "profile", "procedural"];
const SENSITIVITY_LEVELS: readonly SensitivityLevel[] = ["public", "private", "locked"];

export class MemoryService {
  readonly #store: MemoryStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;

  constructor(deps: { store: MemoryStore; ledger: EventLedger; replicaId: string }) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#replicaId = deps.replicaId;
  }

  /**
   * 对话观察入口：对用户消息跑确定性高价值启发式；命中则即时写入候选 + 来源 +
   * memory.candidate_created 事件。无命中（闲聊）返回 null，零副作用。
   */
  observeUserMessage(input: ObserveUserMessageInput): MemoryWriteResult | null {
    const hit = detectHighValue(input.text);
    if (hit === null) return null;
    return this.#persist({
      sessionId: input.sessionId,
      sourceEventId: input.userEventId,
      content: hit.content,
      kind: hit.kind,
      confidence: hit.confidence,
      sensitivity: "private",
      occurredAt: input.occurredAt,
      rule: hit.rule,
    });
  }

  /**
   * memory.write 工具入口：入参为 protocol MemoryWriteInput（schema 校验由 PiAdapter
   * 参数校验 + 此处的业务校验共同把关）；显式写入默认置信度 0.9、sensitivity private。
   */
  writeFromTool(sessionId: string, input: MemoryWriteInput): MemoryWriteResult {
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      throw new MemoryWriteError("content must be a non-empty string");
    }
    if (input.kind !== undefined && !MEMORY_KINDS.includes(input.kind)) {
      throw new MemoryWriteError(`unknown kind: ${String(input.kind)}`);
    }
    if (input.sensitivity !== undefined && !SENSITIVITY_LEVELS.includes(input.sensitivity)) {
      throw new MemoryWriteError(`unknown sensitivity: ${String(input.sensitivity)}`);
    }
    if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1)) {
      throw new MemoryWriteError("confidence must be within [0, 1]");
    }
    const source = this.latestUserEvent(sessionId);
    if (source === null) {
      throw new MemoryWriteError("no user message in this session to attribute the memory to");
    }
    return this.#persist({
      sessionId,
      sourceEventId: source.event_id,
      content: input.content.trim(),
      kind: input.kind ?? "fact",
      confidence: input.confidence ?? 0.9,
      sensitivity: input.sensitivity ?? "private",
      occurredAt: source.occurred_at,
      rule: MEMORY_WRITE_RULE,
    });
  }

  /** FTS5 关键词检索（MemoryStore 透传；命中含来源回链） */
  search(q: string): MemorySearchHit[] {
    return this.#store.search(q);
  }

  /** 会话最新一条 message.user 账本事件（工具写入的来源回链目标） */
  latestUserEvent(sessionId: string): { event_id: string; occurred_at: string } | null {
    const entries = this.#ledger.scan({ sessionId, eventType: SESSION_EVENT_TYPES.messageUser });
    const last = entries.at(-1);
    if (last === undefined) return null;
    return { event_id: last.envelope.event_id, occurred_at: last.envelope.occurred_at };
  }

  #persist(input: {
    sessionId: string;
    sourceEventId: string;
    content: string;
    kind: MemoryEntryKind;
    confidence: number;
    sensitivity: SensitivityLevel;
    occurredAt: string;
    rule: string;
  }): MemoryWriteResult {
    const createInput: CreateCandidateInput = {
      content: input.content,
      kind: input.kind,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      occurredAt: input.occurredAt,
      source: { kind: "message", eventId: input.sourceEventId, sessionId: input.sessionId },
    };
    const { source, candidate } = this.#store.createCandidate(createInput);
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: "agent:runtime",
      eventType: MEMORY_EVENT_TYPES.candidateCreated,
      sessionId: input.sessionId,
      payload: {
        candidate_id: candidate.candidate_id,
        content: candidate.content,
        kind: candidate.kind,
        sensitivity: candidate.sensitivity,
        confidence: candidate.confidence,
        source_id: source.source_id,
        source_event_id: source.event_id,
        rule: input.rule,
      },
      causationId: source.event_id,
    });
    const { sequence } = this.#ledger.append(envelope);
    return { source, candidate, eventId: envelope.event_id, sequence };
  }
}
