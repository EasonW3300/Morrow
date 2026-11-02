/**
 * Task 视图纯逻辑（票 M1-T6 / Issue #18，PRD §4.3 FR-TASK-4、§5.1 Task 视图简版）。
 * React 只做装配；本模块承载全部可测决策——
 *   - 状态呈现映射（任务/节点状态 → 中文标签 + 色调）；
 *   - DAG 层级分组（依赖可视化从简：按拓扑层级缩进分组，不画图——M6 完整版再图形化）；
 *   - diff 识别（节点结果/工具输出中的统一 diff 以只读块呈现）；
 *   - 任务事件流归约（tool.started/finished 配对为可展开 I/O 项，口径同 sse.ts）；
 *   - 事件分页窗口（最新页优先 + 向更早翻页）；
 *   - 修订表单校验（与服务端 validateRevision 同口径的前端防线）。
 */
import type { TaskNodeRecord, TaskNodeStatus, TaskStatus } from "@morrow/protocol/browser";
// 任务账本事件信封：单一真相源在 api.ts（GET /v1/tasks/:id/events 的 events 元素；
// M1 code-review 收敛——原先本文件自持一份同形 TaskEnvelope 拷贝）
import type { TaskEventEnvelope } from "./api.ts";

// --- 状态呈现映射 ----------------------------------------------------------------

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  created: "已创建",
  planned: "已规划",
  running: "运行中",
  paused: "已暂停",
  waiting_input: "等待输入",
  failed: "失败",
  completed: "已完成",
  cancelled: "已取消",
};

const TASK_NODE_STATUS_LABELS: Record<TaskNodeStatus, string> = {
  pending: "待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  pending_review: "待人工核对",
};

export type Tone = "ok" | "run" | "warn" | "error" | "idle";

const TASK_STATUS_TONES: Record<TaskStatus, Tone> = {
  created: "idle",
  planned: "idle",
  running: "run",
  paused: "warn",
  waiting_input: "warn",
  failed: "error",
  completed: "ok",
  cancelled: "idle",
};

const TASK_NODE_STATUS_TONES: Record<TaskNodeStatus, Tone> = {
  pending: "idle",
  running: "run",
  completed: "ok",
  failed: "error",
  pending_review: "warn",
};

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

export function taskNodeStatusLabel(status: TaskNodeStatus): string {
  return TASK_NODE_STATUS_LABELS[status] ?? status;
}

export function taskStatusTone(status: TaskStatus): Tone {
  return TASK_STATUS_TONES[status] ?? "idle";
}

export function taskNodeStatusTone(status: TaskNodeStatus): Tone {
  return TASK_NODE_STATUS_TONES[status] ?? "idle";
}

// --- DAG 层级分组 ----------------------------------------------------------------

export interface DagLayering {
  /** 逐层节点（level 0 = 无依赖；层内按 node_seq 传入序） */
  layers: TaskNodeRecord[][];
  /** 成环节点 key（账本口径之外的手改 DAG 防御；不出现在 layers 里） */
  cyclicKeys: string[];
}

/**
 * 拓扑层级分组（Kahn）：level(n) = 1 + max(level(dep))。依赖可视化从简——
 * 详情页按层级缩进/分组渲染即可表达 DAG 结构；环内节点落 cyclicKeys（渲染为
 * 警示行，不参与层级），该状态在合法任务里不可达（规划/修订均拒环）。
 */
export function dagLayers(nodes: TaskNodeRecord[]): DagLayering {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = node.depends_on.filter((d) => byKey.has(d));
    indegree.set(node.key, deps.length);
    for (const dep of deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.key]);
    }
  }
  const layers: TaskNodeRecord[][] = [];
  let frontier = nodes.filter((n) => (indegree.get(n.key) ?? 0) === 0);
  const placed = new Set<string>();
  while (frontier.length > 0) {
    layers.push(frontier);
    for (const node of frontier) placed.add(node.key);
    const next: TaskNodeRecord[] = [];
    for (const node of frontier) {
      for (const key of dependents.get(node.key) ?? []) {
        const d = (indegree.get(key) ?? 0) - 1;
        indegree.set(key, d);
        if (d === 0) {
          const dependent = byKey.get(key);
          if (dependent !== undefined) next.push(dependent);
        }
      }
    }
    frontier = next;
  }
  const cyclicKeys = nodes.filter((n) => !placed.has(n.key)).map((n) => n.key);
  return { layers, cyclicKeys };
}

