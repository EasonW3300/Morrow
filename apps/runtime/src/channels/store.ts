import { join } from "node:path";
import type {
  ChannelConversationKind,
  ChannelPermissionContext,
  ChannelPrincipal,
  InboundAttachment,
} from "@morrow/protocol";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { uuidv7 } from "../uuid-v7.ts";

/**
 * 平台原始 Conversation 的独立存储（M4-T1 / Issue #38）。
 *
 * 与任务投影同库（events.sqlite，独立连接，WAL）：这里的表是**可变投影**（会话关联
 * session/task、最后消息时间），审计历史仍只在 append-only 账本。
 *
 *   channel_accounts    渠道账号登记（渠道 × 平台账号 → 本机账号 id）
 *   channel_identities  (account, native sender) → 本地主体（owner / contact:<id>）；
 *                       **平台自报身份只作原始载荷记录，绝不直接决定权限**
 *   channel_allowlist   群聊白名单（mention_only / proactive_limited）；未列入的群一律不响应
 *   conversations       平台原始会话记录（来源账号 + 平台会话 id + 解析后的权限上下文 +
 *                       关联 session/task）
 *   messages            平台原始消息记录（raw 原样保留 + 归一化字段 + 关联 task_id）
 *
 * 「不与 Task 混同」：task_id 只是 messages/conversations 上的关联列（中间路由写入），
 * 不写回 raw，也不在渠道路由里创建/推进 Task。
 *
 * 所有 DDL 幂等（CREATE IF NOT EXISTS），旧库自动补表。
 */

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS channel_accounts (
  account_id         TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL,
  native_account_id  TEXT NOT NULL,
  display_name       TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  UNIQUE (channel_id, native_account_id)
);

CREATE TABLE IF NOT EXISTS channel_identities (
  account_id         TEXT NOT NULL,
  native_sender_id   TEXT NOT NULL,
  principal          TEXT NOT NULL,
  display_name       TEXT,
  granted_categories TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  PRIMARY KEY (account_id, native_sender_id)
);

