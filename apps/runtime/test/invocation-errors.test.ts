// 调用链错误码 → HTTP 映射表单测（#22 修复批 / A3）：sendInvocationError 对库层每一类
// 错误的状态码与错误信封断言（runner.ts 头部自定契约表的 HTTP 半边）。e2e 侧的逐码断言
// 见 capabilities.invoke.test.ts（容器路径桩 + 权限桩）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityError } from "../src/capabilities/engine.ts";
import { SandboxContractError } from "../src/sandbox/contract.ts";
import { UnknownToolError } from "../src/sandbox/invoker.ts";
import { PermissionDeniedError } from "../src/sandbox/permission.ts";
import { SandboxError } from "../src/sandbox/runner.ts";
import { sendInvocationError } from "../src/invocation-errors.ts";

/** 捕获 sendError 写出的最小 ServerResponse 桩（writeHead/end 记录，headersSent 语义保真） */
function captureResponse(): {
  stub: import("node:http").ServerResponse;
  statusCode(): number | undefined;
  body(): { code?: string; message?: string };
} {
  const state = {
    sent: false,
    status: undefined as number | undefined,
    body: undefined as { code?: string; message?: string } | undefined,
  };
  const stub = {
    headersSent: false,
    writeHead(status: number) {
      state.sent = true;
      state.status = status;
      return stub;
    },
    end(payload: string) {
      state.body = (JSON.parse(payload) as { error: { code: string; message: string } }).error;
      return stub;
    },
  } as unknown as import("node:http").ServerResponse;
  return {
    stub,
    statusCode: () => state.status,
    body: () => state.body ?? {},
  };
}

test("映射表：runner 契约码逐码落 HTTP 状态（503/504/500/502/400）", () => {
  const cases: Array<[SandboxError, number, string]> = [
    [new SandboxError("sandbox_unavailable", "no usable container runtime", "Install Docker Desktop"), 503, "sandbox_unavailable"],
    [new SandboxError("image_pull_failed", "failed to pull node:22-alpine: net down"), 503, "image_pull_failed"],
    [new SandboxError("tool_timeout", "tool exceeded 30000ms and was killed"), 504, "tool_timeout"],
    [new SandboxError("tool_build_failed", "esbuild bundling failed"), 500, "tool_build_failed"],
    [new SandboxError("tool_error", "tool reported failure: bad input"), 502, "tool_error"],
    [new SandboxError("tool_exit_nonzero", "tool exited with code 3"), 502, "tool_exit_nonzero"],
    [new SandboxError("tool_protocol_error", "exit 0 but stdout has no result envelope"), 502, "tool_protocol_error"],
    [new SandboxError("tool_output_too_large", "tool stdout exceeded 32MB"), 502, "tool_output_too_large"],
    [new SandboxError("tool_package_unsupported", "DockerRunner executes bundled TypeScript packages only"), 400, "tool_package_unsupported"],
  ];
  for (const [err, expectedStatus, expectedCode] of cases) {
    const res = captureResponse();
    assert.equal(sendInvocationError(res.stub, err), true, `${expectedCode} 被映射`);
    assert.equal(res.statusCode(), expectedStatus, `${expectedCode} → ${expectedStatus}`);
    assert.equal(res.body().code, expectedCode);
    assert.match(res.body().message ?? "", /./);
  }
  // install-hint 随 message 落 503 响应
  const res = captureResponse();
  sendInvocationError(res.stub, new SandboxError("sandbox_unavailable", "no usable container runtime", "Install Docker Desktop"));
  assert.match(res.body().message ?? "", /Install Docker Desktop/, "503 附 install-hint");
});

test("映射表：权限/注册/契约/未知工具错误落 HTTP（403/400/404）", () => {
  const cases: Array<[unknown, number, string]> = [
    [new UnknownToolError("ghost.capability"), 404, "unknown_tool"],
    [new PermissionDeniedError("registry not_found: capability is not registered"), 403, "permission_denied"],
    [new SandboxContractError('sandbox.network only supports "none" in v1 (fail-closed)'), 400, "invalid_sandbox_contract"],
    [new CapabilityError("escalation", "manifest permissions exceed the PermissionGrant"), 400, "capability_escalation"],
    [new CapabilityError("invalid_state", 'capability "x" is disabled'), 409, "capability_invalid_state"],
    [new CapabilityError("not_found", 'capability "x" is not registered'), 404, "capability_not_found"],
    [new CapabilityError("version_conflict", "versions are immutable"), 400, "capability_version_conflict"],
  ];
  for (const [err, expectedStatus, expectedCode] of cases) {
    const res = captureResponse();
    assert.equal(sendInvocationError(res.stub, err), true, `${expectedCode} 被映射`);
    assert.equal(res.statusCode(), expectedStatus, `${expectedCode} → ${expectedStatus}`);
    assert.equal(res.body().code, expectedCode);
  }
});

test("未识别错误不映射（返回 false，由调用方上抛 500 兜底）", () => {
  const res = captureResponse();
  assert.equal(sendInvocationError(res.stub, new Error("plain failure")), false);
  assert.equal(res.statusCode(), undefined, "未写响应");
});
