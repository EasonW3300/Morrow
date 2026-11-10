import { join } from "node:path";
import type { DeviceInfo } from "@morrow/protocol";
import { DB_FILE_NAME } from "./ledger.ts";
import { openSqlite, type SqliteDatabase } from "./db.ts";
import { formatFingerprint } from "./pairing/crypto.ts";

/**
 * Device 记录与设备注册表（M0 最小实现 → M3-T2 / Issue #31 设备身份扩展）。
 *
 * 存储与事件账本同库（events.sqlite，WAL）：devices 表可变（last_seen_at / 配对 /
 * 撤销状态），与 events 表的 append-only 互不影响（触发器只锁 events）。
 *
 * M3-T2 增列（幂等迁移，旧 M0 库 ALTER 追加、不重写既有行）：
 *   public_key     ed25519 公钥 raw 32B base64（公开信息，可出现在 API 响应）
 *   fingerprint    公钥 SHA-256 前 16 hex（设备身份，供双端人工核对）
 *   trusted        是否已建立信任（本机自注册 = 1；旧 M0 行迁移后 = 1）
 *   revoked        是否已撤销（撤销后鉴权一律拒绝；不物理删行，保留审计）
 *   paired_at      首次配对成功时间（本机自注册为 null）
 *   last_sync_at   最近一次成功同步时间（M3-T3 同步引擎写入；本票前恒 null）
 *   revoked_at     撤销时间
 *   token_hash     bearer token 的 SHA-256（ADR-0008；绝不存明文 token；撤销后保留为
 *                  吊销墓碑，使该设备请求明确返回 403 而非 401）
 *
 * 不变式：`token_hash`/任何私钥材料绝不进入 DeviceInfo 投影（toDeviceInfo 白名单构造）。
 */

/** GET /v1/devices 载荷元素（协议类型 DeviceInfo 的 runtime 别名，保持既有 import 面） */
export type DeviceRecord = DeviceInfo;

