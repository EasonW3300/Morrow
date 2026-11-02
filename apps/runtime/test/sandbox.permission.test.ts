// LocalPermissionEngine 本地判定桩（票 M2-T2 / Issue #23 第 4 项的本地判定半边；
// M2-T1 的 Grant 五维语义合并后接管——这里锁的是确定性基线行为）。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLocalPermissionEngine, createRegistryPermissionAdapter, PermissionDeniedError, type RuntimeUseRequest } from "../src/sandbox/permission.ts";
import { CapabilityError } from "../src/capabilities/engine.ts";
import { normalizeSandboxContract } from "../src/sandbox/contract.ts";

const WS = mkdtempSync(join(tmpdir(), "morrow-perm-ws-"));
const engine = createLocalPermissionEngine({ workspaceRoot: WS });
const CONTAINER = normalizeSandboxContract({ type: "container" });
const BUILTIN = normalizeSandboxContract({ type: "builtin" });

const baseManifest = {
  name: "tool",
  version: "1.0.0",
  author: "ai" as const,
  runtime: "typescript" as const,
  sandbox: { type: "container" as const },
};

function denyTest(req: Parameters<typeof engine.assertRuntimeUse>[0]): Promise<PermissionDeniedError | null> {
  return engine.assertRuntimeUse(req).then(
    () => null,
    (err: unknown) => (err instanceof PermissionDeniedError ? err : null),
  );
}

describe("LocalPermissionEngine：确定性本地判定（fail-closed 基线）", () => {
  it("network 矛盾拒绝：manifest 声明 network 权限 + 契约 network none → 拒绝", async () => {
    const err = await denyTest({
      manifest: { ...baseManifest, permissions: { network: ["api.example.com:443"] } },
      contract: CONTAINER,
      input: {},
    });
    assert.ok(err !== null);
    assert.match(err.reason, /network:none/);
  });

  it("filesystem 越界拒绝：输入含 workspace 外绝对路径 → 执行前拒绝", async () => {
    const err = await denyTest({
      manifest: baseManifest,
      contract: CONTAINER,
      input: { file: "/etc/passwd" },
    });
    assert.ok(err !== null);
    assert.match(err.reason, /outside the workspace/);
  });

  it("workspace 内绝对路径放行；workspace:// 引用放行；相对路径/URL 放行", async () => {
    await engine.assertRuntimeUse({ manifest: baseManifest, contract: CONTAINER, input: { file: join(WS, "in.txt") } });
    await engine.assertRuntimeUse({ manifest: baseManifest, contract: CONTAINER, input: { file: "workspace://input/a.docx" } });
    await engine.assertRuntimeUse({ manifest: baseManifest, contract: CONTAINER, input: { url: "https://api.example.com/x", q: "a/b" } });
  });

  it("嵌套输入递归扫描：数组/对象深处的越界路径也拒绝", async () => {
    const err = await denyTest({
      manifest: baseManifest,
      contract: CONTAINER,
      input: { files: [{ path: "/root/.ssh/id_rsa" }] },
    });
    assert.ok(err !== null);
  });

  it("builtin（vetted go）同样过复核：越界路径一律拒绝（权限不因沙箱类型豁免）", async () => {
    const err = await denyTest({
      manifest: { ...baseManifest, author: "human", runtime: "go", sandbox: { type: "builtin" as const } },
      contract: BUILTIN,
      input: { path: "/Users/someone/secret" },
    });
    assert.ok(err !== null);
  });

  it("合规输入整体放行（void，不抛）", async () => {
    await engine.assertRuntimeUse({ manifest: baseManifest, contract: CONTAINER, input: { file: "a.docx" } });
  });
});

// merger 对齐件（#23 接缝 ↔ #22 注册表单一入口）：注册表 stub 按 m2t1
// assertRuntimeUse(name, CapabilityUseRequest) 口径回放。
function stubRegistry(reply: "ok" | "not_found" | "disabled" | "throw_raw", seen: Array<{ name: string; request: unknown }> = []) {
  return {
    assertRuntimeUse(name: string, request?: unknown): unknown {
      seen.push({ name, request });
      if (reply === "ok") return { allowed: true, name, version: "1.0.0" };
      if (reply === "not_found") throw new CapabilityError("not_found", `capability "${name}" is not registered`);
      if (reply === "disabled") throw new CapabilityError("invalid_state", `capability "${name}" is disabled (runtime use denied)`);
      throw new Error("raw non-capability error");
    },
  };
}

describe("createRegistryPermissionAdapter：merger 对齐（#23 接缝 ↔ #22 注册表单一入口）", () => {
  const goManifest = {
    name: "morrow.go.textstats",
    version: "1.0.0",
    author: "human" as const,
    runtime: "go" as const,
    sandbox: { type: "builtin" as const },
  };

  it("注册表放行 → void；workspace:// 输入派生为 workspace 下具体路径传给注册表", async () => {
    const seen: Array<{ name: string; request: unknown }> = [];
    const adapter = createRegistryPermissionAdapter({ registry: stubRegistry("ok", seen), workspaceRoot: WS });
    await adapter.assertRuntimeUse({ manifest: goManifest, contract: BUILTIN, input: { file: "workspace://input/a.docx" } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, "morrow.go.textstats");
    const request = seen[0].request as { filesystem?: string[] };
    assert.deepEqual(request.filesystem, [join(WS, "input/a.docx")]);
  });

  it("注册表 not_found / disabled（CapabilityError）→ PermissionDeniedError（本接缝统一口径）", async () => {
    const nf = createRegistryPermissionAdapter({ registry: stubRegistry("not_found"), workspaceRoot: WS });
    await assert.rejects(nf.assertRuntimeUse({ manifest: goManifest, contract: BUILTIN, input: {} }), PermissionDeniedError);
    const dis = createRegistryPermissionAdapter({ registry: stubRegistry("disabled"), workspaceRoot: WS });
    await assert.rejects(dis.assertRuntimeUse({ manifest: goManifest, contract: BUILTIN, input: {} }), (err: unknown) => {
      assert.ok(err instanceof PermissionDeniedError);
      assert.match(err.message, /invalid_state/);
      return true;
    });
  });

  it("本地基线先于注册表：workspace 越界输入在第一道即拒绝（注册表未被调用）", async () => {
    const seen: Array<{ name: string; request: unknown }> = [];
    const adapter = createRegistryPermissionAdapter({ registry: stubRegistry("ok", seen), workspaceRoot: WS });
    await assert.rejects(
      adapter.assertRuntimeUse({ manifest: goManifest, contract: BUILTIN, input: { path: "/etc/passwd" } }),
      PermissionDeniedError,
    );
    assert.equal(seen.length, 0);
  });

  it("非 CapabilityError 的注册表异常原样上抛（不吞内部错误）", async () => {
    const adapter = createRegistryPermissionAdapter({ registry: stubRegistry("throw_raw"), workspaceRoot: WS });
    await assert.rejects(
      adapter.assertRuntimeUse({ manifest: goManifest, contract: BUILTIN, input: {} }),
      (err: unknown) => err instanceof Error && err.message === "raw non-capability error",
    );
  });
});

