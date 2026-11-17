/**
 * 会话级执行模式与确认状态（票 M7-B-T6 / Issue #70，FR-B14/B15/B16）。
 *
 * 三个不可让步的语义，全部在这个模块里可单测：
 *
 * 1. **不持久化**。模式只活在进程内存里（Map），关闭/删除/重启即失效——规格
 *    明确要求「关闭会话即失效，不持久化」。这里刻意**不**写账本作为状态源：
 *    账本里的 `exec.mode_changed` 只是审计记录，`#states` 才是权威状态，进程重启
 *    后一律回到默认（每次确认）。读取模式时若发现会话已关闭/删除也一律回到默认，
 *    即使内存 Map 里还有残值。
 *
 * 2. **默认最严**。未设置 = `confirm_each`。任何未知值、非法值都不被接受为
 *    「完全权限」——解析失败退回默认，不抛错到调用方。
 *
 * 3. **只读豁免是「首次确认之后」**。规格原文是「只读命令白名单会话内首确认后
 *    免二次确认」：第一条只读脚本仍要 Owner 点一次确认，之后同一会话内的只读
 *    脚本才免确认。豁免的只是**确认动作**，不是风险审查——`screenScript` 每次
 *    都跑（危险规则在完全权限下也拦）。
 */

import { isReadOnlyScript, screenScript, type DangerVerdict } from "./danger-rules.ts";

/** 执行模式：每次确认（默认）/ 完全权限（跳过逐次确认，但仍受静态拦截） */
export type ExecMode = "confirm_each" | "full_access";

export const DEFAULT_EXEC_MODE: ExecMode = "confirm_each";

export const EXEC_MODES: readonly ExecMode[] = ["confirm_each", "full_access"];

export function isExecMode(value: unknown): value is ExecMode {
  return value === "confirm_each" || value === "full_access";
}

/**
 * 模式解析：非法/缺失一律退回默认（不抛错）。
 *
 * 这里**不**接受"模糊真值"（`true`/`"full"`/`1`）：执行模式是可扩权的开关，
 * 宽松解析等于给客户端留一个"我以为传的是别的"的口子。
 */
export function parseExecMode(value: unknown): ExecMode {
  return isExecMode(value) ? value : DEFAULT_EXEC_MODE;
}

/** 需要确认的原因（前端据此决定提示文案） */
export type ExecConfirmReason = "readonly_first_time" | "write_command";

/** 单次执行请求的判定结果 */
export type ExecDecision =
  /** 允许执行（无需确认） */
  | { kind: "allow"; reason: "full_access" | "readonly_exempt"; mode: ExecMode }
  /**
   * 需要 Owner 确认。`script` 是**完整未截断**的脚本——规格要求"展示完整脚本"，
   * 所以这里原样返回，不做省略；前端不得截断（截断等于让 Owner 在信息不全时授权）。
   */
  | { kind: "confirm"; script: string; mode: ExecMode; why: ExecConfirmReason }
  /** 拒绝执行（危险规则命中；即使完全权限也拒绝） */
  | { kind: "deny"; verdict: DangerVerdict; mode: ExecMode };

/** 会话级状态（一项会话一条） */
interface SessionExecState {
  mode: ExecMode;
  /**
   * 这一条状态属于哪一代会话（见 isOpen 之外的 epoch）。
   *
   * 没有它就会出现漏洞：会话关闭 → 恢复后仍然是"开着"的，旧状态（完全权限、
   * 只读豁免）会被继承。带上代际号后，代际不匹配即视为无状态。
   */
  epoch: number;
  /** 只读脚本的首次确认是否已用掉（会话生命周期内仅一次） */
  readonlyConfirmed: boolean;
}

/**
 * 执行模式注册表。
 *
 * 依赖 `isOpen` 而不是直接持有 SessionManager：让"会话关闭即失效"这件事在
 * 类型上就可见——每次读写都问一次会话是否仍开着，而不是依赖调用方清理。
 *
 * `epoch` 是第二道防线：`forget` 只是显式清理，而代际号让"关闭后恢复"这种
 * 绕过路径也无法继承旧状态（见 SessionExecState.epoch）。
 */
export interface ExecModeRegistryDeps {
  /** 会话仍可执行（存在、未关闭、未删除） */
  isOpen(sessionId: string): boolean;
  /** 会话执行代际（每关闭一次 +1）；缺省视为 0（单一生命周期） */
  epoch?(sessionId: string): number;
}

export class ExecModeRegistry {
  readonly #deps: ExecModeRegistryDeps;
  readonly #states = new Map<string, SessionExecState>();

  constructor(deps: ExecModeRegistryDeps) {
    this.#deps = deps;
  }

