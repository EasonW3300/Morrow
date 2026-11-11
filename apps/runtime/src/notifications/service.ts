import type { EventEnvelope } from "@morrow/protocol";
import {
  NOTIFICATION_EVENT_TYPE_VALUES,
  type NotificationEventType,
  type NotificationHistoryPage,
  type NotificationQuietHours,
  type NotificationRecord,
  type NotificationRule,
  type NotificationRuleInput,
} from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import type { OutboxService } from "../outbox/service.ts";
import { uuidv7 } from "../uuid-v7.ts";
import { sanitizeForExternalRecipient } from "./sanitizer.ts";
import { NotificationStore } from "./store.ts";

/**
 * 通知规则与路由（M4-T7 / Issue #44，PRD §4.8 FR-NOT-1/2，AC-13）。
 *
 * 事件源：账本 append 订阅（EventLedger.subscribe）——任务域只在账本落 task.* 事件，
 * 本服务不反向依赖 TaskService/Scheduler。事件映射：
 *   completed     ← task.completed
 *   failed        ← task.failed（含规划失败后的终态）
 *   waiting_input ← task.waiting_input
 *   milestone     ← task.node_finished 且 payload.status = "completed"（单节点完成即里程碑；
 *                   pending_review/failed 的节点完成不是里程碑）
 * 去重：键 = task_id | event_type | target，滑动窗口（默认 10 分钟，可注入）；
 * 同一任务同类事件距上次投递不足窗口时长时对同一 target 只投递一次（不同 target 各自一次）。
 * 窗口从最近一次投递起算；Outbox 幂等键 = 去重基键 + 本次窗口起点。
 * 免打扰：quiet_hours 用 UTC HH:MM，窗口内先落 delayed 行，到点由 flushDue 放行；
 * 跨天（start > end）按「晚间 >= start 或 凌晨 < end」判定。
 * 渠道：先经 OutboxService.enqueue（idempotency_key = dedupe_key），再由投递器发送；
 * 本服务绝不直接调用渠道适配器。桌面：落本地 pending 行，GET /v1/notifications/pending
 * 供 UI 拉取（选择轮询而非 SSE：通知量小、需跨重启持久、UI 可幂等重复拉取）。
 * 裁剪：渠道目标是可信联系人/跨设备接收者——private/locked 记忆内容、文件路径、凭据
 * 一律替换为 [已裁剪]；标题与正文同样处理，但通知本身照发（不是整条丢弃）。
 */

export const NOTIFICATION_EVENT_TYPES = {
  ruleUpserted: "notification.rule_upserted",
  dispatched: "notification.dispatched",
  delayed: "notification.delayed",
  suppressed: "notification.suppressed",
  acknowledged: "notification.acknowledged",
} as const;

export type NotificationErrorCode =
  | "invalid_input"
  | "invalid_status"
  | "not_found"
  | "notify_target_required";

export class NotificationError extends Error {
  readonly code: NotificationErrorCode;

  constructor(code: NotificationErrorCode, message: string) {
    super(message);
    this.name = "NotificationError";
    this.code = code;
  }
}

/** 任务只读视图（runtime 注入 tasks.getTask；测试可省略，正文回退事件 payload） */
export interface NotificationTaskView {
  task_id: string;
  goal: string;
  status: string;
  error?: string;
  nodes: Array<{ key: string; title: string; status: string; result?: string; error?: string }>;
}