CREATE TABLE IF NOT EXISTS channel_allowlist (
  account_id             TEXT NOT NULL,
  native_conversation_id TEXT NOT NULL,
  mode                   TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  PRIMARY KEY (account_id, native_conversation_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id        TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL,
  native_conversation_id TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  session_id             TEXT,
  permission_context     TEXT,
  task_id                TEXT,
  created_at             TEXT NOT NULL,
  last_message_at        TEXT NOT NULL,
  UNIQUE (account_id, native_conversation_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id          TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  native_message_id   TEXT NOT NULL,
  direction           TEXT NOT NULL,
  sender_native_id    TEXT,
  text                TEXT NOT NULL,
  timestamp           TEXT NOT NULL,
  mention_agent       INTEGER NOT NULL DEFAULT 0,
  attachments         TEXT NOT NULL DEFAULT '[]',
  permission_context  TEXT,
  task_id             TEXT,
  raw                 TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (conversation_id, native_message_id, direction)
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

-- 渠道启停状态（A1 修复批）：自动装配的稳定适配器缺省未启用；Owner 显式启用后
-- 跨进程保留。实验适配器另有 adapter.isEnabled()（confirm_risk）闸门，不由此表绕过。
CREATE TABLE IF NOT EXISTS channel_settings (
  channel_id TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 渠道默认通知会话（A3 修复批）：channel:<id> 通知目标的解析依据。由 Owner 经
-- PUT /v1/channels/:id/notify-target 指定，必须指向该渠道已存在/已白名单的会话。
CREATE TABLE IF NOT EXISTS channel_notify_target (
  channel_id             TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL,
  native_conversation_id TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
`;

export interface ChannelAccountInput {
  account_id: string;
  channel_id: string;
  native_account_id: string;
  display_name?: string | null;
  enabled?: boolean;
}

export interface ChannelAccountRecord {
  account_id: string;
  channel_id: string;
  native_account_id: string;
  display_name: string | null;
  enabled: boolean;
  created_at: string;
}

export interface ChannelIdentityInput {
  account_id: string;
  native_sender_id: string;
  principal: ChannelPrincipal;
  display_name?: string | null;
  granted_categories?: string[];
}

export interface ChannelIdentityRecord {
  account_id: string;
  native_sender_id: string;
  principal: ChannelPrincipal;
  display_name: string | null;
  granted_categories: string[];
}

export type ConversationAllowMode = "mention_only" | "proactive_limited";

export const CONVERSATION_ALLOW_MODES: readonly ConversationAllowMode[] = ["mention_only", "proactive_limited"];

export interface ConversationAllowInput {
  account_id: string;
  native_conversation_id: string;
  mode: ConversationAllowMode;
}

export interface ConversationAllowRow {
  account_id: string;
  native_conversation_id: string;
  mode: ConversationAllowMode;
  created_at: string;
}

export interface ConversationRecord {
  conversation_id: string;
  account_id: string;
  native_conversation_id: string;
  kind: ChannelConversationKind;
  session_id: string | null;
  permission_context: ChannelPermissionContext | null;
  task_id: string | null;
  created_at: string;
  last_message_at: string;
}

/** 渠道启停状态行（A1 修复批）：缺省不存在 = 未启用 */
export interface ChannelSettingsRecord {
  channel_id: string;
  enabled: boolean;
  updated_at: string;
}

/** 渠道默认通知会话（A3 修复批） */
export interface ChannelNotifyTargetRecord {
  channel_id: string;
  account_id: string;
  native_conversation_id: string;
  updated_at: string;
}

export type MessageDirection = "inbound" | "outbound";

export interface ChannelMessageInput {
  conversationId: string;
  nativeMessageId: string;
  direction: MessageDirection;
  senderNativeId?: string | null;
  text: string;
  timestamp: string;
  mentionAgent: boolean;
  attachments: InboundAttachment[];
  permissionContext: ChannelPermissionContext | null;
  taskId?: string | null;
  /** 平台原始载荷（原样 JSON 持久化；Task 关联绝不写回这里） */
  raw: unknown;
}

export interface ChannelMessageRecord {
  message_id: string;
  conversation_id: string;
  native_message_id: string;
  direction: MessageDirection;
  sender_native_id: string | null;
  text: string;
  timestamp: string;
  mention_agent: boolean;
  attachments: InboundAttachment[];
  permission_context: ChannelPermissionContext | null;
  task_id: string | null;
  raw: unknown;
  created_at: string;
}

interface AccountRow {
  account_id: string;
  channel_id: string;
  native_account_id: string;
  display_name: string | null;
  enabled: number;
  created_at: string;
}

interface IdentityRow {
  account_id: string;
  native_sender_id: string;
  principal: string;
  display_name: string | null;
  granted_categories: string;
}

interface ConversationRow {
  conversation_id: string;
  account_id: string;
  native_conversation_id: string;
  kind: string;
  session_id: string | null;
  permission_context: string | null;
  task_id: string | null;
  created_at: string;
  last_message_at: string;
}

interface MessageRow {
  message_id: string;
  conversation_id: string;
  native_message_id: string;
  direction: string;
  sender_native_id: string | null;
  text: string;
  timestamp: string;
  mention_agent: number;
  attachments: string;
  permission_context: string | null;
  task_id: string | null;
  raw: string;
  created_at: string;
}

export class ChannelStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #upsertAccountStmt;
  #findAccountStmt;
  #findAccountByChannelStmt;
  #upsertIdentityStmt;
  #findIdentityStmt;
  #allowConversationStmt;
  #isConversationAllowedStmt;
  #findAllowModeStmt;
  #listAllowlistStmt;
  #deleteAllowlistStmt;
  #upsertConversationStmt;
  #findConversationStmt;
  #getConversationByIdStmt;
  #setSessionStmt;
  #setTaskStmt;
  #insertMessageStmt;
  #findMessageByIdStmt;
  #findMessageByNativeStmt;
  #listMessagesStmt;
  #getSettingsStmt;
  #upsertSettingsStmt;
  #getNotifyTargetStmt;
  #upsertNotifyTargetStmt;
  #deleteNotifyTargetStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);

    this.#upsertAccountStmt = db.prepare(
      `INSERT INTO channel_accounts (account_id, channel_id, native_account_id, display_name, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         native_account_id = excluded.native_account_id,
         display_name = excluded.display_name,
         enabled = excluded.enabled`,
    );
    this.#findAccountStmt = db.prepare(
      "SELECT account_id, channel_id, native_account_id, display_name, enabled, created_at FROM channel_accounts WHERE account_id = ?",
    );
    this.#findAccountByChannelStmt = db.prepare(
      "SELECT account_id, channel_id, native_account_id, display_name, enabled, created_at FROM channel_accounts WHERE channel_id = ? AND enabled = 1 ORDER BY created_at, account_id LIMIT 1",
    );
    this.#upsertIdentityStmt = db.prepare(
      `INSERT INTO channel_identities (account_id, native_sender_id, principal, display_name, granted_categories, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, native_sender_id) DO UPDATE SET
         principal = excluded.principal,
         display_name = excluded.display_name,
         granted_categories = excluded.granted_categories`,
    );
    this.#findIdentityStmt = db.prepare(
      "SELECT account_id, native_sender_id, principal, display_name, granted_categories FROM channel_identities WHERE account_id = ? AND native_sender_id = ?",
    );
    this.#allowConversationStmt = db.prepare(
      `INSERT INTO channel_allowlist (account_id, native_conversation_id, mode, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, native_conversation_id) DO UPDATE SET mode = excluded.mode`,
    );
    this.#isConversationAllowedStmt = db.prepare(
      "SELECT 1 AS hit FROM channel_allowlist WHERE account_id = ? AND native_conversation_id = ?",
    );
    this.#findAllowModeStmt = db.prepare(
      "SELECT mode FROM channel_allowlist WHERE account_id = ? AND native_conversation_id = ?",
    );
    this.#listAllowlistStmt = db.prepare(
      "SELECT account_id, native_conversation_id, mode, created_at FROM channel_allowlist WHERE account_id = ? ORDER BY created_at, native_conversation_id",
    );
    this.#deleteAllowlistStmt = db.prepare("DELETE FROM channel_allowlist WHERE account_id = ?");
    this.#upsertConversationStmt = db.prepare(
      `INSERT INTO conversations (conversation_id, account_id, native_conversation_id, kind, session_id, permission_context, task_id, created_at, last_message_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)
       ON CONFLICT(account_id, native_conversation_id) DO UPDATE SET
         last_message_at = excluded.last_message_at`,
    );
    this.#findConversationStmt = db.prepare(
      "SELECT * FROM conversations WHERE account_id = ? AND native_conversation_id = ?",
    );
    this.#getConversationByIdStmt = db.prepare("SELECT * FROM conversations WHERE conversation_id = ?");
    this.#setSessionStmt = db.prepare("UPDATE conversations SET session_id = ? WHERE conversation_id = ?");
    this.#setTaskStmt = db.prepare("UPDATE conversations SET task_id = ? WHERE conversation_id = ?");
    this.#insertMessageStmt = db.prepare(
      `INSERT OR IGNORE INTO messages
         (message_id, conversation_id, native_message_id, direction, sender_native_id, text, timestamp, mention_agent, attachments, permission_context, task_id, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#findMessageByIdStmt = db.prepare("SELECT * FROM messages WHERE message_id = ?");
    this.#findMessageByNativeStmt = db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND native_message_id = ? AND direction = ?",
    );
    this.#listMessagesStmt = db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
    );
    this.#getSettingsStmt = db.prepare(
      "SELECT channel_id, enabled, updated_at FROM channel_settings WHERE channel_id = ?",
    );
    this.#upsertSettingsStmt = db.prepare(
      `INSERT INTO channel_settings (channel_id, enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    );
    this.#getNotifyTargetStmt = db.prepare(
      "SELECT channel_id, account_id, native_conversation_id, updated_at FROM channel_notify_target WHERE channel_id = ?",
    );
    this.#upsertNotifyTargetStmt = db.prepare(
      `INSERT INTO channel_notify_target (channel_id, account_id, native_conversation_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         account_id = excluded.account_id,
         native_conversation_id = excluded.native_conversation_id,
         updated_at = excluded.updated_at`,
    );
    this.#deleteNotifyTargetStmt = db.prepare("DELETE FROM channel_notify_target WHERE channel_id = ?");
  }

  static open(dataDir: string): ChannelStore {
    return new ChannelStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  registerAccount(input: ChannelAccountInput, now: Date = new Date()): ChannelAccountRecord {
    this.#upsertAccountStmt.run(
      input.account_id,
      input.channel_id,
      input.native_account_id,
      input.display_name ?? null,
      input.enabled === false ? 0 : 1,
      now.toISOString(),
    );
    return this.findAccount(input.account_id) as ChannelAccountRecord;
  }

  findAccount(accountId: string): ChannelAccountRecord | null {
    const row = this.#findAccountStmt.get(accountId) as AccountRow | undefined;
    return row === undefined ? null : rowToAccount(row);
  }

  /** 渠道当前绑定的启用账号（适配器 start 的 accountId 来源；无 → null） */
  findAccountByChannel(channelId: string): ChannelAccountRecord | null {
    const row = this.#findAccountByChannelStmt.get(channelId) as AccountRow | undefined;
    return row === undefined ? null : rowToAccount(row);
  }

  /** 绑定渠道身份到本地主体（owner / contact:<id>）；重复绑定覆盖授权快照 */
  registerIdentity(input: ChannelIdentityInput, now: Date = new Date()): ChannelIdentityRecord {
    assertPrincipal(input.principal);
    this.#upsertIdentityStmt.run(
      input.account_id,
      input.native_sender_id,
      input.principal,
      input.display_name ?? null,
      JSON.stringify(input.granted_categories ?? (input.principal === "owner" ? ["*"] : [])),
      now.toISOString(),
    );
    return this.findIdentity(input.account_id, input.native_sender_id) as ChannelIdentityRecord;
  }

  findIdentity(accountId: string, nativeSenderId: string): ChannelIdentityRecord | null {
    const row = this.#findIdentityStmt.get(accountId, nativeSenderId) as IdentityRow | undefined;
    return row === undefined ? null : rowToIdentity(row);
  }

  allowConversation(input: ConversationAllowInput, now: Date = new Date()): void {
    if (!CONVERSATION_ALLOW_MODES.includes(input.mode)) {
      throw new Error(`invalid conversation allow mode: ${String(input.mode)}`);
    }
    this.#allowConversationStmt.run(
      input.account_id,
      input.native_conversation_id,
      input.mode,
      now.toISOString(),
    );
  }

  isConversationAllowed(accountId: string, nativeConversationId: string): boolean {
    return this.#isConversationAllowedStmt.get(accountId, nativeConversationId) !== undefined;
  }

  /** 白名单模式（未列入 → null；mention_only / proactive_limited） */
  findAllowMode(accountId: string, nativeConversationId: string): ConversationAllowMode | null {
    const row = this.#findAllowModeStmt.get(accountId, nativeConversationId) as { mode: string } | undefined;
    if (row === undefined) return null;
    return CONVERSATION_ALLOW_MODES.includes(row.mode as ConversationAllowMode)
      ? (row.mode as ConversationAllowMode)
      : null;
  }

  listAllowlist(accountId: string): ConversationAllowRow[] {
    return (this.#listAllowlistStmt.all(accountId) as unknown as Array<{
      account_id: string;
      native_conversation_id: string;
      mode: string;
      created_at: string;
    }>).map((row) => ({
      account_id: row.account_id,
      native_conversation_id: row.native_conversation_id,
      mode: row.mode as ConversationAllowMode,
      created_at: row.created_at,
    }));
  }

  /** PUT 语义：整表替换（空列表 = 清空白名单） */
  replaceAllowlist(accountId: string, entries: Array<{ native_conversation_id: string; mode: ConversationAllowMode }>, now: Date = new Date()): void {
    const iso = now.toISOString();
    this.#db.exec("BEGIN");
    try {
      this.#deleteAllowlistStmt.run(accountId);
      for (const entry of entries) {
        this.#allowConversationStmt.run(accountId, entry.native_conversation_id, entry.mode, iso);
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  getOrCreateConversation(input: {
    accountId: string;
    nativeConversationId: string;
    kind: ChannelConversationKind;
    permissionContext: ChannelPermissionContext | null;
    now?: Date;
  }): ConversationRecord {
    const iso = (input.now ?? new Date()).toISOString();
    this.#upsertConversationStmt.run(
      uuidv7(),
      input.accountId,
      input.nativeConversationId,
      input.kind,
      input.permissionContext === null ? null : JSON.stringify(input.permissionContext),
      iso,
      iso,
    );
    return this.findConversation(input.accountId, input.nativeConversationId) as ConversationRecord;
  }

  findConversation(accountId: string, nativeConversationId: string): ConversationRecord | null {
    const row = this.#findConversationStmt.get(accountId, nativeConversationId) as ConversationRow | undefined;
    return row === undefined ? null : rowToConversation(row);
  }

  getConversationById(conversationId: string): ConversationRecord | null {
    const row = this.#getConversationByIdStmt.get(conversationId) as ConversationRow | undefined;
    return row === undefined ? null : rowToConversation(row);
  }

  setConversationSession(conversationId: string, sessionId: string): void {
    this.#setSessionStmt.run(sessionId, conversationId);
  }

  setConversationTask(conversationId: string, taskId: string): void {
    this.#setTaskStmt.run(taskId, conversationId);
  }

  /** 原始消息落库；native id 重复时返回既有记录（duplicate=true），不重复入会话 */
  insertMessage(input: ChannelMessageInput, now: Date = new Date()): { record: ChannelMessageRecord; duplicate: boolean } {
    const messageId = uuidv7();
    const result = this.#insertMessageStmt.run(
      messageId,
      input.conversationId,
      input.nativeMessageId,
      input.direction,
      input.senderNativeId ?? null,
      input.text,
      input.timestamp,
      input.mentionAgent ? 1 : 0,
      JSON.stringify(input.attachments),
      input.permissionContext === null ? null : JSON.stringify(input.permissionContext),
      input.taskId ?? null,
      JSON.stringify(input.raw ?? null),
      now.toISOString(),
    );
    if (Number(result.changes) === 0) {
      const existing = this.#findMessageByNativeStmt.get(
        input.conversationId,
        input.nativeMessageId,
        input.direction,
      ) as MessageRow | undefined;
      if (existing !== undefined) return { record: rowToMessage(existing), duplicate: true };
    }
    const row = this.#findMessageByIdStmt.get(messageId) as MessageRow | undefined;
    return { record: rowToMessage(row as MessageRow), duplicate: false };
  }

  listMessages(conversationId: string): ChannelMessageRecord[] {
    return (this.#listMessagesStmt.all(conversationId) as unknown as MessageRow[]).map(rowToMessage);
  }

  /** 渠道启用状态（缺省 false：自动装配的稳定适配器不隐式启动） */
  channelEnabled(channelId: string): boolean {
    const row = this.#getSettingsStmt.get(channelId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  setChannelEnabled(channelId: string, enabled: boolean, now: Date = new Date()): void {
    this.#upsertSettingsStmt.run(channelId, enabled ? 1 : 0, now.toISOString());
  }

  getNotifyTarget(channelId: string): ChannelNotifyTargetRecord | null {
    const row = this.#getNotifyTargetStmt.get(channelId) as ChannelNotifyTargetRecord | undefined;
    return row === undefined ? null : { ...row };
  }

  setNotifyTarget(input: {
    channelId: string;
    accountId: string;
    nativeConversationId: string;
    now?: Date;
  }): ChannelNotifyTargetRecord {
    this.#upsertNotifyTargetStmt.run(
      input.channelId,
      input.accountId,
      input.nativeConversationId,
      (input.now ?? new Date()).toISOString(),
    );
    return this.getNotifyTarget(input.channelId) as ChannelNotifyTargetRecord;
  }

  clearNotifyTarget(channelId: string): void {
    this.#deleteNotifyTargetStmt.run(channelId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

function assertPrincipal(principal: string): asserts principal is ChannelPrincipal {
  if (principal !== "owner" && !/^contact:\S+$/.test(principal)) {
    throw new Error(`invalid channel principal: ${principal}`);
  }
}

function rowToAccount(row: AccountRow): ChannelAccountRecord {
  return {
    account_id: row.account_id,
    channel_id: row.channel_id,
    native_account_id: row.native_account_id,
    display_name: row.display_name,
    enabled: row.enabled === 1,
    created_at: row.created_at,
  };
}

function rowToIdentity(row: IdentityRow): ChannelIdentityRecord {
  return {
    account_id: row.account_id,
    native_sender_id: row.native_sender_id,
    principal: row.principal as ChannelPrincipal,
    display_name: row.display_name,
    granted_categories: parseJson(row.granted_categories, [] as string[]),
  };
}

function rowToConversation(row: ConversationRow): ConversationRecord {
  return {
    conversation_id: row.conversation_id,
    account_id: row.account_id,
    native_conversation_id: row.native_conversation_id,
    kind: row.kind === "group" ? "group" : "direct",
    session_id: row.session_id,
    permission_context: row.permission_context === null ? null : (JSON.parse(row.permission_context) as ChannelPermissionContext),
    task_id: row.task_id,
    created_at: row.created_at,
    last_message_at: row.last_message_at,
  };
}

function rowToMessage(row: MessageRow): ChannelMessageRecord {
  return {
    message_id: row.message_id,
    conversation_id: row.conversation_id,
    native_message_id: row.native_message_id,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    sender_native_id: row.sender_native_id,
    text: row.text,
    timestamp: row.timestamp,
    mention_agent: row.mention_agent === 1,
    attachments: parseJson(row.attachments, [] as InboundAttachment[]),
    permission_context: row.permission_context === null ? null : (JSON.parse(row.permission_context) as ChannelPermissionContext),
    task_id: row.task_id,
    raw: JSON.parse(row.raw) as unknown,
    created_at: row.created_at,
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
