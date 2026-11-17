// 容器执行参数与输出截断测试（票 M7-B-T6 / Issue #70，FR-B13）。
//
// 这一层锁死"隔离不是口号"：`--network none`、只读根、workspace 挂载模式、
// 超时强杀路径。参数是全链路上唯一能证明"脚本真的进了容器"的地方——如果用
// 假 Runner 测端到端，恰恰永远测不到这一点。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExecDockerArgs,
  DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  DEFAULT_EXEC_IMAGE,
  truncateOutput,
} from "../src/exec/runner.ts";

const baseSpec = {
  containerName: "morrow-exec-abc123",
  image: DEFAULT_EXEC_IMAGE,
  script: "echo hi",
  workspaceMode: "rw" as const,
  timeoutMs: 30_000,
};

test("docker 参数：网络一律 none（动态 bash 没有联网选项）", () => {
  const args = buildExecDockerArgs(baseSpec);
  const index = args.indexOf("--network");
  assert.ok(index >= 0, "必须显式设置网络");
  assert.equal(args[index + 1], "none");
  assert.equal(args.filter((arg) => arg === "--network").length, 1, "不该出现第二个网络旗标");
});

test("docker 参数：根只读 + /tmp tmpfs + pids 限制 + no-new-privileges", () => {
  const args = buildExecDockerArgs(baseSpec);
  assert.ok(args.includes("--read-only"), "根文件系统必须只读");
  assert.ok(args.some((arg) => arg.startsWith("/tmp:")), "/tmp 需要独立 tmpfs");
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("--security-opt"));
  assert.equal(args[args.indexOf("--security-opt") + 1], "no-new-privileges");
});

test("docker 参数：有工作区时挂载到 /workspace 并以其为 cwd", () => {
  const args = buildExecDockerArgs({ ...baseSpec, workspaceDir: "/tmp/ws", workspaceMode: "rw" });
  const mount = args.find((arg) => arg.startsWith("/tmp/ws:/workspace:"));
  assert.equal(mount, "/tmp/ws:/workspace:rw");
  assert.equal(args[args.indexOf("-w") + 1], "/workspace");
});

test("docker 参数：只读工作区是 ro 挂载", () => {
  const args = buildExecDockerArgs({ ...baseSpec, workspaceDir: "/tmp/ws", workspaceMode: "ro" });
  assert.ok(args.includes("/tmp/ws:/workspace:ro"));
});

test("docker 参数：无工作区时 cwd 落在 /tmp（不乱挂宿主目录）", () => {
  const args = buildExecDockerArgs(baseSpec);
  assert.equal(args[args.indexOf("-w") + 1], "/tmp");
  assert.equal(args.filter((arg) => arg.includes(":/workspace")).length, 0);
});

test("docker 参数：脚本经 sh -c 执行，入口显式覆盖（不依赖镜像默认 ENTRYPOINT）", () => {
  const args = buildExecDockerArgs({ ...baseSpec, script: "ls -la && echo done" });
  assert.equal(args[args.indexOf("--entrypoint") + 1], "/bin/sh");
  const scriptIndex = args.indexOf("-c");
  assert.ok(scriptIndex > 0);
  assert.equal(args[scriptIndex + 1], "ls -la && echo done", "脚本必须原样传给 sh，不被改写");
});

test("docker 参数：容器名带 morrow-exec 前缀（审计/事后 docker logs 可定位）", () => {
  const args = buildExecDockerArgs({ ...baseSpec, containerName: "morrow-exec-deadbeef" });
  assert.equal(args[args.indexOf("--name") + 1], "morrow-exec-deadbeef");
  assert.ok(args.includes("--rm"), "退出即清理，不留死容器");
});

test("docker 参数：内存与 CPU 限额存在（不让一条脚本吃满宿主）", () => {
  const args = buildExecDockerArgs(baseSpec);
  assert.equal(args[args.indexOf("--memory") + 1], "256m");
  assert.equal(args[args.indexOf("--cpus") + 1], "1");
});

// --- 输出截断 -----------------------------------------------------------------------

test("truncateOutput：未超限原样返回", () => {
  const result = truncateOutput("hello", 100);
  assert.equal(result.text, "hello");
  assert.equal(result.truncated, false);
});

test("truncateOutput：超限时截断并标记", () => {
  const result = truncateOutput("a".repeat(200), 100);
  assert.equal(result.text.length, 100);
  assert.equal(result.truncated, true);
});

test("truncateOutput：按字节而非字符（多字节字符不被切半）", () => {
  // 每个汉字 3 字节：10 个汉字 = 30 字节；上限 10 字节只放得下 3 个汉字（9 字节）
  const result = truncateOutput("测试测试测试测试测试", 10);
  assert.equal(result.truncated, true);
  // 关键：结果必须是合法 UTF-8（不能出现替换字符）
  assert.equal(result.text.includes("\uFFFD"), false);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 10);
});

test("默认输出上限是有限值（不允许无界输出）", () => {
  assert.ok(DEFAULT_EXEC_MAX_OUTPUT_BYTES > 0);
  assert.ok(DEFAULT_EXEC_MAX_OUTPUT_BYTES <= 8 * 1024 * 1024, "上限不宜过大（账本/内存都要扛得住）");
});
