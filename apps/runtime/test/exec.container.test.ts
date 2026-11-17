// 动态 bash 真实容器测试（票 M7-B-T6 / Issue #70，FR-B13 的"隔离不是口号"）。
//
// 这是唯一能证明"脚本真的在容器里、真的没网、真的会被杀"的一层。假 Runner 提供
// 不了这个证据，所以哪怕要 docker 也必须留着——但探索发现不满足条件时诚实 skip
// 并写明理由（与 M2 的 sandbox.docker.test.ts 同款口径）。
//
// 覆盖：容器内执行成功 / `--network none` 联网失败 / 超时被杀 / 输出超限截断 /
// workspace 挂载可写 / 宿主环境变量与 ~/.ssh 不可见（隔离的正面证据）。
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { detectContainerRuntime } from "../src/sandbox/detect.ts";
import { ContainerExecRunner, type ExecRequest } from "../src/exec/runner.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const availability = await detectContainerRuntime({ timeoutMs: 10_000 });
const SKIP_REASON: string | false = availability.available
  ? false
  : availability.probeTimedOut === true
    ? "容器运行时探测超时（docker CLI 挂起，10s 无响应）——真实容器测试诚实跳过而非挂死"
    : "本 runner 无可用容器运行时——真实容器测试跳过（CI 仅 ubuntu 腿跑；" +
      `install-hint: ${availability.installHint ?? "n/a"}）`;

const cleanupDirs: string[] = [];
after(() => {
  for (const dir of cleanupDirs) removeDir(dir);
});

const runner = new ContainerExecRunner();

/** 每次用一个全新工作区（隔离测试之间） */
function workspace(): string {
  const dir = tmpDir("morrow-exec-ws-");
  cleanupDirs.push(dir);
  return dir;
}

function request(overrides: Partial<ExecRequest> & { script: string }): ExecRequest {
  return {
    sessionId: "01936b9d-8f7a-7abc-9f2e-000000000001",
    timeoutMs: 60_000,
    maxOutputBytes: 1024 * 1024,
    ...overrides,
  };
}

describe("ContainerExecRunner（真实容器）", { skip: SKIP_REASON }, () => {
  let dir: string;
  beforeEach(() => {
    dir = workspace();
  });

  it("在容器内执行成功（engine 证据 + 退出码 0）", async () => {
    const result = await runner.run(request({ script: "echo hello-from-container && pwd", workspaceDir: dir }));
    assert.equal(result.ok, true, `stderr: ${result.stderr}`);
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /hello-from-container/);
    assert.equal(result.engine.length > 0, true, "必须给出引擎证据");
    assert.equal(result.container.startsWith("morrow-exec-"), true);
  });

  it("联网被阻断（--network none 的正面证据）", async () => {
    // alpine 的 wget 在没有 DNS/网络时失败；断言"失败"而不是"成功"才是隔离证据
    const result = await runner.run(
      request({
        script: "wget -q -T 3 -O /dev/null http://1.1.1.1/ || echo NETWORK-BLOCKED",
        workspaceDir: dir,
      }),
    );
    assert.match(result.stdout, /NETWORK-BLOCKED/, "容器必须无法出网");
  });

  it("超时被杀（timed_out=true，不是等满全窗口）", async () => {
    const started = Date.now();
    const result = await runner.run(request({ script: "sleep 30", timeoutMs: 1_500, workspaceDir: dir }));
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.equal(result.ok, false);
    // 强杀要真的生效：给 docker kill + 宽限留足余量，但不能接近 sleep 的 30s
    assert.ok(elapsed < 20_000, `超时强杀应在数秒内生效，实际 ${elapsed}ms`);
  });

  it("输出超限被截断并标记", async () => {
    const result = await runner.run(
      request({
        script: "yes morrow | head -c 200000",
        workspaceDir: dir,
        maxOutputBytes: 1_024,
      }),
    );
    assert.equal(result.truncated, true, "超过上限必须标记截断");
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 1_024);
  });

  it("workspace 挂载可写：容器内的文件写回宿主工作区", async () => {
    const result = await runner.run(request({ script: "echo written > out.txt", workspaceDir: dir }));
    assert.equal(result.ok, true, `stderr: ${result.stderr}`);
    assert.equal(readFileSync(join(dir, "out.txt"), "utf8").trim(), "written");
  });

  it("宿主环境不可见（容器是新环境，不带宿主 env）", async () => {
    const result = await runner.run(
      request({ script: "env | grep -c MORROW_SECRET_MARKER || true", workspaceDir: dir }),
    );
    assert.equal(result.stdout.trim(), "0", "宿主环境变量不该漏进容器");
  });

  it("~/.ssh 在容器内不存在（隔离的正面证据：凭据面不可达）", async () => {
    const result = await runner.run(
      request({ script: "test -e ~/.ssh && echo PRESENT || echo ABSENT", workspaceDir: dir }),
    );
    assert.match(result.stdout, /ABSENT/, "容器内不该有宿主的 ~/.ssh");
  });

  it("容器根文件系统只读（脚本不能改镜像内容）", async () => {
    const result = await runner.run(
      request({ script: "echo x > /etc/motd 2>/dev/null && echo WROTE || echo READONLY", workspaceDir: dir }),
    );
    assert.match(result.stdout, /READONLY/, "根文件系统必须只读");
  });

  it("/tmp 可写（脚本需要临时空间时的合法出口）", async () => {
    const result = await runner.run(
      request({ script: "echo x > /tmp/t.txt && cat /tmp/t.txt", workspaceDir: dir }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.stdout.trim(), "x");
  });

  it("非零退出码如实回传（不掩盖失败）", async () => {
    const result = await runner.run(request({ script: "exit 7", workspaceDir: dir }));
    assert.equal(result.ok, false);
    assert.equal(result.exit_code, 7);
    assert.equal(result.error_code, "exec_failed");
  });

  it("无工作区时在 /tmp 里跑（不隐式挂载宿主目录）", async () => {
    const result = await runner.run(request({ script: "pwd" }));
    assert.equal(result.ok, true);
    assert.equal(result.stdout.trim(), "/tmp");
  });

  it("子目录工作区也能正常挂载（会话 worktree 的常见形态）", async () => {
    const nested = join(dir, "nested", "project");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "a.txt"), "x");
    const result = await runner.run(request({ script: "cat a.txt", workspaceDir: nested }));
    assert.equal(result.ok, true, `stderr: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "x");
  });
});