export interface NotificationServiceOptions {
  dataDir: string;
  ledger: EventLedger;
  replicaId: string;
  /** 渠道外发唯一出口；null/缺省时渠道目标落 failed（绝不直连适配器） */
  outbox?: OutboxService | null;
  now?: () => Date;
  /** 去重窗口（毫秒，默认 600_000 = 10 分钟） */
  dedupeWindowMs?: number;
  /** 任务详情（正文拼接 goal/结果）；缺省只用事件 payload */
  taskLookup?: (taskId: string) => NotificationTaskView | null;
  /** private/locked 记忆内容（渠道正文裁剪）；缺省空 */
  privateMemoryContents?: () => string[];
  /** 渠道账号解析（Outbox envelope 的 account_id）；缺省 ch-<channel> 占位 */
  channelAccountId?: (channelId: string) => string | null;
  /**
   * 渠道默认通知会话解析（A3 修复批 / Issue #37）：channel:<id> 目标必须映射到该
   * 渠道已存在/已白名单的 native conversation。提供本解析器时，保存渠道规则会校验；
   * 未配置目标 → 400 notify_target_required（不在运行时静默失败）。
   */
  channelNotifyTarget?: (channelId: string) => string | null;
  /** 正文最大长度（默认 1000 字符，超出截断） */
  maxBodyChars?: number;
}

export interface NotificationRouteOutcome {
  notification_id: string;
  target: string;
  status: NotificationRecord["status"];
}

export class NotificationService {
  readonly #store: NotificationStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #outbox: OutboxService | null;
  readonly #now: () => Date;
  readonly #dedupeWindowMs: number;
  readonly #taskLookup: ((taskId: string) => NotificationTaskView | null) | null;
  readonly #privateMemoryContents: () => string[];
  readonly #channelAccountId: ((channelId: string) => string | null) | null;
  readonly #channelNotifyTarget: ((channelId: string) => string | null) | null;
  readonly #maxBodyChars: number;
  #closed = false;

  constructor(options: NotificationServiceOptions) {
    this.#store = NotificationStore.open(options.dataDir);
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#outbox = options.outbox ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#dedupeWindowMs = Math.max(1, options.dedupeWindowMs ?? 600_000);
    this.#taskLookup = options.taskLookup ?? null;
    this.#privateMemoryContents = options.privateMemoryContents ?? (() => []);
    this.#channelAccountId = options.channelAccountId ?? null;
    this.#channelNotifyTarget = options.channelNotifyTarget ?? null;
    this.#maxBodyChars = Math.max(1, options.maxBodyChars ?? 1_000);
  }

  // --- 规则 ------------------------------------------------------------------

  listRules(): NotificationRule[] {
    this.#assertOpen();
    return this.#store.listRules();
  }

