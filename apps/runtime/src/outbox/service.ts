import type { OutboxMessageRecord, OutboxReceipt, OutboxStatus, OutboxTarget } from "@morrow/protocol";
import type { EventLedger } from "../ledger.ts";
import type { LeaseStore } from "../lease/store.ts";
import { buildEventEnvelope } from "../envelope.ts";
import { uuidv7 } from "../uuid-v7.ts";
import { OutboxStore, type OutboxStoreOptions } from "./store.ts";

/**
 * OutboxService（M4-T2 / Issue #39）：外发副作用的编排层——
 * 先落库再投递、按回执/错误分类推进状态机、把每一步写成 outbound.* 账本事件。
 *
 * 状态机（终态 sent；人工出口 retry / mark-sent）：
 *
 *   enqueue ─► pending ─┬─ dispatch 成功 ──────────────► sent（receipt）
 *                       ├─ 平台明确拒收/4xx ────────────► failed（attempts<上限，指数退避）
 *                       │                                  └─ attempts 耗尽 ─► needs_review
 *                       └─ 超时/网络中断/回执未知 ──────► delivery_unknown
 *                                                          └─ 立即（或重启时）─► needs_review
 *   failed/needs_review ──（Owner 显式 POST retry）──────► pending（attempts 归零）
 *   delivery_unknown/needs_review/failed/pending ─（Owner mark-sent）─► sent（manual receipt）
 *
 * 安全底线：delivery_unknown / needs_review 的行**不在 due 查询集合里**，任何自动 dispatch
 * 都不会重发；宁可人工核对，也不重复骚扰对方。
 *
 * 崩溃安全（判定口径 = 请求是否已发出）：
 * - 投递前先 markAttempt（attempts+1、last_attempt_at 落库），然后才调用适配器；
 * - 进程在调用途中被杀 → 行仍是 pending 且 last_attempt_at 非空 → 重启时 recoverStartup
 *   视作「可能已发出」，转 delivery_unknown → needs_review，绝不重发；
 * - 进程在 markAttempt 之前被杀 → last_attempt_at 为空，仍可安全投递。
 *
 * 租约兼容（FR-DEP-4 的副作用提交点）：入队可携带 task_id + fencing_token；投递前若该
 * 任务存在活跃租约，复用 LeaseStore.validate 做同一套 fencing 校验（与 scheduler.ts /
 * sandbox/invoker.ts 的 FencingGuard.assertCanCommit 同语义）。校验失败不发请求，行保持
 * 待投递并退避。
 */

export const OUTBOX_EVENT_TYPES = {
  queued: "outbound.queued",
  sent: "outbound.sent",
  failed: "outbound.failed",
  deliveryUnknown: "outbound.delivery_unknown",
  reviewed: "outbound.reviewed",
  retried: "outbound.retried",
} as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];

export type OutboxErrorCode =
  | "invalid_input"
  | "not_found"
  | "invalid_status"
  | "confirmation_required"
  | "adapter_unavailable"
  | "closed";

export class OutboxError extends Error {
  readonly code: OutboxErrorCode;
  readonly details?: unknown;

  constructor(code: OutboxErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "OutboxError";
    this.code = code;
    this.details = details;
  }
}

/** 适配器收到的外发请求（平台协议转换前的统一形态；不做业务判断） */
export interface OutboxSendRequest {
  id: string;
  idempotency_key: string;
  channel_id: string;
  account_id: string;
  target: OutboxTarget;
  payload: Record<string, unknown>;
  /** 本次是第几次投递尝试（1 起；供适配器做平台侧幂等/日志关联） */
  attempts: number;
}

/**
 * 适配器投递结果（必须显式区分「确认送达」与「明确失败」）：
 * - `sent`：平台回执确认（可带平台消息 id）；
 * - `failed`：平台明确拒收/4xx（幂等安全，可重试）。
 * 未归类的一切异常/超时按「结果未知」处理（不是 failed——不自动重发）。
 */
export type OutboxSendOutcome =
  | { kind: "sent"; receipt?: OutboxReceipt }
  | { kind: "failed"; error: string };

