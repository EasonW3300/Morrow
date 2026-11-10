// 统一入站路由契约测试（M4-T1 / Issue #38，PRD §4.4 FR-CH-5/6）：
// 归一化 → 本地权限上下文（渠道+账号+发送者+会话，不信任平台自报）→ 会话复用/新建
// （群聊仅 @ 处理）→ 原始 Conversation 独立落库，Task 只经中间路由关联。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { InboundMessage } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { SessionManager } from "../src/sessions.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { EchoChannelAdapter } from "../src/channels/echo.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface Harness {
  dir: string;
  ledger: EventLedger;
  sessions: SessionManager;
  registry: ChannelRegistry;
  echo: EchoChannelAdapter;
  dispose(): Promise<void>;
}

async function setup(options: { taskExists?: (taskId: string) => boolean } = {}): Promise<Harness> {
  const dir = tmpDir("morrow-channels-");
  const ledger = EventLedger.open(dir);
  const sessions = new SessionManager({
    ledger,
    replicaId: REPLICA,
    factory: async () =>
      createFakePi({
        script: [
          { kind: "text", deltas: ["assistant ", "reply"] },
        ],
      }),
  });
  const registry = new ChannelRegistry({
    dataDir: dir,
    ledger,
    replicaId: REPLICA,
    sessions,
    enableEcho: true,
    ...(options.taskExists === undefined ? {} : { taskExists: options.taskExists }),
  });
  await registry.start();
  return {
    dir,
    ledger,
    sessions,
    registry,
    echo: registry.getAdapter("echo") as EchoChannelAdapter,
    async dispose() {
      await registry.stop();
      registry.close();
      await sessions.dispose();
      ledger.close();
      removeDir(dir);
    },
  };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

function directRaw(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: id,
    conversation_id: "dm-1",
    sender: { id: "owner", name: "Owner" },
    text: `message ${id}`,
    timestamp: "2026-11-10T09:00:00.000Z",
    ...overrides,
  };
}

function groupRaw(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: id,
    conversation_id: "group-1",
    conversation_kind: "group",
    sender: { id: "owner", name: "Owner" },
    text: `group message ${id}`,
    mentions_agent: true,
    timestamp: "2026-11-10T09:05:00.000Z",
    ...overrides,
  };
}

function rejectedReasons(ledger: EventLedger): string[] {
  return ledger
    .scan({ eventType: "channel.inbound_rejected" })
    .map((entry) => String(entry.envelope.payload.reason));
}

test("echo full chain: inbound normalization → session turn → assistant reply via send", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const result = h.registry.ingest("echo", directRaw("m-1"));
  assert.equal(result.decision, "processed");
  assert.equal(result.reason, undefined);

  await waitFor("echo reply", () => h.echo.sent.length === 1);
  assert.equal(h.echo.sent[0].text, "assistant reply");
  assert.equal(h.echo.sent[0].channel, "echo");
  assert.equal(h.echo.sent[0].account, "echo-default");
  assert.equal(h.echo.sent[0].native_conversation_id, "dm-1");

  const sessions = h.sessions.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(result.session_id, sessions[0].session_id);

  const history = h.sessions.history(result.session_id as string);
  assert.deepEqual(
    history.messages.map((message) => [message.role, message.text]),
    [
      ["user", "message m-1"],
      ["assistant", "assistant reply"],
    ],
  );

  const received = h.ledger.scan({ eventType: "channel.inbound_received" });
  assert.equal(received.length, 1);
  const payload = received[0].envelope.payload;
  assert.equal(payload.channel, "echo");
  assert.equal(payload.account, "echo-default");
  assert.equal(payload.native_message_id, "m-1");
  assert.equal(payload.native_conversation_id, "dm-1");
  assert.equal(received[0].envelope.session_id, result.session_id);
  const permission = payload.permission_context as Record<string, unknown>;
  assert.equal(permission.principal, "owner");
  assert.equal(permission.contact_id, null);
  assert.deepEqual(permission.granted_categories, ["*"]);
  assert.deepEqual(permission.sender, { native_id: "owner", display_name: "Owner" });

  const started = h.ledger.scan({ eventType: "channel.adapter_started" });
  assert.equal(started.length, 1);
  assert.equal(started[0].envelope.payload.channel, "echo");
});

