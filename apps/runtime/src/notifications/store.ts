import { join } from "node:path";
import type {
  NotificationDeliveryStatus,
  NotificationQuietHours,
  NotificationRecord,
  NotificationRule,
  NotificationRuleInput,
} from "@morrow/protocol";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { DB_FILE_NAME } from "../ledger.ts";
import { uuidv7 } from "../uuid-v7.ts";
import { ensureNotificationTables } from "./migrations.ts";

/**
 * 通知规则/投递的可变投影存储（M4-T7）。与账本同库、独立连接。
 * 规则写入按 (event_type, target) 合并 upsert；投递行的状态推进是单向的：
 * delayed → pending/queued → sent/failed/delivery_unknown/needs_review。
 */

interface RuleRow {
  rule_id: string;
  event_type: string;
  target: string;
  quiet_hours: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  notification_id: string;
  task_id: string | null;
  event_type: string;
  target: string;
  kind: string;
  channel_id: string | null;
  status: string;
  title: string;
  body: string;
  outbox_id: string | null;
  dedupe_key: string;
  deliver_after: string | null;
  detail: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface DeliveryInsert {
  notificationId: string;
  taskId: string | null;
  eventType: string;
  target: string;
  kind: "desktop" | "channel";
  channelId: string | null;
  status: NotificationDeliveryStatus;
  title: string;
  body: string;
  outboxId: string | null;
  dedupeKey: string;
  deliverAfter: string | null;
  detail: string | null;
  createdAt: string;
}

export interface DeliveryPatch {
  status?: NotificationDeliveryStatus;
  outboxId?: string | null;
  deliverAfter?: string | null;
  detail?: string | null;
  deliveredAt?: string | null;
}

export class NotificationStore {
  readonly #db: SqliteDatabase;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureNotificationTables(db);
  }

  static open(dataDir: string): NotificationStore {
    return new NotificationStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  /** 全部规则（event_type, target 升序；GET /v1/notifications/rules 的稳定顺序） */
  listRules(): NotificationRule[] {
    const rows = this.#db
      .prepare("SELECT * FROM notification_rules ORDER BY event_type, target")
      .all() as unknown as RuleRow[];
    return rows.map(rowToRule);
  }

  listEnabledRules(eventType: string): NotificationRule[] {
    const rows = this.#db
      .prepare("SELECT * FROM notification_rules WHERE event_type = ? AND enabled = 1 ORDER BY target")
      .all(eventType) as unknown as RuleRow[];
    return rows.map(rowToRule);
  }

  /** 按 key 合并 upsert；返回写入后的规则行（顺序同入参） */
  upsertRules(inputs: NotificationRuleInput[], now: Date): NotificationRule[] {
    const nowIso = now.toISOString();
    const stmt = this.#db.prepare(
      `INSERT INTO notification_rules (rule_id, event_type, target, quiet_hours, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_type, target) DO UPDATE SET
         quiet_hours = excluded.quiet_hours,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    );
    return this.#tx(() => {
      const out: NotificationRule[] = [];
      for (const input of inputs) {
        stmt.run(
          uuidv7(now.getTime()),
          input.event_type,
          input.target,
          input.quiet_hours === undefined || input.quiet_hours === null
            ? null
            : JSON.stringify(input.quiet_hours),
          (input.enabled ?? true) ? 1 : 0,
          nowIso,
          nowIso,
        );
        out.push(this.getRule(input.event_type, input.target) as NotificationRule);
      }
      return out;
    });
  }

  getRule(eventType: string, target: string): NotificationRule | null {
    const row = this.#db
      .prepare("SELECT * FROM notification_rules WHERE event_type = ? AND target = ?")
      .get(eventType, target) as RuleRow | undefined;
    return row === undefined ? null : rowToRule(row);
  }

  /**
   * 滑动窗口去重：同 key 上次投递在 windowMs 内 → false（suppressed）。
   * 命中时把窗口起点推进到本次 now（窗口从最近一次投递起算）。
   */
  claimDedupe(
    dedupeKey: string,
    notificationId: string,
    windowStart: string,
    now: string,
    windowMs: number,
  ): boolean {
    const existing = this.#db
      .prepare("SELECT window_start FROM notification_dedup WHERE dedupe_key = ?")
      .get(dedupeKey) as { window_start: string } | undefined;
    if (existing !== undefined) {
      const elapsed = Date.parse(now) - Date.parse(existing.window_start);
      if (elapsed >= 0 && elapsed < windowMs) return false;
    }
    this.#db
      .prepare(
        `INSERT INTO notification_dedup (dedupe_key, notification_id, window_start, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           notification_id = excluded.notification_id,
           window_start = excluded.window_start,
           created_at = excluded.created_at`,
      )
      .run(dedupeKey, notificationId, windowStart, now);
    return true;
  }

  insertDelivery(input: DeliveryInsert): NotificationRecord {
    this.#db
      .prepare(
        `INSERT INTO notification_deliveries
           (notification_id, task_id, event_type, target, kind, channel_id, status, title, body,
            outbox_id, dedupe_key, deliver_after, detail, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.notificationId,
        input.taskId,
        input.eventType,
        input.target,
        input.kind,
        input.channelId,
        input.status,
        input.title,
        input.body,
        input.outboxId,
        input.dedupeKey,
        input.deliverAfter,
        input.detail,
        input.createdAt,
      );
    return this.getDelivery(input.notificationId) as NotificationRecord;
  }

  getDelivery(notificationId: string): NotificationRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM notification_deliveries WHERE notification_id = ?")
      .get(notificationId) as DeliveryRow | undefined;
    return row === undefined ? null : rowToDelivery(row);
  }

  patchDelivery(notificationId: string, patch: DeliveryPatch): void {
    const sets: string[] = [];
    const params: Array<string | null> = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.outboxId !== undefined) {
      sets.push("outbox_id = ?");
      params.push(patch.outboxId);
    }
    if (patch.deliverAfter !== undefined) {
      sets.push("deliver_after = ?");
      params.push(patch.deliverAfter);
    }
    if (patch.detail !== undefined) {
      sets.push("detail = ?");
      params.push(patch.detail);
    }
    if (patch.deliveredAt !== undefined) {
      sets.push("delivered_at = ?");
      params.push(patch.deliveredAt);
    }
    if (sets.length === 0) return;
    this.#db
      .prepare(`UPDATE notification_deliveries SET ${sets.join(", ")} WHERE notification_id = ?`)
      .run(...params, notificationId);
  }

