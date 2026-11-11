import { join } from "node:path";
import type { EventEnvelope } from "@morrow/protocol";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { DB_FILE_NAME, type EventLedger } from "../ledger.ts";
import { ensureSyncTables } from "./migrations.ts";

/**
 * 删除集合（票 M3-T3 / Issue #32；PRD §4.2「删除传播」/ §4.1 FR-MEM-8 / FR-DEP-5）。
 *
 * 同步只传事件，因此「删了就不再出现」必须有两个层次：
 *   1. fact tombstone（kind=fact）：memory.fact_deleted 一旦被观察到（本机删除或从
 *      peer 导入），该 fact_id 进入删除集合；导入路径看到同一 fact 的 fact_created /
 *      fact_updated / 第二条 fact_deleted 一律跳过——离线副本携带的旧版本不能复活它。
 *   2. event tombstone（kind=event）：删除发生时，把本副本账本里属于该事实的
 *      fact_created / fact_updated / fact_deleted 事件 id 一并记入删除集合。即使对端
 *      以「新事件 id」重放同一事实的修订，也会在 event_id 层被拦下。
 *
 * 命中不静默：同步引擎为每一次跳过落 sync.tombstone_skipped 审计事件（含 peer、
 * 事件类型、命中的 fact_id/event_id 与原因）。删除集合本身是与账本同库的可变表，
 * 不参与同步（它是本副本的判定状态，可由账本中的 memory.fact_deleted 重建）。
 */

export interface TombstoneRow {
  kind: "event" | "fact";
  target_id: string;
  replica_id: string | null;
  version: number | null;
  deleted_at: string;
}

export type TombstoneHit =
  | { skip: false }
  | { skip: true; reason: "deleted_event" | "deleted_fact"; fact_id?: string };

const FACT_EVENT_TYPES = new Set(["memory.fact_created", "memory.fact_updated", "memory.fact_deleted"]);

export class TombstoneStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertStmt;
  #getStmt;
  #listStmt;
  #listByKindStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureSyncTables(db);
    this.#insertStmt = db.prepare(
      `INSERT INTO sync_tombstones (kind, target_id, replica_id, version, deleted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, target_id) DO UPDATE SET
         replica_id = excluded.replica_id,
         version = COALESCE(excluded.version, sync_tombstones.version),
         deleted_at = excluded.deleted_at`,
    );
    this.#getStmt = db.prepare(
      "SELECT kind, target_id, replica_id, version, deleted_at FROM sync_tombstones WHERE kind = ? AND target_id = ?",
    );
    this.#listStmt = db.prepare(
      "SELECT kind, target_id, replica_id, version, deleted_at FROM sync_tombstones ORDER BY kind, target_id",
    );
    this.#listByKindStmt = db.prepare(
      "SELECT kind, target_id, replica_id, version, deleted_at FROM sync_tombstones WHERE kind = ? ORDER BY target_id",
    );
  }

  /** 打开（必要时创建）与账本同库的删除集合 */
  static open(dataDir: string): TombstoneStore {
    return new TombstoneStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  /** 事实是否已被删除（tombstone） */
  isFactDeleted(factId: string): boolean {
    this.#assertOpen();
    return this.#getStmt.get("fact", factId) !== undefined;
  }

  /** 事件是否已进入删除集合 */
  isEventDeleted(eventId: string): boolean {
    this.#assertOpen();
    return this.#getStmt.get("event", eventId) !== undefined;
  }

  getFact(factId: string): TombstoneRow | null {
    this.#assertOpen();
    const row = this.#getStmt.get("fact", factId) as unknown as TombstoneRow | undefined;
    return row ?? null;
  }

  list(kind?: "event" | "fact"): TombstoneRow[] {
    this.#assertOpen();
    return (
      kind === undefined ? this.#listStmt.all() : this.#listByKindStmt.all(kind)
    ) as unknown as TombstoneRow[];
  }

  /**
   * 导入路径的跳过判定：先看事件级删除集合（更精确），再看事实级 tombstone。
   * 只有事实修订事件受事实级约束——普通会话/审计事件不因某条事实删除而被吞掉。
   */
  shouldSkip(envelope: EventEnvelope): TombstoneHit {
    if (this.isEventDeleted(envelope.event_id)) {
      return { skip: true, reason: "deleted_event" };
    }
    if (!FACT_EVENT_TYPES.has(envelope.event_type)) return { skip: false };
    const factId = typeof envelope.payload.fact_id === "string" ? envelope.payload.fact_id : null;
    if (factId === null) return { skip: false };
    if (this.isFactDeleted(factId)) {
      return { skip: true, reason: "deleted_fact", fact_id: factId };
    }
    return { skip: false };
  }

  /**
   * 观察一条 memory.fact_deleted：记录 fact tombstone + 本副本账本里属于该事实的事件 id。
   * 幂等（同一删除事件重复调用无副作用）。返回本次涉及的删除集合条目数。
   */
  recordFactDeletion(envelope: EventEnvelope, ledger: EventLedger): { fact_id: string; deleted_event_ids: string[] } {
    this.#assertOpen();
    if (envelope.event_type !== "memory.fact_deleted") {
      throw new Error(`not a fact deletion event: ${envelope.event_type}`);
    }
    const factId = envelope.payload.fact_id;
    if (typeof factId !== "string" || factId.length === 0) {
      throw new Error("memory.fact_deleted payload is missing fact_id");
    }
    const deletedAt =
      typeof envelope.payload.deleted_at === "string" ? envelope.payload.deleted_at : envelope.occurred_at;
    const version = typeof envelope.payload.version === "number" ? envelope.payload.version : null;
    this.#insertStmt.run("fact", factId, envelope.replica_id, version, deletedAt);

    const deletedEventIds: string[] = [];
    for (const entry of ledger.scan()) {
      if (!FACT_EVENT_TYPES.has(entry.envelope.event_type)) continue;
      if (entry.envelope.payload.fact_id !== factId) continue;
      const eventId = entry.envelope.event_id;
      this.#insertStmt.run("event", eventId, envelope.replica_id, null, deletedAt);
      deletedEventIds.push(eventId);
    }
    return { fact_id: factId, deleted_event_ids: deletedEventIds };
  }

  /**
   * 从账本重建删除集合（启动时调用；一次扫描建 fact→event ids 索引，避免逐条重扫）。
   * 幂等：已有条目只更新 deleted_at/version。
   */
  reconcileFromLedger(ledger: EventLedger): number {
    this.#assertOpen();
    const byFact = new Map<string, string[]>();
    const deletions: EventEnvelope[] = [];
    for (const entry of ledger.scan()) {
      const envelope = entry.envelope;
      if (!FACT_EVENT_TYPES.has(envelope.event_type)) continue;
      const factId = envelope.payload.fact_id;
      if (typeof factId !== "string" || factId.length === 0) continue;
      const list = byFact.get(factId) ?? [];
      list.push(envelope.event_id);
      byFact.set(factId, list);
      if (envelope.event_type === "memory.fact_deleted") deletions.push(envelope);
    }
    for (const envelope of deletions) {
      const factId = envelope.payload.fact_id as string;
      const deletedAt =
        typeof envelope.payload.deleted_at === "string" ? envelope.payload.deleted_at : envelope.occurred_at;
      const version = typeof envelope.payload.version === "number" ? envelope.payload.version : null;
      this.#insertStmt.run("fact", factId, envelope.replica_id, version, deletedAt);
      for (const eventId of byFact.get(factId) ?? []) {
        this.#insertStmt.run("event", eventId, envelope.replica_id, null, deletedAt);
      }
    }
    return deletions.length;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("tombstone store is closed");
  }
}
