/**
 * 渠道与联系人 UI 的联调夹具（票 M4-T8 / Issue #45）。仿 settings-/device-/capability-fixture：
 * 真实 Runtime（真实 SQLite 账本、渠道注册表、联系人服务、通知规则、Outbox）+ 脚本化预置。
 *
 * 三个适配器（全部零真实网络、零真实凭据）：
 *   - feishu：真实 FeishuChannelAdapter 对接本地 ChannelTestServer（token TTL 60s →
 *     健康呈现「token 临期 / 不健康」的降级态，用于验证 health 诊断）；
 *   - qq：真实 QqChannelAdapter + 共享 ChannelTestServer 上的 QQ 协议桩（健康态）；
 *   - wechat：真实 WeChatChannelAdapter + StubLocalBridge，出厂 disabled（实验态 +
 *     常驻「实验」标识；浏览器走查时经风险确认启用 → 通过 API 真实启用）。
 *
 * 预置数据：三个渠道账号、微信/飞书白名单、两个可信联系人（不同授权类别）+ 一条身份
 * 歧义、通知规则（含跨天免打扰与停用行）、Outbox sent / failed / needs_review
 * 三种状态（failed 用 QQ 403 真实失败；needs_review 用发送超时真实产生，绝不自动重发）。
 * 另预置 3 条桌面 pending 通知（Issue #47 走查）：completed / failed / 免打扰到点放行，
 * 用于验证铃铛计数、应用内面板、全部标记已读与权限降级文案。
 *
 *   node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/channel-fixture.ts
 *   # 打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<runtime端口>（stdout ready JSON 给出）
 *   # 权限拒绝态走查再加 &notification_permission=denied
 *
 * stdout 单行 ready JSON；SIGTERM/SIGINT 优雅退出。密钥存内存 SecretStore（不碰钥匙串）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySecretStore } from "../../runtime/src/keyring.ts";
import { loadConfig } from "../../runtime/src/config.ts";
import { startRuntime } from "../../runtime/src/runtime.ts";
import { buildEventEnvelope } from "../../runtime/src/envelope.ts";
import { ChannelTestServer } from "../../runtime/src/channels/testing/channel-test-server.ts";
import { registerQqTestStub } from "../../runtime/src/channels/testing/qq-stub.ts";
import { FeishuChannelAdapter, type FeishuConfig } from "../../runtime/src/channels/adapters/feishu/index.ts";
import { QqChannelAdapter, type QqConfig } from "../../runtime/src/channels/adapters/qq/index.ts";
import {
  StubLocalBridge,
  WeChatChannelAdapter,
} from "../../runtime/src/channels/adapters/wechat/index.ts";

const FEISHU_CONFIG: FeishuConfig = {
  appId: "cli_channel_fixture",
  appSecret: "feishu-fixture-app-secret",
  verificationToken: "feishu-fixture-verification",
  encryptKey: "feishu-fixture-encrypt",
  botOpenId: "ou_fixture_bot",
};

const QQ_CONFIG: QqConfig = {
  appId: "qq_channel_fixture",
  appSecret: "qq-fixture-app-secret",
  botSecret: "qq-fixture-bot-secret",
};

/** 通知面板「跳转任务」用的最小计划（任务保持 planned，不自动调度） */
const FIXTURE_PLAN = JSON.stringify({
  nodes: [
    {
      key: "archive",
      title: "归档",
      goal: "archive results",
      depends_on: [],
      retriable: true,
      side_effect: "reversible",
    },
  ],
});

// --- 平台协议桩（本地回环） ---------------------------------------------------------

const feishuServer = new ChannelTestServer({
  appId: FEISHU_CONFIG.appId,
  appSecret: FEISHU_CONFIG.appSecret,
  verificationToken: FEISHU_CONFIG.verificationToken,
  encryptKey: FEISHU_CONFIG.encryptKey,
  botOpenId: FEISHU_CONFIG.botOpenId,
  // 60 秒 TTL < 适配器 5 分钟提前刷新窗口 → 健康降级（token 临期）可稳定复现
  tokenTtlSeconds: 60,
});
await feishuServer.start();

const qqServer = new ChannelTestServer();
await qqServer.start();
const qqStub = registerQqTestStub(qqServer, {
  appId: QQ_CONFIG.appId,
  appSecret: QQ_CONFIG.appSecret,
  botSecret: QQ_CONFIG.botSecret,
});

// --- 内存 SecretStore：模拟「飞书/QQ 凭据已配置一部分」（界面只显示 configured 投影）---

