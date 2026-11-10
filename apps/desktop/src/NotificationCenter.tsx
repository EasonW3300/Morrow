/**
 * 应用内通知中心（Issue #47，PRD §4.8 FR-NOT-2 / §5.1）。
 *
 * 顶栏铃铛 + 未读数（未读 = runtime pending 条数）；面板列表（时间/事件类型/任务标题/
 * 正文摘要）；「全部标记已读」逐条 ack。系统通知权限被拒或环境不支持时自动降级：
 * 通知保留在 pending 里只出现在本面板，并在面板顶部说明；被拒后不再自动弹授权框，
 * 只提供「重新请求权限」。
 *
 * 轮询与 ack 的全部决策在 notification-center.ts（node:test 覆盖）；系统通知桥在
 * notification-system.ts。本组件只做装配。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NotificationRecord } from "@morrow/protocol/browser";
import { api, ApiError } from "./api.ts";
import {
  NotificationPoller,
  eventTypeLabel,
  eventTypeTone,
  formatNotificationTime,
  notificationSummary,
  permissionNotice,
  resolvePermissionOverride,
  resolvePollIntervalMs,
  shouldRequestPermissionOnStartup,
  taskIdForNavigation,
  type NotificationPermissionState,
} from "./notification-center.ts";
import {
  getNotificationPermissionState,
  readPermissionDeniedFlag,
  requestNotificationPermission,
  showSystemNotification,
  writePermissionDeniedFlag,
} from "./notification-system.ts";

/** 会话级去重集合：组件重挂载（React StrictMode）也不重复弹同一 id 的系统通知 */
const SESSION_DELIVERED_IDS = new Set<string>();

