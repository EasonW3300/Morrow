import { createHash, randomBytes } from "node:crypto";
import type {
  ChannelPermissionContext,
  ContactAmbiguityView,
  ContactCapabilityCategory,
  ContactGrantView,
  ContactInviteView,
  ContactView,
} from "@morrow/protocol";
import { CONTACT_CAPABILITY_CATEGORIES } from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import type { MemoryService } from "../memory/service.ts";
import type { PermissionEngine } from "../capabilities/engine.ts";
import { uuidv7 } from "../uuid-v7.ts";
import { CONTACT_EVENT_TYPES } from "./events.ts";
import { ContactStore, isContactCategory, type ContactGrantRow } from "./store.ts";
import type { ContactBindingResolver } from "./types.ts";

/**
 * 可信联系人服务（M4-T6 / Issue #43，PRD §4.8 FR-NOT-3 / §5.2 流程 5）。
 *
 * 职责边界：
 *   - 邀请码生命周期（生成 → 渠道回复 → 消费绑定）、联系人/授权维护、身份歧义登记与
 *     Owner 选择、联系人会话归属登记；
 *   - **授权判定不在这里**——ContactService 只把类别查询转给 PermissionEngine，
 *     越权阻断与留痕由引擎的单一入口完成（authorizeContactUse）。
 *   - 记忆引用检索在这里编排：先经引擎确认 memory_reference 类别，再以
 *     sensitivity=public 在 MemoryService 检索层过滤（不是 UI 过滤）。
 *
 * 审计事件：contact.invited / contact.bound / contact.grants_updated /
 * contact.ambiguity_detected / contact.ambiguity_resolved（contact.permission_denied
 * 由 PermissionEngine 落账）。
 */

const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_CODE_RE = /^MC-[0-9A-F]{10}$/;

export type ContactErrorCode = "invalid_input" | "not_found" | "invalid_state" | "invite_expired" | "invite_used" | "invite_invalid";

export class ContactError extends Error {
  code: ContactErrorCode;

  constructor(code: ContactErrorCode, message: string) {
    super(message);
    this.name = "ContactError";
    this.code = code;
  }
}

export interface CreateInviteInput {
  display_name?: unknown;
  contact_id?: unknown;
  ttl_ms?: unknown;
}

export interface ResolvedGrantInput {
  category: ContactCapabilityCategory;
  scope: string[];
}

export class ContactService implements ContactBindingResolver {
  readonly #store: ContactStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #engine: PermissionEngine;
  readonly #memory: MemoryService;
  readonly #now: () => Date;
  #closed = false;

  constructor(options: {
    dataDir: string;
    ledger: EventLedger;
    replicaId: string;
    engine: PermissionEngine;
    memory: MemoryService;
    now?: () => Date;
  }) {
    this.#store = ContactStore.open(options.dataDir);
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#engine = options.engine;
    this.#memory = options.memory;
    this.#now = options.now ?? (() => new Date());
  }

  // --- 邀请与联系人 -----------------------------------------------------------

  createInvite(input: CreateInviteInput = {}): ContactInviteView {
    const now = this.#now();
    let contactId: string | null = null;
    if (input.contact_id !== undefined) {
      if (typeof input.contact_id !== "string" || input.contact_id.trim().length === 0) {
        throw new ContactError("invalid_input", "contact_id must be a non-empty string when present");
      }
      contactId = input.contact_id.trim();
      if (this.#store.getContact(contactId) === null) {
        throw new ContactError("not_found", `contact "${contactId}" does not exist`);
      }
    }
    const displayName = typeof input.display_name === "string" ? input.display_name.trim() : "";
    if (input.display_name !== undefined && displayName.length === 0) {
      throw new ContactError("invalid_input", "display_name must be a non-empty string when present");
    }
    if (contactId === null) {
      contactId = this.#store.createContact(displayName.length > 0 ? displayName : "Trusted Contact", now).contact_id;
    }

    const ttl = input.ttl_ms === undefined ? DEFAULT_INVITE_TTL_MS : input.ttl_ms;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_INVITE_TTL_MS) {
      throw new ContactError("invalid_input", `ttl_ms must be an integer within (0, ${MAX_INVITE_TTL_MS}]`);
    }