// --- Diff 识别（只读展示）--------------------------------------------------------

/**
 * 统一 diff 形状识别：节点结果 / 工具输出命中即以只读 diff 块渲染（M1 无隔离工作区，
 * diff 只可能出现在文本产出里；git/@@/---+++ 三种头部任一 + 行级 +/- 上下文）。
 */
export function looksLikeDiff(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const lines = trimmed.split("\n");
  const hasGitHeader = lines.some((l) => l.startsWith("diff --git "));
  const hasHunks = lines.some((l) => l.startsWith("@@ "));
  const hasOldNew = lines.some((l) => l.startsWith("--- ")) && lines.some((l) => l.startsWith("+++ "));
  const hasChanges = lines.some((l) => l.startsWith("+") || l.startsWith("-"));
  return hasGitHeader || (hasHunks && hasChanges) || (hasOldNew && hasChanges);
}

// --- 任务事件流归约 ----------------------------------------------------------------

export type TaskEventItem =
  | {
      kind: "lifecycle";
      type: string;
      occurredAt: string;
      sequence: number;
      /** 人类可读一行摘要（生命周期/介入事件） */
      summary: string;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      argsText: string;
      resultText: string;
      isError: boolean;
      finished: boolean;
      sequence: number;
    };

export function projectTaskEvents(events: Array<{ sequence: number; envelope: TaskEventEnvelope }>): TaskEventItem[] {
  const items: TaskEventItem[] = [];
  for (const { sequence, envelope } of events) {
    const payload = envelope.payload;
    if (envelope.event_type === "tool.started") {
      items.push({
        kind: "tool",
        toolCallId: String(payload.tool_call_id ?? ""),
        toolName: String(payload.tool_name ?? ""),
        argsText: stringifyPayload(payload.args),
        resultText: "",
        isError: false,
        finished: false,
        sequence,
      });
      continue;
    }
    if (envelope.event_type === "tool.finished") {
      const toolCallId = String(payload.tool_call_id ?? "");
      // 就地补全同 id 的 tool.started；缺失自建（重放起点截断防御）
      const index = openToolIndex(items, toolCallId);
      if (index !== -1) {
        const started = items[index];
        if (started.kind === "tool") {
          items[index] = {
            ...started,
            resultText: String(payload.text ?? ""),
            isError: payload.is_error === true,
            finished: true,
          };
          continue;
        }
      }
      items.push({
        kind: "tool",
        toolCallId,
        toolName: String(payload.tool_name ?? ""),
        argsText: "",
        resultText: String(payload.text ?? ""),
        isError: payload.is_error === true,
        finished: true,
        sequence,
      });
      continue;
    }
    items.push({
      kind: "lifecycle",
      type: envelope.event_type,
      occurredAt: envelope.occurred_at,
      sequence,
      summary: lifecycleSummary(envelope.event_type, payload),
    });
  }
  return items;
}

/** 最近一个未完结的同 id 工具项下标（没有则 -1） */
function openToolIndex(items: TaskEventItem[], toolCallId: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "tool" && item.toolCallId === toolCallId && !item.finished) return i;
  }
  return -1;
}

