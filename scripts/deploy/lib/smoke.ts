/**
 * 三形态部署冒烟驱动（票 M3-T5 / Issue #34）。
 *
 * 三个入口脚本只是壳：
 *   scripts/deploy/smoke-local.sh   → node ... --mode local   纯本地
 *   scripts/deploy/smoke-server.sh  → node ... --mode server  服务器（systemd 等价前台）
 *   scripts/deploy/smoke-hybrid.sh  → node ... --mode hybrid  混合双进程（配对 + 双向增量同步）
 *
 * 设计口径：
 * - 全部走真实 HTTP 接缝（/v1/health、/v1/sessions、/v1/pairing/*、/v1/sync/*），
 *   不 import Runtime 内部实现，除了复用打包探针的本地 OpenAI mock（本地对话用）；
 * - 优先用打包产物（scripts/packaging/dist/morrow-runtime-<platform>-<arch>）；
 *   不存在则回退 `node --experimental-strip-types apps/runtime/src/main.ts`（开发机零打包）；
 * - 冒烟进程一律 MORROW_SECRET_BACKEND=memory（设备私钥只在进程内存，不写 OS 凭据库），
 *   临时 dataDir 用完即删；--keep 保留现场便于排查；
 * - 真实 systemd 启动无法在 macOS/开发容器里安全验证：server 模式验证 unit/env 静态契约 +
 *   systemd 等价的前台进程，真实启动在报告中标注“待 Owner 机器验证”。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startMockOpenAI, type MockOpenAIServer } from "../../packaging/src/mock-openai.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const RUNTIME_ENTRY = join(REPO_ROOT, "apps/runtime/src/main.ts");
const UNIT_PATH = join(REPO_ROOT, "deploy/systemd/morrow.service");
const ENV_TEMPLATE_PATH = join(REPO_ROOT, "deploy/morrow.env.example");
const DIST_DIR = join(REPO_ROOT, "scripts/packaging/dist");

type Mode = "local" | "server" | "hybrid";

interface ReadyLine {
  ready: true;
  version: string;
  host: string;
  port: number;
  pid: number;
  data_dir: string;
  replica_id: string;
}

interface RuntimeProc {
  name: string;
  child: ChildProcess;
  ready: ReadyLine;
  stdoutLines: string[];
  stderrLines: string[];
}

interface ApiResponse<T> {
  status: number;
  body: T;
}

class SmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeError(message);
}

function log(line: string): void {
  console.log(`[smoke] ${line}`);
}

function pass(line: string): void {
  console.log(`[smoke] PASS ${line}`);
}

// --- CLI -----------------------------------------------------------------------

interface Options {
  mode: Mode;
  binary?: string;
  keep: boolean;
}

function parseArgs(argv: string[]): Options {
  let mode: Mode | undefined;
  let binary: string | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "local" && value !== "server" && value !== "hybrid") {
        throw new SmokeError(`--mode must be local|server|hybrid (got ${String(value)})`);
      }
      mode = value;
    } else if (arg === "--binary") {
      binary = argv[++i];
      if (binary === undefined) throw new SmokeError("--binary requires a path");
    } else if (arg === "--keep") {
      keep = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log("usage: smoke.ts --mode <local|server|hybrid> [--binary <path>] [--keep]");
      process.exit(0);
    } else {
      throw new SmokeError(`unknown argument: ${arg}`);
    }
  }
  if (mode === undefined) throw new SmokeError("--mode is required");
  return { mode, ...(binary !== undefined ? { binary } : {}), keep };
}

// --- runtime 进程 --------------------------------------------------------------

function runtimeCommand(binary: string | undefined): { file: string; args: string[]; label: string } {
  const explicit = binary ?? process.env.MORROW_SMOKE_BIN;
  if (explicit !== undefined && explicit !== "") {
    const file = resolve(explicit);
    assert(existsSync(file), `runtime binary not found: ${file}`);
    ensureExecutable(file);
    return { file, args: [], label: `binary ${file}` };
  }
  const ext = process.platform === "win32" ? ".exe" : "";
  const packed = join(DIST_DIR, `morrow-runtime-${process.platform}-${process.arch}${ext}`);
  if (existsSync(packed)) {
    ensureExecutable(packed);
    return { file: packed, args: [], label: `packed binary ${packed}` };
  }
  return {
    file: process.execPath,
    args: ["--experimental-sqlite", "--experimental-strip-types", RUNTIME_ENTRY],
    label: "node source (packed binary not found; run pnpm pack:runtime for binary-level proof)",
  };
}

/** CI artifact 下载可能丢可执行位；chmod 失败不掩盖后续 spawn 的真实错误 */
function ensureExecutable(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch {
    // EACCES/只读挂载等：让 spawn 报出真实原因
  }
}

