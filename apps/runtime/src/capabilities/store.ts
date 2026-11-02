import { join } from "node:path";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { ensureCapabilityTables } from "./migrations.ts";

/**
 * 能力注册表存储（票 M2-T1 / Issue #22）：capabilities / capability_versions /
 * capability_grants 三表的纯持久化层——不含权限判定与审计事件（那些是 PermissionEngine
 * 的职责）。行是权威状态，capability.* 账本事件是审计投影（行先于事件落库，
 * 同 MemoryService 口径）。
 */

/** capabilities 表行（manifest 列为 canonical JSON 全文，含 source_hash） */
export interface CapabilityRow {
  name: string;
  version: string;
  author: string;
  runtime: string;
  status: string;
  /** 已验证标记（0/1；GLOSSARY「已验证」——投影层转 boolean） */
  verified: number;
  source_hash: string;
  manifest: string;
  created_at: string;
  updated_at: string;
}

/** capability_versions 表行（(name, version) 不可变；rollback 依据） */
export interface CapabilityVersionRow {
  name: string;
  version: string;
  author: string;
  verified: number;
  source_hash: string;
  manifest: string;
  created_at: string;
}

export interface CapabilityListFilter {
  status?: string;
  author?: string;
  runtime?: string;
}

// --- 共享字段束（Data Clumps 收敛，#22 修复批）---------------------------------
//
// 「manifest 字段串」（name/version/author/runtime/verified/source_hash/manifest）在
// 新注册、登记新版本、回滚三处成组搬运——抽成单一接口 + 绑定 helper，三个写入入口
// 与 SELECT 列清单共享同一真相源，加列时不再三处同步改。

/** 三处写入共用的 manifest 字段束（能力身份 + 内容哈希 + manifest 全文 + verified） */
export interface CapabilityManifestFields {
  name: string;
  version: string;
  author: string;
  runtime: string;
  verified: number;
  source_hash: string;
  manifest: string;
}

/** 新注册写入（能力行 + 版本行同事务）；name 已存在时由调用方先判定，此处兜底抛错 */
export interface NewCapabilityInput extends CapabilityManifestFields {
  status: string;
  created_at: string;
  updated_at: string;
}

/** 既有能力登记新版本（版本行追加 + 当前指针前移，同事务；status 不变） */
export interface NewVersionInput extends CapabilityManifestFields {
  updated_at: string;
}

/** 回滚（当前指针指回历史版本行；字段束随目标版本行原样搬运） */
export interface RollbackInput extends CapabilityManifestFields {
  updated_at: string;
}

/** 当前表 SELECT 列清单（全部 list/get 语句共用；顺序 = CapabilityRow 字段序） */
const CAPABILITY_ROW_COLUMNS =
  "name, version, author, runtime, status, verified, source_hash, manifest, created_at, updated_at";

/** 版本表 SELECT 列清单（顺序 = CapabilityVersionRow 字段序） */
const VERSION_ROW_COLUMNS =
  "name, version, author, verified, source_hash, manifest, created_at";

/** 身份半边 → 位置参数（当前表 name/version/author/runtime 四元组，INSERT 用） */
function identityParams(input: CapabilityManifestFields): [string, string, string, string] {
  return [input.name, input.version, input.author, input.runtime];
}

/** 当前指针前移/回滚的绑定（UPDATE 无 name 列：version/author/runtime + 内容束 + updated_at + WHERE name） */
function currentUpdateParams(
  input: CapabilityManifestFields & { updated_at: string },
): [string, string, string, number, string, string, string, string] {
  return [input.version, input.author, input.runtime, ...contentParams(input), input.updated_at, input.name];
}

/** 内容半边 → 位置参数（verified/source_hash/manifest——三处写入共享的内容束） */
function contentParams(input: CapabilityManifestFields): [number, string, string] {
  return [input.verified, input.source_hash, input.manifest];
}

