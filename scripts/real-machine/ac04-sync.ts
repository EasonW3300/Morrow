#!/usr/bin/env node
/**
 * AC-04 合并态复跑归档（M3-T7 / Issue #36；PRD §8 AC-04 / §4.6 FR-DEP-3）。
 *
 * 方法：
 *   1. 起两个独立 Runtime（各自 dataDir / replica_id / SQLite 账本 / HTTP 端口）；
 *   2. B 经 POST /v1/pairing/join 加入 A（真实配对端点；token 只进内存凭据库）；
 *   3. A/B 各离线创建 50 个会话（= 各 50 条独立 session.created 业务事件，互不可见）；
 *   4. 重连：POST /v1/sync/run 双向同步（真实 HTTP 传输），逐项对账——
 *      无丢失、无重复、同一来源事件相对顺序一致；
 *   5. p95：A 每轮新增 1 条小事件（session.created，≤1KB），调用一次
 *      POST /v1/sync/run（pull→push→push→pull）并计时，取 100 个样本 p95。
 *
 * 环境口径（必须随数字一起引用）：127.0.0.1 本机回环、单机双实例、node 24；
 * 这是**回环基线**，不代表 Tailscale/Wi-Fi 真实网络；真实网络与真实 systemd 待 Owner
 * 环境（见 docs/gates/m3-gate-report.md §6）。
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac04-sync.ts \
 *     [--out docs/gates] [--keep]
 *
 * 输出：stdout JSON 摘要 + Markdown 表；--out 目录额外写 m3-ac04-sync.json / .md。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope, SyncRunReport } from "@morrow/protocol";
import {
  REPLICA_A,
  REPLICA_B,
  assertStatus,
  closePair,
  countByType,
  createSession,
  fetchAllEvents,
  getJson,
  hasFlag,
  nodeEnv,
  nowIso,
  parseOutArg,
  pairViaJoin,
  percentile,
  round2,
  runSync,
  startPair,
  syncRounds,
  type Pair,
  type SyncStatusView,
} from "./lib/m3-harness.ts";

const PER_SIDE = 50;
const P95_SAMPLES = 100;
const P95_THRESHOLD_MS = 10_000;
const SMALL_EVENT_MAX_BYTES = 1024;

interface Sample {
  index: number;
  elapsed_ms: number;
  event_id: string;
}

interface Reconciliation {
  a_written: number;
  b_written: number;
  a_business: number;
  b_business: number;
  expected_business: number;
  a_missing: string[];
  b_missing: string[];
  a_duplicates: number;
  b_duplicates: number;
  a_extra: string[];
  b_extra: string[];
  order_a_from_a: boolean;
  order_a_from_b: boolean;
  order_b_from_a: boolean;
  order_b_from_b: boolean;
  order_ok: boolean;
  lossless: boolean;
  duplicate_free: boolean;
}

interface Ac04Report {
  ticket: string;
  generated_at: string;
  environment: Record<string, string>;
  replicas: { a: string; b: string };
  pairing: {
    method: "POST /v1/pairing/join";
    join_response_has_token: boolean;
    devices_a: number;
    devices_b: number;
    both_trusted: boolean;
  };
  offline: { per_side: number; a_written: number; b_written: number; isolated_before_sync: boolean };
  sync: {
    rounds: Array<{ round: number; a: SyncRunReport; b: SyncRunReport }>;
    status_a: SyncStatusView;
    status_b: SyncStatusView;
    audit: { sync_run_completed: number; sync_pulled: number; sync_pushed: number };
  };
  reconciliation: Reconciliation;
  p95: {
    samples: number;
    threshold_ms: number;
    p50_ms: number;
    p90_ms: number;
    p95_ms: number;
    p99_ms: number;
    min_ms: number;
    max_ms: number;
    mean_ms: number;
    all_samples_converged: boolean;
    max_event_bytes: number;
    small_event_within_1kb: boolean;
    met: boolean;
    environment_note: string;
  };
  pass: boolean;
}

/** 账本中同一来源事件的**实际出现顺序**（不做排序——顺序断言才有意义） */
function orderOf(events: EventEnvelope[], originReplica: string, written: Set<string>): string[] {
  return events
    .filter((event) => event.replica_id === originReplica && written.has(event.event_id))
    .map((event) => event.event_id);
}

function equalOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function duplicatesOf(events: EventEnvelope[], ids: Set<string>): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const event of events) {
    if (!ids.has(event.event_id)) continue;
    if (seen.has(event.event_id)) duplicates += 1;
    else seen.add(event.event_id);
  }
  return duplicates;
}

