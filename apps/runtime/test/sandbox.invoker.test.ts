// ToolInvoker（票 M2-T2 / Issue #23）：同一注册/调用接缝——sandboxed（容器）与 builtin
// （Go Worker）统一注册、统一在执行前过 PermissionEngine 运行时复核。
// 本文件不依赖真实 docker/go：runner 用 FakeRunner 桩，go builtin 用 sh 脚本桩。
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolInvoker, UnknownToolError } from "../src/sandbox/invoker.ts";
import { PermissionDeniedError, type SandboxPermissionEngine, type RuntimeUseRequest } from "../src/sandbox/permission.ts";
import { SandboxError, type SandboxResult, type SandboxRunner, type SandboxToolPackage } from "../src/sandbox/runner.ts";
import { SandboxContractError, type SandboxContract } from "../src/sandbox/contract.ts";

const WS = mkdtempSync(join(tmpdir(), "morrow-invoker-ws-"));

/** FakeRunner：记录调用并回放结果（不碰 docker） */
function fakeRunner(reply: Partial<SandboxResult> = { ok: true, result: { echo: 1 } }): SandboxRunner & { calls: Array<{ pkg: SandboxToolPackage; input: unknown; contract: SandboxContract }> } {
  const calls: Array<{ pkg: SandboxToolPackage; input: unknown; contract: SandboxContract }> = [];
  return {
    calls,
    async run(pkg, input, contract) {
      calls.push({ pkg, input, contract });
      return {
        ok: true,
        exit_code: 0,
        timed_out: false,
        stdout: "",
        stderr: "",
        duration_ms: 1,
        engine: "fake",
        image: "fake:latest",
        ...reply,
      } as SandboxResult;
    },
  };
}

function fakeEngine(intercept?: (req: RuntimeUseRequest) => void): SandboxPermissionEngine & { seen: RuntimeUseRequest[] } {
  const seen: RuntimeUseRequest[] = [];
  return {
    seen,
    async assertRuntimeUse(req) {
      seen.push(req);
      intercept?.(req);
    },
  };
}

/** builtin go 桩：可执行 sh 脚本，读 stdin 回信封（协议与 Go 工具一致） */
function fakeGoBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-fakego-"));
  const bin = join(dir, "fake-tool");
  writeFileSync(bin, '#!/bin/sh\nread -r LINE\necho \'{"ok":true,"result":{"normalized":true}}\'\n');
  chmodSync(bin, 0o755);
  return bin;
}

const SANDBOXED_MANIFEST = {
  name: "docx-to-markdown",
  version: "1.0.0",
  author: "ai" as const,
  runtime: "typescript" as const,
  permissions: { filesystem: ["workspace://input/**"] },
  sandbox: { type: "container" as const, network: "none", filesystem: "workspace-only" as const },
};

const GO_MANIFEST = {
  name: "textstats",
  version: "1.0.0",
  author: "human" as const,
  runtime: "go" as const,
  permissions: {},
  sandbox: { type: "builtin" as const },
};

