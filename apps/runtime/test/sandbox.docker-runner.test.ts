// DockerRunner 行为测试（fake exec 注入——不依赖本机 docker；真实容器路径见 sandbox.docker.test.ts）。
// seam：DockerRunner.run() 的 SandboxResult 形状与错误分类；探测桩注入走 detect seam。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRunner, SandboxError } from "../src/sandbox/docker-runner.ts";
import { normalizeSandboxContract } from "../src/sandbox/contract.ts";

const CONTRACT = normalizeSandboxContract({ type: "container", resources: { timeoutMs: 5000 } });

/** 制造一个最小 TS 工具包（esbuild 入口存在即可，fake exec 下不真编译） */
function makeToolPackage(dir: string): { entry: string; dir: string } {
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "tool.ts");
  writeFileSync(entry, 'const input = await readStdinJson();\nprocess.stdout.write(JSON.stringify({ ok: true, result: input }));\n');
  return { entry, dir };
}

type Rule = { match: (file: string, args: string[]) => boolean; reply: { stdout?: string; stderr?: string; exitCode?: number } };

function fakeDockerExec(rules: Rule[]) {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const exec = async (file: string, args: string[], options?: { input?: string }) => {
    calls.push({ file, args, ...(options?.input !== undefined ? { input: options.input } : {}) });
    for (const rule of rules) {
      if (rule.match(file, args)) {
        return { stdout: rule.reply.stdout ?? "", stderr: rule.reply.stderr ?? "", exitCode: rule.reply.exitCode ?? 0 };
      }
    }
    return { stdout: "", stderr: `unexpected docker call: ${args.join(" ")}`, exitCode: 127 };
  };
  return { exec, calls };
}

function defaultRules(runReply: { stdout: string; exitCode?: number; stderr?: string }): Rule[] {
  return [
    { match: (_f, a) => a.includes("info"), reply: { stdout: "Operating System: Docker Desktop\n" } },
    { match: (_f, a) => a.includes("version") && a.includes("--format"), reply: { stdout: "27.3.1\n" } },
    { match: (_f, a) => a.includes("inspect"), reply: { stdout: "[]\n" } }, // image 已存在
    { match: (_f, a) => a.includes("run"), reply: runReply },
  ];
}

const baseOpts = (exec: unknown) => ({ exec: exec as never, bundleDirRoot: mkdtempSync(join(tmpdir(), "morrow-sb-test-")) });

describe("DockerRunner（fake exec）：执行与结果分类", () => {
  it("成功路径：结构化回传解析为 result；输入经 stdin 注入；image 已存在则不 pull", async () => {
    const fake = fakeDockerExec(defaultRules({ stdout: '{"ok":true,"result":{"echo":"hi"}}\n' }));
    const pkg = makeToolPackage(join(mkdtempSync(join(tmpdir(), "morrow-pkg-")), "src"));
    const runner = new DockerRunner(baseOpts(fake.exec));
    const r = await runner.run({ name: "echo", kind: "typescript", entry: pkg.entry }, { echo: "hi" }, CONTRACT);
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { echo: "hi" });
    assert.equal(r.exit_code, 0);
    assert.equal(r.timed_out, false);
    assert.equal(r.engine, "docker");
    assert.equal(r.image, "node:22-alpine");
    assert.equal(r.pulled, undefined);
    const run = fake.calls.find((c) => c.args.includes("run"));
    assert.ok(run);
    assert.equal(run.input, JSON.stringify({ echo: "hi" }));
  });

  it("首次执行镜像缺失 → 自动 pull 并在结果记录 pulled=true", async () => {
    const fake = fakeDockerExec([
      ...defaultRules({ stdout: '{"ok":true,"result":null}\n' }).filter((r) => !r.match("", ["inspect"])),
      { match: (_f, a) => a.includes("inspect"), reply: { exitCode: 1 } }, // 镜像缺失
      { match: (_f, a) => a.includes("pull"), reply: { stdout: "Pull complete\n" } },
      { match: (_f, a) => a.includes("inspect") && a.length > 3, reply: { stdout: "[]\n" } },
    ]);
    const pkg = makeToolPackage(join(mkdtempSync(join(tmpdir(), "morrow-pkg-")), "src"));
    const runner = new DockerRunner(baseOpts(fake.exec));
    const r = await runner.run({ name: "echo", kind: "typescript", entry: pkg.entry }, {}, CONTRACT);
    assert.equal(r.ok, true);
    assert.equal(r.pulled, true);
    assert.ok(fake.calls.some((c) => c.args.includes("pull")));
  });

  it("工具自报失败 {ok:false,error} → ok=false + error_code=tool_error", async () => {
    const fake = fakeDockerExec(defaultRules({ stdout: '{"ok":false,"error":"bad input"}\n' }));
    const pkg = makeToolPackage(join(mkdtempSync(join(tmpdir(), "morrow-pkg-")), "src"));
    const r = await new DockerRunner(baseOpts(fake.exec)).run({ name: "x", kind: "typescript", entry: pkg.entry }, {}, CONTRACT);
    assert.equal(r.ok, false);
    assert.equal(r.error_code, "tool_error");
    assert.match(r.error ?? "", /bad input/);
  });

  it("非零退出码 → ok=false + error_code=tool_exit_nonzero（stderr 诊断随行）", async () => {
    const fake = fakeDockerExec(defaultRules({ stdout: "crash before envelope\n", stderr: "SyntaxError: boom\n", exitCode: 3 }));
    const pkg = makeToolPackage(join(mkdtempSync(join(tmpdir(), "morrow-pkg-")), "src"));
    const r = await new DockerRunner(baseOpts(fake.exec)).run({ name: "x", kind: "typescript", entry: pkg.entry }, {}, CONTRACT);
    assert.equal(r.ok, false);
    assert.equal(r.exit_code, 3);
    assert.equal(r.error_code, "tool_exit_nonzero");
    assert.match(r.stderr, /boom/);
  });

  it("退出码 0 但 stdout 无信封 → error_code=tool_protocol_error（协议违规显性化）", async () => {
    const fake = fakeDockerExec(defaultRules({ stdout: "just logs, no envelope\n" }));
    const pkg = makeToolPackage(join(mkdtempSync(join(tmpdir(), "morrow-pkg-")), "src"));
    const r = await new DockerRunner(baseOpts(fake.exec)).run({ name: "x", kind: "typescript", entry: pkg.entry }, {}, CONTRACT);
    assert.equal(r.ok, false);
    assert.equal(r.error_code, "tool_protocol_error");
  });

  it("探测桩报告无容器运行时 → 抛 SandboxError code=sandbox_unavailable 且带 install-hint", async () => {
    const fake = fakeDockerExec([]);
    const runner = new DockerRunner({
      ...baseOpts(fake.exec),
      detect: async () => ({ available: false, runtime: null, installHint: "Install Docker Desktop" }),
    });
    await assert.rejects(
      runner.run({ name: "x", kind: "typescript", entry: "whatever.ts" }, {}, CONTRACT),
      (err: unknown) => {
        assert.ok(err instanceof SandboxError);
        assert.equal(err.code, "sandbox_unavailable");
        assert.match(err.message, /Install Docker Desktop/);
        assert.equal(err.installHint, "Install Docker Desktop");
        return true;
      },
    );
  });

  it("go 包进容器 → 拒绝（tool_package_unsupported：Go 走 builtin 直跑，不进 node 容器）", async () => {
    const fake = fakeDockerExec(defaultRules({ stdout: '{"ok":true,"result":1}\n' }));
    await assert.rejects(
      new DockerRunner(baseOpts(fake.exec)).run({ name: "go-tool", kind: "go", binPath: "/x/tool" }, {}, CONTRACT),
      (err: unknown) => {
        assert.ok(err instanceof SandboxError);
        assert.equal(err.code, "tool_package_unsupported");
        return true;
      },
    );
  });
});

