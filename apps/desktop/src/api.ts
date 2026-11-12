/**
 * 控制面 API 封装（fetch，PRD §6.1：UI ↔ Runtime 仅本地 HTTP + JSON）。
 * 错误统一 { error: { code, message } } → ApiError（UI 层做可读呈现）。
 *
 * 跨包类型（ProviderRecord / ConnectivityResult）的唯一真相源在 @morrow/protocol——
 * 此处只 re-export（原先本文件自持一份拷贝，M0 code-review / Issue #11 收敛）。
 */
import type {
  CapabilityRecord,
  CapabilityVersionRecord,
  ChannelHealth,
  ChannelSecretsView,
  ChannelSummary,
  ChannelAllowMode,
  ChannelAllowlistEntryView,
  ConnectivityResult,
  ContactAmbiguityView,
  ContactCapabilityCategory,
  ContactGrantView,
  ContactInviteView,
  ContactView,
  DeviceInfo,
  NotificationRule,
  NotificationRuleInput,
  NotificationRecord,
  OutboxListPage,
  OutboxMessageRecord,
  OutboxStatus,
  PairingClaimRequest,
  PairingClaimResponse,
  PairingCodeResponse,
  PairingJoinRequest,
  PairingJoinResponse,
  Persona,
  PermissionGrant,
  ProviderRecord,
  SessionAttachment,
  SessionWorkspace,
  SyncRunReport,
  SyncStatus,
  TaskDetail,
  TaskExecutionState,
  TaskNodeRecord,
  TaskSummary,
} from "@morrow/protocol/browser";
export type {
  CapabilityRecord,
  CapabilityVersionRecord,
  ChannelHealth,
  ChannelSecretsView,
  ChannelSummary,
  ChannelAllowMode,
  ChannelAllowlistEntryView,
  ConnectivityResult,
  ContactAmbiguityView,
  ContactCapabilityCategory,
  ContactGrantView,
  ContactInviteView,
  ContactView,
  DeviceInfo,
  NotificationRule,
  NotificationRuleInput,
  NotificationRecord,
  OutboxListPage,
  OutboxMessageRecord,
  OutboxStatus,
  PairingClaimRequest,
  PairingClaimResponse,
  PairingCodeResponse,
  PairingJoinRequest,
  PairingJoinResponse,
  Persona,
  PermissionGrant,
  ProviderRecord,
  SessionAttachment,
  SessionWorkspace,
  SyncRunReport,
  SyncStatus,
  TaskDetail,
  TaskExecutionState,
  TaskNodeRecord,
  TaskSummary,
};
// 能力域 UI 侧类型（SkillSummary/SkillProposal 在 capability-ui 定义；工厂投影在本文件）
import type { SkillProposal, SkillSummary } from "./capability-ui.ts";
export type { SkillProposal, SkillSummary };
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * 错误信封里 code/message 之外平铺的字段（M3-T6 / Issue #35）：
     * sync_gap 的 peer_replica_id / expected / actual 就在这里，UI 才能说清缺口位置。
     */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, init);
  } catch (err) {
    // fetch 的网络层失败（连接拒绝/DNS/断网）在浏览器里是 TypeError，不带状态码——
    // 归一成 network_error 的 ApiError，UI 才能区分「连不上 Runtime」与「Runtime 报错」（票 T7 可诊断性）
    if (err instanceof TypeError) {
      throw new ApiError(0, "network_error", `无法连接 Runtime 控制面（${base}）。请确认 Runtime 正在运行。`);
    }
    throw err;
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText || `HTTP ${res.status}`;
    let details: Record<string, unknown> = {};
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string } & Record<string, unknown>;
        [key: string]: unknown;
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
      if (body.error !== undefined && typeof body.error === "object") {
        const { code: _code, message: _message, ...rest } = body.error;
        details = rest;
      }
      // 部分端点把诊断字段放在错误信封之外（如 enable 409 的 risk_notice）——
      // 保留根级字段，UI 才能在未确认风险时原样展示风险文案。
      for (const [key, value] of Object.entries(body)) {
        if (key !== "error") details[key] = value;
      }
    } catch {
      // 非 JSON 错误体，保留 statusText
    }
    throw new ApiError(res.status, code, message, details);
  }
  return (await res.json()) as T;
}

export interface SessionSummary {
  session_id: string;
  event_id?: string;
  title?: string;
  occurred_at: string;
  sequence: number;
  /** 会话类型（票 M7-A-T3）：normal 缺省；ephemeral = 临时会话 */
  kind?: "normal" | "ephemeral";
  /** 归档时间（M7-A-T2；取消归档后缺省） */
  archived_at?: string;
  /** 软删时间（M7-A-T2；恢复后缺省；30 天后服务端折叠剔除） */
  deleted_at?: string;
  /** 会话工作区（M7-A-T4 / Issue #61；未绑定缺省） */
  workspace?: SessionWorkspace;
  /** 只读附件数量（M7-A-T4） */
  attachment_count?: number;
}

/** PUT /v1/sessions/:id/workspace 的 body（三形态） */
export type WorkspaceBindingRequest =
  | { kind: "none" }
  | { kind: "local"; path: string }
  | { kind: "github"; url: string; base_branch?: string; new_branch?: string };

