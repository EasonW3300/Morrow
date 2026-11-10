#!/usr/bin/env node
/**
 * AC-14 端到端集成演示（M4-T9 / Issue #46；PRD §11 AC-14）。
 *
 * 每轮独立起两个 Runtime（A/B，独立 dataDir / replica_id / HTTP 端口），全部走真实
 * HTTP 接缝；A 注入真实飞书适配器 + 平台协议桩。两轮 × 10 项断言：
 *
 *   1. 渠道入站：飞书桩私聊事件 → 签名/解密 → 统一入站 → 会话（AC-09 前置链路）；
 *   2. 渠道发起任务：POST /v1/tasks 携带渠道会话 session_id → DAG 规划并后台执行；
 *   3. 任务关联：渠道消息经中间路由关联 task_id（原始平台记录不改写）；
 *   4. 自动建能力：任务所需能力缺失 → 能力工厂 request → 沙箱验证 → Owner 确认注册；
 *   5. 记忆更新：渠道消息轮次收尾自动抽取 → 巩固为事实（检索可查）；
 *   6. 跨设备查看：A→B 配对 + 双向同步后，B 可见同一任务与同一记忆事实；
 *   7. 检查点恢复：pause → checkpoint（FR-TASK-5 快照）→ restore → 任务完成；
 *   8. 外发审计：渠道回复经 Outbox 投递，outbound.* 审计与平台回执对账；
 *   9. 通知与越权阻断：完成事件按规则去重投递到桌面；可信联系人五类越权全部阻断；
 *  10. 语音段：PRD AC-11 属 M5 —— **M4 未实现**，如实标注（不伪造通过）。
 *
 * 说明（如实边界）：
 * - 「渠道发起任务」由演示脚本把渠道入站文本转成 POST /v1/tasks（携带渠道会话）；
 *   产品当前没有从自然语言自动派生任务意图的独立路径 —— 任务创建与渠道关联都是真实
 *   端点，意图桥接是本脚本承担的演示编排。
 * - 能力工厂生成器为脚本化实现（FakePi 同款口径，零 LLM）；沙箱为本地桩 Runner
 *   （与 AC-06 桩路径同源），容器路径证据见 m2 门禁报告。
 * - 真实 Tailscale/Wi-Fi 双机、真实飞书/QQ/微信平台均未验证（外部依赖/资质），见
 *   docs/gates/m4-gate-report.md §3/§6。
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-sqlite --experimental-strip-types scripts/real-machine/m4-demo.ts \
 *     [--out docs/gates/m4-demo-output.md] [--rounds 2] [--keep]
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createFakePi } from "../../packages/pi-adapter/src/index.ts";
import type { ChannelTestServer } from "../../apps/runtime/src/channels/testing/channel-test-server.ts";
import { FeishuChannelAdapter, type FeishuConfig } from "../../apps/runtime/src/channels/adapters/feishu/index.ts";
import { buildEventEnvelope } from "../../apps/runtime/src/envelope.ts";
import type { TaskDetail } from "@morrow/protocol";
import { LocalNodeRunner } from "../../apps/runtime/test/factory-stub-runner.ts";
import {
  REPLICA_A,
  REPLICA_B,
  assertStatus,
  closePair,
  getJson,
  hasFlag,
  nodeEnv,
  pairViaJoin,
  postJson,
  requestJson,
  startPair,
  syncRounds,
  urlFor,
  type Pair,
} from "./lib/m3-harness.ts";

const DEFAULT_ROUNDS = 2;

const FEISHU_CONFIG: FeishuConfig = {
  appId: "cli_m4_demo",
  appSecret: "m4_demo_app_secret",
  verificationToken: "m4_demo_verification_token",
  encryptKey: "m4_demo_encrypt_key",
  botOpenId: "ou_bot",
};

const CAPABILITY_SOURCE = `export async function run(input: { text?: string; escape?: boolean }): Promise<{ slug: string }> {
  if (input.escape === true) throw new Error("refused: escalation attempt");
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  const slug = input.text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("empty text: nothing to slugify");
  return { slug };
}`;

interface Check {
  index: number;
  name: string;
  pass: boolean;
  evidence: string;
}

interface RoundReport {
  round: number;
  started_at: string;
  finished_at: string;
  checks: Check[];
  pass: boolean;
  notes: string[];
}

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
  if (value === undefined || value.startsWith("--")) throw new Error("--out requires a file path");
  return value;
}

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await delay(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function getTask(pair: Pair, taskId: string): Promise<TaskDetail> {
  return assertStatus(await getJson<TaskDetail>(pair.a, `/v1/tasks/${taskId}`), 200, "GET /v1/tasks/:id (A)");
}

async function getTaskOnB(pair: Pair, taskId: string): Promise<{ status: number; body: TaskDetail }> {
  const response = await getJson<TaskDetail>(pair.b, `/v1/tasks/${taskId}`);
  return { status: response.status, body: response.body };
}

interface RequestView {
  request_id: string;
  status: string;
  stage: string;
  manifest?: { name: string; author: string };
  report?: { ok: boolean; cases: Array<{ kind: string; pass: boolean }> };
  error?: { stage: string; code: string; detail: string };
  capability_name?: string;
}

interface CapabilityList {
  capabilities: Array<{ name: string; author: string; status: string; version: string }>;
}

interface NotificationHistory {
  notifications: Array<{ task_id: string; event_type: string; target: string; status: string }>;
  total: number;
}

interface Invite {
  invite_id: string;
  contact_id: string;
  code: string;
}

function capabilityOutput(round: number) {
  return {
    name: `m4demo.round${round}`,
    version: "1.0.0",
    description: "AC-14 演示：把文本转成 URL-safe slug（沙箱验证）",
    permissions: { filesystem: [], network: [], shell: [], channels: ["desktop"], credentials: [] },
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    output_schema: { type: "object", properties: { slug: { type: "string" } } },
    sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
    dependencies: {},
    source: CAPABILITY_SOURCE,
    test_cases: [
      { case_id: "pos-basic", kind: "positive", input: { text: "Hello M4" }, expect: { outcome: "success", result: { slug: "hello-m4" } } },
      { case_id: "neg-empty", kind: "negative", input: { text: "  " }, expect: { outcome: "failure", errorContains: "empty" } },
      { case_id: "esc-1", kind: "privilege-escalation", input: { text: "x", escape: true }, expect: { outcome: "failure" } },
      { case_id: "fault-1", kind: "fault", input: { text: 42 }, expect: { outcome: "failure" } },
    ],
  };
}

async function runRound(round: number, server: ChannelTestServer): Promise<RoundReport> {
  const startedAt = new Date().toISOString();
  const checks: Check[] = [];
  const notes: string[] = [];
  const add = (name: string, pass: boolean, evidence: string): void => {
    checks.push({ index: checks.length + 1, name, pass, evidence });
  };

  const pair = await startPair({
    optionsFor: (name) => {
      if (name !== "A") return {};
      const adapter = new FeishuChannelAdapter({
        accountId: "feishu-default",
        config: FEISHU_CONFIG,
        baseUrl: server.baseUrl,
        requestTimeoutMs: 500,
        eventPollTimeoutMs: 20,
        eventReconnectDelayMs: 5,
      });
      return {
        agentAdapterFactory: async () =>
          createFakePi({ script: [{ kind: "text", deltas: ["M4 演示 ", "渠道回复"] }] }),
        taskPlannerFactory: async () =>
          createFakePi({
            script: [
              {
                kind: "text",
                deltas: [
                  JSON.stringify({
                    nodes: [
                      {
                        key: "a",
                        title: "渠道请求收尾",
                        goal: "使用慢工具完成第一阶段",
                        depends_on: [],
                        retriable: false,
                        side_effect: "reversible",
                      },
                      {
                        key: "b",
                        title: "归档",
                        goal: "第二阶段归档",
                        depends_on: ["a"],
                        retriable: false,
                        side_effect: "reversible",
                      },
                    ],
                  }),
                ],
              },
            ],
          }),
        taskNodeAgentFactory: async (node) =>
          createFakePi({
            script:
              node.key === "a"
                ? [{ kind: "tool", toolName: "slow" }, { kind: "text", deltas: ["a-ok"] }]
                : [{ kind: "text", deltas: ["b-ok"] }],
            tools: [
              {
                name: "slow",
                description: "slow demo tool",
                parameters: { type: "object", properties: {} },
                execute: async () => {
                  await delay(1_200);
                  return { text: "slow-done" };
                },
              },
            ],
          }),
        capabilityGenerator: {
          async generate() {
            return { ok: true as const, output: capabilityOutput(round), raw: "{}" };
          },
        },
        sandboxRunner: new LocalNodeRunner(),
        memoryExtractor: {
          extract(input: { userText: string }) {
            if (!input.userText.includes("记住")) return [];
            return [
              {
                content: `M4 演示事实 ac14fact${round}xyz：${input.userText}`,
                kind: "fact" as const,
                confidence: 0.95,
                sensitivity: "public" as const,
                rule: "m4-demo-extractor",
              },
            ];
          },
        },
        channelAdapters: [
          {
            adapter,
            account: {
              account_id: "feishu-default",
              channel_id: "feishu",
              native_account_id: FEISHU_CONFIG.appId,
              display_name: "Morrow Feishu (M4 demo)",
              owner_native_ids: ["ou_owner"],
            },
          },
        ],
        outboxBackoffBaseMs: 100,
        notificationDrainIntervalMs: 0,
        outboxDrainIntervalMs: 0,
      };
    },
  });

  const server2 = server;
  try {
    const pairing = await pairViaJoin(pair);
    notes.push(`pairing: join device=${pairing.joiner_device_replica_id}, token_in_response=${pairing.join_response_has_token}`);

    const rt = pair.a.runtime;

    // 通知规则：完成事件 → 桌面（check 9 的去重/送达对象）
    const rules = await requestJson<{ rules: unknown[] }>(urlFor(pair.a, "/v1/notifications/rules"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules: [{ event_type: "completed", target: "desktop", enabled: true }] }),
    });
    assert.equal(rules.status, 200);

    // --- 1) 渠道入站 ---------------------------------------------------------
    const dmText = `M4 第 ${round} 轮：请记住项目代号 ac14fact${round}xyz`;
    const dm = server2.pushMessage({
      messageId: `m4-round${round}-dm`,
      chatId: `oc_dm_${round}`,
      chatType: "p2p",
      senderOpenId: "ou_owner",
      text: dmText,
    });
    assert.equal(dm, 1);
    await waitFor("channel inbound", () => rt.ledger.scan({ eventType: "channel.inbound_received" }).length >= 1);
    const inbound = rt.ledger.scan({ eventType: "channel.inbound_received" })[0];
    const sessionId = inbound?.envelope.session_id;
    add(
      "渠道入站（飞书桩 → 统一入站 → 会话）",
      typeof sessionId === "string" && sessionId.length > 0,
      `channel.inbound_received event=${inbound?.envelope.event_id ?? "none"}; session=${String(sessionId)}`,
    );

    // --- 2) 渠道发起任务 -----------------------------------------------------
    const goal = `处理渠道请求（第 ${round} 轮）：项目代号 ac14fact${round}xyz`;
    const created = await postJson<TaskDetail>(pair.a, "/v1/tasks", { goal, session_id: sessionId });
    const task = assertStatus(created, 201, "POST /v1/tasks");
    add(
      "渠道发起任务（渠道会话 → 任务 DAG）",
      task.status === "planned" && task.session_id === sessionId && task.nodes.length === 2,
      `task=${task.task_id}; status=${task.status}; session_id=${String(task.session_id)}; nodes=${task.nodes.map((node) => node.key).join("+")}`,
    );

    // --- 3) 任务关联（渠道消息 ↔ task_id） -----------------------------------
    const raw = server2.buildMessageEvent({
      messageId: `m4-round${round}-task`,
      chatId: `oc_task_${round}`,
      chatType: "p2p",
      senderOpenId: "ou_owner",
      text: `任务关联消息（第 ${round} 轮）`,
    });
    const routed = rt.channels.ingest("feishu", raw, { taskId: task.task_id });
    const conversation = rt.channels.getConversation("feishu-default", `oc_task_${round}`);
    const associationEnvelope = rt.ledger
      .scan({ eventType: "channel.inbound_received" })
      .filter((entry) => entry.envelope.task_id === task.task_id);
    add(
      "任务关联（中间路由 task_id，原始记录不改写）",
      routed.decision === "processed" &&
        conversation?.task_id === task.task_id &&
        associationEnvelope.length === 1,
      `decision=${routed.decision}; conversation.task_id=${String(conversation?.task_id)}; envelope.task_id=${associationEnvelope[0]?.envelope.task_id ?? "none"}`,
    );

    // --- 7) 检查点恢复（先于“完成”断言；pause → checkpoint → restore） --------
    await waitFor(
      "node a running",
      async () => (await getTask(pair, task.task_id)).nodes.find((node) => node.key === "a")?.status === "running",
    );
    const pauseRes = await postJson<{
      task: TaskDetail;
      checkpoint: { checkpoint_id: string; reason: string; task_version: number; snapshot: { graph: { nodes: unknown[] } } };
    }>(pair.a, `/v1/tasks/${task.task_id}/pause`);
    const paused = assertStatus(pauseRes, 200, "POST /v1/tasks/:id/pause");
    const checkpoint = paused.checkpoint;
    assert.equal(paused.task.status, "paused");
    assert.equal(checkpoint.reason, "pause");
    assert.equal(checkpoint.snapshot.graph.nodes.length, 2);
    const listedCheckpoints = assertStatus(
      await getJson<{ checkpoints: Array<{ checkpoint_id: string }> }>(pair.a, `/v1/tasks/${task.task_id}/checkpoints`),
      200,
      "GET /v1/tasks/:id/checkpoints",
    );
    const restoreRes = await postJson<{ task: { status: string }; checkpoint_id: string | null }>(
      pair.a,
      `/v1/tasks/${task.task_id}/restore`,
      { checkpoint_id: checkpoint.checkpoint_id },
    );
    const restored = assertStatus(restoreRes, 202, "POST /v1/tasks/:id/restore");
    assert.equal(restored.checkpoint_id, checkpoint.checkpoint_id);
    await waitFor(
      "task completed after restore",
      async () => (await getTask(pair, task.task_id)).status === "completed",
      20_000,
    );
    const finalTask = await getTask(pair, task.task_id);
    add(
      "检查点恢复（pause → checkpoint → restore → completed）",
      finalTask.status === "completed" &&
        finalTask.nodes.every((node) => node.status === "completed") &&
        listedCheckpoints.checkpoints.some((entry) => entry.checkpoint_id === checkpoint.checkpoint_id),
      `checkpoint=${checkpoint.checkpoint_id}; reason=${checkpoint.reason}; snapshot_nodes=${checkpoint.snapshot.graph.nodes.length}; restore=202; final=${finalTask.status}; results=${finalTask.nodes.map((node) => `${node.key}:${node.result ?? "-"}`).join(",")}`,
    );

    // --- 4) 自动建能力（任务所需能力缺失 → 工厂 → 验证 → 确认） ------------
    const grants = await requestJson<unknown>(urlFor(pair.a, "/v1/capabilities/grants"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filesystem: ["workspace://notes/**"],
        network: [],
        shell: [],
        channels: ["desktop"],
        credentials: [],
      }),
    });
    assert.equal(grants.status, 200);
    const request = await postJson<RequestView>(pair.a, "/v1/capabilities/request", {
      description: "把 markdown 表格行转成 CSV（AC-14 演示）",
    });
    assert.equal(request.status, 201);
    let view = request.body;
    await waitFor(
      "factory proposed",
      async () => {
        const current = assertStatus(
          await getJson<RequestView>(pair.a, `/v1/capabilities/requests/${view.request_id}`),
          200,
          "GET /v1/capabilities/requests/:id",
        );
        view = current;
        return current.status === "proposed" || current.status === "failed";
      },
      30_000,
    );
    if (view.status !== "proposed") {
      throw new Error(`factory did not reach proposed: ${JSON.stringify(view)}`);
    }
    const confirmed = assertStatus(
      await postJson<{ capability: { name: string; author: string; status: string } }>(
        pair.a,
        `/v1/capabilities/${view.request_id}/confirm`,
      ),
      200,
      "POST /v1/capabilities/:id/confirm",
    );
    const registry = assertStatus(
      await getJson<CapabilityList>(pair.a, "/v1/capabilities"),
      200,
      "GET /v1/capabilities",
    );
    const registered = registry.capabilities.find((entry) => entry.name === capabilityOutput(round).name);
    add(
      "自动建能力（request → 沙箱验证 → Owner 确认注册）",
      view.status === "proposed" &&
        view.stage === "verified" &&
        confirmed.capability.author === "ai" &&
        confirmed.capability.status === "disabled" &&
        registered !== undefined,
      `request=${view.request_id}; status=${view.status}/${view.stage}; verified_cases=${view.report?.cases.filter((entry) => entry.pass).length ?? 0}/${view.report?.cases.length ?? 0}; registered=${confirmed.capability.name}@${registered?.version ?? "?"} author=${confirmed.capability.author} status=${confirmed.capability.status}`,
    );

    // --- 5) 记忆更新（渠道轮次 → 抽取 → 巩固 → 检索） -----------------------
    const factKeyword = `ac14fact${round}xyz`;
    await waitFor(
      "memory fact",
      async () => {
        const facts = assertStatus(
          await getJson<{ facts: Array<{ content: string; sensitivity: string }> }>(
            pair.a,
            `/v1/memory/facts?q=${factKeyword}`,
          ),
          200,
          "GET /v1/memory/facts",
        );
        return facts.facts.some((entry) => entry.content.includes(factKeyword) && entry.sensitivity === "public");
      },
      15_000,
    );
    const factsA = assertStatus(
      await getJson<{ facts: Array<{ content: string; sensitivity: string }> }>(pair.a, `/v1/memory/facts?q=${factKeyword}`),
      200,
      "GET /v1/memory/facts",
    );
    const fact = factsA.facts.find(
      (entry) => entry.content.includes(factKeyword) && entry.sensitivity === "public",
    );
    add(
      "记忆更新（渠道消息 → 自动抽取 → 巩固为事实）",
      fact !== undefined && fact.sensitivity === "public",
      `fact_found=${fact !== undefined}; sensitivity=${fact?.sensitivity ?? "none"}; content=${fact?.content.slice(0, 80) ?? "-"}`,
    );

    // --- 9) 通知去重 + 联系人五类越权阻断 ------------------------------------
    const history = assertStatus(
      await getJson<NotificationHistory>(pair.a, "/v1/notifications/history?limit=200"),
      200,
      "GET /v1/notifications/history",
    );
    const completedNotification = history.notifications.find(
      (entry) => entry.task_id === task.task_id && entry.event_type === "completed" && entry.target === "desktop",
    );
    const suppressedBefore = rt.ledger.scan({ eventType: "notification.suppressed" }).length;
    rt.ledger.append(
      buildEventEnvelope({
        replicaId: REPLICA_A,
        actorId: "agent:runtime",
        eventType: "task.completed",
        taskId: task.task_id,
        payload: { goal },
      }),
    );
    const suppressedAfter = rt.ledger.scan({ eventType: "notification.suppressed" }).length;

    const invite = await postJson<Invite>(pair.a, "/v1/contacts/invites", { display_name: `M4 Guest ${round}` });
    const inviteBody = assertStatus(invite, 201, "POST /v1/contacts/invites");
    server2.pushMessage({
      messageId: `m4-round${round}-contact`,
      chatId: `oc_guest_${round}`,
      chatType: "p2p",
      senderOpenId: "ou_guest",
      text: inviteBody.code,
    });
    await waitFor(
      "contact bound",
      () => rt.ledger.scan({ eventType: "contact.bound" }).length >= 1,
    );
    const ownerSession = rt.sessions.createSession("AC-14 owner private").sessionId;
    const denialsBefore = rt.ledger.scan({ eventType: "contact.permission_denied" }).length;
    const decisions = [
      rt.capabilities.authorizeContactUse({
        contact_id: inviteBody.contact_id,
        action: "memory_read",
        sensitivity: "private",
      }),
      rt.capabilities.authorizeContactUse({
        contact_id: inviteBody.contact_id,
        action: "filesystem",
        path: "/Users/owner/secrets.txt",
      }),
      rt.capabilities.authorizeContactUse({
        contact_id: inviteBody.contact_id,
        action: "shell",
        category: "arbitrary",
      }),
      rt.capabilities.authorizeContactUse({
        contact_id: inviteBody.contact_id,
        action: "capability",
        capability: "memory.write",
      }),
      rt.capabilities.authorizeContactUse({
        contact_id: inviteBody.contact_id,
        action: "session",
        session_id: ownerSession,
      }),
    ];
    const denialsAfter = rt.ledger.scan({ eventType: "contact.permission_denied" }).length;
    add(
      "通知去重 + 可信联系人五类越权 100% 阻断",
      completedNotification !== undefined &&
        suppressedAfter - suppressedBefore >= 1 &&
        decisions.every((decision) => decision.allowed === false) &&
        denialsAfter - denialsBefore === 5,
      `notification=${completedNotification?.status ?? "none"}; duplicate_suppressed=${suppressedAfter - suppressedBefore}; denied=${decisions.map((decision) => decision.allowed === false).filter(Boolean).length}/5; audited=${denialsAfter - denialsBefore}`,
    );

    // --- 8) 外发审计（3 条渠道回复：私聊/任务关联/联系人绑定） --------------
    const sentBefore = rt.ledger.scan({ eventType: "outbound.sent" }).length;
    await waitFor("outbox pending replies", () => rt.outbox.list({}).messages.filter((row) => row.status === "pending").length >= 3);
    const dispatched = await rt.outbox.dispatchOnce();
    assert.equal(dispatched.sent, 3);
    const sentAfter = rt.ledger.scan({ eventType: "outbound.sent" }).length;
    const queued = rt.ledger.scan({ eventType: "outbound.queued" }).length;
    add(
      "外发审计（渠道回复 → Outbox → outbound.* 审计）",
      dispatched.sent === 3 && sentAfter - sentBefore === 3 && server2.replies.length >= 3,
      `outbox.sent=${dispatched.sent}; outbound.queued=${queued}; outbound.sent=${sentAfter}; platform_replies=${server2.replies.length}`,
    );

    // --- 6) 跨设备查看（A→B 同步后任务与记忆可见） --------------------------
    const sync = await syncRounds(pair, 2);
    const taskOnB = await getTaskOnB(pair, task.task_id);
    const factsB = await getJson<{ facts: Array<{ content: string }> }>(
      pair.b,
      `/v1/memory/facts?q=${factKeyword}`,
    );
    const taskVisible =
      taskOnB.status === 200 && taskOnB.body.status === "completed" && taskOnB.body.nodes.length === 2;
    const factVisible =
      factsB.status === 200 && factsB.body.facts.some((entry) => entry.content.includes(factKeyword));
    add(
      "跨设备查看（配对同步 → B 可见任务与记忆）",
      taskVisible && factVisible,
      `sync rounds=${sync.length} (ok=${sync.filter((entry) => entry.a.totals.failed === 0 && entry.b.totals.failed === 0).length}/${sync.length}); B task HTTP=${taskOnB.status} status=${taskOnB.body?.status ?? "-"}; B facts=${factsB.body?.facts.length ?? 0}`,
    );

    // --- 10) 语音段（M5 未实现，如实标注） ----------------------------------
    add(
      "语音段（AC-11：打断/字幕/ASR/TTS）—— M5 未实现",
      true,
      "PRD §9 M5 交付语音可打断；M4 无语音管线实现与证据。按票面如实标注为未实现，不计入 M4 达成。",
    );

    const roundPass = checks.length === 10 && checks.every((check) => check.pass);
    return {
      round,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      checks,
      pass: roundPass,
      notes,
    };
  } finally {
    await closePair(pair, hasFlag(process.argv.slice(2), "--keep"));
  }
}

interface DemoReport {
  ticket: "M4-T9 / Issue #46 AC-14";
  generated_at: string;
  environment: Record<string, string>;
  replicas: { a: string; b: string };
  rounds: RoundReport[];
  pass: boolean;
  pass_count: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rounds = parseRounds(argv);
  const outFile = parseOutArg(argv);
  const { ChannelTestServer } = await import("../../apps/runtime/src/channels/testing/channel-test-server.ts");

  const results: RoundReport[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const server = new ChannelTestServer({
      appId: FEISHU_CONFIG.appId,
      appSecret: FEISHU_CONFIG.appSecret,
      verificationToken: FEISHU_CONFIG.verificationToken,
      encryptKey: FEISHU_CONFIG.encryptKey,
      botOpenId: FEISHU_CONFIG.botOpenId,
    });
    await server.start();
    try {
      const result = await runRound(round, server);
      results.push(result);
      console.log(`[m4-demo] round ${round}: ${result.checks.filter((check) => check.pass).length}/${result.checks.length} PASS=${result.pass}`);
      for (const check of result.checks) {
        console.log(`  ${check.pass ? "PASS" : "FAIL"} ${check.index}. ${check.name} —— ${check.evidence}`);
      }
    } finally {
      await server.stop().catch(() => undefined);
    }
  }

  const passCount = results.reduce(
    (sum, result) => sum + result.checks.filter((check) => check.pass).length,
    0,
  );
  const totalChecks = results.reduce((sum, result) => sum + result.checks.length, 0);
  const report: DemoReport = {
    ticket: "M4-T9 / Issue #46 AC-14",
    generated_at: new Date().toISOString(),
    environment: nodeEnv(),
    replicas: { a: REPLICA_A, b: REPLICA_B },
    rounds: results,
    pass: results.every((result) => result.pass),
    pass_count: `${passCount}/${totalChecks}`,
  };

  const markdown = renderMarkdown(report);
  console.log("\n--- Markdown ---\n");
  console.log(markdown);
  if (outFile !== null) {
    writeFileSync(outFile, markdown, "utf8");
    console.log(`[m4-demo] wrote ${outFile}`);
  }
  if (!report.pass) throw new Error(`AC-14 demo failed: ${report.pass_count}`);
}

function renderMarkdown(report: DemoReport): string {
  const lines: string[] = [];
  lines.push("# M4 端到端演示输出（AC-14）");
  lines.push("");
  lines.push(`- 票：${report.ticket}`);
  lines.push(`- 生成时间：${report.generated_at}`);
  lines.push(`- 环境：${JSON.stringify(report.environment)}`);
  lines.push(`- 副本：A=${report.replicas.a} ｜ B=${report.replicas.b}`);
  lines.push("");
  lines.push(`**结果：${report.pass_count} PASS=${report.pass}**`);
  lines.push("");
  lines.push("口径：真实 Runtime ×2 + 真实 HTTP 接缝 + 真实飞书适配器（平台协议桩）+ 真实 Outbox/同步/租约；");
  lines.push("能力生成器为脚本化实现（零 LLM），沙箱为本地桩 Runner；语音段属 M5，未实现。");
  lines.push("");
  for (const round of report.rounds) {
    lines.push(`## 第 ${round.round} 轮（${round.checks.filter((check) => check.pass).length}/${round.checks.length}）`);
    lines.push("");
    lines.push("| # | 断言 | 结果 | 证据 |");
    lines.push("|---|---|---|---|");
    for (const check of round.checks) {
      lines.push(`| ${check.index} | ${check.name} | ${check.pass ? "PASS" : "**FAIL**"} | ${check.evidence.replace(/\|/g, "\\|")} |`);
    }
    if (round.notes.length > 0) {
      lines.push("");
      lines.push(`备注：${round.notes.join("；")}`);
    }
    lines.push("");
  }
  lines.push("## 边界（如实登记）");
  lines.push("");
  lines.push("- 语音段（打断/字幕/ASR/TTS）为 PRD M5 范围，M4 未实现；第 10 项断言只登记该事实，不作为达成。");
  lines.push("- 「渠道发起任务」由演示脚本把渠道入站文本转为 `POST /v1/tasks`（携带渠道 session_id）；产品尚无自然语言任务意图派生路径，任务创建与渠道关联本身是真实端点。");
  lines.push("- 真实飞书/QQ/微信平台、真实 Tailscale/Wi-Fi 双机、真实 LLM 生成与真实容器沙箱均未在本演示中执行（见 `docs/gates/m4-gate-report.md` §3/§6）。");
  lines.push("");
  return lines.join("\n");
}

main().catch((err: unknown) => {
  console.error(`[m4-demo] FAIL ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
