// runtime 接线测试（票 M2-T2 / Issue #23）：startRuntime 暴露 handle.sandbox（ToolInvoker），
// 注入 seam（sandboxRunner / permissionEngine）生效；默认权限引擎 = M2-T1 注册表复核
// 适配器（createRegistryPermissionAdapter：本地基线 + capabilities.assertRuntimeUse 双道，
// 本文件第二组用例对齐验证）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionDeniedError } from "../src/sandbox/permission.ts";
import type { SandboxResult, SandboxRunner, SandboxToolPackage } from "../src/sandbox/runner.ts";
import type { SandboxContract } from "../src/sandbox/contract.ts";
import type { SandboxPermissionEngine, RuntimeUseRequest } from "../src/sandbox/permission.ts";

function testConfig(dir: string): RuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    replicaId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    provider: null,
  };
}

/** FakeRunner：记录调用，回放成功结果（不碰 docker） */
function fakeRunner(): SandboxRunner & { calls: Array<{ pkg: SandboxToolPackage; input: unknown; contract: SandboxContract }> } {
  const calls: Array<{ pkg: SandboxToolPackage; input: unknown; contract: SandboxContract }> = [];
  return {
    calls,
    async run(pkg, input, contract) {
      calls.push({ pkg, input, contract });
      return { ok: true, exit_code: 0, timed_out: false, stdout: "", stderr: "", result: { via: "fake" }, duration_ms: 1, engine: "fake", image: "fake" };
    },
  };
}

function fakeGoBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-wiring-go-"));
  const bin = join(dir, "fake-tool");
  writeFileSync(bin, '#!/bin/sh\nread -r LINE\necho \'{"ok":true,"result":{"builtin":true}}\'\n');
  chmodSync(bin, 0o755);
  return bin;
}

function permissiveEngine(): SandboxPermissionEngine {
  return { async assertRuntimeUse(_req: RuntimeUseRequest): Promise<void> {} };
}

test("RuntimeHandle.sandbox：同一接缝注册 sandboxed 与 builtin 工具并调用（注入 runner + engine 生效）", async () => {
  const dir = tmpDir("morrow-sbx-wiring-");
  const runner = fakeRunner();
  const runtime = await startRuntime(testConfig(dir), { sandboxRunner: runner, permissionEngine: permissiveEngine() });
  try {
    assert.ok(typeof runtime.sandbox.invoke === "function", "handle.sandbox 应为 ToolInvoker");

    runtime.sandbox.register({
      manifest: {
        name: "docx-to-markdown",
        version: "1.0.0",
        author: "ai",
        runtime: "typescript",
        permissions: { filesystem: ["workspace://input/**"] },
        sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
      },
      package: { name: "docx-to-markdown", kind: "typescript", entry: "/pkg/tool.ts" },
    });
    runtime.sandbox.register({
      manifest: { name: "textstats", version: "1.0.0", author: "human", runtime: "go", permissions: {}, sandbox: { type: "builtin" } },
      package: { name: "textstats", kind: "go", binPath: fakeGoBin() },
    });

    const sandboxed = await runtime.sandbox.invoke("docx-to-markdown", { file: "workspace://a.docx" }, { actorId: "owner" });
    assert.equal(sandboxed.via, "container");
    assert.deepEqual(sandboxed.result, { via: "fake" });
    // workspace 接线到 dataDir/workspace（RuntimeConfig 派生，非测试自选）
    assert.equal(runner.calls[0]?.pkg.workspaceDir, join(dir, "workspace"));

    const builtin = await runtime.sandbox.invoke("textstats", { text: "x" });
    assert.equal(builtin.via, "builtin-go");
    assert.deepEqual(builtin.result, { builtin: true });
    assert.equal(runner.calls.length, 1, "builtin 不经 Runner");

    await assert.rejects(runtime.sandbox.invoke("nope", {}), (err: unknown) => {
      assert.equal((err as { code?: string }).code, "unknown_tool");
      return true;
    });
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// merger 对齐验证（#23 ↔ #22）：默认权限引擎 = createRegistryPermissionAdapter，
// 双道复核——第一道本地基线，第二道 M2-T1 注册表（存在/enabled/五维）。
test("默认权限引擎走 M2-T1 注册表：注册（human→enabled）后放行，未注册/停用拒绝", async () => {
  const dir = tmpDir("morrow-sbx-registry-");
  const runtime = await startRuntime(testConfig(dir), { sandboxRunner: fakeRunner() });
  try {
    const bin = fakeGoBin();
    // 注册表视图（M2-T1 CapabilityManifest；human → enabled；空权限 ⊆ 空 grant）
    runtime.capabilities.register({
      name: "morrow.go.textstats",
      version: "1.0.0",
      author: "human",
      runtime: "go",
      permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: { type: "process", network: "none", filesystem: "none" },
      tests: ["positive.yaml"],
    });
    // 调用接缝视图（M2-T2 ToolInvoker manifest）
    runtime.sandbox.register({
      manifest: { name: "morrow.go.textstats", version: "1.0.0", author: "human", runtime: "go", permissions: {}, sandbox: { type: "builtin" } },
      package: { name: "morrow.go.textstats", kind: "go", binPath: bin },
    });

    const out = await runtime.sandbox.invoke("morrow.go.textstats", { text: "hello" }, { actorId: "owner" });
    assert.equal(out.ok, true);
    assert.equal(out.via, "builtin-go");

    // 未注册 → 注册表 not_found → PermissionDeniedError（先于任何执行机制）
    runtime.sandbox.register({
      manifest: { name: "ghost.tool", version: "1.0.0", author: "human", runtime: "go", permissions: {}, sandbox: { type: "builtin" } },
      package: { name: "ghost.tool", kind: "go", binPath: bin },
    });
    await assert.rejects(runtime.sandbox.invoke("ghost.tool", {}), (err: unknown) => {
      assert.ok(err instanceof PermissionDeniedError);
      assert.match(err.message, /not_found/);
      return true;
    });
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
