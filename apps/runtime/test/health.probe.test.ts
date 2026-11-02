// 沙箱探针状态机测试（票 M2-T1 / Issue #22）：docker/podman/OrbStack 探测的
// 命令存在 → daemon 可达 → 版本三级判定，注入 which/exec 桩（零网络、不依赖本机
// 实际安装状态）。四态：ready / daemon_down / missing / not_configured。
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeSandbox, defaultWhich } from "../src/health.ts";

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function stubExec(results: Record<string, ExecResult>): (file: string, args: string[]) => Promise<ExecResult> {
  return async (file) => {
    const hit = results[file];
    if (hit === undefined) throw new Error(`unexpected exec: ${file}`);
    return hit;
  };
}

function stubWhich(found: string[]): (cmd: string) => string | null {
  return (cmd) => (found.includes(cmd) ? `/usr/local/bin/${cmd}` : null);
}

test("ready：docker 命令存在且 daemon 可达，版本取自探测命令 stdout", async () => {
  const probe = await probeSandbox({
    which: stubWhich(["docker"]),
    exec: stubExec({ "/usr/local/bin/docker": { stdout: "29.6.1\n", stderr: "", exitCode: 0 } }),
    platform: "darwin",
  });
  assert.equal(probe.status, "ready");
  assert.equal(probe.engine, "docker");
  assert.equal(probe.version, "29.6.1");
  assert.equal(probe.install_hint, null);
  assert.match(probe.detail, /docker/);
});

test("ready 回退：docker daemon 不可达 → podman 可达时报 podman ready", async () => {
  const probe = await probeSandbox({
    which: stubWhich(["docker", "podman"]),
    exec: async (file, args) => {
      if (file.endsWith("docker")) return { stdout: "", stderr: "Cannot connect to the Docker daemon", exitCode: 1 };
      if (file.endsWith("podman") && args[0] === "info") return { stdout: "5.4.0\n", stderr: "", exitCode: 0 };
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    },
    platform: "darwin",
  });
  assert.equal(probe.status, "ready");
  assert.equal(probe.engine, "podman");
  assert.equal(probe.version, "5.4.0");
});

test("daemon_down：命令存在但探测命令失败；单引擎失败给启动指引", async () => {
  const probe = await probeSandbox({
    which: stubWhich(["docker"]),
    exec: stubExec({ "/usr/local/bin/docker": { stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", exitCode: 1 } }),
    platform: "darwin",
  });
  assert.equal(probe.status, "daemon_down");
  assert.equal(probe.engine, null);
  assert.equal(probe.version, null);
  assert.match(probe.detail, /docker: daemon unreachable/);
  assert.ok(probe.install_hint !== null);
  assert.match(probe.install_hint, /Docker Desktop/);
});

test("daemon_down：多引擎失败时 detail 列出全部；exec 抛错（超时）也计入失败", async () => {
  const probe = await probeSandbox({
    which: stubWhich(["docker", "podman", "orb"]),
    exec: async () => {
      throw new Error("timed out after 3000ms");
    },
    platform: "linux",
  });
  assert.equal(probe.status, "daemon_down");
  assert.match(probe.detail, /docker: timed out/);
  assert.match(probe.detail, /podman: timed out/);
  assert.match(probe.detail, /orbstack: timed out/);
  assert.match(probe.install_hint ?? "", /daemon/);
});

test("missing：PATH 上没有任何运行时 → 三 OS 安装指引", async () => {
  const darwin = await probeSandbox({ which: () => null, platform: "darwin" });
  assert.equal(darwin.status, "missing");
  assert.match(darwin.install_hint ?? "", /OrbStack|Docker Desktop|Podman/);
  const linux = await probeSandbox({ which: () => null, platform: "linux" });
  assert.equal(linux.status, "missing");
  assert.match(linux.install_hint ?? "", /docs\.docker\.com/);
  const win32 = await probeSandbox({ which: () => null, platform: "win32" });
  assert.equal(win32.status, "missing");
  assert.match(win32.install_hint ?? "", /WSL2/);
});

test("not_configured：探测显式关闭（enabled:false）——第四态不是故障", async () => {
  const probe = await probeSandbox({
    enabled: false,
    which: stubWhich(["docker"]),
    exec: stubExec({ "/usr/local/bin/docker": { stdout: "29.6.1", stderr: "", exitCode: 0 } }),
  });
  assert.equal(probe.status, "not_configured");
  assert.equal(probe.engine, null);
  assert.equal(probe.install_hint, null);
  assert.match(probe.detail, /disabled/);
});

test("探测命令口径：docker 取 Server.Version（daemon 依赖）、podman 走 info、orb 走 version", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  await probeSandbox({
    which: stubWhich(["docker", "podman", "orb"]),
    exec: async (file, args) => {
      calls.push({ file, args });
      if (file.endsWith("docker")) return { stdout: "29.6.1", stderr: "", exitCode: 0 };
      throw new Error("unreachable");
    },
    platform: "darwin",
  });
  assert.deepEqual(calls[0], { file: "/usr/local/bin/docker", args: ["version", "--format", "{{.Server.Version}}"] });
});

test("defaultWhich：PATH 上真实存在的命令可命中（node 自身目录兜底探测）", () => {
  // node 一定在 PATH（测试进程本体）；docker 视机器而定，不做存在性断言
  const nodePath = defaultWhich("node");
  assert.ok(nodePath !== null, "node should be found on PATH");
  assert.ok(nodePath.includes("node"));
});
