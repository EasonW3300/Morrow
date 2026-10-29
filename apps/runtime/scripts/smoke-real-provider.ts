/**
 * 真实 Provider 冒烟脚本（票 T4 / Issue #5 验收：真实 Provider 仅作冒烟）。
 *
 * 手动执行——默认测试套件不依赖网络与真实密钥：
 *
 *   MORROW_PROVIDER_BASE_URL="https://api.example.com/v1" \
 *   MORROW_PROVIDER_API_KEY="sk-..." \
 *   MORROW_PROVIDER_MODEL="gpt-..." \
 *   node --experimental-sqlite --experimental-strip-types scripts/smoke-real-provider.ts
 *
 * 兼容任何 OpenAI Chat Completions 端点（vLLM/Ollama 免密：API_KEY 留空或不给）。
 * 流程：临时数据目录起 runtime → 建会话 → 订阅 SSE → 发消息 → 打印每一帧 →
 * 打印账本事件与历史投影 → 优雅退出（退出码 0 = 冒烟通过）。
 * 可选 MORROW_SMOKE_TEXT 覆盖发送文本；MORROW_SMOKE_EXPECT 工具冒烟未包含（M0 无注册工具）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../src/runtime.ts";

const baseUrl = process.env.MORROW_PROVIDER_BASE_URL;
const model = process.env.MORROW_PROVIDER_MODEL;
if (!baseUrl || !model) {
  console.error("usage: MORROW_PROVIDER_BASE_URL=... MORROW_PROVIDER_MODEL=... [MORROW_PROVIDER_API_KEY=...] " +
    "node --experimental-sqlite --experimental-strip-types scripts/smoke-real-provider.ts");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "morrow-smoke-"));
const runtime = await startRuntime({
  host: "127.0.0.1",
  port: 0,
  dataDir: dir,
  replicaId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  provider: {
    baseUrl,
    apiKey: process.env.MORROW_PROVIDER_API_KEY ?? "",
    modelId: model,
    contextWindow: Number(process.env.MORROW_PROVIDER_CONTEXT_WINDOW ?? "131072"),
    maxTokens: Number(process.env.MORROW_PROVIDER_MAX_TOKENS ?? "8192"),
  },
});

const base = `http://127.0.0.1:${runtime.port}`;
const text = process.env.MORROW_SMOKE_TEXT ?? "用一句话介绍你自己。";

let exitCode = 0;
try {
  const created = await (await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "provider smoke" }),
  })).json();
  const sessionId = created.session_id;
  console.log(`[smoke] session ${sessionId}`);

  // 先开 SSE，再发消息：帧按 text_delta / 账本事件 / done 实时打印
  const stream = await fetch(`${base}/v1/sessions/${sessionId}/stream`);
  const collected = (async () => {
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // 连接时若空闲会先收到一个 done（空闲标记）；只认 message.assistant / agent.error
    // 之后的 done（本轮结束标记），避免把首个 done 误当收尾。
    let sawRunTerminal = false;
    let ended = false;
    while (!ended) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        if (event === "text_delta") process.stdout.write(`[sse] text_delta: ${JSON.parse(data).delta}`);
        else if (event === "done" && sawRunTerminal) { console.log("[sse] done (本轮结束)"); ended = true; }
        else if (event === "message.assistant" || event === "agent.error") {
          sawRunTerminal = true;
          console.log(`[sse] ${event} (seq ${/^id: (.*)$/m.exec(block)?.[1] ?? "?"})`);
        } else if (event !== "done") console.log(`[sse] ${event} (seq ${/^id: (.*)$/m.exec(block)?.[1] ?? "?"})`);
      }
    }
    await reader.cancel().catch(() => {});
  })();

  const sendRes = await fetch(`${base}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  console.log(`[smoke] POST messages -> ${sendRes.status} ${JSON.stringify(await sendRes.json())}`);
  if (sendRes.status !== 202) throw new Error(`send failed: ${sendRes.status}`);
  await collected;

  const ledgerRes = await fetch(`${base}/v1/events?limit=200`);
  const ledger = await ledgerRes.json();
  console.log("[smoke] ledger session events:");
  for (const envelope of ledger.events) {
    if (envelope.session_id === sessionId) {
      console.log(`  ${envelope.event_type}  actor=${envelope.actor_id}  payload=${JSON.stringify(envelope.payload)}`);
    }
  }

  const hist = await (await fetch(`${base}/v1/sessions/${sessionId}/messages`)).json();
  console.log("[smoke] history projection:");
  for (const message of hist.messages) {
    console.log(`  ${message.role}: ${message.text}${message.stop_reason ? ` (stop: ${message.stop_reason})` : ""}`);
  }

  const assistant = hist.messages.filter((m) => m.role === "assistant");
  if (assistant.length === 0 || assistant[0].stop_reason === "error") {
    throw new Error("no successful assistant turn");
  }
  console.log("[smoke] OK");
} catch (err) {
  console.error("[smoke] FAILED:", err);
  exitCode = 1;
} finally {
  await runtime.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
