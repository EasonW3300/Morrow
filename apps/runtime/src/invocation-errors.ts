import type { ServerResponse } from "node:http";
import { CapabilityError } from "./capabilities/engine.ts";
import { SandboxContractError } from "./sandbox/contract.ts";
import { UnknownToolError } from "./sandbox/invoker.ts";
import { PermissionDeniedError } from "./sandbox/permission.ts";
import { SandboxError } from "./sandbox/runner.ts";
import { sendError } from "./http-util.ts";

/**
 * 能力调用链的统一错误码 → HTTP 映射（#22 修复批 / A3，路由层单源）。
 *
 * 库层错误（ToolInvoker / SandboxRunner / 权限引擎）在进入 HTTP 边界时按 sandbox/
 * runner.ts 头部自定契约表落状态码——invoke 端点与 Skill invoke 共用本映射，替换
 * 修复前 skills/routes.ts 把库层错误裸抛成 500 internal_error 的口径：
 *
 *   unknown_tool              → 404（未注册/被生命周期摘除）
 *   permission_denied         → 403（运行时复核拒绝，先于任何执行）
 *   invalid_sandbox_contract  → 400（sandbox 契约非法，注册时 fail fast 同源）
 *   tool_package_unsupported  → 400（包形态不能进该沙箱）
 *   sandbox_unavailable       → 503（无可用容器运行时/daemon 卡死；message 含 install-hint）
 *   image_pull_failed         → 503（基础镜像拉取失败，网络/registry 问题）
 *   tool_timeout              → 504（按契约超时强杀）
 *   tool_build_failed         → 500（esbuild 预打包失败——runner.ts 契约表口径）
 *   tool_error / tool_exit_nonzero / tool_protocol_error / tool_output_too_large → 502
 *                             （工具自身失败：网关语义——runtime 是工具的执行网关）
 *   CapabilityError           → escalation 400（capability_escalation）、
 *                               invalid_state 409、not_found/version_not_found 404、其余 400
 *
 * 未识别错误返回 false 由调用方上抛（保持 500 internal_error 兜底口径）。
 */
export function sendInvocationError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof UnknownToolError) {
    sendError(res, 404, "unknown_tool", err.message);
    return true;
  }
  if (err instanceof PermissionDeniedError) {
    sendError(res, 403, "permission_denied", err.message);
    return true;
  }
  if (err instanceof SandboxContractError) {
    sendError(res, 400, "invalid_sandbox_contract", err.message);
    return true;
  }
  if (err instanceof SandboxError) {
    const status =
      err.code === "sandbox_unavailable" || err.code === "image_pull_failed"
        ? 503
        : err.code === "tool_timeout"
          ? 504
          : err.code === "tool_package_unsupported"
            ? 400
            : err.code === "tool_build_failed"
              ? 500
              : 502; // tool_error / tool_exit_nonzero / tool_protocol_error / tool_output_too_large
    sendError(res, status, err.code, err.message);
    return true;
  }
  if (err instanceof CapabilityError) {
    const status =
      err.code === "not_found" || err.code === "version_not_found"
        ? 404
        : err.code === "invalid_state"
          ? 409
          : 400;
    sendError(res, status, err.code === "escalation" ? "capability_escalation" : `capability_${err.code}`, err.message);
    return true;
  }
  return false;
}