  /**
   * PUT /v1/notifications/rules：按 (event_type, target) key 合并 upsert。
   * 选择合并而非全量替换：桌面 UI 常按卡片局部保存，全量替换会把未提交的规则静默删掉；
   * 关闭规则用 enabled=false 显式表达，且每次 PUT 写一条 notification.rule_upserted 审计。
   */
  upsertRules(inputs: NotificationRuleInput[]): NotificationRule[] {
    this.#assertOpen();
    if (inputs.length === 0) throw new NotificationError("invalid_input", "rules must be a non-empty array");
    const normalized = inputs.map(normalizeRuleInput);
    // A3 修复批：渠道目标必须已解析到该渠道的默认通知会话；未配置即拒绝保存，
    // 避免规则落库后在运行时静默失败（通知只出现在 history，永远发不出去）。
    if (this.#channelNotifyTarget !== null) {
      for (const rule of normalized) {
        if (!rule.target.startsWith("channel:")) continue;
        const channelId = rule.target.slice("channel:".length);
        if (this.#channelNotifyTarget(channelId) === null) {
          throw new NotificationError(
            "notify_target_required",
            `notification target "${rule.target}" has no default notify conversation; set one with PUT /v1/channels/${channelId}/notify-target first`,
          );
        }
      }
    }
    const rules = this.#store.upsertRules(normalized, this.#now());
    this.#emit(NOTIFICATION_EVENT_TYPES.ruleUpserted, "owner", null, {
      rules: rules.map((rule) => ({
        event_type: rule.event_type,
        target: rule.target,
        quiet_hours: rule.quiet_hours,
        enabled: rule.enabled,
      })),
    });
    return rules;
  }

  // --- 查询 ------------------------------------------------------------------

  history(options: { status?: NotificationRecord["status"]; limit?: number; offset?: number } = {}): NotificationHistoryPage {
    this.#assertOpen();
    const limit = clampInt(options.limit, 1, 200, 50);
    const offset = clampInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const result = this.#store.listDeliveries({
      ...(options.status === undefined ? {} : { status: options.status }),
      limit,
      offset,
    });
    return { notifications: result.notifications, total: result.total, limit, offset };
  }

  /** 桌面待拉取（先 flush 到点的免打扰延迟行，再按时间升序返回） */
  pendingDesktop(limit = 50): NotificationRecord[] {
    this.#assertOpen();
    this.flushDue();
    return this.#store.listPendingDesktop(clampInt(limit, 1, 200, 50));
  }

  /** 桌面通知确认（UI 已展示/用户已读）：pending → sent。 */
  acknowledge(notificationId: string): NotificationRecord {
    this.#assertOpen();
    const row = this.#store.getDelivery(notificationId);
    if (row === null) throw new NotificationError("not_found", `notification ${notificationId} does not exist`);
    if (row.kind !== "desktop" || row.status !== "pending") {
      throw new NotificationError(
        "invalid_status",
        `notification ${notificationId} is ${row.kind}/${row.status}; only pending desktop notifications can be acknowledged`,
      );
    }
    const nowIso = this.#now().toISOString();
    this.#store.patchDelivery(notificationId, { status: "sent", deliveredAt: nowIso, detail: "acknowledged" });
    this.#emit(NOTIFICATION_EVENT_TYPES.acknowledged, "owner", row.task_id, {
      notification_id: notificationId,
      target: row.target,
      event_type: row.event_type,
    });
    return this.#store.getDelivery(notificationId) as NotificationRecord;
  }

  // --- 路由（后续切片填充） --------------------------------------------------

  /** 账本事件入口（runtime 订阅回调）。非任务完成类事件返回空。 */
  handleEnvelope(envelope: EventEnvelope): NotificationRouteOutcome[] {
    this.#assertOpen();
    return this.#route(envelope);
  }

  /** 把到点的 delayed 行转入实际投递通道；返回放行条数。 */
  flushDue(): number {
    this.#assertOpen();
    return this.#flushDue();
  }

  /** 投递 queued 的渠道通知（Outbox dispatch），并按回执同步通知状态。 */
  async dispatchQueued(): Promise<number> {
    this.#assertOpen();
    return this.#dispatchQueued();
  }

  /** 一次推进：静默时段放行 + 渠道投递（runtime 定时器/测试手动调用）。 */
  async drain(): Promise<{ flushed: number; dispatched: number }> {
    const flushed = this.flushDue();
    const dispatched = await this.dispatchQueued();
    return { flushed, dispatched };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  // --- 内部（后续切片实现） --------------------------------------------------

  #route(envelope: EventEnvelope): NotificationRouteOutcome[] {
    if (envelope.task_id === undefined || envelope.task_id === null) return [];
    const eventType = eventTypeFor(envelope);
    if (eventType === null) return [];
    const rules = this.#store.listEnabledRules(eventType);
    if (rules.length === 0) return [];
    const now = this.#now();
    const nowIso = now.toISOString();
    const windowMs = this.#dedupeWindowMs;
    const view = this.#taskLookup?.(envelope.task_id) ?? null;
    const message = this.#composeMessage(eventType, envelope, view);
    // 仅渠道投递才需要 private 记忆面；桌面-only 规则不触碰记忆表（懒加载）。
    let privateContents: string[] | null = null;

    const outcomes: NotificationRouteOutcome[] = [];
    for (const rule of rules) {
      const notificationId = uuidv7(now.getTime());
      // 滑动窗口：键 = task|event|target，窗口从最近一次投递起算（默认 10 分钟）。
      const dedupeBase = `${envelope.task_id}|${eventType}|${rule.target}`;
      if (!this.#store.claimDedupe(dedupeBase, notificationId, nowIso, nowIso, windowMs)) {
        this.#emit(NOTIFICATION_EVENT_TYPES.suppressed, "agent:notification", envelope.task_id, {
          event_type: eventType,
          target: rule.target,
          reason: "dedupe_window",
          window_start: nowIso,
          dedupe_key: dedupeBase,
        });
        continue;
      }
      // 本次投递的稳定标识（Outbox 幂等键）：基键 + 本次窗口起点。
      const dedupeKey = `${dedupeBase}|${nowIso}`;
      const kind = rule.target === "desktop" ? "desktop" : "channel";
      const channelId = kind === "channel" ? rule.target.slice("channel:".length) : null;
      // 渠道接收者（可信联系人/跨设备）只看裁剪后的摘要；桌面是本机 Owner，保留全文。
      const outgoing =
        kind === "desktop"
          ? message
          : (() => {
              privateContents ??= this.#privateMemoryContents();
              return {
                title: sanitizeForExternalRecipient(message.title, privateContents),
                body: sanitizeForExternalRecipient(message.body, privateContents),
              };
            })();
      const quietUntil = quietHoursUntil(now, rule.quiet_hours);
      const record = this.#store.insertDelivery({
        notificationId,
        taskId: envelope.task_id,
        eventType,
        target: rule.target,
        kind,
        channelId,
        status: quietUntil === null ? (kind === "desktop" ? "pending" : "queued") : "delayed",
        title: outgoing.title,
        body: outgoing.body,
        outboxId: null,
        dedupeKey,
        deliverAfter: quietUntil === null ? null : quietUntil.toISOString(),
        detail: quietUntil === null ? null : "quiet_hours",
        createdAt: nowIso,
      });
      if (quietUntil !== null) {
        this.#emit(NOTIFICATION_EVENT_TYPES.delayed, "agent:notification", envelope.task_id, {
          notification_id: record.notification_id,
          event_type: eventType,
          target: rule.target,
          status: record.status,
          deliver_after: record.deliver_after,
        });
      } else if (kind === "desktop") {
        this.#emit(NOTIFICATION_EVENT_TYPES.dispatched, "agent:notification", envelope.task_id, {
          notification_id: record.notification_id,
          event_type: eventType,
          target: rule.target,
          status: "pending",
        });
      } else {
        this.#enqueueChannel(record);
      }
      const current = this.#store.getDelivery(record.notification_id) as NotificationRecord;
      outcomes.push({ notification_id: record.notification_id, target: rule.target, status: current.status });
    }
    return outcomes;
  }

  #composeMessage(
    eventType: NotificationEventType,
    envelope: EventEnvelope,
    view: NotificationTaskView | null,
  ): { title: string; body: string } {
    const payload = envelope.payload as Record<string, unknown>;
    const goal = view?.goal ?? stringField(payload, "goal") ?? stringField(payload, "title") ?? envelope.task_id ?? "task";
    let title: string;
    let body: string;
    switch (eventType) {
      case "completed": {
        title = `任务完成：${goal}`;
        const results = (view?.nodes ?? [])
          .filter((node) => node.status === "completed" && typeof node.result === "string")
          .map((node) => `${node.title}: ${node.result}`);
        body = [goal, ...results].join("\n");
        break;
      }
      case "failed": {
        title = `任务失败：${goal}`;
        const reason =
          stringField(payload, "message") ?? stringField(payload, "error") ?? view?.error ?? "unknown error";
        body = `${goal}\n原因：${reason}`;
        break;
      }
      case "waiting_input": {
        title = `任务等待输入：${goal}`;
        const prompt = stringField(payload, "message") ?? stringField(payload, "prompt") ?? "需要你的确认";
        body = `${goal}\n${prompt}`;
        break;
      }
      case "milestone": {
        const key = stringField(payload, "key") ?? stringField(payload, "node_id") ?? "node";
        const nodeTitle = view?.nodes.find((node) => node.key === key)?.title ?? key;
        title = `节点完成：${nodeTitle}`;
        const result = stringField(payload, "result") ?? "completed";
        body = `${goal}\n${nodeTitle}: ${result}`;
        break;
      }
    }
    return { title: truncate(title, 200), body: truncate(body, this.#maxBodyChars) };
  }

  #flushDue(): number {
    const now = this.#now();
    const nowIso = now.toISOString();
    const due = this.#store.dueDelayed(nowIso);
    let released = 0;
    for (const row of due) {
      if (row.kind === "desktop") {
        this.#store.patchDelivery(row.notification_id, { status: "pending", detail: null });
        this.#emit(NOTIFICATION_EVENT_TYPES.dispatched, "agent:notification", row.task_id, {
          notification_id: row.notification_id,
          event_type: row.event_type,
          target: row.target,
          status: "pending",
          released_from: "delayed",
        });
        released += 1;
      } else {
        this.#store.patchDelivery(row.notification_id, { deliverAfter: null });
        this.#enqueueChannel(row);
        released += 1;
      }
    }
    return released;
  }

  /** 渠道通知入 Outbox（唯一外发路径）；失败保留行并落 failed，绝不直连适配器。 */
  #enqueueChannel(row: NotificationRecord): void {
    if (row.channel_id === null) {
      this.#channelFailed(row, "channel_unavailable: target has no channel id");
      return;
    }
    if (this.#outbox === null) {
      this.#channelFailed(row, "outbox_unavailable: notification service has no outbox wired");
      return;
    }
    const accountId = this.#channelAccountId?.(row.channel_id) ?? null;
    if (accountId === null) {
      this.#channelFailed(row, `channel_unavailable: no account bound to ${row.channel_id}`);
      return;
    }
    // A3 修复批：按 Owner 指定的默认通知会话投递（native_conversation_id），而不是
    // 硬编码的 owner 用户目标——飞书/QQ 适配器无法解析 user:owner。
    const targetConversation = this.#channelNotifyTarget?.(row.channel_id) ?? null;
    if (targetConversation === null) {
      this.#channelFailed(row, `notify_target_required: no default notify conversation for ${row.channel_id}`);
      return;
    }
    try {
      const queued = this.#outbox.enqueue({
        idempotencyKey: `notification:${row.dedupe_key}`,
        channelId: row.channel_id,
        accountId,
        target: { kind: "conversation", id: targetConversation },
        payload: {
          kind: "notification",
          notification_id: row.notification_id,
          task_id: row.task_id,
          event_type: row.event_type,
          title: row.title,
          text: row.body,
        },
        causationId: null,
        taskId: row.task_id,
      });
      this.#store.patchDelivery(row.notification_id, {
        status: "queued",
        outboxId: queued.id,
        detail: queued.deduped ? "outbox_deduped" : null,
      });
      this.#emit(NOTIFICATION_EVENT_TYPES.dispatched, "agent:notification", row.task_id, {
        notification_id: row.notification_id,
        event_type: row.event_type,
        target: row.target,
        status: "queued",
        outbox_id: queued.id,
      });
    } catch (err) {
      this.#channelFailed(row, `outbox_enqueue_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #channelFailed(row: NotificationRecord, detail: string): void {
    this.#store.patchDelivery(row.notification_id, { status: "failed", detail, outboxId: null });
    this.#emit(NOTIFICATION_EVENT_TYPES.dispatched, "agent:notification", row.task_id, {
      notification_id: row.notification_id,
      event_type: row.event_type,
      target: row.target,
      status: "failed",
      detail,
    });
  }

  async #dispatchQueued(): Promise<number> {
    if (this.#outbox === null) return 0;
    const rows = this.#store.queuedChannel();
    if (rows.length === 0) return 0;
    try {
      await this.#outbox.dispatchOnce({ limit: rows.length });
    } catch (err) {
      if (err instanceof Error && err.name === "OutboxError" && (err as { code?: string }).code === "adapter_unavailable") {
        return 0;
      }
      throw err;
    }
    let sent = 0;
    for (const row of rows) {
      const outboxRow = row.outbox_id === null ? null : this.#outbox.get(row.outbox_id);
      if (outboxRow === null) continue;
      switch (outboxRow.status) {
        case "sent":
          this.#store.patchDelivery(row.notification_id, {
            status: "sent",
            deliveredAt: outboxRow.receipt?.sent_at ?? this.#now().toISOString(),
            detail: null,
          });
          this.#emit(NOTIFICATION_EVENT_TYPES.dispatched, "agent:notification", row.task_id, {
            notification_id: row.notification_id,
            event_type: row.event_type,
            target: row.target,
            status: "sent",
            outbox_id: row.outbox_id,
          });
          sent += 1;
          break;
        case "failed":
          this.#store.patchDelivery(row.notification_id, {
            status: "failed",
            detail: outboxRow.last_error,
          });
          break;
        case "delivery_unknown":
          this.#store.patchDelivery(row.notification_id, { status: "delivery_unknown", detail: outboxRow.last_error });
          break;
        case "needs_review":
          this.#store.patchDelivery(row.notification_id, { status: "needs_review", detail: outboxRow.last_error });
          break;
        default:
          break;
      }
    }
    return sent;
  }

  // --- 基础 ------------------------------------------------------------------

  #emit(
    eventType: string,
    actorId: "owner" | "agent:runtime" | "agent:notification",
    taskId: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId,
        eventType,
        payload,
        ...(taskId === null ? {} : { taskId }),
      }),
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("NotificationService is closed");
  }
}

