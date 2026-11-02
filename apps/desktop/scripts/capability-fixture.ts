/**
 * 能力管理 UI 的联调夹具（票 M2-T6 / Issue #27），仿 settings-fixture：
 *
 *   真实 Runtime  能力注册表 / 授权面（grants）/ 生命周期（enable/disable/rollback）全部走
 *                T1 的真实端点（POST/GET /v1/capabilities、PUT /v1/capabilities/grants…），
 *                memory.write 由启动流程自动注册；另预置 3 个演示能力（多版本历史、
 *                enabled/disabled 两态、human/ai 两种作者）。
 *   T3 工厂接缝   ⚠️ 工厂端点（POST /v1/capabilities/request 等，PRD §6.2）由 T3 交付——
 *                本夹具 mock 其事件流（检索→规划→构建→验证→待确认→已注册）供 UI 全流程
 *                演示；「确认注册」会真实回注 Runtime 注册表（POST /v1/capabilities）。
 *                T3 合入后删掉这段 mock 即可（UI 路径即合约，无需改 UI）。
 *   T5 Skill 接缝  ⚠️ Skill 清单与提案端点由 T5 交付——本夹具 mock（含悬空引用提案：
 *                批准 → 409 skill_dangling_reference，UI 呈现拒绝理由）。
 *
 * 架构：mock 伺服在**前置端口**，非接缝路径透明代理给真实 Runtime——浏览器只面对一个
 * 控制面 origin（与打包应用「UI ↔ Runtime 仅本地 HTTP」同构，不给 UI 开夹具后门）。
 *
 *   node --experimental-sqlite --experimental-strip-types scripts/capability-fixture.ts
 *   # 然后浏览器打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<front_port>
 *
 * stdout 单行 ready JSON；SIGTERM/SIGINT 优雅退出。密钥走内存 SecretStore；
 * providers.json 落 MORROW_DATA_DIR（默认临时目录）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySecretStore } from "../../runtime/src/keyring.ts";
import { loadConfig } from "../../runtime/src/config.ts";
import { startRuntime } from "../../runtime/src/runtime.ts";
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
const runtime = await startRuntime(config, {
  secretStore: createInMemorySecretStore(),
  agentAdapterFactory: async () => createScriptedAgent(),
});
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

// --- T3 工厂接缝 mock（⚠️ T3 交付后整段删除）----------------------------------------

interface FactoryJob {
  request_id: string;
  requirement: string;
  stage: "retrieval" | "planning" | "building" | "verifying" | "awaiting_confirmation" | "registered" | "failed";
  stage_detail?: string;
  manifest?: Record<string, unknown>;
  verification?: Array<{ category: string; passed: boolean; summary: string }>;
  error?: string;
  /** 剩余阶段脚本（逐 job 一份——同夹具可反复演示完整流转） */
  script: Array<{ stage: FactoryJob["stage"]; afterMs: number; detail: string }>;
}
const factoryJobs = new Map<string, FactoryJob>();
let factorySeq = 0;

const FACTORY_SCRIPT: Array<{ stage: FactoryJob["stage"]; afterMs: number; detail: string }> = [
  { stage: "planning", afterMs: 1800, detail: "检索命中 2 条相关记忆与 1 个既有能力（memory.write）" },
  { stage: "building", afterMs: 1800, detail: "manifest 已规划：filesystem workspace/tmp/** + 无网络 + container 沙箱" },
  { stage: "verifying", afterMs: 2200, detail: "代码生成完毕，容器内执行测试用例" },
  { stage: "awaiting_confirmation", afterMs: 2200, detail: "四类测试全部通过，等待 Owner 确认注册" },
];

const FACTORY_CANDIDATE_MANIFEST: Record<string, unknown> = {
  name: "csv.export",
  version: "0.1.0",
  author: "ai",
  runtime: "typescript",
  permissions: { filesystem: ["workspace/tmp/**"], network: [], shell: [], channels: [], credentials: [] },
  input_schema: { type: "object", properties: { rows: { type: "array" } }, required: ["rows"] },
  output_schema: { type: "object", properties: { csv: { type: "string" } } },
  sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
  tests: ["csv.export:roundtrip", "csv.export:escapes-quotes"],
};

const FACTORY_VERIFICATION = [
  { category: "schema", passed: true, summary: "input/output schema 校验通过（3 个参数用例）" },
  { category: "permission", passed: true, summary: "越权用例 4/4 阻断（filesystem 越界全部被拒）" },
  { category: "functional", passed: true, summary: "功能用例 8/8 通过（manifest.tests 全绿）" },
  { category: "sandbox", passed: true, summary: "container 沙箱内执行成功（network=none）" },
];

function advanceFactory(job: FactoryJob): void {
  const step = job.script.shift();
  if (step === undefined) return;
  job.stage = step.stage;
  job.stage_detail = step.detail;
  if (step.stage === "awaiting_confirmation") {
    job.manifest = FACTORY_CANDIDATE_MANIFEST;
    job.verification = FACTORY_VERIFICATION;
    return;
  }
  setTimeout(() => advanceFactory(job), step.afterMs).unref();
}