const secretStore = createInMemorySecretStore();
await secretStore.setSecret("channel:feishu", "app_id", FEISHU_CONFIG.appId);
await secretStore.setSecret("channel:feishu", "app_secret", FEISHU_CONFIG.appSecret);
await secretStore.setSecret("channel:qq", "app_id", QQ_CONFIG.appId);
await secretStore.setSecret("channel:qq", "app_secret", QQ_CONFIG.appSecret);

const feishuAdapter = new FeishuChannelAdapter({
  accountId: "feishu-default",
  config: FEISHU_CONFIG,
  baseUrl: feishuServer.baseUrl,
  requestTimeoutMs: 500,
  eventPollTimeoutMs: 30,
  eventReconnectDelayMs: 10,
});

const qqAdapter = new QqChannelAdapter({
  accountId: "qq-default",
  config: QQ_CONFIG,
  apiBaseUrl: qqServer.baseUrl,
  tokenEndpoint: `${qqServer.baseUrl}/app/getAppAccessToken`,
  requestTimeoutMs: 500,
  eventPollTimeoutMs: 30,
  eventReconnectDelayMs: 10,
  conversationKinds: { "qq-group-1": "group", "qq-dm-1": "direct" },
});

const wechatBridge = new StubLocalBridge();
const wechatAdapter = new WeChatChannelAdapter({ accountId: "wechat-default", bridge: wechatBridge });

const envDataDir = process.env.MORROW_DATA_DIR;
const dataDir = envDataDir ?? mkdtempSync(join(tmpdir(), "morrow-channel-"));
const config = loadConfig({ ...process.env, MORROW_DATA_DIR: dataDir });

// 通知服务可注入时钟（Issue #47 走查）：先让免打扰行落 delayed，再前移 2 分钟放行到 pending。
let notificationClock = new Date();

const runtime = await startRuntime(config, {
  secretStore,
  agentAdapterFactory: async () => createScriptedAgent(),
  // 任务规划器（通知面板的「跳转任务」需要真实任务行）：单节点脚本化计划
  taskPlannerFactory: async () => createPlanAgent(FIXTURE_PLAN),
  // 节点执行不会发生（任务保持 planned），仍给一个安全桩避免默认 Provider 依赖
  taskNodeAgentFactory: async () => createScriptedAgent(),
  notificationNow: () => notificationClock,
  channelAdapters: [
    {
      adapter: feishuAdapter,
      account: {
        account_id: "feishu-default",
        channel_id: "feishu",
        native_account_id: FEISHU_CONFIG.appId,
        display_name: "Morrow 飞书 Bot（token 临期演示）",
        owner_native_ids: ["ou_owner"],
      },
    },
    {
      adapter: qqAdapter,
      account: {
        account_id: "qq-default",
        channel_id: "qq",
        native_account_id: QQ_CONFIG.appId,
        display_name: "Morrow QQ Bot",
        owner_native_ids: ["qq_owner"],
      },
    },
    {
      adapter: wechatAdapter,
      account: {
        account_id: "wechat-default",
        channel_id: "wechat",
        native_account_id: "wx_owner_account",
        display_name: "微信个人号（实验，出厂关闭）",
        owner_native_ids: ["wx_owner"],
      },
    },
  ],
  // 发送超时压低到 200ms：outbox needs_review 预置无需等 10s
  outboxSendTimeoutMs: 200,
  // 退避基数放大：failed 行不会在随后的超时步骤里被再次选中
  outboxBackoffBaseMs: 5_000,
  outboxBackoffMaxMs: 10_000,
  notificationDrainIntervalMs: 0,
});

// --- 白名单：微信（私聊 + 群）与飞书群；写端点会落 allowlist_updated 审计 --------------

runtime.channels.setAllowlist("wechat", [
  { native_conversation_id: "wx-dm-owner", mode: "mention_only" },
  { native_conversation_id: "wx-group-family", mode: "proactive_limited" },
]);
runtime.channels.setAllowlist("feishu", [
  { native_conversation_id: "oc_feishu_group_demo", mode: "mention_only" },
]);
runtime.channels.setAllowlist("qq", [
  { native_conversation_id: "qq-group-1", mode: "mention_only" },
]);

// --- 可信联系人：真实邀请码 → 渠道回复绑定 → 授权类别 ----------------------------------

async function seedContact(input: {
  displayName: string;
  channel: string;
  accountId: string;
  nativeSenderId: string;
  categories: Array<"query" | "task_execute" | "memory_reference">;
}): Promise<string> {
  const invite = runtime.contacts.createInvite({ display_name: input.displayName });
  const bound = runtime.contacts.bindFromCode({
    channel: input.channel,
    accountId: input.accountId,
    nativeSenderId: input.nativeSenderId,
    text: invite.code,
    displayName: input.displayName,
  });
  if (!bound.bound || bound.contactId === undefined) {
    throw new Error(`channel-fixture: invite binding failed for ${input.displayName}: ${bound.reason ?? "unknown"}`);
  }
  runtime.contacts.setGrants(bound.contactId, {
    grants: input.categories.map((category) => ({ category, scope: [] })),
  });
  return bound.contactId;
}

