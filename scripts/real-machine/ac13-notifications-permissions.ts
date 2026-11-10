#!/usr/bin/env node
/**
 * AC-13 协议层复跑归档（M4-T9 / Issue #46；PRD §11 AC-13 / §4.8 FR-NOT-1/2/3）。
 *
 * 两个口径，全部零真实网络：
 *   A. **权限**：可信联系人五类越权（private 记忆 / 文件 / 开发工具 / 未授权能力 /
 *      他人会话）各 20 次 = 100 次尝试，经 `PermissionEngine` 单一入口 100% 阻断并留
 *      `contact.permission_denied`（reason 逐类可辨）；public 记忆对照组 20/20 放行。
 *   B. **通知**：四类事件（completed / failed / waiting_input / milestone）× 两个目标
 *      （desktop / channel:echo）× 20 轮；每轮每类事件重复投递一次 → 去重窗口内只送达
 *      一次（断言 delivered 160 / suppressed 160）；渠道行经 Outbox → echo 适配器实发。
 *
 * 复用既有测试口径：`apps/runtime/test/contacts.permissions.test.ts`（五类越权与
 * authorizeContactUse 同源）与 `notifications.service.test.ts`（去重/路由同源）。
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac13-notifications-permissions.ts \
 *     [--out docs/gates] [--rounds 20]
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePi } from "../../packages/pi-adapter/src/index.ts";
import type { InboundMessage, NotificationHistoryPage, NotificationRecord } from "@morrow/protocol";
import type { RuntimeConfig } from "../../apps/runtime/src/config.ts";
import { createInMemorySecretStore } from "../../apps/runtime/src/keyring.ts";
import { buildEventEnvelope } from "../../apps/runtime/src/envelope.ts";
import { startRuntime, type RuntimeHandle } from "../../apps/runtime/src/runtime.ts";
import { uuidv7 } from "../../apps/runtime/src/uuid-v7.ts";
import { removeDir, tmpDir } from "../../apps/runtime/test/helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const DEFAULT_ROUNDS = 20;
const EVENT_TYPES = ["completed", "failed", "waiting_input", "milestone"] as const;

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
}

interface GrantList {
  contact_id: string;
  grants: Array<{ category: string; scope: string[] }>;
}

interface RoundResult {
  round: number;
  permission_attempts: number;
  permission_blocked: number;
  public_control_allowed: number;
  notifications_delivered: number;
  notifications_suppressed: number;
  errors: string[];
}

interface Ac13Report {
  ticket: "M4-T9 / Issue #46 AC-13";
  generated_at: string;
  environment: { node: string; platform: string };
  permissions: {
    contact_id: string;
    categories: Array<{ category: string; action: string; attempts: number; blocked: number; reason: string }>;
    total_attempts: number;
    total_blocked: number;
    block_rate: string;
    public_control: { attempts: number; allowed: number };
    denials_audited: number;
    grants: Array<{ category: string; scope: string[] }>;
  };
  notifications: {
    rules: number;
    rounds: number;
    delivered: number;
    suppressed: number;
    history_total: number;
    desktop_pending: number;
    channel_sent: number;
    echo_sent: number;
    dedupe_rate: string;
    by_event_type: Record<string, number>;
  };
  rounds: RoundResult[];
  pass: boolean;
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
    native_message_id: `ac13-m-${seq}`,
    native_conversation_id: overrides.conversation ?? `dm-${overrides.sender ?? "owner"}`,
    conversation_kind: overrides.kind ?? "direct",
    sender: { native_id: overrides.sender ?? "owner", display_name: overrides.sender ?? "Owner" },
    mention: { agent: overrides.mention ?? false },
    attachments: [],
    timestamp: new Date().toISOString(),
    text: overrides.text ?? "hello",
    permission_context: null,
  };
}

function taskEventType(type: (typeof EVENT_TYPES)[number]): { event_type: string; payload: Record<string, unknown> } {
  switch (type) {
    case "completed":
      return { event_type: "task.completed", payload: { goal: "AC-13 通知演示" } };
    case "failed":
      return { event_type: "task.failed", payload: { error: "AC-13 失败演示" } };
    case "waiting_input":
      return { event_type: "task.waiting_input", payload: { reason: "AC-13 等待输入" } };
    case "milestone":
      return { event_type: "task.node_finished", payload: { status: "completed", node_key: "milestone" } };
    default:
      throw new Error("unreachable");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rounds = parseRounds(argv);
  const outDir = parseOutArg(argv);
  const dir = tmpDir("morrow-ac13-");
  const config: RuntimeConfig = { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };

  let runtime: RuntimeHandle | undefined;
  try {
    runtime = await startRuntime(config, {
      secretStore: createInMemorySecretStore(),
      enableEchoChannel: true,
      agentAdapterFactory: async () => createFakePi({ script: [{ kind: "text", deltas: ["AC-13 ", "ack"] }] }),
      notificationDrainIntervalMs: 0,
    });
    const base = `http://127.0.0.1:${runtime.port}`;
    const rt = runtime;
    const echo = rt.channels.getAdapter("echo");
    assert.ok(echo !== undefined, "echo adapter");

    // --- A. 联系人与五类越权 ---------------------------------------------------
    const invite = await postJson<Invite>(base, "/v1/contacts/invites", { display_name: "AC13 Carol" });
    assert.equal(invite.status, 201);
    const bound = rt.channels.routeInbound(
      inbound({ sender: "carol", text: invite.body.code, conversation: "dm-carol" }),
    );
    assert.equal(bound.decision, "processed");
    const contactId = invite.body.contact_id;
    const ownSession = bound.session_id as string;
    assert.ok(ownSession.length > 0);

    const grants = await putJson<GrantList>(base, `/v1/contacts/${contactId}/grants`, {
      grants: [{ category: "memory_reference" }, { category: "task_execute", scope: ["allowed.capability"] }],
    });
    assert.equal(grants.status, 200);

    // 绑定消息的助手回复（echo 直发）先完成并清基线，避免污染通知渠道计数
    await waitFor("contact bind reply delivered", () => ((echo as { sent?: readonly unknown[] }).sent ?? []).length >= 1);
    const echoSentBaseline = ((echo as { sent?: readonly unknown[] }).sent ?? []).length;

    const ownerSession = rt.sessions.createSession("AC-13 owner private session").sessionId;
    const categories = [
      {
        category: "private_memory",
        action: "memory_read",
        reason: "private_memory_denied",
        call: () =>
          rt.capabilities.authorizeContactUse({ contact_id: contactId, action: "memory_read", sensitivity: "private" }),
      },
      {
        category: "filesystem",
        action: "filesystem",
        reason: "filesystem_denied",
        call: () =>
          rt.capabilities.authorizeContactUse({
            contact_id: contactId,
            action: "filesystem",
            path: "/Users/owner/secrets.txt",
          }),
      },
      {
        category: "dev_tools",
        action: "shell",
        reason: "dev_tools_denied",
        call: () =>
          rt.capabilities.authorizeContactUse({ contact_id: contactId, action: "shell", category: "arbitrary" }),
      },
      {
        category: "unauthorized_capability",
        action: "capability",
        reason: "capability_not_granted",
        call: () =>
          rt.capabilities.authorizeContactUse({
            contact_id: contactId,
            action: "capability",
            capability: "memory.write",
          }),
      },
      {
        category: "other_session",
        action: "session",
        reason: "session_not_owned",
        call: () =>
          rt.capabilities.authorizeContactUse({ contact_id: contactId, action: "session", session_id: ownerSession }),
      },
    ] as const;

    const categoryResults: Ac13Report["permissions"]["categories"] = [];
    const perRoundPermission: Array<{ attempts: number; blocked: number; public_ok: number; errors: string[] }> = [];
    let totalAttempts = 0;
    let totalBlocked = 0;
    let publicAttempts = 0;
    let publicAllowed = 0;

    for (let round = 1; round <= rounds; round += 1) {
      const errors: string[] = [];
      let attempts = 0;
      let blocked = 0;
      let publicOk = 0;
      for (const [index, category] of categories.entries()) {
        const decision = category.call();
        attempts += 1;
        const entry =
          categoryResults[index] ??
          (categoryResults[index] = {
            category: category.category,
            action: category.action,
            attempts: 0,
            blocked: 0,
            reason: category.reason,
          });
        entry.attempts += 1;
        if (decision.allowed === false && decision.reason === category.reason) {
          blocked += 1;
          entry.blocked += 1;
        } else {
          errors.push(`${category.category} unexpectedly allowed (reason=${String(decision.reason)})`);
        }
      }
      const control = rt.capabilities.authorizeContactUse({
        contact_id: contactId,
        action: "memory_read",
        sensitivity: "public",
      });
      publicAttempts += 1;
      if (control.allowed === true) {
        publicAllowed += 1;
        publicOk = 1;
      } else {
        errors.push("public memory control was denied");
      }
      totalAttempts += attempts;
      totalBlocked += blocked;
      perRoundPermission.push({ attempts, blocked, public_ok: publicOk, errors });
    }

    const denials = rt.ledger.scan({ eventType: "contact.permission_denied" });
    assert.equal(denials.length, totalBlocked, "every denied decision is audited");

    // --- B. 通知规则与去重 -----------------------------------------------------
    const rules: Array<Record<string, unknown>> = [];
    for (const eventType of EVENT_TYPES) {
      rules.push({ event_type: eventType, target: "desktop", enabled: true });
      rules.push({ event_type: eventType, target: "channel:echo", enabled: true });
    }
    const put = await putJson<{ rules: unknown[] }>(base, "/v1/notifications/rules", { rules });
    assert.equal(put.status, 200);
    assert.equal(put.body.rules.length, rules.length);

    const perTypeDelivered: Record<string, number> = {};
    const roundResults: RoundResult[] = [];
    let delivered = 0;
    let suppressed = 0;
    const suppressedBaseline = rt.ledger.scan({ eventType: "notification.suppressed" }).length;

    for (let round = 1; round <= rounds; round += 1) {
      const errors: string[] = [];
      const taskId = uuidv7();
      let roundDelivered = 0;
      let roundSuppressed = 0;
      for (const type of EVENT_TYPES) {
        const { event_type, payload } = taskEventType(type);
        const envelope = buildEventEnvelope({
          replicaId: REPLICA,
          actorId: "agent:runtime",
          eventType: event_type,
          taskId,
          payload,
        });
        rt.ledger.append(envelope);
        roundDelivered += 2; // desktop + channel:echo
        perTypeDelivered[type] = (perTypeDelivered[type] ?? 0) + 2;
        // 同窗口重复投递 → 两个目标均被去重
        rt.ledger.append(
          buildEventEnvelope({
            replicaId: REPLICA,
            actorId: "agent:runtime",
            eventType: event_type,
            taskId,
            payload,
          }),
        );
        roundSuppressed += 2;
      }
      delivered += roundDelivered;
      suppressed += roundSuppressed;
      roundResults.push({
        round,
        permission_attempts: perRoundPermission[round - 1]?.attempts ?? 0,
        permission_blocked: perRoundPermission[round - 1]?.blocked ?? 0,
        public_control_allowed: perRoundPermission[round - 1]?.public_ok ?? 0,
        notifications_delivered: roundDelivered,
        notifications_suppressed: roundSuppressed,
        errors: [...(perRoundPermission[round - 1]?.errors ?? []), ...errors],
      });
    }

    const suppressedAudited = rt.ledger.scan({ eventType: "notification.suppressed" }).length - suppressedBaseline;
    assert.equal(suppressedAudited, suppressed, "each duplicate is audited as suppressed");

    await rt.notifications.drain();
    const history = await getJson<NotificationHistoryPage>(base, "/v1/notifications/history?limit=200");
    assert.equal(history.status, 200);
    const historyRows = history.body.notifications;
    const desktop = historyRows.filter((row: NotificationRecord) => row.target === "desktop");
    const channel = historyRows.filter((row: NotificationRecord) => row.target.startsWith("channel:"));
    const echoSent = ((echo as { sent?: readonly unknown[] }).sent ?? []).length - echoSentBaseline;
    const channelSent = channel.filter((row) => row.status === "sent").length;
    assert.equal(desktop.length, rounds * EVENT_TYPES.length, "desktop delivery per event type per round");
    assert.equal(channel.length, rounds * EVENT_TYPES.length, "channel delivery per event type per round");
    assert.equal(echoSent, channel.length, "channel notifications dispatched through Outbox → echo");
    assert.equal(channelSent, channel.length, "channel notifications marked sent after receipts");

    const report: Ac13Report = {
      ticket: "M4-T9 / Issue #46 AC-13",
      generated_at: new Date().toISOString(),
      environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
      permissions: {
        contact_id: contactId,
        categories: categoryResults,
        total_attempts: totalAttempts,
        total_blocked: totalBlocked,
        block_rate: `${((totalBlocked / Math.max(1, totalAttempts)) * 100).toFixed(1)}%`,
        public_control: { attempts: publicAttempts, allowed: publicAllowed },
        denials_audited: denials.length,
        grants: grants.body.grants,
      },
      notifications: {
        rules: rules.length,
        rounds,
        delivered,
        suppressed,
        history_total: history.body.total,
        desktop_pending: desktop.filter((row) => row.status === "pending").length,
        channel_sent: channelSent,
        echo_sent: echoSent,
        dedupe_rate: `${((suppressed / Math.max(1, suppressed + delivered)) * 100).toFixed(1)}%`,
        by_event_type: perTypeDelivered,
      },
      rounds: roundResults,
      pass:
        totalBlocked === totalAttempts &&
        totalAttempts === rounds * categories.length &&
        publicAllowed === publicAttempts &&
        delivered === rounds * EVENT_TYPES.length * 2 &&
        suppressed === delivered &&
        channel.length === rounds * EVENT_TYPES.length &&
        echoSent === channel.length &&
        suppressedAudited === suppressed,
    };

    const markdown = renderMarkdown(report);
    if (outDir !== null) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "m4-ac13-notifications-permissions.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(outDir, "m4-ac13-notifications-permissions.md"), markdown, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    console.log("\n--- Markdown ---\n");
    console.log(markdown);
    if (!report.pass) throw new Error("AC-13 assertions failed");
  } finally {
    if (runtime !== undefined) await runtime.close().catch(() => undefined);
    removeDir(dir);
  }
}

function renderMarkdown(report: Ac13Report): string {
  const lines: string[] = [];
  lines.push("# AC-13 协议层复跑（通知与权限）");
  lines.push("");
  lines.push(`- 票：${report.ticket}`);
  lines.push(`- 生成时间：${report.generated_at} ｜ Node ${report.environment.node} ｜ ${report.environment.platform}`);
  lines.push("");
  lines.push("## A. 可信联系人越权 100% 阻断");
  lines.push("");
  lines.push("| 类别 | 动作 | 尝试 | 阻断 | 原因 |");
  lines.push("|---|---|---|---|---|");
  for (const category of report.permissions.categories) {
    lines.push(`| ${category.category} | ${category.action} | ${category.attempts} | ${category.blocked} | ${category.reason} |`);
  }
  lines.push("");
  lines.push(`- 合计：**${report.permissions.total_blocked}/${report.permissions.total_attempts} 阻断（${report.permissions.block_rate}）**；审计事件 \`contact.permission_denied\` ${report.permissions.denials_audited} 条`);
  lines.push(`- 对照组（public 记忆，memory_reference）：${report.permissions.public_control.allowed}/${report.permissions.public_control.attempts} 放行`);
  lines.push("");
  lines.push("## B. 通知路由与去重");
  lines.push("");
  lines.push(`- 规则：${report.notifications.rules} 条（completed/failed/waiting_input/milestone × desktop/channel:echo）`);
  lines.push(`- ${report.notifications.rounds} 轮：每类事件向两个目标各投递 2 次 → 送达 **${report.notifications.delivered}** 条，窗口内重复被去重 **${report.notifications.suppressed}** 条（重复投递抑制率 ${report.notifications.dedupe_rate}；即第 2 次投递 100% 被抑制）`);
  lines.push(`- 历史：${report.notifications.history_total} 条（desktop pending ${report.notifications.desktop_pending} / channel sent ${report.notifications.channel_sent}）；echo 适配器实发 ${report.notifications.echo_sent}`);
  lines.push("");
  lines.push(`**判定：${report.pass ? "PASS" : "FAIL"}**（协议层，零真实网络）`);
  lines.push("");
  return lines.join("\n");
}

main().catch((err: unknown) => {
  console.error(`[ac13] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
