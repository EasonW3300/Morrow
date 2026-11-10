/**
 * 桌面通知消费端纯逻辑（Issue #47，PRD §4.8 FR-NOT-2 / §5.1）。
 *
 * 背景：runtime 的通知控制面（GET /v1/notifications/pending、POST /:id/ack）早已就绪，
 * 但桌面从未拉取——pending 行永远停在数据库里。本模块承载消费端的全部可测决策，
 * React（NotificationCenter）只做装配：
 *
 *   - 轮询状态机：拉 pending → 逐条展示 → 展示成功后 ack（pending → sent）；
 *   - 去重：同一 notification id 在一次会话内只弹一次系统通知（服务端 status 兜底：
 *     已 ack 的行不会再出现在 pending）；
 *   - ack 失败：指数退避重试（默认 3 次），日志只记 id/类型/正文长度，绝不打印正文；
 *   - 降级：系统通知不可用/权限被拒时只在应用内通知中心展示，**不 ack**（保留 pending，
 *     未读数 = pending 条数，「全部标记已读」再逐条 ack）；
 *   - 权限：首次启动请求一次；被拒后不再重复弹系统授权框（本地标记），仅应用内提示。
 *
 * 类型一律从 `@morrow/protocol/browser` 引（主入口有浏览器守卫测试）。
 */
import type { NotificationEventType, NotificationRecord } from "@morrow/protocol/browser";

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_ACK_MAX_ATTEMPTS = 3;
export const DEFAULT_ACK_BACKOFF_BASE_MS = 500;
/** 权限被拒的本地标记：存在即不再自动请求系统授权（用户可手动「重新请求权限」） */
export const PERMISSION_DENIED_STORAGE_KEY = "morrow.notification.permissionDenied";

// --- 轮询与展示 -------------------------------------------------------------------

/** 展示结果：systemDelivered=true 才会 ack；false/缺省 = 降级为应用内展示，保留 pending */
export type NotificationDisplay = (
  record: NotificationRecord,
) => boolean | void | Promise<boolean | void>;

/** 诊断日志字段：只有 id/类型/长度，绝不包含正文（Issue #47 安全要求） */
export interface NotificationLogFields {
  notificationId: string;
  eventType: string;
  bodyLength: number;
  attempt?: number;
  error?: string;
}

export interface NotificationLogger {
  warn(message: string, fields?: NotificationLogFields): void;
}

const consoleLogger: NotificationLogger = {
  warn(message, fields) {
    console.warn(message, fields);
  },
};

export interface NotificationPollerOptions {
  fetchPending: () => Promise<NotificationRecord[]>;
  ack: (notificationId: string) => Promise<unknown>;
  /** 展示回调；返回值 true（或未提供）视为系统通知已展示，随后 ack */
  display?: NotificationDisplay;
  /** 轮询间隔（毫秒）；0 = 不启动定时器（测试/关闭） */
  intervalMs?: number;
  /** ack 最大尝试次数（含首次），默认 3 */
  ackMaxAttempts?: number;
  /** 指数退避基数（毫秒），默认 500 */
  ackBackoffBaseMs?: number;
  /** 注入 sleep（测试零等待） */
  sleep?: (ms: number) => Promise<void>;
  logger?: NotificationLogger;
  /** 会话内已系统展示的 id 集合；传同一个 Set 可跨组件重挂载去重（StrictMode） */
  deliveredIds?: Set<string>;
  onChange?: (pending: readonly NotificationRecord[]) => void;
  onError?: (err: unknown) => void;
  now?: () => Date;
}

export interface PollOnceResult {
  fetched: number;
  displayed: number;
  acknowledged: number;
  ackFailed: number;
  /** 本轮因上一次 poll 未完成而跳过 */
  skipped: boolean;
}

export interface MarkAllReadResult {
  acknowledged: number;
  failed: number;
}

/**
 * 通知轮询状态机。所有 I/O 都由调用方注入（fetchPending/ack/display/sleep），
 * 因此 node:test 可零网络、零计时地覆盖全部路径。
 */
export class NotificationPoller {
  readonly #fetchPending: () => Promise<NotificationRecord[]>;
  readonly #ack: (notificationId: string) => Promise<unknown>;
  readonly #display: NotificationDisplay | null;
  readonly #intervalMs: number;
  readonly #ackMaxAttempts: number;
  readonly #ackBackoffBaseMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #logger: NotificationLogger;
  readonly #deliveredIds: Set<string>;
  readonly #onChange: ((pending: readonly NotificationRecord[]) => void) | undefined;
  readonly #onError: ((err: unknown) => void) | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<PollOnceResult> | null = null;
  #pending: NotificationRecord[] = [];