/** PUT /v1/sessions/:id/workspace 的 200 载荷 */
export interface SessionWorkspaceMutation {
  session_id: string;
  workspace: SessionWorkspace | null;
  event_id: string | null;
  sequence: number | null;
  changed: boolean;
  /** github 且命中本机已有 clone 时为 true（未发生网络动作） */
  reused?: boolean;
}

/** GET/POST/DELETE /v1/sessions/:id/attachments 的载荷 */
export interface SessionAttachmentsResult {
  session_id: string;
  attachments: SessionAttachment[];
  attachment_count: number;
  event_id?: string | null;
  sequence?: number | null;
  changed?: boolean;
}

/** GET /v1/memory/facts 命中条目（票 M7-A-T3 起带 scope） */
export interface MemoryHit {
  id: string;
  stage: "candidate" | "fact";
  type: string;
  content: string;
  sensitivity: string;
  confidence?: number;
  version: number;
  sources: string[];
  scope: string;
  created_at: string;
}

/** 只读记忆视图（票 M7-A-T6 / Issue #62）：来源回链 / 版本链 / 分组簇 */
export interface MemoryOverviewSource {
  event_id: string;
  session_id: string | null;
  occurred_at: string;
}

export interface MemoryOverviewRevision {
  version: number;
  createdAt: string;
  reason: string | null;
  sourceEventId: string | null;
}

export interface MemoryOverviewEntry {
  id: string;
  content: string;
  kind: string;
  sensitivity: string;
  version: number;
  scope: string;
  occurred_at: string;
  createdAt: string;
  updatedAt: string;
  revisions: number[];
  revision_history: MemoryOverviewRevision[];
  sources: MemoryOverviewSource[];
}

export interface MemoryOverviewCluster {
  theme: string | null;
  entries: MemoryOverviewEntry[];
}

export interface MemoryOverviewGroup {
  kind: string;
  count: number;
  clusters: MemoryOverviewCluster[];
}

export type MemoryOverviewResponse =
  | {
      view: "tree";
      scope: string;
      directory: string | null;
      total: number;
      groups: MemoryOverviewGroup[];
    }
  | {
      view: "timeline";
      scope: string;
      directory: string | null;
      total: number;
      limit: number;
      offset: number;
      entries: MemoryOverviewEntry[];
    };

export interface CloseSessionResult {
  session_id: string;
  closed_at: string;
  restorable_until: string;
  event_id?: string;
}

export interface RestoreSessionResult {
  session_id: string;
  restored_at: string;
  event_id: string;
}

export interface PromoteMemoryResult {
  id: string;
  entry_kind: "candidate" | "fact";
  from_scope: string;
  to_scope: "owner";
  event_id: string;
}

/** GET /v1/sessions?include= 的过滤值：缺省只回活动会话 */
export type SessionListInclude = "archived" | "deleted" | "all";

/** 会话元数据端点（rename/archive/unarchive/delete/restore）的 200 载荷 */
export interface SessionMetadataMutation {
  session_id: string;
  event_id: string | null;
  sequence: number | null;
  changed: boolean;
  title?: string;
  archived_at?: string | null;
  deleted_at?: string | null;
  restored_at?: string;
}

export interface MessageRecord {
  message_id: string;
  role: "user" | "assistant";
  text: string;
  stop_reason?: string;
  sequence: number;
  occurred_at: string;
}

export interface SessionHistory {
  session_id: string;
  messages: MessageRecord[];
}

export interface ProviderListResponse {
  providers: ProviderRecord[];
  default_provider_id: string | null;
}

/** GET/PUT /v1/channels/:id/notify-target：渠道默认通知会话（通知规则的前置条件） */
export interface ChannelNotifyTargetView {
  channel: string;
  account_id: string | null;
  native_conversation_id: string | null;
  updated_at: string | null;
}

/** GET /v1/health 载荷（沙箱探针为四态状态机：not_configured|missing|daemon_down|ready，票 M2-T1） */
export interface HealthPayload {
  status: string;
  version: string;
  replica_id: string;
  sandbox: {
    status: string;
    detail: string;
    engine?: string | null;
    version?: string | null;
    install_hint?: string | null;
  };
  ledger: { events: number };
}

// --- 任务域（票 M1-T6 / Issue #18；类型唯一真相源在 @morrow/protocol，UI 本地投影另行定义） ---

/** 任务账本事件信封（GET /v1/tasks/:id/events 的 events 元素） */
export interface TaskEventEnvelope {
  event_id: string;
  event_type: string;
  occurred_at: string;
  task_id?: string;
  payload: Record<string, unknown>;
}

/** GET /v1/tasks/:id/events 载荷（账本分页语义与 GET /v1/events 一致） */
export interface TaskEventsPage {
  events: TaskEventEnvelope[];
  total: number;
  limit: number;
  offset: number;
}

/** checkpoint 列表元素（UI 本地投影：只取渲染所需字段；完整快照在 runtime 侧） */
export interface TaskCheckpointMeta {
  checkpoint_id: string;
  task_id: string;
  task_version: number;
  reason: string;
  created_at: string;
}

