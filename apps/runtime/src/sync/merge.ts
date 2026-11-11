import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import {
  type ConflictReason,
  DefaultConsolidator,
  normalizeForComparison,
} from "../memory/consolidator.ts";

/**
 * 事实三方合并分类（票 M3-T3 / Issue #32，PRD §4.2 FR-DEP-5 / AC-05）。
 *
 * 判定口径**直接复用 M1 巩固器**（DefaultConsolidator）：把远端修订当作候选、本地事实
 * 当作既有事实跑同一决策矩阵，因此 locked / sensitivity_change / 同主题 preference /
 * 重大事实冲突四个分支与 M1 不会漂移。版本关系先于语义分类（M3 code-review B1：
 * `min(version)-1` 的伪基线会让 fast_forward 变成死分支、把普通新版本误判冲突）：
 *
 *   identical       两侧归一化内容与敏感等级相同 → 无需动作（可补来源）
 *   stale_remote    远端版本低于本地 → 陈旧修订，忽略（不覆盖、不制造冲突）
 *   locked          本地是 locked → 永不自动采纳（即使远端版本更高）
 *   fast_forward    远端版本更高 → 直接采纳远端
 *   auto_merge      **同版本**且内容不同、巩固器判 update_fact（同主题 preference）→
 *                   自动合并；胜者按版本/更新时间/内容字典序确定性选取，两端收敛
 *   escalate        **同版本**且内容不同、巩固器判 escalate（sensitivity_change /
 *                   fact_conflict）→ 进待确认队列，绝不静默覆盖
 *
 * 版本/更新时间并列时用内容字典序做最终 tie-break：合并结果必须与「哪一端先算」无关，
 * 否则两台设备各自合并会得到不同文本，下一次同步又互相覆盖。
 */

export interface FactVersionView {
  factId: string;
  content: string;
  kind: MemoryEntryKind;
  sensitivity: SensitivityLevel;
  version: number;
  /** 事实最后更新时间（ISO 8601）；三方比较的次级 tie-break */
  updatedAt?: string;
  /** 有效期截止（ISO 8601；null/缺省 = 长期有效）。过期事实不参与冲突判定（FR-DEP-5）。 */
  validUntil?: string | null;
}

export interface FactMergeInput {
  /**
   * 共同基线。M3 code-review B1 起版本关系直接由 local/remote 的 version 判定，
   * 不再从 `min(version)-1` 伪造基线；此字段仅保留给调用方显式提供真实三方祖先
   * （缺省/未知传 null）。
   */
  base: FactVersionView | null;
  local: FactVersionView | null;
  remote: FactVersionView;
}

interface DecisionBase {
  factId: string;
  localVersion: number | null;
  remoteVersion: number;
  baseVersion: number | null;
}

export type FactMergeDecision =
  | (DecisionBase & { action: "no_local" })
  | (DecisionBase & { action: "identical"; reason: "same_content" })
  | (DecisionBase & { action: "remote_is_base"; reason: "stale_remote" })
  | (DecisionBase & {
      action: "fast_forward";
      reason: "fast_forward";
      content: string;
      sensitivity: SensitivityLevel;
      resultVersion: number;
    })
  | (DecisionBase & {
      action: "auto_merge";
      reason: "preference_update";
      content: string;
      sensitivity: SensitivityLevel;
      resultVersion: number;
    })
  | (DecisionBase & {
      action: "escalate";
      reason: ConflictReason;
      /** 远端修订（待审核队列的 incoming 侧） */
      incomingContent: string;
      incomingSensitivity: SensitivityLevel;
      existingContent: string;
      existingSensitivity: SensitivityLevel;
    });

/** 两侧都有并发修改时，按「版本 > 更新时间 > 内容字典序」确定性选胜者 */
export function deterministicWinner(
  local: FactVersionView,
  remote: FactVersionView,
): { content: string; sensitivity: SensitivityLevel } {
  const winner = compareVersions(local, remote) >= 0 ? local : remote;
  return { content: winner.content, sensitivity: winner.sensitivity };
}