    const code = this.#generateCode();
    const inviteId = uuidv7();
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    this.#store.createInvite({
      inviteId,
      codeHash: hashCode(code),
      contactId,
      expiresAt,
      now,
    });
    this.#append(CONTACT_EVENT_TYPES.invited, {
      invite_id: inviteId,
      contact_id: contactId,
      expires_at: expiresAt,
    });
    return {
      invite_id: inviteId,
      contact_id: contactId,
      code,
      expires_at: expiresAt,
      created_at: now.toISOString(),
    };
  }

  listContacts(): ContactView[] {
    return this.#store.listContacts().map((contact) => ({
      contact_id: contact.contact_id,
      display_name: contact.display_name,
      status: contact.status,
      grants: this.#grantViews(contact.contact_id),
      identities: this.#store.listIdentities(contact.contact_id),
      created_at: contact.created_at,
      updated_at: contact.updated_at,
    }));
  }

  getGrants(contactId: string): ContactGrantView[] {
    if (this.#store.getContact(contactId) === null) {
      throw new ContactError("not_found", `contact "${contactId}" does not exist`);
    }
    return this.#grantViews(contactId);
  }

  setGrants(contactId: string, input: unknown): ContactGrantView[] {
    if (this.#store.getContact(contactId) === null) {
      throw new ContactError("not_found", `contact "${contactId}" does not exist`);
    }
    const grants = this.#parseGrants(input);
    this.#store.setGrants(contactId, grants, this.#now());
    const views = this.#grantViews(contactId);
    this.#append(CONTACT_EVENT_TYPES.grantsUpdated, {
      contact_id: contactId,
      grants: views.map((grant) => ({ category: grant.category, scope: grant.scope })),
    });
    return views;
  }

  // --- 渠道接缝（ContactBindingResolver） -------------------------------------

  matchContacts(accountId: string, nativeSenderId: string): string[] {
    return this.#store.findContactsForSender(accountId, nativeSenderId);
  }

  bindFromCode(input: {
    channel: string;
    accountId: string;
    nativeSenderId: string;
    text: string;
    displayName?: string | null;
  }): { bound: boolean; contactId?: string; inviteId?: string; reason?: string } {
    const code = input.text.trim().toUpperCase();
    if (!INVITE_CODE_RE.test(code)) return { bound: false, reason: "invite_invalid" };
    const invite = this.#store.findInviteByCodeHash(hashCode(code));
    if (invite === null) return { bound: false, reason: "invite_invalid" };
    if (invite.used_at !== null) return { bound: false, reason: "invite_used" };
    if (new Date(invite.expires_at).getTime() <= this.#now().getTime()) {
      return { bound: false, reason: "invite_expired" };
    }
    if (this.#store.getContact(invite.contact_id) === null) return { bound: false, reason: "contact_not_found" };
    const bound = this.#store.consumeInvite({
      inviteId: invite.invite_id,
      contactId: invite.contact_id,
      accountId: input.accountId,
      nativeSenderId: input.nativeSenderId,
      displayName: input.displayName ?? null,
      now: this.#now(),
    });
    if (!bound) return { bound: false, reason: "invite_used" };
    this.#append(CONTACT_EVENT_TYPES.bound, {
      contact_id: invite.contact_id,
      invite_id: invite.invite_id,
      channel: input.channel,
      account_id: input.accountId,
      native_sender_id: input.nativeSenderId,
    }, `contact:${invite.contact_id}`);
    return { bound: true, contactId: invite.contact_id, inviteId: invite.invite_id };
  }

  recordAmbiguity(accountId: string, nativeSenderId: string, candidateContactIds: string[]): string {
    const existing = this.#store.findOpenAmbiguity(accountId, nativeSenderId);
    if (existing !== null) return existing.ambiguity_id;
    const ambiguity = this.#store.recordAmbiguity({
      accountId,
      nativeSenderId,
      candidateContactIds,
      now: this.#now(),
    });
    this.#append(CONTACT_EVENT_TYPES.ambiguityDetected, {
      ambiguity_id: ambiguity.ambiguity_id,
      account_id: accountId,
      native_sender_id: nativeSenderId,
      candidate_contact_ids: candidateContactIds,
    });
    return ambiguity.ambiguity_id;
  }

  recordContactSession(input: {
    contactId: string;
    sessionId: string;
    accountId: string;
    nativeConversationId: string;
  }): void {
    this.#store.recordContactSession({ ...input, now: this.#now() });
  }

  resolveCategories(
    principal: ChannelPermissionContext["principal"],
    contactId: string | null,
    fallback: string[],
  ): string[] {
    if (principal === "owner") return ["*"];
    if (contactId === null) return fallback;
    const categories = this.#engine.contactCategories(contactId);
    return categories === null ? fallback : categories;
  }

  // --- 歧义控制面 -------------------------------------------------------------

  listAmbiguities(filter: { status?: "open" | "resolved" } = {}): ContactAmbiguityView[] {
    return this.#store.listAmbiguities(filter).map((row) => ({
      ambiguity_id: row.ambiguity_id,
      account_id: row.account_id,
      native_sender_id: row.native_sender_id,
      candidate_contact_ids: row.candidate_contact_ids,
      status: row.status,
      resolved_contact_id: row.resolved_contact_id,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    }));
  }

  resolveAmbiguity(ambiguityId: string, contactId: string): ContactAmbiguityView {
    const ambiguity = this.#store.getAmbiguity(ambiguityId);
    if (ambiguity === null) {
      throw new ContactError("not_found", `ambiguity "${ambiguityId}" does not exist`);
    }
    if (ambiguity.status === "resolved") {
      throw new ContactError("invalid_state", `ambiguity "${ambiguityId}" is already resolved`);
    }
    if (!ambiguity.candidate_contact_ids.includes(contactId)) {
      throw new ContactError(
        "invalid_input",
        `contact "${contactId}" is not a candidate for ambiguity "${ambiguityId}" (candidates: ${ambiguity.candidate_contact_ids.join(", ")})`,
      );
    }
    if (this.#store.getContact(contactId) === null) {
      throw new ContactError("not_found", `contact "${contactId}" does not exist`);
    }
    this.#store.keepOnlyIdentity(ambiguity.account_id, ambiguity.native_sender_id, contactId);
    const resolved = this.#store.resolveAmbiguity(ambiguityId, contactId, this.#now());
    if (resolved === null) {
      throw new ContactError("invalid_state", `ambiguity "${ambiguityId}" could not be resolved`);
    }
    this.#append(CONTACT_EVENT_TYPES.ambiguityResolved, {
      ambiguity_id: ambiguityId,
      contact_id: contactId,
      account_id: ambiguity.account_id,
      native_sender_id: ambiguity.native_sender_id,
    });
    return {
      ambiguity_id: resolved.ambiguity_id,
      account_id: resolved.account_id,
      native_sender_id: resolved.native_sender_id,
      candidate_contact_ids: resolved.candidate_contact_ids,
      status: resolved.status,
      resolved_contact_id: resolved.resolved_contact_id,
      created_at: resolved.created_at,
      resolved_at: resolved.resolved_at,
    };
  }

  // --- 记忆引用（检索层 public 过滤） -----------------------------------------

  /**
   * 联系人记忆引用检索：memory_reference 类别 + Sensitivity=public。
   * 判定走 PermissionEngine；命中来自 MemoryService 的检索层过滤（不是返回后再筛）。
   */
  searchMemory(contactId: string, query: string): ReturnType<MemoryService["search"]> {
    const decision = this.#engine.authorizeContactUse({
      contact_id: contactId,
      action: "memory_read",
      sensitivity: "public",
    });
    if (!decision.allowed) return [];
    return this.#memory.search(query, { sensitivity: "public" });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  // --- 内部 -------------------------------------------------------------------

  #grantViews(contactId: string): ContactGrantView[] {
    return this.#store.listGrants(contactId).map((grant: ContactGrantRow) => ({
      category: grant.category,
      scope: grant.scope,
      created_at: grant.created_at,
      updated_at: grant.updated_at,
    }));
  }

  #parseGrants(input: unknown): ResolvedGrantInput[] {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new ContactError("invalid_input", "body must be an object like { grants: [{ category, scope? }] }");
    }
    const body = input as { grants?: unknown; categories?: unknown; scopes?: unknown };
    let raw: unknown = body.grants;
    // 兼容简写：{ categories: ["query"], scopes: { task_execute: ["cap.x"] } }
    if (raw === undefined && body.categories !== undefined) {
      if (!Array.isArray(body.categories)) {
        throw new ContactError("invalid_input", "categories must be an array of category strings");
      }
      const scopes =
        typeof body.scopes === "object" && body.scopes !== null && !Array.isArray(body.scopes)
          ? (body.scopes as Record<string, unknown>)
          : {};
      raw = body.categories.map((category) => ({ category, scope: scopes[String(category)] }));
    }
    if (!Array.isArray(raw)) {
      throw new ContactError("invalid_input", "grants must be an array");
    }
    const out: ResolvedGrantInput[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new ContactError("invalid_input", "each grant must be an object");
      }
      const category = (entry as { category?: unknown }).category;
      if (!isContactCategory(category)) {
        throw new ContactError(
          "invalid_input",
          `grant category must be one of ${CONTACT_CAPABILITY_CATEGORIES.join(" | ")}`,
        );
      }
      if (seen.has(category)) {
        throw new ContactError("invalid_input", `duplicate grant category "${category}"`);
      }
      seen.add(category);
      const scopeRaw = (entry as { scope?: unknown }).scope;
      let scope: string[] = [];
      if (scopeRaw !== undefined) {
        if (!Array.isArray(scopeRaw) || scopeRaw.some((value) => typeof value !== "string" || value.trim().length === 0)) {
          throw new ContactError("invalid_input", "grant scope must be an array of non-empty strings");
        }
        scope = [...new Set((scopeRaw as string[]).map((value) => value.trim()))];
      }
      out.push({ category, scope });
    }
    return out;
  }

  #generateCode(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = `MC-${randomBytes(5).toString("hex").toUpperCase()}`;
      if (this.#store.findInviteByCodeHash(hashCode(code)) === null) return code;
    }
    throw new ContactError("invalid_state", "could not generate a unique invite code");
  }

  #append(eventType: string, payload: Record<string, unknown>, actorId: "owner" | `contact:${string}` | "agent:runtime" = "owner"): void {
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId,
        eventType,
        payload,
      }),
    );
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}