interface DeviceRow {
  replica_id: string;
  label: string | null;
  created_at: string;
  last_seen_at: string;
  public_key: string | null;
  fingerprint: string | null;
  trusted: number;
  revoked: number;
  paired_at: string | null;
  last_sync_at: string | null;
  revoked_at: string | null;
  token_hash: string | null;
  base_url: string | null;
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  replica_id   TEXT PRIMARY KEY,
  label        TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  public_key   TEXT,
  fingerprint  TEXT,
  trusted      INTEGER NOT NULL DEFAULT 0,
  revoked      INTEGER NOT NULL DEFAULT 0,
  paired_at    TEXT,
  last_sync_at TEXT,
  revoked_at   TEXT,
  token_hash   TEXT,
  base_url     TEXT
);
`;

/**
 * M0 旧库迁移：逐列 ALTER（幂等）。trusted 默认 1——M0 表里唯一可能的行就是本机
 * 自注册副本（M3 前无多设备注册路径），迁过来自然是可信本机。
 */
const MIGRATION_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "public_key", ddl: "ALTER TABLE devices ADD COLUMN public_key TEXT" },
  { name: "fingerprint", ddl: "ALTER TABLE devices ADD COLUMN fingerprint TEXT" },
  { name: "trusted", ddl: "ALTER TABLE devices ADD COLUMN trusted INTEGER NOT NULL DEFAULT 1" },
  { name: "revoked", ddl: "ALTER TABLE devices ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0" },
  { name: "paired_at", ddl: "ALTER TABLE devices ADD COLUMN paired_at TEXT" },
  { name: "last_sync_at", ddl: "ALTER TABLE devices ADD COLUMN last_sync_at TEXT" },
  { name: "revoked_at", ddl: "ALTER TABLE devices ADD COLUMN revoked_at TEXT" },
  { name: "token_hash", ddl: "ALTER TABLE devices ADD COLUMN token_hash TEXT" },
  { name: "base_url", ddl: "ALTER TABLE devices ADD COLUMN base_url TEXT" },
];

const SELECT_COLUMNS =
  "replica_id, label, created_at, last_seen_at, public_key, fingerprint, trusted, revoked, paired_at, last_sync_at, revoked_at, base_url";

export interface MarkPairedInput {
  replicaId: string;
  label: string | null;
  publicKey: string;
  fingerprint: string;
  tokenHash: string;
  /** 对端自身的 HTTP 基地址（M3 同步接线修复 / Issue #34）；浏览器 claim 可为空 */
  baseUrl?: string | null;
  now: Date;
}

export class DeviceRegistry {
  readonly #db: SqliteDatabase;
  #closed = false;

  #upsertStmt;
  #listStmt;
  #getStmt;
  #getWithTokenStmt;
  #setIdentityStmt;
  #markPairedStmt;
  #markJoinedPeerStmt;
  #markSyncedStmt;
  #revokeStmt;
  #touchStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);
    const columns = db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
    const present = new Set(columns.map((c) => c.name));
    for (const column of MIGRATION_COLUMNS) {
      if (!present.has(column.name)) db.exec(column.ddl);
    }
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS devices_token_hash_idx ON devices (token_hash) WHERE token_hash IS NOT NULL",
    );

    this.#upsertStmt = db.prepare(
      `INSERT INTO devices (replica_id, label, created_at, last_seen_at, trusted)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(replica_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    );
    this.#listStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM devices ORDER BY created_at, replica_id`,
    );
    this.#getStmt = db.prepare(`SELECT ${SELECT_COLUMNS} FROM devices WHERE replica_id = ?`);
    this.#getWithTokenStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}, token_hash FROM devices WHERE token_hash = ?`,
    );
    this.#setIdentityStmt = db.prepare(
      `INSERT INTO devices (replica_id, label, created_at, last_seen_at, public_key, fingerprint, trusted)
       VALUES (?, NULL, ?, ?, ?, ?, 1)
       ON CONFLICT(replica_id) DO UPDATE SET
         public_key = excluded.public_key,
         fingerprint = excluded.fingerprint,
         trusted = 1`,
    );
    this.#markPairedStmt = db.prepare(
      `INSERT INTO devices
         (replica_id, label, created_at, last_seen_at, public_key, fingerprint, trusted, revoked, paired_at, revoked_at, token_hash, base_url)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, NULL, ?, ?)
       ON CONFLICT(replica_id) DO UPDATE SET
         label = excluded.label,
         last_seen_at = excluded.last_seen_at,
         public_key = excluded.public_key,
         fingerprint = excluded.fingerprint,
         trusted = 1,
         revoked = 0,
         paired_at = excluded.paired_at,
         revoked_at = NULL,
         token_hash = excluded.token_hash,
         base_url = COALESCE(excluded.base_url, devices.base_url)`,
    );
    this.#markJoinedPeerStmt = db.prepare(
      `INSERT INTO devices
         (replica_id, label, created_at, last_seen_at, public_key, fingerprint, trusted, revoked, paired_at, revoked_at, token_hash, base_url)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, NULL, NULL, ?)
       ON CONFLICT(replica_id) DO UPDATE SET
         label = excluded.label,
         last_seen_at = excluded.last_seen_at,
         public_key = excluded.public_key,
         fingerprint = excluded.fingerprint,
         trusted = 1,
         revoked = 0,
         paired_at = excluded.paired_at,
         revoked_at = NULL,
         base_url = COALESCE(excluded.base_url, devices.base_url)`,
    );
    this.#markSyncedStmt = db.prepare("UPDATE devices SET last_sync_at = ? WHERE replica_id = ?");
    this.#revokeStmt = db.prepare(
      "UPDATE devices SET revoked = 1, revoked_at = ? WHERE replica_id = ?",
    );
    this.#touchStmt = db.prepare("UPDATE devices SET last_seen_at = ? WHERE replica_id = ?");
  }

  /** 打开（必要时创建）数据目录下与账本同库的 Device 记录 */
  static open(dataDir: string): DeviceRegistry {
    return new DeviceRegistry(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  /**
   * 启动种子：本副本 upsert 一条可信记录。首见插入（created_at = now）；
   * 已存在则仅刷新 last_seen_at（created_at 保持首见时间——设备年龄可考）。
   */
  touch(replicaId: string, now: Date = new Date()): void {
    const iso = now.toISOString();
    this.#upsertStmt.run(replicaId, null, iso, iso);
  }

  list(): DeviceRecord[] {
    return (this.#listStmt.all() as unknown as DeviceRow[]).map(toDeviceInfo);
  }

  /** 单设备投影；不存在返回 null */
  get(replicaId: string): DeviceRecord | null {
    const row = this.#getStmt.get(replicaId) as DeviceRow | undefined;
    return row === undefined ? null : toDeviceInfo(row);
  }

  /** 本机身份公钥落库（配对首次需要时由 DeviceIdentity 调用；幂等覆盖） */
  setIdentity(replicaId: string, publicKey: string, fingerprint: string, now: Date = new Date()): void {
    const iso = now.toISOString();
    this.#setIdentityStmt.run(replicaId, iso, iso, publicKey, fingerprint);
  }

  /** 配对成功：写入公钥/指纹/标签/令牌摘要，置 trusted=1、revoked=0（重新配对可复活？不——见下） */
  markPaired(input: MarkPairedInput): void {
    const iso = input.now.toISOString();
    this.#markPairedStmt.run(
      input.replicaId,
      input.label,
      iso,
      iso,
      input.publicKey,
      input.fingerprint,
      iso,
      input.tokenHash,
      input.baseUrl ?? null,
    );
  }

  /**
   * 本机作为新设备加入对端 Runtime 后（M3 修复批 / Issue #35，POST /v1/pairing/join）：
   * 把对端（服务端）记为本机 devices 中的可信远端设备。token 不落本表——只存本机
   * OS 凭据库（见 PairingService.join），本表只保存公开身份。
   */
  markJoinedPeer(input: {
    replicaId: string;
    label: string | null;
    publicKey: string;
    fingerprint: string;
    /** 对端的 HTTP 基地址（join 的 base_url）——服务端也要能反向出站同步 */
    baseUrl?: string | null;
    now: Date;
  }): void {
    const iso = input.now.toISOString();
    this.#markJoinedPeerStmt.run(
      input.replicaId,
      input.label,
      iso,
      iso,
      input.publicKey,
      input.fingerprint,
      iso,
      input.baseUrl ?? null,
    );
  }

  /**
   * 对端 HTTP 基地址（M3 同步接线修复 / Issue #34）：设备投影（DeviceInfo）不暴露该
   * 内部字段，同步传输按需查询。不存在/未记录返回 null。
   */
  baseUrl(replicaId: string): string | null {
    const row = this.#getStmt.get(replicaId) as DeviceRow | undefined;
    return row?.base_url ?? null;
  }

  /**
   * 同步成功：写 last_sync_at（M3 修复批 / Issue #35）。只更新已存在的设备行——
   * 不认识的 peer 不因一次同步而凭空出现在设备列表。返回是否命中一行。
   */
  markSynced(replicaId: string, now: Date = new Date()): boolean {
    const result = this.#markSyncedStmt.run(now.toISOString(), replicaId);
    return Number(result.changes) > 0;
  }

  /**
   * 撤销：置 revoked=1 并记录时间（幂等，重复撤销保留首次 revoked_at）。
   * token_hash 保留作为「吊销墓碑」：该设备的后续请求能明确返回 403 device_revoked
   * 而不是退化成 401 invalid_token；摘要本身不构成访问权（鉴权必查 revoked）。
   * 返回是否由本次调用生效（false = 已是撤销态或不存在）。
   */
  revoke(replicaId: string, now: Date = new Date()): boolean {
    const existing = this.get(replicaId);
    if (existing === null) return false;
    if (existing.revoked) return false;
    this.#revokeStmt.run(now.toISOString(), replicaId);
    return true;
  }

  /** 已认证请求刷新 last_seen_at（节流由调用方决定；本方法逐次写） */
  touchDevice(replicaId: string, now: Date = new Date()): void {
    this.#touchStmt.run(now.toISOString(), replicaId);
  }

  /** bearer token 摘要 → 设备行（含 revoked/trusted/token_hash，仅供鉴权内部）；未命中 null */
  findByTokenHash(tokenHash: string): { device: DeviceRecord; tokenHash: string } | null {
    const row = this.#getWithTokenStmt.get(tokenHash) as DeviceRow | undefined;
    if (row === undefined) return null;
    return { device: toDeviceInfo(row), tokenHash: row.token_hash ?? tokenHash };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

/**
 * 行 → API 投影（白名单）：token_hash 与未来任何内部列都不会流出。
 * 指纹短格式由指纹派生；无指纹（未配对的本机）时为 null。
 */
function toDeviceInfo(row: DeviceRow): DeviceRecord {
  return {
    replica_id: row.replica_id,
    label: row.label,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    public_key: row.public_key,
    fingerprint: row.fingerprint,
    fingerprint_short: row.fingerprint === null ? null : formatFingerprint(row.fingerprint),
    trusted: row.trusted === 1,
    revoked: row.revoked === 1,
    paired_at: row.paired_at,
    last_sync_at: row.last_sync_at,
    revoked_at: row.revoked_at,
  };
}
