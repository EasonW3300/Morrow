#!/usr/bin/env node
/**
 * AC-15 协议层复跑归档（M4-T9 / Issue #46；PRD §11 AC-15 / §4.4 FR-CH-3）。
 *
 * 口径：**平台协议桩** —— 微信个人号实验适配器 + 可注入 `LocalBridge` 的 `StubLocalBridge`
 * （纯内存，零真实微信/零网络）。逐项覆盖票面要求：
 *   1. 配置与环境声明：出厂 disabled；`environment = Windows + 最新版微信`；风险文案常驻；
 *   2. 风险确认：未带 `confirm_risk` 的启用请求 409 `risk_confirmation_required`；
 *      确认后启用并落 `channel.experimental_enabled` 审计；
 *   3. 白名单收发：20 轮允许会话收发经 Outbox → 桥实发；20 轮非白名单会话被拒且不发；
 *   4. 健康检查：桥接进程/登录态/窗口句柄/最近错误；故障注入后健康降级；
 *   5. 日志可诊断：ledger 审计链（adapter_started / experimental_enabled /
 *      inbound_received / inbound_rejected / adapter_stopped）；
 *   6. 关闭：disable 立即停止收发（桥断开，后续消息不进入会话链路）。
 *
 * **真实微信环境未联调**：需要 Owner 的 Windows 机器 + 最新版微信 + 本地自动化桥
 * （M4 只交付可注入接缝，真实桥未实现）——外部依赖阻塞，不得标完成。
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac15-wechat.ts \
 *     [--out docs/gates] [--rounds 20]
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePi } from "../../packages/pi-adapter/src/index.ts";
import type { ChannelHealth, ChannelSummary } from "@morrow/protocol";
import type { RuntimeConfig } from "../../apps/runtime/src/config.ts";
import { createInMemorySecretStore } from "../../apps/runtime/src/keyring.ts";
import { startRuntime, type RuntimeHandle } from "../../apps/runtime/src/runtime.ts";
import {
  StubLocalBridge,
  WeChatChannelAdapter,
  WECHAT_ENVIRONMENT,
  WECHAT_RISK_NOTICE,
} from "../../apps/runtime/src/channels/adapters/wechat/index.ts";
import { removeDir, tmpDir } from "../../apps/runtime/test/helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const DEFAULT_ROUNDS = 20;
const ALLOWED = "wx-dm-1";
const BLOCKED = "wx-dm-2";

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

interface RoundResult {
  round: number;
  allowed_sent: boolean;
  blocked_rejected: boolean;
  blocked_sent_extra: number;
  errors: string[];
}

interface Ac15Report {
  ticket: "M4-T9 / Issue #46 AC-15";
  generated_at: string;
  environment: { node: string; platform: string };
  config: {
    factory_disabled: boolean;
    experimental: boolean;
    environment_declared: unknown;
    risk_notice: string;
    expected_environment: unknown;
  };
  risk_confirmation: {
    refused_status: number;
    refused_code: string | null;
    enabled_status: number;
    audit_events: number;
  };
  allowlist: {
    rounds_requested: number;
    rounds_completed: number;
    allowed_sent: { passed: number; total: number };
    blocked_rejected: { passed: number; total: number };
    bridge_sent_total: number;
    inbound_received: number;
    inbound_rejected: number;
  };
  health: {
    initial: { healthy: boolean; state: string; connection: string | null; bridge: unknown };
    degraded: { healthy: boolean; connection: string | null; last_error: string | null; bridge: unknown };
    restored_healthy: boolean;
  };
  logs: {
    event_types: Record<string, number>;
    all_expected_present: boolean;
    expected: string[];
  };
  disable: {
    status: number;
    bridge_disconnected: boolean;
    channel_enabled: boolean;
    channel_state: string | null;
    inbound_after_disable: number;
    stopped_audited: number;
  };
  real_wechat_layer: {
    status: "not_run_external_block";
    reason: string;
    requires: string[];
  };
  rounds: RoundResult[];
  pass: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rounds = parseRounds(argv);
  const outDir = parseOutArg(argv);
  const dir = tmpDir("morrow-ac15-wechat-");
  const bridge = new StubLocalBridge();
  const adapter = new WeChatChannelAdapter({ accountId: "wechat-default", bridge });
  const config: RuntimeConfig = { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };

  let runtime: RuntimeHandle | undefined;
  try {
    runtime = await startRuntime(config, {
      secretStore: createInMemorySecretStore(),
      agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["AC-15 ", "回复"] }] }),
      channelAdapters: [
        {
          adapter,
          account: {
            account_id: "wechat-default",
            channel_id: "wechat",
            native_account_id: "wx_owner",
            display_name: "Morrow WeChat (AC-15 stub)",
            owner_native_ids: ["wx_owner"],
          },
        },
      ],
      outboxBackoffBaseMs: 100,
      notificationDrainIntervalMs: 0,
    });
    const base = `http://127.0.0.1:${runtime.port}`;
    const rt = runtime;

    // --- 1) 配置与环境声明（出厂 disabled） -----------------------------------
    const initialList = await getJson<{ channels: ChannelSummary[] }>(base, "/v1/channels");
    assert.equal(initialList.status, 200);
    const initialWechat = initialList.body.channels.find((channel) => channel.channel_id === "wechat");
    assert.ok(initialWechat !== undefined);
    assert.equal(initialWechat.enabled, false);
    assert.equal(initialWechat.state, "stopped");
    assert.equal(initialWechat.experimental, true);
    assert.equal(initialWechat.environment?.os, "Windows");
    assert.match(initialWechat.environment?.client ?? "", /微信/);
    assert.equal(initialWechat.risk_notice, WECHAT_RISK_NOTICE);
    assert.match(WECHAT_RISK_NOTICE, /默认关闭/);
    assert.match(WECHAT_RISK_NOTICE, /风险自担/);

    const initialHealth = await getJson<ChannelHealth>(base, "/v1/channels/wechat/health");
    assert.equal(initialHealth.status, 200);
    assert.equal(initialHealth.body.healthy, false);
    assert.equal(initialHealth.body.state, "stopped");
    assert.equal(initialHealth.body.experimental, true);
    assert.equal(initialHealth.body.bridge?.process, "stopped");
    assert.equal(initialHealth.body.risk_notice, WECHAT_RISK_NOTICE);
    assert.deepEqual(initialHealth.body.environment, WECHAT_ENVIRONMENT);

    // --- 2) 风险确认 ---------------------------------------------------------
    const refused = await postJson<{ error?: { code?: string }; risk_notice?: string }>(
      base,
      "/v1/channels/wechat/enable",
      {},
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error?.code, "risk_confirmation_required");
    assert.equal(refused.body.risk_notice, WECHAT_RISK_NOTICE);
    assert.equal(bridge.connected, false, "未确认风险绝不连接本地桥");

    const enabled = await postJson(base, "/v1/channels/wechat/enable", { confirm_risk: true });
    assert.equal(enabled.status, 200);
    assert.equal(bridge.connected, true);
    const enabledAudit = rt.ledger.scan({ eventType: "channel.experimental_enabled" });
    assert.equal(enabledAudit.length, 1);
    assert.equal(enabledAudit[0]?.envelope.payload.confirm_risk, true);

    const allow = await putJson(base, "/v1/channels/wechat/allowlist", {
      allowlist: [{ native_conversation_id: ALLOWED, mode: "mention_only" }],
    });
    assert.equal(allow.status, 200);

    // --- 3) 白名单收发 / 非白名单阻断 ----------------------------------------
    const results: RoundResult[] = [];
    const inboundBaseline = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;
    const rejectedBaseline = rt.ledger.scan({ eventType: "channel.inbound_rejected" }).length;
    for (let round = 1; round <= rounds; round += 1) {
      const errors: string[] = [];
      const beforeInbound = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;
      const beforeRejected = rt.ledger.scan({ eventType: "channel.inbound_rejected" }).length;
      const beforeSent = bridge.sent.length;

      bridge.emit({
        message_id: `ac15-in-${round}`,
        conversation_id: ALLOWED,
        conversation_kind: "direct",
        sender: { id: "wx_owner", name: "Owner" },
        text: `AC-15 白名单消息第 ${round} 轮`,
        timestamp: new Date().toISOString(),
      });
      let allowedSent = false;
      try {
        await waitFor(`round ${round} inbound`, () =>
          rt.ledger.scan({ eventType: "channel.inbound_received" }).length >= beforeInbound + 1,
        );
        await waitFor(`round ${round} outbox`, () =>
          rt.outbox.list({}).messages.some((row) => row.status === "pending"),
        );
        const dispatched = await rt.outbox.dispatchOnce();
        assert.equal(dispatched.sent, 1);
        assert.equal(bridge.sent.length - beforeSent, 1, "one bridge reply");
        assert.equal(bridge.sent.at(-1)?.conversation_id, ALLOWED);
        allowedSent = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      bridge.emit({
        message_id: `ac15-blocked-${round}`,
        conversation_id: BLOCKED,
        conversation_kind: "direct",
        sender: { id: "wx_stranger", name: "Stranger" },
        text: `AC-15 非白名单消息第 ${round} 轮`,
        timestamp: new Date().toISOString(),
      });
      let blockedRejected = false;
      try {
        await waitFor(`round ${round} non-allowlisted rejection`, () =>
          rt.ledger.scan({ eventType: "channel.inbound_rejected" }).length >= beforeRejected + 1,
        );
        const rejection = rt.ledger.scan({ eventType: "channel.inbound_rejected" }).at(-1);
        assert.equal(rejection?.envelope.payload.reason, "conversation_not_allowed");
        assert.equal(bridge.sent.length - beforeSent, 1, "blocked conversation never gets a reply");
        blockedRejected = true;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      results.push({
        round,
        allowed_sent: allowedSent,
        blocked_rejected: blockedRejected,
        blocked_sent_extra: bridge.sent.length - beforeSent - 1,
        errors,
      });
      if (errors.length > 0) break;
    }

    // --- 4) 健康检查（故障注入 → 降级 → 恢复） ------------------------------
    bridge.setStatus({ process: "error", login: "logged_out", window: "unavailable", last_error: "bridge crashed" });
    const degraded = await getJson<ChannelHealth>(base, "/v1/channels/wechat/health");
    assert.equal(degraded.status, 200);
    assert.equal(degraded.body.healthy, false);
    assert.equal(degraded.body.connection, "degraded");
    assert.equal(degraded.body.last_error, "bridge crashed");
    assert.equal(degraded.body.bridge?.process, "error");
    assert.equal(degraded.body.bridge?.login, "logged_out");
    assert.equal(degraded.body.bridge?.window, "unavailable");

    bridge.setStatus({ process: "running", login: "logged_in", window: "available", last_error: null });
    const restored = await getJson<ChannelHealth>(base, "/v1/channels/wechat/health");
    assert.equal(restored.body.healthy, true);

    // --- 5) 日志可诊断（结构化审计链） ---------------------------------------
    const expectedEvents = [
      "channel.adapter_started",
      "channel.experimental_enabled",
      "channel.inbound_received",
      "channel.inbound_rejected",
    ];
    const eventTypes: Record<string, number> = {};
    for (const eventType of expectedEvents) {
      eventTypes[eventType] = rt.ledger.scan({ eventType }).length;
    }
    const allExpectedPresent = expectedEvents.every((eventType) => (eventTypes[eventType] ?? 0) > 0);

    // --- 6) 关闭 -------------------------------------------------------------
    const disabled = await postJson(base, "/v1/channels/wechat/disable", {});
    assert.equal(disabled.status, 200);
    assert.equal(bridge.connected, false);
    const finalList = await getJson<{ channels: ChannelSummary[] }>(base, "/v1/channels");
    const finalWechat = finalList.body.channels.find((channel) => channel.channel_id === "wechat");
    assert.equal(finalWechat?.enabled, false);
    assert.equal(finalWechat?.state, "stopped");

    const beforeAfterDisable = rt.ledger.scan({ eventType: "channel.inbound_received" }).length;
    bridge.emit({
      message_id: "ac15-after-disable",
      conversation_id: ALLOWED,
      conversation_kind: "direct",
      sender: { id: "wx_owner", name: "Owner" },
      text: "禁用后",
      timestamp: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const inboundAfterDisable = rt.ledger.scan({ eventType: "channel.inbound_received" }).length - beforeAfterDisable;
    assert.equal(inboundAfterDisable, 0, "disabled adapter stops receiving");
    const stoppedAudited = rt.ledger.scan({ eventType: "channel.adapter_stopped" }).length;
    assert.ok(stoppedAudited >= 1);

    const completed = results.length;
    const allowedPassed = results.filter((result) => result.allowed_sent).length;
    const blockedPassed = results.filter((result) => result.blocked_rejected && result.blocked_sent_extra === 0).length;

    const report: Ac15Report = {
      ticket: "M4-T9 / Issue #46 AC-15",
      generated_at: new Date().toISOString(),
      environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
      config: {
        factory_disabled: initialWechat.enabled === false,
        experimental: initialWechat.experimental === true,
        environment_declared: initialWechat.environment,
        risk_notice: String(initialWechat.risk_notice),
        expected_environment: WECHAT_ENVIRONMENT,
      },
      risk_confirmation: {
        refused_status: refused.status,
        refused_code: refused.body.error?.code ?? null,
        enabled_status: enabled.status,
        audit_events: enabledAudit.length,
      },
      allowlist: {
        rounds_requested: rounds,
        rounds_completed: completed,
        allowed_sent: { passed: allowedPassed, total: completed },
        blocked_rejected: { passed: blockedPassed, total: completed },
        bridge_sent_total: bridge.sent.length,
        inbound_received: rt.ledger.scan({ eventType: "channel.inbound_received" }).length - inboundBaseline,
        inbound_rejected: rt.ledger.scan({ eventType: "channel.inbound_rejected" }).length - rejectedBaseline,
      },
      health: {
        initial: {
          healthy: initialHealth.body.healthy,
          state: initialHealth.body.state,
          connection: initialHealth.body.connection ?? null,
          bridge: initialHealth.body.bridge,
        },
        degraded: {
          healthy: degraded.body.healthy,
          connection: degraded.body.connection ?? null,
          last_error: degraded.body.last_error ?? null,
          bridge: degraded.body.bridge,
        },
        restored_healthy: restored.body.healthy,
      },
      logs: { event_types: eventTypes, all_expected_present: allExpectedPresent, expected: expectedEvents },
      disable: {
        status: disabled.status,
        bridge_disconnected: bridge.connected === false,
        channel_enabled: finalWechat?.enabled ?? true,
        channel_state: finalWechat?.state ?? null,
        inbound_after_disable: inboundAfterDisable,
        stopped_audited: stoppedAudited,
      },
      real_wechat_layer: {
        status: "not_run_external_block",
        reason:
          "真实微信个人号联调需要 Owner 的 Windows 机器 + 最新版微信 + 真实本地自动化桥；M4 只交付可注入 LocalBridge 接缝与平台桩验证，真实桥未实现。",
        requires: ["Windows 声明环境（最新版微信）", "真实本地自动化桥实现", "Owner 现场登录与白名单会话"],
      },
      rounds: results,
      pass:
        completed === rounds &&
        allowedPassed === rounds &&
        blockedPassed === rounds &&
        allExpectedPresent &&
        inboundAfterDisable === 0 &&
        degraded.body.healthy === false &&
        restored.body.healthy === true &&
        refused.status === 409,
    };

    const markdown = renderMarkdown(report);
    if (outDir !== null) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "m4-ac15-wechat.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(outDir, "m4-ac15-wechat.md"), markdown, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    console.log("\n--- Markdown ---\n");
    console.log(markdown);
    if (!report.pass) throw new Error("AC-15 assertions failed");
  } finally {
    if (runtime !== undefined) await runtime.close().catch(() => undefined);
    removeDir(dir);
  }
}

function renderMarkdown(report: Ac15Report): string {
  const lines: string[] = [];
  lines.push("# AC-15 协议层复跑（微信个人号实验适配器，平台协议桩）");
  lines.push("");
  lines.push(`- 票：${report.ticket}`);
  lines.push(`- 生成时间：${report.generated_at} ｜ Node ${report.environment.node} ｜ ${report.environment.platform}`);
  lines.push("- 口径：真实 `WeChatChannelAdapter` + `StubLocalBridge`（纯内存，零真实微信/零网络）");
  lines.push("");
  lines.push("| 项 | 结果 |");
  lines.push("|---|---|");
  lines.push(`| 配置与环境声明 | 出厂 disabled=${report.config.factory_disabled}；experimental=${report.config.experimental}；环境 os=${String((report.config.environment_declared as Record<string, unknown>)?.os)}；风险文案常驻 |`);
  lines.push(`| 风险确认 | 未确认 → ${report.risk_confirmation.refused_status} ${report.risk_confirmation.refused_code}；确认后 → ${report.risk_confirmation.enabled_status}，审计 ${report.risk_confirmation.audit_events} 条 |`);
  lines.push(`| 白名单收发 | **${report.allowlist.allowed_sent.passed}/${report.allowlist.allowed_sent.total}**（桥实发 ${report.allowlist.bridge_sent_total} 条） |`);
  lines.push(`| 非白名单阻断 | **${report.allowlist.blocked_rejected.passed}/${report.allowlist.blocked_rejected.total}**（无外发） |`);
  lines.push(`| 健康检查 | 初始 healthy=${report.health.initial.healthy} → 故障 healthy=${report.health.degraded.healthy}（${String(report.health.degraded.last_error)}）→ 恢复 healthy=${report.health.restored_healthy} |`);
  lines.push(`| 日志审计 | 期望事件齐全=${report.logs.all_expected_present}（${report.logs.expected.join(" / ")}） |`);
  lines.push(`| 关闭 | disable ${report.disable.status}；桥断开=${report.disable.bridge_disconnected}；禁用后入站 ${report.disable.inbound_after_disable} 条 |`);
  lines.push("");
  lines.push(`**真实微信层：未做（外部阻塞）** —— ${report.real_wechat_layer.reason}`);
  lines.push("");
  lines.push(`**判定：${report.pass ? "PASS" : "FAIL"}**（协议层；真实环境未达成）`);
  lines.push("");
  return lines.join("\n");
}

main().catch((err: unknown) => {
  console.error(`[ac15] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