async function handleFactoryConfirm(job: FactoryJob, res: ServerResponse): Promise<void> {
  const manifest = job.manifest as CapabilityManifest | undefined;
  if (manifest === undefined) {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "factory_not_ready", message: "工厂请求尚未到待确认阶段" } }));
    return;
  }
  // 确认注册走真实 Runtime 注册端点（ai 默认停用——Owner 到清单里启用）
  const registered = await fetch(`${runtimeBase}/v1/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifest),
  });
  if (!registered.ok) {
    const body = await registered.text();
    res.writeHead(registered.status, { "content-type": "application/json" });
    res.end(body);
    return;
  }
  job.stage = "registered";
  job.stage_detail = `已注册 ${manifest.name}@${manifest.version}（默认停用，可在能力清单中启用）`;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(serializeJob(job)));
}

// --- T5 Skill 接缝 mock（⚠️ T5 交付后整段删除）----------------------------------------

const skills = [
  {
    skill_id: "weekly-report",
    title: "周报汇总",
    version: "1.2.0",
    capabilities: ["memory.write", "report.render"],
    enabled: true,
  },
  {
    skill_id: "web-digest",
    title: "网页摘要归档",
    version: "0.4.1",
    capabilities: ["web.fetch", "memory.write"],
    enabled: false,
  },
];

interface Proposal {
  proposal_id: string;
  title: string;
  status: "pending" | "approved" | "rejected";
  capabilities: string[];
  missing_capabilities?: string[];
  reason?: string;
}
const proposals: Proposal[] = [
  {
    proposal_id: "prop-clean",
    title: "报告归档 Skill（组合既有能力）",
    status: "pending",
    capabilities: ["memory.write", "report.render"],
  },
  {
    proposal_id: "prop-dangling",
    title: "邮件周报 Skill（引用未注册能力）",
    status: "pending",
    capabilities: ["mail.send", "report.render"],
    missing_capabilities: ["mail.send"],
  },
];

function handleProposalDecide(
  proposal: Proposal,
  decision: string,
  res: ServerResponse,
): void {
  if (decision !== "approve" && decision !== "reject") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "http_404", message: "unknown proposal action" } }));
    return;
  }
  if (proposal.status !== "pending") {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "skill_proposal_decided", message: `提案已是 ${proposal.status} 态` } }));
    return;
  }
  const missing = proposal.missing_capabilities ?? [];
  if (decision === "approve" && missing.length > 0) {
    // 悬空引用提案被拒（T5 判定的 mock 口径）：409 + 未注册能力清单
    res.writeHead(409, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: "skill_dangling_reference",
          message: `提案引用的能力未注册：${missing.join("、")}——先实现并注册这些能力，或移除引用`,
        },
      }),
    );
    return;
  }
  proposal.status = decision === "approve" ? "approved" : "rejected";
  proposal.reason =
    decision === "approve" ? "Owner 批准，进入注册流程。" : "Owner 拒绝（UI 手动拒绝）。";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(proposal));
}

// --- 前置伺服：接缝路由 + 其余透明代理 ------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 工厂 job 对外投影：剥掉夹具内部字段（script），只留 API 合约形状 */
function serializeJob(job: FactoryJob): Record<string, unknown> {
  const { script: _script, ...rest } = job;
  return rest;
}

/** 透明代理（JSON 控制面流量；保持 UI 单一 origin） */
async function proxyToRuntime(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const body = await readBody(req);
  const upstream = await fetch(runtimeBase + url.pathname + url.search, {
    method: req.method,
    headers: { "content-type": req.headers["content-type"] ?? "application/json" },
    ...(body.length > 0 ? { body } : {}),
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  res.end(text);
}

const front: Server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      // T3 工厂接缝
      if (req.method === "POST" && url.pathname === "/v1/capabilities/request") {
        const body = JSON.parse((await readBody(req)) || "{}") as { requirement?: string };
        const id = `fact-${String(++factorySeq).padStart(3, "0")}`;
        const job: FactoryJob = {
          request_id: id,
          requirement: body.requirement ?? "",
          stage: "retrieval",
          stage_detail: "正在检索记忆与既有能力",
          script: [...FACTORY_SCRIPT],
        };
        factoryJobs.set(id, job);
        setTimeout(() => advanceFactory(job), 1500).unref();
        sendJson(res, 201, serializeJob(job));
        return;
      }
      const factoryMatch = /^\/v1\/capabilities\/request\/([^/]+)(?:\/confirm)?$/.exec(url.pathname);
      if (factoryMatch !== null) {
        const job = factoryJobs.get(factoryMatch[1]);
        if (job === undefined) {
          sendJson(res, 404, { error: { code: "factory_request_not_found", message: "未知工厂请求" } });
          return;
        }
        if (url.pathname.endsWith("/confirm")) {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: { code: "http_405", message: "method not allowed" } });
            return;
          }
          await handleFactoryConfirm(job, res);
          return;
        }
        sendJson(res, 200, serializeJob(job));
        return;
      }
      // T5 Skill 接缝
      if (req.method === "GET" && url.pathname === "/v1/skills") {
        sendJson(res, 200, { skills });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/skills/proposals") {
        sendJson(res, 200, { proposals });
        return;
      }
      const proposalMatch = /^\/v1\/skills\/proposals\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (req.method === "POST" && proposalMatch !== null) {
        const proposal = proposals.find((p) => p.proposal_id === proposalMatch[1]);
        if (proposal === undefined) {
          sendJson(res, 404, { error: { code: "skill_proposal_not_found", message: "未知提案" } });
          return;
        }
        handleProposalDecide(proposal, proposalMatch[2], res);
        return;
      }
      // 其余 → 真实 Runtime
      await proxyToRuntime(req, res, url);
    } catch (err) {
      sendJson(res, 500, { error: { code: "fixture_error", message: String(err) } });
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
    version: "0.1.0",
    runtime: runtimeBase,
    front: `http://127.0.0.1:${frontPort}`,
    data_dir: config.dataDir,
    hint:
      `浏览器打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:${frontPort}（前置端口，` +
      `非接缝路径代理给真实 Runtime）。演示：清单/详情（web.fetch 双版本历史 + 回滚）/` +
      `预授权编辑（PUT grants 真实生效）/工厂全流程（约 8s 到待确认，确认后真实注册 csv.export）/` +
      `Skill 提案（prop-dangling 批准 → 悬空引用被拒呈现）。`,
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
