// 容器运行时检测器（票 M2-T2 / Issue #23）。
// seam：detectContainerRuntime({exec, platform}) —— 探测命令经 ExecFn 桩注入，
// 三 OS 检测口径（docker/podman/OrbStack/WSL2）与 install-hint 文本用假 exec 断言；
// 真实 docker 路径在 sandbox.docker.test.ts（本机 docker 可用时）。
// 注：OrbStack/Docker Desktop 都提供 `docker` CLI——引擎归类靠 docker info 的 OperatingSystem 字段。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectContainerRuntime, INSTALL_HINT } from "../src/sandbox/detect.ts";

type ExecCall = { file: string; args: string[] };
/** 按「file + args 关键子序列」分发回放的假 exec */
function fakeExec(
  rules: Array<{ match: (call: ExecCall) => boolean; reply: { stdout?: string; stderr?: string; exitCode?: number } }>,
): { exec: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push({ file, args });
    for (const rule of rules) {
      if (rule.match({ file, args })) {
        return { stdout: rule.reply.stdout ?? "", stderr: rule.reply.stderr ?? "", exitCode: rule.reply.exitCode ?? 0 };
      }
    }
    return { stdout: "", stderr: `no fake rule for ${file}`, exitCode: 127 };
  };
  return { exec, calls };
}

const isInfo = (file: string) => (call: ExecCall) => call.file === file && call.args.includes("info");

describe("detectContainerRuntime：探测桩注入的三 OS 口径", () => {
  it("docker info 成功 → available，engine=docker，版本取自 docker version", async () => {
    const fake = fakeExec([
      { match: (c) => c.file === "docker" && c.args.includes("version"), reply: { stdout: "27.3.1\n" } },
      { match: isInfo("docker"), reply: { stdout: "Operating System: Docker Desktop\n" } },
    ]);
    const r = await detectContainerRuntime({ exec: fake.exec, platform: "linux" });
    assert.equal(r.available, true);
    assert.equal(r.installHint, null);
    assert.equal(r.runtime?.engine, "docker");
    assert.equal(r.runtime?.version, "27.3.1");
  });

  it("docker info 的 OperatingSystem 含 OrbStack → engine=orbstack（macOS 双引擎归类）", async () => {
    const fake = fakeExec([
      { match: (c) => c.file === "docker" && c.args.includes("version"), reply: { stdout: "29.4.0\n" } },
      { match: isInfo("docker"), reply: { stdout: "Operating System: OrbStack\n" } },
    ]);
    const r = await detectContainerRuntime({ exec: fake.exec, platform: "darwin" });
    assert.equal(r.available, true);
    assert.equal(r.runtime?.engine, "orbstack");
    assert.equal(r.runtime?.detail, "OrbStack");
  });

  it("docker CLI 缺失 + podman info 成功 → available，engine=podman", async () => {
    const fake = fakeExec([
      { match: isInfo("podman"), reply: { stdout: "host: linux\n" } },
      { match: (c) => c.file === "podman" && c.args.includes("version"), reply: { stdout: "5.2.0\n" } },
    ]);
    const r = await detectContainerRuntime({ exec: fake.exec, platform: "linux" });
    assert.equal(r.available, true);
    assert.equal(r.runtime?.engine, "podman");
    assert.equal(r.runtime?.command, "podman");
  });

  it("全不可用（linux）→ unavailable + Linux 安装指引（Docker Engine/podman）", async () => {
    const r = await detectContainerRuntime({ exec: async () => ({ stdout: "", stderr: "command not found", exitCode: 127 }), platform: "linux" });
    assert.equal(r.available, false);
    assert.equal(r.runtime, null);
    assert.ok(r.installHint?.includes("Docker Engine"));
    assert.ok(r.installHint === INSTALL_HINT.linux);
  });

  it("macOS 指引含 Docker Desktop 与 OrbStack 两条路", async () => {
    assert.ok((INSTALL_HINT.darwin ?? "").includes("Docker Desktop"));
    assert.ok((INSTALL_HINT.darwin ?? "").includes("OrbStack"));
  });

  it("Windows：docker 缺失但 WSL2 存在 → unavailable + WSL2 专项指引（检测到子系统但无容器引擎）", async () => {
    const fake = fakeExec([
      { match: (c) => c.file === "wsl.exe", reply: { stdout: "Default Version: 2\n" } },
    ]);
    const r = await detectContainerRuntime({ exec: fake.exec, platform: "win32" });
    assert.equal(r.available, false);
    assert.ok(r.installHint?.includes("WSL2"));
    // 确认探测序列真的探过 wsl
    assert.ok(fake.calls.some((c) => c.file === "wsl.exe"));
  });

  it("CLI 在但 daemon 不可达（info 非零）→ unavailable + 指引点名 daemon 未运行", async () => {
    const fake = fakeExec([
      { match: (c) => c.file === "docker" && c.args.includes("--version"), reply: { stdout: "Docker version 27.3.1\n" } },
      { match: isInfo("docker"), reply: { stderr: "Cannot connect to the Docker daemon", exitCode: 1 } },
    ]);
    const r = await detectContainerRuntime({ exec: fake.exec, platform: "darwin" });
    assert.equal(r.available, false);
    assert.ok(r.installHint?.includes("daemon"));
  });

  it("win32 的 docker 探测用 docker.exe（Windows CLI 名）", async () => {
    const fake = fakeExec([
      { match: (c) => c.file === "docker.exe" && c.args.includes("info"), reply: { stdout: "Operating System: Docker Desktop\n" } },
      { match: (c) => c.file === "docker.exe" && c.args.includes("version"), reply: { stdout: "27.3.1\n" } },
    ]);
    const r = await detectContainerRuntime({ exec: fake.exec, platform: "win32" });
    assert.equal(r.available, true);
    assert.equal(r.runtime?.command, "docker.exe");
  });
});
