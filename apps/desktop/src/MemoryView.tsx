import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type MemoryOverviewEntry,
  type MemoryOverviewGroup,
  type MemoryOverviewResponse,
  type SessionSummary,
} from "./api.ts";
import {
  clusterLabel,
  entryMeta,
  formatTimestamp,
  isExpanded,
  kindLabel,
  openDirectoryHint,
  overviewViewLabel,
  pagerLabel,
  revisionChainLabel,
  scopeOptions,
  sourceJumpHint,
  sourceJumpTarget,
  toggleExpanded,
  type MemoryOverviewView,
} from "./memory-ui.ts";
import { Badge } from "./design-system/primitives/Badge.tsx";
import { Button } from "./design-system/primitives/Button.tsx";

/**
 * 记忆页（票 M7-A-T6 / Issue #62）：只读。
 *
 * - 两种视图：树（按 kind 分组 + 弱主题聚类，分组/聚类由 Runtime 计算）与时间线
 *   （occurred_at 倒序分页，limit/offset 走控制面）。
 * - 每条可展开：版本链（revisions + 修订概要）、来源事件（可跳到原会话；会话已归档/
 *   删除只给提示，不报错）、类型/敏感等级。
 * - 作用域：默认 owner（全局树不含 session:*）；有活动会话时可切到
 *   `session:<id>`（owner ∪ 该会话）。
 * - 无任何编辑/删除入口——写路径只经 Markdown 受控导入。
 * - 「打开记忆文件目录」经 Tauri 命令调用 OS 文件管理器（不起新窗口）；非 Tauri
 *   环境（浏览器 dev）降级为展示目录路径。
 */

const TIMELINE_PAGE_SIZE = 20;

export function MemoryView({
  base,
  activeSessionId,
  onOpenSource,
}: {
  base: string;
  /** 当前活动会话（提供 session 作用域选项） */
  activeSessionId: string | null;
  /** 来源跳动：切到原会话（App 负责路由） */
  onOpenSource?: (sessionId: string) => void;
}) {
  const [view, setView] = useState<MemoryOverviewView>("tree");
  const [scope, setScope] = useState("owner");
  const [data, setData] = useState<MemoryOverviewResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [directoryNote, setDirectoryNote] = useState<string | null>(null);

  const scopes = scopeOptions(activeSessionId);
  const effectiveScope = scopes.some((option) => option.value === scope) ? scope : "owner";

  // 来源跳转需要知道会话是否已归档/软删（默认列表不含它们 → include=all）
  useEffect(() => {
    let cancelled = false;
    api
      .listSessions(base, "all")
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.memoryOverview(base, {
        view,
        scope: effectiveScope,
        ...(view === "timeline" ? { limit: TIMELINE_PAGE_SIZE, offset } : {}),
      });
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setLoading(false);
    }
  }, [base, view, effectiveScope, offset]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchView = useCallback((next: MemoryOverviewView) => {
    setView(next);
    setOffset(0);
    setExpanded([]);
  }, []);

  const switchScope = useCallback((next: string) => {
    setScope(next);
    setOffset(0);
    setExpanded([]);
  }, []);

  const openDirectory = useCallback(async () => {
    const directory = data?.directory ?? null;
    if (directory === null) {
      setDirectoryNote(openDirectoryHint(null));
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_memory_dir", { path: directory });
      setDirectoryNote(`已在文件管理器中打开：${directory}`);
    } catch (err) {
      // 浏览器 dev / 非 Tauri 运行：不新开窗口，降级展示路径
      const reason = err instanceof Error ? err.message : String(err);
      setDirectoryNote(`${openDirectoryHint(directory)}（本地打开不可用：${reason}）`);
    }
  }, [data]);

  return (
    <div className="page memory-page">
      <div className="page-head">
        <h2>记忆</h2>
        <div className="memory-actions">
          <Badge tone="muted">只读</Badge>
          <Button variant="secondary" size="sm" onClick={() => void openDirectory()}>
            打开记忆文件目录
          </Button>
        </div>
      </div>
      <p className="page-hint">
        这是 Agent 记住的东西。页面只读；修改只经 Markdown 受控导入（复制目录里的文件改完再导入）。
      </p>

      <div className="memory-toolbar">
        <div className="memory-view-switch" role="group" aria-label="记忆视图">
          {(["tree", "timeline"] as const).map((item) => (
            <Button key={item} variant="ghost" size="sm" selected={view === item} onClick={() => switchView(item)}>
              {overviewViewLabel(item)}
            </Button>
          ))}
        </div>
        <label className="field memory-scope-field">
          <span className="field-label">作用域</span>
          <select value={effectiveScope} onChange={(event) => switchScope(event.target.value)}>
            {scopes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} loading={loading}>
          刷新
        </Button>
      </div>

      {directoryNote !== null && <p className="page-hint memory-dir-note">{directoryNote}</p>}
      {error !== null && <div className="banner-error">读取记忆失败：{error}</div>}

      {data === null ? (
        <p className="page-hint">{loading ? "正在读取记忆…" : "暂无数据。"}</p>
      ) : data.view === "tree" ? (
        <TreeBody
          groups={data.groups}
          total={data.total}
          scope={data.scope}
          expanded={expanded}
          sessions={sessions}
          onToggle={(id) => setExpanded((current) => toggleExpanded(current, id))}
          onOpenSource={onOpenSource}
        />
      ) : (
        <TimelineBody
          entries={data.entries}
          total={data.total}
          limit={data.limit}
          offset={data.offset}
          scope={data.scope}
          expanded={expanded}
          sessions={sessions}
          onToggle={(id) => setExpanded((current) => toggleExpanded(current, id))}
          onPage={setOffset}
          onOpenSource={onOpenSource}
        />
      )}
    </div>
  );
}

