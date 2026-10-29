/**
 * 二进制 --probe 模式（打包探针，T8 / Issue #9）。
 *
 * 在编译产物内部依次执行启动探针（验收：standalone 与 sidecar 两形态"同样探针"）：
 * 1. 正常启动 Runtime（node:sqlite 账本，无任何运行时标志）→ stdout 单行 ready JSON
 *    （与 apps/runtime/src/main.ts 的 sidecar 启动协议同形状）；
 * 2. health 自检：GET /v1/health → 200 + status ok + 账本已记账 runtime.started；
 * 3. node:sqlite 直连 roundtrip（建表/写入/读回 + sqlite_version()）——ADR-0006 实测证据；
 * 4. 对话探针：真实 PiAdapter（完整 Pi 依赖树）→ MORROW_PROBE_LLM_BASE_URL 指向的
 *    OpenAI 兼容 mock 服务器跑一轮流式对话，断言窄事件契约；
 * 5. 优雅关闭（记账 runtime.stopped、WAL checkpoint）→ 报告行 → 退出码 0（失败 1）。
 *
 * 对话探针选型：复用 pi-adapter 真实接线测试的本地 mock 服务器（而非 FakePi 内置模式），
 * 理由见 scripts/packaging/README.md「探针设计」。
 */
import type { RuntimeHandle } from "@morrow/runtime";
import { loadConfig, openSqlite, startRuntime } from "@morrow/runtime";
import { createPiAdapter, type MorrowAgentEvent } from "@morrow/pi-adapter";
import runtimePackageJson from "../../../apps/runtime/package.json" with { type: "json" };
import { fetchJson } from "./probe-lib.ts";

/** 与 src/probe-lib.ts 的 ProbeReport 对应（契约：单行 JSON） */
interface CheckResult {
  ok: boolean;
  [key: string]: unknown;
}

interface ProbeReport {
  probe: "pass" | "fail";
  version: string;
  runtime: { name: string; bun: string | null; node: string };
  checks: Record<string, CheckResult>;
  error?: string;
}

const DIALOGUE_TIMEOUT_MS = 30_000;

/** 等待一行真正落到 stdout（管道写入异步，直接 process.exit 可能丢行） */
function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, () => resolve());
  });
}

function flushExit(code: number): void {
  process.exit(code);
}

function runtimeInfo(): ProbeReport["runtime"] {
  const versions = process.versions as Record<string, string | undefined>;
  const bun = versions.bun ?? null;
  return { name: bun !== null ? "bun" : "node", bun, node: versions.node ?? "unknown" };
}

async function checkHealth(runtime: RuntimeHandle): Promise<CheckResult> {
  const res = await fetchJson(`http://${runtime.host}:${runtime.port}/v1/health`, 5_000);
  if (res.status !== 200) {
    throw new Error(`/v1/health returned ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const body = res.body as { status?: string; ledger?: { events?: number } };
  if (body.status !== "ok") {
    throw new Error(`/v1/health body status is not "ok": ${JSON.stringify(res.body)}`);
  }
  const ledgerEvents = body.ledger?.events ?? 0;
  if (ledgerEvents < 1) {
    throw new Error(`ledger has ${ledgerEvents} events; runtime.started was not appended`);
  }
  return { ok: true, http_status: res.status, status: body.status, ledger_events: ledgerEvents };
}

/** node:sqlite 直连 roundtrip（内存库）：建表 → 写入 → 读回 → sqlite_version() */
function checkSqlite(): CheckResult {
  const db = openSqlite(":memory:");
  try {
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO probe (v) VALUES (?)").run("probe-ok");
    const rows = db.prepare("SELECT v FROM probe").all() as Array<{ v: string }>;
    if (rows.length !== 1 || rows[0]?.v !== "probe-ok") {
      throw new Error(`sqlite roundtrip mismatch: ${JSON.stringify(rows)}`);
    }
    const versionRow = db.prepare("SELECT sqlite_version() AS v").get() as { v: string } | undefined;
    return {
      ok: true,
      driver: "node:sqlite",
      sqlite_version: versionRow?.v ?? "unknown",
      roundtrip_rows: rows.length,
    };
  } finally {
    db.close();
  }
}

async function checkDialogue(baseUrl: string): Promise<CheckResult> {
  const adapter = await createPiAdapter({
    baseUrl,
    apiKey: "probe-key",
    model: { id: "probe-chat-model", contextWindow: 8192, maxTokens: 1024 },
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
    systemPrompt: "你是 Morrow 运行时探针。",
  });
  const started = Date.now();
  try {
    const events: MorrowAgentEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.prompt("探针：请原样回复“探针正常”。");

    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent !== undefined) {
      throw new Error(`dialogue produced error event: ${JSON.stringify(errorEvent)}`);
    }
    const last = events.at(-1);
    if (last?.type !== "agent_end" || last.stopReason !== "stop") {
      throw new Error(`dialogue did not end with agent_end(stop): last=${JSON.stringify(last)}`);
    }
    const text = events
      .filter((e): e is Extract<MorrowAgentEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.delta)
      .join("");
    if (text !== "探针正常") {
      throw new Error(`dialogue text mismatch: ${JSON.stringify(text)}`);
    }
    return {
      ok: true,
      stop_reason: "stop",
      text,
      event_count: events.length,
      elapsed_ms: Date.now() - started,
    };
  } finally {
    adapter.dispose();
  }
}

function withTimeout<T>(promise: Promise<T>, _label: string, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${_label} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

export async function runProbe(): Promise<void> {
  const report: ProbeReport = {
    probe: "fail",
    version: runtimePackageJson.version,
    runtime: runtimeInfo(),
    checks: {},
  };

  let runtime: RuntimeHandle | undefined;
  let finishing = false;

  const finish = async (code: number): Promise<void> => {
    if (finishing) return;
    finishing = true;
    try {
      await runtime?.close();
    } catch {
      // 关闭失败不掩盖探针结论
    }
    await writeLine(JSON.stringify(report));
    flushExit(code);
  };

  process.on("SIGTERM", () => {
    report.error = `interrupted by SIGTERM before completion`;
    void finish(1);
  });
  process.on("SIGINT", () => {
    report.error = `interrupted by SIGINT before completion`;
    void finish(1);
  });

  try {
    const config = loadConfig();
    runtime = await startRuntime(config);
    // ready 行与 apps/runtime/src/main.ts 的 sidecar 启动协议同形状
    await writeLine(
      JSON.stringify({
        ready: true,
        version: report.version,
        host: runtime.host,
        port: runtime.port,
        pid: process.pid,
        data_dir: config.dataDir,
        replica_id: config.replicaId,
      }),
    );

    report.checks["health"] = await checkHealth(runtime);
    report.checks["sqlite"] = checkSqlite();

    const baseUrl = process.env.MORROW_PROBE_LLM_BASE_URL;
    if (baseUrl === undefined || baseUrl === "") {
      throw new Error(
        "MORROW_PROBE_LLM_BASE_URL is not set; the dialogue probe needs an OpenAI-compatible base url",
      );
    }
    const dialogue = await withTimeout(checkDialogue(baseUrl), "dialogue probe", DIALOGUE_TIMEOUT_MS);
    report.checks["dialogue"] = dialogue;

    report.probe = "pass";
    await finish(0);
  } catch (err) {
    report.probe = "fail";
    report.error = err instanceof Error ? err.message : String(err);
    await finish(1);
  }
}