/** 适配器抛出的已分类错误；未分类异常一律按 network 语义（结果未知）处理 */
export class OutboxChannelError extends Error {
  readonly kind: "explicit" | "network" | "timeout";

  constructor(kind: "explicit" | "network" | "timeout", message: string) {
    super(message);
    this.name = "OutboxChannelError";
    this.kind = kind;
  }
}

export interface OutboxChannelAdapter {
  send(
    request: OutboxSendRequest,
    options?: { signal?: AbortSignal },
  ): Promise<OutboxSendOutcome>;
}

export interface OutboxServiceOptions extends OutboxStoreOptions {
  ledger: EventLedger;
  replicaId: string;
  /** 渠道适配器；null = 尚未接线（dispatchOnce 抛 adapter_unavailable） */
  adapter?: OutboxChannelAdapter | null;
  /** 租约存储（fencing 校验；null/缺省 = 不校验，纯本地直发场景） */
  leases?: LeaseStore | null;
  /** 注入时钟（测试拨快退避；缺省系统时间） */
  now?: () => Date;
  /** 明确失败的最大自动尝试次数（默认 5；耗尽转 needs_review） */
  maxAttempts?: number;
  /** 指数退避基数（默认 1000ms） */
  backoffBaseMs?: number;
  /** 退避上限（默认 60_000ms） */
  backoffMaxMs?: number;
  /** 单次投递超时（默认 10_000ms；超时按结果未知处理） */
  sendTimeoutMs?: number;
  /** dispatchOnce 默认并发上限（默认 4） */
  concurrency?: number;
  /** dispatchOnce 默认批量上限（默认 20） */
  batchLimit?: number;
}

export interface EnqueueOutboundInput {
  /** 幂等键（必填；同一逻辑外发复用同一键 → deduped，不重复发送） */
  idempotencyKey: string;
  channelId: string;
  accountId: string;
  target: OutboxTarget;
  payload: Record<string, unknown>;
  causationId?: string | null;
  /** 关联任务（须为 uuid；跨副本同步随信封 task_id 传播） */
  taskId?: string | null;
  /** 任务执行租约 fencing token（与 taskId 同时给出才参与投递前校验） */
  fencingToken?: number | null;
}

export interface DispatchOptions {
  limit?: number;
  concurrency?: number;
}

export interface OutboxDispatchSummary {
  /** 实际向适配器发起请求的行数 */
  attempted: number;
  sent: number;
  failed: number;
  delivery_unknown: number;
  needs_review: number;
  /** 未发起请求（租约 fencing 拒绝/等待中）的行数 */
  deferred: number;
}

