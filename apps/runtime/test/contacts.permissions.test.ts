// 可信联系人与群聊权限端到端契约（M4-T6 / Issue #43，PRD §4.8 FR-NOT-3 / §7 / AC-13）：
// - 一次性邀请码（过期/已用拒绝）→ 渠道回复绑定 → 默认仅 query；
// - 五类越权（private 记忆/文件/开发工具/未授权能力/他人会话）全部阻断并留痕；
// - 记忆引用在检索层强制 sensitivity=public（private 混合数据不进结果）；
// - 群聊白名单端点 + mention_only 未 @ 不响应；proactive_limited 语义；
// - 同一平台发送者匹配多个联系人 → 需要 Owner 选择，不自动合并。
// 全部注入 FakePi/内存时钟：零网络、零真实等待。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { InboundMessage, SensitivityLevel } from "@morrow/protocol";
import { buildEventEnvelope } from "../src/envelope.ts";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import type { MemoryExtractor } from "../src/memory/extraction.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SESSION = "01936b9d-8f7a-7abc-9f2e-0000000000f6";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function fakeFactory() {
  return async () => createFakePi({ script: [{ kind: "text", deltas: ["ack"] }] });
}

function clock(startIso = "2026-01-01T00:00:00.000Z"): { now(): Date; advance(ms: number): void } {
  let current = new Date(startIso);
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

interface Harness {
  runtime: RuntimeHandle;
  dir: string;
  dispose(): Promise<void>;
}

async function start(options: {
  clock?: { now(): Date; advance(ms: number): void };
  extractor?: MemoryExtractor;
} = {}): Promise<Harness> {
  const dir = tmpDir("morrow-contacts-");
  const runtime = await startRuntime(testConfig(dir), {
    enableEchoChannel: true,
    agentAdapterFactory: fakeFactory(),
    ...(options.clock === undefined ? {} : { contactNow: options.clock.now }),
    ...(options.extractor === undefined ? {} : { memoryExtractor: options.extractor }),
  });
  return {
    runtime,
    dir,
    async dispose() {
      await runtime.close();
      removeDir(dir);
    },
  };
}

let seq = 0;

function inbound(overrides: {
  sender?: string;
  text?: string;
  conversation?: string;
  kind?: "direct" | "group";
  mention?: boolean;
} = {}): InboundMessage {
  seq += 1;
  return {
    channel: "echo",
    account: "echo-default",
    native_message_id: `m-${seq}`,
    native_conversation_id: overrides.conversation ?? `dm-${overrides.sender ?? "owner"}`,
    conversation_kind: overrides.kind ?? "direct",
    sender: { native_id: overrides.sender ?? "owner", display_name: overrides.sender ?? "Owner" },
    mention: { agent: overrides.mention ?? false },
    attachments: [],
    timestamp: "2026-11-10T09:00:00.000Z",
    text: overrides.text ?? "hello",
    permission_context: null,
  };
}

async function postJson<T>(port: number, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function putJson<T>(port: number, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function getJson<T>(port: number, path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

interface Invite {
  invite_id: string;
  contact_id: string;
  code: string;
  expires_at: string;
  created_at: string;
}

interface ContactList {
  contacts: Array<{
    contact_id: string;
    display_name: string;
    grants: Array<{ category: string; scope: string[] }>;
    identities: Array<{ account_id: string; native_sender_id: string }>;
  }>;
}

interface GrantList {
  contact_id: string;
  grants: Array<{ category: string; scope: string[] }>;
}

interface Ambiguity {
  ambiguity_id: string;
  candidate_contact_ids: string[];
  status: string;
  resolved_contact_id: string | null;
}

async function createInvite(h: Harness, body: Record<string, unknown> = {}): Promise<Invite> {
  const res = await postJson<Invite>(h.runtime.port, "/v1/contacts/invites", body);
  assert.equal(res.status, 201);
  return res.body;
}

function rejectionDetails(h: Harness): Array<{ reason: unknown; detail: unknown }> {
  return h.runtime.ledger.scan({ eventType: "channel.inbound_rejected" }).map((entry) => ({
    reason: entry.envelope.payload.reason,
    detail: entry.envelope.payload.detail,
  }));
}

function contactEvents(h: Harness, eventType: string): number {
  return h.runtime.ledger.scan({ eventType }).length;
}

test("invite code binds a channel identity once, is rejected after use, and defaults to query-only", async (t) => {
  const h = await start();
  t.after(() => h.dispose());

  const invite = await createInvite(h, { display_name: "Alice" });
  assert.match(invite.code, /^MC-[0-9A-F]{10}$/);

  // 绑定前：联系人只有默认 query 授权
  const listed = await getJson<ContactList>(h.runtime.port, "/v1/contacts");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.contacts.length, 1);
  assert.deepEqual(
    listed.body.contacts[0]?.grants.map((grant) => [grant.category, grant.scope]),
    [["query", []]],
  );

  const bound = h.runtime.channels.routeInbound(inbound({ sender: "alice", text: invite.code }));
  assert.equal(bound.decision, "processed");
  assert.equal(contactEvents(h, "contact.bound"), 1);

  const received = h.runtime.ledger.scan({ eventType: "channel.inbound_received" });
  const permission = received[0]?.envelope.payload.permission_context as Record<string, unknown>;
  assert.equal(permission.principal, `contact:${invite.contact_id}`);
  assert.deepEqual(permission.granted_categories, ["query"]);

  const contacts = await getJson<ContactList>(h.runtime.port, "/v1/contacts");
  assert.deepEqual(contacts.body.contacts[0]?.identities.map((identity) => identity.native_sender_id), ["alice"]);

  // 一次性：同一码从另一发送者回复 → 不绑定，留痕 invite_used
  const replay = h.runtime.channels.routeInbound(inbound({ sender: "mallory", text: invite.code }));
  assert.equal(replay.decision, "rejected");
  assert.equal(replay.reason, "unknown_sender");
  assert.equal(rejectionDetails(h).at(-1)?.detail, "invite_used");
  assert.equal(contactEvents(h, "contact.bound"), 1);
});

test("expired invite codes are rejected without binding", async (t) => {
  const c = clock();
  const h = await start({ clock: c });
  t.after(() => h.dispose());

  const invite = await createInvite(h, { display_name: "Bob", ttl_ms: 1000 });
  c.advance(2000);

  const result = h.runtime.channels.routeInbound(inbound({ sender: "bob", text: invite.code }));
  assert.equal(result.decision, "rejected");
  assert.equal(result.reason, "unknown_sender");
  assert.equal(rejectionDetails(h).at(-1)?.detail, "invite_expired");
  assert.equal(contactEvents(h, "contact.bound"), 0);
});

test("all five unauthorized contact actions are blocked and audited through PermissionEngine", async (t) => {
  const h = await start();
  t.after(() => h.dispose());

  const invite = await createInvite(h, { display_name: "Carol" });
  const bound = h.runtime.channels.routeInbound(
    inbound({ sender: "carol", text: invite.code, conversation: "dm-carol" }),
  );
  assert.equal(bound.decision, "processed");
  const contactId = invite.contact_id;
  const ownSession = bound.session_id as string;

  const grants = await putJson<GrantList>(h.runtime.port, `/v1/contacts/${contactId}/grants`, {
    grants: [
      { category: "memory_reference" },
      { category: "task_execute", scope: ["allowed.capability"] },
    ],
  });
  assert.equal(grants.status, 200);
  assert.deepEqual(grants.body.grants.map((grant) => grant.category).sort(), ["memory_reference", "task_execute"]);

  const ownerSession = h.runtime.sessions.createSession("owner private session").sessionId;

  // 1) private 记忆
  const privateMemory = h.runtime.capabilities.authorizeContactUse({
    contact_id: contactId,
    action: "memory_read",
    sensitivity: "private",
  });
  assert.equal(privateMemory.allowed, false);
  assert.equal(privateMemory.reason, "private_memory_denied");

  // 2) 读文件
  const filesystem = h.runtime.capabilities.authorizeContactUse({
    contact_id: contactId,
    action: "filesystem",
    path: "/Users/owner/secrets.txt",
  });
  assert.equal(filesystem.allowed, false);
  assert.equal(filesystem.reason, "filesystem_denied");

  // 3) 开发工具/命令
  const shell = h.runtime.capabilities.authorizeContactUse({
    contact_id: contactId,
    action: "shell",
    category: "arbitrary",
  });
  assert.equal(shell.allowed, false);
  assert.equal(shell.reason, "dev_tools_denied");

  // 4) 未授权能力（scope 没声明的能力名）
  const capability = h.runtime.capabilities.authorizeContactUse({
    contact_id: contactId,
    action: "capability",
    capability: "memory.write",
  });
  assert.equal(capability.allowed, false);
  assert.equal(capability.reason, "capability_not_granted");

  // 5) 读他人会话（Owner 会话）vs 自己的渠道会话
  const otherSession = h.runtime.capabilities.authorizeContactUse({
    contact_id: contactId,
    action: "session",
    session_id: ownerSession,
  });
  assert.equal(otherSession.allowed, false);
  assert.equal(otherSession.reason, "session_not_owned");
  const own = h.runtime.capabilities.authorizeContactUse({
    contact_id: contactId,
    action: "session",
    session_id: ownSession,
  });
  assert.equal(own.allowed, true);

  // 能力注入面：联系人会话只拿到 scope 声明的能力名；Owner 会话不受收窄
  assert.deepEqual(h.runtime.capabilities.contactCapabilitiesForSession(ownSession), ["allowed.capability"]);
  assert.equal(h.runtime.capabilities.contactCapabilitiesForSession(ownerSession), null);

  // 公开记忆在 memory_reference 下允许（对照组）
  assert.equal(
    h.runtime.capabilities.authorizeContactUse({
      contact_id: contactId,
      action: "memory_read",
      sensitivity: "public",
    }).allowed,
    true,
  );

  // 显式授权 memory.write（scope 声明）后，能力判定才放行；再收回 scope 又拒绝
  await putJson(h.runtime.port, `/v1/contacts/${contactId}/grants`, {
    grants: [
      { category: "memory_reference" },
      { category: "task_execute", scope: ["memory.write"] },
    ],
  });
  assert.deepEqual(h.runtime.capabilities.contactCapabilitiesForSession(ownSession), ["memory.write"]);
  assert.equal(
    h.runtime.capabilities.authorizeContactUse({
      contact_id: contactId,
      action: "capability",
      capability: "memory.write",
    }).allowed,
    true,
  );

  const denials = h.runtime.ledger.scan({ eventType: "contact.permission_denied" });
  assert.equal(denials.length, 5);
  assert.deepEqual(
    denials.map((entry) => entry.envelope.payload.reason).sort(),
    ["capability_not_granted", "dev_tools_denied", "filesystem_denied", "private_memory_denied", "session_not_owned"],
  );
  for (const denial of denials) {
    assert.equal(denial.envelope.actor_id, `contact:${contactId}`);
  }
});

test("memory_reference retrieval filters private memories at the retrieval layer", async (t) => {
  const level: { current: SensitivityLevel } = { current: "private" };
  const extractor: MemoryExtractor = {
    extract(input) {
      return [
        {
          content: input.userText,
          // kind 不同避免巩固器把两条同关键词内容当成事实冲突（本测试只关心检索层过滤）
          kind: level.current === "public" ? "preference" : "fact",
          confidence: 0.95,
          sensitivity: level.current,
          rule: "test-extractor",
        },
      ];
    },
  };
  const h = await start({ extractor });
  t.after(() => h.dispose());

  const invite = await createInvite(h, { display_name: "Dave" });
  const bound = h.runtime.channels.routeInbound(inbound({ sender: "dave", text: invite.code, conversation: "dm-dave" }));
  assert.equal(bound.decision, "processed");
  await putJson(h.runtime.port, `/v1/contacts/${invite.contact_id}/grants`, {
    grants: [{ category: "memory_reference" }],
  });

  // 混合数据：同一关键词下 public + private 各一条，均巩固为事实
  async function seed(text: string, sensitivity: SensitivityLevel): Promise<void> {
    level.current = sensitivity;
    const user = buildEventEnvelope({
      replicaId: REPLICA,
      actorId: "owner",
      eventType: "message.user",
      sessionId: SESSION,
      payload: { text },
    });
    h.runtime.ledger.append(user);
    const run = await h.runtime.memory.extractTurn({
      sessionId: SESSION,
      userEventId: user.event_id,
      occurredAt: user.occurred_at,
      text,
    });
    assert.ok((run.consolidation?.createdFactIds.length ?? 0) >= 1, `fact not created for ${text}`);
    level.current = "private";
  }

  await seed("项目代号 Alpha 是对外公开的介绍", "public");
  await seed("项目代号 Omega 是 Owner 的私人计划", "private");

  // 普通检索（Owner 面）能看到两条数据的候选与事实索引
  const ownerHits = h.runtime.memory.search("项目代号");
  assert.equal(ownerHits.length, 4);
  assert.deepEqual([...new Set(ownerHits.map((hit) => hit.sensitivity))].sort(), ["private", "public"]);

  // 联系人记忆引用：检索层就只返回 public（private 从未进入结果集）
  const hits = h.runtime.contacts.searchMemory(invite.contact_id, "项目代号");
  assert.equal(hits.length, 2);
  assert.ok(hits.every((hit) => hit.sensitivity === "public"));
  assert.ok(hits.every((hit) => hit.content.includes("Alpha")));
});

test("group allowlist endpoint replaces entries with audit; non-allowlisted groups stay silent", async (t) => {
  const h = await start();
  t.after(() => h.dispose());

  const put = await putJson<{ channel: string; account_id: string; allowlist: Array<{ native_conversation_id: string; mode: string }> }>(
    h.runtime.port,
    "/v1/channels/echo/allowlist",
    {
      allowlist: [
        { native_conversation_id: "group-1", mode: "mention_only" },
        { native_conversation_id: "group-2", mode: "proactive_limited" },
      ],
    },
  );
  assert.equal(put.status, 200);
  assert.deepEqual(
    put.body.allowlist.map((entry) => [entry.native_conversation_id, entry.mode]),
    [
      ["group-1", "mention_only"],
      ["group-2", "proactive_limited"],
    ],
  );

  const listed = await getJson<{ allowlist: Array<{ native_conversation_id: string; mode: string }> }>(
    h.runtime.port,
    "/v1/channels/echo/allowlist",
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.allowlist.length, 2);
  assert.equal(contactEvents(h, "channel.allowlist_updated"), 1);

  // 未列入白名单的群：即使 @ 也不响应
  const notListed = h.runtime.channels.routeInbound(
    inbound({ kind: "group", conversation: "group-3", mention: true, text: "hi @agent" }),
  );
  assert.equal(notListed.decision, "rejected");
  assert.equal(notListed.reason, "conversation_not_allowed");

  // mention_only：白名单内未 @ 不插话
  const notMentioned = h.runtime.channels.routeInbound(
    inbound({ kind: "group", conversation: "group-1", mention: false, text: "chatter" }),
  );
  assert.equal(notMentioned.decision, "rejected");
  assert.equal(notMentioned.reason, "group_mention_required");

  // mention_only + @：处理
  const mentioned = h.runtime.channels.routeInbound(
    inbound({ kind: "group", conversation: "group-1", mention: true, text: "hi @agent" }),
  );
  assert.equal(mentioned.decision, "processed");

  // proactive_limited：白名单内允许有限主动参与（无 @ 也处理）
  const proactive = h.runtime.channels.routeInbound(
    inbound({ kind: "group", conversation: "group-2", mention: false, text: "status?" }),
  );
  assert.equal(proactive.decision, "processed");
});

test("a platform sender matching multiple contacts requires Owner selection, never auto-merge", async (t) => {
  const h = await start();
  t.after(() => h.dispose());

  const inviteA = await createInvite(h, { display_name: "Eve A" });
  const inviteB = await createInvite(h, { display_name: "Eve B" });

  const first = h.runtime.channels.routeInbound(inbound({ sender: "eve", text: inviteA.code, conversation: "dm-eve" }));
  assert.equal(first.decision, "processed");

  // 同一发送者再回复另一个邀请码 → 两个联系人匹配 = 歧义（码已消费绑定，但消息不处理）
  const second = h.runtime.channels.routeInbound(inbound({ sender: "eve", text: inviteB.code, conversation: "dm-eve" }));
  assert.equal(second.decision, "rejected");
  assert.equal(second.reason, "identity_ambiguous");
  assert.equal(contactEvents(h, "contact.bound"), 2);

  const ambiguities = await getJson<{ ambiguities: Ambiguity[] }>(h.runtime.port, "/v1/contacts/ambiguities?status=open");
  assert.equal(ambiguities.status, 200);
  assert.equal(ambiguities.body.ambiguities.length, 1);
  const ambiguity = ambiguities.body.ambiguities[0] as Ambiguity;
  assert.deepEqual([...ambiguity.candidate_contact_ids].sort(), [inviteA.contact_id, inviteB.contact_id].sort());

  // 歧义未解决前普通消息仍被阻断（不猜测）
  const still = h.runtime.channels.routeInbound(inbound({ sender: "eve", text: "are you there?", conversation: "dm-eve" }));
  assert.equal(still.decision, "rejected");
  assert.equal(still.reason, "identity_ambiguous");

  // Owner 选择 B
  const resolved = await postJson<Ambiguity>(
    h.runtime.port,
    `/v1/contacts/ambiguities/${ambiguity.ambiguity_id}/resolve`,
    { contact_id: inviteB.contact_id },
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.status, "resolved");
  assert.equal(resolved.body.resolved_contact_id, inviteB.contact_id);
  assert.equal(contactEvents(h, "contact.ambiguity_resolved"), 1);

  const after = h.runtime.channels.routeInbound(inbound({ sender: "eve", text: "now routed", conversation: "dm-eve" }));
  assert.equal(after.decision, "processed");
  const received = h.runtime.ledger.scan({ eventType: "channel.inbound_received" }).at(-1);
  const permission = received?.envelope.payload.permission_context as Record<string, unknown>;
  assert.equal(permission.principal, `contact:${inviteB.contact_id}`);

  const open = await getJson<{ ambiguities: Ambiguity[] }>(h.runtime.port, "/v1/contacts/ambiguities?status=open");
  assert.equal(open.body.ambiguities.length, 0);
});
