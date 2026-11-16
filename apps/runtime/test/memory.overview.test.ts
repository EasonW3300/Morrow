// 只读记忆视图的纯逻辑（票 M7-A-T6 / Issue #62）：树分组 + 弱主题聚类 + 时间线排序分页。
// 单测锁定确定性口径——同一输入两次输出逐字节一致；聚类复用 consolidator 的
// salientTokens（不新写抽取）。HTTP 接缝的全链路覆盖在 memory.overview.api.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_KIND_ORDER,
  buildTreeGroups,
  clusterEntries,
  overviewEntryOrder,
  paginateTimeline,
  sortTimeline,
  type MemoryOverviewEntry,
} from "../src/memory/overview.ts";
import { salientTokens } from "../src/memory/consolidator.ts";

function entry(overrides: Partial<MemoryOverviewEntry> & { id: string; content: string }): MemoryOverviewEntry {
  return {
    id: overrides.id,
    content: overrides.content,
    kind: overrides.kind ?? "fact",
    sensitivity: overrides.sensitivity ?? "private",
    version: overrides.version ?? 1,
    scope: overrides.scope ?? "owner",
    occurred_at: overrides.occurred_at ?? "2026-11-12T00:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-11-12T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-11-12T00:00:00.000Z",
    revisions: overrides.revisions ?? [],
    revision_history: overrides.revision_history ?? [],
    sources: overrides.sources ?? [],
  };
}

test("树分组：按 kind 固定顺序分组，组内按 occurred_at 倒序（同刻按 id 升序）", () => {
  const entries = [
    entry({ id: "b", content: "偏好深色主题", kind: "preference", occurred_at: "2026-11-12T02:00:00.000Z" }),
    entry({ id: "a", content: "周五复盘", kind: "fact", occurred_at: "2026-11-12T01:00:00.000Z" }),
    entry({ id: "c", content: "我是工程师", kind: "profile", occurred_at: "2026-11-12T03:00:00.000Z" }),
    entry({ id: "d", content: "部署前跑测试", kind: "procedural", occurred_at: "2026-11-12T04:00:00.000Z" }),
    entry({ id: "e", content: "周末爬山", kind: "fact", occurred_at: "2026-11-12T05:00:00.000Z" }),
  ];
  const groups = buildTreeGroups(entries);
  assert.deepEqual(
    groups.map((group) => group.kind),
    [...MEMORY_KIND_ORDER],
    "固定 kind 顺序（只含非空组也保持该顺序）",
  );
  assert.deepEqual(
    groups.map((group) => group.count),
    [2, 1, 1, 1],
  );
  assert.deepEqual(
    groups[0].clusters.flatMap((cluster) => cluster.entries.map((item) => item.id)),
    ["e", "a"],
    "fact 组内 occurred_at 倒序",
  );
});

test("树分组：空 kind 不出组；无条目返回空数组", () => {
  assert.deepEqual(buildTreeGroups([]), []);
  const groups = buildTreeGroups([entry({ id: "x", content: "只有一条事实", kind: "fact" })]);
  assert.deepEqual(groups.map((group) => group.kind), ["fact"]);
});

test("弱主题聚类：共享显著词元的条目归入同一簇（复用 consolidator 的 salientTokens）", () => {
  // 两条内容共享「部署」，应聚成一簇；第三条内容无关单独成簇
  assert.ok(salientTokens("部署前先跑测试").has("部"));
  const entries = [
    entry({ id: "a", content: "部署前先跑完整测试", occurred_at: "2026-11-12T03:00:00.000Z" }),
    entry({ id: "b", content: "部署后检查回滚脚本", occurred_at: "2026-11-12T02:00:00.000Z" }),
    entry({ id: "c", content: "周末去爬山", occurred_at: "2026-11-12T01:00:00.000Z" }),
  ];
  const clusters = clusterEntries(entries);
  assert.equal(clusters.length, 2);
  assert.deepEqual(
    clusters.map((cluster) => cluster.entries.map((item) => item.id)),
    [["a", "b"], ["c"]],
  );
  // 簇标签是簇内共享的词元（取覆盖条目数最多、并列取字典序最小者）
  const theme = clusters[0].theme;
  assert.equal(typeof theme, "string");
  assert.ok(
    clusters[0].entries.every((item) => salientTokens(item.content).has(theme as string)),
    "主题标签来自簇内每个条目的显著词元交集",
  );
});

