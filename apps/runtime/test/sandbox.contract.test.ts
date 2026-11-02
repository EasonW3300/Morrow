// 沙箱契约（manifest.sandbox）规范化与默认值（票 M2-T2 / Issue #23）。
// seam：normalizeSandboxContract —— 输入是 PRD §6.3 manifest.sandbox 原始字段，
// 输出是 runner 使用的完整契约（network/filesystem/resources 补默认并校验）。
// 断言来源：PRD §6.3 示例 {"type":"container","network":"none","filesystem":"workspace-only"}
// 与票面「network: none 默认、filesystem: workspace-only、resources: cpu/mem/timeout」。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSandboxContract, SandboxContractError } from "../src/sandbox/contract.ts";

describe("normalizeSandboxContract：manifest.sandbox → 完整契约", () => {
  it("container + 显式字段：原样保留（PRD §6.3 示例形态）", () => {
    const c = normalizeSandboxContract({
      type: "container",
      network: "none",
      filesystem: "workspace-only",
      resources: { cpus: 0.5, memoryMb: 128, timeoutMs: 5000 },
    });
    assert.equal(c.type, "container");
    assert.equal(c.network, "none");
    assert.equal(c.filesystem, "workspace-only");
    assert.deepEqual(c.resources, { cpus: 0.5, memoryMb: 128, timeoutMs: 5000 });
  });

  it("network 缺省 → none（票面：network: none 默认）；filesystem 缺省 → workspace-only", () => {
    const c = normalizeSandboxContract({ type: "container" });
    assert.equal(c.network, "none");
    assert.equal(c.filesystem, "workspace-only");
  });

  it("resources 缺省 → cpus 1 / memoryMb 256 / timeoutMs 30000（明确默认，非隐式无限）", () => {
    const c = normalizeSandboxContract({ type: "container" });
    assert.deepEqual(c.resources, { cpus: 1, memoryMb: 256, timeoutMs: 30_000 });
  });

  it("builtin（human 签发的 vetted 工具）：不经容器，resources 只保留超时语义", () => {
    const c = normalizeSandboxContract({ type: "builtin", resources: { timeoutMs: 10_000 } });
    assert.equal(c.type, "builtin");
    assert.equal(c.network, "none");
    assert.equal(c.filesystem, "workspace-only");
    assert.equal(c.resources.timeoutMs, 10_000);
  });

  it("type 非法（缺失/未知）→ SandboxContractError invalid_sandbox_contract", () => {
    assert.throws(() => normalizeSandboxContract({}), SandboxContractError);
    assert.throws(() => normalizeSandboxContract({ type: "vm" }), SandboxContractError);
    try {
      normalizeSandboxContract({ type: "vm" });
    } catch (err) {
      assert.equal((err as SandboxContractError).code, "invalid_sandbox_contract");
    }
  });

  it("v1 只支持 network=none：其他值拒绝（fail-closed，未来加 allowlist 再放开）", () => {
    assert.throws(() => normalizeSandboxContract({ type: "container", network: "allowlist" }), SandboxContractError);
  });

  it("v1 只支持 filesystem=workspace-only：其他值拒绝", () => {
    assert.throws(() => normalizeSandboxContract({ type: "container", filesystem: "full" }), SandboxContractError);
  });

  it("resources 非法（负数/超上限/非数值）→ 拒绝", () => {
    assert.throws(() => normalizeSandboxContract({ type: "container", resources: { cpus: 0 } }), SandboxContractError);
    assert.throws(() => normalizeSandboxContract({ type: "container", resources: { cpus: 17 } }), SandboxContractError);
    assert.throws(() => normalizeSandboxContract({ type: "container", resources: { memoryMb: 8 } }), SandboxContractError);
    assert.throws(() => normalizeSandboxContract({ type: "container", resources: { timeoutMs: 0 } }), SandboxContractError);
    assert.throws(() => normalizeSandboxContract({ type: "container", resources: { cpus: "lots" } }), SandboxContractError);
  });
});