export function NotificationCenter({
  base,
  onOpenTask,
  pollIntervalMs,
}: {
  base: string;
  onOpenTask?: (taskId: string) => void;
  /** 覆盖轮询间隔（毫秒，0=关闭）；缺省读 URL/env，最终默认 10s */
  pollIntervalMs?: number;
}) {
  const intervalMs = useMemo(
    () =>
      pollIntervalMs ??
      resolvePollIntervalMs(window.location.search, import.meta.env.VITE_NOTIFICATION_POLL_MS),
    [pollIntervalMs],
  );
  const permissionOverride = useMemo(() => resolvePermissionOverride(window.location.search), []);

  const [pending, setPending] = useState<readonly NotificationRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<NotificationPermissionState>(
    permissionOverride ?? "unavailable",
  );
  const [permissionReady, setPermissionReady] = useState(permissionOverride !== null);
  const [requesting, setRequesting] = useState(false);
  const [marking, setMarking] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);

  const pollerRef = useRef<NotificationPoller | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const permissionRef = useRef<NotificationPermissionState>(permission);

  useEffect(() => {
    permissionRef.current = permission;
  }, [permission]);

  // 首次启动：读权限态；仅在「尚未决定」且没被拒过时请求一次（拒绝后不再自动弹框）。
  useEffect(() => {
    if (permissionOverride !== null) return;
    let cancelled = false;
    void (async () => {
      const deniedBefore = readPermissionDeniedFlag();
      let state = await getNotificationPermissionState(deniedBefore);
      if (!cancelled && shouldRequestPermissionOnStartup(state, deniedBefore)) {
        state = await requestNotificationPermission();
        writePermissionDeniedFlag(state === "denied");
      }
      if (!cancelled) {
        setPermission(state);
        setPermissionReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [permissionOverride]);

  // 轮询消费：拉 pending → 逐条系统展示 → 成功 ack；降级时不 ack（保留未读）。
  useEffect(() => {
    if (!permissionReady) return;
    let disposed = false;
    const poller = new NotificationPoller({
      fetchPending: () => api.listPendingNotifications(base),
      ack: (notificationId) => api.ackNotification(base, notificationId),
      display: (record) => {
        if (disposed || permissionRef.current !== "granted") return false;
        return showSystemNotification(record);
      },
      intervalMs,
      deliveredIds: SESSION_DELIVERED_IDS,
      onChange: (items) => {
        if (!disposed) {
          setPending(items);
          setPollError(null);
        }
      },
      onError: (err) => {
        if (!disposed) {
          setPollError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
        }
      },
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      disposed = true;
      poller.stop();
      pollerRef.current = null;
    };
  }, [base, intervalMs, permissionReady]);

  // 面板打开时点外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (hostRef.current !== null && !hostRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const requestAgain = useCallback(async () => {
    setRequesting(true);
    try {
      if (permissionOverride !== null) {
        setPermission(permissionOverride);
        return;
      }
      const state = await requestNotificationPermission();
      writePermissionDeniedFlag(state === "denied");
      setPermission(state);
    } finally {
      setRequesting(false);
    }
  }, [permissionOverride]);

  const markAllRead = useCallback(async () => {
    const poller = pollerRef.current;
    if (poller === null) return;
    setMarking(true);
    try {
      await poller.markAllRead();
      await poller.pollOnce();
    } finally {
      setMarking(false);
    }
  }, []);

  const openTask = useCallback(
    (record: NotificationRecord) => {
      const taskId = taskIdForNavigation(record);
      if (taskId === null || onOpenTask === undefined) return;
      onOpenTask(taskId);
      setOpen(false);
    },
    [onOpenTask],
  );

  const notice = permissionNotice(permission);
  const count = pending.length;
  const countLabel = count > 99 ? "99+" : String(count);

  return (
    <div className="notify-host" ref={hostRef}>
      <button
        type="button"
        className={open ? "notify-bell selected" : "notify-bell"}
        aria-label={count > 0 ? `通知中心，${count} 条未读` : "通知中心"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 15.5H6l1.6-2.4V10a4.4 4.4 0 1 1 8.8 0v3.1L18 15.5Z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        <span>通知</span>
        {count > 0 && (
          <span className="notify-badge" aria-hidden="true">
            {countLabel}
          </span>
        )}
      </button>

      {open && (
        <section className="notify-panel" aria-label="通知中心">
          <header className="notify-panel-head">
            <strong>通知中心</strong>
            <span className="notify-count">{count > 0 ? `${count} 条未读` : "暂无未读"}</span>
          </header>

          {notice !== null && (
            <div className={`notify-permission tone-${notice.tone}`}>
              <div>
                <strong>{notice.title}</strong>
                <p>{notice.detail}</p>
              </div>
              {notice.canRequest && (
                <button
                  type="button"
                  className="btn"
                  disabled={requesting}
                  onClick={() => void requestAgain()}
                >
                  {requesting ? "请求中…" : "重新请求权限"}
                </button>
              )}
            </div>
          )}

          {pollError !== null && <div className="notify-error">拉取通知失败：{pollError}</div>}

          {pending.length === 0 ? (
            <div className="notify-empty">
              <p>暂无待读通知。</p>
              <p className="hint">
                任务完成、失败或需要你输入时，会在这里提醒
                {permission === "granted" ? "，并弹出系统通知。" : "。"}
              </p>
            </div>
          ) : (
            <>
              <ul className="notify-list">
                {pending.map((record) => {
                  const taskId = taskIdForNavigation(record);
                  const clickable = taskId !== null && onOpenTask !== undefined;
                  return (
                    <li key={record.notification_id} className="notify-item">
                      <div className="notify-item-meta">
                        <span className={`badge badge-tone-${eventTypeTone(record.event_type)}`}>
                          {eventTypeLabel(record.event_type)}
                        </span>
                        <time dateTime={record.created_at}>
                          {formatNotificationTime(record.created_at)}
                        </time>
                      </div>
                      {clickable ? (
                        <button
                          type="button"
                          className="notify-item-title notify-link"
                          onClick={() => openTask(record)}
                          title="打开对应任务"
                        >
                          {record.title}
                        </button>
                      ) : (
                        <div className="notify-item-title">{record.title}</div>
                      )}
                      <p className="notify-item-body">{notificationSummary(record.body)}</p>
                    </li>
                  );
                })}
              </ul>
              <footer className="notify-panel-foot">
                <button
                  type="button"
                  className="btn primary"
                  disabled={marking || pending.length === 0}
                  onClick={() => void markAllRead()}
                >
                  {marking ? "标记中…" : "全部标记已读"}
                </button>
              </footer>
            </>
          )}
        </section>
      )}
    </div>
  );
}
