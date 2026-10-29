import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type SessionSummary } from "./api.ts";
import { resolveRuntimeBase } from "./runtime-endpoint.ts";
import { ChatView } from "./ChatView.tsx";
import { SessionList } from "./SessionList.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { HealthView } from "./HealthView.tsx";

/**
 * 桌面壳根组件：解析控制面地址（sidecar ready）→ 顶栏导航（会话 / 设置 / 健康）。
 * 会话数据都来自控制面 HTTP/SSE（api.ts / EventSource），壳不做私有通道；
 * 设置与健康页（票 T7 / Issue #8）同样只走控制面 API。
 * 导航整合是 M0 简化：PRD §5.1 的「设置 → Provider 与模型」扁平为一级页签。
 */
type View = "chat" | "settings" | "health";

const NAV_ITEMS: { key: View; label: string }[] = [
  { key: "chat", label: "会话" },
  { key: "settings", label: "设置" },
  { key: "health", label: "健康" },
];

export default function App() {
  const [base, setBase] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    resolveRuntimeBase()
      .then(setBase)
      .catch((err: unknown) => setBootError(err instanceof Error ? err.message : String(err)));
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!base) return;
    try {
      setSessions(await api.listSessions(base));
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [base]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const createSession = useCallback(async () => {
    if (!base) return;
    setCreating(true);
    try {
      const { session_id } = await api.createSession(base);
      await refreshSessions();
      setSelectedId(session_id);
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setCreating(false);
    }
  }, [base, refreshSessions]);

  if (bootError !== null) {
    return (
      <div className="boot boot-error">
        <h1>Morrow</h1>
        <p>{bootError}</p>
        <p className="hint">Runtime sidecar 由桌面壳拉起；若反复失败请查看应用日志（app_log_dir/sidecar.log）。</p>
      </div>
    );
  }
  if (base === null) {
    return (
      <div className="boot">
        <h1>Morrow</h1>
        <p>正在启动 Runtime sidecar…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Morrow</span>
        <nav className="topnav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={view === item.key ? "nav-item selected" : "nav-item"}
              onClick={() => setView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      {view === "chat" && (
        <div className="chat-layout">
          <aside className="sidebar">
            <div className="sidebar-head">
              <span className="sidebar-title">会话</span>
              <button onClick={() => void createSession()} disabled={creating}>
                {creating ? "创建中…" : "新建会话"}
              </button>
            </div>
            <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
            {listError !== null && <div className="list-error">{listError}</div>}
            <div className="sidebar-foot">控制面 {base.replace("http://", "")}</div>
          </aside>
          <main className="main">
            {selectedId === null ? (
              <div className="boot">
                <p>选择左侧会话，或新建一个开始对话。</p>
              </div>
            ) : (
              <ChatView key={selectedId} base={base} sessionId={selectedId} />
            )}
          </main>
        </div>
      )}
      {view === "settings" && (
        <main className="main page-host">
          <SettingsView base={base} />
        </main>
      )}
      {view === "health" && (
        <main className="main page-host">
          <HealthView base={base} />
        </main>
      )}
    </div>
  );
}