test("聚类确定性：同一输入两次结果完全一致；输入顺序不影响聚类结果", () => {
  const entries = [
    entry({ id: "a", content: "部署前先跑完整测试", occurred_at: "2026-11-12T03:00:00.000Z" }),
    entry({ id: "b", content: "部署后检查回滚脚本", occurred_at: "2026-11-12T02:00:00.000Z" }),
    entry({ id: "c", content: "周末去爬山", occurred_at: "2026-11-12T01:00:00.000Z" }),
    entry({ id: "d", content: "部署脚本加超时保护", occurred_at: "2026-11-12T00:00:00.000Z" }),
  ];
  const first = clusterEntries(entries);
  const second = clusterEntries(entries);
  assert.deepEqual(first, second, "同输入两次一致");

  // 输入顺序打乱后，buildTreeGroups 内部先按稳定次序归一，再聚类
  const shuffled = [entries[2], entries[0], entries[3], entries[1]];
  assert.deepEqual(buildTreeGroups(shuffled), buildTreeGroups(entries), "输入顺序不影响分组");
});

test("聚类：无显著词元（纯标点/空白/停用字）不强行并簇，theme 为 null", () => {
  const clusters = clusterEntries([
    entry({ id: "a", content: "……", occurred_at: "2026-11-12T02:00:00.000Z" }),
    entry({ id: "b", content: "的了吗", occurred_at: "2026-11-12T01:00:00.000Z" }),
  ]);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((cluster) => cluster.theme), [null, null]);
});

test("时间线排序：occurred_at 倒序；同刻按 id 升序（确定性 tie-break）", () => {
  const sorted = sortTimeline([
    entry({ id: "b", content: "b", occurred_at: "2026-11-12T01:00:00.000Z" }),
    entry({ id: "a", content: "a", occurred_at: "2026-11-12T03:00:00.000Z" }),
    entry({ id: "c", content: "c", occurred_at: "2026-11-12T01:00:00.000Z" }),
    entry({ id: "d", content: "d", occurred_at: "2026-11-12T02:00:00.000Z" }),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["a", "d", "b", "c"]);
});

test("时间线分页：total 是全集；limit/offset 切片不丢不重", () => {
  const all = [1, 2, 3, 4, 5].map((n) =>
    entry({ id: `e${n}`, content: `事实${n}`, occurred_at: `2026-11-12T0${n}:00:00.000Z` }),
  );
  const page1 = paginateTimeline(all, { limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.deepEqual(page1.entries.map((item) => item.id), ["e5", "e4"]);
  const page2 = paginateTimeline(all, { limit: 2, offset: 2 });
  assert.deepEqual(page2.entries.map((item) => item.id), ["e3", "e2"]);
  const page3 = paginateTimeline(all, { limit: 2, offset: 4 });
  assert.deepEqual(page3.entries.map((item) => item.id), ["e1"]);
  const past = paginateTimeline(all, { limit: 2, offset: 10 });
  assert.deepEqual(past.entries, []);
  assert.equal(past.total, 5);
});

test("overviewEntryOrder：树与时间线共用同一稳定条目序", () => {
  const entries = [
    entry({ id: "b", content: "b", occurred_at: "2026-11-12T01:00:00.000Z" }),
    entry({ id: "a", content: "a", occurred_at: "2026-11-12T02:00:00.000Z" }),
  ];
  assert.deepEqual(overviewEntryOrder(entries).map((item) => item.id), ["a", "b"]);
});
