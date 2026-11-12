import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type SessionSummary } from "./api.ts";
import { resolveRuntimeBase } from "./runtime-endpoint.ts";
import { ChatView } from "./ChatView.tsx";
import { SessionList } from "./SessionList.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { HealthView } from "./HealthView.tsx";
import { TaskView } from "./TaskView.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import { ThemeToggle } from "./design-system/ThemeToggle.tsx";
import { applyTheme, getInitialTheme, saveTheme, type Theme } from "./design-system/theme.ts";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { EphemeralPanel } from "./EphemeralPanel.tsx";

/**
 * 桌面壳根组件：解析控制面地址（sidecar ready）→ 顶栏导航（会话 / 任务 / 设置 / 健康）。
 * 会话数据都来自控制面 HTTP/SSE（api.ts / EventSource），壳不做私有通道；
 * 设置与健康页（票 T7 / Issue #8）同样只走控制面 API。
 * 导航整合是 M0 简化：PRD §5.1 的「设置 → Provider 与模型」扁平为一级页签；
 * 「设置 → 能力管理」（票 M2-T6 / Issue #27）落在设置页的子页签。
 * 任务页签（票 M1-T6 / Issue #18）：PRD §5.1 Task 视图简版；Chat 任务卡片经
 * openTaskId 跳转（路由从简：壳内 state 传递，不引路由库）。
 * 能力引用卡（票 M2-T6）：Task 节点用到的能力芯片经 openCapabilityName 跳到设置→能力管理。
 */
type View = "chat" | "tasks" | "settings" | "health";

const NAV_ITEMS: { key: View; label: string }[] = [
  { key: "chat", label: "会话" },
  { key: "tasks", label: "任务" },
  { key: "settings", label: "设置" },
  { key: "health", label: "健康" },
];

export default function App() {
  const [base, setBase] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [openCapabilityName, setOpenCapabilityName] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [ephemeralId, setEphemeralId] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "light" ? "dark" : "light"));
  }, []);

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

  /** 临时会话（票 M7-A-T3）：右上角按钮 → 右侧独立面板；已打开时只切回会话视图 */
  const openEphemeral = useCallback(async () => {
    setView("chat");
    if (!base || ephemeralId !== null) return;
    try {
      const { session_id } = await api.createEphemeralSession(base);
      await refreshSessions();
      setEphemeralId(session_id);
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [base, ephemeralId, refreshSessions]);

  /** 会话元数据（M7-A-T2）：改名/归档/删除都写账本事件，刷新即折叠结果。 */
  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      if (!base) return;
      await api.renameSession(base, sessionId, title);
      await refreshSessions();
    },
    [base, refreshSessions],
  );

  const archiveSession = useCallback(
    async (sessionId: string) => {
      if (!base) return;
      await api.archiveSession(base, sessionId);
      setSelectedId((current) => (current === sessionId ? null : current));
      await refreshSessions();
    },
    [base, refreshSessions],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!base) return;
      await api.deleteSession(base, sessionId);
      setSelectedId((current) => (current === sessionId ? null : current));
      await refreshSessions();
    },
    [base, refreshSessions],
  );

  /** Chat 任务卡片 → Task 视图（路由从简：切页签 + 预选任务） */
  const openTask = useCallback((taskId: string) => {
    setOpenTaskId(taskId);
    setView("tasks");
  }, []);

  /** Task 节点面板的能力引用芯片 → 设置 → 能力管理（预选该能力详情） */
  const openCapability = useCallback((name: string) => {
    setOpenCapabilityName(name);
    setView("settings");
  }, []);

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
      <GlassSurface as="header" className="topbar">
        <span className="brand">Morrow</span>
        <nav className="topnav">
          {NAV_ITEMS.map((item) => (
            <Button
              key={item.key}
              variant="nav"
              selected={view === item.key}
              onClick={() => setView(item.key)}
            >
              {item.label}
            </Button>
          ))}
        </nav>
        <div className="topbar-actions">
          <Button variant="ghost" size="sm" selected={ephemeralId !== null} onClick={() => void openEphemeral()}>
            临时会话
          </Button>
          <NotificationCenter base={base} onOpenTask={openTask} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </GlassSurface>
      {view === "chat" && (
        <div className="chat-layout">
          <GlassSurface as="aside" className="sidebar">
            <div className="sidebar-head">
              <span className="sidebar-title">会话</span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void createSession()}
                disabled={creating}
              >
                {creating ? "创建中…" : "新建会话"}
              </Button>
            </div>
            <SessionList
              sessions={sessions.filter((session) => session.kind !== "ephemeral")}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRename={renameSession}
              onArchive={archiveSession}
              onDelete={deleteSession}
            />
            {listError !== null && <div className="list-error">{listError}</div>}
            <div className="sidebar-foot">控制面 {base.replace("http://", "")}</div>
          </GlassSurface>
          <main className="main">
            {selectedId === null ? (
              <div className="boot">
                <p>选择左侧会话，或新建一个开始对话。</p>
              </div>
            ) : (
              <ChatView
                key={selectedId}
                base={base}
                sessionId={selectedId}
                onOpenTask={openTask}
                onOpenSettings={() => setView("settings")}
              />
            )}
          </main>
          {ephemeralId !== null && (
            <EphemeralPanel base={base} sessionId={ephemeralId} onExit={() => setEphemeralId(null)} />
          )}
        </div>
      )}
      {view === "tasks" && (
        <main className="main page-host">
          <TaskView base={base} initialTaskId={openTaskId} onOpenCapability={openCapability} />
        </main>
      )}
      {view === "settings" && (
        <main className="main page-host">
          <SettingsView base={base} initialCapabilityName={openCapabilityName} />
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
