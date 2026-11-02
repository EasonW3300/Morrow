// SandboxRunner 接缝的纯函数部分（票 M2-T2 / Issue #23）：
// - buildDockerRunArgs：docker run 参数构建（network none / 资源限额 / read-only / 挂载）——
//   纯函数 seam，限额与隔离旗标在这里被单测锁死，真实容器测试只验运行时行为；
// - parseToolEnvelope：工具 stdout 结构化回传协议解析（PRD §5：stdout/stderr 结构化回传）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDockerRunArgs } from "../src/sandbox/docker-args.ts";
import { parseToolEnvelope } from "../src/sandbox/protocol.ts";
import { normalizeSandboxContract } from "../src/sandbox/contract.ts";

const CONTRACT = normalizeSandboxContract({
  type: "container",
  resources: { cpus: 0.5, memoryMb: 128, timeoutMs: 5000 },
});

function args(overrides: Partial<Parameters<typeof buildDockerRunArgs>[0]> = {}): string[] {
  return buildDockerRunArgs({
    containerName: "morrow-sb-test01",
    image: "node:22-alpine",
    bundleContainerPath: "/tool/bundle.js",
    packageHostDir: "/host/pkg",
    workspaceHostDir: "/host/ws",
    workspaceMode: "rw",
    contract: CONTRACT,
    ...overrides,
  });
}

describe("buildDockerRunArgs：隔离与限额旗标（manifest.sandbox 契约强制）", () => {
  it("network none 必须存在（票面：--network none 默认）", () => {
    const a = args();
    assert.equal(a[a.indexOf("--network") + 1], "none");
  });

  it("资源限额按契约落地：--cpus 0.5 / --memory 128m", () => {
    const a = args();
    assert.equal(a[a.indexOf("--cpus") + 1], "0.5");
    assert.equal(a[a.indexOf("--memory") + 1], "128m");
  });

  it("workspace-only → --read-only 根文件系统 + workspace 读写挂载 + 工具包只读挂载", () => {
    const a = args();
    assert.ok(a.includes("--read-only"));
    assert.ok(a.includes("/host/ws:/workspace:rw"));
    assert.ok(a.includes("/host/pkg:/tool:ro"));
  });

  it("workspaceMode=ro → 只读挂载（manifest 读写按声明）", () => {
    const a = args({ workspaceMode: "ro" });
    assert.ok(a.includes("/host/ws:/workspace:ro"));
    assert.ok(!a.includes("/host/ws:/workspace:rw"));
  });

  it("带容器名（超时强杀定位用）、-i（stdin 注入输入）、无 tty（结构化 stdout 不被污染）", () => {
    const a = args();
    assert.equal(a[a.indexOf("--name") + 1], "morrow-sb-test01");
    assert.ok(a.includes("-i"));
    assert.ok(!a.includes("-t"));
  });

  it("加固旗标：--tmpfs /tmp（read-only 根下可写临时区）、--pids-limit、no-new-privileges", () => {
    const a = args();
    const tmpfs = a[a.indexOf("--tmpfs") + 1];
    assert.ok(tmpfs.startsWith("/tmp:") && tmpfs.includes("rw"));
    assert.ok(a.includes("--pids-limit"));
    assert.equal(a[a.indexOf("--security-opt") + 1], "no-new-privileges");
  });

  it("入口命令：node <bundle>，工作目录 /workspace", () => {
    const a = args();
    assert.equal(a[a.indexOf("node") + 1], "/tool/bundle.js");
    assert.equal(a[a.indexOf("-w") + 1], "/workspace");
  });

  it("无 workspace（工具不需要文件系统）时不产生 workspace 挂载", () => {
    const a = args({ workspaceHostDir: undefined });
    assert.ok(!a.some((v) => typeof v === "string" && v.startsWith("/host/ws")));
  });
});

describe("parseToolEnvelope：工具 stdout 结构化回传协议", () => {
  it("单行 {ok:true,result:…} → result", () => {
    const r = parseToolEnvelope('{"ok":true,"result":{"echo":"hi"}}\n');
    assert.deepEqual(r, { kind: "result", result: { echo: "hi" } });
  });

  it("多行输出（含日志）取最后一个非空行", () => {
    const r = parseToolEnvelope("booting...\n{\"ok\":true,\"result\":1}\n");
    assert.deepEqual(r, { kind: "result", result: 1 });
  });

  it("{ok:false,error:…} → tool_error（工具自报失败）", () => {
    const r = parseToolEnvelope('{"ok":false,"error":"input invalid"}\n');
    assert.deepEqual(r, { kind: "tool_error", error: "input invalid" });
  });

  it("非 JSON 尾行 → malformed；空 stdout → empty", () => {
    assert.equal(parseToolEnvelope("plain text\n").kind, "malformed");
    assert.equal(parseToolEnvelope("").kind, "empty");
    assert.equal(parseToolEnvelope("   \n").kind, "empty");
  });

  it("ok:true 但缺 result 字段 → malformed（协议要求显式 result，禁止把 undefined 当成功）", () => {
    assert.equal(parseToolEnvelope('{"ok":true}\n').kind, "malformed");
  });
});
