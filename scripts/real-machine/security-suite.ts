#!/usr/bin/env node
/**
 * M6-T1 安全与故障注入汇总（Issue #52；M6 规格 #51：只汇总与补缺，不新增功能域）。
 *
 * 一个命令跑完六个安全域，输出 PASS/FAIL 总表：
 *   1. 越权        可信联系人五类越权 + 能力注册五维越权
 *   2. 密钥泄漏    providers.json / API 响应 / 账本事件 / 运行期日志的字节级扫描
 *   3. CSRF/来源   text/plain simple POST 415、非本地来源无 CORS、回环豁免精确地址
 *   4. 沙箱        无运行时 → sandbox_unavailable + install-hint；生成代码不越 manifest 权限
 *   5. 同步安全    tombstone 双向不复活、撤销设备 401/403、通知正文按接收者裁剪
 *   6. 租约        旧 fencing token 被拒、双持有冻结
 *
 * 设计原则：
 * - **聚合调用、不重写断言**：每个域直接 spawn `node --test` 跑既有测试文件；
 *   本脚本只补一个既有套件没有的检查（运行期日志字节扫描），其余零重复实现。
 * - **可复跑**：零真实网络（仅 127.0.0.1 回环）、零真实密钥（测试注入内存 SecretStore /
 *   平台桩 / FakePi；子进程环境剥离 MORROW_PROVIDER_*，避免继承宿主密钥）。
 * - **证据可引用**：失败时打印具体测试名；通过时域名/文件/断言数可对回测试文件与
 *   docs/security/README.md 的域→断言映射。
 *
 * 用法：
 *   export PATH="/opt/homebrew/bin:$PATH"
 *   node --experimental-strip-types scripts/real-machine/security-suite.ts [--json docs/gates/m6-security-summary.json]
 *
 * 退出码：0 = 六域全 PASS；1 = 任一域失败（或测试计数无法解析）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "../../apps/runtime/src/config.ts";
import { createInMemorySecretStore } from "../../apps/runtime/src/keyring.ts";
import { startRuntime } from "../../apps/runtime/src/runtime.ts";
import { removeDir, tmpDir } from "../../apps/runtime/test/helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const RUNTIME_DIR = join(ROOT, "apps/runtime");
const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface InlineCheck {
  name: string;
  run(): Promise<string> | string;
}

interface DomainSpec {
  id: string;
  title: string;
  /** 相对 apps/runtime 的测试文件；全部为既有断言。 */
  files: string[];
  /** 既有套件未覆盖的补充检查（当前仅域 2 的日志字节扫描）。 */
  checks: InlineCheck[];
  evidence: string;
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface DomainResult {
  spec: DomainSpec;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
  checks: CheckResult[];
  durationMs: number;
  error: string | null;
}

