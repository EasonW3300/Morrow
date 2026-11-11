#!/usr/bin/env node
/**
 * AC-09 协议层复跑归档（M4-T9 / Issue #46；PRD §11 AC-09 / §4.4 FR-CH-1/5/6/7）。
 *
 * 口径：**平台协议桩**（`ChannelTestServer`，真实飞书 Open API 形状、零真实网络），
 * 真实 `FeishuChannelAdapter` + 真实 Runtime + 真实 HTTP 控制面。逐轮（20 轮）覆盖票面
 * 要求的五项：
 *   1. 私聊：p2p 事件 → 签名/解密 → 统一入站 → 会话 → 回复入 Outbox；
 *   2. 群 @：白名单群 + mention_only + @ 机器人 → 处理（未 @ 不响应由路由套件覆盖）；
 *   3. 可信联系人授权：一次性邀请码经渠道回复绑定 → permission_context 记录
 *      `contact:<id>`，默认仅 `query`；
 *   4. 外发审计：每组 4 条回复经 Outbox 投递，`outbound.queued`/`outbound.sent` 与
 *      平台侧 reply 计数逐条对账；
 *   5. 任务关联：真实 `POST`/库形态创建的任务经中间路由关联（消息 task_id 列 +
 *      事件信封 task_id），不覆盖平台原始记录。
 *
 * 边界（如实标注）：飞书**真实平台**联调未做（自建应用资质未注册，Owner 侧滞后）；
 * 本脚本全部数字是协议桩口径。真实长连接是官方 SDK WebSocket，本脚本用同 base_url 的
 * HTTP 长轮询模拟事件到达语义（见 packages/channels/README.md）。
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac09-feishu.ts \
 *     [--out docs/gates] [--rounds 20]
 *
 * 输出：stdout JSON 摘要 + Markdown；--out 目录写 m4-ac09-feishu.json / .md。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePi } from "../../packages/pi-adapter/src/index.ts";
import type { ChannelHealth, ChannelSummary, EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../../apps/runtime/src/config.ts";
import { createInMemorySecretStore } from "../../apps/runtime/src/keyring.ts";
import { startRuntime, type RuntimeHandle } from "../../apps/runtime/src/runtime.ts";
import { ChannelTestServer } from "../../apps/runtime/src/channels/testing/channel-test-server.ts";
import { FeishuChannelAdapter, type FeishuConfig } from "../../apps/runtime/src/channels/adapters/feishu/index.ts";
import { removeDir, tmpDir } from "../../apps/runtime/test/helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const GROUP_ID = "oc_group_m4";
const DEFAULT_ROUNDS = 20;

const FEISHU_CONFIG: FeishuConfig = {
  appId: "cli_m4_ac09",
  appSecret: "ac09_app_secret",
  verificationToken: "ac09_verification_token",
  encryptKey: "ac09_encrypt_key",
  botOpenId: "ou_bot",
};

function parseRounds(argv: string[]): number {
  const index = argv.indexOf("--rounds");
  if (index === -1) return DEFAULT_ROUNDS;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error("--rounds requires a positive integer");
  return value;
}

function parseOutArg(argv: string[]): string | null {
  const index = argv.indexOf("--out");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("--out requires a directory path");
  return value;
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
}

interface JsonResponse<T> {
  status: number;
  body: T;
  raw: string;
}

async function requestJson<T>(base: string, path: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(`${base}${path}`, init);
  const raw = await response.text();
  const body = raw.length === 0 ? (null as T) : (JSON.parse(raw) as T);
  return { status: response.status, body, raw };
}

async function getJson<T>(base: string, path: string): Promise<JsonResponse<T>> {
  return requestJson<T>(base, path);
}

async function postJson<T>(base: string, path: string, body?: unknown): Promise<JsonResponse<T>> {
  return requestJson<T>(base, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function putJson<T>(base: string, path: string, body: unknown): Promise<JsonResponse<T>> {
  return requestJson<T>(base, path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface Invite {
  invite_id: string;
  contact_id: string;
  code: string;
  expires_at: string;
}

interface RoundResult {
  round: number;
  private_ok: boolean;
  group_mention_ok: boolean;
  contact_ok: boolean;
  contact_id: string | null;
  task_association_ok: boolean;
  task_id: string | null;
  outbound_ok: boolean;
  outbound_messages: number;
  platform_replies: number;
  inbound_events: number;
  errors: string[];
}

interface Ac09Report {
  ticket: "M4-T9 / Issue #46 AC-09";
  generated_at: string;
  environment: { node: string; platform: string };
  channel: { config: FeishuConfig; capabilities: unknown; health: unknown };
  rounds_requested: number;
  rounds_completed: number;
  aspects: {
    direct_message: { passed: number; total: number };
    group_mention: { passed: number; total: number };
    trusted_contact_authorization: { passed: number; total: number };
    outbound_audit: { passed: number; total: number; messages: number };
    task_association: { passed: number; total: number };
  };
  totals: {
    outbound_messages: number;
    platform_replies: number;
    inbound_received: number;
    outbound_queued: number;
    outbound_sent: number;
    contact_bound: number;
    sessions: number;
  };
  real_platform_layer: {
    status: "not_run_external_block";
    reason: string;
    evidence_pointer: string;
  };
  rounds: RoundResult[];
  pass: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rounds = parseRounds(argv);
  const outDir = parseOutArg(argv);
  const dir = tmpDir("morrow-ac09-feishu-");
  const server = new ChannelTestServer({
    appId: FEISHU_CONFIG.appId,
    appSecret: FEISHU_CONFIG.appSecret,
    verificationToken: FEISHU_CONFIG.verificationToken,
    encryptKey: FEISHU_CONFIG.encryptKey,
    botOpenId: FEISHU_CONFIG.botOpenId,
  });
  await server.start();

  const config: RuntimeConfig = { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
  const adapter = new FeishuChannelAdapter({
    accountId: "feishu-default",
    config: FEISHU_CONFIG,
    baseUrl: server.baseUrl,
    requestTimeoutMs: 500,
    eventPollTimeoutMs: 20,
    eventReconnectDelayMs: 5,
  });

  let runtime: RuntimeHandle | undefined;
  try {
    runtime = await startRuntime(config, {
      secretStore: createInMemorySecretStore(),
      agentAdapterFactory: async () =>
        createFakePi({ script: [{ kind: "text", deltas: ["AC-09 ", "协议层回复"] }] }),
      taskPlannerFactory: async () =>
        createFakePi({
          script: [
            {
              kind: "text",
              deltas: [
                JSON.stringify({
                  nodes: [
                    { key: "ac09", title: "AC-09 关联节点", goal: "记录关联", depends_on: [], side_effect: "reversible" },
                  ],
                }),
              ],
            },
          ],
        }),
      channelAdapters: [
        {
          adapter,
          account: {
            account_id: "feishu-default",
            channel_id: "feishu",
            native_account_id: FEISHU_CONFIG.appId,
            display_name: "Morrow Feishu (AC-09 stub)",
            owner_native_ids: ["ou_owner"],
          },
        },
      ],
      outboxBackoffBaseMs: 100,
      notificationDrainIntervalMs: 0,
      outboxDrainIntervalMs: 0,
    });
    const base = `http://127.0.0.1:${runtime.port}`;
    const rt = runtime;

    // 群聊白名单：mention_only（T6 端点）
    const allow = await putJson(base, "/v1/channels/feishu/allowlist", {
      allowlist: [{ native_conversation_id: GROUP_ID, mode: "mention_only" }],
    });
    assert.equal(allow.status, 200, "PUT /v1/channels/feishu/allowlist");

    const channels = await getJson<{ channels: ChannelSummary[] }>(base, "/v1/channels");
    assert.equal(channels.status, 200);
    const summary = channels.body.channels.find((channel) => channel.channel_id === "feishu");
    assert.ok(summary !== undefined, "feishu channel listed");
    assert.equal(summary.capabilities.direct_message, "supported");
    assert.equal(summary.capabilities.group_mention, "supported");
    assert.equal(summary.capabilities.group_proactive, "limited");
    assert.equal(summary.capabilities.attachments, "limited");

    const health = await getJson<ChannelHealth>(base, "/v1/channels/feishu/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.healthy, true);

    const results: RoundResult[] = [];
    const inboundBaseline = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;

    for (let round = 1; round <= rounds; round += 1) {
      const errors: string[] = [];
      const before = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;
      const beforeReplies = server.replies.length;
      const beforeSent = rt.ledger.scan({ eventType: "outbound.sent" }).length;

      // 1) 私聊
      server.pushMessage({
        messageId: `ac09_dm_${round}`,
        chatId: `oc_dm_${round}`,
        chatType: "p2p",
        senderOpenId: "ou_owner",
        text: `AC-09 私聊第 ${round} 轮`,
      });
      try {
        await waitFor(`round ${round} private inbound`, () =>
          rt.ledger.scan({ eventType: "channel.inbound_received" }).length >= before + 1,
        );
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      const privateOk = errors.length === 0;

      // 2) 群 @（白名单 + mention_only + 提及 bot）
      const beforeGroup = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;
      server.pushMessage({
        messageId: `ac09_group_${round}`,
        chatId: GROUP_ID,
        chatType: "group",
        senderOpenId: "ou_owner",
        mentionBot: true,
        text: `AC-09 群 @ 第 ${round} 轮`,
      });
      let groupOk = false;
      try {
        await waitFor(`round ${round} group inbound`, () =>
          rt.ledger.scan({ eventType: "channel.inbound_received" }).length >= beforeGroup + 1,
        );
        groupOk = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      // 3) 可信联系人：一次性邀请码经渠道消息绑定，默认仅 query
      let contactOk = false;
      let contactId: string | null = null;
      try {
        const invite = await postJson<Invite>(base, "/v1/contacts/invites", {
          display_name: `AC09 Contact ${round}`,
        });
        assert.equal(invite.status, 201, "POST /v1/contacts/invites");
        contactId = invite.body.contact_id;
        const beforeContact = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;
        server.pushMessage({
          messageId: `ac09_contact_${round}`,
          chatId: `oc_contact_${round}`,
          chatType: "p2p",
          senderOpenId: `ou_contact_${round}`,
          text: invite.body.code,
        });
        await waitFor(`round ${round} contact inbound`, () =>
          rt.ledger.scan({ eventType: "channel.inbound_received" }).length >= beforeContact + 1,
        );
        const received = rt.ledger.scan({ eventType: "channel.inbound_received" }).at(-1) as EventEnvelope | undefined;
        const permission = received?.envelope.payload.permission_context as
          | { principal?: string; granted_categories?: string[] }
          | undefined;
        assert.equal(permission?.principal, `contact:${contactId}`, "permission principal");
        assert.deepEqual(permission?.granted_categories, ["query"], "default grants = query only");
        contactOk = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      // 4) 任务关联：真实任务存在性校验 + 消息关联列 + 事件信封 task_id
      let taskOk = false;
      let taskId: string | null = null;
      try {
        const task = await rt.tasks.createTask(`AC-09 关联任务 ${round}`);
        taskId = task.task_id;
        assert.equal(task.status, "planned");
        const raw = server.buildMessageEvent({
          messageId: `ac09_task_${round}`,
          chatId: `oc_task_${round}`,
          chatType: "p2p",
          senderOpenId: "ou_owner",
          text: `AC-09 任务关联消息 ${round}`,
        });
        const routed = rt.channels.ingest("feishu", raw, { taskId: task.task_id });
        assert.equal(routed.decision, "processed", `task association routed: ${JSON.stringify(routed)}`);
        const conversation = rt.channels.getConversation("feishu-default", `oc_task_${round}`);
        assert.equal(conversation?.task_id, task.task_id, "conversation task_id association");
        const receivedTask = rt.ledger
          .scan({ eventType: "channel.inbound_received" })
          .filter((entry) => entry.envelope.task_id === task.task_id);
        assert.equal(receivedTask.length, 1, "event envelope carries task_id");
        // 平台原始记录不被任务关联改写
        const records = rt.channels.listMessages(String(routed.conversation_id));
        const inboundRecord = records.find((record) => record.direction === "inbound" && record.task_id === task.task_id);
        assert.ok(inboundRecord !== undefined, "raw message record keeps task_id column");
        taskOk = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      // 5) 外发审计：本组 4 条回复（私聊/群/联系人/任务关联）经 Outbox 投递
      let outboundOk = false;
      let outboundMessages = 0;
      try {
        await waitFor(
          `round ${round} outbox rows`,
          () => rt.outbox.list({ status: "pending", limit: 200 }).messages.length >= 4,
        );
        const dispatched = await rt.outbox.dispatchOnce();
        assert.equal(dispatched.attempted, 4, "four pending outbound messages");
        assert.equal(dispatched.sent, 4, "four messages sent");
        outboundMessages = dispatched.sent;
        const newReplies = server.replies.length - beforeReplies;
        assert.equal(newReplies, 4, "platform received four replies");
        const sentEvents = rt.ledger.scan({ eventType: "outbound.sent" }).length - beforeSent;
        assert.equal(sentEvents, 4, "outbound.sent audit per message");
        outboundOk = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      const inboundEvents = rt.ledger.scan({ eventType: "channel.inbound_received" }).length - before;
      results.push({
        round,
        private_ok: privateOk,
        group_mention_ok: groupOk,
        contact_ok: contactOk,
        contact_id: contactId,
        task_association_ok: taskOk,
        task_id: taskId,
        outbound_ok: outboundOk,
        outbound_messages: outboundMessages,
        platform_replies: server.replies.length - beforeReplies,
        inbound_events: inboundEvents,
        errors,
      });
      if (errors.length > 0) break;
    }

    const count = (predicate: (result: RoundResult) => boolean): number => results.filter(predicate).length;
    const completed = results.length;
    const aspects = {
      direct_message: { passed: count((result) => result.private_ok), total: completed },
      group_mention: { passed: count((result) => result.group_mention_ok), total: completed },
      trusted_contact_authorization: { passed: count((result) => result.contact_ok), total: completed },
      outbound_audit: {
        passed: count((result) => result.outbound_ok),
        total: completed,
        messages: results.reduce((sum, result) => sum + result.outbound_messages, 0),
      },
      task_association: { passed: count((result) => result.task_association_ok), total: completed },
    };

    const pass =
      completed === rounds &&
      Object.values(aspects).every((aspect) => aspect.passed === aspect.total && aspect.total === rounds);

    const report: Ac09Report = {
      ticket: "M4-T9 / Issue #46 AC-09",
      generated_at: new Date().toISOString(),
      environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
      channel: {
        config: FEISHU_CONFIG,
        capabilities: summary.capabilities,
        health: { healthy: health.body.healthy, state: health.body.state, connection: health.body.connection },
      },
      rounds_requested: rounds,
      rounds_completed: completed,
      aspects,
      totals: {
        outbound_messages: aspects.outbound_audit.messages,
        platform_replies: server.replies.length,
        inbound_received: rt.ledger.scan({ eventType: "channel.inbound_received" }).length - inboundBaseline,
        outbound_queued: rt.ledger.scan({ eventType: "outbound.queued" }).length,
        outbound_sent: rt.ledger.scan({ eventType: "outbound.sent" }).length,
        contact_bound: rt.ledger.scan({ eventType: "contact.bound" }).length,
        sessions: rt.sessions.listSessions().length,
      },
      real_platform_layer: {
        status: "not_run_external_block",
        reason: "飞书自建应用资质未注册（Owner 侧滞后），真实平台联调按 Owner 要求暂缓；本报告全部数字为平台协议桩口径。",
        evidence_pointer: "docs/gates/m4-qq-live-evidence.md（QQ 真实平台；飞书无对应证据）",
      },
      rounds: results,
      pass,
    };

    const markdown = renderMarkdown(report);
    if (outDir !== null) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "m4-ac09-feishu.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(outDir, "m4-ac09-feishu.md"), markdown, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    console.log("\n--- Markdown ---\n");
    console.log(markdown);
    if (!pass) {
      const failures = results.filter((result) => result.errors.length > 0);
      throw new Error(`AC-09 assertions failed: ${JSON.stringify(failures.map((result) => result.errors))}`);
    }
  } finally {
    if (runtime !== undefined) await runtime.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDir(dir);
  }
}

function renderMarkdown(report: Ac09Report): string {
  const lines: string[] = [];
  lines.push("# AC-09 协议层复跑（飞书 Bot，平台协议桩）");
  lines.push("");
  lines.push(`- 票：${report.ticket}`);
  lines.push(`- 生成时间：${report.generated_at} ｜ Node ${report.environment.node} ｜ ${report.environment.platform}`);
  lines.push("- 口径：真实 `FeishuChannelAdapter` + 真实 Runtime + `ChannelTestServer`（飞书 Open API 形状，零真实网络）");
  lines.push("- **真实平台层：未做（外部阻塞）** —— 飞书自建应用资质未注册");
  lines.push("");
  lines.push("## 逐项结果");
  lines.push("");
  lines.push("| 项 | 通过 | 说明 |");
  lines.push("|---|---|---|");
  lines.push(`| 私聊（p2p 入站 → 回复） | **${report.aspects.direct_message.passed}/${report.aspects.direct_message.total}** | 签名 + AES 解密 + 入站路由 + Outbox |`);
  lines.push(`| 群 @（白名单 mention_only） | **${report.aspects.group_mention.passed}/${report.aspects.group_mention.total}** | 提及 bot 才处理 |`);
  lines.push(`| 可信联系人授权 | **${report.aspects.trusted_contact_authorization.passed}/${report.aspects.trusted_contact_authorization.total}** | 一次性邀请码绑定，默认仅 query |`);
  lines.push(`| 外发审计 | **${report.aspects.outbound_audit.passed}/${report.aspects.outbound_audit.total}** | ${report.aspects.outbound_audit.messages} 条 outbound.sent，平台 reply 逐条对账 |`);
  lines.push(`| 任务关联 | **${report.aspects.task_association.passed}/${report.aspects.task_association.total}** | 中间路由 task_id（原始记录不改写） |`);
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push(`- 入站事件：${report.totals.inbound_received} ｜ Outbox queued/sent：${report.totals.outbound_queued}/${report.totals.outbound_sent} ｜ 平台回执：${report.totals.platform_replies}`);
  lines.push(`- 联系人绑定事件：${report.totals.contact_bound} ｜ 会话数：${report.totals.sessions}`);
  lines.push(`- 能力声明：direct=${String((report.channel.capabilities as Record<string, unknown>).direct_message)}，group_mention=${String((report.channel.capabilities as Record<string, unknown>).group_mention)}，group_proactive=${String((report.channel.capabilities as Record<string, unknown>).group_proactive)}（受限），attachments=${String((report.channel.capabilities as Record<string, unknown>).attachments)}（受限）`);
  lines.push("");
  lines.push(`**判定：${report.pass ? "PASS" : "FAIL"}**（协议层；真实平台层未达成）`);
  lines.push("");
  return lines.join("\n");
}

main().catch((err: unknown) => {
  console.error(`[ac09] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
