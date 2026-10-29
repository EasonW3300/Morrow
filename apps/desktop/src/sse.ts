/**
 * Chat 投影（纯逻辑，React 只做装配）。
 *
 * 帧 → 状态的归约实现 runtime SSE 的 durable/易失帧契约（apps/runtime README
 * 「SSE 会话事件流」，语义详见 sse.test.ts 头注释）：
 *   - durable 帧（账本事件，id = seq）按 seq 去重、顺序渲染；
 *   - text_delta（易失）只累积到 streaming 缓冲；
 *   - message.assistant（权威全文）到达即覆盖易失累积；
 *   - done 关轮并清残留易失文本。
 */
import type { MessageRecord } from "./api.ts";

export interface Envelope {
  event_id: string;
  event_type: string;
  occurred_at: string;
  session_id: string | null;
  payload: Record<string, unknown>;
}

export type Frame =
  | { type: "event"; sequence: number; envelope: Envelope }
  | { type: "delta"; delta: string }
  | { type: "done" };

export type ChatItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      messageId: string;
      text: string;
      stopReason?: string;
      sequence: number;
      occurredAt: string;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      argsText: string;
      resultText: string;
      isError: boolean;
      durationMs?: number;
      finished: boolean;
      sequence: number;
    }
  | { kind: "error"; message: string; sequence: number };

export interface ChatState {
  items: ChatItem[];
  /** 本轮易失文本增量累积（text_delta） */
  streaming: string;
  /** message.user 与 done 之间为 true（渲染「生成中」指示） */
  turnActive: boolean;
  /** 已应用的最大 durable seq（重连重放去重边界） */
  lastSeq: number;
}

export function emptyChatState(): ChatState {
  return { items: [], streaming: "", turnActive: false, lastSeq: 0 };
}

export function applyFrame(state: ChatState, frame: Frame): ChatState {
  switch (frame.type) {
    case "delta":
      return { ...state, streaming: state.streaming + frame.delta, turnActive: true };
    case "done":
      // message.assistant 已先行（权威全文）；工厂失败轮没有 assistant，易失残留一并清掉
      return { ...state, turnActive: false, streaming: "" };
    case "event":
      return applyEvent(state, frame.sequence, frame.envelope);
  }
}

function applyEvent(state: ChatState, sequence: number, envelope: Envelope): ChatState {
  if (sequence <= state.lastSeq) {
    return state; // 重放/重连去重（durable 帧以账本 seq 为唯一序）
  }
  const payload = envelope.payload;
  switch (envelope.event_type) {
    case "message.user":
      return {
        ...state,
        lastSeq: sequence,
        turnActive: true,
        streaming: "",
        items: [
          ...state.items,
          {
            kind: "message",
            role: "user",
            messageId: String(payload.message_id ?? ""),
            text: String(payload.text ?? ""),
            sequence,
            occurredAt: envelope.occurred_at,
          },
        ],
      };
    case "tool.started":
      return {
        ...state,
        lastSeq: sequence,
        items: [
          ...state.items,
          {
            kind: "tool",
            toolCallId: String(payload.tool_call_id ?? ""),
            toolName: String(payload.tool_name ?? ""),
            argsText: stringifyPayload(payload.args),
            resultText: "",
            isError: false,
            finished: false,
            sequence,
          },
        ],
      };
    case "tool.finished":
      return { ...state, lastSeq: sequence, items: finishTool(state.items, payload, sequence) };
    case "agent.error":
      return {
        ...state,
        lastSeq: sequence,
        items: [
          ...state.items,
          { kind: "error", message: String(payload.message ?? "unknown agent error"), sequence },
        ],
      };
    case "message.assistant":
      return {
        ...state,
        lastSeq: sequence,
        streaming: "", // 权威全文落地，易失累积作废
        items: [
          ...state.items,
          {
            kind: "message",
            role: "assistant",
            messageId: String(payload.message_id ?? ""),
            text: String(payload.text ?? ""),
            stopReason: String(payload.stop_reason ?? "stop"),
            sequence,
            occurredAt: envelope.occurred_at,
          },
        ],
      };
    default:
      // session.created 等非渲染事件：只推进游标（保持重放去重正确）
      return { ...state, lastSeq: sequence };
  }
}

/** tool.finished 就地补全对应 tool.started 项；缺失 started 时防御性自建（重放起点截断） */
function finishTool(items: ChatItem[], payload: Record<string, unknown>, sequence: number): ChatItem[] {
  const toolCallId = String(payload.tool_call_id ?? "");
  const index = items.findLastIndex(
    (item) => item.kind === "tool" && item.toolCallId === toolCallId && !item.finished,
  );
  const resultText = String(payload.text ?? "");
  const isError = payload.is_error === true;
  const durationMs =
    typeof payload.duration_ms === "number" ? (payload.duration_ms as number) : undefined;
  if (index === -1) {
    return [
      ...items,
      {
        kind: "tool",
        toolCallId,
        toolName: String(payload.tool_name ?? ""),
        argsText: "",
        resultText,
        isError,
        ...(durationMs !== undefined ? { durationMs } : {}),
        finished: true,
        sequence,
      },
    ];
  }
  return items.map((item, i) =>
    i === index && item.kind === "tool"
      ? {
          ...item,
          resultText,
          isError,
          ...(durationMs !== undefined ? { durationMs } : {}),
          finished: true,
        }
      : item,
  );
}

function stringifyPayload(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** GET /messages 投影 → 初始 ChatState（重启后历史可见；lastSeq 取最后一条消息 seq） */
export function stateFromHistory(messages: MessageRecord[]): ChatState {
  let lastSeq = 0;
  const items: ChatItem[] = messages.map((message) => {
    lastSeq = Math.max(lastSeq, message.sequence);
    return {
      kind: "message",
      role: message.role,
      messageId: message.message_id,
      text: message.text,
      ...(message.stop_reason !== undefined ? { stopReason: message.stop_reason } : {}),
      sequence: message.sequence,
      occurredAt: message.occurred_at,
    } satisfies ChatItem;
  });
  return { items, streaming: "", turnActive: false, lastSeq };
}
