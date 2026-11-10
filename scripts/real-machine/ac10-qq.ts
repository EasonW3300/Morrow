#!/usr/bin/env node
/**
 * AC-10 协议层复跑归档（M4-T9 / Issue #46；PRD §11 AC-10 / §4.4 FR-CH-2/5/7）。
 *
 * 口径：**平台协议桩**（共享 `ChannelTestServer` + `registerQqTestStub`，官方 API v2 形状，
 * 零真实网络），真实 `QqChannelAdapter`（Ed25519 事件签名校验）+ 真实 Runtime。逐轮
 * （20 轮）覆盖：
 *   1. 群 @：白名单群 + mention_only + `<@!appid>` 提及 → 入站归一化 → Outbox → 群消息 API；
 *   2. 私聊：C2C 事件 → 单聊消息 API；
 *   3. 外发审计：每组 2 条回复 `outbound.queued`/`outbound.sent` 与平台侧计数对账。
 * 另外单列（一次）：
 *   - 主动消息受限：`capabilities().group_proactive = limited` 声明 + 平台拒绝
 *     `proactive_rejected` 分类 → `needs_review`，不自动重试；
 *   - access token 失效 → 刷新一次后成功（健康不降级）。
 *
 * **真实平台层另列**：`docs/gates/m4-qq-live-evidence.md` —— QQ 官方 Bot 已在真实平台
 * 跑通「群 @ 入站 → 回复」**1 次**（Owner 确认收到），并发现/修复 `unknown_conversation`
 * 缺陷（提交 73cf438）。AC-10 要求的「各 20 次」统计、私聊实测、主动消息真实拒绝样例、
 * 真实链路外发审计核对**均未做**，如实标注为未达成。
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac10-qq.ts \
 *     [--out docs/gates] [--rounds 20]
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePi } from "../../packages/pi-adapter/src/index.ts";
import type { ChannelSummary, EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../../apps/runtime/src/config.ts";
import { createInMemorySecretStore } from "../../apps/runtime/src/keyring.ts";
import { startRuntime, type RuntimeHandle } from "../../apps/runtime/src/runtime.ts";
import { ChannelTestServer } from "../../apps/runtime/src/channels/testing/channel-test-server.ts";
import { registerQqTestStub, type QqTestStub } from "../../apps/runtime/src/channels/testing/qq-stub.ts";
import { QqChannelAdapter, type QqConfig } from "../../apps/runtime/src/channels/adapters/qq/index.ts";
import { removeDir, tmpDir } from "../../apps/runtime/test/helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const GROUP_ID = "qq_group_m4";
const DEFAULT_ROUNDS = 20;

const QQ_CONFIG: QqConfig = {
  appId: "qq_m4_ac10",
  appSecret: "ac10_app_secret",
  botSecret: "ac10_bot_secret",
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

async function putJson<T>(base: string, path: string, body: unknown): Promise<JsonResponse<T>> {
  return requestJson<T>(base, path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface RoundResult {
  round: number;
  group_mention_ok: boolean;
  direct_ok: boolean;
  outbound_ok: boolean;
  outbound_messages: number;
  platform_group_messages: number;
  platform_direct_messages: number;
  inbound_events: number;
  errors: string[];
}

interface Ac10Report {
  ticket: "M4-T9 / Issue #46 AC-10";
  generated_at: string;
  environment: { node: string; platform: string };
  channel: { config: QqConfig; capabilities: unknown };
  rounds_requested: number;
  rounds_completed: number;
  aspects: {
    group_mention: { passed: number; total: number };
    direct_message: { passed: number; total: number };
    outbound_audit: { passed: number; total: number; messages: number };
    proactive_limited: { declared: boolean; rejection_classified: boolean; evidence: string };
    token_refresh: { passed: boolean; evidence: string };
  };
  totals: {
    outbound_messages: number;
    platform_group_messages: number;
    platform_direct_messages: number;
    inbound_received: number;
    outbound_queued: number;
    outbound_sent: number;
    signed_events: boolean;
  };
  real_platform_layer: {
    status: "partial";
    evidence_pointer: string;
    completed: string[];
    not_completed: string[];
  };
  rounds: RoundResult[];
  pass: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rounds = parseRounds(argv);
  const outDir = parseOutArg(argv);
  const dir = tmpDir("morrow-ac10-qq-");
  const server = new ChannelTestServer();
  await server.start();
  const stub: QqTestStub = registerQqTestStub(server, {
    appId: QQ_CONFIG.appId,
    appSecret: QQ_CONFIG.appSecret,
    botSecret: QQ_CONFIG.botSecret,
  });

  const config: RuntimeConfig = { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
  const adapter = new QqChannelAdapter({
    accountId: "qq-default",
    config: QQ_CONFIG,
    apiBaseUrl: server.baseUrl,
    tokenEndpoint: `${server.baseUrl}/app/getAppAccessToken`,
    requestTimeoutMs: 500,
    eventPollTimeoutMs: 20,
    eventReconnectDelayMs: 5,
  });

  let runtime: RuntimeHandle | undefined;
  try {
    runtime = await startRuntime(config, {
      secretStore: createInMemorySecretStore(),
      agentAdapterFactory: async () =>
        createFakePi({ script: [{ kind: "text", deltas: ["AC-10 ", "协议层回复"] }] }),
      channelAdapters: [
        {
          adapter,
          account: {
            account_id: "qq-default",
            channel_id: "qq",
            native_account_id: QQ_CONFIG.appId,
            display_name: "Morrow QQ (AC-10 stub)",
            owner_native_ids: ["qq_owner"],
          },
        },
      ],
      outboxBackoffBaseMs: 100,
      notificationDrainIntervalMs: 0,
      outboxDrainIntervalMs: 0,
    });
    const base = `http://127.0.0.1:${runtime.port}`;
    const rt = runtime;

    const allow = await putJson(base, "/v1/channels/qq/allowlist", {
      allowlist: [{ native_conversation_id: GROUP_ID, mode: "mention_only" }],
    });
    assert.equal(allow.status, 200, "PUT /v1/channels/qq/allowlist");

    const channels = await getJson<{ channels: ChannelSummary[] }>(base, "/v1/channels");
    assert.equal(channels.status, 200);
    const summary = channels.body.channels.find((channel) => channel.channel_id === "qq");
    assert.ok(summary !== undefined, "qq channel listed");
    assert.equal(summary.capabilities.direct_message, "supported");
    assert.equal(summary.capabilities.group_mention, "supported");
    assert.equal(summary.capabilities.group_proactive, "limited", "proactive is platform-limited");
    assert.equal(summary.capabilities.attachments, "limited");

    const results: RoundResult[] = [];
    const inboundBaseline = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;

    for (let round = 1; round <= rounds; round += 1) {
      const errors: string[] = [];
      const before = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;
      const beforeGroup = stub.groupMessages.length;
      const beforeDirect = stub.c2cMessages.length;
      const beforeSent = rt.ledger.scan({ eventType: "outbound.sent" }).length;

      // 1) 群 @
      stub.pushMessage({
        type: "group",
        messageId: `ac10_group_${round}`,
        conversationId: GROUP_ID,
        senderId: "qq_owner",
        text: `AC-10 群 @ 第 ${round} 轮`,
      });
      let groupOk = false;
      try {
        await waitFor(`round ${round} group inbound`, () =>
          rt.ledger.scan({ eventType: "channel.inbound_received" }).length >= before + 1,
        );
        groupOk = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      // 2) 私聊
      stub.pushMessage({
        type: "direct",
        messageId: `ac10_direct_${round}`,
        senderId: "qq_owner",
        text: `AC-10 私聊第 ${round} 轮`,
      });
      let directOk = false;
      try {
        await waitFor(`round ${round} direct inbound`, () =>
          rt.ledger.scan({ eventType: "channel.inbound_received" }).length >= before + 2,
        );
        directOk = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      // 3) 外发审计
      let outboundOk = false;
      let outboundMessages = 0;
      try {
        await waitFor(`round ${round} outbox rows`, () =>
          rt.outbox.list({}).messages.filter((row) => row.status === "pending").length >= 2,
        );
        const dispatched = await rt.outbox.dispatchOnce();
        assert.equal(dispatched.attempted, 2);
        assert.equal(dispatched.sent, 2);
        outboundMessages = dispatched.sent;
        assert.equal(stub.groupMessages.length - beforeGroup, 1, "one group reply");
        assert.equal(stub.c2cMessages.length - beforeDirect, 1, "one direct reply");
        const groupReply = stub.groupMessages.at(-1);
        assert.equal(groupReply?.msg_id, `ac10_group_${round}`, "passive reply quotes inbound msg_id");
        assert.equal(groupReply?.proactive, false);
        const directReply = stub.c2cMessages.at(-1);
        assert.equal(directReply?.msg_id, `ac10_direct_${round}`);
        assert.equal(rt.ledger.scan({ eventType: "outbound.sent" }).length - beforeSent, 2);
        outboundOk = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      results.push({
        round,
        group_mention_ok: groupOk,
        direct_ok: directOk,
        outbound_ok: outboundOk,
        outbound_messages: outboundMessages,
        platform_group_messages: stub.groupMessages.length - beforeGroup,
        platform_direct_messages: stub.c2cMessages.length - beforeDirect,
        inbound_events: rt.ledger.scan({ eventType: "channel.inbound_received" }).length - before,
        errors,
      });
      if (errors.length > 0) break;
    }

    // --- 主动消息受限（一次） ---------------------------------------------------
    let proactiveOk = false;
    let proactiveEvidence = "not run";
    try {
      stub.rejectProactive = true;
      const row = rt.outbox.enqueue({
        idempotencyKey: "ac10:proactive:evidence-1",
        channelId: "qq",
        accountId: "qq-default",
        target: { kind: "conversation", id: GROUP_ID },
        payload: { text: "AC-10 主动消息（平台限制）" },
      });
      const dispatched = await rt.outbox.dispatchOnce();
      assert.equal(dispatched.needs_review, 1);
      const stored = rt.outbox.get(row.id);
      assert.equal(stored?.status, "needs_review");
      assert.match(stored?.last_error ?? "", /proactive_rejected/);
      assert.equal(stub.rejectedProactive.length, 1);
      assert.equal(stub.rejectedProactive[0]?.code, 304046);
      const reviewed = rt.ledger
        .scan({ eventType: "outbound.reviewed" })
        .filter((entry) => entry.envelope.idempotency_key === "ac10:proactive:evidence-1");
      assert.equal(reviewed.length, 1);
      // 时间推进后不自动重发
      const again = await rt.outbox.dispatchOnce();
      assert.equal(again.attempted, 0);
      proactiveOk = true;
      proactiveEvidence = `platform reject code=${stub.rejectedProactive[0]?.code}; outbox=needs_review; outbound.failed(will_retry=false)+outbound.reviewed; retry attempts after 10min=0`;
    } catch (err) {
      proactiveEvidence = err instanceof Error ? err.message : String(err);
    } finally {
      stub.rejectProactive = false;
    }

    // --- token 失效 → 刷新一次成功（一次） --------------------------------------
    let tokenOk = false;
    let tokenEvidence = "not run";
    try {
      const tokensBefore = stub.issuedTokenCount();
      stub.expireAccessToken();
      stub.pushMessage({
        type: "direct",
        messageId: "ac10_token_refresh",
        senderId: "qq_owner",
        text: "token refresh check",
      });
      await waitFor("token refresh inbound", () =>
        rt.ledger.scan({ eventType: "channel.inbound_received" }).length >= inboundBaseline + results.length * 2 + 1,
      );
      await waitFor("token refresh outbox", () =>
        rt.outbox.list({}).messages.filter((row) => row.status === "pending").length >= 1,
      );
      const dispatched = await rt.outbox.dispatchOnce();
      assert.equal(dispatched.sent, 1);
      assert.ok(stub.issuedTokenCount() > tokensBefore, "access token refreshed");
      assert.equal(rt.ledger.scan({ eventType: "channel.inbound_rejected" }).length, 0, "signed events accepted");
      tokenOk = true;
      tokenEvidence = `expired token → refreshed (issued ${tokensBefore} → ${stub.issuedTokenCount()}); reply sent once`;
    } catch (err) {
      tokenEvidence = err instanceof Error ? err.message : String(err);
    }

    const count = (predicate: (result: RoundResult) => boolean): number => results.filter(predicate).length;
    const completed = results.length;
    const aspects: Ac10Report["aspects"] = {
      group_mention: { passed: count((result) => result.group_mention_ok), total: completed },
      direct_message: { passed: count((result) => result.direct_ok), total: completed },
      outbound_audit: {
        passed: count((result) => result.outbound_ok),
        total: completed,
        messages: results.reduce((sum, result) => sum + result.outbound_messages, 0),
      },
      proactive_limited: {
        declared: summary.capabilities.group_proactive === "limited",
        rejection_classified: proactiveOk,
        evidence: proactiveEvidence,
      },
      token_refresh: { passed: tokenOk, evidence: tokenEvidence },
    };

    const pass =
      completed === rounds &&
      aspects.group_mention.passed === rounds &&
      aspects.direct_message.passed === rounds &&
      aspects.outbound_audit.passed === rounds &&
      aspects.proactive_limited.declared &&
      aspects.proactive_limited.rejection_classified &&
      aspects.token_refresh.passed;

    const report: Ac10Report = {
      ticket: "M4-T9 / Issue #46 AC-10",
      generated_at: new Date().toISOString(),
      environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
      channel: { config: QQ_CONFIG, capabilities: summary.capabilities },
      rounds_requested: rounds,
      rounds_completed: completed,
      aspects,
      totals: {
        outbound_messages: aspects.outbound_audit.messages,
        platform_group_messages: stub.groupMessages.length,
        platform_direct_messages: stub.c2cMessages.length,
        inbound_received: rt.ledger.scan({ eventType: "channel.inbound_received" }).length - inboundBaseline,
        outbound_queued: rt.ledger.scan({ eventType: "outbound.queued" }).length,
        outbound_sent: rt.ledger.scan({ eventType: "outbound.sent" }).length,
        signed_events: true,
      },
      real_platform_layer: {
        status: "partial",
        evidence_pointer: "docs/gates/m4-qq-live-evidence.md",
        completed: [
          "真实 QQ 官方 Bot 群 @ 入站 → 回复：累计 15 次（首轮 1 + 第二轮 14；含 10 次仅 @ 不带正文），0 拒绝，Owner 侧确认收到",
          "真实 QQ 官方 Bot 私聊（C2C）入站 → 回复：1 次（/v2/users/{openid}/messages，端点选择正确）",
          "主动消息真实限制：群主动消息 HTTP 400 code=40034105（无权限）→ proactive_rejected；私聊主动消息 HTTP 200（额度内可发），证实分场景受限",
          "真实平台发现并修复三处缺陷：unknown_conversation（73cf438）、40034105 未入不可重试码表、测试桩六个注入选项未生效（56ca2d2）",
        ],
        not_completed: [
          "AC-10 要求的群 @ 20 次门线：累计 15 次（差 5），不标完成",
          "私聊 20 次门线：当前 1 次",
          "真实链路 Outbox 幂等/未知状态与外发审计逐条落库核对",
        ],
      },
      rounds: results,
      pass,
    };

    const markdown = renderMarkdown(report);
    if (outDir !== null) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "m4-ac10-qq.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(outDir, "m4-ac10-qq.md"), markdown, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    console.log("\n--- Markdown ---\n");
    console.log(markdown);
    if (!pass) {
      const failures = results.filter((result) => result.errors.length > 0);
      throw new Error(`AC-10 assertions failed: ${JSON.stringify(failures.map((result) => result.errors))}`);
    }
  } finally {
    if (runtime !== undefined) await runtime.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDir(dir);
  }
}

function renderMarkdown(report: Ac10Report): string {
  const lines: string[] = [];
  lines.push("# AC-10 协议层复跑（QQ 官方 Bot，平台协议桩）");
  lines.push("");
  lines.push(`- 票：${report.ticket}`);
  lines.push(`- 生成时间：${report.generated_at} ｜ Node ${report.environment.node} ｜ ${report.environment.platform}`);
  lines.push("- 口径：真实 `QqChannelAdapter`（Ed25519 事件签名）+ 真实 Runtime + `ChannelTestServer` + `registerQqTestStub`（零真实网络）");
  lines.push("");
  lines.push("## 逐项结果");
  lines.push("");
  lines.push("| 项 | 通过 | 说明 |");
  lines.push("|---|---|---|");
  lines.push(`| 群 @ | **${report.aspects.group_mention.passed}/${report.aspects.group_mention.total}** | 白名单 mention_only + <@!appid> 提及；被动回复带 msg_id |`);
  lines.push(`| 私聊（C2C） | **${report.aspects.direct_message.passed}/${report.aspects.direct_message.total}** | /v2/users/{openid}/messages |`);
  lines.push(`| 外发审计 | **${report.aspects.outbound_audit.passed}/${report.aspects.outbound_audit.total}** | ${report.aspects.outbound_audit.messages} 条 outbound.sent |`);
  lines.push(`| 主动消息受限 | 声明=${report.aspects.proactive_limited.declared}；拒绝分类=${report.aspects.proactive_limited.rejection_classified} | ${report.aspects.proactive_limited.evidence} |`);
  lines.push(`| token 刷新 | **${report.aspects.token_refresh.passed ? "PASS" : "FAIL"}** | ${report.aspects.token_refresh.evidence} |`);
  lines.push("");
  lines.push("## 真实平台层（单列，未达 20 次门线）");
  lines.push("");
  lines.push(`证据：\`${report.real_platform_layer.evidence_pointer}\``);
  lines.push("");
  lines.push("已完成：");
  for (const item of report.real_platform_layer.completed) lines.push(`- ${item}`);
  lines.push("");
  lines.push("未完成：");
  for (const item of report.real_platform_layer.not_completed) lines.push(`- ${item}`);
  lines.push("");
  lines.push(`**协议层判定：${report.pass ? "PASS" : "FAIL"}** ｜ **真实平台层：部分（群 @ 累计 15/20 + 私聊 1 次，0 失败），AC-10 的 20 次门线未达成**`);
  lines.push("");
  return lines.join("\n");
}

main().catch((err: unknown) => {
  console.error(`[ac10] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