/** 清掉宿主环境里的 MORROW_*，保证冒烟不受用户 shell 配置影响 */
function cleanBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("MORROW_")) delete env[key];
  }
  return env;
}

async function startRuntimeProcess(
  name: string,
  env: NodeJS.ProcessEnv,
  command: { file: string; args: string[]; label: string },
): Promise<RuntimeProc> {
  const child = spawn(command.file, command.args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let ready: ReadyLine | undefined;
  let buffer = "";
  let spawnError: Error | undefined;
  child.on("error", (err) => {
    spawnError = err;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        stdoutLines.push(line);
        try {
          const parsed = JSON.parse(line) as Partial<ReadyLine>;
          if (parsed.ready === true && typeof parsed.port === "number") ready = parsed as ReadyLine;
        } catch {
          // 非 ready 的日志行忽略
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim().length > 0) stderrLines.push(line.trim());
    }
  });

  const deadline = Date.now() + 30_000;
  while (ready === undefined) {
    if (spawnError !== undefined) throw new SmokeError(`[${name}] failed to spawn: ${spawnError.message}`);
    if (child.exitCode !== null) {
      throw new SmokeError(
        `[${name}] exited before ready (code ${child.exitCode})\nstdout: ${stdoutLines.join(" | ")}\nstderr: ${stderrLines.join(" | ")}`,
      );
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new SmokeError(`[${name}] ready line timeout\nstderr: ${stderrLines.join(" | ")}`);
    }
    await delay(50);
  }
  log(`${name} ready: host=${ready.host} port=${ready.port} replica=${ready.replica_id} (${command.label})`);
  return { name, child, ready, stdoutLines, stderrLines };
}

async function stopRuntime(proc: RuntimeProc): Promise<void> {
  if (proc.child.exitCode !== null) {
    throw new SmokeError(`[${proc.name}] already exited (code ${proc.child.exitCode})`);
  }
  proc.child.kill("SIGTERM");
  const deadline = Date.now() + 20_000;
  while (proc.child.exitCode === null) {
    if (Date.now() > deadline) {
      proc.child.kill("SIGKILL");
      throw new SmokeError(`[${proc.name}] did not exit within 20s after SIGTERM`);
    }
    await delay(50);
  }
  assert(proc.child.exitCode === 0, `[${proc.name}] exit code ${proc.child.exitCode} (expected 0)`);
  const stopped = proc.stdoutLines.some((line) => {
    try {
      const parsed = JSON.parse(line) as { stopped?: boolean; signal?: string };
      return parsed.stopped === true && parsed.signal === "SIGTERM";
    } catch {
      return false;
    }
  });
  assert(stopped, `[${proc.name}] missing graceful SIGTERM stopped line`);
  pass(`${proc.name} graceful shutdown (exit 0, runtime.stopped recorded)`);
}

