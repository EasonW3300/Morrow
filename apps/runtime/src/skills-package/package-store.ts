/**
 * Skill 包安装的持久化与 HTTP 面（票 M7-B-T3 / Issue #68 的交付缺口补齐，FR-B7/B10）。
 *
 * B3 原本只交付了库层（`installSkillPackage` / `diffPermissions`），没有 HTTP 端点、
 * 没有"已安装"记录、没有 UI——FR-B7「npm 源安装」与 FR-B10「升级展示 diff、卸载保留
 * 审计」因此无法验收。本模块补上这三件事的表与路由。
 *
 * 表（与账本同库）：
 *   skill_packages      已安装技能包：spec/version/哈希/包目录/能力名/状态
 *
 * 设计要点：
 *   - **卸载 = 删行 + 禁用能力**（不删审计；账本里的 skill_package.* 事件永久保留）；
 *   - **升级必须先看 diff**：`POST .../upgrade` 在 `widens=true` 且调用方未带
 *     `accept_permission_widening=true` 时**拒绝**——这是决策 #14 的硬要求，
 *     不能让一次升级悄悄扩权；
 *   - 安装/升级/卸载都写审计事件（含完整 spec 与哈希，事后可验"当时装了什么"）。
 */

import { join } from "node:path";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS skill_packages (
  package_name   TEXT PRIMARY KEY,
  spec           TEXT NOT NULL,
  version        TEXT NOT NULL,
  source_hash    TEXT NOT NULL,
  package_dir    TEXT NOT NULL,
  capability     TEXT NOT NULL,
  has_entry      INTEGER NOT NULL DEFAULT 0,
  permissions_json TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'installed',
  installed_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
`;

/** 已安装技能包记录 */
export interface SkillPackageRecord {
  package_name: string;
  /** 安装时使用的 npm spec（含版本；升级会更新） */
  spec: string;
  version: string;
  /** 服务端重算的完整性哈希（`sha256-...`） */
  source_hash: string;
  /** 包目录（卸载时删这棵树） */
  package_dir: string;
  /** 注册的能力名 */
  capability: string;
  /** 是否含可执行入口（含 entry 的包必须已声明 sandbox + tests） */
  has_entry: boolean;
  /** 声明式权限（升级 diff 的对照基准） */
  permissions: Record<string, string[]>;
  status: "installed" | "disabled";
  installed_at: string;
  updated_at: string;
}

interface SkillPackageRow {
  package_name: string;
  spec: string;
  version: string;
  source_hash: string;
  package_dir: string;
  capability: string;
  has_entry: number;
  permissions_json: string;
  status: string;
  installed_at: string;
  updated_at: string;
}

function projectPackage(row: SkillPackageRow): SkillPackageRecord {
  return {
    package_name: row.package_name,
    spec: row.spec,
    version: row.version,
    source_hash: row.source_hash,
    package_dir: row.package_dir,
    capability: row.capability,
    has_entry: row.has_entry === 1,
    permissions: JSON.parse(row.permissions_json) as Record<string, string[]>,
    status: row.status === "disabled" ? "disabled" : "installed",
    installed_at: row.installed_at,
    updated_at: row.updated_at,
  };
}

export class SkillPackageStore {
  readonly #db: SqliteDatabase;
  readonly #ownsConnection: boolean;

  constructor(options: { dataDir?: string; db?: SqliteDatabase } = {}) {
    if (options.db !== undefined) {
      this.#db = options.db;
      this.#ownsConnection = false;
    } else {
      if (options.dataDir === undefined) throw new Error("SkillPackageStore requires dataDir or db");
      this.#db = openSqlite(join(options.dataDir, DB_FILE_NAME));
      this.#ownsConnection = true;
    }
    this.#db.exec(CREATE_SQL);
  }

  list(): SkillPackageRecord[] {
    return (this.#db.prepare("SELECT * FROM skill_packages ORDER BY installed_at, package_name").all() as SkillPackageRow[]).map(
      projectPackage,
    );
  }

  get(packageName: string): SkillPackageRecord | null {
    const row = this.#db.prepare("SELECT * FROM skill_packages WHERE package_name = ?").get(packageName) as
      | SkillPackageRow
      | undefined;
    return row === undefined ? null : projectPackage(row);
  }

  upsert(record: SkillPackageRecord): void {
    this.#db
      .prepare(
        `INSERT INTO skill_packages (
          package_name, spec, version, source_hash, package_dir, capability, has_entry,
          permissions_json, status, installed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(package_name) DO UPDATE SET
          spec = excluded.spec,
          version = excluded.version,
          source_hash = excluded.source_hash,
          package_dir = excluded.package_dir,
          capability = excluded.capability,
          has_entry = excluded.has_entry,
          permissions_json = excluded.permissions_json,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        record.package_name,
        record.spec,
        record.version,
        record.source_hash,
        record.package_dir,
        record.capability,
        record.has_entry ? 1 : 0,
        JSON.stringify(record.permissions),
        record.status,
        record.installed_at,
        record.updated_at,
      );
  }

  setStatus(packageName: string, status: SkillPackageRecord["status"], now: string): void {
    this.#db.prepare("UPDATE skill_packages SET status = ?, updated_at = ? WHERE package_name = ?").run(status, now, packageName);
  }

  delete(packageName: string): boolean {
    const existing = this.get(packageName);
    if (existing === null) return false;
    this.#db.prepare("DELETE FROM skill_packages WHERE package_name = ?").run(packageName);
    return true;
  }

  close(): void {
    if (this.#ownsConnection) this.#db.close();
  }
}
