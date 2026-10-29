/**
 * 设置与健康 UI 的联调夹具（票 T7 / Issue #8）：真实 Runtime（Provider CRUD + 连通性测试 +
 * 会话族）+ 四条 mock 连通性路径 + 脚本化 Agent（会话回合无网络）。
 *
 * 与 apps/runtime/scripts/dev-fixture.ts 的差别：那里验证 Chat 流，这里验证设置页——
 * 连通性测试端点会真实 fetch 注册的 base_url，所以夹具本地伺服 OpenAI 兼容端点的
 * 三种应答（200 / 401 / 500），外加一个「无人监听端口」构成 unreachable。
 *
 *   node --experimental-sqlite --experimental-strip-types scripts/settings-fixture.ts
 *   # 然后浏览器打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<runtime_port>
 *
 * stdout 单行 ready JSON（runtime / mock 各端口都给出）；SIGTERM/SIGINT 优雅退出。
 * 密钥存内存 SecretStore（不碰用户钥匙串）；providers.json 落 MORROW_DATA_DIR（默认临时目录）。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySecretStore } from "../../runtime/src/keyring.ts";
import { loadConfig } from "../../runtime/src/config.ts";
import { startRuntime } from "../../runtime/src/runtime.ts";

/** 四条连通性测试路径：ok=200；auth=401；error=500；unreachable=无人监听端口 */
const mock: { ok: number; auth: number; error: number; unreachable: number } = {
  ok: await freePort(),
  auth: await freePort(),
  error: await freePort(),
  unreachable: await freePort(),
};

const servers: Server[] = [
  serveOpenAICompatible(mock.ok, 200, { id: "chatcmpl-ok", content: "pong" }),
  serveOpenAICompatible(mock.auth, 401, { error: { message: "invalid api key" } }),
  serveOpenAICompatible(mock.error, 500, { error: { message: "upstream exploded" } }),
];

const envDataDir = process.env.MORROW_DATA_DIR;
const dataDir = envDataDir ?? mkdtempSync(join(tmpdir(), "morrow-settings-"));
const config = { ...loadConfig(), dataDir };
const runtime = await startRuntime(config, {
  secretStore: createInMemorySecretStore(),
  agentAdapterFactory: async () => createScriptedAgent(),
});

console.log(
  JSON.stringify({
    ready: true,
    fixture: "settings",
    version: "0.1.0",
    host: runtime.host,
    port: runtime.port,
    data_dir: config.dataDir,
    mock,
    hint: `浏览器打开 http://127.0.0.1:1420/?runtime=http://${runtime.host}:${runtime.port}；` +
      `连通性四路径：http://127.0.0.1:${mock.ok}(ok) / :${mock.auth}(auth_failed) / :${mock.unreachable}(unreachable) / :${mock.error}(error)`,
  }),
);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const server of servers) server.close();
  void runtime
    .close(signal)
    .then(() => {
      console.log(JSON.stringify({ stopped: true, signal }));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("[settings-fixture] error during shutdown:", err);
      process.exit(1);
    });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/** OpenAI 兼容最小应答：POST /chat/completions → 指定状态码 + JSON；其余路径 404 */
function serveOpenAICompatible(port: number, status: number, body: unknown): Server {
  const server = createServer((req, res) => {
    if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/** 占位即释放，拿一个大概率空闲的端口（unreachable 路径用：无人监听 → ECONNREFUSED） */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("no port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 脚本化 Agent（同 dev-fixture 的最小回声版）：让「建会话 → 发消息」无需真实模型即可走通 */
function createScriptedAgent() {
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async prompt(input: string | { content: string }[]): Promise<void> {
      const text = typeof input === "string" ? input : input.map((m) => m.content).join(" ");
      emit({ type: "text_delta", delta: `settings-fixture 收到：「${text}」` });
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
