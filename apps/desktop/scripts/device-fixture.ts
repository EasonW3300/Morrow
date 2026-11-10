/**
 * 设备与同步 UI 的联调夹具（票 M3-T6 / Issue #35）：真实 Runtime + 脚本化数据。
 *
 * 仿 settings-fixture：Runtime 是本进程内真实实例（真实 SQLite 账本、真实配对服务），
 * 设备/游标/冲突/任务数据全部在启动时**脚本化预置**——浏览器打开即有内容可走查，
 * 不需要两台真机：
 *
 *   - 设备：本机（启动自注册）+ 两台已配对设备（各自独立 ed25519 指纹）
 *     + 一台已撤销设备（展示撤销终态）；
 *   - 同步游标：两台 peer 的拉取/确认进度（待上传估算 = 本地 seq 上界 − 已确认）；
 *   - 冲突：真实走「记忆写入 → 受控导入触发 sensitivity 冲突」的 M1 路径，
 *     再补 sync_conflict_meta（来源副本 / 三方版本），GET /v1/sync/conflicts 直接可见；
 *   - needs_reconcile：真实创建任务（脚本化规划器）后由 flagNeedsReconcile 冻结，
 *     证据写明两个副本各自独立执行过；Task 视图可见醒目横幅与裁决按钮。
 *
 *   node --experimental-sqlite --experimental-strip-types scripts/device-fixture.ts
 *   # 浏览器打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<runtime_port>
 *
 * 走查路径：设置 → 设备与同步
 *   1) 设备列表：指纹/配对时间/最后同步/撤销（二次确认）；
 *   2) 生成配对码 → 复制 6 位码与指纹 → 在「加入另一台设备」填入（地址默认本机，
 *      claim 会在同一 Runtime 上注册一个演示设备，用于验证指纹核对与撤销闭环）；
 *   3) 同步状态面板：seq 范围/peer 游标/待上传估算/待下载未知（端点无该字段）；
 *   4) 冲突审核：保留本地 / 采用远端 / 合并（真实裁决写入账本）。
 *   5) 任务页：需要裁决的任务有橙色警示条与「标记为已完成 / 标记为失败」。
 *
 * stdout 单行 ready JSON；SIGTERM/SIGINT 优雅退出。密钥存内存 SecretStore。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySecretStore } from "../../runtime/src/keyring.ts";
import { loadConfig } from "../../runtime/src/config.ts";
import { startRuntime } from "../../runtime/src/runtime.ts";
import { buildEventEnvelope } from "../../runtime/src/envelope.ts";
import { generateDeviceKeyPair, hashToken } from "../../runtime/src/pairing/crypto.ts";
import { SyncCursorStore } from "../../runtime/src/sync/cursors.ts";
import { detectDualExecution } from "../../runtime/src/lease/reconcile.ts";

const envDataDir = process.env.MORROW_DATA_DIR;
const dataDir = envDataDir ?? mkdtempSync(join(tmpdir(), "morrow-device-fixture-"));
const config = { ...loadConfig(), dataDir };

/** 规划器只需输出合法 DAG；任务创建后即被冻结为 needs_reconcile，不会真的执行节点。 */
const PLAN = JSON.stringify({
  nodes: [
    { key: "collect", title: "收集季度资料", goal: "collect", depends_on: [], retriable: true, side_effect: "reversible" },
    { key: "archive", title: "归档", goal: "archive", depends_on: ["collect"], retriable: true, side_effect: "delivery_unknown" },
  ],
});

const runtime = await startRuntime(config, {
  secretStore: createInMemorySecretStore(),
  agentAdapterFactory: async () => createScriptedAgent("device-fixture"),
  taskPlannerFactory: async () => createScriptedAgent(PLAN, "plan"),
});

// --- 设备预置：两台已配对 + 一台已撤销 ---------------------------------------------

const pairedA = randomUUID();
const pairedB = randomUUID();
const revoked = randomUUID();

