import { useEffect, useState } from "react";
import { ApiError, type SessionSummary } from "./api.ts";
import { useConfirm } from "./design-system/ConfirmDialog.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import {
  closeSessionMenu,
  deleteSessionConfirmMessage,
  deleteSessionConfirmTitle,
  openSessionMenu,
  sessionActions,
  toggleSessionMenu,
  validateSessionTitle,
  type SessionActionId,
  type SessionMenuState,
} from "./session-ui.ts";
import { workspaceDetail, workspaceLabel } from "./workspace-ui.ts";

/**
 * 会话侧栏列表（session.created + 元数据事件折叠投影；标题缺省用短 id）。
 * M7-A-T2（Issue #59）：行内「⋯」与右键菜单两个入口，动作含重命名（内联编辑）、
 * 归档、删除（二次确认写明记忆不受影响 + 30 天内可恢复）。
 */
export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onRename,
  onArchive,
  onDelete,
}: {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  onRename?: (sessionId: string, title: string) => Promise<void>;
  onArchive?: (sessionId: string) => Promise<void>;
  onDelete?: (sessionId: string) => Promise<void>;
}) {
  const [menu, setMenu] = useState<SessionMenuState>({ openFor: null });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  // 点击菜单外任意处收起（「⋯」/菜单内部带 data-session-menu 标记）
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-session-menu]") !== null) return;
      setMenu(closeSessionMenu());
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const startRename = (session: SessionSummary): void => {
    setMenu(closeSessionMenu());
    setRenamingId(session.session_id);
    setRenameDraft(session.title ?? "");
    setRenameError(null);
  };

  const cancelRename = (): void => {
    setRenamingId(null);
    setRenameError(null);
  };

  const submitRename = async (sessionId: string): Promise<void> => {
    const validation = validateSessionTitle(renameDraft);
    if (!validation.ok) {
      setRenameError(validation.message);
      return;
    }
    setBusy(true);
    setRenameError(null);
    try {
      await onRename?.(sessionId, validation.title);
      setRenamingId(null);
    } catch (err) {
      setRenameError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: SessionActionId, session: SessionSummary): Promise<void> => {
    setMenu(closeSessionMenu());
    setActionError(null);
    switch (action) {
      case "rename":
        startRename(session);
        return;
      case "archive":
        try {
          await onArchive?.(session.session_id);
        } catch (err) {
          setActionError(errorText(err));
        }
        return;
      case "delete": {
        const ok = await confirm({
          title: deleteSessionConfirmTitle(),
          message: deleteSessionConfirmMessage(),
          confirmLabel: "删除",
          cancelLabel: "取消",
          tone: "danger",
        });
        if (!ok) return;
        try {
          await onDelete?.(session.session_id);
        } catch (err) {
          setActionError(errorText(err));
        }
        return;
      }
      case "unarchive":
      case "restore":
        return;
    }
  };

  if (sessions.length === 0) {
    return <div className="session-empty">还没有会话</div>;
  }
  return (
    <>
      <ul className="sessions">
        {sessions.map((session) => {
          const renaming = renamingId === session.session_id;
          return (
            <li
              key={session.session_id}
              className="session-row"
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu(openSessionMenu(menu, session.session_id));
              }}
            >
              {renaming ? (
                <div className="session-rename">
                  <input
                    className="session-rename-input"
                    autoFocus
                    value={renameDraft}
                    placeholder="会话标题"
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitRename(session.session_id);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                  <div className="session-rename-actions">
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void submitRename(session.session_id)}>
                      保存
                    </Button>
                    <Button size="sm" onClick={cancelRename}>
                      取消
                    </Button>
                  </div>
                  {renameError !== null && <div className="session-rename-error">{renameError}</div>}
                </div>
              ) : (
                <>
                  <button
                    className={session.session_id === selectedId ? "session-item selected" : "session-item"}
                    onClick={() => onSelect(session.session_id)}
                  >
                    <span className="session-title">
                      {session.title ?? `会话 ${session.session_id.slice(0, 8)}`}
                    </span>
                    {session.workspace !== undefined && (
                      <span className="session-workspace" title={workspaceDetail(session.workspace)}>
                        {workspaceLabel(session.workspace)}
                      </span>
                    )}
                    <span className="session-time">{shortTime(session.occurred_at)}</span>
                  </button>
                  <button
                    className="session-menu-trigger"
                    aria-label="会话操作"
                    aria-haspopup="menu"
                    data-session-menu
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenu(toggleSessionMenu(menu, session.session_id));
                    }}
                  >
                    ⋯
                  </button>
                  {menu.openFor === session.session_id && (
                    <div className="session-menu" role="menu" data-session-menu>
                      {sessionActions(session).map((action) => (
                        <button
                          key={action.id}
                          role="menuitem"
                          className={action.danger === true ? "session-menu-item danger" : "session-menu-item"}
                          onClick={() => void runAction(action.id, session)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {actionError !== null && <div className="list-error">{actionError}</div>}
      {confirmDialog}
    </>
  );
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
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
