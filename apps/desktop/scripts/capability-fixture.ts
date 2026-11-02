/**
 * 能力管理 UI 的联调夹具（票 M2-T6 / Issue #27；T7 接缝收尾 / Issue #28），仿 settings-fixture：
 *
 * T3/T5 已合入——原 mock 段（工厂事件流脚本、Skill/提案静态数组与接缝路由）整段删除，
 * 前置伺服只剩**纯透明代理**：浏览器面对的每条路径都打在真实 Runtime 上。
 *
 *   真实 Runtime  能力注册表 / 授权面（grants）/ 生命周期（enable/disable/rollback）/
 *                工厂（POST /v1/capabilities/request → GET /v1/capabilities/requests/:id →
 *                POST /v1/capabilities/:id/confirm）/ Skill（案例上报 → 自动晋升提案 →
 *                批准 → invoke）全部走真实端点；memory.write 由启动流程自动注册；另预置
 *                3 个演示能力（多版本历史、enabled/disabled 两态、human/ai 两种作者）。
 *   工厂生成注入  演示走真实工厂管线（检索→规划→构建→esbuild→沙箱验证→待确认），生成器
 *                注入脚本化实现（FakePi 同款口径，零 LLM/零网络）：需求含「CSV」时产出
 *                csv.export 计划（四类测试用例齐备）；沙箱用本地桩 Runner（无 docker 路径，
 *                与 AC-06 桩同源）——容器路径证据见 docs/gates/m2-gate-report.md。
 *   Skill 种子    经真实案例上报端点沉淀 2 次成功案例（memory.write）→ 达阈值自动产生
 *                提案（真实 skill.proposed 事件），UI 批准后即可 invoke。
 *
 * 架构：非接缝路径透明代理给真实 Runtime——浏览器只面对一个控制面 origin（与打包应用
 * 「UI ↔ Runtime 仅本地 HTTP」同构，不给 UI 开夹具后门）。
 *
 *   node --experimental-sqlite --experimental-strip-types scripts/capability-fixture.ts
 *   # 然后浏览器打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<front_port>
 *
 * stdout 单行 ready JSON；SIGTERM/SIGINT 优雅退出。密钥走内存 SecretStore；
 * providers.json 落 MORROW_DATA_DIR（默认临时目录）。
 */
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySecretStore } from "../../runtime/src/keyring.ts";
import { loadConfig } from "../../runtime/src/config.ts";
import { startRuntime } from "../../runtime/src/runtime.ts";
import { createMemoryWriteTool } from "../../runtime/src/memory/tool.ts";
import type { CapabilityGenerator, GeneratorResult } from "../../runtime/src/capabilities/factory/generator.ts";
import type { GeneratorOutput } from "../../runtime/src/capabilities/factory/types.ts";
import { LocalNodeRunner } from "../../runtime/test/factory-stub-runner.ts";
import type { CapabilityManifest } from "@morrow/protocol";

// --- 演示能力（经真实注册端点落库；source_hash 由 runtime 计算存档） --------------------

const WEB_FETCH_V030: CapabilityManifest = {
  name: "web.fetch",
  version: "0.3.0",
  author: "ai",
  runtime: "typescript",
  permissions: {
    filesystem: ["workspace/cache/**"],
    network: ["api.example.com:443"],
    shell: [],
    channels: [],
    credentials: [],
  },
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  output_schema: { type: "object", properties: { text: { type: "string" } } },
  sandbox: { type: "container", network: "restricted", filesystem: "workspace-only" },
  tests: ["web.fetch:fetches-allowed-host", "web.fetch:denies-ungranted-host"],
};

const WEB_FETCH_V100: CapabilityManifest = {
  ...WEB_FETCH_V030,
  version: "1.0.0",
  permissions: { ...WEB_FETCH_V030.permissions, network: ["api.example.com:443", "cdn.example.com:443"] },
};