  listDeliveries(options: {
    status?: NotificationDeliveryStatus;
    kind?: "desktop" | "channel";
    limit: number;
    offset: number;
  }): { notifications: NotificationRecord[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.status !== undefined) {
      where.push("status = ?");
      params.push(options.status);
    }
    if (options.kind !== undefined) {
      where.push("kind = ?");
      params.push(options.kind);
    }
    const clause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
    const total = Number(
      (this.#db.prepare(`SELECT COUNT(*) AS n FROM notification_deliveries${clause}`).get(...params) as { n: number })
        .n,
    );
    const rows = this.#db
      .prepare(
        `SELECT * FROM notification_deliveries${clause}
         ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit, options.offset) as unknown as DeliveryRow[];
    return { notifications: rows.map(rowToDelivery), total };
  }

  /** 到点的延迟行（免打扰时段已结束） */
  dueDelayed(nowIso: string, limit = 100): NotificationRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM notification_deliveries
         WHERE status = 'delayed' AND deliver_after IS NOT NULL AND deliver_after <= ?
         ORDER BY deliver_after, rowid LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  /** 桌面待拉取（升序：先到先显示） */
  listPendingDesktop(limit = 50): NotificationRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM notification_deliveries
         WHERE kind = 'desktop' AND status = 'pending'
         ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(limit) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  queuedChannel(limit = 100): NotificationRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM notification_deliveries
         WHERE kind = 'channel' AND status = 'queued' AND outbox_id IS NOT NULL
         ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(limit) as unknown as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  close(): void {
    this.#db.close();
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }
}

function rowToRule(row: RuleRow): NotificationRule {
  return {
    rule_id: row.rule_id,
    event_type: row.event_type as NotificationRule["event_type"],
    target: row.target,
    quiet_hours: row.quiet_hours === null ? null : (JSON.parse(row.quiet_hours) as NotificationQuietHours),
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToDelivery(row: DeliveryRow): NotificationRecord {
  return {
    notification_id: row.notification_id,
    task_id: row.task_id,
    event_type: row.event_type as NotificationRecord["event_type"],
    target: row.target,
    kind: row.kind as NotificationRecord["kind"],
    channel_id: row.channel_id,
    status: row.status as NotificationDeliveryStatus,
    title: row.title,
    body: row.body,
    outbox_id: row.outbox_id,
    dedupe_key: row.dedupe_key,
    deliver_after: row.deliver_after,
    detail: row.detail,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
  };
}
