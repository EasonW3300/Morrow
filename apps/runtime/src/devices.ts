import { join } from "node:path";
import { DB_FILE_NAME } from "./ledger.ts";
import { openSqlite, type SqliteDatabase } from "./db.ts";

/**
 * Device 记录（票 #3 规格项「Owner 身份、Device 记录、事件上的 actor_id」的 M0 最小实现）。
 *
 * M0 只做**只读登记**：本副本（replica_id）启动时 upsert 进 devices 表（既有 replica-id
 * 文件经 RuntimeConfig.replicaId 种子），`GET /v1/devices` 可读。**不做配对/撤销/多设备**——
 * 那是 M3 同步里程碑的范围（PRD §5.2 配对协议、AC-04/05）；本表届时扩为设备注册表
 * （设备密钥、指纹、撤销状态）。
 *
 * 存储与事件账本同库（events.sqlite，WAL）：devices 表可变（last_seen_at 随启动刷新），
 * 与 events 表的 append-only 互不影响（触发器只锁 events）。与账本共用 openSqlite 的
 * PRAGMA（WAL / busy_timeout / FULL sync）。
 */

/** 设备记录（GET /v1/devices 载荷元素；label 为人工可读名，M0 未命名机制，恒 null） */export interface DeviceRecord {
  replica_id: string;
  label: string | null;
  created_at: string;
  last_seen_at: string;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  replica_id   TEXT PRIMARY KEY,
  label        TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
`;

export class DeviceRegistry {
  readonly #db: SqliteDatabase;
  #closed = false;

  #upsertStmt;
  #listStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);
    this.#upsertStmt = db.prepare(
      `INSERT INTO devices (replica_id, label, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(replica_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    );
    this.#listStmt = db.prepare(
      "SELECT replica_id, label, created_at, last_seen_at FROM devices ORDER BY created_at, replica_id",
    );
  }

  /** 打开（必要时创建）数据目录下与账本同库的 Device 记录 */
  static open(dataDir: string): DeviceRegistry {
    return new DeviceRegistry(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  /**
   * 启动种子：本副本 upsert 一条记录。首见插入（created_at = now）；
   * 已存在则仅刷新 last_seen_at（created_at 保持首见时间——设备年龄可考）。
   */
  touch(replicaId: string, now: Date = new Date()): void {
    const iso = now.toISOString();
    this.#upsertStmt.run(replicaId, null, iso, iso);
  }

  list(): DeviceRecord[] {
    return this.#listStmt.all() as unknown as DeviceRecord[];
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
