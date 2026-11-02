// AC-03 前置验证脚本（票 M1-T3 / Issue #15；PRD AC-03 / FR-MEM-1..8 / GLOSSARY 回链口径）。
//
// 100 条设计记录端到端：写入（message.user 入账）→ 抽取（memory.extracted + 候选）→
// 巩固（事实 + memory.fact_created）→ Markdown 投影（幂等断言）→ FTS 检索 → 逐条回链
// 断言（全部 100 条投影 frontmatter 的 sources 非空且指向存在的账本事件）→ 账本完整性
// 校验 → 投影/导入/删除抽查（1 条受控编辑转版本化修订、1 条删除标记不复活）。
//
// 确定性 / 零网络 / 可重复执行：抽取器与巩固器均为确定性实现（脚本内 stub + 默认决策
// 矩阵），记录内容两两词元不相交（每条恰建一个事实，无冲突分支）；不建 HTTP 服务、
// 不发任何网络请求；数据目录每次运行新建临时目录、退出时清理，可反复执行。
// 运行：pnpm --filter @morrow/runtime memory:ac03
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "../src/ledger.ts";
import { buildEventEnvelope } from "../src/envelope.ts";
import { MemoryProjector, parseFactMarkdown } from "../src/memory/projection.ts";
import { MemoryService } from "../src/memory/service.ts";
import { MemoryStore } from "../src/memory/store.ts";
import type { MemoryExtractor } from "../src/memory/extraction.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const SESSION = "01936b9d-8f7a-7abc-9f2e-00000000ac03";
const RECORDS = 100;

const pad = (i: number): string => String(i).padStart(3, "0");
/** 设计记录 i 的内容：词元（mem-### / tok-###）逐条唯一——巩固器按显著词元匹配，
 *  两两不相交保证每条候选恰好新建一个事实（零冲突分支，结果确定性） */
const contentOf = (i: number): string => `mem-${pad(i)} tok-${pad(i)}`;

/** 脚本抽取器：本轮文本原样成候选（confidence 0.9 ≥ 自动巩固准入线 0.8） */
const extractor: MemoryExtractor = {
  extract: (input) => [
    { content: input.userText.trim(), kind: "fact", confidence: 0.9, sensitivity: "private", rule: "ac03-script" },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "morrow-ac03-"));
const store = MemoryStore.open(dir);
const ledger = EventLedger.open(dir);
const projector = new MemoryProjector({ store, dataDir: dir });
const service = new MemoryService({ store, ledger, replicaId: REPLICA, extractor, projector });

function fail(message: string): never {
  throw new Error(`AC-03: ${message}`);
}

function fileOf(factId: string): string {
  return join(projector.dir, `${factId}.md`);
}

