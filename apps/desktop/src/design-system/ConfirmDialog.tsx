import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./primitives/Button.tsx";
import { GlassSurface } from "./primitives/GlassSurface.tsx";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破坏性操作（默认）用 danger 实底；普通确认用 primary */
  tone?: "danger" | "primary";
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * 应用内确认框：替代 window.confirm，保持与 Liquid Glass 浮层一致的视觉与键盘路径。
 * 用法：const [confirm, confirmDialog] = useConfirm(); ... {confirmDialog}
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const ask = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const entry = { ...options, resolve };
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      pendingRef.current = entry;
      setPending(entry);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    const entry = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    const previous = previousFocusRef.current;
    previousFocusRef.current = null;
    entry?.resolve(ok);
    previous?.focus();
  }, []);

  useEffect(() => {
    if (pending === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") settle(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pending, settle]);

  const dialog: ReactNode =
    pending === null ? null : (
      <div className="modal-backdrop" role="presentation" onClick={() => settle(false)}>
        <GlassSurface
          variant="elevated"
          className="modal-card modal-card--compact"
          role="alertdialog"
          aria-modal="true"
          aria-label={pending.title}
          onClick={(event) => event.stopPropagation()}
        >
          <h3>{pending.title}</h3>
          <div className="modal-body-text">{pending.message}</div>
          <div className="form-actions">
            <Button
              variant={(pending.tone ?? "danger") === "danger" ? "danger" : "primary"}
              className={(pending.tone ?? "danger") === "danger" ? "danger-solid" : undefined}
              autoFocus
              onClick={() => settle(true)}
            >
              {pending.confirmLabel ?? "确认"}
            </Button>
            <Button onClick={() => settle(false)}>{pending.cancelLabel ?? "取消"}</Button>
          </div>
        </GlassSurface>
      </div>
    );

  return [ask, dialog];
}