describe("ToolInvoker：同一注册 + 调用接缝", () => {
  it("sandboxed 工具：契约在注册时规范化，调用时传给 runner；workspace 按权限接线", async () => {
    const runner = fakeRunner();
    const engine = fakeEngine();
    const invoker = new ToolInvoker({ runner, permissionEngine: engine, workspaceRoot: WS });
    invoker.register({
      manifest: SANDBOXED_MANIFEST,
      package: { name: "docx-to-markdown", kind: "typescript", entry: "/pkg/tool.ts" },
    });
    const out = await invoker.invoke("docx-to-markdown", { file: "a.docx" });
    assert.equal(out.ok, true);
    assert.deepEqual(out.result, { echo: 1 });
    assert.equal(out.via, "container");
    assert.equal(out.sandbox?.engine, "fake");
    const call = runner.calls[0];
    assert.equal(call.contract.network, "none");
    assert.equal(call.contract.resources.timeoutMs, 30_000);
    assert.equal(call.pkg.workspaceDir, WS);
    assert.equal(call.pkg.workspaceMode, "rw"); // 声明了 filesystem 权限 → rw
  });

  it("执行前 PermissionEngine 运行时复核：engine 被调用且拿到 manifest/contract/input", async () => {
    const runner = fakeRunner();
    const engine = fakeEngine();
    const invoker = new ToolInvoker({ runner, permissionEngine: engine, workspaceRoot: WS });
    invoker.register({ manifest: SANDBOXED_MANIFEST, package: { name: "docx-to-markdown", kind: "typescript", entry: "/pkg/t.ts" } });
    await invoker.invoke("docx-to-markdown", { file: "a.docx" }, { actorId: "owner", sessionId: "s1" });
    assert.equal(engine.seen.length, 1);
    assert.equal(engine.seen[0].manifest.name, "docx-to-markdown");
    assert.equal(engine.seen[0].contract.type, "container");
    assert.deepEqual(engine.seen[0].input, { file: "a.docx" });
    assert.equal(engine.seen[0].context?.actorId, "owner");
  });

  it("复核拒绝 → PermissionDeniedError 且 runner 未执行（先权限后执行，fail-closed）", async () => {
    const runner = fakeRunner();
    const engine = fakeEngine((req) => {
      throw new PermissionDeniedError("capability not granted to this actor");
    });
    const invoker = new ToolInvoker({ runner, permissionEngine: engine, workspaceRoot: WS });
    invoker.register({ manifest: SANDBOXED_MANIFEST, package: { name: "docx-to-markdown", kind: "typescript", entry: "/pkg/t.ts" } });
    await assert.rejects(invoker.invoke("docx-to-markdown", {}), (err: unknown) => {
      assert.ok(err instanceof PermissionDeniedError);
      assert.equal(err.code, "permission_denied");
      return true;
    });
    assert.equal(runner.calls.length, 0);
  });

  it("未知能力 → UnknownToolError（code=unknown_tool）", async () => {
    const invoker = new ToolInvoker({ runner: fakeRunner(), permissionEngine: fakeEngine(), workspaceRoot: WS });
    await assert.rejects(invoker.invoke("nope", {}), UnknownToolError);
  });

  it("注册时契约非法 → SandboxContractError（fail fast，不进注册表）", () => {
    const invoker = new ToolInvoker({ runner: fakeRunner(), permissionEngine: fakeEngine(), workspaceRoot: WS });
    assert.throws(
      () => invoker.register({
        manifest: { ...SANDBOXED_MANIFEST, sandbox: { type: "container", network: "allowlist" } },
        package: { name: "x", kind: "typescript", entry: "/pkg/t.ts" },
      }),
      SandboxContractError,
    );
  });
});