export interface RecoverySummary {
  /** 崩溃后 pending 且已发起过请求 → 转 delivery_unknown 的行数 */
  recovered: number;
  /** delivery_unknown → needs_review 的行数（含 recovered） */
  reviewed: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class OutboxService {
  readonly #store: OutboxStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #leases: LeaseStore | null;
  readonly #now: () => Date;
  readonly #maxAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #sendTimeoutMs: number;
  readonly #concurrency: number;
  readonly #batchLimit: number;
  #adapter: OutboxChannelAdapter | null;
  /** 进程内 dispatch 串行化：并发调用共享同一轮，避免同一 pending 行被重复发送 */
  #dispatchInflight: Promise<OutboxDispatchSummary> | null = null;

  constructor(options: OutboxServiceOptions) {
    this.#store = new OutboxStore(options);
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#leases = options.leases ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    this.#backoffBaseMs = Math.max(1, options.backoffBaseMs ?? 1_000);
    this.#backoffMaxMs = Math.max(this.#backoffBaseMs, options.backoffMaxMs ?? 60_000);
    this.#sendTimeoutMs = Math.max(1, options.sendTimeoutMs ?? 10_000);
    this.#concurrency = Math.max(1, options.concurrency ?? 4);
    this.#batchLimit = Math.max(1, options.batchLimit ?? 20);
    this.#adapter = options.adapter ?? null;
  }

  /** 适配器接线/替换（channel 域启动后注入；null 时 dispatch 明确报 adapter_unavailable） */
  setAdapter(adapter: OutboxChannelAdapter | null): void {
    this.#adapter = adapter;
  }

  /** 入队：先落库；幂等键冲突返回既有行且不重复记 queued 事件。 */
  enqueue(input: EnqueueOutboundInput): { id: string; deduped: boolean; message: OutboxMessageRecord } {
    validateEnqueue(input);
    const nowIso = this.#nowIso();
    const { deduped, message } = this.#store.enqueue({
      id: uuidv7(this.#now().getTime()),
      idempotencyKey: input.idempotencyKey,
      channelId: input.channelId,
      accountId: input.accountId,
      target: input.target,
      payload: input.payload,
      causationId: input.causationId ?? null,
      taskId: input.taskId ?? null,
      fencingToken: input.fencingToken ?? null,
      now: nowIso,
    });
    if (!deduped) {
      this.#emit(OUTBOX_EVENT_TYPES.queued, message, {
        status: "pending",
        idempotency_key: message.idempotency_key,
      });
    }
    return { id: message.id, deduped, message };
  }

  get(id: string): OutboxMessageRecord | null {
    return this.#store.get(id);
  }

  list(filter: { status?: OutboxStatus; limit?: number; offset?: number } = {}): {
    messages: OutboxMessageRecord[];
    total: number;
    limit: number;
    offset: number;
  } {
    const limit = clampInt(filter.limit, 1, 200, 50);
    const offset = clampInt(filter.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const result = this.#store.list({ ...(filter.status === undefined ? {} : { status: filter.status }), limit, offset });
    return { ...result, limit, offset };
  }

  /**
   * 投递一批到期行（pending + 退避到期的 failed）。并发上限由 options.concurrency 决定
   * （默认服务配置）。delivery_unknown / needs_review 永不入选。
   */
  async dispatchOnce(options: DispatchOptions = {}): Promise<OutboxDispatchSummary> {
    // 同一进程内同一时刻只跑一轮：并发的 dispatchOnce 共享同一结果，同一 pending 行
    // 不会被两个调用各发一次（跨进程由 outbox 表本身是副本私有态保证）。
    if (this.#dispatchInflight !== null) return this.#dispatchInflight;
    const run = this.#dispatchBatch(options);
    this.#dispatchInflight = run;
    try {
      return await run;
    } finally {
      this.#dispatchInflight = null;
    }
  }

  async #dispatchBatch(options: DispatchOptions): Promise<OutboxDispatchSummary> {
    const adapter = this.#adapter;
    if (adapter === null) {
      throw new OutboxError("adapter_unavailable", "no channel adapter is wired into the outbox dispatcher");
    }
    const limit = clampInt(options.limit, 1, 10_000, this.#batchLimit);
    const concurrency = clampInt(options.concurrency, 1, 64, this.#concurrency);
    const rows = this.#store.due(this.#nowIso(), limit);
    const summary: OutboxDispatchSummary = {
      attempted: 0,
      sent: 0,
      failed: 0,
      delivery_unknown: 0,
      needs_review: 0,
      deferred: 0,
    };

    let cursor = 0;
    const workerCount = Math.min(concurrency, rows.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const row = rows[index];
        if (row === undefined) return;
        const outcome = await this.#dispatchRow(row, adapter);
        switch (outcome) {
          case "sent":
            summary.sent += 1;
            summary.attempted += 1;
            break;
          case "failed":
            summary.failed += 1;
            summary.attempted += 1;
            break;
          case "delivery_unknown":
            summary.delivery_unknown += 1;
            summary.attempted += 1;
            break;
          case "needs_review":
            summary.needs_review += 1;
            break;
          case "deferred":
            summary.deferred += 1;
            break;
        }
      }
    });
    await Promise.all(workers);
    return summary;
  }

  /**
   * 启动恢复（进程重启后、开始投递前调用）：
   * - pending 且 last_attempt_at 非空 = 请求可能已发出但无回执 → delivery_unknown → needs_review；
   * - 已有 delivery_unknown（上次进程未来得及升级）→ needs_review。
   * 两者都**不重发**。
   */
  recoverStartup(): RecoverySummary {
    const nowIso = this.#nowIso();
    let recovered = 0;
    let reviewed = 0;
    for (const row of this.#store.inFlight()) {
      const reason = "process_interrupted_after_dispatch_start";
      this.#store.markDeliveryUnknown(row.id, reason, nowIso);
      recovered += 1;
      this.#emit(OUTBOX_EVENT_TYPES.deliveryUnknown, row, {
        status: "delivery_unknown",
        error: reason,
        attempts: row.attempts,
        recovered_from: "pending",
      }, { deliveryUnknown: true });
      if (this.#store.escalateToReview(row.id, reason, nowIso)) {
        reviewed += 1;
        this.#emit(OUTBOX_EVENT_TYPES.reviewed, row, {
          status: "needs_review",
          review_reason: reason,
          previous_status: "delivery_unknown",
          attempts: row.attempts,
        });
      }
    }
    for (const row of this.#store.byStatus("delivery_unknown")) {
      const reason = "unreviewed_delivery_unknown_at_startup";
      if (this.#store.escalateToReview(row.id, reason, nowIso)) {
        reviewed += 1;
        this.#emit(OUTBOX_EVENT_TYPES.reviewed, row, {
          status: "needs_review",
          review_reason: reason,
          previous_status: "delivery_unknown",
          attempts: row.attempts,
        });
      }
    }
    return { recovered, reviewed };
  }

  /**
   * 人工显式重试（Owner 决定）：仅 failed / needs_review；needs_review 必须
   * `confirmed: true`（明确承认「可能已送达，重试可能造成重复」）。
   */
  retry(
    id: string,
    options: { confirmed?: boolean; actorId?: "owner" } = {},
  ): OutboxMessageRecord {
    const row = this.#requireRow(id);
    if (row.status !== "failed" && row.status !== "needs_review") {
      throw new OutboxError(
        "invalid_status",
        `outbox row ${id} is ${row.status}; only failed or needs_review can be retried`,
        { status: row.status },
      );
    }
    if (row.status === "needs_review" && options.confirmed !== true) {
      throw new OutboxError(
        "confirmation_required",
        `outbox row ${id} may already have been delivered; retry requires {"confirmed": true}`,
        { status: row.status },
      );
    }
    const nowIso = this.#nowIso();
    this.#store.resetForRetry(id, nowIso);
    this.#emit(
      OUTBOX_EVENT_TYPES.retried,
      row,
      {
        status: "pending",
        previous_status: row.status,
        previous_attempts: row.attempts,
        confirmed: options.confirmed === true,
        error: row.last_error,
      },
      { actorId: options.actorId ?? "owner" },
    );
    return this.#requireRow(id);
  }

  /** 人工标记已送达（线下核对/平台后台确认）：写 manual receipt 并留审计。 */
  markSent(
    id: string,
    options: { platformMessageId?: string; note?: string; actorId?: "owner" } = {},
  ): OutboxMessageRecord {
    const row = this.#requireRow(id);
    if (row.status === "sent") {
      throw new OutboxError("invalid_status", `outbox row ${id} is already sent`, { status: row.status });
    }
    const nowIso = this.#nowIso();
    const receipt: OutboxReceipt = {
      sent_at: nowIso,
      ...(options.platformMessageId === undefined ? {} : { platform_message_id: options.platformMessageId }),
      raw: { manual: true, ...(options.note === undefined ? {} : { note: options.note }) },
    };
    this.#store.markSent(id, receipt, nowIso);
    this.#emit(
      OUTBOX_EVENT_TYPES.sent,
      row,
      {
        status: "sent",
        attempts: row.attempts,
        previous_status: row.status,
        manual: true,
        ...(options.note === undefined ? {} : { note: options.note }),
      },
      { actorId: options.actorId ?? "owner", receipt: this.#envelopeReceipt(row, receipt) },
    );
    return this.#requireRow(id);
  }

  close(): void {
    this.#store.close();
  }

  // --- 内部 ------------------------------------------------------------------

  async #dispatchRow(
    row: OutboxMessageRecord,
    adapter: OutboxChannelAdapter,
  ): Promise<"sent" | "failed" | "delivery_unknown" | "needs_review" | "deferred"> {
    const nowIso = this.#nowIso();

    // 副作用提交点 fencing（FR-DEP-4）：任务有活跃租约时，token 必须仍有效。
    if (row.task_id !== null && this.#leases !== null) {
      const lease = this.#leases.current(row.task_id);
      if (lease !== null && lease.active) {
        const token = this.#store.fencingToken(row.id);
        if (token === null || !this.#leases.validate(row.task_id, token)) {
          const reason = `lease_lost: fencing token ${token ?? "<none>"} is stale for task ${row.task_id}`;
          this.#store.defer(row.id, reason, this.#backoffAt(nowIso, Math.max(1, row.attempts)), nowIso);
          this.#emit(OUTBOX_EVENT_TYPES.failed, row, {
            status: row.status,
            attempts: row.attempts,
            error: reason,
            code: "lease_lost",
            will_retry: true,
            next_attempt_at: this.#backoffAt(nowIso, Math.max(1, row.attempts)),
          });
          return "deferred";
        }
      }
    }

    // 先落库再投递：请求可能发出之前，attempts/last_attempt_at 必须已持久化。
    const attempt = row.attempts + 1;
    this.#store.markAttempt(row.id, nowIso);

    let outcome: OutboxSendOutcome | OutboxChannelError;
    try {
      outcome = await this.#sendWithTimeout(adapter, {
        id: row.id,
        idempotency_key: row.idempotency_key,
        channel_id: row.channel_id,
        account_id: row.account_id,
        target: row.target,
        payload: row.payload,
        attempts: attempt,
      });
    } catch (err) {
      // 未分类异常 = 结果未知（保守）：不自动重发。
      outcome = err instanceof OutboxChannelError ? err : new OutboxChannelError("network", stringifyError(err));
    }

    const doneIso = this.#nowIso();
    if (!(outcome instanceof OutboxChannelError) && outcome.kind === "sent") {
      const receipt: OutboxReceipt = { sent_at: doneIso, ...(outcome.receipt ?? {}) };
      this.#store.markSent(row.id, receipt, doneIso);
      this.#emit(
        OUTBOX_EVENT_TYPES.sent,
        row,
        { status: "sent", attempts: attempt, receipt },
        { receipt: this.#envelopeReceipt(row, receipt) },
      );
      return "sent";
    }

    const detail =
      outcome instanceof OutboxChannelError
        ? { message: outcome.message, errorKind: outcome.kind }
        : { message: outcome.error, errorKind: "explicit" };

    if (detail.errorKind === "explicit") {
      // 平台明确拒收/4xx：幂等安全，可退避重试；达到上限后转人工核对。
      if (attempt >= this.#maxAttempts) {
        const reason = `${detail.message} (max attempts ${this.#maxAttempts} exhausted)`;
        this.#store.markFailed(row.id, reason, null, doneIso, "needs_review");
        this.#emit(OUTBOX_EVENT_TYPES.failed, row, {
          status: "failed",
          attempts: attempt,
          error: detail.message,
          will_retry: false,
        });
        this.#emit(OUTBOX_EVENT_TYPES.reviewed, row, {
          status: "needs_review",
          review_reason: "max_attempts_exhausted",
          previous_status: "failed",
          attempts: attempt,
          error: detail.message,
        });
        return "needs_review";
      }
      const nextAttemptAt = this.#backoffAt(doneIso, attempt);
      this.#store.markFailed(row.id, detail.message, nextAttemptAt, doneIso, "failed");
      this.#emit(OUTBOX_EVENT_TYPES.failed, row, {
        status: "failed",
        attempts: attempt,
        error: detail.message,
        will_retry: true,
        next_attempt_at: nextAttemptAt,
      });
      return "failed";
    }

    // 超时 / 网络中断 / 回执未知：请求可能已到达平台 —— 不自动重发，进人工核对。
    const reason = `${detail.errorKind}: ${detail.message}`;
    this.#store.markDeliveryUnknown(row.id, reason, doneIso);
    this.#emit(
      OUTBOX_EVENT_TYPES.deliveryUnknown,
      row,
      { status: "delivery_unknown", attempts: attempt, error: reason },
      { deliveryUnknown: true },
    );
    if (this.#store.escalateToReview(row.id, reason, doneIso)) {
      this.#emit(OUTBOX_EVENT_TYPES.reviewed, row, {
        status: "needs_review",
        review_reason: reason,
        previous_status: "delivery_unknown",
        attempts: attempt,
      });
    }
    return "delivery_unknown";
  }

  async #sendWithTimeout(adapter: OutboxChannelAdapter, request: OutboxSendRequest): Promise<OutboxSendOutcome> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OutboxChannelError("timeout", `channel adapter did not respond within ${this.#sendTimeoutMs}ms`));
      }, this.#sendTimeoutMs);
    });
    try {
      return await Promise.race([adapter.send(request, { signal: controller.signal }), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #backoffAt(fromIso: string, attempt: number): string {
    const delay = Math.min(this.#backoffBaseMs * 2 ** Math.max(0, attempt - 1), this.#backoffMaxMs);
    return new Date(new Date(fromIso).getTime() + delay).toISOString();
  }

  #envelopeReceipt(
    row: OutboxMessageRecord,
    receipt: OutboxReceipt,
  ): { channel: string; remote_message_id?: string; delivered_at?: string; error?: string } {
    return {
      channel: row.channel_id,
      ...(receipt.platform_message_id === undefined ? {} : { remote_message_id: receipt.platform_message_id }),
      ...(receipt.sent_at === undefined ? {} : { delivered_at: receipt.sent_at }),
      ...(typeof receipt.raw?.error === "string" ? { error: receipt.raw.error } : {}),
    };
  }

  #emit(
    eventType: OutboxEventType,
    row: OutboxMessageRecord,
    payload: Record<string, unknown>,
    options: {
      actorId?: "owner" | "agent:outbox";
      receipt?: { channel: string; remote_message_id?: string; delivered_at?: string; error?: string };
      deliveryUnknown?: boolean;
    } = {},
  ): void {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId: options.actorId ?? "agent:outbox",
      eventType,
      taskId: row.task_id,
      payload: {
        outbox_id: row.id,
        idempotency_key: row.idempotency_key,
        channel_id: row.channel_id,
        account_id: row.account_id,
        target: row.target,
        ...payload,
      },
      causationId: row.causation_id,
      idempotencyKey: row.idempotency_key,
      ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
      ...(options.deliveryUnknown === undefined ? {} : { deliveryUnknown: options.deliveryUnknown }),
    });
    this.#ledger.append(envelope);
  }

  #requireRow(id: string): OutboxMessageRecord {
    const row = this.#store.get(id);
    if (row === null) throw new OutboxError("not_found", `outbox row ${id} does not exist`);
    return row;
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }
}