/** 生命周期事件 → 一行摘要（介入事件携带的修改/结果摘要在详情页直接可读） */
function lifecycleSummary(type: string, payload: Record<string, unknown>): string {
  const keys = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : [];
  switch (type) {
    case "task.created":
      return `创建任务：${String(payload.goal ?? "")}`;
    case "task.planned": {
      const nodes = keys(payload.nodes).length;
      return nodes > 0
        ? `规划完成：${nodes} 个节点（task_version ${String(payload.task_version ?? 1)}）`
        : "规划完成";
    }
    case "task.started":
      return "开始执行";
    case "task.resumed":
      return `恢复执行${payload.reason ? `（${String(payload.reason)}）` : ""}`;
    case "task.paused":
      return "已暂停（安全点）";
    case "task.waiting_input":
      return `等待输入（${String(payload.reason ?? "unknown")}）：${keys(payload.keys).join(", ")}`;
    case "task.completed":
      return "任务完成";
    case "task.failed":
      return `任务失败：${String(payload.message ?? payload.reason ?? "unknown")}`;
    case "task.cancelled":
      return "任务已取消";
    case "task.planning_failed":
      return `规划失败：${String(payload.message ?? "unknown")}`;
    case "task.node_started":
      return `节点 ${String(payload.key ?? "")} 开始（第 ${String(payload.attempt ?? 1)} 次）`;
    case "task.node_finished":
      return `节点 ${String(payload.key ?? "")} ${String(payload.status ?? "")}${
        payload.result !== undefined ? `：${truncate(String(payload.result), 80)}` : ""
      }${payload.error !== undefined ? `（错误：${truncate(String(payload.error), 80)}）` : ""}`;
    case "task.revised": {
      const summary = payload.summary as { updated_keys?: string[]; added_keys?: string[]; removed_keys?: string[] } | undefined;
      const parts: string[] = [];
      if (summary?.updated_keys?.length) parts.push(`修改 ${summary.updated_keys.join(", ")}`);
      if (summary?.added_keys?.length) parts.push(`新增 ${summary.added_keys.join(", ")}`);
      if (summary?.removed_keys?.length) parts.push(`移除 ${summary.removed_keys.join(", ")}`);
      return `任务修订（task_version ${String(payload.task_version ?? "")}）：${parts.join("；") || "无字段变更"}`;
    }
    case "task.node_taken_over":
      return `Owner 接管节点 ${String(payload.key ?? "")}`;
    case "task.node_released":
      return `Owner 交还节点 ${String(payload.key ?? "")}`;
    case "task.node_completed_by_owner":
      return `Owner 完成节点 ${String(payload.key ?? "")}：${truncate(String(payload.result ?? ""), 80)}`;
    case "task.checkpoint_created":
      return `检查点（${String(payload.reason ?? "")}，task_version ${String(payload.task_version ?? "")}）`;
    case "task.restored":
      return `从检查点恢复（replay ${keys(payload.replay_keys).join(", ") || "无"}）`;
    case "agent.error":
      return `Agent 错误：${String(payload.message ?? "unknown")}`;
    default:
      return type;
  }
}

// --- 事件分页窗口（最新页优先）----------------------------------------------------

export interface EventPageState {
  /** 当前窗口的请求 offset */
  offset: number;
  hasOlder: boolean;
  hasNewer: boolean;
}

/**
 * 最新页优先的分页窗口描述：初次加载（offset=null）取账本最后 limit 条（执行中的
 * 任务最新事件最有用）；组件以 offset±limit（钳位 [0, lastPage]）为翻页目标。
 */
export function eventPageState(total: number, limit: number, currentOffset: number | null): EventPageState {
  const lastPageOffset = Math.max(0, total - limit);
  const offset = currentOffset === null ? lastPageOffset : Math.min(currentOffset, lastPageOffset);
  return {
    offset,
    hasOlder: offset > 0,
    hasNewer: offset < lastPageOffset,
  };
}

// --- 修订表单校验 ----------------------------------------------------------------

/** 修改表单的一行（未完成节点）：留空 = 不修改该字段 */
export interface ReviseFormUpdate {
  key: string;
  goal: string;
  model: string;
}

/** 新增节点表单行；dependsOn 为逗号分隔的 key 列表 */
export interface ReviseFormAddition {
  key: string;
  title: string;
  goal?: string;
  dependsOn: string;
}

export interface ReviseFormState {
  updates: ReviseFormUpdate[];
  removeKeys: string[];
  additions: ReviseFormAddition[];
}

export interface ReviseFormResult {
  ok: boolean;
  errors: string[];
  /** 校验通过时可直接 POST /v1/tasks/:id/revise 的修改集 */
  body: { update?: Array<{ key: string; goal?: string; model?: string }>; add?: Array<{ key: string; title: string; goal?: string; depends_on?: string[] }>; remove?: string[] } | null;
}