export class CapabilityStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertCapabilityStmt;
  #insertVersionStmt;
  #updateCurrentStmt;
  #getStmt;
  #listAllStmt;
  #listByStatusStmt;
  #listByAuthorStmt;
  #listByRuntimeStmt;
  #setStatusStmt;
  #versionsStmt;
  #versionStmt;
  #getGrantsStmt;
  #setGrantsStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    ensureCapabilityTables(db);
    this.#insertCapabilityStmt = db.prepare(
      `INSERT INTO capabilities (name, version, author, runtime, status, verified, source_hash, manifest, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#insertVersionStmt = db.prepare(
      `INSERT INTO capability_versions (name, version, author, verified, source_hash, manifest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#updateCurrentStmt = db.prepare(
      `UPDATE capabilities
       SET version = ?, author = ?, runtime = ?, verified = ?, source_hash = ?, manifest = ?, updated_at = ?
       WHERE name = ?`,
    );
    this.#getStmt = db.prepare(
      `SELECT ${CAPABILITY_ROW_COLUMNS} FROM capabilities WHERE name = ?`,
    );
    this.#listAllStmt = db.prepare(
      `SELECT ${CAPABILITY_ROW_COLUMNS} FROM capabilities ORDER BY created_at, name`,
    );
    this.#listByStatusStmt = db.prepare(
      `SELECT ${CAPABILITY_ROW_COLUMNS} FROM capabilities WHERE status = ? ORDER BY created_at, name`,
    );
    this.#listByAuthorStmt = db.prepare(
      `SELECT ${CAPABILITY_ROW_COLUMNS} FROM capabilities WHERE author = ? ORDER BY created_at, name`,
    );
    this.#listByRuntimeStmt = db.prepare(
      `SELECT ${CAPABILITY_ROW_COLUMNS} FROM capabilities WHERE runtime = ? ORDER BY created_at, name`,
    );
    this.#setStatusStmt = db.prepare("UPDATE capabilities SET status = ?, updated_at = ? WHERE name = ?");
    this.#versionsStmt = db.prepare(
      `SELECT ${VERSION_ROW_COLUMNS} FROM capability_versions WHERE name = ? ORDER BY created_at, version`,
    );
    this.#versionStmt = db.prepare(
      `SELECT ${VERSION_ROW_COLUMNS} FROM capability_versions WHERE name = ? AND version = ?`,
    );
    this.#getGrantsStmt = db.prepare("SELECT grants, updated_at FROM capability_grants WHERE id = 1");
    this.#setGrantsStmt = db.prepare(
      "INSERT INTO capability_grants (id, grants, updated_at) VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET grants = excluded.grants, updated_at = excluded.updated_at",
    );
  }

  /** 打开（必要时创建）数据目录下与账本同库的能力表 */
  static open(dataDir: string): CapabilityStore {
    return new CapabilityStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  /** 注册（首见）：能力行 + 版本行同事务落库 */
  insertNew(input: NewCapabilityInput): void {
    this.#assertOpen();
    this.#tx(() => {
      this.#insertCapabilityStmt.run(
        ...identityParams(input),
        input.status,
        ...contentParams(input),
        input.created_at,
        input.updated_at,
      );
      this.#insertVersionStmt.run(
        input.name,
        input.version,
        input.author,
        ...contentParams(input),
        input.created_at,
      );
    });
  }

  /** 既有能力登记新版本：版本行追加 + 当前指针前移（同事务；status 保持不变） */
  appendVersion(input: NewVersionInput): void {
    this.#assertOpen();
    this.#tx(() => {
      this.#insertVersionStmt.run(
        input.name,
        input.version,
        input.author,
        ...contentParams(input),
        input.updated_at,
      );
      this.#updateCurrentStmt.run(...currentUpdateParams(input));
    });
  }

  /** 回滚：当前指针指回历史版本（版本行不增不改——历史不可变） */
  rollbackTo(input: RollbackInput): void {
    this.#assertOpen();
    this.#updateCurrentStmt.run(...currentUpdateParams(input));
  }

  get(name: string): CapabilityRow | null {
    this.#assertOpen();
    const row = this.#getStmt.get(name) as unknown as CapabilityRow | undefined;
    return row ?? null;
  }

  list(filter: CapabilityListFilter = {}): CapabilityRow[] {
    this.#assertOpen();
    if (filter.status !== undefined) {
      return this.#listByStatusStmt.all(filter.status) as unknown as CapabilityRow[];
    }
    if (filter.author !== undefined) {
      return this.#listByAuthorStmt.all(filter.author) as unknown as CapabilityRow[];
    }
    if (filter.runtime !== undefined) {
      return this.#listByRuntimeStmt.all(filter.runtime) as unknown as CapabilityRow[];
    }
    return this.#listAllStmt.all() as unknown as CapabilityRow[];
  }

  setStatus(name: string, status: string, updatedAt: string): void {
    this.#assertOpen();
    this.#setStatusStmt.run(status, updatedAt, name);
  }

  /** 版本历史（created_at 升序——注册顺序） */
  versions(name: string): CapabilityVersionRow[] {
    this.#assertOpen();
    return this.#versionsStmt.all(name) as unknown as CapabilityVersionRow[];
  }

  getVersion(name: string, version: string): CapabilityVersionRow | null {
    this.#assertOpen();
    const row = this.#versionStmt.get(name, version) as unknown as CapabilityVersionRow | undefined;
    return row ?? null;
  }

  /** 当前授权（未设置过返回 null——引擎给全空默认） */
  getGrants(): { grants: string; updated_at: string } | null {
    this.#assertOpen();
    const row = this.#getGrantsStmt.get() as unknown as { grants: string; updated_at: string } | undefined;
    return row ?? null;
  }

  setGrants(grantsJson: string, updatedAt: string): void {
    this.#assertOpen();
    this.#setGrantsStmt.run(grantsJson, updatedAt);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("capability store is closed");
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