const REPORT_RENDER_V110: CapabilityManifest = {
  name: "report.render",
  version: "1.1.0",
  author: "human",
  runtime: "typescript",
  permissions: { filesystem: ["reports/**"], network: [], shell: ["read"], channels: [], credentials: [] },
  input_schema: { type: "object", properties: { title: { type: "string" } } },
  output_schema: { type: "object", properties: { html: { type: "string" } } },
  sandbox: { type: "none", network: "none", filesystem: "none" },
  tests: [],
};

const LOG_ARCHIVE_V020: CapabilityManifest = {
  name: "log.archive",
  version: "0.2.0",
  author: "human",
  runtime: "go",
  permissions: { filesystem: ["logs/**"], network: [], shell: ["read", "package"], channels: [], credentials: [] },
  input_schema: { type: "object", properties: { since: { type: "string" } } },
  output_schema: { type: "object", properties: { archive: { type: "string" } } },
  sandbox: { type: "process", network: "none", filesystem: "workspace-only" },
  tests: ["log.archive:roundtrip"],
};

const envDataDir = process.env.MORROW_DATA_DIR;
const dataDir = envDataDir ?? mkdtempSync(join(tmpdir(), "morrow-capability-"));
const config = { ...loadConfig(), dataDir };

// --- 工厂演示：脚本化生成器（真实管线，零 LLM）+ 本地桩沙箱 -----------------------------

/** 工厂演示需求关键词：描述含「CSV」即路由到 csv.export 计划 */
const FACTORY_DEMO_KEYWORD = "CSV";

const FACTORY_DEMO_REQUIREMENT = "需要一个把 markdown 表格行转成 CSV 的能力，输入限制 1MB。";

/** csv.export 生成计划（四类测试用例齐备；permissions ⊆ 预置授权面） */
const FACTORY_DEMO_PLAN: GeneratorOutput = {
  name: "csv.export",
  version: "0.1.0",
  description: FACTORY_DEMO_REQUIREMENT,
  permissions: { filesystem: ["workspace/tmp/**"], network: [], shell: [], channels: [], credentials: [] },
  input_schema: { type: "object", properties: { rows: { type: "array" } }, required: ["rows"] },
  output_schema: { type: "object", properties: { csv: { type: "string" } } },
  sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
  dependencies: {},
  source: `export async function run(input: { rows?: unknown } | null): Promise<{ csv: string }> {
  if (input === null || typeof input !== "object") throw new Error("fault: input must be an object");
  for (const key of Object.keys(input)) {
    if (!["rows"].includes(key)) throw new Error("refused: unexpected field '" + key + "' (possible escalation attempt)");
  }
  const rows = input.rows;
  if (!Array.isArray(rows)) throw new Error("fault: rows must be an array");
  if (rows.length === 0) throw new Error("empty rows: nothing to export");
  if (rows.length > 10000) throw new Error("rows exceed the 1MB demo budget");
  const cell = (value: unknown): string => {
    const text = String(value ?? "");
    return /[",\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const lines = rows.map((row) => (Array.isArray(row) ? row.map(cell).join(",") : cell(row)));
  return { csv: lines.join("\\n") };
}`,
  test_cases: [
    { case_id: "pos-roundtrip", kind: "positive", input: { rows: [["a", "b"], ["c", "d"]] }, expect: { outcome: "success", result: { csv: "a,b\nc,d" } } },
    { case_id: "neg-empty", kind: "negative", input: { rows: [] }, expect: { outcome: "failure", errorContains: "nothing to export" } },
    { case_id: "esc-extra-field", kind: "privilege-escalation", input: { rows: [["a"]], path: "/etc/passwd" }, expect: { outcome: "failure", errorContains: "refused" } },
    { case_id: "fault-null", kind: "fault", input: null, expect: { outcome: "failure", errorContains: "must be an object" } },
  ],
};

