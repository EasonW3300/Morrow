import { join } from "node:path";
import {
  CONTACT_CAPABILITY_CATEGORIES,
  type ContactCapabilityCategory,
} from "@morrow/protocol";
import { DB_FILE_NAME } from "../ledger.ts";
import { openSqlite, type SqliteDatabase } from "../db.ts";
import { uuidv7 } from "../uuid-v7.ts";

/**
 * 可信联系人持久化（M4-T6 / Issue #43，PRD §4.8 FR-NOT-3）。
 *
 *   contacts              联系人本体（display_name / status）
 *   contact_grants        联系人 × 能力类别 × 可选 scope（scope = 允许执行的能力名列表）；
 *                         新建联系人默认只有 query（FR-NOT-3）
 *   contact_invites       一次性邀请码（只存 sha256 哈希；used_at 非空即已消费）
 *   contact_identities    联系人 × 渠道账号 × 平台发送者（多对多——同一发送者可有多个
 *                         联系人匹配，从而产生歧义；**绝不自动合并**）
 *   contact_ambiguities   身份歧义待 Owner 选择
 *   contact_sessions      联系人的会话归属（「读他人会话」判定的本地依据）
 *
 * 与账本同库（events.sqlite，独立连接，WAL）。行是权威状态，contact.* 账本事件
 * 由 ContactService / PermissionEngine 在行落定后追加（审计投影）。
 * 所有 DDL 幂等（CREATE IF NOT EXISTS），旧库自动补表。
 */

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  contact_id    TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_grants (
  contact_id  TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('query', 'task_execute', 'memory_reference')),
  scope       TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (contact_id, category)
);