/** 修改集（POST /v1/tasks/:id/revise body；字段语义见 runtime validateRevision） */
export interface TaskRevisionBody {
  update?: Array<{ key: string; title?: string; goal?: string | null; model?: string | null; depends_on?: string[] }>;
  add?: Array<{ key: string; title: string; goal?: string; depends_on?: string[]; model?: string }>;
  remove?: string[];
}

/** POST /v1/tasks/:id/{resume,restore} 202 载荷（与 runtime scheduler ResumeResult 同形投影） */
export interface TaskResumeResult {
  task: TaskSummary;
  checkpoint_id: string | null;
  /** 恢复决策（runtime planReconcile 的投影；UI 只读展示用） */
  reconcile: {
    actions: Array<{
      node_id: string;
      key: string;
      side_effect: string;
      from_status: string;
      checkpoint_status: string | null;
      to_status: string;
      action: string;
    }>;
    pending_review_keys: string[];
    pending_compensations: Array<{ key: string; side_effect: string; note: string }>;
    replay_keys: string[];
  };
}

// --- 能力域（票 M2-T6 / Issue #27；类型唯一真相源在 @morrow/protocol，UI 本地投影另行定义）---

/** GET /v1/capabilities/:id 载荷（engine.get 投影：当前记录 + 版本历史） */
export interface CapabilityDetail {
  record: CapabilityRecord;
  versions: CapabilityVersionRecord[];
}

export interface CapabilityRollbackResult {
  capability: CapabilityRecord;
  from_version: string;
  to_version: string;
}

/**
 * 工厂请求视图（真实 T3 合约的 UI 读取面——apps/runtime/src/capabilities/factory/types.ts
 * FactoryRequestView 的投影，只保留 UI 渲染所需字段）：
 *   POST /v1/capabilities/request       {description} → 201 {request_id,status,stage}
 *   GET  /v1/capabilities/requests/:id  进度/报告（轮询观察口径）
 *   POST /v1/capabilities/:id/confirm   Owner 确认门（:id = request_id；proposed → 注册）
 */
export interface FactoryRequest {
  request_id: string;
  status: "submitted" | "reused" | "proposed" | "failed" | "confirmed";
  stage: "submitted" | "retrieved" | "planned" | "built" | "verified";
  /** 原始需求描述（POST 201 响应可缺省——只有三元组） */
  description?: string;
  /** planned 起携带：候选 manifest（确认注册即注册它） */
  manifest?: Record<string, unknown>;
  /** built/proposed 携带：逐用例验证报告（capability-ui describeVerification 消费） */
  report?: {
    ok: boolean;
    cases: Array<{
      case_id: string;
      kind: "positive" | "negative" | "privilege-escalation" | "fault";
      pass: boolean;
      detail: string;
    }>;
    sandbox_error?: string;
  };
  /** failed 携带：结构化诊断（stage/code/detail，越权带逐维 violations） */
  error?: {
    stage: string;
    code: string;
    detail: string;
    violations?: Array<{ dimension: string; requested: string; reason: string }>;
  };
  /** reused 携带：命中既有能力/Skill 的摘要（FR-CAP-1 重用路径） */
  reuse_matches?: Array<{ source: string; name?: string; score: number }>;
  /** confirmed 后的注册能力名 */
  capability_name?: string;
}

const JSON_HEADERS = { "content-type": "application/json" };

// --- 设备与同步（票 M3-T6 / Issue #35；设备/配对类型在 @morrow/protocol，冲突视图是 UI 投影）---

/**
 * GET /v1/sync/conflicts 的元素：memory_conflicts 本体 + 同步元数据
 * （apps/runtime/src/sync/memory-sync.ts 的 SyncConflictView 投影）。
 */
export interface SyncConflictView {
  conflict_id: string;
  candidate_id: string;
  fact_id: string;
  reason: string;
  existing_content: string;
  incoming_content: string;
  existing_sensitivity: string;
  incoming_sensitivity: string;
  source_id: string;
  status: "open" | "resolved";
  /** T3 裁决语义：keep_old = 本地既有值，keep_new = 远端入站值 */
  resolution: "keep_new" | "keep_old" | "merge" | null;
  resolved_content: string | null;
  created_at: string;
  resolved_at: string | null;
  /** sync = 来自其他副本；local = 本机内产生（同一队列，不另建） */
  origin: "sync" | "local";
  local_replica_id: string | null;
  remote_replica_id: string | null;
  local_version: number | null;
  remote_version: number | null;
  base_version: number | null;
  remote_event_id: string | null;
  sync_resolved_at: string | null;
}

/** POST /v1/sync/conflicts/:id/resolve 200 载荷（memory.resolveConflict 结果 + 同步元数据） */
export interface SyncConflictResolveResult {
  conflictId: string;
  factId: string;
  resolution: "keep_new" | "keep_old" | "merge";
  version: number;
  revisionId: string | null;
  factUpdatedEventId: string | null;
  conflictResolvedEventId: string;
  sync: Record<string, unknown> | null;
}

/** POST /v1/tasks/:id/reconcile 200 载荷 */
export interface TaskReconcileResult {
  task: TaskDetail;
  reconciliation: { resolution: "completed" | "failed"; event_id: string; sequence: number };
}