/** 脚本化生成器：演示需求 → 计划（其余描述诚实返回 no_output，工厂落 factory_failed） */
function createScriptedGenerator(): CapabilityGenerator {
  return {
    async generate(ctx): Promise<GeneratorResult> {
      if (!ctx.description.includes(FACTORY_DEMO_KEYWORD)) {
        return { ok: false, code: "no_output", detail: `fixture generator only scripts the "${FACTORY_DEMO_KEYWORD}" demo requirement` };
      }
      return { ok: true, output: FACTORY_DEMO_PLAN, raw: JSON.stringify(FACTORY_DEMO_PLAN) };
    },
  };
}

/**
 * Skill invoke 的执行注入（RuntimeOptions.skillInvoker 公开 seam）。
 * 缺省接线缺口已由 #22 修复批闭合：runtime 启动时把注册表 enabled 能力登记进
 * ToolInvoker（memory.write 为进程内执行条目），缺省 invoke 不再必然 unknown_tool。
 * 夹具仍注入自有实现，原因有二：① memory.write 的归属语义要求会话里有 user message——
 * 夹具懒创建演示会话并补 user message（真实来源回链），缺省链路无会话上下文时由工具
 * 自身语义拒绝；② 与 Agent Loop 同一条 createMemoryWriteTool 执行路径，写真实记忆服务，
 * 不伪造结果。
 */
let runtimeHandle: Awaited<ReturnType<typeof startRuntime>> | null = null;
/** 懒创建的演示会话（memory.write 的归属语义要求会话里有 user message） */
let demoSessionId: string | null = null;
function ensureDemoSession(): string {
  if (demoSessionId === null && runtimeHandle !== null) {
    const created = runtimeHandle.sessions.createSession("capability-fixture 演示会话");
    runtimeHandle.sessions.sendUserMessage(created.sessionId, "帮我把这段表格归档成 CSV，并把这件事记进长期记忆。");
    demoSessionId = created.sessionId;
  }
  return demoSessionId ?? "skill-invoke";
}
const fixtureSkillInvoker = {
  async invoke(
    name: string,
    input: unknown,
    context?: { actorId?: string; sessionId?: string },
  ): Promise<{ ok: boolean; result?: unknown; error_code?: string; error?: string; via?: string }> {
    if (name === "memory.write" && runtimeHandle !== null) {
      const sessionId = context?.sessionId ?? ensureDemoSession();
      const tool = createMemoryWriteTool({ service: runtimeHandle.memory, sessionId });
      const result = await tool.execute(`skill-invoke-${Date.now()}`, input);
      return result.isError === true
        ? { ok: false, error: result.text, via: "builtin" }
        : { ok: true, result: { text: result.text }, via: "builtin" };
    }
    return { ok: false, error_code: "unknown_tool", error: `fixture skill invoker wires memory.write only; got "${name}"`, via: "builtin" };
  },
};

const runtime = await startRuntime(config, {
  secretStore: createInMemorySecretStore(),
  agentAdapterFactory: async () => createScriptedAgent(),
  sandboxRunner: new LocalNodeRunner(),
  capabilityGenerator: createScriptedGenerator(),
  skillInvoker: fixtureSkillInvoker,
});
runtimeHandle = runtime;
const runtimeBase = `http://${runtime.host}:${runtime.port}`;

/** 预置授权面（覆盖全部演示能力的五维声明——注册校验 permissions ⊆ grants，先授权后注册） */
const SEED_GRANTS = {
  filesystem: ["workspace/cache/**", "workspace/tmp/**", "reports/**", "logs/**"],
  network: ["api.example.com:443", "cdn.example.com:443"],
  shell: ["read", "package"],
  channels: ["desktop"],
  credentials: [],
};