CREATE TABLE IF NOT EXISTS contact_invites (
  invite_id              TEXT PRIMARY KEY,
  code_hash              TEXT NOT NULL UNIQUE,
  contact_id             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  used_at                TEXT,
  used_account_id        TEXT,
  used_native_sender_id  TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_invites_code_idx ON contact_invites (code_hash);

CREATE TABLE IF NOT EXISTS contact_identities (
  contact_id       TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  native_sender_id TEXT NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (contact_id, account_id, native_sender_id)
);
CREATE INDEX IF NOT EXISTS contact_identities_sender_idx ON contact_identities (account_id, native_sender_id);

CREATE TABLE IF NOT EXISTS contact_ambiguities (
  ambiguity_id           TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL,
  native_sender_id       TEXT NOT NULL,
  candidate_contact_ids  TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_contact_id    TEXT,
  created_at             TEXT NOT NULL,
  resolved_at            TEXT
);

CREATE TABLE IF NOT EXISTS contact_sessions (
  contact_id             TEXT NOT NULL,
  session_id             TEXT NOT NULL,
  account_id             TEXT NOT NULL,
  native_conversation_id TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  PRIMARY KEY (contact_id, session_id)
);
`;

export interface ContactRow {
  contact_id: string;
  display_name: string;
  status: "active" | "suspended";
  created_at: string;
  updated_at: string;
}

export interface ContactGrantRow {
  contact_id: string;
  category: ContactCapabilityCategory;
  scope: string[];
  created_at: string;
  updated_at: string;
}

export interface ContactInviteRow {
  invite_id: string;
  code_hash: string;
  contact_id: string;
  expires_at: string;
  used_at: string | null;
  used_account_id: string | null;
  used_native_sender_id: string | null;
  created_at: string;
}

export interface ContactIdentityRow {
  contact_id: string;
  account_id: string;
  native_sender_id: string;
  display_name: string | null;
  created_at: string;
}

export interface ContactAmbiguityRow {
  ambiguity_id: string;
  account_id: string;
  native_sender_id: string;
  candidate_contact_ids: string[];
  status: "open" | "resolved";
  resolved_contact_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface ContactDbRow {
  contact_id: string;
  display_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface GrantDbRow {
  contact_id: string;
  category: string;
  scope: string;
  created_at: string;
  updated_at: string;
}

interface InviteDbRow {
  invite_id: string;
  code_hash: string;
  contact_id: string;
  expires_at: string;
  used_at: string | null;
  used_account_id: string | null;
  used_native_sender_id: string | null;
  created_at: string;
}

interface IdentityDbRow {
  contact_id: string;
  account_id: string;
  native_sender_id: string;
  display_name: string | null;
  created_at: string;
}

interface AmbiguityDbRow {
  ambiguity_id: string;
  account_id: string;
  native_sender_id: string;
  candidate_contact_ids: string;
  status: string;
  resolved_contact_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function isContactCategory(value: unknown): value is ContactCapabilityCategory {
  return typeof value === "string" && (CONTACT_CAPABILITY_CATEGORIES as readonly string[]).includes(value);
}

export class ContactStore {
  readonly #db: SqliteDatabase;
  #closed = false;

  #insertContactStmt;
  #updateContactStmt;
  #getContactStmt;
  #listContactsStmt;
  #insertGrantStmt;
  #deleteGrantsStmt;
  #listGrantsStmt;
  #insertInviteStmt;
  #findInviteByHashStmt;
  #consumeInviteStmt;
  #insertIdentityStmt;
  #findContactsForSenderStmt;
  #listIdentitiesStmt;
  #deleteOtherIdentitiesStmt;
  #insertAmbiguityStmt;
  #findOpenAmbiguityStmt;
  #getAmbiguityStmt;
  #listAmbiguitiesStmt;
  #resolveAmbiguityStmt;
  #insertSessionStmt;
  #hasSessionStmt;
  #findContactBySessionStmt;

  private constructor(db: SqliteDatabase) {
    this.#db = db;
    db.exec(CREATE_SQL);

    this.#insertContactStmt = db.prepare(
      "INSERT INTO contacts (contact_id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    );
    this.#updateContactStmt = db.prepare(
      "UPDATE contacts SET display_name = ?, status = ?, updated_at = ? WHERE contact_id = ?",
    );
    this.#getContactStmt = db.prepare(
      "SELECT contact_id, display_name, status, created_at, updated_at FROM contacts WHERE contact_id = ?",
    );
    this.#listContactsStmt = db.prepare(
      "SELECT contact_id, display_name, status, created_at, updated_at FROM contacts ORDER BY created_at, contact_id",
    );
    this.#insertGrantStmt = db.prepare(
      `INSERT INTO contact_grants (contact_id, category, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(contact_id, category) DO UPDATE SET scope = excluded.scope, updated_at = excluded.updated_at`,
    );
    this.#deleteGrantsStmt = db.prepare("DELETE FROM contact_grants WHERE contact_id = ?");
    this.#listGrantsStmt = db.prepare(
      "SELECT contact_id, category, scope, created_at, updated_at FROM contact_grants WHERE contact_id = ? ORDER BY category",
    );
    this.#insertInviteStmt = db.prepare(
      `INSERT INTO contact_invites (invite_id, code_hash, contact_id, expires_at, used_at, used_account_id, used_native_sender_id, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    );
    this.#findInviteByHashStmt = db.prepare(
      "SELECT * FROM contact_invites WHERE code_hash = ?",
    );
    this.#consumeInviteStmt = db.prepare(
      `UPDATE contact_invites SET used_at = ?, used_account_id = ?, used_native_sender_id = ?
       WHERE invite_id = ? AND used_at IS NULL`,
    );
    this.#insertIdentityStmt = db.prepare(
      `INSERT INTO contact_identities (contact_id, account_id, native_sender_id, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(contact_id, account_id, native_sender_id) DO UPDATE SET display_name = excluded.display_name`,
    );
    this.#findContactsForSenderStmt = db.prepare(
      "SELECT contact_id FROM contact_identities WHERE account_id = ? AND native_sender_id = ? ORDER BY contact_id",
    );
    this.#listIdentitiesStmt = db.prepare(
      "SELECT contact_id, account_id, native_sender_id, display_name, created_at FROM contact_identities WHERE contact_id = ? ORDER BY account_id, native_sender_id",
    );
    this.#deleteOtherIdentitiesStmt = db.prepare(
      "DELETE FROM contact_identities WHERE account_id = ? AND native_sender_id = ? AND contact_id <> ?",
    );
    this.#insertAmbiguityStmt = db.prepare(
      `INSERT INTO contact_ambiguities (ambiguity_id, account_id, native_sender_id, candidate_contact_ids, status, resolved_contact_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, 'open', NULL, ?, NULL)`,
    );
    this.#findOpenAmbiguityStmt = db.prepare(
      "SELECT * FROM contact_ambiguities WHERE account_id = ? AND native_sender_id = ? AND status = 'open' ORDER BY created_at LIMIT 1",
    );
    this.#getAmbiguityStmt = db.prepare("SELECT * FROM contact_ambiguities WHERE ambiguity_id = ?");
    this.#listAmbiguitiesStmt = db.prepare(
      "SELECT * FROM contact_ambiguities ORDER BY created_at, ambiguity_id",
    );
    this.#resolveAmbiguityStmt = db.prepare(
      "UPDATE contact_ambiguities SET status = 'resolved', resolved_contact_id = ?, resolved_at = ? WHERE ambiguity_id = ? AND status = 'open'",
    );
    this.#insertSessionStmt = db.prepare(
      `INSERT INTO contact_sessions (contact_id, session_id, account_id, native_conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(contact_id, session_id) DO NOTHING`,
    );
    this.#hasSessionStmt = db.prepare(
      "SELECT 1 AS hit FROM contact_sessions WHERE contact_id = ? AND session_id = ?",
    );
    this.#findContactBySessionStmt = db.prepare(
      "SELECT contact_id FROM contact_sessions WHERE session_id = ? LIMIT 1",
    );
  }

  static open(dataDir: string): ContactStore {
    return new ContactStore(openSqlite(join(dataDir, DB_FILE_NAME)));
  }

  createContact(displayName: string, now: Date = new Date()): ContactRow {
    const iso = now.toISOString();
    const contactId = uuidv7();
    this.#insertContactStmt.run(contactId, displayName, iso, iso);
    this.addGrant(contactId, "query", [], now);
    return this.getContact(contactId) as ContactRow;
  }

  getContact(contactId: string): ContactRow | null {
    const row = this.#getContactStmt.get(contactId) as ContactDbRow | undefined;
    return row === undefined ? null : rowToContact(row);
  }

  listContacts(): ContactRow[] {
    return (this.#listContactsStmt.all() as unknown as ContactDbRow[]).map(rowToContact);
  }

  updateContact(contactId: string, fields: { display_name?: string; status?: "active" | "suspended" }, now: Date = new Date()): ContactRow | null {
    const existing = this.getContact(contactId);
    if (existing === null) return null;
    this.#updateContactStmt.run(
      fields.display_name ?? existing.display_name,
      fields.status ?? existing.status,
      now.toISOString(),
      contactId,
    );
    return this.getContact(contactId);
  }

  addGrant(contactId: string, category: ContactCapabilityCategory, scope: string[], now: Date = new Date()): void {
    const iso = now.toISOString();
    this.#insertGrantStmt.run(contactId, category, JSON.stringify(scope), iso, iso);
  }

  /** 全量替换授权（PUT 语义）；空列表 = 收回所有类别 */
  setGrants(contactId: string, grants: Array<{ category: ContactCapabilityCategory; scope: string[] }>, now: Date = new Date()): void {
    const iso = now.toISOString();
    this.#tx(() => {
      this.#deleteGrantsStmt.run(contactId);
      for (const grant of grants) {
        this.#insertGrantStmt.run(contactId, grant.category, JSON.stringify(grant.scope), iso, iso);
      }
    });
  }

  listGrants(contactId: string): ContactGrantRow[] {
    return (this.#listGrantsStmt.all(contactId) as unknown as GrantDbRow[]).map(rowToGrant);
  }

  createInvite(input: {
    inviteId: string;
    codeHash: string;
    contactId: string;
    expiresAt: string;
    now?: Date;
  }): ContactInviteRow {
    this.#insertInviteStmt.run(
      input.inviteId,
      input.codeHash,
      input.contactId,
      input.expiresAt,
      (input.now ?? new Date()).toISOString(),
    );
    return this.getInvite(input.inviteId) as ContactInviteRow;
  }

  getInvite(inviteId: string): ContactInviteRow | null {
    const row = this.#db.prepare("SELECT * FROM contact_invites WHERE invite_id = ?").get(inviteId) as InviteDbRow | undefined;
    return row === undefined ? null : rowToInvite(row);
  }

  findInviteByCodeHash(codeHash: string): ContactInviteRow | null {
    const row = this.#findInviteByHashStmt.get(codeHash) as InviteDbRow | undefined;
    return row === undefined ? null : rowToInvite(row);
  }

  /** 消费邀请码并绑定身份（同一事务：单次语义不能被并发击穿） */
  consumeInvite(input: {
    inviteId: string;
    contactId: string;
    accountId: string;
    nativeSenderId: string;
    displayName?: string | null;
    now?: Date;
  }): boolean {
    const now = input.now ?? new Date();
    const iso = now.toISOString();
    return this.#tx(() => {
      const result = this.#consumeInviteStmt.run(iso, input.accountId, input.nativeSenderId, input.inviteId);
      if (Number(result.changes) === 0) return false;
      this.#insertIdentityStmt.run(
        input.contactId,
        input.accountId,
        input.nativeSenderId,
        input.displayName ?? null,
        iso,
      );
      return true;
    });
  }

  insertIdentity(input: {
    contactId: string;
    accountId: string;
    nativeSenderId: string;
    displayName?: string | null;
    now?: Date;
  }): void {
    this.#insertIdentityStmt.run(
      input.contactId,
      input.accountId,
      input.nativeSenderId,
      input.displayName ?? null,
      (input.now ?? new Date()).toISOString(),
    );
  }

  findContactsForSender(accountId: string, nativeSenderId: string): string[] {
    return (this.#findContactsForSenderStmt.all(accountId, nativeSenderId) as unknown as Array<{ contact_id: string }>).map(
      (row) => row.contact_id,
    );
  }

  listIdentities(contactId: string): ContactIdentityRow[] {
    return (this.#listIdentitiesStmt.all(contactId) as unknown as IdentityDbRow[]).map(rowToIdentity);
  }

  /** Owner 显式选择后移除该发送者与其余联系人的绑定（不自动合并，但选择即排他） */
  keepOnlyIdentity(accountId: string, nativeSenderId: string, contactId: string): void {
    this.#deleteOtherIdentitiesStmt.run(accountId, nativeSenderId, contactId);
  }

  recordAmbiguity(input: {
    accountId: string;
    nativeSenderId: string;
    candidateContactIds: string[];
    now?: Date;
  }): ContactAmbiguityRow {
    const existing = this.findOpenAmbiguity(input.accountId, input.nativeSenderId);
    if (existing !== null) return existing;
    const ambiguityId = uuidv7();
    this.#insertAmbiguityStmt.run(
      ambiguityId,
      input.accountId,
      input.nativeSenderId,
      JSON.stringify(input.candidateContactIds),
      (input.now ?? new Date()).toISOString(),
    );
    return this.getAmbiguity(ambiguityId) as ContactAmbiguityRow;
  }

  findOpenAmbiguity(accountId: string, nativeSenderId: string): ContactAmbiguityRow | null {
    const row = this.#findOpenAmbiguityStmt.get(accountId, nativeSenderId) as AmbiguityDbRow | undefined;
    return row === undefined ? null : rowToAmbiguity(row);
  }

  getAmbiguity(ambiguityId: string): ContactAmbiguityRow | null {
    const row = this.#getAmbiguityStmt.get(ambiguityId) as AmbiguityDbRow | undefined;
    return row === undefined ? null : rowToAmbiguity(row);
  }

  listAmbiguities(filter: { status?: "open" | "resolved" } = {}): ContactAmbiguityRow[] {
    return (this.#listAmbiguitiesStmt.all() as unknown as AmbiguityDbRow[])
      .map(rowToAmbiguity)
      .filter((row) => filter.status === undefined || row.status === filter.status);
  }

  resolveAmbiguity(ambiguityId: string, contactId: string, now: Date = new Date()): ContactAmbiguityRow | null {
    this.#resolveAmbiguityStmt.run(contactId, now.toISOString(), ambiguityId);
    return this.getAmbiguity(ambiguityId);
  }

  recordContactSession(input: {
    contactId: string;
    sessionId: string;
    accountId: string;
    nativeConversationId: string;
    now?: Date;
  }): void {
    this.#insertSessionStmt.run(
      input.contactId,
      input.sessionId,
      input.accountId,
      input.nativeConversationId,
      (input.now ?? new Date()).toISOString(),
    );
  }

  hasContactSession(contactId: string, sessionId: string): boolean {
    return this.#hasSessionStmt.get(contactId, sessionId) !== undefined;
  }

  /** 会话 → 联系人（无归属 = null，即 Owner/非联系人的普通会话） */
  findContactBySession(sessionId: string): string | null {
    const row = this.#findContactBySessionStmt.get(sessionId) as { contact_id: string } | undefined;
    return row === undefined ? null : row.contact_id;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
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

function parseScope(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rowToContact(row: ContactDbRow): ContactRow {
  return {
    contact_id: row.contact_id,
    display_name: row.display_name,
    status: row.status === "suspended" ? "suspended" : "active",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToGrant(row: GrantDbRow): ContactGrantRow {
  return {
    contact_id: row.contact_id,
    category: row.category as ContactCapabilityCategory,
    scope: parseScope(row.scope),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToInvite(row: InviteDbRow): ContactInviteRow {
  return {
    invite_id: row.invite_id,
    code_hash: row.code_hash,
    contact_id: row.contact_id,
    expires_at: row.expires_at,
    used_at: row.used_at,
    used_account_id: row.used_account_id,
    used_native_sender_id: row.used_native_sender_id,
    created_at: row.created_at,
  };
}

function rowToIdentity(row: IdentityDbRow): ContactIdentityRow {
  return {
    contact_id: row.contact_id,
    account_id: row.account_id,
    native_sender_id: row.native_sender_id,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}

function rowToAmbiguity(row: AmbiguityDbRow): ContactAmbiguityRow {
  return {
    ambiguity_id: row.ambiguity_id,
    account_id: row.account_id,
    native_sender_id: row.native_sender_id,
    candidate_contact_ids: parseScope(row.candidate_contact_ids),
    status: row.status === "resolved" ? "resolved" : "open",
    resolved_contact_id: row.resolved_contact_id,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}
