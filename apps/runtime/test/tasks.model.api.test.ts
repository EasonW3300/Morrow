// 模型切换执行深度 e2e（票 M1-T6 / Issue #18，FR-TASK-3「切换模型对新节点生效」）：
// 生产默认节点工厂按注册 Provider id 解析 node.model——命中用该 Provider（其 model_id
// 出现在对 Provider base_url 的请求里），未命中回退默认 Provider。
// FakePi 只接管规划（脚本化 DAG）；节点执行走 createPiAdapter 真实管线，对本地 loopback
// mock 伺服的 OpenAI 兼容端点发请求——零外网。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import type { TaskDetail } from "@morrow/protocol";
import { createInMemorySecretStore } from "../src/keyring.ts";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function planScript(text: string): FakeStep[] {
  return [{ kind: "text", deltas: [text] }];
}

function planJson(nodes: unknown): string {
  return JSON.stringify({ nodes });
}

/** 节点 a 无 model（默认 Provider）；b 指定注册 Provider p-b；c 指定未注册的 ghost（回退默认） */
const PLAN = planJson([
  { key: "a", title: "A", goal: "do a", depends_on: [] },
  { key: "b", title: "B", goal: "do b", depends_on: [], model: "p-b" },
  { key: "c", title: "C", goal: "do c", depends_on: [], model: "ghost-provider" },
]);

interface MockRequest {
  model: string | undefined;
  lastUserText: string | undefined;
}

/** OpenAI 兼容 loopback mock：记录每次 chat/completions 的 model 与末条 user 消息 */
function serveOpenAIMock(records: MockRequest[]): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let model: string | undefined;
        let lastUserText: string | undefined;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            model?: string;
            messages?: Array<{ role: string; content?: unknown }>;
          };
          model = body.model;
          const messages = body.messages ?? [];
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
              const content = messages[i].content;
              lastUserText = typeof content === "string" ? content : JSON.stringify(content);
              break;
            }
          }
        } catch {
          // 记录不了就不记录（断言侧会看到缺请求）
        }
        records.push({ model, lastUserText });
        // pi-ai 的 openai-completions 客户端走 SSE 流式解析，终止条件是 finish_reason
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "mock-ok" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

test("default node factory resolves node.model to the registered provider; unknown model falls back to default", async () => {
  const records: MockRequest[] = [];
  const mock = await serveOpenAIMock(records);
  const mockPort = (mock.address() as { port: number }).port;
  const dir = tmpDir("morrow-model-switch-");
  try {
    const runtime = await startRuntime(
      { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null },
      {
        secretStore: createInMemorySecretStore(),
        // 规划脚本化（FakePi）；节点执行不注入 → 生产默认工厂（被测对象）
        taskPlannerFactory: async () => createFakePi({ script: planScript(PLAN) }),
      },
    );
    try {
      const base = `http://127.0.0.1:${runtime.port}`;
      const post = async (path: string, body: Record<string, unknown>): Promise<Response> =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // 注册两个 Provider（同 mock 端点、不同 model_id），p-a 为默认
      await post("/v1/providers", {
        provider_id: "p-a",
        name: "Default P",
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        model: "model-default",
        api_key: "sk-test",
      });
      await post("/v1/providers", {
        provider_id: "p-b",
        name: "Side P",
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        model: "model-side-b",
        api_key: "sk-test",
      });
      await post("/v1/providers/p-a/default", {});

      const created = await json<TaskDetail>(await post("/v1/tasks", { goal: "模型切换" }));
      assert.equal(created.status, "planned");
      await waitFor("task completes", async () => {
        const r = await fetch(`${base}/v1/tasks/${created.task_id}`);
        const detail = await json<TaskDetail>(r);
        return detail.status === "completed" || detail.status === "failed";
      });
      const detail = await json<TaskDetail>(await fetch(`${base}/v1/tasks/${created.task_id}`));
      assert.equal(detail.status, "completed", JSON.stringify(detail.error ?? ""));

      // 三个节点各打了一次 mock；model 字段即所解析 Provider 的 model_id
      const models = records.map((r) => r.model).sort();
      assert.deepEqual(models, ["model-default", "model-default", "model-side-b"]);
      // 节点 goal 到达对应请求（b 的指令走 p-b 的 model）
      const bRequest = records.find((r) => r.lastUserText?.includes("do b"));
      assert.equal(bRequest?.model, "model-side-b", "node.model=p-b → p-b 的 model_id");
      const cRequest = records.find((r) => r.lastUserText?.includes("do c"));
      assert.equal(cRequest?.model, "model-default", "未注册的 ghost-provider 回退默认 Provider");
    } finally {
      await runtime.close();
    }
  } finally {
    mock.close();
    removeDir(dir);
  }
});