const NODE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 修订表单校验（前端同口径防线；服务端 validateRevision 仍是权威）：
 * 至少一项修改；已完成节点不可改/不可移；新增 key 模式/唯一/title 必填；
 * depends_on 可解析（现存未移除 + 新增）且不成环；修改行的 goal/model 留空即不改。
 */
export function validateReviseForm(form: ReviseFormState, nodes: TaskNodeRecord[]): ReviseFormResult {
  const errors: string[] = [];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const update: NonNullable<ReviseFormResult["body"]>["update"] = [];
  for (const row of form.updates) {
    const target = byKey.get(row.key);
    if (target === undefined) continue; // 表单来自现存节点，防御性跳过
    if (target.status === "completed") {
      errors.push(`节点 ${row.key} 已完成，不可修改`);
      continue;
    }
    const change: { key: string; goal?: string; model?: string } = { key: row.key };
    if (row.goal.trim().length > 0) change.goal = row.goal.trim();
    if (row.model.trim().length > 0) change.model = row.model.trim();
    if (change.goal !== undefined || change.model !== undefined) update.push(change);
  }
  const remove: string[] = [];
  for (const key of form.removeKeys) {
    const target = byKey.get(key);
    if (target?.status === "completed") {
      errors.push(`节点 ${key} 已完成，不可移除`);
      continue;
    }
    remove.push(key);
  }
  const add: NonNullable<ReviseFormResult["body"]>["add"] = [];
  const addKeys = new Set<string>();
  // 依赖解析对照「修改后」的 key 集：现存未移除 + 新增（成环检查在收集完依赖后统一做）
  const removeSet = new Set(remove);
  const keysAfter = new Set<string>([...byKey.keys()].filter((k) => !removeSet.has(k)));
  const depsByKey = new Map<string, string[]>();
  for (const node of nodes) {
    if (removeSet.has(node.key)) continue;
    depsByKey.set(node.key, node.depends_on.filter((d) => keysAfter.has(d)));
  }
  for (const row of form.additions) {
    const key = row.key.trim();
    if (!NODE_KEY_RE.test(key)) {
      errors.push(`新增节点 key「${key}」不合法（小写字母/数字开头，短标识）`);
      continue;
    }
    if (byKey.has(key) || addKeys.has(key)) {
      errors.push(`节点 key「${key}」已存在`);
      continue;
    }
    if (row.title.trim().length === 0) {
      errors.push(`新增节点「${key}」缺少标题`);
      continue;
    }
    const deps = row.dependsOn
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    let depsOk = true;
    for (const dep of deps) {
      if (dep === key) {
        errors.push(`新增节点「${key}」依赖自身`);
        depsOk = false;
      } else if (!keysAfter.has(dep)) {
        errors.push(`新增节点「${key}」依赖未知节点「${dep}」`);
        depsOk = false;
      }
    }
    if (!depsOk) continue; // 该行整体无效，不进修改集
    addKeys.add(key);
    keysAfter.add(key);
    depsByKey.set(key, deps);
    add.push({
      key,
      title: row.title.trim(),
      ...((row.goal ?? "").trim().length > 0 ? { goal: (row.goal ?? "").trim() } : {}),
      ...(deps.length > 0 ? { depends_on: deps } : {}),
    });
  }
  // 成环检查（复用 dagLayers 的拓扑口径）
  const graph: TaskNodeRecord[] = [...depsByKey.entries()].map(([key, depends_on]) => ({ key, depends_on } as TaskNodeRecord));
  const layering = dagLayers(graph);
  if (layering.cyclicKeys.length > 0) {
    errors.push(`修订会引入依赖环：${layering.cyclicKeys.join(", ")}`);
  }
  if (update.length === 0 && add.length === 0 && remove.length === 0) {
    errors.push("至少填写一项修改（修改目标 / 新增 / 移除）");
  }
  if (errors.length > 0) return { ok: false, errors, body: null };
  return {
    ok: true,
    errors: [],
    body: {
      ...(update.length > 0 ? { update } : {}),
      ...(add.length > 0 ? { add } : {}),
      ...(remove.length > 0 ? { remove } : {}),
    },
  };
}

// --- 工具 ------------------------------------------------------------------------

function stringifyPayload(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