describe("DockerRunner：有界辅助调用（#23 修复批——daemon 卡死不挂死调用方）", () => {
  function hangingExecHarness(hangArgs: (args: string[]) => boolean) {
    const exec = async (file: string, args: string[], options?: { input?: string }) => {
      if (hangArgs(args)) {
        await new Promise(() => {}); // 永不 resolve：模拟 daemon 卡死
      }
      if (args.includes("info")) return { stdout: "Operating System: Docker Desktop\n", stderr: "", exitCode: 0 };
      if (args.includes("--format")) return { stdout: "27.3.1\n", stderr: "", exitCode: 0 };
      if (args.includes("inspect")) return { stdout: "", stderr: "image missing", exitCode: 1 };
      if (args.includes("run")) return { stdout: '{"ok":true,"result":1}\n', stderr: "", exitCode: 0 };
      return { stdout: "", stderr: `unexpected: ${args.join(" ")}`, exitCode: 127 };
    };
    return { exec };
  }

  it("image inspect 挂起 → 有界内抛 sandbox_unavailable（daemon wedged 语义 + 修复指引）", async () => {
    const { exec } = hangingExecHarness((args) => args.includes("inspect"));
    const started = Date.now();
    await assert.rejects(
      new DockerRunner({ exec: exec as never, auxTimeoutMs: 50, bundleDirRoot: mkdtempSync(join(tmpdir(), "morrow-sb-test-")) }).run(
        { name: "x", kind: "typescript", entry: makeToolPackage(join(mkdtempSync(join(tmpdir(), "morrow-pkg-")), "src")).entry },
        {},
        CONTRACT,
      ),
      (err: unknown) => {
        assert.ok(err instanceof SandboxError);
        assert.equal(err.code, "sandbox_unavailable");
        assert.match(err.message, /wedged|docker info/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5_000, "有界返回而非无限等待");
  });

  it("image pull 挂起 → 有界内抛 image_pull_failed（503 族，非无限等待）", async () => {
    const { exec } = hangingExecHarness((args) => args.includes("pull"));
    const started = Date.now();
    await assert.rejects(
      new DockerRunner({ exec: exec as never, auxTimeoutMs: 50, pullTimeoutMs: 50, bundleDirRoot: mkdtempSync(join(tmpdir(), "morrow-sb-test-")) }).run(
        { name: "x", kind: "typescript", entry: makeToolPackage(join(mkdtempSync(join(tmpdir(), "morrow-pkg-")), "src")).entry },
        {},
        CONTRACT,
      ),
      (err: unknown) => {
        assert.ok(err instanceof SandboxError);
        assert.equal(err.code, "image_pull_failed");
        assert.match(err.message, /did not respond within/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5_000, "有界返回而非无限等待");
  });
});