function normalizeRuleInput(input: NotificationRuleInput): NotificationRuleInput {
  if (input === null || typeof input !== "object") {
    throw new NotificationError("invalid_input", "each rule must be an object");
  }
  if (!NOTIFICATION_EVENT_TYPE_VALUES.includes(input.event_type)) {
    throw new NotificationError(
      "invalid_input",
      `event_type must be one of ${NOTIFICATION_EVENT_TYPE_VALUES.join(" | ")}`,
    );
  }
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!(target === "desktop" || /^channel:\S+$/.test(target))) {
    throw new NotificationError("invalid_input", "target must be desktop or channel:<channel_id>");
  }
  let quietHours: NotificationQuietHours | null = null;
  if (input.quiet_hours !== undefined && input.quiet_hours !== null) {
    const raw = input.quiet_hours;
    if (
      typeof raw !== "object" ||
      typeof raw.start !== "string" ||
      typeof raw.end !== "string" ||
      !isClock(raw.start) ||
      !isClock(raw.end)
    ) {
      throw new NotificationError("invalid_input", "quiet_hours must be { start: 'HH:MM', end: 'HH:MM' }");
    }
    quietHours = { start: raw.start, end: raw.end };
  }
  return {
    event_type: input.event_type,
    target,
    quiet_hours: quietHours,
    enabled: input.enabled ?? true,
  };
}

