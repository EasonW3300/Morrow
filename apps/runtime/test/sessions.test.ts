// 会话贯通 seam 测试（票 T4 / Issue #5，PRD §6.2 M0 子集）：
// POST/GET /v1/sessions、POST/GET /v1/sessions/:id/messages、GET /v1/sessions/:id/stream。
// Agent Loop 一律经 PiAdapter 接口注入（测试用 FakePi，无网络）；账本是唯一事实源。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface SessionCreated {
  session_id: string;
  event_id: string;
  sequence: number;
  occurred_at: string;
  title?: string;
}

interface SessionList {
  sessions: Array<{ session_id: string; event_id: string; sequence: number; title?: string }>;
}

interface HistoryBody {
  session_id: string;
  messages: Array<{
    message_id: string;
    role: "user" | "assistant";
    text: string;
    stop_reason?: string;
    event_id: string;
    sequence: number;
  }>;
}

interface SendAck {
  message_id: string;
  event_id: string;
  sequence: number;
  status: "processing" | "queued";
}

interface EventPage {
  events: EventEnvelope[];
  total: number;
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function fakeFactory(script: FakeStep[], tools: MorrowTool[] = []) {
  return async () => createFakePi({ script, tools });
}

/** FakePi 的 tool 步骤要求同名工具已注册，否则以 "Unknown tool" 失败收场 */
function toolNamed(name: string, text: string): MorrowTool {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ text }),
  };
}

/** 轮询直到条件成立或超时（Agent Loop 异步推进，测试以账本/HTTP 为观察点） */
async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function createSession(port: number, title?: string): Promise<SessionCreated> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
  assert.equal(res.status, 201);
  return json<SessionCreated>(res);
}

async function send(port: number, sessionId: string, text: string): Promise<SendAck> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
  return json<SendAck>(res);
}