function renderMarkdown(report: Ac04Report): string {
  const r = report.reconciliation;
  const p = report.p95;
  return [
    "# AC-04 合并态复跑归档（M3-T7 / Issue #36）",
    "",
    `**生成时间**：${report.generated_at} ｜ **node**：${report.environment.node} ｜ **平台**：${report.environment.platform}`,
    `**环境**：127.0.0.1 本机回环双实例（A/B 独立 dataDir + 独立 HTTP 端口；非 Tailscale/Wi-Fi）`,
    `**配对**：POST /v1/pairing/join（响应无 token 明文=${!report.pairing.join_response_has_token}；双端 trusted=${report.pairing.both_trusted}）`,
    "",
    "## 1. 50 × 2 离线事件对账",
    "",
    "| 项 | A | B |",
    "|---|---|---|",
    `| 离线写入业务事件 | ${report.offline.a_written} | ${report.offline.b_written} |`,
    `| 同步后本地业务事件 | ${r.a_business} | ${r.b_business} |`,
    `| 缺失 | ${r.a_missing.length} | ${r.b_missing.length} |`,
    `| 重复 | ${r.a_duplicates} | ${r.b_duplicates} |`,
    `| 来源 A 事件相对顺序一致 | ${r.order_a_from_a ? "是" : "否"} | ${r.order_a_from_b ? "是" : "否"} |`,
    `| 来源 B 事件相对顺序一致 | ${r.order_b_from_a ? "是" : "否"} | ${r.order_b_from_b ? "是" : "否"} |`,
    "",
    `**判定**：无丢失=${r.lossless}；无重复=${r.duplicate_free}；顺序一致=${r.order_ok}；pass=${report.pass}`,
    "",
    "## 2. 小事件同步 p95（100 样本）",
    "",
    "| 统计量 | 值 |",
    "|---|---|",
    `| 样本数 | ${p.samples} |`,
    `| p50 | ${p.p50_ms} ms |`,
    `| p90 | ${p.p90_ms} ms |`,
    `| **p95** | **${p.p95_ms} ms** |`,
    `| p99 | ${p.p99_ms} ms |`,
    `| min / max / mean | ${p.min_ms} / ${p.max_ms} / ${p.mean_ms} ms |`,
    `| 单条事件最大字节 | ${p.max_event_bytes} B（≤1KB=${p.small_event_within_1kb}） |`,
    `| 阈值 | ≤ ${p.threshold_ms} ms（PRD §8 待校准） |`,
    `| 判定 | ${p.met ? "MET" : "NOT MET"} |`,
    "",
    `> 环境说明：${p.environment_note}`,
    "",
    "## 3. 同步审计与状态",
    "",
    "| 项 | A | B |",
    "|---|---|---|",
    `| ledger sequence.max | ${report.sync.status_a.sequence.max} | ${report.sync.status_b.sequence.max} |`,
    `| last_sync_at | ${report.sync.status_a.last_sync_at} | ${report.sync.status_b.last_sync_at} |`,
    `| peer pending_upload | ${report.sync.status_a.peers[0]?.pending_upload ?? "n/a"} | ${report.sync.status_b.peers[0]?.pending_upload ?? "n/a"} |`,
    `| peer pending_download | ${report.sync.status_a.peers[0]?.pending_download ?? "n/a"} | ${report.sync.status_b.peers[0]?.pending_download ?? "n/a"} |`,
    "",
    `sync.run_completed 审计：${report.sync.audit.sync_run_completed}（A+B 账本合计）；sync.pulled：${report.sync.audit.sync_pulled}；sync.pushed：${report.sync.audit.sync_pushed}。`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDir = parseOutArg(argv);
  const keep = hasFlag(argv, "--keep");
  let pair: Pair | undefined;
  try {
    pair = await startPair({ keep });
    const pairing = await pairViaJoin(pair);

    // 配对后先确认双方都没有对方的离线事件（配对审计事件本身可以互有）
    const beforeA = await fetchAllEvents(pair.a);
    const beforeB = await fetchAllEvents(pair.b);

    const writtenA: Array<{ event_id: string; sequence: number }> = [];
    for (let index = 0; index < PER_SIDE; index++) {
      writtenA.push(await createSession(pair.a, `ac04-offline-A-${String(index + 1).padStart(2, "0")}`));
    }
    const writtenB: Array<{ event_id: string; sequence: number }> = [];
    for (let index = 0; index < PER_SIDE; index++) {
      writtenB.push(await createSession(pair.b, `ac04-offline-B-${String(index + 1).padStart(2, "0")}`));
    }

    const idsA = new Set(writtenA.map((entry) => entry.event_id));
    const idsB = new Set(writtenB.map((entry) => entry.event_id));
    const allWritten = new Set([...idsA, ...idsB]);
    const beforeAIds = new Set(beforeA.map((event) => event.event_id));
    const beforeBIds = new Set(beforeB.map((event) => event.event_id));
    const isolatedBeforeSync =
      writtenA.every((entry) => !beforeBIds.has(entry.event_id)) && writtenB.every((entry) => !beforeAIds.has(entry.event_id));

    const rounds = await syncRounds(pair, 3);
    const eventsA = await fetchAllEvents(pair.a);
    const eventsB = await fetchAllEvents(pair.b);

    const aBusiness = eventsA.filter((event) => allWritten.has(event.event_id)).length;
    const bBusiness = eventsB.filter((event) => allWritten.has(event.event_id)).length;

    const missingA = [...allWritten].filter((id) => !eventsA.some((event) => event.event_id === id));
    const missingB = [...allWritten].filter((id) => !eventsB.some((event) => event.event_id === id));
    const extraA = eventsA
      .filter((event) => event.event_type === "session.created" && event.replica_id !== REPLICA_A && event.replica_id !== REPLICA_B)
      .map((event) => event.event_id);
    const extraB = eventsB
      .filter((event) => event.event_type === "session.created" && event.replica_id !== REPLICA_A && event.replica_id !== REPLICA_B)
      .map((event) => event.event_id);

    const orderAA = orderOf(eventsA, REPLICA_A, idsA);
    const orderAB = orderOf(eventsB, REPLICA_A, idsA);
    const orderBA = orderOf(eventsA, REPLICA_B, idsB);
    const orderBB = orderOf(eventsB, REPLICA_B, idsB);
    const writtenOrderA = writtenA.map((entry) => entry.event_id);
    const writtenOrderB = writtenB.map((entry) => entry.event_id);
    const orderAFromA = equalOrder(orderAA, writtenOrderA);
    const orderAFromB = equalOrder(orderAB, writtenOrderA);
    const orderBFromA = equalOrder(orderBA, writtenOrderB);
    const orderBFromB = equalOrder(orderBB, writtenOrderB);

    const reconciliation: Reconciliation = {
      a_written: writtenA.length,
      b_written: writtenB.length,
      a_business: aBusiness,
      b_business: bBusiness,
      expected_business: PER_SIDE * 2,
      a_missing: missingA,
      b_missing: missingB,
      a_duplicates: duplicatesOf(eventsA, allWritten),
      b_duplicates: duplicatesOf(eventsB, allWritten),
      a_extra: extraA,
      b_extra: extraB,
      order_a_from_a: orderAFromA,
      order_a_from_b: orderAFromB,
      order_b_from_a: orderBFromA,
      order_b_from_b: orderBFromB,
      order_ok: orderAFromA && orderAFromB && orderBFromA && orderBFromB,
      lossless: missingA.length === 0 && missingB.length === 0,
      duplicate_free: duplicatesOf(eventsA, allWritten) === 0 && duplicatesOf(eventsB, allWritten) === 0,
    };

    // --- p95：100 次「单条小事件 → 一次 sync/run」---
    const samples: Sample[] = [];
    const p95EventIds: string[] = [];
    for (let index = 1; index <= P95_SAMPLES; index++) {
      const created = await createSession(pair.a, `p95-${index}`);
      p95EventIds.push(created.event_id);
      const started = performance.now();
      const report = await runSync(pair.a);
      const elapsed = performance.now() - started;
      if (!report.totals.ok || report.totals.failed > 0 || report.totals.pushed < 1) {
        throw new Error(`p95 sample ${index}: sync/run did not push the new event: ${JSON.stringify(report.totals)}`);
      }
      samples.push({ index, elapsed_ms: round2(elapsed), event_id: created.event_id });
    }

    // 计时结束后的收尾同步：让 B 也 pull 到 A 的 p95 事件（p95 采样期间只由 A push），
    // 使状态面板的 pending_download 回到审计残量而不是 401 条。
    await syncRounds(pair, 2);

    // 收敛验证（计时之外）：100 条 p95 事件都恰好一次到达 B
    const eventsBAfterP95 = await fetchAllEvents(pair.b);
    const p95IdSet = new Set(p95EventIds);
    const p95OnB = eventsBAfterP95.filter((event) => p95IdSet.has(event.event_id)).length;
    const allSamplesConverged = p95OnB === P95_SAMPLES && eventsBAfterP95.filter((event) => p95IdSet.has(event.event_id)).length === new Set(p95EventIds).size;

    const eventsAAfter = await fetchAllEvents(pair.a);
    const eventById = new Map([...eventsAAfter, ...eventsBAfterP95].map((event) => [event.event_id, event]));
    const maxEventBytes = Math.max(
      0,
      ...p95EventIds.map((id) => {
        const event = eventById.get(id);
        return event === undefined ? 0 : Buffer.byteLength(JSON.stringify(event), "utf8");
      }),
    );

    const elapsed = samples.map((sample) => sample.elapsed_ms);
    const p95 = {
      samples: P95_SAMPLES,
      threshold_ms: P95_THRESHOLD_MS,
      p50_ms: round2(percentile(elapsed, 50)),
      p90_ms: round2(percentile(elapsed, 90)),
      p95_ms: round2(percentile(elapsed, 95)),
      p99_ms: round2(percentile(elapsed, 99)),
      min_ms: round2(Math.min(...elapsed)),
      max_ms: round2(Math.max(...elapsed)),
      mean_ms: round2(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length),
      all_samples_converged: allSamplesConverged,
      max_event_bytes: maxEventBytes,
      small_event_within_1kb: maxEventBytes <= SMALL_EVENT_MAX_BYTES,
      met: percentile(elapsed, 95) <= P95_THRESHOLD_MS,
      environment_note:
        "本机回环基线（127.0.0.1，单机双实例，node 24）：100 次「1 条 session.created（≤1KB）→ POST /v1/sync/run 完成」的墙钟耗时，百分位用最近秩法。真实 Tailscale/Wi-Fi 网络未测，阈值待校准（PRD §8）。",
    };

    const statusA = assertStatus(await getJson<SyncStatusView>(pair.a, "/v1/sync/status"), 200, "GET /v1/sync/status");
    const statusB = assertStatus(await getJson<SyncStatusView>(pair.b, "/v1/sync/status"), 200, "GET /v1/sync/status");
    const audit = {
      sync_run_completed: countByType(eventsAAfter, "sync.run_completed") + countByType(eventsBAfterP95, "sync.run_completed"),
      sync_pulled: countByType(eventsAAfter, "sync.pulled") + countByType(eventsBAfterP95, "sync.pulled"),
      sync_pushed: countByType(eventsAAfter, "sync.pushed") + countByType(eventsBAfterP95, "sync.pushed"),
    };

    const bothTrusted = [pairing.devices_a, pairing.devices_b].every((devices) => {
      const peer = devices.find((device) => device.replica_id === (devices === pairing.devices_a ? REPLICA_B : REPLICA_A));
      return peer !== undefined && peer.trusted && !peer.revoked;
    });

    const pass =
      reconciliation.lossless &&
      reconciliation.duplicate_free &&
      reconciliation.order_ok &&
      isolatedBeforeSync &&
      allSamplesConverged &&
      p95.small_event_within_1kb &&
      p95.met &&
      bothTrusted;

    const report: Ac04Report = {
      ticket: "M3-T7 / Issue #36 AC-04",
      generated_at: nowIso(),
      environment: nodeEnv(),
      replicas: { a: REPLICA_A, b: REPLICA_B },
      pairing: {
        method: "POST /v1/pairing/join",
        join_response_has_token: pairing.join_response_has_token,
        devices_a: pairing.devices_a.length,
        devices_b: pairing.devices_b.length,
        both_trusted: bothTrusted,
      },
      offline: {
        per_side: PER_SIDE,
        a_written: writtenA.length,
        b_written: writtenB.length,
        isolated_before_sync: isolatedBeforeSync,
      },
      sync: {
        rounds: rounds.map((round) => ({
          round: round.round,
          a: round.a,
          b: round.b,
        })),
        status_a: statusA,
        status_b: statusB,
        audit,
      },
      reconciliation,
      p95,
      pass,
    };

    const markdown = renderMarkdown(report);
    if (outDir !== null) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "m3-ac04-sync.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(outDir, "m3-ac04-sync.md"), markdown, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    console.log("\n--- Markdown ---\n");
    console.log(markdown);
    if (!pass) {
      throw new Error("AC-04 assertions failed; see report above");
    }
  } finally {
    if (pair !== undefined) await closePair(pair, keep);
  }
}

main().catch((err: unknown) => {
  console.error(`[ac04] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