// --- HTTP ----------------------------------------------------------------------

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new SmokeError(`non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
  return { status: response.status, body: body as T };
}

async function getJson<T>(port: number, path: string): Promise<ApiResponse<T>> {
  return requestJson<T>(`${baseUrl(port)}${path}`);
}

async function postJson<T>(port: number, path: string, body: unknown): Promise<ApiResponse<T>> {
  return requestJson<T>(`${baseUrl(port)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface EventPage {
  events: Array<{ event_id: string; event_type: string }>;
  total: number;
  limit: number;
  offset: number;
}

interface SessionCreated {
  session_id: string;
  event_id: string;
}

interface MessageRecord {
  role: "user" | "assistant";
  text: string;
  stop_reason?: string;
}

interface HistoryBody {
  session_id: string;
  messages: MessageRecord[];
}

async function fetchAllEvents(port: number): Promise<Array<{ event_id: string; event_type: string }>> {
  const all: Array<{ event_id: string; event_type: string }> = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard++) {
    const res = await getJson<EventPage>(port, `/v1/events?limit=200&offset=${offset}`);
    assert(res.status === 200, `GET /v1/events failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    all.push(...res.body.events);
    offset += res.body.events.length;
    if (offset >= res.body.total || res.body.events.length === 0) return all;
  }
  throw new SmokeError("event pagination did not terminate");
}

async function createSessions(port: number, count: number, prefix: string): Promise<string[]> {
  const eventIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const res = await postJson<SessionCreated>(port, "/v1/sessions", { title: `${prefix}-${i + 1}` });
    assert(res.status === 201, `POST /v1/sessions failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    eventIds.push(res.body.event_id);
  }
  return eventIds;
}

// --- 本地形态 ------------------------------------------------------------------

async function smokeLocal(options: Options): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "morrow-smoke-local-"));
  let mock: MockOpenAIServer | undefined;
  let proc: RuntimeProc | undefined;
  const command = runtimeCommand(options.binary);
  try {
    mock = await startMockOpenAI();
    const env = cleanBaseEnv();
    Object.assign(env, {
      MORROW_HOST: "127.0.0.1",
      MORROW_PORT: "0",
      MORROW_DATA_DIR: dir,
      MORROW_SECRET_BACKEND: "memory",
      MORROW_PROVIDER_BASE_URL: mock.url,
      MORROW_PROVIDER_API_KEY: "smoke-key",
      MORROW_PROVIDER_MODEL: "smoke-model",
    });
    proc = await startRuntimeProcess("local", env, command);
    assert(proc.ready.host === "127.0.0.1", `default/overridden bind should be loopback, got ${proc.ready.host}`);
    assert(proc.ready.host !== "0.0.0.0", "runtime must not bind 0.0.0.0 by default");

    const health = await getJson<{ status: string; ledger: { events: number } }>(proc.ready.port, "/v1/health");
    assert(health.status === 200 && health.body.status === "ok", `health not ok: ${JSON.stringify(health.body)}`);
    assert(health.body.ledger.events >= 1, "health should report at least the startup event");
    pass(`local health ok (ledger events=${health.body.ledger.events})`);

    const created = await postJson<SessionCreated>(proc.ready.port, "/v1/sessions", { title: "smoke-local" });
    assert(created.status === 201, `session create failed: HTTP ${created.status}`);
    const sent = await postJson<{ status: string }>(proc.ready.port, `/v1/sessions/${created.body.session_id}/messages`, {
      text: "本地冒烟：请回一句话",
    });
    assert(sent.status === 202, `message send failed: HTTP ${sent.status} ${JSON.stringify(sent.body)}`);

    let assistant: MessageRecord | undefined;
    const deadline = Date.now() + 15_000;
    while (assistant === undefined) {
      const history = await getJson<HistoryBody>(proc.ready.port, `/v1/sessions/${created.body.session_id}/messages`);
      assert(history.status === 200, `history failed: HTTP ${history.status}`);
      assistant = history.body.messages.find((message) => message.role === "assistant");
      if (assistant !== undefined) break;
      if (Date.now() > deadline) throw new SmokeError("assistant message did not arrive within 15s");
      await delay(100);
    }
    assert(assistant.text.length > 0, "assistant reply is empty");
    assert(assistant.stop_reason === "stop", `assistant stop_reason=${String(assistant.stop_reason)} (expected stop)`);
    assert(mock.requests.length >= 1, "mock OpenAI provider received no request");
    pass(`local dialogue round-trip (assistant="${assistant.text}", stop_reason=${assistant.stop_reason})`);

    await stopRuntime(proc);
    proc = undefined;
  } finally {
    if (proc !== undefined) proc.child.kill("SIGKILL");
    if (mock !== undefined) await mock.close();
    if (options.keep) log(`kept data dir: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

// --- 服务器形态 ----------------------------------------------------------------

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function smokeServer(options: Options): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "morrow-smoke-server-"));
  let proc: RuntimeProc | undefined;
  const command = runtimeCommand(options.binary);
  try {
    // 1) unit 静态契约：真实 systemd 验证在 Owner 机器执行，这里锁定模板不可退化的关键项
    const unit = readFileSync(UNIT_PATH, "utf8");
    for (const needle of [
      "User=morrow",
      "Group=morrow",
      "ExecStart=/usr/local/bin/morrow",
      "EnvironmentFile=/etc/morrow/morrow.env",
      "Restart=on-failure",
      "StateDirectory=morrow",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
    ]) {
      assert(unit.includes(needle), `systemd unit missing required directive: ${needle}`);
    }
    pass("systemd unit template contains required directives");

    // 2) env 模板：默认回环、约定数据目录、systemd EnvironmentFile 可解析
    const fileEnv = parseEnvFile(ENV_TEMPLATE_PATH);
    assert(fileEnv.MORROW_HOST === "127.0.0.1", `env template default host must be 127.0.0.1, got ${fileEnv.MORROW_HOST}`);
    assert(fileEnv.MORROW_HOST !== "0.0.0.0", "env template must not default to 0.0.0.0");
    assert(fileEnv.MORROW_DATA_DIR === "/var/lib/morrow", "env template must use /var/lib/morrow");
    assert(fileEnv.MORROW_PORT === "8787", "env template should use a stable port (8787)");
    pass("env template parses with loopback default and /var/lib/morrow");

    // 3) systemd 等价前台进程：同一 env 文件语义（KEY=VALUE），覆盖 dataDir/port 以便本机可跑
    const env = cleanBaseEnv();
    Object.assign(env, fileEnv, {
      MORROW_HOST: "127.0.0.1",
      MORROW_PORT: "0",
      MORROW_DATA_DIR: dir,
      MORROW_SECRET_BACKEND: "memory",
    });
    proc = await startRuntimeProcess("server", env, command);
    const health = await getJson<{ status: string; replica_id: string }>(proc.ready.port, "/v1/health");
    assert(health.status === 200 && health.body.status === "ok", `health not ok: ${JSON.stringify(health.body)}`);
    assert(health.body.replica_id === proc.ready.replica_id, "health replica_id must match the ready line");
    pass("server-form foreground process health ok");

    await stopRuntime(proc);
    proc = undefined;

    // 4) 真实 systemd：本机（macOS）没有 systemd；Linux 上需要 Owner/CI 的 systemd 会话
    const hasSystemdRun = spawnSync("which", ["systemd-run"], { stdio: "ignore" }).status === 0;
    const realSystemdNote =
      process.platform !== "linux"
        ? "SKIPPED (not Linux; run deploy/systemd/morrow.service on the Owner Ubuntu host)"
        : hasSystemdRun
          ? "SKIPPED (requires an active user/system systemd manager; validate with install-ubuntu.sh on the Owner host)"
          : "SKIPPED (systemd-run not present)";
    log(`real systemd start: ${realSystemdNote}`);
    pass("server-form smoke complete (systemd-equivalent foreground)");
  } finally {
    if (proc !== undefined) proc.child.kill("SIGKILL");
    if (options.keep) log(`kept data dir: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
}

// --- 混合形态 ------------------------------------------------------------------

interface PairingCodeBody {
  code: string;
  expires_at: string;
  server: { replica_id: string; public_key: string; fingerprint: string; fingerprint_short: string };
}

interface ClaimBody {
  token: string;
  device: { replica_id: string; fingerprint: string };
  server: { replica_id: string; fingerprint: string };
}

interface DeviceListBody {
  devices: Array<{ replica_id: string; trusted: boolean; revoked: boolean; public_key?: string | null }>;
}

interface SyncEnvelope {
  source_replica_id: string;
  sequence: number;
  envelope: { event_id: string; event_type: string };
}

interface PullBody {
  envelopes: SyncEnvelope[];
  next_seq: number;
  has_more: boolean;
}

interface PushBody {
  accepted: number;
  duplicates: number;
  next_seq: number | null;
}

interface SyncStatusBody {
  replica_id: string;
  sequence: { min: number | null; max: number | null; count: number };
  cursors: Array<{ peer_replica_id: string; last_pulled_sequence: number; last_acked_sequence: number }>;
}

async function pairDevice(params: {
  host: RuntimeProc; // 生成码并接收 claim 的一端
  guest: RuntimeProc; // 持码来 claim 的一端
  hostServer: PairingCodeBody["server"];
  guestServer: PairingCodeBody["server"];
  guestCode: string;
  label: string;
}): Promise<void> {
  const claimed = await postJson<ClaimBody>(params.host.ready.port, "/v1/pairing/claim", {
    code: params.guestCode,
    device_public_key: params.guestServer.public_key,
    device_label: params.label,
    device_replica_id: params.guest.ready.replica_id,
    // 双端指纹核对：claim 时校验对端指纹，不一致则不消耗配对码
    server_fingerprint: params.hostServer.fingerprint,
  });
  assert(claimed.status === 200, `claim failed: HTTP ${claimed.status} ${JSON.stringify(claimed.body)}`);
  assert(claimed.body.server.replica_id === params.host.ready.replica_id, "claim response server replica mismatch");
  assert(claimed.body.device.replica_id === params.guest.ready.replica_id, "claim response device replica mismatch");
}

async function assertTrusted(port: number, peerReplicaId: string): Promise<void> {
  const devices = await getJson<DeviceListBody>(port, "/v1/devices");
  assert(devices.status === 200, `GET /v1/devices failed: HTTP ${devices.status}`);
  const peer = devices.body.devices.find((device) => device.replica_id === peerReplicaId);
  assert(peer !== undefined, `device list missing peer ${peerReplicaId}`);
  assert(peer.trusted === true, `peer ${peerReplicaId} is not trusted`);
  assert(peer.revoked === false, `peer ${peerReplicaId} is revoked`);
}

async function pullAll(port: number): Promise<SyncEnvelope[]> {
  const all: SyncEnvelope[] = [];
  let since = 0;
  for (let guard = 0; guard < 100; guard++) {
    const res = await getJson<PullBody>(port, `/v1/sync/pull?since=${since}&limit=200`);
    assert(res.status === 200, `sync pull failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    all.push(...res.body.envelopes);
    if (!res.body.has_more) return all;
    since = res.body.next_seq;
  }
  throw new SmokeError("sync pull pagination did not terminate");
}

async function pushAll(port: number, peerReplicaId: string, envelopes: SyncEnvelope[]): Promise<PushBody> {
  const res = await postJson<PushBody>(port, "/v1/sync/push", {
    peer_replica_id: peerReplicaId,
    envelopes,
  });
  assert(res.status === 200, `sync push failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function smokeHybrid(options: Options): Promise<void> {
  const dirA = mkdtempSync(join(tmpdir(), "morrow-smoke-hybrid-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "morrow-smoke-hybrid-b-"));
  let a: RuntimeProc | undefined;
  let b: RuntimeProc | undefined;
  const command = runtimeCommand(options.binary);
  try {
    const envFor = (dir: string): NodeJS.ProcessEnv => {
      const env = cleanBaseEnv();
      Object.assign(env, {
        MORROW_HOST: "127.0.0.1",
        MORROW_PORT: "0",
        MORROW_DATA_DIR: dir,
        MORROW_SECRET_BACKEND: "memory",
      });
      return env;
    };
    a = await startRuntimeProcess("A(local)", envFor(dirA), command);
    b = await startRuntimeProcess("B(server)", envFor(dirB), command);
    assert(a.ready.replica_id !== b.ready.replica_id, "two runtimes must have distinct replica ids");

    // 1) 双向配对（T2）：各自生成一次性码，另一侧持码 claim，双端核对指纹
    const aCode = await postJson<PairingCodeBody>(a.ready.port, "/v1/pairing/codes", {});
    assert(aCode.status === 201, `A pairing code failed: HTTP ${aCode.status} ${JSON.stringify(aCode.body)}`);
    const bCode = await postJson<PairingCodeBody>(b.ready.port, "/v1/pairing/codes", {});
    assert(bCode.status === 201, `B pairing code failed: HTTP ${bCode.status} ${JSON.stringify(bCode.body)}`);
    await pairDevice({
      host: a,
      guest: b,
      hostServer: aCode.body.server,
      guestServer: bCode.body.server,
      guestCode: aCode.body.code,
      label: "smoke-B",
    });
    await pairDevice({
      host: b,
      guest: a,
      hostServer: bCode.body.server,
      guestServer: aCode.body.server,
      guestCode: bCode.body.code,
      label: "smoke-A",
    });
    await assertTrusted(a.ready.port, b.ready.replica_id);
    await assertTrusted(b.ready.port, a.ready.replica_id);
    pass("hybrid pairing complete (A<->B, both trusted, fingerprints matched)");

    // 2) “离线”写入：A 写 5 条、B 写 3 条；此时不做任何同步
    const aSessionEvents = await createSessions(a.ready.port, 5, "offline-A");
    const bSessionEvents = await createSessions(b.ready.port, 3, "offline-B");
    const aEventsBefore = await fetchAllEvents(a.ready.port);
    const bEventsBefore = await fetchAllEvents(b.ready.port);
    const bIdsBefore = new Set(bEventsBefore.map((event) => event.event_id));
    const aIdsBefore = new Set(aEventsBefore.map((event) => event.event_id));
    assert(aSessionEvents.every((id) => !bIdsBefore.has(id)), "B already has A's offline events before sync");
    assert(bSessionEvents.every((id) => !aIdsBefore.has(id)), "A already has B's offline events before sync");
    pass(`offline writes isolated (A=5 events, B=3 events)`);

    // 3) 重连：A → B 全量增量推送（HTTP sync push），再 B → A 反向推送
    const aBatch = await pullAll(a.ready.port);
    const pushedToB = await pushAll(b.ready.port, a.ready.replica_id, aBatch);
    assert(
      pushedToB.accepted === aBatch.length,
      `B should accept all ${aBatch.length} A events, accepted=${pushedToB.accepted} duplicates=${pushedToB.duplicates}`,
    );
    const lastASeq = aBatch[aBatch.length - 1].sequence;
    const statusB = await getJson<SyncStatusBody>(b.ready.port, "/v1/sync/status");
    const cursorAOnB = statusB.body.cursors.find((cursor) => cursor.peer_replica_id === a.ready.replica_id);
    assert(cursorAOnB !== undefined, "B has no cursor for A after push");
    assert(cursorAOnB.last_acked_sequence === lastASeq, `B cursor for A=${cursorAOnB.last_acked_sequence}, expected ${lastASeq}`);

    const bBatch = await pullAll(b.ready.port);
    const pushedToA = await pushAll(a.ready.port, b.ready.replica_id, bBatch);
    assert(pushedToA.accepted > 0, "A should accept B-origin events (B's offline writes + pairing audit)");
    const lastBSeq = bBatch[bBatch.length - 1].sequence;
    const statusA = await getJson<SyncStatusBody>(a.ready.port, "/v1/sync/status");
    const cursorBOnA = statusA.body.cursors.find((cursor) => cursor.peer_replica_id === b.ready.replica_id);
    assert(cursorBOnA !== undefined, "A has no cursor for B after push");
    assert(cursorBOnA.last_acked_sequence === lastBSeq, `A cursor for B=${cursorBOnA.last_acked_sequence}, expected ${lastBSeq}`);
    pass(`bidirectional sync complete (A->B accepted=${pushedToB.accepted}, B->A accepted=${pushedToA.accepted})`);

    // 4) 幂等：同一批重推不产生新事件
    const repeated = await pushAll(b.ready.port, a.ready.replica_id, aBatch);
    assert(repeated.accepted === 0, `repeat push must not add events, accepted=${repeated.accepted}`);
    assert(repeated.duplicates === aBatch.length, `repeat push duplicates=${repeated.duplicates}, expected ${aBatch.length}`);
    pass("idempotent re-push (accepted=0, all duplicates)");

    // 5) 对账：双方离线写入的事件在对方账本中各出现一次；配对审计已互传
    const aEventsAfter = await fetchAllEvents(a.ready.port);
    const bEventsAfter = await fetchAllEvents(b.ready.port);
    const aIdsAfter = aEventsAfter.map((event) => event.event_id);
    const bIdsAfterRaw = bEventsAfter.map((event) => event.event_id);
    assert(new Set(aIdsAfter).size === aIdsAfter.length, "A ledger contains duplicate event ids");
    assert(new Set(bIdsAfterRaw).size === bIdsAfterRaw.length, "B ledger contains duplicate event ids");
    const bIdsAfter = new Set(bIdsAfterRaw);
    for (const id of aSessionEvents) {
      assert(bIdsAfter.has(id), `B is missing A offline event ${id}`);
      assert(bIdsAfterRaw.filter((candidate) => candidate === id).length === 1, `B has duplicate A event ${id}`);
    }
    for (const id of bSessionEvents) {
      assert(aIdsAfter.includes(id), `A is missing B offline event ${id}`);
    }
    assert(
      aEventsAfter.filter((event) => event.event_type === "device.paired").length >= 2,
      "A should hold both pairing records after sync",
    );
    assert(
      bEventsAfter.filter((event) => event.event_type === "device.paired").length >= 2,
      "B should hold both pairing records after sync",
    );
    pass("reconciliation: all offline events present exactly once on both replicas");
    pass("hybrid sync complete");
  } finally {
    if (a !== undefined) a.child.kill("SIGKILL");
    if (b !== undefined) b.child.kill("SIGKILL");
    if (options.keep) {
      log(`kept data dirs: ${dirA} ${dirB}`);
    } else {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  }
}

// --- 入口 ----------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  log(`mode=${options.mode}`);
  if (options.mode === "local") await smokeLocal(options);
  else if (options.mode === "server") await smokeServer(options);
  else await smokeHybrid(options);
  log("all checks passed");
}

main().catch((err: unknown) => {
  console.error(`[smoke] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