  /**
   * 取当前代际的状态；代际不符/会话不可执行 → 清掉残值并返回 null。
   *
   * 这是唯一的读取入口：所有"这个会话现在是什么模式/有没有豁免"的判断都经过
   * 这里，避免某条路径漏查代际。
   */
  #live(sessionId: string): SessionExecState | null {
    if (!this.#deps.isOpen(sessionId)) {
      this.#states.delete(sessionId);
      return null;
    }
    const state = this.#states.get(sessionId);
    if (state === undefined) return null;
    const epoch = this.#deps.epoch?.(sessionId) ?? 0;
    if (state.epoch !== epoch) {
      this.#states.delete(sessionId);
      return null;
    }
    return state;
  }

  /** 当前模式（会话已关闭/未知/跨代 → 默认；同时清掉残值） */
  modeOf(sessionId: string): ExecMode {
    return this.#live(sessionId)?.mode ?? DEFAULT_EXEC_MODE;
  }

  /**
   * 切换模式。返回 `changed` 便于审计与幂等响应。
   *
   * 会话不可执行时返回 null（HTTP 层按 404/409 处理），**不**创建状态——否则
   * 一个已关闭会话也能被"预设"成完全权限，等它被恢复时就成了弹药库。
   */
  setMode(sessionId: string, mode: ExecMode): { mode: ExecMode; changed: boolean } | null {
    if (!this.#deps.isOpen(sessionId)) {
      // 失败路径也要清残值：否则 size 会一直挂着一条已关闭会话的状态
      this.#states.delete(sessionId);
      return null;
    }
    const epoch = this.#deps.epoch?.(sessionId) ?? 0;
    const current = this.#live(sessionId);
    if (current !== null && current.mode === mode) return { mode, changed: false };
    if (current === null) {
      this.#states.set(sessionId, { mode, epoch, readonlyConfirmed: false });
    } else {
      current.mode = mode;
    }
    return { mode, changed: true };
  }

  /** 会话结束（关闭/删除）时显式清理（幂等；代际号也会兜底清理） */
  forget(sessionId: string): void {
    this.#states.delete(sessionId);
  }

  /**
   * 判定一次执行请求。次序固定：
   *   1. 危险规则 → deny（**所有模式**下都拒绝；`confirm` 不是逃生路径）
   *   2. 完全权限 → allow
   *   3. 只读且首次确认未用 → confirm（`readonly_first_time`）
   *   4. 只读且首次确认已用 → allow（`readonly_exempt`）
   *   5. 其余 → confirm（`write_command`，带完整脚本）
   */
  decide(sessionId: string, script: string): ExecDecision {
    const mode = this.modeOf(sessionId);
    const verdict = screenScript(script);
    if (!verdict.allowed) return { kind: "deny", verdict, mode };

    if (mode === "full_access") return { kind: "allow", reason: "full_access", mode };

    if (isReadOnlyScript(script)) {
      if (this.#stateFor(sessionId, mode).readonlyConfirmed) {
        return { kind: "allow", reason: "readonly_exempt", mode };
      }
      return { kind: "confirm", script, mode, why: "readonly_first_time" };
    }

    return { kind: "confirm", script, mode, why: "write_command" };
  }

  /**
   * 记录一次 Owner 确认，返回是否**新**获得只读豁免。
   *
   * 只在被确认的脚本确实是只读时置位：确认过一条写命令不该让后面的 `ls`
   * 也顺带免确认（那是把两条语义搅在一起）。
   */
  recordConfirmation(sessionId: string, script: string): { readonlyExempted: boolean } {
    if (!this.#deps.isOpen(sessionId)) {
      this.#states.delete(sessionId);
      return { readonlyExempted: false };
    }
    if (!isReadOnlyScript(script)) return { readonlyExempted: false };
    const state = this.#stateFor(sessionId, this.modeOf(sessionId));
    const wasExempt = state.readonlyConfirmed;
    state.readonlyConfirmed = true;
    return { readonlyExempted: !wasExempt };
  }

  /** 只读首次确认是否已用掉（响应里回传给 UI，便于展示"只读已免确认"） */
  readonlyConfirmed(sessionId: string): boolean {
    return this.#live(sessionId)?.readonlyConfirmed ?? false;
  }

  #stateFor(sessionId: string, mode: ExecMode): SessionExecState {
    let state = this.#live(sessionId);
    if (state === null) {
      state = {
        mode,
        epoch: this.#deps.epoch?.(sessionId) ?? 0,
        readonlyConfirmed: false,
      };
      this.#states.set(sessionId, state);
    }
    return state;
  }

  /** 仅测试/诊断：当前驻留的会话数（证明关闭后会释放） */
  get size(): number {
    return this.#states.size;
  }
}
