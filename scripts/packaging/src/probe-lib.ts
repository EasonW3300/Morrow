/**
 * 探针公共库（T8 / Issue #9）：standalone 与 sidecar 探针脚本共用。
 *
 * 职责：
 * - 子进程 stdout 的 JSON 行流解析（ready 行握手、噪声容错、超时）；
 * - 探针 HTTP 请求（/v1/health）；
 * - 嵌入式探针套件 runEmbeddedProbe：拉起二进制 --probe 模式，断言
 *   ready → health → 对话探针（真实 PiAdapter × 本地 OpenAI 兼容 mock 服务器）→ 退出码 0。
 *
 * 对话探针选型（README「探针设计」节）：复用 pi-adapter 真实接线测试的本地
 * OpenAI 兼容 SSE mock 服务器（adapted from packages/pi-adapter/test/pi-adapter.live.test.ts），
 * 让编译产物内的完整 Pi 依赖树（@earendil-works/pi-agent-core + pi-ai）真实跑一轮对话——
 * 这是 bun compile 对生产依赖树的直接验证，也是 ADR-0006 的实测证据来源。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryFileName } from "./target.ts";
import { startMockOpenAI, type MockOpenAIRequest } from "./mock-openai.ts";

export { binaryFileName };

// --- JSON 行流 --------------------------------------------------------------

/** 解析单行 JSON，仅接受普通对象；噪声行返回 undefined（不抛错） */
export function parseJsonObjectLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/** main.ts / probe-mode 的 stdout ready 行形状（sidecar 启动协议，apps/runtime README） */
export interface ReadyEvent {
  ready: true;
  version: string;
  host: string;
  port: number;
  pid: number;
  data_dir: string;
  replica_id: string;
}

export function asReadyEvent(obj: unknown): ReadyEvent | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (o.ready !== true) return undefined;
  if (typeof o.port !== "number" || !Number.isInteger(o.port) || o.port <= 0) return undefined;
  if (typeof o.version !== "string" || typeof o.host !== "string") return undefined;
  if (typeof o.data_dir !== "string" || typeof o.replica_id !== "string" || typeof o.pid !== "number") {
    return undefined;
  }
  return o as unknown as ReadyEvent;
}

export interface JsonLineSource {
  /** 喂入子进程 stdout 的原始 chunk（任意切分边界） */
  push(chunk: string): void;
  /** stdout 结束（交付残留半行后进入 EOF） */
  end(): void;
  /** 下一条 JSON 对象行；超时或 EOF reject */
  next(timeoutMs: number): Promise<Record<string, unknown>>;
  /** 被跳过的非 JSON 行（诊断用） */
  readonly noise: string[];
}

/**
 * 子进程 stdout → JSON 对象行流。
 * 非对象行（bun 运行时噪声、console.error 窜流等）跳过并记入 noise；
 * 空行忽略；end() 时残留半行按一行交付（容忍结尾无换行的输出）。
 */
export function createJsonLineSource(): JsonLineSource {
  let buffer = "";
  let ended = false;
  const noise: string[] = [];
  const buffered: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    resolve: (line: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  function deliver(line: string): void {
    const obj = parseJsonObjectLine(line);
    if (obj === undefined) {
      if (line.trim() !== "") noise.push(line.trim());
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(obj);
    } else {
      buffered.push(obj);
    }
  }

  function rejectAll(err: Error): void {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  return {
    push(chunk: string): void {
      if (ended) return;
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        deliver(line);
      }
    },
    end(): void {
      if (ended) return;
      ended = true;
      if (buffer.trim() !== "") {
        const rest = buffer;
        buffer = "";
        deliver(rest);
      }
      rejectAll(new Error("json line source EOF"));
    },
    next(timeoutMs: number): Promise<Record<string, unknown>> {
      const bufferedLine = buffered.shift();
      if (bufferedLine !== undefined) return Promise.resolve(bufferedLine);
      if (ended) return Promise.reject(new Error("json line source EOF"));
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error(`timeout waiting for json line (${timeoutMs}ms)`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    get noise(): string[] {
      return noise;
    },
  };
}

// --- 探针 HTTP ---------------------------------------------------------------

export interface FetchJsonResult {
  status: number;
  body: unknown;
}

/** GET JSON（探针请求）；网络层失败抛错（含 url），非 2xx 由调用方按状态码断言 */
export async function fetchJson(url: string, timeoutMs = 5000): Promise<FetchJsonResult> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`health check failed for ${url}: ${reason}`);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON body 原样返回文本，由调用方判断
  }
  return { status: res.status, body };
}