function compareVersions(a: FactVersionView, b: FactVersionView): number {
  if (a.version !== b.version) return a.version - b.version;
  const at = a.updatedAt ?? "";
  const bt = b.updatedAt ?? "";
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.content !== b.content) return a.content < b.content ? -1 : 1;
  if (a.sensitivity !== b.sensitivity) return a.sensitivity < b.sensitivity ? -1 : 1;
  return 0;
}

function sameState(a: { content: string; sensitivity: SensitivityLevel }, b: { content: string; sensitivity: SensitivityLevel }): boolean {
  return normalizeForComparison(a.content) === normalizeForComparison(b.content) && a.sensitivity === b.sensitivity;
}

export function classifyFactMerge(input: FactMergeInput): FactMergeDecision {
  const { base, local, remote } = input;
  const baseDecision: DecisionBase = {
    factId: remote.factId,
    localVersion: local?.version ?? null,
    remoteVersion: remote.version,
    baseVersion: base?.version ?? null,
  };

  if (local === null) {
    return { ...baseDecision, action: "no_local" };
  }
  if (sameState(local, remote)) {
    return { ...baseDecision, action: "identical", reason: "same_content" };
  }
  // 版本关系（B1）：远端更低 → 陈旧修订，忽略；不因「本地改了、远端是旧值」制造冲突。
  if (remote.version < local.version) {
    return { ...baseDecision, action: "remote_is_base", reason: "stale_remote" };
  }
  // locked 禁止一切自动改写（GLOSSARY）：即使远端版本更高，也交由 Owner 裁决。
  if (local.sensitivity === "locked" || base?.sensitivity === "locked") {
    return escalateDecision(baseDecision, "locked", local, remote);
  }
  if (remote.version > local.version) {
    return {
      ...baseDecision,
      action: "fast_forward",
      reason: "fast_forward",
      content: remote.content,
      sensitivity: remote.sensitivity,
      resultVersion: remote.version,
    };
  }

  // 同版本且内容不同 = 并发修改：完全沿用 M1 巩固器的决策矩阵
  // （同主题 preference 自动，其余上报）。
  const [action] = new DefaultConsolidator().consolidate({
    candidates: [
      {
        candidateId: "sync-remote",
        content: remote.content,
        kind: remote.kind,
        sensitivity: remote.sensitivity,
        confidence: 1,
        sourceId: "sync",
      },
    ],
    facts: [
      {
        factId: local.factId,
        content: local.content,
        kind: local.kind,
        sensitivity: local.sensitivity,
        version: local.version,
      },
    ],
  });
  if (action === undefined) {
    return escalateDecision(baseDecision, "fact_conflict", local, remote);
  }
  if (action.action === "corroborate") {
    return { ...baseDecision, action: "identical", reason: "same_content" };
  }
  if (action.action === "update_fact") {
    const winner = deterministicWinner(local, remote);
    return {
      ...baseDecision,
      action: "auto_merge",
      reason: "preference_update",
      content: winner.content,
      sensitivity: winner.sensitivity,
      resultVersion: Math.max(local.version, remote.version) + 1,
    };
  }
  if (action.action === "escalate") {
    return escalateDecision(baseDecision, action.reason, local, remote);
  }
  // 同一 fact_id 却没有显著词元交集（巩固器会 create_fact）：身份冲突仍按重大事实上报，
  // 不静默覆盖——事实 id 由账本承载，重名不同主题留给 Owner 裁决。
  return escalateDecision(baseDecision, "fact_conflict", local, remote);
}

function escalateDecision(
  base: DecisionBase,
  reason: ConflictReason,
  local: FactVersionView,
  remote: FactVersionView,
): FactMergeDecision {
  return {
    ...base,
    action: "escalate",
    reason,
    incomingContent: remote.content,
    incomingSensitivity: remote.sensitivity,
    existingContent: local.content,
    existingSensitivity: local.sensitivity,
  };
}