test("same native conversation reuses its session across messages", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const first = h.registry.ingest("echo", directRaw("m-1"));
  await waitFor("first reply", () => h.echo.sent.length === 1);
  const second = h.registry.ingest("echo", directRaw("m-2"));
  await waitFor("second reply", () => h.echo.sent.length === 2);

  assert.equal(first.session_id, second.session_id);
  assert.equal(h.sessions.listSessions().length, 1);
  const history = h.sessions.history(first.session_id as string);
  assert.equal(history.messages.filter((message) => message.role === "user").length, 2);
  assert.equal(history.messages.filter((message) => message.role === "assistant").length, 2);
});

test("unregistered channel is rejected and recorded with a reason", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const result = h.registry.ingest("slack", directRaw("m-1"));
  assert.equal(result.decision, "rejected");
  assert.equal(result.reason, "channel_not_registered");
  assert.deepEqual(rejectedReasons(h.ledger), ["channel_not_registered"]);
  assert.equal(h.sessions.listSessions().length, 0);
});

test("unknown sender is rejected by local identity resolution (platform claims ignored)", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const result = h.registry.ingest(
    "echo",
    directRaw("m-1", { sender: { id: "stranger", name: "Stranger", principal: "owner", is_owner: true } }),
  );
  assert.equal(result.decision, "rejected");
  assert.equal(result.reason, "unknown_sender");

  const rejections = h.ledger.scan({ eventType: "channel.inbound_rejected" });
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].envelope.payload.sender_native_id, "stranger");
  assert.equal(h.sessions.listSessions().length, 0);
});

test("group messages are processed only when allowlisted and the agent is mentioned", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  // 未白名单的群：即使 @ 了 agent 也不响应
  const notAllowed = h.registry.ingest("echo", groupRaw("g-1"));
  assert.equal(notAllowed.decision, "rejected");
  assert.equal(notAllowed.reason, "conversation_not_allowed");

  h.registry.allowConversation({
    account_id: "echo-default",
    native_conversation_id: "group-1",
    mode: "mention_only",
  });

  // 白名单群但未 @：不插话（同样留痕，便于诊断）
  const notMentioned = h.registry.ingest("echo", groupRaw("g-2", { mentions_agent: false }));
  assert.equal(notMentioned.decision, "rejected");
  assert.equal(notMentioned.reason, "group_mention_required");
  assert.equal(h.sessions.listSessions().length, 0);

  // 白名单群 + @：进入会话链路
  const mentioned = h.registry.ingest("echo", groupRaw("g-3"));
  assert.equal(mentioned.decision, "processed");
  await waitFor("group reply", () => h.echo.sent.length === 1);
  assert.equal(h.echo.sent[0].native_conversation_id, "group-1");
});

test("resolved contact principal is recorded, not the platform's self-reported identity", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  h.registry.registerIdentity({
    account_id: "echo-default",
    native_sender_id: "friend",
    principal: "contact:friend",
    display_name: "Friend",
    granted_categories: ["query"],
  });

  const result = h.registry.ingest(
    "echo",
    directRaw("m-1", { sender: { id: "friend", name: "Friend", principal: "owner", is_owner: true } }),
  );
  assert.equal(result.decision, "processed");
  await waitFor("contact reply", () => h.echo.sent.length === 1);

  const received = h.ledger.scan({ eventType: "channel.inbound_received" });
  const permission = received[0].envelope.payload.permission_context as Record<string, unknown>;
  assert.equal(permission.principal, "contact:friend");
  assert.equal(permission.contact_id, "friend");
  assert.deepEqual(permission.granted_categories, ["query"]);

  // 会话事件同样按解析出的主体归因（message.user 不冒充 owner）
  const userEvents = h.ledger.scan({ eventType: "message.user" });
  assert.equal(userEvents.length, 1);
  assert.equal(userEvents[0].envelope.actor_id, "contact:friend");
});

