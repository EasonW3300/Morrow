/**
 * Plan 模式的只读能力判定（票 M7-C-T2 / Issue #76，FR-C1）。
 *
 * ## 为什么是白名单而不是"权限全空即只读"
 *
 * 直觉上"没声明任何权限 = 只读"，但这是错的：`memory.write` 的 manifest 权限
 * 五维全空（它写的是 Morrow 自己的记忆库，不是宿主文件系统），却是一个**写操作**。
 * 同理，将来任何"只改内部状态"的工具都会骗过这个判定。
 *
 * 所以只读必须靠**名字白名单**：默认不在名单里 = 不是只读。新增工具不会因为
 * 作者忘了声明权限就悄悄进入 Plan 模式——这是"默认拒绝"的正确方向。
 *
 * ## 白名单的口径
 *
 * 只放两类：
 *   1. **纯读工具**（读文件、列目录、搜代码、看 git 历史、检索记忆）；
 *   2. **本地只读命令执行**（`ls`/`cat`/`grep`/`git status` 一类，且脚本必须整体只读）。
 *
 * 不放进来的常见陷阱：
 *   - `memory.write`（写内部状态）；
 *   - 任何 `shell: ["arbitrary"]` 的能力（可以 `rm`）；
 *   - MCP 工具（第三方宿主任意行为，无法保证只读）；
 *   - 新注册的 AI 生成工具（未审计）。
 */

import type { CapabilityManifest } from "@morrow/protocol";

/**
 * Plan 模式下允许的能力名（精确匹配）。
 *
 * 刻意**不使用通配**（没有 `read.*` 这类前缀规则）：通配会让一个新加的
 * `read_and_delete` 意外通过。精确名单看着笨，但它是可审计的。
 */
export const PLAN_MODE_READONLY_CAPABILITIES: readonly string[] = [
  // 内置只读工具（当前批次；M7-C 之前只有 memory.write 一个 builtin，故列表以
  // 未来的只读工具名为准——现在主要由下面的「按 manifest 判定的只读 shell」承担）
  "fs.read",
  "fs.list",
  "fs.stat",
  "code.search",
  "git.read",
  "memory.search",
];

/** 允许在 Plan 模式下执行的 shell 命令类别（manifest.permissions.shell 的取值） */
export const PLAN_MODE_READONLY_SHELL_CATEGORIES: readonly string[] = [
  // 只读类别由 danger-rules.ts 的 isReadOnlyScript 在运行前二次判定；
  // 这里只放"允许被考虑"的类别，具体脚本仍要过静态只读检查。
  "readonly",
];

/**
 * 判定一个能力在 Plan 模式下是否可用。
 *
 * 三道闸（任一不满足即不可用）：
 *   1. 名字在只读白名单里，**或**它的 shell 权限只包含只读类别；
 *   2. 它没有任何写类权限（filesystem 写域 / network / channels / credentials）；
 *   3. 它的 sandbox 类型不是 `process` 之外的未知形态（保守：只认已知类型）。
 *
 * 第 2 条与第 1 条是**且**关系：白名单里的能力若声明了 network，仍然拒绝——
 * 白名单是"这个工具是只读的"，但 manifest 说的权限更权威（防白名单过期）。
 */
export function isPlanModeReadOnly(manifest: CapabilityManifest): boolean {
  // 写类权限一律拒绝（白名单也不能豁免：声明了网络就是能出网）
  const permissions = manifest.permissions;
  if (permissions.network.length > 0) return false;
  if (permissions.channels.length > 0) return false;
  if (permissions.credentials.length > 0) return false;
  if (permissions.filesystem.length > 0) return false;

  const shellWrite = permissions.shell.filter(
    (category) => !PLAN_MODE_READONLY_SHELL_CATEGORIES.includes(category),
  );
  if (shellWrite.length > 0) return false;

  // 名字白名单：精确匹配
  return PLAN_MODE_READONLY_CAPABILITIES.includes(manifest.name);
}

/** Plan 模式下的工具集过滤（保持原顺序，便于测试对照） */
export function filterPlanModeTools<T extends { manifest: CapabilityManifest }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => isPlanModeReadOnly(tool.manifest));
}

/**
 * Plan 模式进入/退出的会话状态（票 M7-C-T2）。
 *
 * **不持久化**（与执行模式同款）：重启/关闭会话回默认。只活在内存里——一个
 * "重启后还停在只读"的会话是意外，不是特性。
 */
export class PlanModeRegistry {
  readonly #deps: { isOpen(sessionId: string): boolean; epoch?(sessionId: string): number };
  readonly #entered = new Map<string, { epoch: number; phase: string }>();

  constructor(deps: { isOpen(sessionId: string): boolean; epoch?(sessionId: string): number }) {
    this.#deps = deps;
  }

  /**
   * 是否处于 Plan 模式。
   *
   * 代际号与执行模式同款：会话关闭→恢复后是新的一代，不继承关闭前的只读状态
   * （否则"我关掉了计划模式"会变成"它偷偷还在只读"）。
   */
  isActive(sessionId: string): boolean {
    if (!this.#deps.isOpen(sessionId)) {
      this.#entered.delete(sessionId);
      return false;
    }
    const entry = this.#entered.get(sessionId);
    if (entry === undefined) return false;
    const epoch = this.#deps.epoch?.(sessionId) ?? 0;
    if (entry.epoch !== epoch) {
      this.#entered.delete(sessionId);
      return false;
    }
    return true;
  }

  /** 当前阶段（未进入 → null） */
  phaseOf(sessionId: string): string | null {
    return this.isActive(sessionId) ? (this.#entered.get(sessionId)?.phase ?? null) : null;
  }

  /** 进入 Plan（幂等：已进入返回 changed=false） */
  enter(sessionId: string, phase = "explore"): { active: boolean; changed: boolean } {
    if (!this.#deps.isOpen(sessionId)) {
      this.#entered.delete(sessionId);
      return { active: false, changed: false };
    }
    if (this.isActive(sessionId)) return { active: true, changed: false };
    this.#entered.set(sessionId, { epoch: this.#deps.epoch?.(sessionId) ?? 0, phase });
    return { active: true, changed: true };
  }

  /** 退出 Plan（幂等） */
  exit(sessionId: string): { active: boolean; changed: boolean } {
    const wasActive = this.isActive(sessionId);
    this.#entered.delete(sessionId);
    return { active: false, changed: wasActive };
  }

  /** 切换阶段（未进入 → null，不隐式进入） */
  setPhase(sessionId: string, phase: string): { phase: string; changed: boolean } | null {
    if (!this.isActive(sessionId)) return null;
    const entry = this.#entered.get(sessionId);
    if (entry === undefined) return null;
    const changed = entry.phase !== phase;
    entry.phase = phase;
    return { phase, changed };
  }

  forget(sessionId: string): void {
    this.#entered.delete(sessionId);
  }

  get size(): number {
    return this.#entered.size;
  }
}