const contactLin = await seedContact({
  displayName: "林（同事）",
  channel: "feishu",
  accountId: "feishu-default",
  nativeSenderId: "ou_lin",
  categories: ["query", "task_execute"],
});
const contactZhou = await seedContact({
  displayName: "周（家人）",
  channel: "qq",
  accountId: "qq-default",
  nativeSenderId: "qq_zhou",
  categories: ["query"],
});
const ambiguityId = runtime.contacts.recordAmbiguity("qq-default", "qq_uncertain_sender", [contactLin, contactZhou]);

// --- 通知规则：四类事件 × 目标 × 免打扰（含跨天与停用行） ----------------------------

// A3 修复批（Issue #37）后 channel:<id> 规则保存要求渠道已有默认通知会话（fail-closed）；
// 夹具必须先指到已白名单的会话，否则 upsertRules 直接 400 notify_target_required。
const feishuTarget = runtime.channels.setNotifyTarget("feishu", "oc_feishu_group_demo");
const qqTarget = runtime.channels.setNotifyTarget("qq", "qq-group-1");
if (!feishuTarget.ok || !qqTarget.ok) {
  throw new Error(
    `channel-fixture: failed to seed notify targets: ${feishuTarget.ok ? "" : feishuTarget.code} / ${qqTarget.ok ? "" : qqTarget.code}`,
  );
}

runtime.notifications.upsertRules([
  { event_type: "completed", target: "desktop", quiet_hours: null, enabled: true },
  { event_type: "failed", target: "desktop", quiet_hours: { start: "22:00", end: "08:00" }, enabled: true },
  { event_type: "completed", target: "channel:feishu", quiet_hours: null, enabled: true },
  { event_type: "waiting_input", target: "channel:qq", quiet_hours: { start: "23:00", end: "07:00" }, enabled: false },
  { event_type: "milestone", target: "channel:feishu", quiet_hours: null, enabled: true },
]);

// --- Outbox 三种状态：sent（真实送达）/ failed（真实 403）/ needs_review（真实超时） ----

const sentRow = runtime.outbox.enqueue({
  idempotencyKey: "fixture-outbox-sent",
  channelId: "qq",
  accountId: "qq-default",
  target: { kind: "conversation", id: "qq-group-1" },
  payload: { text: "【夹具】季度归档已完成，这是正常送达的消息（Outbox 审计对照）。" },
});
// 先让 sent 行在平台桩正常应答下真实送达
qqStub.mode = "ok";
await runtime.outbox.dispatchOnce();

const failedRow = runtime.outbox.enqueue({
  idempotencyKey: "fixture-outbox-failed",
  channelId: "qq",
  accountId: "qq-default",
  target: { kind: "conversation", id: "qq-group-1" },
  payload: { text: "【夹具】这条会收到平台 403：可重试的明确失败。" },
});
qqStub.mode = "forbidden";
await runtime.outbox.dispatchOnce();

const timeoutRow = runtime.outbox.enqueue({
  idempotencyKey: "fixture-outbox-timeout",
  channelId: "qq",
  accountId: "qq-default",
  target: { kind: "conversation", id: "qq-dm-1" },
  payload: { text: "【夹具】这条发送超时：可能已送达，转 needs_review 等你核对。" },
});
qqStub.mode = "hang";
await runtime.outbox.dispatchOnce();
qqStub.mode = "ok";

const sentStatus = runtime.outbox.get(sentRow.id)?.status;
const failedStatus = runtime.outbox.get(failedRow.id)?.status;
const reviewStatus = runtime.outbox.get(timeoutRow.id)?.status;
if (sentStatus !== "sent" || failedStatus !== "failed" || reviewStatus !== "needs_review") {
  throw new Error(
    `channel-fixture: unexpected outbox seed statuses: ${sentStatus} / ${failedStatus} / ${reviewStatus}`,
  );
}

// --- 桌面 pending 通知（Issue #47 走查：铃铛计数 / 面板 / 全部已读 / 权限降级） -------
const completedTask = await runtime.tasks.createTask("整理季度资料并归档", {});
const failedTask = await runtime.tasks.createTask("扫描旧项目依赖并升级", {});
const waitingTask = await runtime.tasks.createTask("确认生产部署窗口", {});

function appendTaskEvent(
  taskId: string,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  runtime.ledger.append(
    buildEventEnvelope({
      replicaId: config.replicaId,
      actorId: "agent:runtime",
      eventType,
      taskId,
      payload,
    }),
  );
}

