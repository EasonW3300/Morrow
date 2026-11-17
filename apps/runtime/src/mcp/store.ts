/**
 * MCP Server 配置存储（票 M7-B-T2 / Issue #71，FR-B1..B6）。
 *
 * 与任务/渠道投影同库（events.sqlite，独立连接，WAL）：配置本体是**可变投影**
 * （Owner 会改、会删），审计历史仍在 append-only 账本（`mcp.server_installed` 等）。
 *
 * 表：
 *   mcp_servers       一台 server 一行：来源、启动命令（JSON argv）、状态、协议版本、
 *                     降级原因、安装时的风险确认记录
 *   mcp_server_grants 该 server 的工具默认五维权限（**默认全空**：装了不等于授权）
 *
 * 为什么把 argv 存成 JSON 而不是拼接后的字符串：安装时展示给 Owner 的是**完整
 * 未截断命令**，运行时执行的也必须是同一串 argv。存拼接串会在含空格/引号的参数上
 * 产生"展示的和执行的不是一回事"——那正是供应链攻击最喜欢的缝。
 */

import { join } from "node:path";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  server_id          TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  source             TEXT NOT NULL,
  command            TEXT NOT NULL,
  args_json          TEXT NOT NULL DEFAULT '[]',
  env_keys_json      TEXT NOT NULL DEFAULT '[]',
  cwd                TEXT,
  enabled            INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'disabled',
  protocol_version   TEXT,
  generation         TEXT,
  server_name        TEXT,
  server_version     TEXT,
  last_error         TEXT,
  risk_acknowledged  INTEGER NOT NULL DEFAULT 0,
  risk_ack_text      TEXT,
  installed_by       TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_server_grants (
  server_id     TEXT PRIMARY KEY,
  filesystem    TEXT NOT NULL DEFAULT '[]',
  network       TEXT NOT NULL DEFAULT '[]',
  shell         TEXT NOT NULL DEFAULT '[]',
  channels      TEXT NOT NULL DEFAULT '[]',
  credentials   TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL
);
`;

/** server 来源（「已安装」页要能一眼看出"这玩意儿从哪来的"） */
export type McpServerSource = "manual" | "template" | "document" | "npm" | "builtin";

/** 生命周期状态（disabled 是安装后的默认态） */
export type McpServerStatus = "disabled" | "running" | "degraded" | "error";

/** 一台 MCP server 的完整记录 */
export interface McpServerRecord {
  server_id: string;
  display_name: string;
  source: McpServerSource;
  /** 可执行文件（不拼接参数） */
  command: string;
  args: string[];
  /** 环境变量**名称**（值不落库——密钥走 OS 凭据库） */
  env_keys: string[];
  cwd: string | null;
  enabled: boolean;
  status: McpServerStatus;
  protocol_version: string | null;
  generation: "discover" | "initialize" | null;
  server_name: string | null;
  server_version: string | null;
  /** 降级/失败原因（degraded 时必须能给出可读原因） */
  last_error: string | null;
  /** 安装时是否勾选了风险确认（false 的记录不该存在——但保留字段便于审计取证） */
  risk_acknowledged: boolean;
  /** 勾选时展示给 Owner 的原文（事后可证明"当时告知了什么"） */
  risk_ack_text: string | null;
  installed_by: string;
  created_at: string;
  updated_at: string;
}

/** 五维权限（与 capability 的 PermissionGrant 同形；默认全空） */
export interface McpServerGrants {
  filesystem: string[];
  network: string[];
  shell: string[];
  channels: string[];
  credentials: string[];
}

export const EMPTY_MCP_GRANTS: McpServerGrants = {
  filesystem: [],
  network: [],
  shell: [],
  channels: [],
  credentials: [],
};

interface ServerRow {
  server_id: string;
  display_name: string;
  source: string;
  command: string;
  args_json: string;
  env_keys_json: string;
  cwd: string | null;
  enabled: number;
  status: string;
  protocol_version: string | null;
  generation: string | null;
  server_name: string | null;
  server_version: string | null;
  last_error: string | null;
  risk_acknowledged: number;
  risk_ack_text: string | null;
  installed_by: string;
  created_at: string;
  updated_at: string;
}

interface GrantsRow {
  server_id: string;
  filesystem: string;
  network: string;
  shell: string;
  channels: string;
  credentials: string;
  updated_at: string;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function projectServer(row: ServerRow): McpServerRecord {
  return {
    server_id: row.server_id,
    display_name: row.display_name,
    source: row.source as McpServerSource,
    command: row.command,
    args: parseStringArray(row.args_json),
    env_keys: parseStringArray(row.env_keys_json),
    cwd: row.cwd,
    enabled: row.enabled === 1,
    status: row.status as McpServerStatus,
    protocol_version: row.protocol_version,
    generation:
      row.generation === "discover" || row.generation === "initialize" ? row.generation : null,
    server_name: row.server_name,
    server_version: row.server_version,
    last_error: row.last_error,
    risk_acknowledged: row.risk_acknowledged === 1,
    risk_ack_text: row.risk_ack_text,
    installed_by: row.installed_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function projectGrants(row: GrantsRow | null): McpServerGrants {
  if (row === null) return { ...EMPTY_MCP_GRANTS };
  return {
    filesystem: parseStringArray(row.filesystem),
    network: parseStringArray(row.network),
    shell: parseStringArray(row.shell),
    channels: parseStringArray(row.channels),
    credentials: parseStringArray(row.credentials),
  };
}

export class McpServerStore {
  readonly #db: SqliteDatabase;
  readonly #ownsConnection: boolean;

  constructor(options: { dataDir?: string; db?: SqliteDatabase } = {}) {
    if (options.db !== undefined) {
      this.#db = options.db;
      this.#ownsConnection = false;
    } else {
      if (options.dataDir === undefined) {
        throw new Error("McpServerStore requires either dataDir or db");
      }
      this.#db = openSqlite(join(options.dataDir, DB_FILE_NAME));
      this.#ownsConnection = true;
    }
    this.#db.exec(CREATE_SQL);
  }

  list(): McpServerRecord[] {
    return (this.#db.prepare("SELECT * FROM mcp_servers ORDER BY created_at, server_id").all() as ServerRow[]).map(
      projectServer,
    );
  }

  get(serverId: string): McpServerRecord | null {
    const row = this.#db.prepare("SELECT * FROM mcp_servers WHERE server_id = ?").get(serverId) as
      | ServerRow
      | undefined;
    return row === undefined ? null : projectServer(row);
  }

  /** 按显示名查（安装去重：同名 server 不许装两次，否则工具命名空间会互撞） */
  findByName(displayName: string): McpServerRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM mcp_servers WHERE display_name = ? COLLATE NOCASE")
      .get(displayName) as ServerRow | undefined;
    return row === undefined ? null : projectServer(row);
  }

  insert(record: McpServerRecord): void {
    this.#db
      .prepare(
        `INSERT INTO mcp_servers (
          server_id, display_name, source, command, args_json, env_keys_json, cwd,
          enabled, status, protocol_version, generation, server_name, server_version,
          last_error, risk_acknowledged, risk_ack_text, installed_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.server_id,
        record.display_name,
        record.source,
        record.command,
        JSON.stringify(record.args),
        JSON.stringify(record.env_keys),
        record.cwd,
        record.enabled ? 1 : 0,
        record.status,
        record.protocol_version,
        record.generation,
        record.server_name,
        record.server_version,
        record.last_error,
        record.risk_acknowledged ? 1 : 0,
        record.risk_ack_text,
        record.installed_by,
        record.created_at,
        record.updated_at,
      );
    this.#db
      .prepare("INSERT OR REPLACE INTO mcp_server_grants (server_id, updated_at) VALUES (?, ?)")
      .run(record.server_id, record.created_at);
  }

  /** 更新状态字段（启停/健康探测后回写；不动配置本体） */
  updateRuntimeState(
    serverId: string,
    state: {
      enabled?: boolean;
      status?: McpServerStatus;
      protocol_version?: string | null;
      generation?: "discover" | "initialize" | null;
      server_name?: string | null;
      server_version?: string | null;
      last_error?: string | null;
    },
    now: string,
  ): McpServerRecord | null {
    const existing = this.get(serverId);
    if (existing === null) return null;
    this.#db
      .prepare(
        `UPDATE mcp_servers SET
          enabled = ?, status = ?, protocol_version = ?, generation = ?,
          server_name = ?, server_version = ?, last_error = ?, updated_at = ?
         WHERE server_id = ?`,
      )
      .run(
        (state.enabled ?? existing.enabled) ? 1 : 0,
        state.status ?? existing.status,
        state.protocol_version === undefined ? existing.protocol_version : state.protocol_version,
        state.generation === undefined ? existing.generation : state.generation,
        state.server_name === undefined ? existing.server_name : state.server_name,
        state.server_version === undefined ? existing.server_version : state.server_version,
        state.last_error === undefined ? existing.last_error : state.last_error,
        now,
        serverId,
      );
    return this.get(serverId);
  }

  delete(serverId: string): boolean {
    const existing = this.get(serverId);
    if (existing === null) return false;
    this.#db.prepare("DELETE FROM mcp_server_grants WHERE server_id = ?").run(serverId);
    this.#db.prepare("DELETE FROM mcp_servers WHERE server_id = ?").run(serverId);
    return true;
  }

  grantsOf(serverId: string): McpServerGrants {
    const row = this.#db
      .prepare("SELECT * FROM mcp_server_grants WHERE server_id = ?")
      .get(serverId) as GrantsRow | undefined;
    return projectGrants(row ?? null);
  }

  setGrants(serverId: string, grants: McpServerGrants, now: string): void {
    this.#db
      .prepare(
        `INSERT INTO mcp_server_grants (server_id, filesystem, network, shell, channels, credentials, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           filesystem = excluded.filesystem,
           network = excluded.network,
           shell = excluded.shell,
           channels = excluded.channels,
           credentials = excluded.credentials,
           updated_at = excluded.updated_at`,
      )
      .run(
        serverId,
        JSON.stringify(grants.filesystem),
        JSON.stringify(grants.network),
        JSON.stringify(grants.shell),
        JSON.stringify(grants.channels),
        JSON.stringify(grants.credentials),
        now,
      );
  }

  close(): void {
    if (this.#ownsConnection) this.#db.close();
  }
}
