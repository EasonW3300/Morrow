// runtime 接线测试（票 M2-T2 / Issue #23）：startRuntime 暴露 handle.sandbox（ToolInvoker），
// 注入 seam（sandboxRunner / permissionEngine）生效；health 沙箱探针仍为 M0 桩（转正是
// M2-T1 / Issue #22 的交付——本票不接 health，冲突面最小化）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxResult, SandboxRunner, SandboxToolPackage } from "../src/sandbox/runner.ts";
import type { SandboxContract } from "../src/sandbox/contract.ts";

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

test("RuntimeHandle.sandbox：同一接缝注册 sandboxed 与 builtin 工具并调用（注入 runner 生效）", async () => {
  const dir = tmpDir("morrow-sbx-wiring-");
  const runner = fakeRunner();
  const runtime = await startRuntime(testConfig(dir), { sandboxRunner: runner });
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