function isClock(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** 账本事件 → 通知事件类型；milestone 仅取 completed 的节点完成事件 */
function eventTypeFor(envelope: EventEnvelope): NotificationEventType | null {
  switch (envelope.event_type) {
    case "task.completed":
      return "completed";
    case "task.failed":
      return "failed";
    case "task.waiting_input":
      return "waiting_input";
    case "task.node_finished": {
      const status = (envelope.payload as Record<string, unknown>).status;
      return status === "completed" ? "milestone" : null;
    }
    default:
      return null;
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 免打扰结束时刻；不在时段内返回 null。
 * 语义：UTC wall clock，start 含、end 不含；start > end 为跨天（晚间 >= start 或凌晨 < end）。
 * start === end 视为零长度窗口（不静默）。
 */
function quietHoursUntil(now: Date, quiet: NotificationQuietHours | null): Date | null {
  if (quiet === null) return null;
  const start = clockMinutes(quiet.start);
  const end = clockMinutes(quiet.end);
  if (start === end) return null;
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const inWindow =
    start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
  if (!inWindow) return null;

  const endsAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(end / 60), end % 60, 0, 0),
  );
  if (endsAt.getTime() <= now.getTime()) endsAt.setUTCDate(endsAt.getUTCDate() + 1);
  return endsAt;
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export type { NotificationEventType };