try {
  // 1) 写入 → 抽取 → 巩固：100 条设计记录逐条走完整管线 --------------------------
  const factIds: string[] = [];
  for (let i = 0; i < RECORDS; i++) {
    const user = buildEventEnvelope({
      replicaId: REPLICA,
      actorId: "owner",
      eventType: "message.user",
      sessionId: SESSION,
      payload: { text: contentOf(i) },
    });
    ledger.append(user);
    const run = await service.extractTurn({
      sessionId: SESSION,
      userEventId: user.event_id,
      occurredAt: user.occurred_at,
      text: contentOf(i),
    });
    const factId = run.consolidation?.createdFactIds[0];
    if (factId === undefined) fail(`record ${i} (${contentOf(i)}): expected one consolidated fact`);
    factIds.push(factId);
  }
  if (factIds.length !== RECORDS) fail(`expected ${RECORDS} facts, got ${factIds.length}`);
  if (new Set(factIds).size !== RECORDS) fail("fact ids must be distinct");
  if (store.listFacts().length !== RECORDS) fail("live fact view must hold exactly 100 facts");
  console.log(`[1/6] 写入→抽取→巩固：${RECORDS} 条记录各成一条事实（fact_created 事件齐全）`);

  // 2) 投影 + 幂等断言（同状态同字节） -------------------------------------------
  const first = projector.projectAll();
  if (first.written.length !== RECORDS || first.removed.length !== 0) {
    fail(`first projection: expected ${RECORDS} written / 0 removed, got ${JSON.stringify(first)}`);
  }
  const before = new Map(readdirSync(projector.dir).map((name) => [name, readFileSync(join(projector.dir, name))]));
  const second = projector.projectAll();
  if (second.written.length !== 0 || second.unchanged.length !== RECORDS || second.removed.length !== 0) {
    fail(`re-projection must be a no-op, got ${JSON.stringify(second)}`);
  }
  for (const [name, bytes] of before) {
    if (!readFileSync(join(projector.dir, name)).equals(bytes)) fail(`projection file ${name} is not byte-identical on regeneration`);
  }
  console.log(`[2/6] 投影：${RECORDS} 个 {fact_id}.md；再生成幂等（0 写入 / ${RECORDS} 未变 / 同字节）`);

  // 3) 检索：每条记录可经 FTS 命中其事实（含来源回链） ----------------------------
  for (let i = 0; i < RECORDS; i++) {
    const hits = service.search(`tok-${pad(i)}`);
    const factHit = hits.find((h) => h.stage === "fact" && h.content === contentOf(i));
    if (factHit === undefined) fail(`record ${i}: FTS search did not hit its fact`);
    if (factHit.sources.length === 0) fail(`record ${i}: fact hit has no source links`);
  }
  console.log(`[3/6] 检索：${RECORDS}/${RECORDS} 条记录 FTS 命中事实（含来源回链）`);

  // 4) 逐条回链断言：投影 frontmatter sources 非空且全部指向存在的账本事件 ---------
  const ledgerEventIds = new Set(ledger.scan().map((entry) => entry.envelope.event_id));
  for (let i = 0; i < RECORDS; i++) {
    const factId = factIds[i];
    const parsed = parseFactMarkdown(readFileSync(fileOf(factId), "utf8"));
    if (parsed.fields.id !== factId) fail(`record ${i}: frontmatter id mismatch`);
    if (Number(parsed.fields.version) !== 1) fail(`record ${i}: unexpected version`);
    if (parsed.fields.type !== "fact" || parsed.fields.sensitivity !== "private") {
      fail(`record ${i}: frontmatter type/sensitivity mismatch`);
    }
    let sources: unknown;
    try {
      sources = JSON.parse(parsed.fields.sources);
    } catch {
      fail(`record ${i}: sources is not a JSON array`);
    }
    if (!Array.isArray(sources) || sources.length === 0) fail(`record ${i}: sources must be a non-empty array`);
    for (const sourceEventId of sources) {
      if (typeof sourceEventId !== "string" || !ledgerEventIds.has(sourceEventId)) {
        fail(`record ${i}: source ${String(sourceEventId)} does not point to an existing ledger event`);
      }
    }
  }
  console.log(`[4/6] 回链断言：${RECORDS}/${RECORDS} 条 sources 非空且全部指向存在的账本事件（共 ${ledgerEventIds.size} 个事件）`);

  // 5) 账本完整性 -----------------------------------------------------------------
  const integrity = ledger.verifyIntegrity();
  if (!integrity.ok) fail(`integrity mismatches: ${JSON.stringify(integrity.mismatches)}`);
  console.log(`[5/6] 账本完整性：${integrity.checked}/${integrity.total} 事件 hash 校验通过`);

  // 6) 投影 → 受控导入 → 删除标记 抽查（M1-T3 端到端） ----------------------------
  // 6a. 受控导入：编辑第 0 条 → 版本化修订 + 投影刷新
  const editFactId = factIds[0];
  const original = readFileSync(fileOf(editFactId), "utf8");
  const edited = original.replace(`\n\n${contentOf(0)}\n`, `\n\n${contentOf(0)} revised by owner\n`);
  if (edited === original) fail("import spot-check: failed to edit the projected body");
  const imported = service.importMarkdown(edited);
  if (imported.status !== "updated" || imported.version !== 2) fail(`import spot-check: expected updated v2, got ${JSON.stringify(imported)}`);
  if (!readFileSync(fileOf(editFactId), "utf8").includes("version: 2")) fail("import spot-check: projection file not refreshed");
  const afterImport = projector.projectAll();
  if (afterImport.written.length !== 0 || afterImport.unchanged.length !== RECORDS) {
    fail(`post-import re-projection must be idempotent, got ${JSON.stringify(afterImport)}`);
  }
  // 编辑后的事实回链依然成立（sources 增加了 memory.import_received 证据事件）
  const ledgerEventIdsAfterImport = new Set(ledger.scan().map((entry) => entry.envelope.event_id));
  const reParsed = parseFactMarkdown(readFileSync(fileOf(editFactId), "utf8"));
  const reSources = JSON.parse(reParsed.fields.sources) as string[];
  if (reSources.length === 0 || reSources.some((s) => !ledgerEventIdsAfterImport.has(s))) {
    fail("import spot-check: refreshed sources broke ledger backlinks");
  }

  // 6b. 删除标记：删除最后一条 → tombstone + 文件移除 + 重投影不复活
  const deleteFactId = factIds[RECORDS - 1];
  const deleted = service.deleteFact(deleteFactId);
  if (deleted.deleted !== true) fail("delete spot-check: expected deleted:true");
  if (store.getFact(deleteFactId) === null) fail("delete must be a soft delete (row retained for audit)");
  const tombstones = ledger.scan({ eventType: "memory.fact_deleted" });
  if (tombstones.length !== 1 || (tombstones[0].envelope.payload as Record<string, unknown>).fact_id !== deleteFactId) {
    fail("delete spot-check: memory.fact_deleted tombstone missing or wrong");
  }
  const afterDelete = projector.projectAll();
  if (afterDelete.written.includes(deleteFactId) || afterDelete.unchanged.includes(deleteFactId)) {
    fail("re-projection must not resurrect deleted memory");
  }
  if (service.search(`tok-${pad(RECORDS - 1)}`).some((h) => h.id === deleteFactId)) {
    fail("deleted fact must leave the retrieval surface");
  }
  console.log("[6/6] 抽查：受控导入转版本化修订（v1→v2）+ 删除 tombstone + 重投影不复活");

  console.log(`AC-03 OK：${RECORDS} 条设计记录 写入→抽取→巩固→投影→检索→回链 全部通过；数据目录 ${dir} 已清理`);
} finally {
  store.close();
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
}
