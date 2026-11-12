import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import { salientTokens } from "./consolidator.ts";

/**
 * 只读记忆视图的纯逻辑（票 M7-A-T6 / Issue #62）：
 *
 *   tree      按 kind（fact / preference / profile / procedural）固定顺序分组，
 *             组内做**弱主题聚类**——复用 consolidator 的 `salientTokens`（不新增抽取），
 *             聚类只决定展示分组，不落库、不改变记忆本身。
 *   timeline  按 occurred_at 倒序（同刻按 id 升序）分页。
 *
 * 确定性口径（同一输入两次输出完全一致、与输入顺序无关）：
 *   1. 条目序 = occurred_at 倒序，同刻 id 升序（`overviewEntryOrder`）；
 *   2. 聚类贪心：按条目序逐条并入「显著词元交集最大」的既有簇（并列取先出现的簇），
 *      否则新建簇——簇的顺序 = 首次出现顺序；
 *   3. 簇标签 = 簇内覆盖条目数最多的显著词元；并列取首次出现位置更早者，再并列取字典序。
 *      簇内无任何显著词元（纯标点/停用字）时 theme = null。
 *
 * 本模块不触存储与账本；service 负责把存储行投影成 MemoryOverviewEntry。
 */

export const MEMORY_KIND_ORDER: readonly MemoryEntryKind[] = ["fact", "preference", "profile", "procedural"];

/** 版本链概要（展开项用；version 即版本号列表的来源） */
export interface MemoryOverviewRevision {
  version: number;
  createdAt: string;
  reason: string | null;
  /** 该修订的来源事件（可回链账本；同步合并产生且本地无对应事件时为 null） */
  sourceEventId: string | null;
}

/** 来源回链（PRD §6.4 sources；occurred_at 为账本事件时间，事件缺失时回退来源行创建时间） */
export interface MemoryOverviewSource {
  event_id: string;
  session_id: string | null;
  occurred_at: string;
}

/** 只读视图的单条记忆（长期事实；候选不进入该视图——版本链是事实的属性） */
export interface MemoryOverviewEntry {
  id: string;
  content: string;
  kind: MemoryEntryKind;
  sensitivity: SensitivityLevel;
  version: number;
  scope: string;
  occurred_at: string;
  createdAt: string;
  updatedAt: string;
  /** 版本号列表（升序；不含当前版本的初始版本也算——事实 v1 无修订时为空） */
  revisions: number[];
  revision_history: MemoryOverviewRevision[];
  sources: MemoryOverviewSource[];
}

export interface MemoryOverviewCluster {
  /** 簇主题词元（null = 无显著词元可作标签） */
  theme: string | null;
  entries: MemoryOverviewEntry[];
}

export interface MemoryOverviewGroup {
  kind: MemoryEntryKind;
  count: number;
  clusters: MemoryOverviewCluster[];
}

export interface TimelinePage {
  total: number;
  limit: number;
  offset: number;
  entries: MemoryOverviewEntry[];
}

/** 稳定条目序：occurred_at 倒序，同刻按 id 升序（树与时间线共用） */
export function overviewEntryOrder(entries: readonly MemoryOverviewEntry[]): MemoryOverviewEntry[] {
  return [...entries].sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/** 时间线排序（同 overviewEntryOrder；独立命名表达视图语义） */
export function sortTimeline(entries: readonly MemoryOverviewEntry[]): MemoryOverviewEntry[] {
  return overviewEntryOrder(entries);
}

/** 时间线分页：先排序再切片；total 为排序后的全集大小 */
export function paginateTimeline(
  entries: readonly MemoryOverviewEntry[],
  paging: { limit: number; offset: number },
): TimelinePage {
  const ordered = sortTimeline(entries);
  return {
    total: ordered.length,
    limit: paging.limit,
    offset: paging.offset,
    entries: ordered.slice(paging.offset, paging.offset + paging.limit),
  };
}

/** 树分组：固定 kind 顺序，只用非空组；组内弱主题聚类 */
export function buildTreeGroups(entries: readonly MemoryOverviewEntry[]): MemoryOverviewGroup[] {
  const ordered = overviewEntryOrder(entries);
  const groups: MemoryOverviewGroup[] = [];
  for (const kind of MEMORY_KIND_ORDER) {
    const ofKind = ordered.filter((entry) => entry.kind === kind);
    if (ofKind.length === 0) continue;
    groups.push({ kind, count: ofKind.length, clusters: clusterEntries(ofKind) });
  }
  return groups;
}

/**
 * 弱主题聚类（确定性贪心）：共享显著词元的条目归入同一簇。
 * 输入顺序不影响结果（内部先按 overviewEntryOrder 归一）。
 */
export function clusterEntries(entries: readonly MemoryOverviewEntry[]): MemoryOverviewCluster[] {
  const ordered = overviewEntryOrder(entries);
  const clusters: Array<{ entries: MemoryOverviewEntry[]; tokens: Set<string> }> = [];
  for (const entry of ordered) {
    const tokens = salientTokens(entry.content);
    let bestIndex = -1;
    let bestOverlap = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const overlap = overlapSize(tokens, clusters[i].tokens);
      if (overlap > bestOverlap) {
        bestIndex = i;
        bestOverlap = overlap;
      }
    }
    if (bestIndex >= 0) {
      clusters[bestIndex].entries.push(entry);
      for (const token of tokens) clusters[bestIndex].tokens.add(token);
    } else {
      clusters.push({ entries: [entry], tokens: new Set(tokens) });
    }
  }
  return clusters.map((cluster) => ({ theme: clusterTheme(cluster.entries), entries: cluster.entries }));
}

function overlapSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
}

/**
 * 簇标签：覆盖条目数最多的词元；并列取首次出现位置更早者，再并列取字典序。
 * 无显著词元返回 null。位置按条目序 + salientTokens 的插入序（确定性）。
 */
function clusterTheme(entries: MemoryOverviewEntry[]): string | null {
  const stats = new Map<string, { count: number; firstPosition: number }>();
  let position = 0;
  for (const entry of entries) {
    for (const token of salientTokens(entry.content)) {
      const existing = stats.get(token);
      if (existing === undefined) {
        stats.set(token, { count: 1, firstPosition: position });
      } else {
        existing.count += 1;
      }
      position += 1;
    }
  }
  let best: { token: string; count: number; firstPosition: number } | null = null;
  for (const [token, stat] of stats) {
    if (
      best === null ||
      stat.count > best.count ||
      (stat.count === best.count &&
        (stat.firstPosition < best.firstPosition ||
          (stat.firstPosition === best.firstPosition && token < best.token)))
    ) {
      best = { token, ...stat };
    }
  }
  return best === null ? null : best.token;
}