// failed 的桌面规则原本带跨天免打扰；临时置空确保本轮落 pending（随后恢复，保留规则演示）
runtime.notifications.upsertRules([
  { event_type: "failed", target: "desktop", quiet_hours: null, enabled: true },
]);
appendTaskEvent(completedTask.task_id, "task.completed", { goal: "整理季度资料并归档" });
appendTaskEvent(failedTask.task_id, "task.failed", {
  goal: "扫描旧项目依赖并升级",
  message: "依赖解析失败：lockfile 与 workspace 不一致",
});
runtime.notifications.upsertRules([
  { event_type: "failed", target: "desktop", quiet_hours: { start: "22:00", end: "08:00" }, enabled: true },
]);

// 免打扰到点：规则窗口覆盖「现在」→ 事件先落 delayed；时钟前移 2 分钟 → flushDue 放行 pending
function utcClockMinutes(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}
function hhmm(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}
const quietStart = utcClockMinutes(notificationClock);
runtime.notifications.upsertRules([
  {
    event_type: "waiting_input",
    target: "desktop",
    quiet_hours: { start: hhmm(quietStart), end: hhmm(quietStart + 1) },
    enabled: true,
  },
]);
appendTaskEvent(waitingTask.task_id, "task.waiting_input", {
  goal: "确认生产部署窗口",
  message: "确认今晚 22:00 的部署窗口？",
});
notificationClock = new Date(notificationClock.getTime() + 2 * 60_000);
const flushedQuietRows = runtime.notifications.flushDue();
notificationClock = new Date();

const pendingNotifications = runtime.notifications.pendingDesktop();
if (pendingNotifications.length !== 3 || flushedQuietRows !== 1) {
  throw new Error(
    `channel-fixture: unexpected desktop pending seed: ${pendingNotifications.length} pending, ${flushedQuietRows} flushed`,
  );
}
const pendingByEvent = Object.fromEntries(
  pendingNotifications.map((row) => [row.event_type, row.notification_id]),
);

console.log(
  JSON.stringify({
    ready: true,
    fixture: "channel",
    version: "0.1.0",
    host: runtime.host,
    port: runtime.port,
    data_dir: config.dataDir,
    mocks: { feishu: feishuServer.baseUrl, qq: qqServer.baseUrl },
    seed: {
      contacts: { lin: contactLin, zhou: contactZhou },
      ambiguity_id: ambiguityId,
      outbox: { sent: sentRow.id, failed: failedRow.id, needs_review: timeoutRow.id },
      notifications: {
        pending: pendingByEvent,
        tasks: {
          completed: completedTask.task_id,
          failed: failedTask.task_id,
          waiting_input: waitingTask.task_id,
        },
      },
    },
    hint:
      `浏览器打开 http://127.0.0.1:1420/?runtime=http://${runtime.host}:${runtime.port}；` +
      "顶栏铃铛应显示 3 条未读（completed/failed/免打扰到点），点开面板可跳任务、全部标记已读；" +
      "加 &notification_permission=denied 走查权限拒绝降级文案；" +
      "设置 → 渠道 → 启用微信（完整风险文案 + 勾选）→ 加白名单 → 加联系人授权 → 改通知规则 → " +
      "在 Outbox 对 needs_review 行「我已核对，重发」/「标记已送达」；飞书行会显示 token 临期降级。",
  }),
);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.allSettled([feishuServer.stop(), qqServer.stop()])
    .then(() => runtime.close(signal))
    .then(() => {
      console.log(JSON.stringify({ stopped: true, signal }));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("[channel-fixture] error during shutdown:", err);
      process.exit(1);
    });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/** 脚本化 Agent（同 settings-fixture 的最小回声版）：会话回合无真实模型 */
function createScriptedAgent() {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async prompt(input: string | { content: string }[]): Promise<void> {
      const text = typeof input === "string" ? input : input.map((message) => message.content).join(" ");
      emit({ type: "text_delta", delta: `channel-fixture 收到：「${text}」` });
      emit({ type: "agent_end", stopReason: "stop" });
    },
    subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort(): void {},
    async waitForIdle(): Promise<void> {},
    dispose(): void {
      listeners.clear();
    },
  };
}

/** 规划 Agent：只吐一段计划 JSON（taskPlannerFactory 注入，任务保持 planned） */
function createPlanAgent(plan: string) {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async prompt(): Promise<void> {
      emit({ type: "text_delta", delta: plan });
      emit({ type: "agent_end", stopReason: "stop" });
    },
    subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort(): void {},
    async waitForIdle(): Promise<void> {},
    dispose(): void {
      listeners.clear();
    },
  };
}