// --- 嵌入式探针套件 -----------------------------------------------------------

/** 二进制 --probe 模式打印的探针报告行（probe-mode.ts 契约） */
export interface ProbeReport {
  probe: "pass" | "fail";
  version?: string;
  runtime?: { name: string; bun: string | null; node: string };
  checks?: Record<string, { ok: boolean } & Record<string, unknown>>;
  error?: string;
}

export interface EmbeddedProbeOptions {
  binaryPath: string;
  /** 追加/覆盖给二进制的环境变量（调用方无需关心 MORROW_DATA_DIR 等探针基础设施变量） */
  env?: Record<string, string | undefined>;
  readyTimeoutMs?: number;
  probeTimeoutMs?: number;
}

export interface EmbeddedProbeResult {
  ready: ReadyEvent;
  report: ProbeReport;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  stdoutNoise: string[];
  mockRequests: MockOpenAIRequest[];
  dataDir: string;
}

function defaultBinaryPath(): string {
  return join(import.meta.dirname ?? ".", "..", "dist", binaryFileName(process.platform, process.arch));
}

/** 解析 --binary <path> 参数（缺省为当前平台 dist 产物路径）；存在性由探针脚本检查 */
export function resolveBinaryPath(argv: string[]): string {
  const flagIndex = argv.indexOf("--binary");
  const explicit = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const path = explicit ?? defaultBinaryPath();
  return path;
}

export function waitExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`binary did not exit within ${timeoutMs}ms (killed)`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal: signal ?? null });
    });
  });
}

// --- 失败诊断与 spawn 前自愈 ---------------------------------------------------

/**
 * spawn 前自愈可执行位（posix）：actions/download-artifact 的上传/下载不保留 mode 位，
 * CI 产物落盘后不可执行（run 40872208364 的 linux/macos gate 腿双探针 EACCES）。
 * 放在探针 spawn 层而非 workflow chmod 步骤：可执行位属于产物消费方职责，
 * gate / pnpm probe:runtime:* / 将来发布验证等所有调用方一并受益；Windows 无
 * 可执行位概念，直接跳过。文件缺失的错误由调用方的存在性检查先行呈现。
 */
export function ensureExecutable(binaryPath: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(binaryPath, 0o755);
  } catch {
    // chmod 失败不掩盖后续 spawn 的原生报错（EACCES/ENOENT 更接近真实原因）
  }
}

/**
 * 探针失败时的子进程状态诊断（附在错误信息尾部）：
 * 退出码/信号 + stderr 尾部 + stdout 非对象噪声行。EOF 类失败（如 Windows
 * sidecar 阶段 A 的 "json line source EOF"）原样丢失 stderr，排障无从下手——
 * CI 可维护性：任何探针失败都必须带出子进程的可观测状态。
 *
 * killOrigin：探针最近一次 kill 的调用来源标注（由调用方在 kill 前设置）。
 * 子进程死于信号而探针未发过 kill 时标注 external——区分"探针自身终止路径"
 * 与"外部/子进程自身异常"，这是 run 40882409974 windows 腿定位的关键线索。
 */
export function describeChildDiagnostics(
  child: ChildProcess | undefined,
  stderr: string,
  source: JsonLineSource,
  killOrigin?: string,
): string {
  const parts: string[] = [];
  if (child === undefined) {
    parts.push("child not spawned");
  } else if (child.exitCode !== null) {
    parts.push(`child exit=${child.exitCode}`);
  } else if (child.signalCode !== null) {
    parts.push(`child killed by signal ${child.signalCode}`);
    parts.push(`kill origin: ${killOrigin ?? "external (probe sent no kill)"}`);
  } else {
    parts.push("child still running");
  }
  const stderrTail = stderr.trim();
  if (stderrTail !== "") parts.push(`stderr tail: ${stderrTail.slice(-800)}`);
  const noise = source.noise.slice(-5);
  if (noise.length > 0) parts.push(`stdout noise: ${JSON.stringify(noise)}`);
  return parts.join("; ");
}