function TreeBody({
  groups,
  total,
  scope,
  expanded,
  sessions,
  onToggle,
  onOpenSource,
}: {
  groups: MemoryOverviewGroup[];
  total: number;
  scope: string;
  expanded: string[];
  sessions: SessionSummary[];
  onToggle: (entryId: string) => void;
  onOpenSource?: (sessionId: string) => void;
}) {
  if (total === 0) {
    return <p className="empty-note">还没有记忆。对话里说「请记住 …」后会出现在这里。</p>;
  }
  return (
    <div className="memory-tree">
      <p className="page-hint">
        共 {total} 条 · 作用域 {scope === "owner" ? "长期记忆（owner）" : scope}
      </p>
      {groups.map((group) => (
        <section key={group.kind} className="memory-group" aria-label={kindLabel(group.kind)}>
          <h3 className="memory-group-title">
            {kindLabel(group.kind)} <span className="memory-count">{group.count}</span>
          </h3>
          <div className="memory-clusters">
            {group.clusters.map((cluster, index) => (
              <div key={`${group.kind}-${cluster.theme ?? index}`} className="memory-cluster">
                <div className="memory-cluster-title">{clusterLabel(cluster.theme, index)}</div>
                {cluster.entries.map((entry) => (
                  <MemoryEntryCard
                    key={entry.id}
                    entry={entry}
                    expanded={isExpanded(expanded, entry.id)}
                    sessions={sessions}
                    onToggle={() => onToggle(entry.id)}
                    onOpenSource={onOpenSource}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TimelineBody({
  entries,
  total,
  limit,
  offset,
  scope,
  expanded,
  sessions,
  onToggle,
  onPage,
  onOpenSource,
}: {
  entries: MemoryOverviewEntry[];
  total: number;
  limit: number;
  offset: number;
  scope: string;
  expanded: string[];
  sessions: SessionSummary[];
  onToggle: (entryId: string) => void;
  onPage: (offset: number) => void;
  onOpenSource?: (sessionId: string) => void;
}) {
  if (total === 0) {
    return <p className="empty-note">还没有记忆。对话里说「请记住 …」后会出现在这里。</p>;
  }
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  return (
    <div className="memory-timeline">
      <div className="memory-pager">
        <span className="page-hint">
          {pagerLabel(total, limit, offset)} · 作用域 {scope === "owner" ? "长期记忆（owner）" : scope}
        </span>
        <div className="memory-pager-actions">
          <Button variant="ghost" size="sm" disabled={!hasPrev} onClick={() => onPage(Math.max(0, offset - limit))}>
            上一页
          </Button>
          <Button variant="ghost" size="sm" disabled={!hasNext} onClick={() => onPage(offset + limit)}>
            下一页
          </Button>
        </div>
      </div>
      <ol className="memory-timeline-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <div className="memory-timeline-stamp">{formatTimestamp(entry.occurred_at)}</div>
            <MemoryEntryCard
              entry={entry}
              expanded={isExpanded(expanded, entry.id)}
              sessions={sessions}
              onToggle={() => onToggle(entry.id)}
              onOpenSource={onOpenSource}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

function MemoryEntryCard({
  entry,
  expanded,
  sessions,
  onToggle,
  onOpenSource,
}: {
  entry: MemoryOverviewEntry;
  expanded: boolean;
  sessions: SessionSummary[];
  onToggle: () => void;
  onOpenSource?: (sessionId: string) => void;
}) {
  return (
    <article className="memory-entry">
      <button
        type="button"
        className="memory-entry-head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="memory-entry-content">{entry.content}</span>
        <span className="memory-entry-meta">{entryMeta(entry)}</span>
      </button>
      {expanded && (
        <div className="memory-entry-detail">
          <div className="memory-detail-row">
            <span className="memory-detail-label">版本链</span>
            <span>{revisionChainLabel(entry)}</span>
          </div>
          {entry.revision_history.length > 0 && (
            <ul className="memory-revision-list">
              {entry.revision_history.map((revision) => (
                <li key={revision.version}>
                  v{revision.version} · {formatTimestamp(revision.createdAt)}
                  {revision.reason !== null ? ` · ${revision.reason}` : ""}
                </li>
              ))}
            </ul>
          )}
          <div className="memory-detail-row">
            <span className="memory-detail-label">来源</span>
            <span className="memory-source-list">
              {entry.sources.map((source) => {
                const target = sourceJumpTarget(source, sessions);
                const hint = sourceJumpHint(source, sessions);
                return (
                  <span key={source.event_id} className="memory-source">
                    {target.kind === "session" && onOpenSource !== undefined ? (
                      <button
                        type="button"
                        className="memory-source-link"
                        onClick={() => onOpenSource(target.sessionId)}
                        title={`来源事件 ${source.event_id}`}
                      >
                        跳到原始消息 · {formatTimestamp(source.occurred_at)}
                      </button>
                    ) : (
                      <span className="memory-source-disabled" title={hint ?? undefined}>
                        来源 · {formatTimestamp(source.occurred_at)}
                      </span>
                    )}
                    {hint !== null && <span className="memory-source-hint">{hint}</span>}
                  </span>
                );
              })}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}