export const api = {
  listSessions(base: string, include?: SessionListInclude): Promise<SessionSummary[]> {
    const query = include === undefined ? "" : `?include=${encodeURIComponent(include)}`;
    return request<{ sessions: SessionSummary[] }>(base, `/v1/sessions${query}`).then((r) => r.sessions);
  },

  renameSession(base: string, sessionId: string, title: string): Promise<SessionMetadataMutation> {
    return request<SessionMetadataMutation>(base, `/v1/sessions/${encodeURIComponent(sessionId)}/rename`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title }),
    });
  },

  archiveSession(base: string, sessionId: string): Promise<SessionMetadataMutation> {
    return request<SessionMetadataMutation>(base, `/v1/sessions/${encodeURIComponent(sessionId)}/archive`, {
      method: "POST",
      headers: JSON_HEADERS,
    });
  },

  unarchiveSession(base: string, sessionId: string): Promise<SessionMetadataMutation> {
    return request<SessionMetadataMutation>(base, `/v1/sessions/${encodeURIComponent(sessionId)}/unarchive`, {
      method: "POST",
      headers: JSON_HEADERS,
    });
  },

  restoreSession(base: string, sessionId: string): Promise<SessionMetadataMutation> {
    return request<SessionMetadataMutation>(base, `/v1/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
      headers: JSON_HEADERS,
    });
  },

  /** 软删（30 天内可恢复；删除不影响记忆） */
  deleteSession(base: string, sessionId: string): Promise<SessionMetadataMutation> {
    return request<SessionMetadataMutation>(base, `/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  },

  // --- 会话工作区与附件（票 M7-A-T4 / Issue #61）---

  bindWorkspace(base: string, sessionId: string, body: WorkspaceBindingRequest): Promise<SessionWorkspaceMutation> {
    return request<SessionWorkspaceMutation>(base, `/v1/sessions/${encodeURIComponent(sessionId)}/workspace`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  },

  listAttachments(base: string, sessionId: string): Promise<SessionAttachmentsResult> {
    return request<SessionAttachmentsResult>(base, `/v1/sessions/${encodeURIComponent(sessionId)}/attachments`);
  },

  addAttachments(base: string, sessionId: string, paths: string[]): Promise<SessionAttachmentsResult> {
    return request<SessionAttachmentsResult>(base, `/v1/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ paths }),
    });
  },

  removeAttachments(base: string, sessionId: string, paths: string[]): Promise<SessionAttachmentsResult> {
    return request<SessionAttachmentsResult>(base, `/v1/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ paths }),
    });
  },

  createSession(base: string, title?: string): Promise<{ session_id: string }> {
    return request<{ session_id: string }>(base, "/v1/sessions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(title === undefined ? {} : { title }),
    });
  },

  /** 临时会话（票 M7-A-T3）：kind=ephemeral；写入隔离 + 禁写入类能力 + 24h 生命周期 */
  createEphemeralSession(base: string, title?: string): Promise<{ session_id: string; kind: "ephemeral" }> {
    return request<{ session_id: string; kind: "ephemeral" }>(base, "/v1/sessions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(title === undefined ? { kind: "ephemeral" } : { kind: "ephemeral", title }),
    });
  },

  /** 临时会话关闭；返回 restorable_until（24h 窗口截止） */
  closeSession(base: string, sessionId: string): Promise<CloseSessionResult> {
    return request<CloseSessionResult>(base, `/v1/sessions/${sessionId}/close`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{}",
    });
  },

  /** 只读记忆视图（票 M7-A-T6）：tree = 按 kind 分组 + 弱主题聚类；timeline = 倒序分页 */
  memoryOverview(
    base: string,
    options: { view: "tree" | "timeline"; scope?: string; limit?: number; offset?: number },
  ): Promise<MemoryOverviewResponse> {
    const params = new URLSearchParams({ view: options.view });
    if (options.scope !== undefined) params.set("scope", options.scope);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    return request<MemoryOverviewResponse>(base, `/v1/memory/overview?${params.toString()}`);
  },

  /** 记忆检索（票 M7-A-T3：scope=session:<id> 看到全局 + 该会话；缺省全局） */
  searchMemory(base: string, q: string, scope?: string): Promise<MemoryHit[]> {
    const params = new URLSearchParams({ q });
    if (scope !== undefined) params.set("scope", scope);
    return request<{ facts: MemoryHit[] }>(base, `/v1/memory/facts?${params.toString()}`).then((r) => r.facts);
  },

  /** 提升为长期记忆（scope session:* → owner；非 session scope 409） */
  promoteMemory(base: string, entryId: string): Promise<PromoteMemoryResult> {
    return request<PromoteMemoryResult>(base, `/v1/memory/${entryId}/promote`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{}",
    });
  },

  // --- 全局 Persona（票 M7-A-T1 / Issue #58，ADR-0009） ---

  getPersona(base: string): Promise<Persona> {
    return request<{ persona: Persona }>(base, "/v1/persona").then((r) => r.persona);
  },

  updatePersona(base: string, persona: Persona): Promise<Persona> {
    return request<{ persona: Persona }>(base, "/v1/persona", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(persona),
    }).then((r) => r.persona);
  },

  history(base: string, sessionId: string): Promise<SessionHistory> {
    return request<SessionHistory>(base, `/v1/sessions/${sessionId}/messages`);
  },

  sendMessage(base: string, sessionId: string, text: string): Promise<void> {
    return request<unknown>(base, `/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ text }),
    }).then(() => undefined);
  },

  // --- Provider 族与健康（票 T7 / Issue #8；密钥只在 create/update 的请求体里出现一次，响应永不回传） ---

  listProviders(base: string): Promise<ProviderListResponse> {
    return request<ProviderListResponse>(base, "/v1/providers");
  },

  createProvider(base: string, payload: object): Promise<ProviderRecord> {
    return request<ProviderRecord>(base, "/v1/providers", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    });
  },

  updateProvider(base: string, providerId: string, patch: object): Promise<ProviderRecord> {
    return request<ProviderRecord>(base, `/v1/providers/${encodeURIComponent(providerId)}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    });
  },

  deleteProvider(base: string, providerId: string): Promise<void> {
    return request<unknown>(base, `/v1/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    }).then(() => undefined);
  },

  setDefaultProvider(base: string, providerId: string): Promise<{ default_provider_id: string }> {
    return request<{ default_provider_id: string }>(
      base,
      `/v1/providers/${encodeURIComponent(providerId)}/default`,
      { method: "POST" },
    );
  },

  testProvider(base: string, providerId: string): Promise<ConnectivityResult> {
    return request<ConnectivityResult>(base, `/v1/providers/${encodeURIComponent(providerId)}/test`, {
      method: "POST",
    });
  },

  health(base: string): Promise<HealthPayload> {
    return request<HealthPayload>(base, "/v1/health");
  },

  // --- 任务域（票 M1-T6 / Issue #18）-------------------------------------------

  listTasks(base: string, sessionId?: string): Promise<TaskSummary[]> {
    const query = sessionId === undefined ? "" : `?session_id=${encodeURIComponent(sessionId)}`;
    return request<{ tasks: TaskSummary[] }>(base, `/v1/tasks${query}`).then((r) => r.tasks);
  },

  getTask(base: string, taskId: string): Promise<TaskDetail> {
    return request<TaskDetail>(base, `/v1/tasks/${encodeURIComponent(taskId)}`);
  },

  taskEvents(base: string, taskId: string, limit: number, offset: number): Promise<TaskEventsPage> {
    return request<TaskEventsPage>(
      base,
      `/v1/tasks/${encodeURIComponent(taskId)}/events?limit=${limit}&offset=${offset}`,
    );
  },

  taskCheckpoints(base: string, taskId: string): Promise<TaskCheckpointMeta[]> {
    return request<{ checkpoints: TaskCheckpointMeta[] }>(
      base,
      `/v1/tasks/${encodeURIComponent(taskId)}/checkpoints`,
    ).then((r) => r.checkpoints);
  },

  pauseTask(base: string, taskId: string): Promise<{ task: TaskSummary; checkpoint: TaskCheckpointMeta }> {
    return request(base, `/v1/tasks/${encodeURIComponent(taskId)}/pause`, { method: "POST" });
  },

  resumeTask(base: string, taskId: string): Promise<TaskResumeResult> {
    return request<TaskResumeResult>(base, `/v1/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
  },

  restoreTask(base: string, taskId: string, checkpointId: string): Promise<TaskResumeResult> {
    return request<TaskResumeResult>(base, `/v1/tasks/${encodeURIComponent(taskId)}/restore`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ checkpoint_id: checkpointId }),
    });
  },

  reviseTask(base: string, taskId: string, revision: TaskRevisionBody): Promise<{ task: TaskDetail }> {
    return request(base, `/v1/tasks/${encodeURIComponent(taskId)}/revise`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(revision),
    });
  },

  takeoverNode(base: string, taskId: string, nodeId: string): Promise<{ task: TaskDetail }> {
    return request(base, `/v1/tasks/${encodeURIComponent(taskId)}/nodes/${encodeURIComponent(nodeId)}/takeover`, {
      method: "POST",
    });
  },

  completeNode(base: string, taskId: string, nodeId: string, result: string): Promise<{ task: TaskDetail }> {
    return request(base, `/v1/tasks/${encodeURIComponent(taskId)}/nodes/${encodeURIComponent(nodeId)}/complete`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ result }),
    });
  },

  releaseNode(base: string, taskId: string, nodeId: string): Promise<{ task: TaskDetail }> {
    return request(base, `/v1/tasks/${encodeURIComponent(taskId)}/nodes/${encodeURIComponent(nodeId)}/release`, {
      method: "POST",
    });
  },

  // --- 能力域（票 M2-T6 / Issue #27；T1 已交付端点，类型唯一真相源在 @morrow/protocol）---

  listCapabilities(
    base: string,
    filters?: { status?: "enabled" | "disabled"; author?: "human" | "ai"; runtime?: "typescript" | "go" },
  ): Promise<CapabilityRecord[]> {
    const params = new URLSearchParams();
    if (filters?.status !== undefined) params.set("status", filters.status);
    if (filters?.author !== undefined) params.set("author", filters.author);
    if (filters?.runtime !== undefined) params.set("runtime", filters.runtime);
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    return request<{ capabilities: CapabilityRecord[] }>(base, `/v1/capabilities${query}`).then((r) => r.capabilities);
  },

  getCapability(base: string, name: string): Promise<CapabilityDetail> {
    return request<CapabilityDetail>(base, `/v1/capabilities/${encodeURIComponent(name)}`);
  },

  setCapabilityStatus(
    base: string,
    name: string,
    action: "enable" | "disable",
  ): Promise<{ capability: CapabilityRecord; changed: boolean }> {
    return request(base, `/v1/capabilities/${encodeURIComponent(name)}/${action}`, { method: "POST" });
  },

  rollbackCapability(base: string, name: string, version: string): Promise<CapabilityRollbackResult> {
    return request(base, `/v1/capabilities/${encodeURIComponent(name)}/rollback`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ version }),
    });
  },

  getGrants(base: string): Promise<PermissionGrant> {
    return request<{ grants: PermissionGrant }>(base, "/v1/capabilities/grants").then((r) => r.grants);
  },

  putGrants(base: string, grants: PermissionGrant): Promise<{ grants: PermissionGrant; event_id: string | null }> {
    return request(base, "/v1/capabilities/grants", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ grants }),
    });
  },

  // 工厂端点（T3 已合入，真实合约）：POST /v1/capabilities/request + 进度轮询
  // GET /v1/capabilities/requests/:id + 确认注册 POST /v1/capabilities/:id/confirm。
  requestCapabilityFactory(base: string, requirement: string): Promise<FactoryRequest> {
    return request<FactoryRequest>(base, "/v1/capabilities/request", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: requirement }),
    });
  },

  getCapabilityFactoryRequest(base: string, requestId: string): Promise<FactoryRequest> {
    return request<FactoryRequest>(base, `/v1/capabilities/requests/${encodeURIComponent(requestId)}`);
  },

  /** Owner 确认门：proposed → 注册（author=ai 默认 disabled）。返回确认后的请求视图。 */
  confirmCapabilityFactory(base: string, requestId: string): Promise<FactoryRequest> {
    return request<{ request: FactoryRequest }>(
      base,
      `/v1/capabilities/${encodeURIComponent(requestId)}/confirm`,
      { method: "POST" },
    ).then((r) => r.request);
  },

  // Skill 端点（T5 已合入）：runtime 侧双路径族——/v1/skills*（UI 合约）与
  // /v1/capabilities/skills*（能力域家族）同 handler 同形状。
  listSkills(base: string): Promise<SkillSummary[]> {
    return request<{ skills: SkillSummary[] }>(base, "/v1/skills").then((r) => r.skills);
  },

  listSkillProposals(base: string): Promise<SkillProposal[]> {
    return request<{ proposals: SkillProposal[] }>(base, "/v1/skills/proposals").then((r) => r.proposals);
  },

  decideSkillProposal(
    base: string,
    proposalId: string,
    decision: "approve" | "reject",
  ): Promise<SkillProposal> {
    return request<SkillProposal>(base, `/v1/skills/proposals/${encodeURIComponent(proposalId)}/${decision}`, {
      method: "POST",
    });
  },

  // --- 设备与同步（票 M3-T6 / Issue #35；端点由 M3-T1/T2/T3/T4 提供）-------------

  /** GET /v1/devices（本机自注册行在前，按 created_at 排序；投影不含 token 摘要） */
  listDevices(base: string): Promise<DeviceInfo[]> {
    return request<{ devices: DeviceInfo[] }>(base, "/v1/devices").then((r) => r.devices);
  },

  /** POST /v1/pairing/codes（201）：一次性 6 位码 + 过期时间 + 本机指纹 */
  createPairingCode(base: string): Promise<PairingCodeResponse> {
    return request<PairingCodeResponse>(base, "/v1/pairing/codes", { method: "POST" });
  },

  /**
   * POST /v1/pairing/claim：新设备凭码加入信任网络。
   * `base` 是**被加入的那个 Runtime**（不是本机控制面）——加入设备向导允许输入地址；
   * 响应里 token 仅此一次出现，浏览器侧不持久化（桌面壳应存 OS 凭据库）。
   */
  claimPairing(base: string, body: PairingClaimRequest): Promise<PairingClaimResponse> {
    return request<PairingClaimResponse>(base, "/v1/pairing/claim", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  },

  /**
   * POST /v1/pairing/join：让**本机 Runtime** 作为新设备加入 `base_url` 对端。
   * token 由 Runtime 写本机 OS 凭据库，浏览器全程不接触。
   */
  joinPairing(base: string, body: PairingJoinRequest): Promise<PairingJoinResponse> {
    return request<PairingJoinResponse>(base, "/v1/pairing/join", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  },

  /** DELETE /v1/devices/:id：撤销（revoked=1 + 清鉴权能力，保留审计墓碑） */
  revokeDevice(base: string, deviceId: string): Promise<{ device: DeviceInfo; changed: boolean }> {
    return request<{ device: DeviceInfo; changed: boolean }>(
      base,
      `/v1/devices/${encodeURIComponent(deviceId)}`,
      { method: "DELETE" },
    );
  },

  /** GET /v1/sync/status：本副本 sequence + 各 peer 游标/待上传/待下载/最后同步 */
  syncStatus(base: string): Promise<SyncStatus> {
    return request<SyncStatus>(base, "/v1/sync/status");
  },

  /** POST /v1/sync/run：立即同步一轮（可指定单个 peer；缺省全部已配对） */
  syncRun(base: string, peerReplicaId?: string): Promise<SyncRunReport> {
    return request<SyncRunReport>(base, "/v1/sync/run", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(peerReplicaId === undefined ? {} : { peer_replica_id: peerReplicaId }),
    });
  },

  /** GET /v1/sync/conflicts?status=：跨设备冲突汇总（复用 M1 冲突队列） */
  syncConflicts(base: string, status?: "open" | "resolved"): Promise<SyncConflictView[]> {
    const query = status === undefined ? "" : `?status=${status}`;
    return request<{ conflicts: SyncConflictView[] }>(base, `/v1/sync/conflicts${query}`).then(
      (r) => r.conflicts,
    );
  },

  /** POST /v1/sync/conflicts/:id/resolve：复用 M1 裁决语义（keep_old/keep_new/merge） */
  resolveSyncConflict(
    base: string,
    conflictId: string,
    body: { resolution: "keep_old" | "keep_new" | "merge"; content?: string },
  ): Promise<SyncConflictResolveResult> {
    return request<SyncConflictResolveResult>(
      base,
      `/v1/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) },
    );
  },

  /** GET /v1/tasks/:id/execution：租约 + 双端独立执行证据（needs_reconcile 的事实依据） */
  taskExecution(base: string, taskId: string): Promise<TaskExecutionState> {
    return request<TaskExecutionState>(base, `/v1/tasks/${encodeURIComponent(taskId)}/execution`);
  },

  /** POST /v1/tasks/:id/reconcile：Owner 显式裁决 needs_reconcile → completed | failed */
  reconcileTask(
    base: string,
    taskId: string,
    body: { resolution: "completed" | "failed"; note?: string },
  ): Promise<TaskReconcileResult> {
    return request<TaskReconcileResult>(base, `/v1/tasks/${encodeURIComponent(taskId)}/reconcile`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  },

  // --- 渠道与联系人（M4-T8 / Issue #45；端点由 M4-T1/T2/T5/T6/T7 提供）-----------

  /** GET /v1/channels：适配器清单（state/enabled/capabilities/experimental/risk_notice） */
  listChannels(base: string): Promise<ChannelSummary[]> {
    return request<{ channels: ChannelSummary[] }>(base, "/v1/channels").then((r) => r.channels);
  },

  /** GET /v1/channels/:id/health：连接/token 有效期/最近错误/本地桥 */
  channelHealth(base: string, channelId: string): Promise<ChannelHealth> {
    return request<ChannelHealth>(base, `/v1/channels/${encodeURIComponent(channelId)}/health`);
  },

  /** POST /v1/channels/:id/enable：实验适配器必须带 confirm_risk=true（否则 409） */
  enableChannel(base: string, channelId: string, confirmRisk: boolean): Promise<{ channel: string; enabled: boolean }> {
    return request<{ channel: string; enabled: boolean }>(
      base,
      `/v1/channels/${encodeURIComponent(channelId)}/enable`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ confirm_risk: confirmRisk }) },
    );
  },

  /** POST /v1/channels/:id/disable：实验适配器立即停止收发（幂等） */
  disableChannel(base: string, channelId: string): Promise<{ channel: string; enabled: boolean }> {
    return request<{ channel: string; enabled: boolean }>(
      base,
      `/v1/channels/${encodeURIComponent(channelId)}/disable`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}) },
    );
  },

  /** GET /v1/channels/:id/allowlist：群聊白名单（会话 id × 模式） */
  getAllowlist(
    base: string,
    channelId: string,
  ): Promise<{ channel: string; account_id: string | null; allowlist: ChannelAllowlistEntryView[] }> {
    return request(base, `/v1/channels/${encodeURIComponent(channelId)}/allowlist`);
  },

  /** PUT /v1/channels/:id/allowlist：整表替换（mention_only | proactive_limited）+ 审计 */
  putAllowlist(
    base: string,
    channelId: string,
    entries: Array<{ native_conversation_id: string; mode: ChannelAllowMode }>,
  ): Promise<{ channel: string; account_id: string | null; allowlist: ChannelAllowlistEntryView[] }> {
    return request(base, `/v1/channels/${encodeURIComponent(channelId)}/allowlist`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ allowlist: entries }),
    });
  },

  /** GET /v1/channels/:id/notify-target：默认通知会话（未配置 native_conversation_id=null） */
  getChannelNotifyTarget(base: string, channelId: string): Promise<ChannelNotifyTargetView> {
    return request<ChannelNotifyTargetView>(base, `/v1/channels/${encodeURIComponent(channelId)}/notify-target`);
  },

  /**
   * PUT /v1/channels/:id/notify-target：channel:<id> 通知规则保存的前置条件。
   * 会话必须已存在或已加入白名单，否则 400（conversation_not_found）。
   */
  putChannelNotifyTarget(
    base: string,
    channelId: string,
    nativeConversationId: string,
  ): Promise<ChannelNotifyTargetView> {
    return request<ChannelNotifyTargetView>(base, `/v1/channels/${encodeURIComponent(channelId)}/notify-target`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ native_conversation_id: nativeConversationId }),
    });
  },

  /** GET /v1/channels/:id/secrets：凭据字段投影（configured 布尔，绝不回显密文） */
  getChannelSecrets(base: string, channelId: string): Promise<ChannelSecretsView> {
    return request<ChannelSecretsView>(base, `/v1/channels/${encodeURIComponent(channelId)}/secrets`);
  },

  /** PUT /v1/channels/:id/secrets：写 SecretStore（只提交本次要改的字段） */
  putChannelSecrets(
    base: string,
    channelId: string,
    secrets: Record<string, string>,
  ): Promise<ChannelSecretsView> {
    return request<ChannelSecretsView>(base, `/v1/channels/${encodeURIComponent(channelId)}/secrets`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ secrets }),
    });
  },

  /** GET /v1/contacts：联系人 + 授权 + 平台身份绑定 */
  listContacts(base: string): Promise<ContactView[]> {
    return request<{ contacts: ContactView[] }>(base, "/v1/contacts").then((r) => r.contacts);
  },

  /** POST /v1/contacts/invites：一次性邀请码（code 只返回一次，24h 有效） */
  createContactInvite(
    base: string,
    body: { display_name?: string; contact_id?: string; ttl_ms?: number },
  ): Promise<ContactInviteView> {
    return request<ContactInviteView>(base, "/v1/contacts/invites", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  },

  /** PUT /v1/contacts/:id/grants：授权类别整表替换（query/task_execute/memory_reference） */
  putContactGrants(
    base: string,
    contactId: string,
    grants: Array<{ category: ContactCapabilityCategory; scope?: string[] }>,
  ): Promise<{ contact_id: string; grants: ContactGrantView[] }> {
    return request(base, `/v1/contacts/${encodeURIComponent(contactId)}/grants`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ grants }),
    });
  },

  /** GET /v1/contacts/ambiguities?status=open：身份歧义待 Owner 选择 */
  listContactAmbiguities(base: string, status?: "open" | "resolved"): Promise<ContactAmbiguityView[]> {
    const query = status === undefined ? "" : `?status=${status}`;
    return request<{ ambiguities: ContactAmbiguityView[] }>(base, `/v1/contacts/ambiguities${query}`).then(
      (r) => r.ambiguities,
    );
  },

  /** POST /v1/contacts/ambiguities/:id/resolve：显式选择联系人（不自动合并） */
  resolveContactAmbiguity(
    base: string,
    ambiguityId: string,
    contactId: string,
  ): Promise<ContactAmbiguityView> {
    return request<ContactAmbiguityView>(
      base,
      `/v1/contacts/ambiguities/${encodeURIComponent(ambiguityId)}/resolve`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ contact_id: contactId }) },
    );
  },

  /** GET /v1/notifications/rules：事件 × 目标规则清单 */
  listNotificationRules(base: string): Promise<NotificationRule[]> {
    return request<{ rules: NotificationRule[] }>(base, "/v1/notifications/rules").then((r) => r.rules);
  },

  /** PUT /v1/notifications/rules：按 (event_type, target) key 合并 upsert */
  putNotificationRules(base: string, rules: NotificationRuleInput[]): Promise<NotificationRule[]> {
    return request<{ rules: NotificationRule[] }>(base, "/v1/notifications/rules", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ rules }),
    }).then((r) => r.rules);
  },

  /** GET /v1/notifications/pending：桌面待拉取（服务端已放行到点的免打扰延迟行） */
  listPendingNotifications(base: string): Promise<NotificationRecord[]> {
    return request<{ notifications: NotificationRecord[] }>(base, "/v1/notifications/pending").then(
      (r) => r.notifications,
    );
  },

  /** POST /v1/notifications/:id/ack：桌面已展示/已读确认（pending → sent） */
  ackNotification(base: string, notificationId: string): Promise<NotificationRecord> {
    return request<{ notification: NotificationRecord }>(
      base,
      `/v1/notifications/${encodeURIComponent(notificationId)}/ack`,
      { method: "POST", headers: JSON_HEADERS },
    ).then((r) => r.notification);
  },

  /** GET /v1/outbox?status=&limit=&offset=：外发审计列表（人工核对入口） */
  listOutbox(
    base: string,
    options: { status?: OutboxStatus; limit?: number; offset?: number } = {},
  ): Promise<OutboxListPage> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    return request<OutboxListPage>(base, `/v1/outbox${query}`);
  },

  /** POST /v1/outbox/:id/retry：failed 直接重试；needs_review 必须 confirmed=true */
  retryOutbox(base: string, outboxId: string, confirmed: boolean): Promise<{ message: OutboxListPage["messages"][number] }> {
    return request(base, `/v1/outbox/${encodeURIComponent(outboxId)}/retry`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(confirmed ? { confirmed: true } : {}),
    });
  },

  /** POST /v1/outbox/:id/mark-sent：线下核对后人工标记已送达（写 manual receipt） */
  markOutboxSent(
    base: string,
    outboxId: string,
    body: { platform_message_id?: string; note?: string } = {},
  ): Promise<{ message: OutboxListPage["messages"][number] }> {
    return request(base, `/v1/outbox/${encodeURIComponent(outboxId)}/mark-sent`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  },
};