/** 对话探针的请求级契约断言（mock 服务器捕获视角；与 pi-adapter 契约测试同口径） */
export function assertMockContract(requests: MockOpenAIRequest[]): void {
  if (requests.length !== 1) {
    throw new Error(`expected exactly 1 provider request, got ${requests.length}`);
  }
  const { auth, body } = requests[0];
  if (auth !== "Bearer probe-key") {
    throw new Error(`authorization header mismatch: ${String(auth)}`);
  }
  if (body.model !== "probe-chat-model") {
    throw new Error(`request model mismatch: ${String(body.model)}`);
  }
  if (body.stream !== true) {
    throw new Error("request is not streaming (stream != true)");
  }
  const messages = body.messages as Array<{ role?: string }> | undefined;
  if (!Array.isArray(messages) || messages[0]?.role !== "system" || messages[1]?.role !== "user") {
    throw new Error(`request messages shape unexpected: ${JSON.stringify(messages?.map((m) => m.role))}`);
  }
}

/**
 * 嵌入式探针套件（standalone 探针与 sidecar 探针第二阶段共用）：
 * 1. 启动本地 OpenAI 兼容 mock 服务器（复用 pi-adapter 真实接线测试的实现）；
 * 2. 以 `--probe` 拉起二进制（临时 dataDir、随机端口、MORROW_PROBE_LLM_BASE_URL 指向 mock）；
 * 3. 断言 stdout 首行是 ready JSON、随后是 probe:"pass" 报告、退出码 0。
 * 任一步失败抛错（错误信息含 stderr 尾部）。
 */
export async function runEmbeddedProbe(opts: EmbeddedProbeOptions): Promise<EmbeddedProbeResult> {
  const mock = await startMockOpenAI();
  const dataDir = mkdtempSync(join(tmpdir(), "morrow-probe-"));
  let child: ChildProcess | undefined;
  try {
    ensureExecutable(opts.binaryPath);
    child = spawn(opts.binaryPath, ["--probe"], {
      env: {
        ...process.env,
        ...opts.env,
        MORROW_DATA_DIR: dataDir,
        MORROW_PORT: "0",
        MORROW_PROBE_LLM_BASE_URL: mock.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const source = createJsonLineSource();
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => source.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("close", () => source.end());

    let readyRaw: Record<string, unknown>;
    try {
      readyRaw = await source.next(opts.readyTimeoutMs ?? 20_000);
    } catch (err) {
      // EOF/超时不带子进程状态，排障无从下手（run 40872208364 windows 腿同款盲区）
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${message} [${describeChildDiagnostics(child, stderr, source)}]`,
      );
    }
    const ready = asReadyEvent(readyRaw);
    if (ready === undefined) {
      throw new Error(`first stdout json line is not a ready event: ${JSON.stringify(readyRaw)}`);
    }

    const exit = await waitExit(child, opts.probeTimeoutMs ?? 90_000);
    if (exit.code !== 0) {
      throw new Error(
        `probe binary exited with code ${exit.code} (signal ${exit.signal ?? "none"}); stderr tail: ${
          stderr.slice(-800) || "(empty)"
        }`,
      );
    }

    const reportRaw = await source.next(5_000);
    const report = reportRaw as unknown as ProbeReport;
    if (report.probe !== "pass") {
      throw new Error(`probe report is not "pass": ${JSON.stringify(reportRaw)}`);
    }
    return {
      ready,
      report,
      exitCode: exit.code,
      signal: exit.signal,
      stderr,
      stdoutNoise: [...source.noise],
      mockRequests: mock.requests,
      dataDir,
    };
  } finally {
    // 失败路径上确保二进制不残留（探针脚本必须可重复执行）
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await mock.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