  constructor(options: NotificationPollerOptions) {
    this.#fetchPending = options.fetchPending;
    this.#ack = options.ack;
    this.#display = options.display ?? null;
    this.#intervalMs = Math.max(0, Math.trunc(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.#ackMaxAttempts = Math.max(1, Math.trunc(options.ackMaxAttempts ?? DEFAULT_ACK_MAX_ATTEMPTS));
    this.#ackBackoffBaseMs = Math.max(1, Math.trunc(options.ackBackoffBaseMs ?? DEFAULT_ACK_BACKOFF_BASE_MS));
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#logger = options.logger ?? consoleLogger;
    this.#deliveredIds = options.deliveredIds ?? new Set();
    this.#onChange = options.onChange;
    this.#onError = options.onError;
  }

  /** 最近一次轮询后的待读列表（已成功 ack 的不在里面） */
  get pending(): readonly NotificationRecord[] {
    return this.#pending;
  }

  /** 未读 = pending 条数（与顶栏铃铛计数同一口径） */
  get unreadCount(): number {
    return this.#pending.length;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer !== null || this.#intervalMs <= 0) return;
    this.#emitErrorSafe(this.pollOnce());
    this.#timer = setInterval(() => {
      this.#emitErrorSafe(this.pollOnce());
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** 主动拉一轮（不依赖定时器）；并发调用时复用进行中的那一轮 */
  pollOnce(): Promise<PollOnceResult> {
    if (this.#inFlight !== null) {
      return this.#inFlight.then((result) => ({ ...result, skipped: true }));
    }
    const run = this.#pollOnce().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = run;
    return run;
  }

  /** 「全部标记已读」：逐条 ack 当前 pending；成功的从列表移除，失败的保留 */
  async markAllRead(): Promise<MarkAllReadResult> {
    const batch = [...this.#pending];
    let acknowledged = 0;
    let failed = 0;
    const remaining: NotificationRecord[] = [];
    for (const record of batch) {
      if (await this.#ackWithRetry(record)) {
        acknowledged += 1;
        this.#deliveredIds.add(record.notification_id);
      } else {
        failed += 1;
        remaining.push(record);
      }
    }
    if (remaining.length !== this.#pending.length) {
      this.#pending = remaining;
      this.#notifyChange();
    }
    return { acknowledged, failed };
  }

  async #pollOnce(): Promise<PollOnceResult> {
    let fetched: NotificationRecord[];
    try {
      fetched = await this.#fetchPending();
    } catch (err) {
      this.#onError?.(err);
      return { fetched: 0, displayed: 0, acknowledged: 0, ackFailed: 0, skipped: false };
    }

    let displayed = 0;
    let acknowledged = 0;
    let ackFailed = 0;
    const ackedIds = new Set<string>();

    for (const record of fetched) {
      // 服务端 status 已保证 ack 过的不在 pending；这里的 deliveredIds 是会话内
      // 「同一条不重复弹系统通知」的端侧兜底（ack 失败时下一轮只重试 ack，不再弹）。
      if (!this.#deliveredIds.has(record.notification_id)) {
        let systemDelivered = true;
        if (this.#display !== null) {
          try {
            const result = await this.#display(record);
            systemDelivered = result !== false;
          } catch (err) {
            // 展示失败（如系统通知 API 抛错）→ 降级应用内，保留 pending 等用户已读
            systemDelivered = false;
            this.#logger.warn("notification display failed", {
              notificationId: record.notification_id,
              eventType: record.event_type,
              bodyLength: record.body.length,
              error: errorMessage(err),
            });
          }
        }
        if (!systemDelivered) continue; // 应用内中心已可见（pending 保留），不 ack
        this.#deliveredIds.add(record.notification_id);
        displayed += 1;
      }

      if (await this.#ackWithRetry(record)) {
        acknowledged += 1;
        ackedIds.add(record.notification_id);
      } else {
        ackFailed += 1;
      }
    }

