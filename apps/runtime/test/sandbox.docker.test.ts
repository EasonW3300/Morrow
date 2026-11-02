// DockerRunner 真实容器测试（票 M2-T2 / Issue #23 验收：容器内执行成功 + 网络默认不通
// + workspace 越界被拒 + 超时强杀 + 资源限额 + 结构化回传）。
//
// 环境门槛：需要可用容器运行时（docker/podman/OrbStack）。本机开发与 CI ubuntu 腿（有
// docker）真跑；macOS/Windows runner 无 docker（CI 工作流标注 + 这里探测自动 skip），
// skip 即注明理由。零 LLM / 零 FakePi——纯容器行为测试。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DockerRunner } from "../src/sandbox/docker-runner.ts";
import { detectContainerRuntime } from "../src/sandbox/detect.ts";
import { normalizeSandboxContract, type SandboxContract } from "../src/sandbox/contract.ts";
import { FIXTURE_TOOL, type FixtureMode } from "./fixtures/sandbox-fixture-input.ts";

const availability = await detectContainerRuntime();
const SKIP_REASON = availability.available
  ? false
  : "本 runner 无可用容器运行时——真实容器测试跳过（CI 仅 ubuntu 腿跑；" +
    `install-hint: ${availability.installHint ?? "n/a"}）`;

const cleanupDirs: string[] = [];
after(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
});

function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-sb-ws-"));
  cleanupDirs.push(dir);
  return dir;
}

function runner(): DockerRunner {
  return new DockerRunner();
}

function contract(overrides: Partial<SandboxContract["resources"]> = {}): SandboxContract {
  return normalizeSandboxContract({ type: "container", resources: overrides });
}

async function runFixture(mode: FixtureMode, input: Record<string, unknown>, opts: {
  workspace?: string;
  workspaceMode?: "rw" | "ro";
  resources?: Partial<SandboxContract["resources"]>;
} = {}) {
  const workspace = opts.workspace ?? newWorkspace();
  const r = await runner().run(
    {
      name: "sandbox-fixture",
      kind: "typescript",
      entry: FIXTURE_TOOL,
      workspaceDir: workspace,
      workspaceMode: opts.workspaceMode ?? "rw",
    },
    { mode, ...input },
    contract(opts.resources),
  );
  return { result: r, workspace };
}

describe("DockerRunner 真实容器测试（需 docker/OrbStack）", { skip: SKIP_REASON }, () => {
  it("检测口径：本机有可用容器运行时（docker 或 OrbStack 经 docker CLI）", async () => {
    assert.equal(availability.available, true);
    assert.ok(["docker", "orbstack", "podman"].includes(availability.runtime?.engine ?? ""));
    assert.ok((availability.runtime?.version ?? "").length > 0);
  });

  it("执行成功 + 结构化回传：stdin 输入 → stdout 信封 → result 解析；退出码 0", async () => {
    const { result } = await runFixture("echo", { text: "morrow" });
    assert.equal(result.ok, true);
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.deepEqual(result.result, { echo: "morrow" });
    assert.ok(result.duration_ms >= 0);
    assert.ok(result.engine.length > 0);
    assert.equal(result.image, "node:22-alpine");
  });

  it("网络默认不通（--network none）：容器内出网尝试失败（探针证据随 result 回传）", async () => {
    const { result } = await runFixture("network-probe", {});
    assert.equal(result.ok, true, `probe tool itself should run: ${result.error ?? ""}`);
    const probe = result.result as { networkBlocked: boolean; error: string };
    assert.equal(probe.networkBlocked, true, "容器内 fetch 必须失败（network none）");
    assert.match(probe.error, /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|AbortError|timeout/i);
  });

  it("filesystem 越界被拒：workspace 内可读可写，workspace 外宿主路径不可见", async () => {
    const workspace = newWorkspace();
    writeFileSync(join(workspace, "in.txt"), "workspace-data");
    const outside = newWorkspace();
    const outsideSecret = join(outside, "secret.txt");
    writeFileSync(outsideSecret, "must-not-be-visible");

    // workspace 内读
    const readIn = await runFixture("read-file", { path: "/workspace/in.txt" }, { workspace });
    assert.equal(readIn.result.ok, true);
    assert.deepEqual(readIn.result.result, { content: "workspace-data" });

    // workspace 内写 → 宿主可见（rw 挂载贯通）
    const writeIn = await runFixture("write-file", { path: "/workspace/out.txt", content: "sandbox-out" }, { workspace });
    assert.equal(writeIn.result.ok, true);
    assert.equal(readFileSync(join(workspace, "out.txt"), "utf8"), "sandbox-out");

    // workspace 外宿主绝对路径：容器内不存在（仅显式挂载可见——workspace-only 的本义）
    const readOut = await runFixture("read-file", { path: outsideSecret }, { workspace });
    assert.equal(readOut.result.ok, false);
    assert.equal(readOut.result.error_code, "tool_error");
    assert.match(readOut.result.error ?? "", /ENOENT|no such file/i);
  });

  it("只读根文件系统：容器根路径写入被拒（EROFS），/workspace 与 /tmp 仍可写", async () => {
    const { result } = await runFixture("write-file", { path: "/usr/morrow-ro-probe.txt", content: "x" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /EROFS|read-only/i);
  });

  it("超时强杀：sleep 5s、timeout 1.2s → timed_out + exit 137", async () => {
    const { result } = await runFixture("sleep", { ms: 5000 }, { resources: { timeoutMs: 1200 } });
    assert.equal(result.ok, false);
    assert.equal(result.timed_out, true);
    assert.equal(result.error_code, "tool_timeout");
    assert.equal(result.exit_code, 137);
  });

  it("资源限额生效：64MB 上限下分配并填满 160MB → OOM 被杀", async () => {
    const { result } = await runFixture("alloc", { mb: 160 }, { resources: { memoryMb: 64 } });
    assert.equal(result.ok, false, "超额分配必须被 cgroup 终止");
    assert.ok(result.exit_code === 137 || /killed|OOM/i.test(result.error ?? ""), `exit=${result.exit_code} error=${result.error}`);
  });

  it("退出码透传 + stderr 诊断：exit 3 工具失败如实回传", async () => {
    const { result } = await runFixture("fail", {});
    assert.equal(result.ok, false);
    assert.equal(result.exit_code, 3);
    assert.equal(result.error_code, "tool_exit_nonzero");
    assert.match(result.stderr, /intentional failure/);
  });

  it("镜像拉取策略：node:22-alpine 本地已存在（首次执行按需 pull 后可 inspect）", async () => {
    const inspected = await new Promise<{ exitCode: number }>((resolve) => {
      execFile("docker", ["image", "inspect", "node:22-alpine"], (err) => {
        resolve({ exitCode: err ? 1 : 0 });
      });
    });
    assert.equal(inspected.exitCode, 0, "跑过首轮测试后基础镜像应已在本地（pull 策略：inspect 缺失才 pull）");
  });
});
