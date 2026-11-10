import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type TaskCheckpointMeta,
  type TaskDetail,
  type TaskEventEnvelope,
  type TaskNodeRecord,
  type TaskSummary,
} from "./api.ts";
import {
  dagLayers,
  describeReconcileEvidence,
  eventPageState,
  looksLikeDiff,
  NEEDS_RECONCILE_MESSAGE,
  projectTaskEvents,
  reconcileControls,
  taskNeedsReconcile,
  taskNodeStatusLabel,
  taskNodeStatusTone,
  taskStatusLabel,
  taskStatusTone,
  validateReviseForm,
  type ReviseFormAddition,
  type ReviseFormState,
  type TaskEventItem,
} from "./task-ui.ts";
import { collectCapabilityRefs, type CapabilityRef } from "./capability-ui.ts";

/**
 * Task 视图（票 M1-T6 / Issue #18，PRD §5.1 Task 视图简版、FR-TASK-3/4）：
 * - 列表：goal / 状态 / task_version / 创建时间（?session_id 过滤由 Chat 卡片跳转复用）；
 * - 详情：DAG 节点状态（依赖可视化从简——按拓扑层级缩进分组）、执行事件流（分页加载、
 *   工具 I/O 展开）、节点结果 diff 只读块、检查点列表；
 * - 操作按钮：暂停/恢复/修改（表单）/恢复到检查点 + 节点级 接管/完成/交还；
 * - 刷新策略（选择记录在案）：**操作后 refetch + 非终端态 2s 轮询**——任务执行无
 *   SSE 通道（账本 task_id 专列只有 HTTP 分页），轮询让后台调度进度无需手动刷新；
 *   操作后立即 refetch 保证按钮反馈即时；终端态停表。事件流不参与轮询（手动加载
 *   分页窗口，避免大页抖动），轮询只刷新任务投影与检查点。
 * - 能力引用卡（票 M2-T6 / Issue #27）：节点详情面板展示该节点用到的能力
 *   （tool.started 的 tool_name 命中能力注册表 → 名称+版本芯片），点击跳设置→能力管理。
 */
const POLL_INTERVAL_MS = 2000;
const EVENT_PAGE_SIZE = 50;
/** 能力引用卡的扫描窗口（账本单页上限 200；引用卡是辅助信息，不做全量回扫） */
const CAPABILITY_REFS_EVENT_LIMIT = 200;
const TERMINAL_STATUSES = new Set(["failed", "completed", "cancelled"]);