async function history(port: number, sessionId: string): Promise<HistoryBody> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`);
  assert.equal(res.status, 200);
  return json<HistoryBody>(res);
}

async function sessionEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  const body = await json<EventPage>(res);
  return body.events.filter((e) => e.session_id !== null && e.session_id !== undefined);
}

test("POST /v1/sessions records session.created; GET /v1/sessions lists it", async () => {
  const dir = tmpDir("morrow-sess-create-");
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory([]) });
  try {
    const created = await createSession(runtime.port, "demo session");
    assert.match(created.session_id, /^[0-9a-f-]{36}$/);
    assert.match(created.event_id, /^[0-9a-f-]{36}$/);
    assert.ok(created.sequence >= 2); // runtime.started 之后
    assert.match(created.occurred_at, /Z$/);

    const list = await json<SessionList>(await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`));
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].session_id, created.session_id);
    assert.equal(list.sessions[0].title, "demo session");

    const events = await sessionEvents(runtime.port);
    const createdEvent = events.find((e) => e.event_type === "session.created");
    assert.ok(createdEvent, "session.created in ledger");
    assert.equal(createdEvent.session_id, created.session_id);
    assert.equal(createdEvent.actor_id, "owner");
    assert.equal(createdEvent.replica_id, REPLICA);
    assert.deepEqual(createdEvent.payload, { title: "demo session" });
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("invalid create/send bodies return 400 invalid_body", async () => {
  const dir = tmpDir("morrow-sess-body-");
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory([]) });
  try {
    const badCreates = ['{"title": 42}', "not-json", '{"title": ""}'];
    for (const body of badCreates) {
      const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(res.status, 400, body);
      const err = await json<ApiError>(res);
      assert.equal(err.error.code, "invalid_body", body);
    }
    const created = await createSession(runtime.port);
    const badSends = ['{"text": 42}', "{}", "not-json", '{"text": ""}'];
    for (const body of badSends) {
      const res = await fetch(
        `http://127.0.0.1:${runtime.port}/v1/sessions/${created.session_id}/messages`,
        { method: "POST", headers: { "content-type": "application/json" }, body },
      );
      assert.equal(res.status, 400, body);
      const err = await json<ApiError>(res);
      assert.equal(err.error.code, "invalid_body", body);
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("unknown session ids return 404 on messages/history/stream", async () => {
  const dir = tmpDir("morrow-sess-404-");
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory([]) });
  try {
    const ghost = "01936b9d-8f7a-7abc-9f2e-000000000001";
    const sendRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${ghost}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(sendRes.status, 404);
    assert.equal((await json<ApiError>(sendRes)).error.code, "not_found");

    const histRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${ghost}/messages`);
    assert.equal(histRes.status, 404);

    const streamRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${ghost}/stream`);
    assert.equal(streamRes.status, 404);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("sending a message drives the agent loop: ledger records user+assistant, history projects it", async () => {
  const dir = tmpDir("morrow-sess-loop-");
  const script: FakeStep[] = [{ kind: "text", deltas: ["Hello", " ", "world"] }];
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory(script) });
  try {
    const created = await createSession(runtime.port);
    const ack = await send(runtime.port, created.session_id, "Hi there");
    assert.equal(ack.status, "processing");
    assert.match(ack.message_id, /^[0-9a-f-]{36}$/);

    const sid = created.session_id;
    await waitFor("assistant message in history", async () =>
      (await history(runtime.port, sid)).messages.some((m) => m.role === "assistant"),
    );

    const hist = await history(runtime.port, sid);
    assert.equal(hist.session_id, sid);
    assert.equal(hist.messages.length, 2);
    assert.deepEqual(
      { role: hist.messages[0].role, text: hist.messages[0].text },
      { role: "user", text: "Hi there" },
    );
    assert.equal(hist.messages[0].message_id, ack.message_id);
    assert.deepEqual(
      { role: hist.messages[1].role, text: hist.messages[1].text, stop: hist.messages[1].stop_reason },
      { role: "assistant", text: "Hello world", stop: "stop" },
    );

    const events = await sessionEvents(runtime.port);
    const types = events.map((e) => e.event_type);
    assert.deepEqual(types, ["session.created", "message.user", "message.assistant"]);

    const userEvent = events[1];
    assert.equal(userEvent.actor_id, "owner");
    assert.equal(userEvent.payload.text, "Hi there");
    assert.equal(userEvent.payload.message_id, ack.message_id);

    const assistantEvent = events[2];
    assert.equal(assistantEvent.actor_id, "agent:runtime");
    assert.equal(assistantEvent.payload.text, "Hello world");
    assert.equal(assistantEvent.payload.stop_reason, "stop");
    assert.equal(assistantEvent.causation_id, userEvent.event_id, "assistant causation -> user message");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("tool runs record tool.started/tool.finished with a causation chain", async () => {
  const dir = tmpDir("morrow-sess-tool-");
  const script: FakeStep[] = [
    { kind: "tool", toolName: "echo", args: { x: 1 }, result: "echoed" },
    { kind: "text", deltas: ["done"] },
  ];
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(script, [toolNamed("echo", "echoed")]),
  });
  try {
    const created = await createSession(runtime.port);
    await send(runtime.port, created.session_id, "use the tool");
    const sid = created.session_id;
    await waitFor("assistant message in history", async () =>
      (await history(runtime.port, sid)).messages.some((m) => m.role === "assistant"),
    );

    const events = await sessionEvents(runtime.port);
    assert.deepEqual(
      events.map((e) => e.event_type),
      ["session.created", "message.user", "tool.started", "tool.finished", "message.assistant"],
    );

    const [user, toolStart, toolEnd, assistant] = events.slice(1);
    assert.equal(toolStart.payload.tool_name, "echo");
    assert.deepEqual(toolStart.payload.args, { x: 1 });
    assert.equal(toolStart.causation_id, user.event_id);

    assert.equal(toolEnd.payload.tool_call_id, toolStart.payload.tool_call_id);
    assert.equal(toolEnd.payload.tool_name, "echo");
    assert.equal(toolEnd.payload.text, "echoed");
    assert.equal(toolEnd.payload.is_error, false);
    assert.equal(toolEnd.causation_id, toolStart.event_id, "tool.finished causation -> tool.started");

    assert.equal(assistant.payload.text, "done");
    assert.equal(assistant.causation_id, user.event_id);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("tool failures are recorded with is_error, and provider errors record agent.error", async () => {
  const dir = tmpDir("morrow-sess-error-");
  const script: FakeStep[] = [
    { kind: "tool", toolName: "failing", error: "tool exploded" },
    { kind: "error", message: "provider down" },
  ];
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(script, [toolNamed("failing", "unused")]),
  });
  try {
    const created = await createSession(runtime.port);
    await send(runtime.port, created.session_id, "break things");
    const sid = created.session_id;
    await waitFor("assistant message in history", async () =>
      (await history(runtime.port, sid)).messages.some((m) => m.role === "assistant"),
    );

    const events = await sessionEvents(runtime.port);
    assert.deepEqual(
      events.map((e) => e.event_type),
      ["session.created", "message.user", "tool.started", "tool.finished", "agent.error", "message.assistant"],
    );

    const toolEnd = events[3];
    assert.equal(toolEnd.payload.is_error, true);
    assert.equal(toolEnd.payload.text, "tool exploded");

    const agentError = events[4];
    assert.equal(agentError.actor_id, "agent:runtime");
    assert.equal(agentError.payload.message, "provider down");

    const assistant = events[5];
    assert.equal(assistant.payload.stop_reason, "error");
    assert.equal(assistant.payload.text, "");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- SSE（GET /v1/sessions/:id/stream）--------------------------------------

interface SseFrame {
  event: string;
  id: string | null;
  data: string;
}

/** 从 fetch 响应收集 SSE 帧，直到 until 命中或超时（超时抛出已收帧帮助定位） */
async function collectSse(
  res: Response,
  until: (frames: SseFrame[]) => boolean,
  timeoutMs = 5000,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const reader = res.body?.getReader();
  assert.ok(reader, "response body must be readable");
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sse timeout; frames so far: ${JSON.stringify(frames)}`)), timeoutMs);
  });
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        let event = "message";
        let id: string | null = null;
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":") || line.length === 0) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value2 = colon === -1 ? "" : line.slice(colon + 1);
          if (value2.startsWith(" ")) value2 = value2.slice(1);
          if (field === "event") event = value2;
          else if (field === "id") id = value2;
          else if (field === "data") data.push(value2);
        }
        frames.push({ event, id, data: data.join("\n") });
      }
      if (until(frames)) {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  })();
  try {
    await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function eventTypeSequence(frames: SseFrame[]): Array<{ id: string | null; event: string }> {
  return frames.map((f) => ({ id: f.id, event: f.event }));
}

test("SSE after a run: frames replay the ledger in sequence order and end with done", async () => {
  const dir = tmpDir("morrow-sse-replay-");
  const script: FakeStep[] = [
    { kind: "tool", toolName: "echo", args: { x: 1 }, result: "echoed" },
    { kind: "text", deltas: ["done"] },
  ];
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(script, [toolNamed("echo", "echoed")]),
  });
  try {
    const created = await createSession(runtime.port);
    const sid = created.session_id;
    await send(runtime.port, sid, "use the tool");
    await waitFor("assistant message in history", async () =>
      (await history(runtime.port, sid)).messages.some((m) => m.role === "assistant"),
    );

    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sid}/stream`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const frames = await collectSse(res, (f) => f.filter((x) => x.event === "done").length >= 1);
    assert.deepEqual(
      eventTypeSequence(frames),
      [
        { id: String(created.sequence), event: "session.created" },
        { id: String(created.sequence + 1), event: "message.user" },
        { id: String(created.sequence + 2), event: "tool.started" },
        { id: String(created.sequence + 3), event: "tool.finished" },
        { id: String(created.sequence + 4), event: "message.assistant" },
        { id: null, event: "done" },
      ],
      "durable frames carry the ledger seq as id, in ledger order, then done",
    );

    // SSE 信封与账本原文逐字节一致（data 即信封 JSON）
    const events = await sessionEvents(runtime.port);
    const dataFrames = frames.filter((f) => f.id !== null);
    assert.equal(dataFrames.length, events.length);
    for (let i = 0; i < events.length; i++) {
      assert.deepEqual(JSON.parse(dataFrames[i].data), events[i]);
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("SSE connected before sending: live text deltas, tool events and done, deltas without id", async () => {
  const dir = tmpDir("morrow-sse-live-");
  const script: FakeStep[] = [
    { kind: "tool", toolName: "echo", args: {}, result: "ok" },
    { kind: "text", deltas: ["Hello", " ", "world"] },
  ];
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(script, [toolNamed("echo", "ok")]),
  });
  try {
    const created = await createSession(runtime.port);
    const sid = created.session_id;

    // 连接时空闲：重放已有事件 + done（易失，无 id）；随后发送，帧应实时到达
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sid}/stream`);
    const collected = collectSse(res, (f) => f.filter((x) => x.event === "done").length >= 2, 8000);
    await send(runtime.port, sid, "stream me");
    const frames = await collected;

    assert.deepEqual(
      eventTypeSequence(frames),
      [
        { id: String(created.sequence), event: "session.created" },
        { id: null, event: "done" },
        { id: String(created.sequence + 1), event: "message.user" },
        { id: String(created.sequence + 2), event: "tool.started" },
        { id: String(created.sequence + 3), event: "tool.finished" },
        { id: null, event: "text_delta" },
        { id: null, event: "text_delta" },
        { id: null, event: "text_delta" },
        { id: String(created.sequence + 4), event: "message.assistant" },
        { id: null, event: "done" },
      ],
      "deltas have no id (transient), ledger events are seq-id'd in order",
    );

    const deltas = frames.filter((f) => f.event === "text_delta");
    assert.equal(deltas.map((f) => JSON.parse(f.data).delta as string).join(""), "Hello world");

    const assistantFrame = frames.filter((f) => f.id !== null && f.event === "message.assistant")[0];
    assert.equal(JSON.parse(assistantFrame.data).payload.text, "Hello world");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("Last-Event-ID resumes the stream: only ledger events after the given seq are replayed", async () => {
  const dir = tmpDir("morrow-sse-resume-");
  const script: FakeStep[] = [
    { kind: "tool", toolName: "echo", args: {}, result: "ok" },
    { kind: "text", deltas: ["done"] },
  ];
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(script, [toolNamed("echo", "ok")]),
  });
  try {
    const created = await createSession(runtime.port);
    const sid = created.session_id;
    await send(runtime.port, sid, "use the tool");
    await waitFor("assistant message in history", async () =>
      (await history(runtime.port, sid)).messages.some((m) => m.role === "assistant"),
    );

    // 客户端已见到 message.user（seq = created.sequence + 1），断线重连
    const lastId = created.sequence + 1;
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sid}/stream`, {
      headers: { "last-event-id": String(lastId) },
    });
    const frames = await collectSse(res, (f) => f.filter((x) => x.event === "done").length >= 1);
    const durable = frames.filter((f) => f.id !== null);
    assert.deepEqual(
      durable.map((f) => f.event),
      ["tool.started", "tool.finished", "message.assistant"],
      "events up to last-event-id are not replayed",
    );
    for (const frame of durable) assert.ok(Number(frame.id) > lastId);
    // 断连期间的流式增量不可恢复（易失），但权威全文随 message.assistant 重放
    assert.equal(JSON.parse(durable[2].data).payload.text, "done");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("invalid last-event-id returns 400; mutation methods on stream/messages are 405", async () => {
  const dir = tmpDir("morrow-sse-guard-");
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory([]) });
  try {
    const created = await createSession(runtime.port);
    const sid = created.session_id;
    const bad = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sid}/stream`, {
      headers: { "last-event-id": "yesterday" },
    });
    assert.equal(bad.status, 400);
    assert.equal((await json<ApiError>(bad)).error.code, "invalid_query");

    const postStream = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sid}/stream`, {
      method: "POST",
    });
    assert.equal(postStream.status, 405);
    const putMessages = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${sid}/messages`, {
      method: "PUT",
    });
    assert.equal(putMessages.status, 405);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- 串行 / 中断 / 未配置 Provider -------------------------------------------

test("an aborted run records a partial assistant turn and the session continues cleanly", async () => {
  const dir = tmpDir("morrow-sess-abort-");
  // FakePi 每轮重放同一 script 数组；中断后换脚本内容，验证会话可继续
  const script: FakeStep[] = [{ kind: "hang" }];
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory(script) });
  try {
    const created = await createSession(runtime.port);
    const sid = created.session_id;
    await send(runtime.port, sid, "hang please");
    await waitFor("message.user in ledger", async () =>
      (await sessionEvents(runtime.port)).some((e) => e.event_type === "message.user"),
    );

    runtime.sessions.abort(sid);
    await waitFor("aborted assistant in history", async () =>
      (await history(runtime.port, sid)).messages.some((m) => m.role === "assistant" && m.stop_reason === "aborted"),
    );

    // 中断不污染：账本里事件一个不少、顺序完好
    const afterAbort = await sessionEvents(runtime.port);
    assert.deepEqual(
      afterAbort.map((e) => e.event_type),
      ["session.created", "message.user", "message.assistant"],
    );
    assert.equal(afterAbort[2].payload.stop_reason, "aborted");

    // 继续对话：新脚本，正常运行
    script.length = 0;
    script.push({ kind: "text", deltas: ["after", "-abort"] });
    await send(runtime.port, sid, "continue");
    await waitFor("second assistant in history", async () => (await history(runtime.port, sid)).messages.length === 4);

    const hist = await history(runtime.port, sid);
    assert.deepEqual(
      hist.messages.map((m) => `${m.role}:${m.text}${m.stop_reason ? `(${m.stop_reason})` : ""}`),
      ["user:hang please", "assistant:(aborted)", "user:continue", "assistant:after-abort(stop)"],
    );

    const events = await sessionEvents(runtime.port);
    assert.deepEqual(
      events.map((e) => e.event_type),
      ["session.created", "message.user", "message.assistant", "message.user", "message.assistant"],
      "interrupted turn keeps its record; next turn appends after it",
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("concurrent sends to one session are serialized: runs never interleave in the ledger", async () => {
  const dir = tmpDir("morrow-sess-concurrent-");
  const script: FakeStep[] = [
    { kind: "tool", toolName: "echo", args: {}, result: "ok" },
    { kind: "text", deltas: ["reply"] },
  ];
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory(script, [toolNamed("echo", "ok")]),
  });
  try {
    const created = await createSession(runtime.port);
    const sid = created.session_id;

    const [ack1, ack2] = await Promise.all([
      send(runtime.port, sid, "first"),
      send(runtime.port, sid, "second"),
    ]);
    assert.notEqual(ack1.message_id, ack2.message_id);

    await waitFor("both assistant turns in history", async () =>
      (await history(runtime.port, sid)).messages.filter((m) => m.role === "assistant").length === 2,
    );

    const events = await sessionEvents(runtime.port);
    const toolStarts = events.filter((e) => e.event_type === "tool.started");
    const assistants = events.filter((e) => e.event_type === "message.assistant");
    assert.equal(toolStarts.length, 2);
    assert.equal(assistants.length, 2);
    // /v1/events 按 seq 升序返回，单副本下数组下标即账本顺序
    const indexOf = (e: EventEnvelope) => events.findIndex((x) => x.event_id === e.event_id);
    const firstAssistantIdx = indexOf(assistants[0].payload.text === "reply" ? assistants[0] : assistants[1]);
    assert.ok(
      indexOf(toolStarts[1]) > firstAssistantIdx,
      "second run's tool.started must come after the first run's message.assistant (runs never interleave)",
    );
    assert.ok(indexOf(toolStarts[0]) < firstAssistantIdx);

    // 历史按账本顺序投影：user/assistant 交替且两条输入都在
    const hist = await history(runtime.port, sid);
    assert.deepEqual(
      hist.messages.map((m) => [m.role, m.text]),
      [
        ["user", "first"],
        ["assistant", "reply"],
        ["user", "second"],
        ["assistant", "reply"],
      ],
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("without provider config or factory, sending returns 503 and records nothing", async () => {
  const dir = tmpDir("morrow-sess-503-");
  const runtime = await startRuntime(testConfig(dir)); // provider: null 且无 factory
  try {
    const created = await createSession(runtime.port);
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${created.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(res.status, 503);
    const err = await json<ApiError>(res);
    assert.equal(err.error.code, "provider_not_configured");
    assert.match(err.error.message, /MORROW_PROVIDER_BASE_URL/);

    const events = await sessionEvents(runtime.port);
    assert.deepEqual(
      events.map((e) => e.event_type),
      ["session.created"],
      "user input is not recorded when the loop cannot run",
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
