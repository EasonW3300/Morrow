// A4 修复批（Issue #37）：联系人授权真正接进入站路由。
// 端到端（渠道入站 → PermissionEngine.authorizeContactUse → 拒绝/放行）：
//   - 默认仅 query；渠道消息触发 task_execute → contact_permission_denied 留痕且不回复；
//   - memory_reference 授权下 public 记忆引用放行、private 拒绝；
//   - 联系人会话经 contactCapabilitiesForSession 收窄工具（scope 为空 → 不注入）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi } from "@morrow/pi-adapter";
import type { InboundMessage } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { createInMemorySecretStore } from "../src/keyring.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

let seq = 0;
function inbound(sender: string, text: string, conversation: string): InboundMessage {
  seq += 1;
  return {
    channel: "echo",
    account: "echo-default",
    native_message_id: `a4-${seq}`,
    native_conversation_id: conversation,
    conversation_kind: "direct",
    sender: { native_id: sender, display_name: sender },
    mention: { agent: false },
    attachments: [],
    timestamp: new Date().toISOString(),
    text,
    permission_context: null,
  };
}

test("联系人入站授权：任务执行拒绝留痕、public 记忆放行、private 记忆拒绝、工具收窄", async (t) => {
  const dir = tmpDir("morrow-inbound-authorization-");
  const runtime: RuntimeHandle = await startRuntime(testConfig(dir), {
    secretStore: createInMemorySecretStore(),
    enableEchoChannel: true,
    agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["ack"] }] }),
    notificationDrainIntervalMs: 0,
    outboxDrainIntervalMs: 0,
  });
  t.after(async () => {
    await runtime.close();
    removeDir(dir);
  });

  const invite = runtime.contacts.createInvite({ display_name: "Alice" });
  const bound = runtime.channels.routeInbound(inbound("alice", invite.code, "dm-alice"));
  assert.equal(bound.decision, "processed", "邀请码绑定消息按默认 query 放行");
  const contactId = invite.contact_id;

  // 1) 默认仅 query：任务执行意图 → 拒绝，且不回消息
  const beforeTask = runtime.outbox.list({}).total;
  const taskAttempt = runtime.channels.routeInbound(inbound("alice", "帮我执行这个任务", "dm-alice"));
  assert.equal(taskAttempt.decision, "rejected");
  assert.equal(taskAttempt.reason, "contact_permission_denied");
  assert.equal(runtime.outbox.list({}).total, beforeTask, "拒绝的入站不产生回复");
  const taskRejection = runtime.ledger.scan({ eventType: "channel.inbound_rejected" }).at(-1);
  assert.match(String(taskRejection?.envelope.payload.detail), /task_execute_not_granted/);
  const taskDenial = runtime.ledger.scan({ eventType: "contact.permission_denied" }).at(-1);
  assert.equal(taskDenial?.envelope.actor_id, `contact:${contactId}`);
  assert.equal(taskDenial?.envelope.payload.category, "task_execute");

  // 2) 授予 memory_reference：public 记忆引用放行
  runtime.contacts.setGrants(contactId, { grants: [{ category: "memory_reference" }] });
  const publicMemory = runtime.channels.routeInbound(
    inbound("alice", "我之前说过的公开记忆是什么", "dm-alice"),
  );
  assert.equal(publicMemory.decision, "processed");
  const received = runtime.ledger.scan({ eventType: "channel.inbound_received" }).at(-1);
  assert.deepEqual(
    received?.envelope.payload.permission_decision,
    {
      category: "memory_reference",
      basis: "memory-reference markers matched; sensitivity=public",
      sensitivity: "public",
    },
    "判定类别与依据随入站事件留痕",
  );

  // 3) 显式要求私密记忆 → private_memory_denied + 不回消息
  const beforePrivate = runtime.outbox.list({}).total;
  const privateMemory = runtime.channels.routeInbound(inbound("alice", "我的私密记忆是什么", "dm-alice"));
  assert.equal(privateMemory.decision, "rejected");
  assert.equal(privateMemory.reason, "contact_permission_denied");
  assert.equal(runtime.outbox.list({}).total, beforePrivate);
  const privateRejection = runtime.ledger.scan({ eventType: "channel.inbound_rejected" }).at(-1);
  assert.match(String(privateRejection?.envelope.payload.detail), /private_memory_denied/);

  // 4) 联系人会话工具收窄：memory_reference 无 scope → 不注入任何能力工具
  assert.ok(publicMemory.session_id !== undefined);
  assert.deepEqual(runtime.capabilities.contactCapabilitiesForSession(publicMemory.session_id!), []);
  // Owner 会话不受收窄（对照）
  const ownerSession = runtime.sessions.createSession("owner session").sessionId;
  assert.equal(runtime.capabilities.contactCapabilitiesForSession(ownerSession), null);
});