    // 已成功 ack 的从本次 pending 移除；ack 失败/降级项保留（应用内中心仍可见）。
    this.#pending = fetched.filter((record) => !ackedIds.has(record.notification_id));
    this.#notifyChange();
    return { fetched: fetched.length, displayed, acknowledged, ackFailed, skipped: false };
  }

  async #ackWithRetry(record: NotificationRecord): Promise<boolean> {
    let delay = this.#ackBackoffBaseMs;
    for (let attempt = 1; attempt <= this.#ackMaxAttempts; attempt += 1) {
      try {
        await this.#ack(record.notification_id);
        return true;
      } catch (err) {
        this.#logger.warn("notification ack failed", {
          notificationId: record.notification_id,
          eventType: record.event_type,
          bodyLength: record.body.length,
          attempt,
          error: errorMessage(err),
        });
        if (attempt < this.#ackMaxAttempts) {
          await this.#sleep(delay);
          delay *= 2;
        }
      }
    }
    return false;
  }

  #notifyChange(): void {
    this.#onChange?.([...this.#pending]);
  }

  #emitErrorSafe(promise: Promise<PollOnceResult>): void {
    void promise.catch((err: unknown) => this.#onError?.(err));
  }
}

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// --- 权限与降级 -------------------------------------------------------------------

/**
 * 系统通知权限四态：
 * - granted      系统通知可用；
 * - denied       用户拒绝（或本地标记为拒绝）→ 应用内降级，不再自动弹授权框；
 * - prompt       尚未决定 → 首次启动请求一次；
 * - unavailable  当前环境没有系统通知能力（浏览器联调）→ 应用内降级。
 */
export type NotificationPermissionState = "granted" | "denied" | "prompt" | "unavailable";

export interface PermissionNotice {
  tone: "warn" | "muted";
  title: string;
  detail: string;
  canRequest: boolean;
}

/** 面板顶部说明；granted 时无提示 */
export function permissionNotice(state: NotificationPermissionState): PermissionNotice | null {
  switch (state) {
    case "granted":
      return null;
    case "denied":
      return {
        tone: "warn",
        title: "系统通知权限未授予",
        detail:
          "新通知会保留在应用内通知中心，不会再重复弹出系统授权框。需要系统通知时可点「重新请求权限」。",
        canRequest: true,
      };
    case "prompt":
      return {
        tone: "warn",
        title: "系统通知权限尚未授予",
        detail: "授予后任务完成/失败等事件会弹出系统通知；未授予时通知只出现在应用内中心。",
        canRequest: true,
      };
    case "unavailable":
      return {
        tone: "muted",
        title: "当前环境不支持系统通知",
        detail: "浏览器联调模式：通知只在应用内通知中心展示。桌面应用内可弹出系统通知。",
        canRequest: false,
      };
  }
}

/** 首次启动是否自动请求权限：只在「尚未决定」且没有本地拒绝标记时请求一次 */
export function shouldRequestPermissionOnStartup(
  state: NotificationPermissionState,
  previouslyDenied: boolean,
): boolean {
  return state === "prompt" && !previouslyDenied;
}

/** 用户点「重新请求权限」是否应调用系统 API（unavailable 无意义） */
export function canRequestPermissionAgain(state: NotificationPermissionState): boolean {
  return state !== "unavailable";
}

/** 浏览器走查用：?notification_permission=denied|granted|prompt 强制权限态（其他值忽略） */
export function resolvePermissionOverride(search: string): NotificationPermissionState | null {
  const value = new URLSearchParams(search).get("notification_permission");
  return value === "denied" || value === "granted" || value === "prompt" ? value : null;
}

/** 轮询间隔：?notification_poll_ms=0 关闭；其次 VITE_NOTIFICATION_POLL_MS；默认 10s */
export function resolvePollIntervalMs(search: string, envValue?: string): number {
  const fromQuery = new URLSearchParams(search).get("notification_poll_ms");
  const raw = fromQuery ?? envValue;
  if (raw === undefined || raw.trim() === "") return DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.trunc(parsed);
}

// --- 展示投影 ---------------------------------------------------------------------

const EVENT_TYPE_LABELS: Record<NotificationEventType, string> = {
  completed: "任务完成",
  failed: "任务失败",
  waiting_input: "等待输入",
  milestone: "里程碑",
};

export function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType as NotificationEventType] ?? eventType;
}

export function eventTypeTone(eventType: string): "ok" | "error" | "warn" | "muted" {
  switch (eventType) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "waiting_input":
      return "warn";
    default:
      return "muted";
  }
}

/** 正文摘要：压平空白并截断（面板一行展示；不改动服务端已裁剪的正文） */
export function notificationSummary(body: string, maxChars = 120): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** 跳转任务 id：仅在 task_id 非空时可用（不臆造、不从正文解析） */
export function taskIdForNavigation(record: Pick<NotificationRecord, "task_id">): string | null {
  const taskId = record.task_id;
  if (typeof taskId !== "string") return null;
  const trimmed = taskId.trim();
  return trimmed === "" ? null : trimmed;
}

/** 时间展示：同一天 HH:MM，否则 MM-DD HH:MM（本地时区；now 可注入） */
export function formatNotificationTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}