/** 预置演示能力：先 PUT 授权面（真实校验的注册前提）→ 注册（幂等）→ web.fetch 启用 */
async function seedCapabilities(): Promise<void> {
  const grantsRes = await fetch(`${runtimeBase}/v1/capabilities/grants`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(SEED_GRANTS),
  });
  if (!grantsRes.ok) throw new Error(`seed grants failed: HTTP ${grantsRes.status} ${await grantsRes.text()}`);
  for (const manifest of [WEB_FETCH_V030, WEB_FETCH_V100, REPORT_RENDER_V110, LOG_ARCHIVE_V020]) {
    const res = await fetch(`${runtimeBase}/v1/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest),
    });
    if (!res.ok) throw new Error(`seed ${manifest.name}@${manifest.version} failed: HTTP ${res.status} ${await res.text()}`);
  }
  const enable = await fetch(`${runtimeBase}/v1/capabilities/web.fetch/enable`, { method: "POST" });
  if (!enable.ok) throw new Error(`enable web.fetch failed: HTTP ${enable.status}`);
  // log.archive 停用态演示（停用后运行时调用被拒——清单里可再启用）
  const disable = await fetch(`${runtimeBase}/v1/capabilities/log.archive/disable`, { method: "POST" });
  if (!disable.ok) throw new Error(`disable log.archive failed: HTTP ${disable.status}`);
}
await seedCapabilities();

/** Skill 种子：经真实案例上报端点沉淀 2 次成功案例（memory.write）→ 阈值 2 自动晋升提案 */
async function seedSkillCases(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${runtimeBase}/v1/capabilities/skills/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "memory.write",
        outcome: "success",
        source_event_id: `fixture-seed-${i + 1}`,
        occurred_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`seed skill case failed: HTTP ${res.status} ${await res.text()}`);
  }
}
await seedSkillCases();

// --- 前置伺服：纯透明代理（真实 Runtime 单一 origin） ----------------------------------

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 透明代理（JSON 控制面流量；保持 UI 单一 origin）。content-type 仅在原始请求携带时
 *  转发——无 body 的 POST（如提案决策）不得伪造 application/json，否则 runtime 会去
 *  解析空 body 而 400。 */
async function proxyToRuntime(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL,
): Promise<void> {
  const body = await readBody(req);
  const contentType = req.headers["content-type"];
  const upstream = await fetch(runtimeBase + url.pathname + url.search, {
    method: req.method,
    headers: {
      ...(contentType !== undefined ? { "content-type": Array.isArray(contentType) ? contentType[0] : contentType } : {}),
    },
    ...(body.length > 0 ? { body } : {}),
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  res.end(text);
}

const front = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      await proxyToRuntime(req, res, url);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "fixture_error", message: String(err) } }));
    }
  })();
});

/** 占位即释放，拿一个大概率空闲端口 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("no port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const frontPort = await freePort();
front.listen(frontPort, "127.0.0.1");

console.log(
  JSON.stringify({
    ready: true,
    fixture: "capability",
    version: "0.2.0",
    runtime: runtimeBase,
    front: `http://127.0.0.1:${frontPort}`,
    data_dir: config.dataDir,
    hint:
      `浏览器打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:${frontPort}（纯透明代理，` +
      `全部路径打真实 Runtime）。演示：清单/详情（web.fetch 双版本历史 + 回滚）/` +
      `预授权编辑（PUT grants 真实生效）/工厂全流程（提交含「${FACTORY_DEMO_KEYWORD}」的需求，` +
      `真实管线约数秒到待确认，确认后注册 csv.export——author=ai 默认停用）/` +
      `Skill 提案（memory.write 两次成功案例已自动沉淀 1 条待批准提案，批准后可 invoke）。`,
  }),
);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  front.close();
  void runtime
    .close(signal)
    .then(() => {
      console.log(JSON.stringify({ stopped: true, signal }));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("[capability-fixture] error during shutdown:", err);
      process.exit(1);
    });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/** 脚本化 Agent（同 settings-fixture 的最小回声版）：建会话发消息无需真实模型 */
function createScriptedAgent() {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async prompt(input: string | { content: string }[]): Promise<void> {
      const text = typeof input === "string" ? input : input.map((m) => m.content).join(" ");
      emit({ type: "text_delta", delta: `capability-fixture 收到：「${text}」` });
      emit({ type: "agent_end", stopReason: "stop" });
    },
    subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort(): void {},
    async waitForIdle(): Promise<void> {},
    dispose(): void {
      listeners.clear();
    },
  };
}
