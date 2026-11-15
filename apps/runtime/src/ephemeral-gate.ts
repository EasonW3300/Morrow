/**
 * 临时会话写入门（票 M7-A-T3 / ADR-0010，FR-A10「禁用写入类能力并限制任务创建」）。
 *
 * 规格要求这条限制是**单一入口**：能力网关（`POST /v1/capabilities/:id/invoke`）、
 * Skill 重用调用（`POST /v1/capabilities/skills/:id/invoke`，逐步能力）与任务创建
 * （`POST /v1/tasks`）都调本模块，而不是各自实现一份判定。历史缺陷：403 只挂在
 * 能力 invoke 一个端点上，skill invoke 与任务创建可以绕过去。
 *
 * 判定口径：
 *   - 只有 `kind=ephemeral` 的会话受门禁；普通会话 / 未知会话 / 无会话上下文一律放行
 *     （无会话上下文的调用不属临时会话，语义由执行链自身裁决）。
 *   - 写入类能力 = manifest 任一权限维非空（见 `isEphemeralWriteClassCapability`），
 *     判定与错误构造留在 PermissionEngine（`assertEphemeralUse`），本模块只做路由。
 */

import type { PermissionEngine } from "./capabilities/engine.ts";
import type { SessionKind } from "./sessions.ts";

/** 门禁依赖的最小面（结构注入，便于测试与宿主替换） */
export interface EphemeralGateDeps {
  sessionKind(sessionId: string): SessionKind | null;
  capabilities: Pick<PermissionEngine, "assertEphemeralUse">;
}

/**
 * 能力调用门禁：临时会话里拒绝写入类能力。
 * `capabilityNames` 为本次调用会触达的能力（skill 是全部 step 的 capability_id）。
 * 抛 `CapabilityError("forbidden")`（HTTP 403 `capability_forbidden`）。
 */
export function assertEphemeralCapabilityUse(
  deps: EphemeralGateDeps,
  sessionId: string | undefined,
  capabilityNames: readonly string[],
): void {
  if (sessionId === undefined || deps.sessionKind(sessionId) !== "ephemeral") return;
  for (const name of capabilityNames) deps.capabilities.assertEphemeralUse(name);
}

/** 会话是否处于临时会话（缺省/未知 → false） */
export function isEphemeralSession(deps: Pick<EphemeralGateDeps, "sessionKind">, sessionId: string | undefined): boolean {
  return sessionId !== undefined && deps.sessionKind(sessionId) === "ephemeral";
}

/** 任务创建门禁的错误码（HTTP 403）：与能力门的 capability_forbidden 分开，便于 UI 呈现。 */
export const EPHEMERAL_TASK_FORBIDDEN_CODE = "ephemeral_task_forbidden";

/**
 * 任务创建门禁（FR-A10 的「并限制任务创建」）：临时会话不能创建任务。
 * 返回 null = 放行；否则返回可直接写进错误信封的说明。
 */
export function ephemeralTaskCreationDenial(
  deps: Pick<EphemeralGateDeps, "sessionKind">,
  sessionId: string | undefined,
): string | null {
  if (!isEphemeralSession(deps, sessionId)) return null;
  return `session ${sessionId} is an ephemeral session; task creation is disabled in ephemeral sessions (promote it to a normal session first)`;
}