interface ParsedCounts {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

const DOMAINS: DomainSpec[] = [
  {
    id: "authorization",
    title: "越权（可信联系人五类 + 能力注册五维）",
    files: [
      "test/contacts.permissions.test.ts",
      "test/channels.contact-authorization.test.ts",
      "test/capabilities.engine.test.ts",
      "test/capabilities.api.test.ts",
      "test/capabilities.invoke.test.ts",
    ],
    checks: [],
    evidence:
      "contacts.permissions.test.ts「all five unauthorized contact actions…」；capabilities.engine.test.ts「checkPermissionsWithinGrants：五维…」；capabilities.api.test.ts「注册越权：五维…」",
  },
  {
    id: "secret-leak",
    title: "密钥泄漏（配置 / API / 账本 / 日志）",
    files: [
      "test/providers.test.ts",
      "test/providers.api.test.ts",
      "test/keyring.test.ts",
      "test/channels.secrets.api.test.ts",
      "test/notifications.service.test.ts",
    ],
    checks: [
      {
        name: "运行期日志字节扫描（console 捕获，与测试同进程）",
        run: auditRuntimeLogsForSecrets,
      },
    ],
    evidence:
      "providers.test.ts「providers.json 不得含密钥」；providers.api.test.ts「密钥全链路不泄漏…」；channels.secrets.api.test.ts「写入不回显」；notifications.service.test.ts「内容裁剪…凭据被裁剪」",
  },
  {
    id: "csrf-origin",
    title: "CSRF / 来源（415、CORS、回环精确豁免）",
    files: ["test/cors.test.ts", "test/pairing.test.ts"],
    checks: [],
    evidence:
      "cors.test.ts「simple POST with text/plain (CSRF vector) is rejected 415…」「non-local origins get no CORS grant」；pairing.test.ts「鉴权策略：回环豁免；非回环无令牌 401…撤销后 403」",
  },
  {
    id: "sandbox",
    title: "沙箱（不可用拒绝 + 权限不越界）",
    files: [
      "test/sandbox.contract.test.ts",
      "test/sandbox.detect.test.ts",
      "test/sandbox.permission.test.ts",
      "test/sandbox.invoker.test.ts",
      "test/sandbox.runner-units.test.ts",
      "test/sandbox.docker-runner.test.ts",
      "test/sandbox.wiring.test.ts",
      "test/invocation-errors.test.ts",
      "test/capabilities.invoke.test.ts",
    ],
    checks: [],
    evidence:
      "sandbox.docker-runner.test.ts「无容器运行时 → sandbox_unavailable 且带 install-hint」；sandbox.permission.test.ts「越界路径一律拒绝」；sandbox.invoker.test.ts「先权限后执行，fail-closed」；capabilities.invoke.test.ts 错误码表 503+install-hint",
  },
  {
    id: "sync-security",
    title: "同步安全（tombstone / 撤销设备 / 通知裁剪）",
    files: [
      "test/sync.memory.test.ts",
      "test/sync.engine.test.ts",
      "test/sync.api.test.ts",
      "test/pairing.test.ts",
      "test/notifications.service.test.ts",
    ],
    checks: [],
    evidence:
      "sync.memory.test.ts「删除跨副本传播且不复活…反向同理」；sync.api.test.ts「integrity_hash 不符 → 400 拒绝整批」；pairing.test.ts 撤销后 403 device_revoked；notifications.service.test.ts「渠道接收者正文不含 private…凭据」",
  },
  {
    id: "lease",
    title: "租约（fencing token / 双持有冻结）",
    files: [
      "test/lease.test.ts",
      "test/lease.api.test.ts",
      "test/lease.scheduler.test.ts",
      "test/lease.fencing-sync.test.ts",
      "test/lease.preacquire.test.ts",
    ],
    checks: [],
    evidence:
      "lease.test.ts「fencing guard 在租约被抢占后拒绝旧 token 的副作用提交」；lease.fencing-sync.test.ts「B.validate(1)=false，A 旧 token=1 被拒」；lease.preacquire.test.ts「近同时 acquire（双持有）→ 立即 needs_reconcile」",
  },
];

/** 子进程环境：剥离宿主密钥与数据目录，禁止交互式颜色/分页干扰解析。 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    // 强制内存凭据库：即使某个测试忘记注入 SecretStore，也不会触碰真实 Keychain。
    MORROW_SECRET_BACKEND: "memory",
  };
  for (const name of [
    "MORROW_PROVIDER_API_KEY",
    "MORROW_PROVIDER_BASE_URL",
    "MORROW_PROVIDER_MODEL",
    "MORROW_DATA_DIR",
    "MORROW_REPLICA_ID",
    "MORROW_HOST",
    "MORROW_PORT",
    "MORROW_PUBLIC_BASE_URL",
  ]) {
    delete env[name];
  }
  return env;
}

function parseCounts(output: string): ParsedCounts | null {
  const grab = (label: string): number | null => {
    const match = output.match(new RegExp(`ℹ ${label} (\\d+)`));
    return match === null ? null : Number(match[1]);
  };
  const tests = grab("tests");
  const passed = grab("pass");
  const failed = grab("fail");
  const skipped = grab("skipped");
  if (tests === null || passed === null || failed === null) return null;
  const failures = [
    ...new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("✖ ") && !line.startsWith("✖ failing tests"))
        .map((line) => line.replace(/\s+\(\d+(?:\.\d+)?ms\)\s*$/, "")),
    ),
  ];
  return { tests, passed, failed, skipped: skipped ?? 0, failures };
}

async function runTestFiles(spec: DomainSpec, timeoutMs = 300_000): Promise<DomainResult> {
  const args = [
    "--experimental-sqlite",
    "--experimental-strip-types",
    "--test",
    ...spec.files,
  ];
  const started = Date.now();
  const outcome = await new Promise<{ output: string; code: number | null; timedOut: boolean }>((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: RUNTIME_DIR,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      output += `\n[spawn error] ${String(error)}\n`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ output, code, timedOut });
    });
  });
  const durationMs = Date.now() - started;
  const counts = parseCounts(outcome.output);
  const base: Omit<DomainResult, "checks"> = {
    spec,
    tests: counts?.tests ?? 0,
    passed: counts?.passed ?? 0,
    failed: counts?.failed ?? (counts === null ? 1 : 0),
    skipped: counts?.skipped ?? 0,
    failures: counts?.failures ?? [],
    durationMs,
    error: null,
  };
  if (outcome.timedOut) {
    base.error = `超时（>${timeoutMs}ms），进程已强杀`;
    base.failed = Math.max(base.failed, 1);
  } else if (counts === null) {
    base.error = `无法解析测试计数（退出码 ${String(outcome.code)}）；输出尾部：\n${outcome.output.split("\n").slice(-15).join("\n")}`;
  } else if (outcome.code !== 0 && base.failed === 0) {
    base.error = `测试进程退出码 ${String(outcome.code)} 但计数为 0 失败；输出尾部：\n${outcome.output.split("\n").slice(-15).join("\n")}`;
    base.failed = 1;
  }
  return { ...base, checks: [] };
}

/** 域 2 补充：运行期日志（console.log/warn/error）字节扫描。
 *  既有套件只扫 providers.json / HTTP 响应 / 账本；日志面没有系统化断言，这里在
 *  同进程捕获一次真实启动 + 注册/冲突/轮换路径的输出，证明本轮执行路径无密钥外泄；
 *  系统性日志脱敏未实现的事实登记在 docs/gates/m6-security-summary.md 残余风险。
 */
async function auditRuntimeLogsForSecrets(): Promise<string> {
  const marker = "sk-m6-security-suite-log-do-not-leak";
  const rotated = "sk-m6-security-suite-log-rotated-do-not-leak";
  const dir = tmpDir("morrow-m6-log-scan-");
  const store = createInMemorySecretStore();
  const config: RuntimeConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    replicaId: REPLICA,
    provider: null,
  };
  const captured: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...data: unknown[]): void => {
    captured.push(data.map((item) => (typeof item === "string" ? item : String(item))).join(" "));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  let runtime: Awaited<ReturnType<typeof startRuntime>> | null = null;
  try {
    runtime = await startRuntime(config, { secretStore: store });
    const port = runtime.port;
    const register = (apiKey: string) =>
      fetch(`http://127.0.0.1:${port}/v1/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider_id: "m6-log-scan",
          name: "M6 log scan",
          base_url: "https://example.invalid/v1",
          model: "scan-model",
          api_key: apiKey,
        }),
      });
    assert.equal((await register(marker)).status, 201, "日志扫描前置：注册应成功");
    // 错误路径 1：重复注册 409；错误路径 2：未知 Provider 404；错误路径 3：key 轮换。
    assert.equal((await register(marker)).status, 409, "日志扫描前置：重复注册应 409");
    await fetch(`http://127.0.0.1:${port}/v1/providers/ghost`);
    await fetch(`http://127.0.0.1:${port}/v1/providers/m6-log-scan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: rotated }),
    });
  } finally {
    if (runtime !== null) await runtime.close();
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    removeDir(dir);
  }
  const bytes = captured.join("\n");
  assert.equal(bytes.includes(marker), false, "运行期日志不得含注册密钥");
  assert.equal(bytes.includes(rotated), false, "运行期日志不得含轮换后的密钥");
  return `捕获 ${captured.length} 行 / ${Buffer.byteLength(bytes)} 字节，密钥命中 0`;
}

async function runDomain(spec: DomainSpec): Promise<DomainResult> {
  const result = await runTestFiles(spec);
  result.checks = [];
  for (const check of spec.checks) {
    try {
      const detail = await check.run();
      result.checks.push({ name: check.name, passed: true, detail });
    } catch (error) {
      result.checks.push({
        name: check.name,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function statusOf(result: DomainResult): "PASS" | "FAIL" {
  const checksFailed = result.checks.filter((check) => !check.passed).length;
  return result.failed === 0 && checksFailed === 0 && result.error === null ? "PASS" : "FAIL";
}

function assertionsOf(result: DomainResult): number {
  return result.tests + result.checks.length;
}

function passedOf(result: DomainResult): number {
  return result.passed + result.checks.filter((check) => check.passed).length;
}

function failedOf(result: DomainResult): number {
  return result.failed + result.checks.filter((check) => !check.passed).length;
}

function evidenceOf(spec: DomainSpec): string {
  return spec.files.map((file) => file.replace(/^test\//, "")).join(", ");
}

function printEnvironment(): void {
  console.log("M6 安全与故障注入汇总（Issue #52）");
  console.log(`时间：${new Date().toISOString()}`);
  console.log(`环境：node ${process.version} ｜ ${process.platform}-${process.arch} ｜ runtime=${RUNTIME_DIR}`);
  console.log("边界：零真实网络（仅 127.0.0.1 回环）｜零真实密钥（内存 SecretStore / 平台桩 / FakePi）");
  console.log("");
}

function printTable(results: DomainResult[]): void {
  console.log("| # | 安全域 | 断言 | 通过 | 失败 | 跳过 | 结论 | 证据（apps/runtime/test） |");
  console.log("|---|--------|------|------|------|------|------|--------------------------|");
  results.forEach((result, index) => {
    const status = statusOf(result);
    const evidence = evidenceOf(result.spec);
    console.log(
      `| ${index + 1} | ${result.spec.title} | ${assertionsOf(result)} | ${passedOf(result)} | ${failedOf(result)} | ${result.skipped} | ${status} | ${evidence} |`,
    );
  });
  console.log("");
}

function printDetails(results: DomainResult[]): void {
  results.forEach((result, index) => {
    const status = statusOf(result);
    console.log(`[${status}] ${index + 1}. ${result.spec.title}（${(result.durationMs / 1000).toFixed(1)}s）`);
    for (const failure of result.failures) console.log(`  失败测试：${failure}`);
    for (const check of result.checks) {
      console.log(`  补充检查：${check.passed ? "PASS" : "FAIL"} ${check.name} — ${check.detail}`);
    }
    if (result.error !== null) console.log(`  错误：${result.error}`);
  });
  console.log("");
}

function writeJson(path: string, results: DomainResult[]): void {
  const payload = {
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    boundary: "zero external network (loopback only); zero real secrets (in-memory SecretStore / stubs / FakePi)",
    domains: results.map((result) => ({
      id: result.spec.id,
      title: result.spec.title,
      assertions: assertionsOf(result),
      passed: passedOf(result),
      failed: failedOf(result),
      skipped: result.skipped,
      status: statusOf(result),
      duration_ms: result.durationMs,
      files: result.spec.files,
      evidence: result.spec.evidence,
      failures: result.failures,
      checks: result.checks,
      error: result.error,
    })),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`JSON 证据已写入：${path}`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const jsonIndex = argv.indexOf("--json");
  const jsonPath = jsonIndex === -1 ? null : (argv[jsonIndex + 1] ?? null);
  if (jsonIndex !== -1 && (jsonPath === null || jsonPath.startsWith("--"))) {
    console.error("--json 需要一个输出路径");
    return 1;
  }

  printEnvironment();
  const results: DomainResult[] = [];
  for (const spec of DOMAINS) {
    const result = await runDomain(spec);
    results.push(result);
    const mark = statusOf(result) === "PASS" ? "PASS" : "FAIL";
    console.log(`... ${spec.id} ${mark}（${assertionsOf(result)} 断言，${(result.durationMs / 1000).toFixed(1)}s）`);
  }
  console.log("");
  printTable(results);
  printDetails(results);

  const failures = results.filter((result) => statusOf(result) === "FAIL");
  const totalAssertions = results.reduce((sum, result) => sum + assertionsOf(result), 0);
  const totalPassed = results.reduce((sum, result) => sum + passedOf(result), 0);
  console.log(`合计：${results.length} 域 ｜ ${totalAssertions} 断言 ｜ ${totalPassed} 通过 ｜ ${totalAssertions - totalPassed} 失败`);

  if (jsonPath !== null) writeJson(resolve(jsonPath), results);
  if (failures.length === 0) {
    console.log("结论：六域全部 PASS");
    return 0;
  }
  console.log(`结论：${failures.length} 个域 FAIL — ${failures.map((result) => result.spec.id).join(", ")}`);
  return 1;
}

process.exitCode = await main();
