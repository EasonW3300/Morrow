import type { SessionSummary } from "./api.ts";

/** 会话侧栏列表（session.created 投影；标题缺省用短 id） */
export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  if (sessions.length === 0) {
    return <div className="session-empty">还没有会话</div>;
  }
  return (
    <ul className="sessions">
      {sessions.map((session) => (
        <li key={session.session_id}>
          <button
            className={session.session_id === selectedId ? "session-item selected" : "session-item"}
            onClick={() => onSelect(session.session_id)}
          >
            <span className="session-title">
              {session.title ?? `会话 ${session.session_id.slice(0, 8)}`}
            </span>
            <span className="session-time">{shortTime(session.occurred_at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