export function TaskView({
  base,
  initialTaskId,
  onOpenCapability,
}: {
  base: string;
  initialTaskId: string | null;
  onOpenCapability?: (name: string) => void;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialTaskId);

  const refreshList = useCallback(async () => {
    try {
      setTasks(await api.listTasks(base));
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [base]);

  useEffect(() => {
    void refreshList();
    const timer = setInterval(() => void refreshList(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshList]);

  // Chat 卡片跳转（initialTaskId 变化）→ 选中对应任务
  useEffect(() => {
    if (initialTaskId !== null) setSelectedId(initialTaskId);
  }, [initialTaskId]);

  return (
    <div className="page task-page">
      <div className="page-head">
        <h2>任务</h2>
        <button className="btn" onClick={() => void refreshList()}>
          刷新列表
        </button>
      </div>
      {listError !== null && <div className="banner-error">{listError}</div>}
      {tasks.some((task) => taskNeedsReconcile(task.status)) && (
        <div className="needs-reconcile-strip">
          有任务处于「待人工裁决」：两设备独立执行过同一任务，需要你在详情页给出结论。
        </div>
      )}
      <div className="task-layout">
        <aside className="task-list">
          {tasks.length === 0 && <p className="empty-note">暂无任务。任务由会话或 API 创建（POST /v1/tasks）。</p>}
          {tasks.map((task) => {
            const needsReconcile = taskNeedsReconcile(task.status);
            return (
              <button
                key={task.task_id}
                className={`task-row${task.task_id === selectedId ? " selected" : ""}${needsReconcile ? " task-row-reconcile" : ""}`}
                onClick={() => setSelectedId(task.task_id)}
              >
                <span className="task-row-goal">
                  {needsReconcile && <span className="task-row-alert" aria-label="需人工裁决">⚠ </span>}
                  {task.goal}
                </span>
                <span className="task-row-meta">
                  <span className={`badge tone-${taskStatusTone(task.status)}`}>{taskStatusLabel(task.status)}</span>
                  <span className="mono">v{task.task_version}</span>
                  <span>{shortTime(task.created_at)}</span>
                </span>
              </button>
            );
          })}
        </aside>
        <main className="task-detail">
          {selectedId === null ? (
            <p className="empty-note">从左侧选择任务查看详情。</p>
          ) : (
            <TaskDetailPanel
              key={selectedId}
              base={base}
              taskId={selectedId}
              onChanged={refreshList}
              onOpenCapability={onOpenCapability}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// --- 任务详情 --------------------------------------------------------------------

function TaskDetailPanel({
  base,
  taskId,
  onChanged,
  onOpenCapability,
}: {
  base: string;
  taskId: string;
  onChanged: () => void;
  onOpenCapability?: (name: string) => void;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkpoints, setCheckpoints] = useState<TaskCheckpointMeta[]>([]);
  const [showRevise, setShowRevise] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setTask(await api.getTask(base, taskId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [base, taskId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void api
      .taskCheckpoints(base, taskId)
      .then(setCheckpoints)
      .catch(() => setCheckpoints([]));
  }, [base, taskId, task?.task_version, task?.status]);

  // 能力引用卡（票 M2-T6）：tool.started 的 tool_name 命中能力注册表 → node_id → 芯片。
  // 注册表/事件任一不可得时静默降级为空（引用卡是增强信息，不阻塞任务详情）。
  const [capabilityRefs, setCapabilityRefs] = useState<Map<string, CapabilityRef[]>>(new Map());
  useEffect(() => {
    void (async () => {
      try {
        const [records, events] = await Promise.all([
          api.listCapabilities(base),
          api.taskEvents(base, taskId, CAPABILITY_REFS_EVENT_LIMIT, 0),
        ]);
        setCapabilityRefs(collectCapabilityRefs(events.events, records));
      } catch {
        setCapabilityRefs(new Map());
      }
    })();
  }, [base, taskId]);

  // needs_reconcile 证据（票 M3-T6 / Issue #35）：GET /v1/tasks/:id/execution 的
  // evidence 说明哪两个副本各自执行过（判定不是凭空冻结）。
  const [evidenceText, setEvidenceText] = useState<string | null>(null);
  useEffect(() => {
    if (task?.status !== "needs_reconcile") {
      setEvidenceText(null);
      return;
    }
    void api
      .taskExecution(base, taskId)
      .then((execution) => setEvidenceText(describeReconcileEvidence(execution.evidence)))
      .catch(() => setEvidenceText(null));
  }, [base, taskId, task?.status]);

  const [reconcileNote, setReconcileNote] = useState("");

  const run = useCallback(
    async (what: string, action: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setOpError(null);
      try {
        await action();
        await refresh();
        onChanged();
      } catch (err) {
        setOpError(
          err instanceof ApiError ? `${what}失败（${err.code}）：${err.message}` : `${what}失败：${String(err)}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [refresh, onChanged],
  );

  if (error !== null && task === null) {
    return <div className="banner-error">{error}</div>;
  }
  if (task === null) {
    return <p className="empty-note">正在读取任务…</p>;
  }
  const terminal = TERMINAL_STATUSES.has(task.status);

  return (
    <div className="task-detail-body">
      <div className="task-head">
        <div>
          <h3>{task.goal}</h3>
          <p className="task-head-meta">
            <span className={`badge tone-${taskStatusTone(task.status)}`}>{taskStatusLabel(task.status)}</span>
            <span className="mono">task_version {task.task_version}</span>
            <span className="mono">{task.task_id}</span>
          </p>
        </div>
        <div className="task-actions">
          <button className="btn" disabled={busy || task.status !== "running"} onClick={() => void run("暂停", () => api.pauseTask(base, task.task_id))}>
            暂停
          </button>
          <button
            className="btn"
            disabled={busy || (task.status !== "paused" && task.status !== "waiting_input" && task.status !== "planned")}
            onClick={() => void run("恢复", () => api.resumeTask(base, task.task_id))}
          >
            恢复
          </button>
          <button className="btn" disabled={busy || terminal || task.status === "running"} onClick={() => setShowRevise((v) => !v)}>
            修改…
          </button>
        </div>
      </div>
      {opError !== null && <div className="banner-error">{opError}</div>}
      {task.error !== undefined && <div className="banner-error">任务错误：{task.error}</div>}
      {reconcileControls(task.status, busy).visible && (
        <div className="needs-reconcile-panel" role="alert">
          <div className="needs-reconcile-head">
            <span className="needs-reconcile-badge">⚠ 待人工裁决</span>
            <strong>{NEEDS_RECONCILE_MESSAGE}</strong>
          </div>
          <p className="hint-inline">
            Runtime 不会自动合并任何一侧结果：请核对下方证据与节点结果后，选择一个结论；裁决会记入任务账本。
          </p>
          {evidenceText !== null && <p className="needs-reconcile-evidence">执行证据：{evidenceText}</p>}
          <label className="field">
            <span className="field-label">裁决说明（可选，进审计）</span>
            <input
              value={reconcileNote}
              onChange={(e) => setReconcileNote(e.target.value)}
              placeholder="例如：采纳台式机侧的归档结果"
              disabled={busy}
            />
          </label>
          <div className="form-actions">
            {reconcileControls(task.status, busy).options.map((option) => (
              <button
                key={option.resolution}
                className={option.resolution === "completed" ? "btn primary" : "btn danger"}
                disabled={option.disabled}
                title={option.hint}
                onClick={() =>
                  void run("裁决", () =>
                    api.reconcileTask(base, task.task_id, {
                      resolution: option.resolution,
                      ...(reconcileNote.trim().length > 0 ? { note: reconcileNote.trim() } : {}),
                    }),
                  )
                }
              >
                {busy ? "提交中…" : option.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {!terminal && task.status === "running" && <p className="hint-inline">任务执行中：详情每 2 秒自动刷新。</p>}
      {showRevise && (
        <ReviseForm
          base={base}
          task={task}
          busy={busy}
          onDone={() => {
            setShowRevise(false);
            void refresh();
            onChanged();
          }}
        />
      )}
      <NodeList base={base} task={task} busy={busy} run={run} capabilityRefs={capabilityRefs} onOpenCapability={onOpenCapability} />
      <EventStream base={base} taskId={task.task_id} />
      {checkpoints.length > 0 && (
        <CheckpointList
          base={base}
          taskId={task.task_id}
          checkpoints={checkpoints}
          busy={busy}
          disabled={terminal}
          run={run}
        />
      )}
    </div>
  );
}

// --- DAG 节点（层级缩进分组 + 节点级操作）------------------------------------------

function NodeList({
  base,
  task,
  busy,
  run,
  capabilityRefs,
  onOpenCapability,
}: {
  base: string;
  task: TaskDetail;
  busy: boolean;
  run: (what: string, action: () => Promise<unknown>) => Promise<void>;
  capabilityRefs: Map<string, CapabilityRef[]>;
  onOpenCapability?: (name: string) => void;
}) {
  const layering = dagLayers(task.nodes);
  return (
    <section className="task-section">
      <h4>DAG 节点（按依赖层级分组）</h4>
      {layering.layers.map((layer, index) => (
        <div key={index} className="dag-layer" style={{ marginLeft: index * 20 }}>
          <p className="dag-layer-label">第 {index + 1} 层（依赖已满足顺序）</p>
          {layer.map((node) => (
            <NodeRow
              key={node.node_id}
              base={base}
              taskId={task.task_id}
              node={node}
              busy={busy}
              run={run}
              capabilityRefs={capabilityRefs.get(node.node_id) ?? []}
              onOpenCapability={onOpenCapability}
            />
          ))}
        </div>
      ))}
      {layering.cyclicKeys.length > 0 && (
        <div className="banner-error">依赖环（异常状态）：{layering.cyclicKeys.join(", ")}</div>
      )}
    </section>
  );
}

function NodeRow({
  base,
  taskId,
  node,
  busy,
  run,
  capabilityRefs,
  onOpenCapability,
}: {
  base: string;
  taskId: string;
  node: TaskNodeRecord;
  busy: boolean;
  run: (what: string, action: () => Promise<unknown>) => Promise<void>;
  capabilityRefs: CapabilityRef[];
  onOpenCapability?: (name: string) => void;
}) {
  const [completing, setCompleting] = useState(false);
  const [result, setResult] = useState("");
  const owned = node.actor === "owner";
  return (
    <div className={`node-row tone-border-${taskNodeStatusTone(node.status)} ${owned ? "node-owned" : ""}`}>
      <div className="node-line">
        <span className={`badge tone-${taskNodeStatusTone(node.status)}`}>{taskNodeStatusLabel(node.status)}</span>
        <strong>{node.title}</strong>
        <span className="mono node-key">{node.key}</span>
        {node.model !== undefined && <span className="node-meta">模型 {node.model}</span>}
        {node.attempts > 0 && <span className="node-meta">尝试 {node.attempts} 次</span>}
        {owned && <span className="badge tone-warn">Owner 接管中</span>}
      </div>
      {node.goal !== undefined && <p className="node-goal">{node.goal}</p>}
      {capabilityRefs.length > 0 && (
        <div className="capability-refs">
          <span className="capability-refs-label">用到的能力：</span>
          {capabilityRefs.map((ref) => (
            <button
              key={ref.name}
              className="capability-ref-chip"
              title={`${ref.name} v${ref.version}——点击查看能力详情`}
              onClick={() => onOpenCapability?.(ref.name)}
            >
              {ref.name}
              <span className="mono">v{ref.version}</span>
            </button>
          ))}
        </div>
      )}
      {node.result !== undefined && (
        looksLikeDiff(node.result) ? (
          <pre className="diff-view">{node.result}</pre>
        ) : (
          <p className="node-result">{node.result}</p>
        )
      )}
      {node.error !== undefined && <p className="node-error">错误：{node.error}</p>}
      {owned && node.status === "pending" && (
        <div className="node-actions">
          {completing ? (
            <>
              <input
                className="mono"
                placeholder="完成结果（提交后节点置为已完成）"
                value={result}
                onChange={(e) => setResult(e.target.value)}
              />
              <button
                className="btn primary"
                disabled={busy || result.trim().length === 0}
                onClick={() => {
                  setCompleting(false);
                  void run("完成节点", () => api.completeNode(base, taskId, node.node_id, result.trim()));
                }}
              >
                提交结果
              </button>
              <button className="btn" onClick={() => setCompleting(false)}>
                取消
              </button>
            </>
          ) : (
            <>
              <button className="btn primary" disabled={busy} onClick={() => setCompleting(true)}>
                完成…
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => void run("交还节点", () => api.releaseNode(base, taskId, node.node_id))}
              >
                交还调度
              </button>
            </>
          )}
        </div>
      )}
      {!owned && node.status === "pending" && (
        <div className="node-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => void run("接管节点", () => api.takeoverNode(base, taskId, node.node_id))}
          >
            接管
          </button>
        </div>
      )}
    </div>
  );
}

// --- 修订表单（暂停 → 修改 → 恢复 的「修改」）--------------------------------------

function ReviseForm({
  base,
  task,
  busy,
  onDone,
}: {
  base: string;
  task: TaskDetail;
  busy: boolean;
  onDone: () => void;
}) {
  const unfinished = task.nodes.filter((n) => n.status !== "completed");
  const [updates, setUpdates] = useState(() =>
    unfinished.map((n) => ({ key: n.key, goal: n.goal ?? "", model: n.model ?? "" })),
  );
  const [removeKeys, setRemoveKeys] = useState<string[]>([]);
  const [additions, setAdditions] = useState<ReviseFormAddition[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form: ReviseFormState = { updates, removeKeys, additions };
  const preview = validateReviseForm(form, task.nodes);

  const submit = async (): Promise<void> => {
    const validated = validateReviseForm(form, task.nodes);
    if (!validated.ok || validated.body === null) {
      setErrors(validated.errors);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.reviseTask(base, task.task_id, validated.body);
      onDone();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="task-section form-card">
      <h4>修改未完成节点（task_version 将 +1 并重算下游依赖）</h4>
      {unfinished.length === 0 && <p className="empty-note">没有未完成节点可修改。</p>}
      {unfinished.map((node) => {
        const row = updates.find((u) => u.key === node.key) ?? { key: node.key, goal: "", model: "" };
        return (
          <div key={node.key} className="revise-row">
            <label>
              <input
                type="checkbox"
                checked={removeKeys.includes(node.key)}
                onChange={(e) =>
                  setRemoveKeys((prev) => (e.target.checked ? [...prev, node.key] : prev.filter((k) => k !== node.key)))
                }
              />
              移除
            </label>
            <span className="mono node-key">{node.key}</span>
            <input
              placeholder={`目标（留空保持「${node.goal ?? "（无）"}」）`}
              value={row.goal}
              onChange={(e) =>
                setUpdates((prev) => prev.map((u) => (u.key === node.key ? { ...u, goal: e.target.value } : u)))
              }
            />
            <input
              placeholder={`模型（Provider id，留空保持「${node.model ?? "默认"}」）`}
              value={row.model}
              onChange={(e) =>
                setUpdates((prev) => prev.map((u) => (u.key === node.key ? { ...u, model: e.target.value } : u)))
              }
            />
          </div>
        );
      })}
      {additions.map((row, index) => (
        <div key={index} className="revise-row">
          <button className="btn" onClick={() => setAdditions((prev) => prev.filter((_, i) => i !== index))}>
            移除行
          </button>
          <input
            className="mono"
            placeholder="key（如 review-log）"
            value={row.key}
            onChange={(e) => setAdditions((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))}
          />
          <input
            placeholder="标题"
            value={row.title}
            onChange={(e) => setAdditions((prev) => prev.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)))}
          />
          <input
            placeholder="目标指令"
            value={row.goal}
            onChange={(e) => setAdditions((prev) => prev.map((r, i) => (i === index ? { ...r, goal: e.target.value } : r)))}
          />
          <input
            className="mono"
            placeholder="依赖 key（逗号分隔，可空）"
            value={row.dependsOn}
            onChange={(e) => setAdditions((prev) => prev.map((r, i) => (i === index ? { ...r, dependsOn: e.target.value } : r)))}
          />
        </div>
      ))}
      <div className="revise-actions">
        <button className="btn" disabled={busy} onClick={() => setAdditions((prev) => [...prev, { key: "", title: "", goal: "", dependsOn: "" }])}>
          + 新增节点
        </button>
        <button className="btn primary" disabled={busy || submitting || !preview.ok} onClick={() => void submit()}>
          {submitting ? "提交中…" : "提交修改"}
        </button>
      </div>
      {!preview.ok && preview.errors.length > 0 && (
        <div className="form-errors">
          {preview.errors.map((e, i) => (
            <p key={i}>{e}</p>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div className="form-errors">
          {errors.map((e, i) => (
            <p key={i}>{e}</p>
          ))}
        </div>
      )}
      {submitError !== null && <div className="banner-error">{submitError}</div>}
    </section>
  );
}

// --- 执行事件流（分页 + 工具 I/O + diff 只读）---------------------------------------

function EventStream({ base, taskId }: { base: string; taskId: string }) {
  const [events, setEvents] = useState<TaskEventEnvelope[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target: number | null) => {
      try {
        // 先取 total 定位窗口（任务事件量小，count 与页同源）
        const first = await api.taskEvents(base, taskId, 1, 0);
        const page = eventPageState(first.total, EVENT_PAGE_SIZE, target);
        const data = await api.taskEvents(base, taskId, EVENT_PAGE_SIZE, page.offset);
        setEvents(data.events);
        setTotal(data.total);
        setOffset(page.offset);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
      }
    },
    [base, taskId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const items: TaskEventItem[] = projectTaskEvents(events.map((e) => ({ sequence: 0, envelope: e })));

  return (
    <section className="task-section">
      <h4>执行事件流（{total} 条，每页 {EVENT_PAGE_SIZE}）</h4>
      {error !== null && <div className="banner-error">{error}</div>}
      <div className="event-pages">
        <button className="btn" disabled={offset === null || !eventPageState(total, EVENT_PAGE_SIZE, offset).hasNewer} onClick={() => void load((offset ?? 0) + EVENT_PAGE_SIZE)}>
          ← 返回较新
        </button>
        <button className="btn" disabled={offset === null || !eventPageState(total, EVENT_PAGE_SIZE, offset).hasOlder} onClick={() => void load(Math.max(0, (offset ?? 0) - EVENT_PAGE_SIZE))}>
          加载更早 →
        </button>
      </div>
      <div className="event-list">
        {items.map((item, index) => (
          <EventRow key={`${offset ?? "latest"}-${index}`} item={item} />
        ))}
        {items.length === 0 && <p className="empty-note">该窗口没有事件。</p>}
      </div>
    </section>
  );
}

function EventRow({ item }: { item: TaskEventItem }) {
  if (item.kind === "tool") {
    return (
      <details className={`tool-row ${item.isError ? "tool-error" : ""}`}>
        <summary>
          <span className="tool-state">{item.finished ? (item.isError ? "✗" : "✓") : "⋯"}</span>
          工具 <code>{item.toolName}</code>
          {item.finished ? <span className="tool-meta">{item.isError ? " 失败" : ""}</span> : <span className="tool-meta">运行中</span>}
        </summary>
        <div className="tool-body">
          {item.argsText.length > 0 && <pre className="tool-args">{item.argsText}</pre>}
          {item.resultText.length > 0 &&
            (looksLikeDiff(item.resultText) ? (
              <pre className="diff-view">{item.resultText}</pre>
            ) : (
              <pre className="tool-result">{item.resultText}</pre>
            ))}
        </div>
      </details>
    );
  }
  return (
    <div className="event-row">
      <span className="event-type mono">{item.type}</span>
      <span className="event-summary">{item.summary}</span>
      <span className="event-time">{shortTime(item.occurredAt)}</span>
    </div>
  );
}

// --- 检查点（恢复到检查点）----------------------------------------------------------

function CheckpointList({
  base,
  taskId,
  checkpoints,
  busy,
  disabled,
  run,
}: {
  base: string;
  taskId: string;
  checkpoints: TaskCheckpointMeta[];
  busy: boolean;
  disabled: boolean;
  run: (what: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <section className="task-section">
      <h4>检查点（恢复基准）</h4>
      {checkpoints.map((cp) => (
        <div key={cp.checkpoint_id} className="checkpoint-row">
          <span className="mono">{shortTime(cp.created_at)}</span>
          <span>{cp.reason}</span>
          <span className="mono">v{cp.task_version}</span>
          <button
            className="btn"
            disabled={busy || disabled}
            onClick={() => void run("恢复到检查点", () => api.restoreTask(base, taskId, cp.checkpoint_id))}
          >
            恢复到此检查点
          </button>
        </div>
      ))}
    </section>
  );
}

// --- 工具 ------------------------------------------------------------------------

function shortTime(iso: string): string {
  // 本地时区短格式（创建时间/事件时间展示用）
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