function validateEnqueue(input: EnqueueOutboundInput): void {
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
    throw new OutboxError("invalid_input", "idempotencyKey must be a non-empty string");
  }
  if (typeof input.channelId !== "string" || input.channelId.length === 0) {
    throw new OutboxError("invalid_input", "channelId must be a non-empty string");
  }
  if (typeof input.accountId !== "string" || input.accountId.length === 0) {
    throw new OutboxError("invalid_input", "accountId must be a non-empty string");
  }
  if (
    input.target === null ||
    typeof input.target !== "object" ||
    (input.target.kind !== "conversation" && input.target.kind !== "user") ||
    typeof input.target.id !== "string" ||
    input.target.id.length === 0
  ) {
    throw new OutboxError("invalid_input", "target must be { kind: conversation|user, id: <non-empty string> }");
  }
  if (input.payload === null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new OutboxError("invalid_input", "payload must be a JSON object");
  }
  if (input.taskId !== undefined && input.taskId !== null && !UUID_RE.test(input.taskId)) {
    throw new OutboxError("invalid_input", "taskId must be a lowercase uuid");
  }
  if (
    input.fencingToken !== undefined &&
    input.fencingToken !== null &&
    (!Number.isInteger(input.fencingToken) || input.fencingToken < 1)
  ) {
    throw new OutboxError("invalid_input", "fencingToken must be a positive integer");
  }
  if (input.fencingToken !== undefined && input.fencingToken !== null && (input.taskId === undefined || input.taskId === null)) {
    throw new OutboxError("invalid_input", "fencingToken requires taskId");
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
