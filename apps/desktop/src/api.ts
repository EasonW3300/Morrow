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
  ConnectivityResult,
  PermissionGrant,
  ProviderRecord,
  TaskDetail,
  TaskNodeRecord,
  TaskSummary,
} from "@morrow/protocol/browser";
export type { CapabilityRecord, CapabilityVersionRecord, ConnectivityResult, PermissionGrant, ProviderRecord, TaskDetail, TaskNodeRecord, TaskSummary };
// 能力域 UI 侧类型（SkillSummary/SkillProposal 在 capability-ui 定义；工厂投影在本文件）
import type { SkillProposal, SkillSummary } from "./capability-ui.ts";
export type { SkillProposal, SkillSummary };
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // 非 JSON 错误体，保留 statusText
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export interface SessionSummary {
  session_id: string;
  title?: string;
  occurred_at: string;
  sequence: number;
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
 * 工厂请求投影（T3 接缝；形状与 capability-ui 的 FactoryStage / VerificationReportItem 对齐）。
 * T3 落地后以其真实 schema 为准——本投影只承诺 UI 渲染所需的最小字段集。
 */
export interface FactoryRequest {
  request_id: string;
  requirement: string;
  stage:
    | "retrieval"
    | "planning"
    | "building"
    | "verifying"
    | "awaiting_confirmation"
    | "registered"
    | "failed";
  /** 阶段说明（进度区副文案；可缺省） */
  stage_detail?: string;
  /** awaiting_confirmation 起携带：候选 manifest（确认注册即提交它） */
  manifest?: Record<string, unknown>;
  /** verifying/awaiting_confirmation 携带：四类测试结果 */
  verification?: Array<{
    category: "schema" | "permission" | "functional" | "sandbox";
    passed: boolean;
    summary: string;
  }>;
  error?: string;
}

const JSON_HEADERS = { "content-type": "application/json" };

export const api = {
  listSessions(base: string): Promise<SessionSummary[]> {
    return request<{ sessions: SessionSummary[] }>(base, "/v1/sessions").then((r) => r.sessions);
  },

  createSession(base: string, title?: string): Promise<{ session_id: string }> {
    return request<{ session_id: string }>(base, "/v1/sessions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(title === undefined ? {} : { title }),
    });
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

  // ⚠️ 接缝（票 M2-T6 / Issue #27）：Tool Factory 端点由 T3 交付（PRD §6.2 的
  // POST /v1/capabilities/request + 进度轮询 + 确认注册）。以下封装在 T3 落地前只会命中
  // 404（capability-fixture 的 mock 端点提供演示数据）；T3 合入后无需改 UI——路径即合约。
  requestCapabilityFactory(base: string, requirement: string): Promise<FactoryRequest> {
    return request<FactoryRequest>(base, "/v1/capabilities/request", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ requirement }),
    });
  },

  getCapabilityFactoryRequest(base: string, requestId: string): Promise<FactoryRequest> {
    return request<FactoryRequest>(base, `/v1/capabilities/request/${encodeURIComponent(requestId)}`);
  },

  confirmCapabilityFactory(base: string, requestId: string): Promise<FactoryRequest> {
    return request<FactoryRequest>(base, `/v1/capabilities/request/${encodeURIComponent(requestId)}/confirm`, {
      method: "POST",
    });
  },

  // ⚠️ 接缝（票 M2-T6 / Issue #27）：Skill 清单与提案端点由 T5 交付。同上：UI 先行，
  // 404 时界面提示「端点未接入（T5）」；capability-fixture 提供演示数据。
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
};
