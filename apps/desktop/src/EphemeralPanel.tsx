import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type MemoryHit } from "./api.ts";
import { ChatView } from "./ChatView.tsx";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";
import { GlassSurface } from "./design-system/primitives/GlassSurface.tsx";
import {
  closeNotice,
  ephemeralCapabilityGate,
  ephemeralScope,
  promoteDisabledReason,
} from "./ephemeral-ui.ts";

/**
 * 临时会话面板（票 M7-A-T3 / Issue #60，ADR-0010）：右侧独立面板，标注「临时」。
 *
 * - 会话写入的记忆带 scope=session:<id>，默认不进长期记忆；面板内提供关键词检索
 *   （作用域 = 全局 + 本会话）与「提升为长期记忆」。
 * - 关闭后 24h 内可恢复；面板明确提示截止时刻（与后端 session_expired 同口径）。
 * - 写入类能力入口在面板内禁用并给提示（服务端 invoke 另有 403 兜底，双保险）。
 */
export function EphemeralPanel({
  base,
  sessionId,
  onExit,
}: {
  base: string;
  sessionId: string;
  onExit: () => void;
}) {
  const scope = ephemeralScope(sessionId);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gate = ephemeralCapabilityGate();

  const search = useCallback(async () => {
    const q = query.trim();
    if (q.length === 0) return;
    try {
      setHits(await api.searchMemory(base, q, scope));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [base, query, scope]);

  useEffect(() => {
    if (closedAt !== null) setHits([]);
  }, [closedAt]);

  const close = async () => {
    setBusy(true);
    try {
      const result = await api.closeSession(base, sessionId);
      setClosedAt(result.closed_at);
      setMessage(null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      await api.restoreSession(base, sessionId);
      setClosedAt(null);
      setMessage("已恢复：作用域内的临时记忆仍在。");
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  const promote = async (hit: MemoryHit) => {
    try {
      await api.promoteMemory(base, hit.id);
      setHits((prev) => prev.map((item) => (item.id === hit.id ? { ...item, scope: "owner" } : item)));
      setMessage(`已提升为长期记忆：${hit.content}`);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  };

  return (
    <GlassSurface as="aside" className="ephemeral-drawer" aria-label="临时会话面板">
      <div className="ephemeral-head">
        <Badge tone="warn">临时</Badge>
        <span className="ephemeral-title">临时会话</span>
        <Button size="sm" variant="ghost" onClick={onExit} aria-label="收起临时会话面板">
          收起
        </Button>
      </div>

      {closedAt !== null ? (
        <div className="ephemeral-closed" role="status">
          <p>{closeNotice(closedAt)}</p>
          <Button size="sm" variant="primary" onClick={() => void restore()} disabled={busy}>
            恢复临时会话
          </Button>
        </div>
      ) : (
        <div className="ephemeral-chat">
          <ChatView key={`${sessionId}-${closedAt ?? "open"}`} base={base} sessionId={sessionId} />
        </div>
      )}

      <div className="ephemeral-memory">
        <div className="ephemeral-section-head">
          <span>临时记忆</span>
          <span className="ephemeral-hint">默认不进长期记忆</span>
        </div>
        <div className="ephemeral-search">
          <input
            value={query}
            placeholder="检索本会话 + 长期记忆"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
            disabled={closedAt !== null}
          />
          <Button size="sm" onClick={() => void search()} disabled={closedAt !== null || query.trim().length === 0}>
            检索
          </Button>
        </div>
        {hits.length > 0 && (
          <ul className="ephemeral-hits" role="list">
            {hits.map((hit) => {
              const disabledReason = promoteDisabledReason(hit.scope);
              return (
                <li key={hit.id} className="ephemeral-hit">
                  <div className="ephemeral-hit-text">{hit.content}</div>
                  <div className="ephemeral-hit-meta">
                    <Badge tone={hit.scope === "owner" ? "muted" : "warn"}>
                      {hit.scope === "owner" ? "长期" : "临时"}
                    </Badge>
                    <span className="mono">{hit.stage}</span>
                    <Button
                      size="sm"
                      onClick={() => void promote(hit)}
                      disabled={disabledReason !== null}
                      title={disabledReason ?? "移入长期记忆（owner 作用域）"}
                    >
                      提升为长期记忆
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {message !== null && <div className="ephemeral-message">{message}</div>}
        {error !== null && (
          <div className="banner-error" role="alert">
            {error}
          </div>
        )}
        <div className="ephemeral-gate" role="note">
          <span>临时会话禁写入类能力：</span>
          <Button size="sm" disabled title={gate.register}>
            注册能力
          </Button>
          <Button size="sm" disabled title={gate.generate}>
            生成代码
          </Button>
          <Button size="sm" disabled title={gate.write}>
            写操作
          </Button>
        </div>
      </div>

      {closedAt === null && (
        <div className="ephemeral-foot">
          <Button size="sm" variant="ghost" onClick={() => void close()} disabled={busy}>
            关闭临时会话
          </Button>
          <span className="ephemeral-hint">关闭后 24h 内可恢复</span>
        </div>
      )}
    </GlassSurface>
  );
}