describe("ToolInvoker：进程内工具（sandbox.type=process，#22 修复批）", () => {
  const PROCESS_MANIFEST = {
    name: "memory.write",
    version: "1.0.0",
    author: "human" as const,
    runtime: "typescript" as const,
    permissions: {},
    sandbox: { type: "process" as const, network: "none", filesystem: "none" },
  };

  function processInvoker(impl: (input: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>) {
    const invoker = new ToolInvoker({ runner: fakeRunner(), permissionEngine: fakeEngine(), workspaceRoot: WS });
    invoker.register({
      manifest: PROCESS_MANIFEST,
      package: { name: "memory.write", kind: "typescript" },
      inProcess: impl,
    });
    return invoker;
  }

  it("进程内直呼：实现返回结构化结果 → ok+result+via=in-process；runner 未被触碰", async () => {
    const runner = fakeRunner();
    const invoker = new ToolInvoker({ runner, permissionEngine: fakeEngine(), workspaceRoot: WS });
    invoker.register({
      manifest: PROCESS_MANIFEST,
      package: { name: "memory.write", kind: "typescript" },
      inProcess: async (input) => ({ ok: true, result: { echoed: input } }),
    });
    const out = await invoker.invoke("memory.write", { content: "x" }, { actorId: "owner" });
    assert.equal(out.ok, true);
    assert.deepEqual(out.result, { echoed: { content: "x" } });
    assert.equal(out.via, "in-process");
    assert.equal(out.exit_code, 0);
    assert.equal(runner.calls.length, 0, "进程内工具不经容器 Runner");
  });

  it("实现自报失败 {ok:false,error} → 结构化 tool_error，不向调用方裸抛", async () => {
    const invoker = processInvoker(async () => ({ ok: false, error: "no user message in this session to attribute the memory to" }));
    const out = await invoker.invoke("memory.write", {});
    assert.equal(out.ok, false);
    assert.equal(out.error_code, "tool_error");
    assert.match(out.error ?? "", /user message/);
  });

  it("实现抛异常 → 按 tool_error 归类（执行链不因实现崩溃变 500）", async () => {
    const invoker = processInvoker(async () => {
      throw new Error("impl crashed");
    });
    const out = await invoker.invoke("memory.write", {});
    assert.equal(out.ok, false);
    assert.equal(out.error_code, "tool_error");
    assert.match(out.error ?? "", /impl crashed/);
  });

  it("注册校验：process 缺 inProcess / go runtime 进程内 → 拒绝（fail fast）", () => {
    const invoker = new ToolInvoker({ runner: fakeRunner(), permissionEngine: fakeEngine(), workspaceRoot: WS });
    assert.throws(
      () => invoker.register({ manifest: PROCESS_MANIFEST, package: { name: "memory.write", kind: "typescript" } }),
      /requires registration.inProcess/,
    );
    assert.throws(
      () =>
        invoker.register({
          manifest: { ...PROCESS_MANIFEST, runtime: "go" },
          package: { name: "x", kind: "typescript" },
          inProcess: async () => ({ ok: true }),
        }),
      /requires runtime=typescript/,
    );
  });

  it("unregister：摘除后 invoke 报 UnknownToolError（生命周期同步的原语）", async () => {
    const invoker = processInvoker(async () => ({ ok: true, result: 1 }));
    assert.equal(invoker.has("memory.write"), true);
    assert.equal(invoker.unregister("memory.write"), true);
    assert.equal(invoker.has("memory.write"), false);
    await assert.rejects(invoker.invoke("memory.write", {}), UnknownToolError);
    assert.equal(invoker.unregister("memory.write"), false, "重复摘除幂等");
  });
});

describe("ToolInvoker：拒绝路径（无容器运行时 → sandbox_unavailable + install-hint）", () => {
  function unavailableRunner(): SandboxRunner {
    // 真实 DockerRunner 的拒绝行为在 sandbox.docker-runner.test.ts 验过；这里用同错误形态的桩
    return {
      async run() {
        throw new SandboxError("sandbox_unavailable", "no usable container runtime", "Install Docker Engine (https://docs.docker.com/engine/install/)");
      },
    };
  }

  it("sandboxed 调用被拒：sandbox_unavailable + install-hint 随错误返回", async () => {
    const invoker = new ToolInvoker({ runner: unavailableRunner(), permissionEngine: fakeEngine(), workspaceRoot: WS });
    invoker.register({ manifest: SANDBOXED_MANIFEST, package: { name: "docx-to-markdown", kind: "typescript", entry: "/pkg/t.ts" } });
    await assert.rejects(invoker.invoke("docx-to-markdown", {}), (err: unknown) => {
      assert.ok(err instanceof SandboxError);
      assert.equal(err.code, "sandbox_unavailable");
      assert.match(err.installHint ?? "", /Docker Engine/);
      return true;
    });
  });

  it("builtin 不受影响：无容器运行时时 vetted Go 工具仍可调用（Runner 仅服务 sandboxed 类）", async () => {
    const invoker = new ToolInvoker({ runner: unavailableRunner(), permissionEngine: fakeEngine(), workspaceRoot: WS });
    invoker.register({ manifest: GO_MANIFEST, package: { name: "textstats", kind: "go", binPath: fakeGoBin() } });
    const out = await invoker.invoke("textstats", { text: "hello world" });
    assert.equal(out.ok, true);
    assert.equal(out.via, "builtin-go");
    assert.deepEqual(out.result, { normalized: true });
  });
});
