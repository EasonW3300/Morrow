import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.ts";
import {
  applyFrame,
  emptyChatState,
  stateFromHistory,
  type ChatItem,
  type ChatState,
  type Envelope,
  type Frame,
} from "./sse.ts";

/**
 * Chat 视图（票 T6 验收核心）：
 * - 历史先到：GET /messages 投影播种（重启后历史可见）；
 * - 再挂 SSE：GET /sessions/:id/stream，durable 帧按 seq 去重续放（重连自动 Last-Event-ID），
 *   text_delta 易失累积，message.assistant 权威全文覆盖；
 * - 工具事件（tool.started/finished）与 agent.error 直接可见；
 * - 发送失败（如 503 provider_not_configured）以可读横幅呈现。
 * 所有通信仅经控制面 HTTP/SSE（fetch + EventSource）。
 */

/** durable 账本事件帧（SSE event 名 = event_type，data = 信封 JSON，id = seq） */
const DURABLE_EVENTS = [
  "session.created",
  "message.user",
  "tool.started",
  "tool.finished",
  "agent.error",
  "message.assistant",
] as const;

const ALL_FRAME_EVENTS: readonly string[] = [...DURABLE_EVENTS, "text_delta", "done"];

export function ChatView({ base, sessionId }: { base: string; sessionId: string }) {
  const [state, setState] = useState<ChatState>(emptyChatState());
  const [streamError, setStreamError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    setState(emptyChatState());
    setStreamError(null);

    void (async () => {
      // 1) 历史播种（失败不阻塞：SSE 全量重放同样能重建 durable 投影）
      try {
        const history = await api.history(base, sessionId);
        if (!cancelled) setState(stateFromHistory(history.messages));
      } catch {
        // 忽略：交给 SSE 重放兜底
      }
      // 2) SSE 流：先重放后 live，浏览器自动带 Last-Event-ID 重连
      source = new EventSource(`${base}/v1/sessions/${sessionId}/stream`);
      const handleFrame = (event: MessageEvent<string>) => {
        if (cancelled) return;
        try {
          const frame = parseFrame(event);
          setState((prev) => applyFrame(prev, frame));
        } catch {
          // 单帧畸形不拖垮整个流
        }
      };
      for (const type of ALL_FRAME_EVENTS) {
        source.addEventListener(type, handleFrame as EventListener);
      }
      source.onopen = () => {
        if (!cancelled) setConnected(true);
      };
      source.onerror = () => {
        if (!cancelled) setConnected(false); // EventSource 自动重连
      };
    })();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [base, sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state]);

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    setDraft("");
    try {
      await api.sendMessage(base, sessionId, text);
    } catch (err) {
      setStreamError(
        err instanceof ApiError ? `${readableCode(err.code)}（${err.code}）：${err.message}` : String(err),
      );
      setDraft(text); // 发送失败把输入还回去
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat">
      <div className={`stream-status ${connected ? "ok" : "down"}`}>
        {connected ? "已连接 Runtime 事件流" : "事件流连接中/断开（自动重连）"}
      </div>
      {streamError !== null && (
        <div className="banner-error" role="alert">
          {streamError}
        </div>
      )}
      <div className="messages">
        {state.items.map((item, index) => (
          <ItemRow key={itemKey(item, index)} item={item} />
        ))}
        {state.turnActive && (
          <div className="bubble assistant streaming">
            {state.streaming.length > 0 ? state.streaming : "…"}
            <span className="cursor">▌</span>
          </div>
        )}
        {state.items.length === 0 && !state.turnActive && (
          <div className="empty-chat">发送第一条消息开始对话</div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        <textarea
          value={draft}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button onClick={() => void send()} disabled={sending || draft.trim().length === 0}>
          发送
        </button>
      </div>
    </div>
  );
}

function itemKey(item: ChatItem, index: number): string {
  return `${item.kind}-${item.sequence}-${index}`;
}

/** SSE MessageEvent → 归约帧：durable 帧序号取 id（账本 seq），易失帧无 id */
function parseFrame(event: MessageEvent<string>): Frame {
  if (event.type === "text_delta") {
    const data = JSON.parse(event.data) as { delta?: unknown };
    return { type: "delta", delta: String(data.delta ?? "") };
  }
  if (event.type === "done") {
    return { type: "done" };
  }
  const envelope = JSON.parse(event.data) as Envelope;
  return { type: "event", sequence: Number(event.lastEventId), envelope };
}

function ItemRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "message":
      return (
        <div className={`bubble ${item.role}`}>
          <div className="bubble-text">{item.text}</div>
          {item.role === "assistant" && item.stopReason !== undefined && item.stopReason !== "stop" && (
            <div className="bubble-meta">{stopReasonLabel(item.stopReason)}</div>
          )}
        </div>
      );
    case "tool":
      return (
        <details className={`tool-row ${item.isError ? "tool-error" : ""}`}>
          <summary>
            <span className="tool-state">{item.finished ? (item.isError ? "✗" : "✓") : "⋯"}</span>
            工具 <code>{item.toolName}</code>
            {item.finished ? (
              <span className="tool-meta">
                {item.durationMs !== undefined ? ` ${item.durationMs}ms` : ""}
                {item.isError ? " 失败" : ""}
              </span>
            ) : (
              <span className="tool-meta">运行中</span>
            )}
          </summary>
          <div className="tool-body">
            {item.argsText.length > 0 && <pre className="tool-args">{item.argsText}</pre>}
            {item.resultText.length > 0 && <pre className="tool-result">{item.resultText}</pre>}
          </div>
        </details>
      );
    case "error":
      return (
        <div className="agent-error" role="alert">
          <span className="agent-error-label">agent.error</span>
          {item.message}
        </div>
      );
  }
}

function readableCode(code: string): string {
  switch (code) {
    case "provider_not_configured":
      return "尚未配置模型 Provider";
    case "invalid_body":
      return "请求体非法";
    case "not_found":
      return "会话不存在";
    case "http_503":
      return "Runtime 拒绝服务";
    default:
      return "请求失败";
  }
}

function stopReasonLabel(reason: string): string {
  switch (reason) {
    case "aborted":
      return "已中断";
    case "error":
      return "错误收尾";
    case "length":
      return "达到长度上限";
    case "toolUse":
      return "工具调用收尾";
    default:
      return `stop_reason: ${reason}`;
  }
}