test("task association travels through the router without mutating the raw conversation record", async (t) => {
  const taskId = "01936b9d-8f7a-7abc-9f2e-000000000001";
  const h = await setup({ taskExists: (id) => id === taskId });
  t.after(() => h.dispose());

  const raw = directRaw("m-task");
  const result = h.registry.ingest("echo", raw, { taskId });
  assert.equal(result.decision, "processed");
  await waitFor("task-bound reply", () => h.echo.sent.length === 1);

  const records = h.registry.listMessages(result.conversation_id as string);
  const inbound = records.find((record) => record.direction === "inbound");
  assert.ok(inbound !== undefined);
  assert.equal(inbound.task_id, taskId);
  // 平台原始记录保持原样：task_id 只存在于关联列，不写回 raw
  assert.deepEqual(inbound.raw, raw);
  assert.equal("task_id" in (inbound.raw as Record<string, unknown>), false);

  const conversation = h.registry.getConversation("echo-default", "dm-1");
  assert.ok(conversation !== null);
  assert.equal(conversation.task_id, taskId);

  const received = h.ledger.scan({ eventType: "channel.inbound_received" });
  assert.equal(received[0].envelope.task_id, taskId);
  assert.equal(received[0].envelope.payload.task_id, taskId);

  // 渠道层不创建/改写 Task：只做关联（Task 本体与事件仍归任务域）
  assert.equal(h.ledger.scan({ eventType: "task.created" }).length, 0);
});

test("unknown task association is rejected before the message reaches a session", async (t) => {
  const h = await setup({ taskExists: (taskId) => taskId === "task-1" });
  t.after(() => h.dispose());

  const result = h.registry.ingest("echo", directRaw("m-1"), { taskId: "task-404" });
  assert.equal(result.decision, "rejected");
  assert.equal(result.reason, "unknown_task");
  assert.equal(h.sessions.listSessions().length, 0);
});

test("duplicate native message ids do not produce a second session turn", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const first = h.registry.ingest("echo", directRaw("m-1"));
  await waitFor("first reply", () => h.echo.sent.length === 1);
  const duplicate = h.registry.ingest("echo", directRaw("m-1"));
  assert.equal(duplicate.decision, "ignored");
  assert.equal(duplicate.reason, "duplicate_message");
  assert.equal(h.sessions.history(first.session_id as string).messages.filter((m) => m.role === "user").length, 1);
  assert.equal(h.echo.sent.length, 1);
});

test("malformed platform payloads are rejected as parse_error with the adapter error code", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  const result = h.registry.ingest("echo", { message_id: "m-1" }); // 缺 sender/timestamp
  assert.equal(result.decision, "rejected");
  assert.equal(result.reason, "parse_error");
  const rejection = h.ledger.scan({ eventType: "channel.inbound_rejected" })[0];
  assert.equal(rejection.envelope.payload.error_code, "invalid_inbound");
  assert.equal(h.sessions.listSessions().length, 0);
});

test("adapter lifecycle records adapter_started and adapter_stopped", async (t) => {
  const h = await setup();
  t.after(() => h.dispose());

  assert.equal(h.ledger.scan({ eventType: "channel.adapter_started" }).length, 1);
  await h.registry.stop();
  const stopped = h.ledger.scan({ eventType: "channel.adapter_stopped" });
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].envelope.payload.channel, "echo");
  assert.equal(stopped[0].envelope.payload.account_id, "echo-default");
});

// 类型守卫：routeInbound 的公开输入形状与 PROTOCOL 合约一致
export type _InboundMessageShapeCheck = InboundMessage;
