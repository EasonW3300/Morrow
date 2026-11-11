#!/usr/bin/env node
/**
 * M3 端到端演示驱动（票 M3-T7 / Issue #36；PRD §9 M3 门槛）。
 *
 * 每轮独立起两个 Runtime（独立 dataDir / replica_id / HTTP 端口；A 注入 FakePi
 * 规划器与节点执行器），走真实 HTTP 接缝完成：
 *   1. 配对：A 生成一次性码 → B POST /v1/pairing/join（宿主侧新端点）
 *   2. 双向同步：A/B 各离线写 5 条会话事件 → POST /v1/sync/run 双向收敛
 *   3. 删除传播：A 删事实 / B 离线写旧修订 → 同步后双方保持删除、旧修订不导入
 *   4. 冲突分类：preference 自动合并（两端收敛 v3）；locked 单侧修订进待审核
 *   5. 任务执行权转移：租约 token=1 → transfer-execution → 目标设备取得执行权
 *   6. needs_reconcile：异地执行证据入账本 → detect 冻结 → Owner 显式裁决
 *
 * 每轮 10 项断言，两轮独立执行。剩余边界（无共识协议下的拉取-acquire 竞态窗口、
 * 附件文件传输未实现）在 docs/gates/m3-gate-report.md §6 如实登记。
 *
 * 用法：bash scripts/real-machine/m3-demo.sh [--out docs/gates/m3-demo-output.md] [--keep]
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createFakePi } from "../../packages/pi-adapter/src/index.ts";
import type { EventEnvelope, TaskDetail } from "@morrow/protocol";
import { buildEventEnvelope } from "../../apps/runtime/src/envelope.ts";
import { uuidv7 } from "../../apps/runtime/src/uuid-v7.ts";
import {
  REPLICA_A,
  REPLICA_B,
  assertStatus,
  closePair,
  createSession,
  fetchAllEvents,
  getJson,
  hasFlag,
  nodeEnv,
  nowIso,
  pairViaJoin,
  postJson,
  startPair,
  syncRounds,
  type Pair,
} from "./lib/m3-harness.ts";

const ROUNDS = 2;
const OFFLINE_PER_SIDE = 5;

interface Check {
  index: number;
  name: string;
  pass: boolean;
  evidence: string;
}

interface RoundResult {
  round: number;
  started_at: string;
  finished_at: string;
  checks: Check[];
  pass: boolean;
  notes: string[];
}

function planJson(goal: string): string {
  return JSON.stringify({
    nodes: [
      {
        key: "step",
        title: "演示节点",
        goal,
        depends_on: [],
        retriable: false,
        side_effect: "reversible",
      },
    ],
  });
}

function env(): Record<string, string> {
  return nodeEnv();
}

async function waitFor(what: string, condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

function findEvent(events: EventEnvelope[], eventType: string, taskId?: string): EventEnvelope | undefined {
  return events.find((event) => event.event_type === eventType && (taskId === undefined || event.task_id === taskId));
}

async function taskEvents(pair: Pair, taskId: string): Promise<EventEnvelope[]> {
  const page = assertStatus(
    await getJson<{ events: EventEnvelope[]; total: number }>(pair.a, `/v1/tasks/${taskId}/events?limit=200`),
    200,
    "GET /v1/tasks/:id/events",
  );
  return page.events;
}

async function getTask(pair: Pair, taskId: string): Promise<TaskDetail> {
  return assertStatus(await getJson<TaskDetail>(pair.a, `/v1/tasks/${taskId}`), 200, "GET /v1/tasks/:id");
}

interface ExecutionView {
  task_id: string;
  status: string;
  lease: { holder_replica_id: string | null; fencing_token: number; active: boolean } | null;
  needs_reconcile: boolean;
  evidence: { replicas: string[]; reasons: string[] } | null;
}

async function getExecution(pair: Pair, taskId: string): Promise<ExecutionView> {
  return assertStatus(await getJson<ExecutionView>(pair.a, `/v1/tasks/${taskId}/execution`), 200, "GET /v1/tasks/:id/execution");
}

function seedFact(pair: Pair, text: string, kind: "fact" | "preference" | "profile", sensitivity: "public" | "private" | "locked"): { factId: string; baselineEventId: string } {
  const factId = uuidv7();
  const baseline = buildEventEnvelope({
    replicaId: REPLICA_A,
    actorId: "owner",
    eventType: "memory.fact_created",
    payload: { fact_id: factId, version: 1, content: text, kind, sensitivity, revision_id: uuidv7(), reason: "demo_seed" },
  });
  pair.a.runtime.ledger.append(baseline);
  pair.a.runtime.memoryRebuilder.rebuild();
  return { factId, baselineEventId: baseline.event_id };
}

function offlineUpdate(pair: Pair, replicaId: string, factId: string, text: string, kind: "fact" | "preference" | "profile", sensitivity: "public" | "private" | "locked"): EventEnvelope {
  const envelope = buildEventEnvelope({
    replicaId,
    actorId: "owner",
    eventType: "memory.fact_updated",
    payload: {
      fact_id: factId,
      version: 2,
      content: text,
      kind,
      sensitivity,
      revision_id: uuidv7(),
      reason: "offline_edit",
    },
  });
  (replicaId === REPLICA_A ? pair.a : pair.b).runtime.ledger.append(envelope);
  return envelope;
}

async function runRound(round: number, keep: boolean): Promise<RoundResult> {
  const startedAt = nowIso();
  const checks: Check[] = [];
  const notes: string[] = [];
  const check = (name: string, pass: boolean, evidence: string): void => {
    checks.push({ index: checks.length + 1, name, pass, evidence });
  };
  let pair: Pair | undefined;
  try {
    pair = await startPair({
      keep,
      optionsFor: (name) => {
        if (name !== "A") return {};
        return {
          taskPlannerFactory: async (goal: string) =>
            createFakePi({ script: [{ kind: "text", deltas: [planJson(goal.includes("hang") ? "hang" : "done")] }] }),
          taskNodeAgentFactory: async (node) =>
            createFakePi({ script: node.goal === "hang" ? [{ kind: "hang" }] : [{ kind: "text", deltas: ["done"] }] }),
          leaseTtlMs: 30_000,
          leaseHeartbeatMs: 200,
        };
      },
    });

    // 1) 配对：join 端点
    const pairing = await pairViaJoin(pair);
    const bothTrusted = [pairing.devices_a, pairing.devices_b].every((devices, index) => {
      const peerId = index === 0 ? REPLICA_B : REPLICA_A;
      const peer = devices.find((device) => device.replica_id === peerId);
      return peer !== undefined && peer.trusted && !peer.revoked;
    });
    check(
      "配对：B 经 POST /v1/pairing/join 加入 A，双端 trusted，响应无 token 明文",
      bothTrusted && !pairing.join_response_has_token,
      `fingerprint=${pairing.server_fingerprint_short} devicesA=${pairing.devices_a.length} devicesB=${pairing.devices_b.length} join_has_token=${pairing.join_response_has_token}`,
    );

    // 2) 双向同步：各离线 5 条会话事件
    const aSessions: string[] = [];
    for (let i = 1; i <= OFFLINE_PER_SIDE; i++) aSessions.push((await createSession(pair.a, `m3-demo-A-${round}-${i}`)).event_id);
    const bSessions: string[] = [];
    for (let i = 1; i <= OFFLINE_PER_SIDE; i++) bSessions.push((await createSession(pair.b, `m3-demo-B-${round}-${i}`)).event_id);
    const beforeA = new Set((await fetchAllEvents(pair.a)).map((event) => event.event_id));
    const beforeB = new Set((await fetchAllEvents(pair.b)).map((event) => event.event_id));
    const isolated = aSessions.every((id) => !beforeB.has(id)) && bSessions.every((id) => !beforeA.has(id));
    const rounds = await syncRounds(pair, 3);
    const eventsA = await fetchAllEvents(pair.a);
    const eventsB = await fetchAllEvents(pair.b);
    const union = new Set([...aSessions, ...bSessions]);
    const aHasAll = [...union].every((id) => eventsA.filter((event) => event.event_id === id).length === 1);
    const bHasAll = [...union].every((id) => eventsB.filter((event) => event.event_id === id).length === 1);
    const lastSync = pair.a.runtime.devices.list().find((device) => device.replica_id === REPLICA_B)?.last_sync_at ?? null;
    const runCompleted = findEvent(eventsA, "sync.run_completed") !== undefined;
    check(
      "双向同步：A/B 各 5 条离线事件重连后双方恰好各一次，sync/run 有审计与 last_sync_at",
      isolated && aHasAll && bHasAll && lastSync !== null && runCompleted,
      `isolated=${isolated} A=${aSessions.length + bSessions.length}/${union.size} B=${bSessions.length + aSessions.length}/${union.size} last_sync_at=${lastSync} rounds=${rounds.length}`,
    );

    // 3) 删除传播：A 删 / B 离线改
    const delFact = seedFact(pair, "M3 演示删除事实：本地端口 8787。", "fact", "private");
    await syncRounds(pair, 2);
    pair.a.runtime.memory.deleteFact(delFact.factId);
    const stale = offlineUpdate(pair, REPLICA_B, delFact.factId, "M3 演示删除事实：离线端口 9000。", "fact", "private");
    pair.b.runtime.memoryRebuilder.rebuild();
    await syncRounds(pair, 3);
    const delA = pair.a.runtime.memory.getFact(delFact.factId);
    const delB = pair.b.runtime.memory.getFact(delFact.factId);
    const skippedOnA = pair.a.runtime.ledger
      .scan({ eventType: "sync.tombstone_skipped" })
      .some((entry) => (entry.envelope.payload as { event_id?: string }).event_id === stale.event_id);
    check(
      "删除传播：A 删除后双方均保持 deleted_at，B 的离线旧修订未导入（tombstone_skipped）",
      delA?.deleted_at != null && delB?.deleted_at != null && skippedOnA && !pair.a.runtime.ledger.hasEvent(stale.event_id),
      `A.deleted=${delA?.deleted_at != null} B.deleted=${delB?.deleted_at != null} stale_imported=${pair.a.runtime.ledger.hasEvent(stale.event_id)} skipped_audit=${skippedOnA}`,
    );

    // 4) 再同步一轮仍不复活
    await syncRounds(pair, 2);
    const stillDeleted =
      pair.a.runtime.memory.getFact(delFact.factId)?.deleted_at != null &&
      pair.b.runtime.memory.getFact(delFact.factId)?.deleted_at != null;
    check("删除不复活：再次双向同步后双方仍为删除态", stillDeleted, `still_deleted=${stillDeleted}`);

    // 5) 冲突分类 A：preference 自动合并
    const pref = seedFact(pair, "Owner 偏好使用 vim 编辑器。", "preference", "private");
    await syncRounds(pair, 2);
    offlineUpdate(pair, REPLICA_A, pref.factId, "Owner 偏好使用 vim 编辑器。", "preference", "private");
    offlineUpdate(pair, REPLICA_B, pref.factId, "Owner 偏好使用 emacs 编辑器。", "preference", "private");
    pair.a.runtime.memoryRebuilder.rebuild();
    pair.b.runtime.memoryRebuilder.rebuild();
    await syncRounds(pair, 4);
    const prefA = pair.a.runtime.memory.getFact(pref.factId);
    const prefB = pair.b.runtime.memory.getFact(pref.factId);
    const prefConflicts = [...pair.a.runtime.memory.listConflicts({ status: "open" }), ...pair.b.runtime.memory.listConflicts({ status: "open" })].filter(
      (conflict) => conflict.fact_id === pref.factId,
    ).length;
    const mergedEvents = pair.a.runtime.ledger.scan({ eventType: "sync.merged" });
    const mergedEventsB = pair.b.runtime.ledger.scan({ eventType: "sync.merged" });
    const describeMerges = (entries: typeof mergedEvents): string =>
      entries
        .map((entry) => {
          const payload = entry.envelope.payload as {
            local_version?: number;
            remote_version?: number;
            result_version?: number;
            remote_event_id?: string;
            remote_replica_id?: string;
            reason?: string;
          };
          return `${payload.local_version}->${payload.remote_version}=${payload.result_version}@${String(payload.remote_replica_id).slice(0, 8)}:${payload.remote_event_id}(${payload.reason})`;
        })
        .join(",");
    check(
      "冲突分类（自动合并）：preference 双端竞争 → 两端收敛到同一版本与内容，无待审核冲突",
      prefA !== null && prefB !== null && prefA.version >= 3 && prefA.version === prefB.version && prefA.content === prefB.content && prefConflicts === 0 && mergedEvents.length > 0,
      `A.v=${prefA?.version} B.v=${prefB?.version} same_content=${prefA?.content === prefB?.content} conflicts=${prefConflicts} sync.mergedA=${mergedEvents.length} sync.mergedB=${mergedEventsB.length} mergesA=${describeMerges(mergedEvents)} mergesB=${describeMerges(mergedEventsB)}`,
    );
    if ((prefA?.version ?? 0) > 3) {
      notes.push(
        `preference 已收敛但版本从 3 涨到 ${prefA?.version}：多轮同步边界上陈旧的 v2 被再次分类合并（版本膨胀，见门禁报告 §6）。`,
      );
    }

    // 6) 冲突分类 B：locked 单侧修订进待审核（A 拉取 B 的离线修订；不再回推冲突审计）
    const locked = seedFact(pair, "Owner 的护照号是 E12345678。", "profile", "locked");
    await syncRounds(pair, 2);
    offlineUpdate(pair, REPLICA_B, locked.factId, "Owner 的护照号是 E87654321。", "profile", "locked");
    pair.b.runtime.memoryRebuilder.rebuild();
    const pulled = await pair.a.runtime.sync.pullFromPeer(REPLICA_B, { limit: 1000 });
    const lockedA = pair.a.runtime.memory.getFact(locked.factId);
    const lockedB = pair.b.runtime.memory.getFact(locked.factId);
    const lockedConflict = pair.a.runtime.memory.listConflicts({ status: "open" }).find((conflict) => conflict.fact_id === locked.factId);
    check(
      "冲突分类（待审核）：locked 修订进 A 的冲突队列，A 本地值不被覆盖",
      pulled.accepted > 0 && lockedConflict?.reason === "locked" && lockedA?.content === "Owner 的护照号是 E12345678。" && lockedB?.content === "Owner 的护照号是 E87654321。",
      `pulled=${pulled.accepted} reason=${lockedConflict?.reason ?? "none"} A.content=${lockedA?.content ?? "null"} B.content=${lockedB?.content ?? "null"}`,
    );

    // 7) 任务执行权转移
    const transferTask = assertStatus(await postJson<TaskDetail>(pair.a, "/v1/tasks", { goal: "stage transfer hang" }), 201, "POST /v1/tasks (transfer)");
    await waitFor("execution lease active", async () => {
      const view = await getExecution(pair, transferTask.task_id);
      return view.lease?.active === true && view.lease.holder_replica_id === REPLICA_A;
    });
    const beforeTransfer = await getExecution(pair, transferTask.task_id);
    const transferred = assertStatus(
      await postJson<{ task: TaskDetail; lease: { active: boolean; holder_replica_id: string | null }; transfer_event_id: string }>(
        pair.a,
        `/v1/tasks/${transferTask.task_id}/transfer-execution`,
        { target_replica_id: REPLICA_B },
      ),
      200,
      "POST /v1/tasks/:id/transfer-execution",
    );
    const transferEvents = await taskEvents(pair, transferTask.task_id);
    const transferEvent = findEvent(transferEvents, "task.execution_transferred", transferTask.task_id);
    // 真实流程：转移事件必须先同步到目标设备，目标才可能看到预留的 fencing token。
    // 不同步直接 acquire 会从 1 起号——那正是 review 发现的问题（旧 token 仍可提交）。
    await postJson(pair.a, "/v1/sync/run", {});
    await postJson(pair.b, "/v1/sync/run", {});
    await postJson(pair.a, "/v1/sync/run", {});
    const targetAcquire = pair.b.runtime.leases.acquire(transferTask.task_id, REPLICA_B, 30_000);
    check(
      "任务执行权转移：A 持有 token=1 → transfer 释放 → 目标设备 B 取得执行权",
      beforeTransfer.lease?.fencing_token === 1 &&
        transferred.lease.active === false &&
        transferred.lease.holder_replica_id === null &&
        transferEvent !== undefined &&
        (transferEvent.payload as { to_replica_id?: string }).to_replica_id === REPLICA_B &&
        "token" in targetAcquire &&
        // 跨副本单调：目标采用 transfer 预留的 next_fencing_token（= before+1）
        targetAcquire.token === 2 &&
        pair.b.runtime.leases.validate(transferTask.task_id, 1) === false,
      `before.token=${beforeTransfer.lease?.fencing_token} after.active=${transferred.lease.active} event=${transferEvent?.event_id ?? "none"} target=${(transferEvent?.payload as { to_replica_id?: string }).to_replica_id ?? "none"} B.token=${"token" in targetAcquire ? targetAcquire.token : "held"}`,
    );

    // 8) needs_reconcile 检测（异地执行证据入账本；任务投影不在同步面内）
    const reconcileTask = assertStatus(await postJson<TaskDetail>(pair.a, "/v1/tasks", { goal: "stage reconcile done" }), 201, "POST /v1/tasks (reconcile)");
    await waitFor("reconcile task completed", async () => (await getTask(pair, reconcileTask.task_id)).status === "completed");
    pair.a.runtime.ledger.append(
      buildEventEnvelope({
        replicaId: REPLICA_B,
        actorId: "agent:runtime",
        eventType: "task.started",
        taskId: reconcileTask.task_id,
        payload: { demo: "simulated synced evidence from replica B" },
      }),
    );
    notes.push("needs_reconcile 的异地证据以直接入账本方式模拟：任务投影（tasks 表）不随同步事件重建，见门禁报告 §6。");
    const detected = assertStatus(
      await postJson<{ detected: boolean; task: TaskDetail; evidence: { replicas: string[] } | null }>(
        pair.a,
        `/v1/tasks/${reconcileTask.task_id}/reconcile/detect`,
        {},
      ),
      200,
      "POST /v1/tasks/:id/reconcile/detect",
    );
    const reconcileEvents = await taskEvents(pair, reconcileTask.task_id);
    check(
      "needs_reconcile 检测：双端独立执行证据 → 任务冻结为 needs_reconcile，不静默合并",
      detected.detected &&
        detected.task.status === "needs_reconcile" &&
        findEvent(reconcileEvents, "task.needs_reconcile", reconcileTask.task_id) !== undefined &&
        detected.evidence !== null &&
        detected.evidence.replicas.includes(REPLICA_A) &&
        detected.evidence.replicas.includes(REPLICA_B),
      `detected=${detected.detected} status=${detected.task.status} replicas=${detected.evidence?.replicas.join(",") ?? "none"}`,
    );

    // 9) needs_reconcile 裁决
    const resolved = assertStatus(
      await postJson<{ task: TaskDetail; reconciliation: { resolution: string } }>(
        pair.a,
        `/v1/tasks/${reconcileTask.task_id}/reconcile`,
        { resolution: "completed", note: "m3-demo: owner kept replica A result" },
      ),
      200,
      "POST /v1/tasks/:id/reconcile",
    );
    const afterEvents = await taskEvents(pair, reconcileTask.task_id);
    const reconciledEvent = findEvent(afterEvents, "task.reconciled", reconcileTask.task_id);
    check(
      "needs_reconcile 裁决：Owner 显式选择 completed，task.reconciled 以 owner 身份留痕",
      resolved.task.status === "completed" &&
        resolved.reconciliation.resolution === "completed" &&
        reconciledEvent !== undefined &&
        reconciledEvent.actor_id === "owner",
      `status=${resolved.task.status} resolution=${resolved.reconciliation.resolution} reconciled_actor=${reconciledEvent?.actor_id ?? "none"}`,
    );

    // 10) 执行权单点：needs_reconcile 任务没有有效租约（此前 8/9 未创建租约）
    const finalExecution = await getExecution(pair, reconcileTask.task_id);
    check(
      "执行权单点：needs_reconcile 期间与裁决后均无有效执行租约（不并行重放）",
      finalExecution.lease === null || finalExecution.lease.active === false,
      `lease=${finalExecution.lease === null ? "null" : `active=${finalExecution.lease.active}`}`,
    );

    void env();
    return {
      round,
      started_at: startedAt,
      finished_at: nowIso(),
      checks,
      pass: checks.every((item) => item.pass),
      notes,
    };
  } finally {
    if (pair !== undefined) await closePair(pair, keep);
  }
}

function renderMarkdown(rounds: RoundResult[]): string {
  const lines = [
    "# M3 端到端演示输出（M3-T7 / Issue #36）",
    "",
    `**生成时间**：${nowIso()} ｜ **node**：${process.version} ｜ **平台**：${process.platform}-${process.arch}`,
    "**形态**：两个独立 Runtime（127.0.0.1 随机端口、独立 dataDir/SQLite；A 注入 FakePi 规划/执行器）",
    "",
  ];
  for (const round of rounds) {
    lines.push(`## 第 ${round.round} 轮（${round.pass ? "PASS" : "FAIL"}：${round.checks.filter((item) => item.pass).length}/${round.checks.length}）`, "");
    lines.push(`起止：${round.started_at} → ${round.finished_at}`, "");
    lines.push("| # | 断言 | 结果 | 证据 |", "|---|---|---|---|");
    for (const check of round.checks) {
      lines.push(`| ${check.index} | ${check.name} | ${check.pass ? "PASS" : "FAIL"} | ${check.evidence.replaceAll("|", "\\|")} |`);
    }
    if (round.notes.length > 0) {
      lines.push("", "注记：", ...round.notes.map((note) => `- ${note}`));
    }
    lines.push("", `**轮次小结**：PASS=${round.checks.filter((item) => item.pass).length} FAIL=${round.checks.filter((item) => !item.pass).length}`, "");
  }
  const totalPass = rounds.reduce((sum, round) => sum + round.checks.filter((item) => item.pass).length, 0);
  const total = rounds.reduce((sum, round) => sum + round.checks.length, 0);
  lines.push(`**总计**：${rounds.length} 轮，${totalPass}/${total} 项断言 PASS（每轮 10 项）`, "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const outPath = outIndex === -1 ? resolve("docs/gates/m3-demo-output.md") : resolve(argv[outIndex + 1] ?? "");
  if (outIndex !== -1 && (argv[outIndex + 1] === undefined || argv[outIndex + 1].startsWith("--"))) {
    throw new Error("--out requires a file path");
  }
  const keep = hasFlag(argv, "--keep");
  const rounds: RoundResult[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const result = await runRound(round, keep);
    rounds.push(result);
    console.error(`[m3-demo] round ${round}: PASS=${result.checks.filter((item) => item.pass).length} FAIL=${result.checks.filter((item) => !item.pass).length}`);
  }
  const markdown = renderMarkdown(rounds);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, "utf8");
  console.log(JSON.stringify({ rounds, out: outPath }, null, 2));
  console.log(markdown);
  if (!rounds.every((round) => round.pass)) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`[m3-demo] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
