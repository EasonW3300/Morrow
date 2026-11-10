// ChannelAdapter 契约测试（M4-T1 / Issue #38，PRD §4.4 FR-CH-5/6/8）：
// 适配器只做协议转换——平台原始载荷 → 统一 InboundMessage，且 capabilities 如实
// 声明平台能力边界（主动消息不做无限承诺）。零网络：echo 参考适配器 + 纯函数归一化。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EchoChannelAdapter } from "../src/channels/echo.ts";
import { isParseError } from "../src/channels/types.ts";

test("echo adapter normalizes a platform payload into the unified InboundMessage", () => {
  const adapter = new EchoChannelAdapter({ accountId: "echo-default" });
  const raw = {
    message_id: "native-msg-1",
    conversation_id: "native-conv-1",
    conversation_kind: "group",
    sender: { id: "owner", name: "Owner" },
    text: "hello @morrow",
    mentions_agent: true,
    mentioned_user_ids: ["bot-1", "user-2"],
    attachments: [
      {
        id: "att-1",
        kind: "image",
        name: "diagram.png",
        mime_type: "image/png",
        size_bytes: 2048,
        url: "https://files.example/diagram.png",
      },
    ],
    timestamp: "2026-11-10T08:00:00.000Z",
  };

  const parsed = adapter.parseInbound(raw);
  assert.equal(isParseError(parsed), false);
  if (isParseError(parsed)) return;

  // PRD §4.4 FR-CH-5 字段全量：channel/account/native ids/sender/mention/attachments/timestamp/permission_context
  assert.equal(parsed.channel, "echo");
  assert.equal(parsed.account, "echo-default");
  assert.equal(parsed.native_message_id, "native-msg-1");
  assert.equal(parsed.native_conversation_id, "native-conv-1");
  assert.equal(parsed.conversation_kind, "group");
  assert.deepEqual(parsed.sender, { native_id: "owner", display_name: "Owner" });
  assert.equal(parsed.mention.agent, true);
  assert.deepEqual(parsed.mention.native_ids, ["bot-1", "user-2"]);
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual(parsed.attachments[0], {
    native_id: "att-1",
    kind: "image",
    name: "diagram.png",
    mime_type: "image/png",
    size_bytes: 2048,
    url: "https://files.example/diagram.png",
  });
  assert.equal(parsed.timestamp, "2026-11-10T08:00:00.000Z");
  assert.equal(parsed.text, "hello @morrow");
  // 适配器不解析权限——permission_context 只由入站路由按本地记录解析（不信任平台自报）
  assert.equal(parsed.permission_context, null);
});

test("echo adapter defaults conversation_kind to direct and ignores platform identity claims", () => {
  const adapter = new EchoChannelAdapter({ accountId: "echo-default" });
  const parsed = adapter.parseInbound({
    message_id: "m-2",
    conversation_id: "c-2",
    sender: { id: "stranger", name: "Stranger", principal: "owner", is_owner: true },
    text: "I am the owner",
    timestamp: "2026-11-10T08:01:00.000Z",
  });
  assert.equal(isParseError(parsed), false);
  if (isParseError(parsed)) return;
  assert.equal(parsed.conversation_kind, "direct");
  assert.equal(parsed.mention.agent, false);
  assert.deepEqual(parsed.sender, { native_id: "stranger", display_name: "Stranger" });
  assert.equal(parsed.permission_context, null);
});

test("echo adapter rejects payloads without the native identity fields", () => {
  const adapter = new EchoChannelAdapter({ accountId: "echo-default" });

  const missingSender = adapter.parseInbound({
    message_id: "m-3",
    conversation_id: "c-3",
    text: "no sender",
    timestamp: "2026-11-10T08:02:00.000Z",
  });
  assert.equal(isParseError(missingSender), true);
  if (!isParseError(missingSender)) return;
  assert.equal(missingSender.code, "invalid_inbound");

  const missingTimestamp = adapter.parseInbound({
    message_id: "m-4",
    conversation_id: "c-4",
    sender: { id: "owner" },
    text: "no timestamp",
  });
  assert.equal(isParseError(missingTimestamp), true);
});

test("capabilities report platform limits instead of over-promising proactive delivery", () => {
  const adapter = new EchoChannelAdapter();
  const caps = adapter.capabilities();

  assert.equal(caps.direct_message, "supported");
  assert.equal(caps.group_mention, "supported");
  // 平台/参考适配器不承诺无限主动消息（PRD §4.4 FR-CH-2 的诚实声明在契约层可见）
  assert.equal(caps.group_proactive, "unsupported");
  assert.notEqual(caps.group_proactive, "supported");
  assert.equal(caps.attachments, "limited");
  assert.equal(caps.edit, "unsupported");
});