const now = Date.now();
const ago = (ms: number): Date => new Date(now - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

for (const seed of [
  { replicaId: pairedA, label: "书房笔记本", pairedAt: ago(8 * DAY) },
  { replicaId: pairedB, label: "办公室台式机", pairedAt: ago(5 * DAY) },
  { replicaId: revoked, label: "已淘汰的旧机器", pairedAt: ago(21 * DAY) },
]) {
  const key = generateDeviceKeyPair();
  runtime.devices.markPaired({
    replicaId: seed.replicaId,
    label: seed.label,
    publicKey: key.publicKey,
    fingerprint: key.fingerprint,
    tokenHash: hashToken(`fixture-token-${seed.replicaId}`),
    now: seed.pairedAt,
  });
}
// 撤销是终态：撤销时间与令牌墓碑（last_seen_at 保持配对时刻，避免伪造活跃）
runtime.devices.revoke(revoked, ago(2 * DAY));

// --- 冲突预置：真实记忆写入 + 受控导入触发冲突 -------------------------------------

const session = runtime.sessions.createSession("设备与同步演示会话");
const userEvent = buildEventEnvelope({
  replicaId: config.replicaId,
  actorId: "owner",
  eventType: "message.user",
  sessionId: session.sessionId,
  payload: { text: "记住：季度归档在每月最后一个工作日完成" },
});
runtime.ledger.append(userEvent);
const written = runtime.memory.writeFromTool(session.sessionId, {
  content: "季度归档在每月最后一个工作日完成",
  kind: "fact",
  sensitivity: "private",
});
const consolidation = runtime.memory.consolidatePending();
const factId = consolidation?.createdFactIds[0] ?? written.candidate.candidate_id;
const fact = runtime.memory.getFact(factId);
if (fact === null) throw new Error("device-fixture: seeded memory fact not found");

// 导入把 sensitivity 从 private 改成 locked → T2 冲突口径（sensitivity_change）进队列
const conflictImport = runtime.memory.importMarkdown(
  [
    "---",
    `id: ${fact.fact_id}`,
    `version: ${fact.version}`,
    `type: ${fact.kind}`,
    `sensitivity: locked`,
    `valid_from: ${fact.valid_from}`,
    "sources: []",
    `created_at: ${fact.created_at}`,
    `updated_at: ${fact.updated_at}`,
    "---",
    "季度归档改在每月 25 日完成（在办公室台式机上改的）",
    "",
  ].join("\n"),
);
if (conflictImport.status !== "conflict" || conflictImport.conflict_id === undefined) {
  throw new Error(`device-fixture: expected a memory conflict, got ${conflictImport.status}`);
}
runtime.syncConflicts.record({
  conflict_id: conflictImport.conflict_id,
  fact_id: fact.fact_id,
  local_replica_id: config.replicaId,
  remote_replica_id: pairedB,
  local_version: fact.version,
  remote_version: fact.version + 1,
  base_version: fact.version,
  reason: conflictImport.reason ?? "sensitivity_change",
  remote_event_id: randomUUID(),
  created_at: ago(40 * 60_000).toISOString(),
});

// --- needs_reconcile 任务预置：真实创建（脚本化规划）后冻结 -------------------------
// 直接走服务层 createTask：它会规划出 DAG 但不自动调度（HTTP 路由才 kick），
// 因此任务是 planned 且不会被真的执行——随后由 flagNeedsReconcile 冻结为待裁决。
const seededTask = await runtime.tasks.createTask("跨设备归档季度资料（双端各自执行过）", {
  sessionId: session.sessionId,
});
const taskId = seededTask.task_id;
if (seededTask.status !== "planned") {
  throw new Error(`device-fixture: expected planned task before freeze, got ${seededTask.status}`);
}
// 两条「各自执行过 collect 节点」的执行证据（本机 + peerA）：detectDualExecution 只看
// 账本事实，因此这里是真证据——GET /v1/tasks/:id/execution 会原样复述给 UI。
for (const replicaId of [config.replicaId, pairedA]) {
  runtime.ledger.append(
    buildEventEnvelope({
      replicaId,
      actorId: "agent:runtime",
      eventType: "task.node_started",
      taskId,
      payload: { key: "collect", attempt: 1, node_id: "seed-node-collect" },
    }),
  );
}
const evidence = detectDualExecution(runtime.ledger, taskId);
if (evidence === null) throw new Error("device-fixture: dual execution evidence was not detected");
runtime.tasks.flagNeedsReconcile(taskId, evidence);

// --- 同步游标预置：一个 peer 双向推进、一个 peer 只拉不确认 --------------------------

const sequenceRange = runtime.ledger.sequenceRange();
const localMax = sequenceRange.max ?? 1;
const cursors = SyncCursorStore.open(config.dataDir);
try {
  // peerA：已拉到 12；推送方向确认到「本地上界 − 3」（待上传估算 = 3 条）
  cursors.advancePulled(pairedA, 12, ago(70 * 60_000));
  cursors.advanceAcked(pairedA, Math.max(1, localMax - 3), ago(35 * 60_000));
  // peerB：只拉过一批、从未确认过本机推送（待上传估算 = 本地全部）
  cursors.advancePulled(pairedB, 4, ago(11 * HOUR));
} finally {
  cursors.close();
}

console.log(
  JSON.stringify({
    ready: true,
    fixture: "device",
    version: "0.1.0",
    host: runtime.host,
    port: runtime.port,
    data_dir: config.dataDir,
    session_id: session.sessionId,
    task_id: taskId,
    devices: { self: config.replicaId, paired: [pairedA, pairedB], revoked },
    conflict_id: conflictImport.conflict_id,
    hint:
      `浏览器打开 http://127.0.0.1:1420/?runtime=http://${runtime.host}:${runtime.port}；` +
      "设置 → 设备与同步：设备列表/撤销、生成配对码 + 加入设备（同一 Runtime 演示指纹核对）、" +
      "同步状态面板、冲突裁决（keep_old/keep_new/merge）；任务页有 needs_reconcile 裁决入口。",
  }),
);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void runtime
    .close(signal)
    .then(() => {
      console.log(JSON.stringify({ stopped: true, signal }));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("[device-fixture] error during shutdown:", err);
      process.exit(1);
    });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// --- 辅助 -------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * 脚本化 Agent（零网络）：`plan` 步骤输出 DAG 文本，普通步骤回声。
 * 形状与 pi-adapter 的 AgentRuntime 最小面一致（prompt/subscribe/abort/waitForIdle/dispose）。
 */
function createScriptedAgent(text: string, kind: "plan" | "chat" = "chat") {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async prompt(input: string | { content: string }[]): Promise<void> {
      const prompt = typeof input === "string" ? input : input.map((m) => m.content).join(" ");
      emit({ type: "text_delta", delta: kind === "plan" ? text : `${text} 收到：「${prompt}」` });
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
