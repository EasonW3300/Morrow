#!/usr/bin/env node
/**
 * AC-05 合并态复跑归档（M3-T7 / Issue #36；PRD §8 AC-05 / §4.6 FR-DEP-5、§4.1 FR-MEM-8）。
 *
 * 方法：
 *   1. 两个独立 Runtime（真实 HTTP 传输）；B 经 POST /v1/pairing/join 加入 A；
 *   2. A 账本落 20 条 `memory.fact_created`（基线 v1；事实 id 显式），同步到 B；
 *   3. A/B 各自离线写同一事实的 v2 竞争修订（内容/敏感等级按 20 个样本），重连同步；
 *   4. 逐项分类：6 个 preference 应自动合并（两端收敛到同一 v3）；14 个应进待审核
 *      （locked 3 / sensitivity_change 5 / fact_conflict 6），分类口径复用 M1 巩固器
 *      （DefaultConsolidator，展示在同一行）；
 *   5. 删除不复活双向：A 删 / B 离线改 → 同步；B 删 / A 离线改 → 同步；
 *      断言双方事实保持 deleted_at 非空、旧修订未导入、sync.tombstone_skipped 审计。
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac05-conflicts.ts \
 *     [--out docs/gates] [--keep]
 *
 * 输出：stdout JSON 摘要 + Markdown 表；--out 目录额外写 m3-ac05-conflicts.json / .md。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope, MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import { buildEventEnvelope } from "../../apps/runtime/src/envelope.ts";
import { DefaultConsolidator } from "../../apps/runtime/src/memory/consolidator.ts";
import { uuidv7 } from "../../apps/runtime/src/uuid-v7.ts";
import {
  REPLICA_A,
  REPLICA_B,
  closePair,
  countByType,
  fetchAllEvents,
  hasFlag,
  nodeEnv,
  nowIso,
  parseOutArg,
  pairViaJoin,
  startPair,
  syncRounds,
  type Pair,
} from "./lib/m3-harness.ts";

interface Sample {
  name: string;
  kind: MemoryEntryKind;
  localSensitivity: SensitivityLevel;
  remoteSensitivity: SensitivityLevel;
  localContent: string;
  remoteContent: string;
  expect: "auto" | "locked" | "sensitivity_change" | "fact_conflict";
}

/** 20 个竞争事实样本（与 apps/runtime/test/sync.merge.test.ts 同一集合） */
const SAMPLES: Sample[] = [
  { name: "pref-vim-emacs", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 偏好使用 vim 编辑器。", remoteContent: "Owner 偏好使用 emacs 编辑器。", expect: "auto" },
  { name: "pref-theme", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "I prefer the dark theme for the editor.", remoteContent: "I prefer the light theme for the editor.", expect: "auto" },
  { name: "pref-dark-light", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 喜欢深色主题。", remoteContent: "Owner 喜欢浅色主题。", expect: "auto" },
  { name: "pref-pnpm-npm", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 默认使用 pnpm 安装依赖。", remoteContent: "Owner 默认使用 npm 安装依赖。", expect: "auto" },
  { name: "pref-tabs-spaces", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner prefers tabs in TypeScript files.", remoteContent: "Owner prefers spaces in TypeScript files.", expect: "auto" },
  { name: "pref-font", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 的编辑器字体是 JetBrains Mono。", remoteContent: "Owner 的编辑器字体是 Fira Code。", expect: "auto" },
  { name: "fact-database", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "项目使用 PostgreSQL 作为主数据库。", remoteContent: "项目使用 MySQL 作为主数据库。", expect: "fact_conflict" },
  { name: "fact-ubuntu-debian", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "部署目标是 Ubuntu 24.04。", remoteContent: "部署目标是 Debian 12。", expect: "fact_conflict" },
  { name: "fact-port", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "服务监听端口 8787。", remoteContent: "服务监听端口 9000。", expect: "fact_conflict" },
  { name: "fact-sqlite", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "Morrow runtime 使用 node:sqlite。", remoteContent: "Morrow runtime 使用 better-sqlite3。", expect: "fact_conflict" },
  { name: "fact-city", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 住在杭州。", remoteContent: "Owner 住在上海。", expect: "fact_conflict" },
  { name: "fact-branch", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "发布分支是 integration/m0。", remoteContent: "发布分支是 main。", expect: "fact_conflict" },
  { name: "locked-passport", kind: "profile", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "Owner 的护照号是 E12345678。", remoteContent: "Owner 的护照号是 E87654321。", expect: "locked" },
  { name: "locked-birthday", kind: "profile", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "Owner 的生日是 1990-01-01。", remoteContent: "Owner 的生日是 1991-01-01。", expect: "locked" },
  { name: "locked-credential", kind: "fact", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "服务器根密码已托管在 1Password。", remoteContent: "服务器根密码已托管在 Bitwarden。", expect: "locked" },
  { name: "sens-address", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的家庭地址是杭州西湖区。", remoteContent: "Owner 的家庭地址是杭州滨江区。", expect: "sensitivity_change" },
  { name: "sens-phone", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的手机号是 13800000000。", remoteContent: "Owner 的手机号是 13900000000。", expect: "sensitivity_change" },
  { name: "sens-medical", kind: "fact", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的医疗记录保存在家庭医生处。", remoteContent: "Owner 的医疗记录保存在私人诊所。", expect: "sensitivity_change" },
  { name: "sens-apikey", kind: "fact", localSensitivity: "private", remoteSensitivity: "public", localContent: "客户的 API key 存放在 vault。", remoteContent: "客户的 API key 存放在环境变量。", expect: "sensitivity_change" },
  { name: "sens-bank", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的银行账户尾号 1234。", remoteContent: "Owner 的银行账户尾号 5678。", expect: "sensitivity_change" },
];

interface RowResult {
  name: string;
  kind: MemoryEntryKind;
  expected: Sample["expect"];
  m1_consolidator: string;
  a_conflict_reason: string | null;
  b_conflict_reason: string | null;
  a_version: number | null;
  b_version: number | null;
  a_content: string | null;
  b_content: string | null;
  converged: boolean;
  local_view_kept: boolean | null;
  pass: boolean;
}

interface DeletionEvidence {
  direction: string;
  fact_id: string;
  deleted_a: boolean;
  deleted_b: boolean;
  stale_event_imported_by_deleter: boolean;
  tombstone_skipped_audits: number;
  pass: boolean;
}

interface Ac05Report {
  ticket: string;
  generated_at: string;
  environment: Record<string, string>;
  samples: number;
  counts: {
    auto_expected: number;
    auto_merged: number;
    review_expected: number;
    review_raised: number;
    locked: number;
    sensitivity_change: number;
    fact_conflict: number;
    /** 待审核样本中，本地 v2 编辑仍可见的条数（缺陷观测；见 §6） */
    review_local_view_retained: number;
  };
  rows: RowResult[];
  deletion: {
    evidence: DeletionEvidence[];
    pass: boolean;
  };
  audit: {
    sync_merged_a: number;
    sync_merged_b: number;
    sync_conflict_a: number;
    sync_conflict_b: number;
    tombstone_skipped_a: number;
    tombstone_skipped_b: number;
  };
  pass: boolean;
}

function factCreated(pair: Pair, factId: string, sample: Sample): EventEnvelope {
  // 基线 v1 与 A 侧 v2 同主题、同内容（v2 仅推进版本）——三方合并的「共同主题」成立；
  // 若基线换成无关文本，M1 巩固器会因显著词元交集为空判 create_fact → fact_conflict，
  // 分类样本就不再是「同一事实的竞争修订」。
  const envelope = buildEventEnvelope({
    replicaId: REPLICA_A,
    actorId: "owner",
    eventType: "memory.fact_created",
    payload: {
      fact_id: factId,
      version: 1,
      content: sample.localContent,
      kind: sample.kind,
      sensitivity: sample.localSensitivity,
      revision_id: uuidv7(),
      reason: "seed",
    },
  });
  pair.a.runtime.ledger.append(envelope);
  return envelope;
}

function offlineUpdate(pair: Pair, replicaId: string, factId: string, sample: Sample, side: "A" | "B"): EventEnvelope {
  const envelope = buildEventEnvelope({
    replicaId,
    actorId: "owner",
    eventType: "memory.fact_updated",
    payload: {
      fact_id: factId,
      version: 2,
      content: side === "A" ? sample.localContent : sample.remoteContent,
      kind: sample.kind,
      sensitivity: side === "A" ? sample.localSensitivity : sample.remoteSensitivity,
      revision_id: uuidv7(),
      reason: "offline_edit",
    },
  });
  (side === "A" ? pair.a : pair.b).runtime.ledger.append(envelope);
  return envelope;
}

function reasonOf(
  conflicts: Array<{ fact_id: string; reason: string }>,
  factId: string,
): string | null {
  return conflicts.find((conflict) => conflict.fact_id === factId)?.reason ?? null;
}

function m1Branch(sample: Sample): string {
  const action = new DefaultConsolidator().consolidate({
    candidates: [
      {
        candidateId: "remote",
        content: sample.remoteContent,
        kind: sample.kind,
        sensitivity: sample.remoteSensitivity,
        confidence: 1,
        sourceId: "sync",
      },
    ],
    facts: [
      {
        factId: "local",
        content: sample.localContent,
        kind: sample.kind,
        sensitivity: sample.localSensitivity,
        version: 2,
      },
    ],
  })[0];
  if (action === undefined) return "no_action";
  if (action.action === "update_fact") return "auto_merge";
  if (action.action === "escalate") return `review:${action.reason}`;
  return action.action;
}

function renderMarkdown(report: Ac05Report): string {
  const lines = [
    "# AC-05 合并态复跑归档（M3-T7 / Issue #36）",
    "",
    `**生成时间**：${report.generated_at} ｜ **node**：${report.environment.node} ｜ **平台**：${report.environment.platform}`,
    `**样本**：20 个竞争事实（6 preference 自动合并 + 14 待审核：locked 3 / sensitivity_change 5 / fact_conflict 6）`,
    "",
    "## 1. 20 个竞争事实分类结果",
    "",
    "| # | 样本 | kind | M1 巩固器分支 | 期望 | A 分类 | B 分类 | A v / B v | 收敛 | 本地视图保留 | 判定 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  report.rows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${row.name} | ${row.kind} | ${row.m1_consolidator} | ${row.expected} | ${row.a_conflict_reason ?? "auto_merge"} | ${row.b_conflict_reason ?? "auto_merge"} | ${row.a_version ?? "-"} / ${row.b_version ?? "-"} | ${row.converged} | ${row.local_view_kept === null ? "-" : row.local_view_kept} | ${row.pass ? "PASS" : "FAIL"} |`,
    );
  });
  lines.push(
    "",
    "**计数**：" +
      `自动合并期望 ${report.counts.auto_expected} → 实际 ${report.counts.auto_merged}；` +
      `待审核期望 ${report.counts.review_expected} → 实际 ${report.counts.review_raised}；` +
      `locked ${report.counts.locked} / sensitivity_change ${report.counts.sensitivity_change} / fact_conflict ${report.counts.fact_conflict}。`,
    "",
    `> **缺陷观测（如实登记，见门禁报告 §6）**：14 个待审核样本的**分类全部正确**，但两端都产生 ` +
      `sync.conflict 后，跨端冲突审计互把对方本地 v2 修订记入 remote_event_ids，重放时双方可见值回落基线 v1；` +
      `本地 v2 可见的条数 = ${report.counts.review_local_view_retained}/${report.counts.review_expected}。` +
      `冲突队列（memory_conflicts）仍完整保留两侧内容，Owner 仍可裁决；缺陷在「重放过滤未按 local_replica_id 归属判定」，` +
      `不影响 AC-05 的「预期合并或待审核」分类判定，但影响待审核期间的本地可见值。`,
    "",
    "## 2. 删除不复活（双向）",
    "",
    "| 方向 | fact_id | A deleted | B deleted | 删除方导入了旧修订 | tombstone_skipped 审计 | 判定 |",
    "|---|---|---|---|---|---|---|",
  );
  for (const item of report.deletion.evidence) {
    lines.push(
      `| ${item.direction} | ${item.fact_id} | ${item.deleted_a} | ${item.deleted_b} | ${item.stale_event_imported_by_deleter} | ${item.tombstone_skipped_audits} | ${item.pass ? "PASS" : "FAIL"} |`,
    );
  }
  lines.push(
    "",
    `**删除判定**：${report.deletion.pass ? "PASS（双方保持删除态，旧修订未复活）" : "FAIL"}`,
    "",
    "## 3. 同步审计",
    "",
    "| 事件 | A | B |",
    "|---|---|---|",
    `| sync.merged | ${report.audit.sync_merged_a} | ${report.audit.sync_merged_b} |`,
    `| sync.conflict | ${report.audit.sync_conflict_a} | ${report.audit.sync_conflict_b} |`,
    `| sync.tombstone_skipped | ${report.audit.tombstone_skipped_a} | ${report.audit.tombstone_skipped_b} |`,
    "",
    `**总判定**：${report.pass ? "PASS" : "FAIL"}`,
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDir = parseOutArg(argv);
  const keep = hasFlag(argv, "--keep");
  let pair: Pair | undefined;
  try {
    pair = await startPair({ keep });
    await pairViaJoin(pair);

    // --- 20 个基线事实（显式 fact_id，直接落 memory.fact_created 事件）---
    const sampleFacts = SAMPLES.map((sample) => ({ sample, factId: uuidv7() }));
    for (const { sample, factId } of sampleFacts) factCreated(pair, factId, sample);
    pair.a.runtime.memoryRebuilder.rebuild();

    // 先把基线事实同步到 B（B 的导入路径会重建记忆投影）
    await syncRounds(pair, 2);
    for (const { sample, factId } of sampleFacts) {
      const onB = pair.b.runtime.memory.getFact(factId);
      if (onB === null || onB.version !== 1) {
        throw new Error(`B 未收到基线事实 ${sample.name} (${factId})：${JSON.stringify(onB)}`);
      }
    }

    // --- 双方离线写竞争 v2 ---
    const updatesA: EventEnvelope[] = [];
    const updatesB: EventEnvelope[] = [];
    for (const { sample, factId } of sampleFacts) {
      updatesA.push(offlineUpdate(pair, REPLICA_A, factId, sample, "A"));
      updatesB.push(offlineUpdate(pair, REPLICA_B, factId, sample, "B"));
    }
    // 离线编辑在本机立即可见（生产路径由 MemoryService 写行 + 投影；这里直接落事件，
    // 必须重建投影才能模拟“重连前本地记忆视图已是 v2”）
    pair.a.runtime.memoryRebuilder.rebuild();
    pair.b.runtime.memoryRebuilder.rebuild();

    // 重连：多轮确保合并/冲突审计事件也传播到两端
    await syncRounds(pair, 6);

    const conflictsA = pair.a.runtime.memory.listConflicts({ status: "open" });
    const conflictsB = pair.b.runtime.memory.listConflicts({ status: "open" });
    const rows: RowResult[] = sampleFacts.map(({ sample, factId }) => {
      const aFact = pair.a.runtime.memory.getFact(factId);
      const bFact = pair.b.runtime.memory.getFact(factId);
      const aReason = reasonOf(conflictsA, factId);
      const bReason = reasonOf(conflictsB, factId);
      const converged =
        aFact !== null &&
        bFact !== null &&
        aFact.content === bFact.content &&
        aFact.version === bFact.version;
      if (sample.expect === "auto") {
        const pass =
          converged &&
          aReason === null &&
          bReason === null &&
          aFact !== null &&
          bFact !== null &&
          aFact.version === 3;
        return {
          name: sample.name,
          kind: sample.kind,
          expected: sample.expect,
          m1_consolidator: m1Branch(sample),
          a_conflict_reason: aReason,
          b_conflict_reason: bReason,
          a_version: aFact?.version ?? null,
          b_version: bFact?.version ?? null,
          a_content: aFact?.content ?? null,
          b_content: bFact?.content ?? null,
          converged,
          local_view_kept: null,
          pass,
        };
      }
      const localViewKept =
        aFact !== null && aFact.version === 2 && aFact.content === sample.localContent;
      // AC-05 判定口径：分类正确（双方都进同一原因的待审核队列）即达成；
      // 「本地可见值是否保留」单列为缺陷观测——两端同时竞争时跨端 sync.conflict
      // 会把彼此本地修订也标记为不采纳，重放后可见值回落基线（见报告 §6）。
      const pass =
        aReason === sample.expect &&
        bReason === sample.expect &&
        aFact !== null &&
        bFact !== null;
      return {
        name: sample.name,
        kind: sample.kind,
        expected: sample.expect,
        m1_consolidator: m1Branch(sample),
        a_conflict_reason: aReason,
        b_conflict_reason: bReason,
        a_version: aFact?.version ?? null,
        b_version: bFact?.version ?? null,
        a_content: aFact?.content ?? null,
        b_content: bFact?.content ?? null,
        converged,
        local_view_kept: localViewKept,
        pass,
      };
    });

    // --- 删除不复活（双向）---
    const delSampleA: Sample = {
      name: "delete-a",
      kind: "fact",
      localSensitivity: "private",
      remoteSensitivity: "private",
      localContent: "删除测试 A：本地端口 8787。",
      remoteContent: "删除测试 A：离线端口 9000。",
      expect: "fact_conflict",
    };
    const delSampleB: Sample = {
      name: "delete-b",
      kind: "fact",
      localSensitivity: "private",
      remoteSensitivity: "private",
      localContent: "删除测试 B：部署 Ubuntu 24.04。",
      remoteContent: "删除测试 B：离线 Debian 12。",
      expect: "fact_conflict",
    };
    const delFactA = uuidv7();
    const delFactB = uuidv7();
    factCreated(pair, delFactA, delSampleA);
    factCreated(pair, delFactB, delSampleB);
    pair.a.runtime.memoryRebuilder.rebuild();
    await syncRounds(pair, 2);
    if (pair.b.runtime.memory.getFact(delFactA) === null || pair.b.runtime.memory.getFact(delFactB) === null) {
      throw new Error("删除测试基线未同步到 B");
    }

    // A 删除 factA；B 离线继续编辑旧修订
    pair.a.runtime.memory.deleteFact(delFactA);
    const staleA = buildEventEnvelope({
      replicaId: REPLICA_B,
      actorId: "owner",
      eventType: "memory.fact_updated",
      payload: {
        fact_id: delFactA,
        version: 2,
        content: delSampleA.remoteContent,
        kind: delSampleA.kind,
        sensitivity: delSampleA.remoteSensitivity,
        revision_id: uuidv7(),
        reason: "offline_edit",
      },
    });
    pair.b.runtime.ledger.append(staleA);

    // B 删除 factB；A 离线继续编辑旧修订（反向）
    pair.b.runtime.memory.deleteFact(delFactB);
    const staleB = buildEventEnvelope({
      replicaId: REPLICA_A,
      actorId: "owner",
      eventType: "memory.fact_updated",
      payload: {
        fact_id: delFactB,
        version: 2,
        content: delSampleB.localContent,
        kind: delSampleB.kind,
        sensitivity: delSampleB.localSensitivity,
        revision_id: uuidv7(),
        reason: "offline_edit",
      },
    });
    pair.a.runtime.ledger.append(staleB);

    await syncRounds(pair, 6);

    const deletionEvidence: DeletionEvidence[] = [
      {
        direction: "A 删 / B 离线改 / B 上线",
        fact_id: delFactA,
        deleted_a: pair.a.runtime.memory.getFact(delFactA)?.deleted_at != null,
        deleted_b: pair.b.runtime.memory.getFact(delFactA)?.deleted_at != null,
        stale_event_imported_by_deleter: pair.a.runtime.ledger.hasEvent(staleA.event_id),
        tombstone_skipped_audits: pair.a.runtime.ledger
          .scan({ eventType: "sync.tombstone_skipped" })
          .filter((entry) => (entry.envelope.payload as { event_id?: string }).event_id === staleA.event_id).length,
        pass: false,
      },
      {
        direction: "B 删 / A 离线改 / A 上线",
        fact_id: delFactB,
        deleted_a: pair.a.runtime.memory.getFact(delFactB)?.deleted_at != null,
        deleted_b: pair.b.runtime.memory.getFact(delFactB)?.deleted_at != null,
        stale_event_imported_by_deleter: pair.b.runtime.ledger.hasEvent(staleB.event_id),
        tombstone_skipped_audits: pair.b.runtime.ledger
          .scan({ eventType: "sync.tombstone_skipped" })
          .filter((entry) => (entry.envelope.payload as { event_id?: string }).event_id === staleB.event_id).length,
        pass: false,
      },
    ];
    for (const item of deletionEvidence) {
      item.pass =
        item.deleted_a &&
        item.deleted_b &&
        !item.stale_event_imported_by_deleter &&
        item.tombstone_skipped_audits >= 1;
    }

    // 删除后再同步一轮，仍保持删除态
    await syncRounds(pair, 2);
    const stillDeleted =
      pair.a.runtime.memory.getFact(delFactA)?.deleted_at != null &&
      pair.b.runtime.memory.getFact(delFactA)?.deleted_at != null &&
      pair.a.runtime.memory.getFact(delFactB)?.deleted_at != null &&
      pair.b.runtime.memory.getFact(delFactB)?.deleted_at != null;

    const eventsA = await fetchAllEvents(pair.a);
    const eventsB = await fetchAllEvents(pair.b);
    const autoRows = rows.filter((row) => row.expected === "auto");
    const reviewRows = rows.filter((row) => row.expected !== "auto");
    const counts = {
      auto_expected: autoRows.length,
      auto_merged: autoRows.filter((row) => row.pass).length,
      review_expected: reviewRows.length,
      review_raised: reviewRows.filter((row) => row.a_conflict_reason === row.expected && row.b_conflict_reason === row.expected).length,
      locked: reviewRows.filter((row) => row.expected === "locked").length,
      sensitivity_change: reviewRows.filter((row) => row.expected === "sensitivity_change").length,
      fact_conflict: reviewRows.filter((row) => row.expected === "fact_conflict").length,
      review_local_view_retained: reviewRows.filter((row) => row.local_view_kept === true).length,
    };
    const audit = {
      sync_merged_a: countByType(eventsA, "sync.merged"),
      sync_merged_b: countByType(eventsB, "sync.merged"),
      sync_conflict_a: countByType(eventsA, "sync.conflict"),
      sync_conflict_b: countByType(eventsB, "sync.conflict"),
      tombstone_skipped_a: countByType(eventsA, "sync.tombstone_skipped"),
      tombstone_skipped_b: countByType(eventsB, "sync.tombstone_skipped"),
    };
    const deletionPass = deletionEvidence.every((item) => item.pass) && stillDeleted;
    const pass =
      rows.length === 20 &&
      rows.every((row) => row.pass) &&
      counts.auto_merged === counts.auto_expected &&
      counts.review_raised === counts.review_expected &&
      counts.locked === 3 &&
      counts.sensitivity_change === 5 &&
      counts.fact_conflict === 6 &&
      deletionPass;

    const report: Ac05Report = {
      ticket: "M3-T7 / Issue #36 AC-05",
      generated_at: nowIso(),
      environment: nodeEnv(),
      samples: rows.length,
      counts,
      rows,
      deletion: { evidence: deletionEvidence, pass: deletionPass },
      audit,
      pass,
    };
    const markdown = renderMarkdown(report);
    if (outDir !== null) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "m3-ac05-conflicts.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(join(outDir, "m3-ac05-conflicts.md"), markdown, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    console.log("\n--- Markdown ---\n");
    console.log(markdown);
    if (!pass) {
      throw new Error("AC-05 assertions failed; see report above");
    }
  } finally {
    if (pair !== undefined) await closePair(pair, keep);
  }
}

main().catch((err: unknown) => {
  console.error(`[ac05] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
