import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPiAdapter, type AgentRuntime, type MorrowTool } from "@morrow/pi-adapter";
import packageJson from "../package.json" with { type: "json" };
import piAdapterPackageJson from "../../../packages/pi-adapter/package.json" with { type: "json" };
import { ensureBuiltinCapabilities, MEMORY_WRITE_CAPABILITY_MANIFEST } from "./capabilities/builtin.ts";
import { CAPABILITY_EVENT_TYPES, PermissionEngine, type CapabilityLifecycleEvent } from "./capabilities/engine.ts";
import type { CapabilityRecord } from "@morrow/protocol";
import { capabilityRoutes } from "./capabilities/routes.ts";
import { skillRoutes } from "./capabilities/skills/routes.ts";
import { SkillService } from "./capabilities/skills/service.ts";
import { factoryRoutes } from "./capabilities/factory/routes.ts";
import { CapabilityFactory } from "./capabilities/factory/service.ts";
import { CAPABILITY_FACTORY_SYSTEM_PROMPT, PiCapabilityGenerator, type CapabilityGenerator } from "./capabilities/factory/generator.ts";
import type { RuntimeConfig } from "./config.ts";
import { testProviderConnectivity } from "./connectivity.ts";
import { DeviceRegistry, type DeviceRecord } from "./devices.ts";
import { detectSecretStore, type SecretStore } from "./keyring.ts";
import { DeviceIdentity } from "./pairing/identity.ts";
import { PairingService } from "./pairing/service.ts";
import { authorizeRequest } from "./pairing/auth.ts";
import { pairingRoutes } from "./pairing/routes.ts";
import { probeSandbox } from "./health.ts";
import { EventLedger } from "./ledger.ts";
import { MemoryService } from "./memory/service.ts";
import { MemoryStore } from "./memory/store.ts";
import { createMemoryWriteTool } from "./memory/tool.ts";
import { memoryRoutes } from "./memory/routes.ts";
import { MemoryProjector } from "./memory/projection.ts";
import { LlmMemoryExtractor, LLM_EXTRACTOR_SYSTEM_PROMPT, type MemoryExtractor } from "./memory/extraction.ts";
import { SyncCursorStore } from "./sync/cursors.ts";
import { SyncEngine } from "./sync/engine.ts";
import { syncRoutes } from "./sync/routes.ts";
import type { SyncTransport } from "./sync/transport.ts";
import { DeviceSyncTransport } from "./sync/device-transport.ts";
import { TombstoneStore } from "./sync/tombstones.ts";
import { SyncConflictStore } from "./sync/conflict-store.ts";
import { MemorySyncService } from "./sync/memory-sync.ts";
import { SyncFileMerger } from "./sync/files.ts";
import { MemoryProjectionRebuilder } from "./memory/rebuild.ts";
import { TaskProjectionRebuilder } from "./task-rebuild.ts";
import { ProviderRegistry, ProviderRegistryError, ENV_PROVIDER_ID, type ProviderResolver, type ResolvedProvider } from "./providers.ts";
import { SessionManager, type AgentRuntimeExtras, type SessionFrame } from "./sessions.ts";
import { ChannelRegistry } from "./channels/registry.ts";
import { channelRoutes } from "./channels/routes.ts";
import { createChannelOutboxAdapter } from "./channels/outbox-adapter.ts";
import { NotificationService } from "./notifications/service.ts";
import { notificationRoutes } from "./notifications/routes.ts";
import { TaskScheduler, type NodeAgentFactory, type TaskNodeExecInput } from "./scheduler.ts";
import { CheckpointError, CheckpointService } from "./checkpoint.ts";
import { PLANNER_SYSTEM_PROMPT, TaskError, TaskService, type PlannerFactory } from "./tasks.ts";
import { buildEventEnvelope } from "./envelope.ts";
import { computeIntegrityHash, type EventEnvelope } from "@morrow/protocol";
import { UUID_RE } from "./uuid-v7.ts";
import { parsePaging, readJsonBody, sendError, sendJson } from "./http-util.ts";
import { sendInvocationError } from "./invocation-errors.ts";
import { LockTable } from "./locks.ts";
import { LeaseStore } from "./lease/store.ts";
import { FencingGuard } from "./lease/fencing.ts";
import { detectDualExecution } from "./lease/reconcile.ts";
import { LeaseCoordinator } from "./lease/coordinator.ts";
import { OutboxService, type OutboxChannelAdapter } from "./outbox/service.ts";
import { outboxRoutes } from "./outbox/routes.ts";
import { WorktreeManager } from "./worktree.ts";
import { DockerRunner } from "./sandbox/docker-runner.ts";
import { ToolInvoker, type InvocationResult } from "./sandbox/invoker.ts";
import { createRegistryPermissionAdapter, type SandboxPermissionEngine } from "./sandbox/permission.ts";
import type { SandboxRunner } from "./sandbox/runner.ts";

/**
 * Runtime HTTP 服务（PRD §6.2 的 M0 子集 + M1 任务族 + M2-T1 能力族）。
 *
 * node:http + 极简路由，不引框架——为 T8 bun compile 单二进制留路（ADR-0003）。
 * 路由面：GET /v1/health、GET /v1/events、GET /v1/devices（M0 只读登记，票 #3）、
 * T4 会话族（POST/GET /v1/sessions、
 * POST/GET /v1/sessions/:id/messages、GET /v1/sessions/:id/stream SSE）、
 * T5 Provider 族（GET/POST /v1/providers、GET/PUT/DELETE /v1/providers/:id、
 * POST /v1/providers/:id/default、POST /v1/providers/:id/test）、
 * M1-T4 任务族（POST/GET /v1/tasks、GET /v1/tasks/:id、GET /v1/tasks/:id/events）、
 * M1-T2 记忆族（GET /v1/memory/facts、GET /v1/memory/candidates、
 * POST /v1/memory/candidates/:id/decide、GET /v1/memory/conflicts、
 * POST /v1/memory/conflicts/:id/resolve）+ M1-T3 记忆投影族
 * （POST /v1/memory/import 受控导入、DELETE /v1/memory/facts/:id 删除标记、
 * POST /v1/memory/project 投影再生成）、M2-T1 能力族
 * （POST/GET /v1/capabilities、GET/PUT /v1/capabilities/grants、
 * GET /v1/capabilities/:id、POST /v1/capabilities/:id/{enable,disable,rollback}、
 * POST /v1/capabilities/:id/invoke ——能力调用端点，#22 修复批 / FR-CAP-5：经
 * ToolInvoker 统一执行链，错误码按 invocation-errors.ts 映射表落 HTTP 状态）、
 * M2-T5 Skill 族（GET /v1/capabilities/skills[?match=]、GET/POST
 * /v1/capabilities/skills/cases、POST /v1/capabilities/skills[...]、
 * POST .../skills/:id/{approve,reject}、POST .../skills/:id/invoke +
 * T6 api.ts 合约别名 /v1/skills[...]）。
 * 未匹配路径 404，路径命中但方法不符 405（账本 append-only：对事件的任何变更
 * 方法在请求层即被拒绝）。
 * 生命周期：start 先监听后记账 runtime.started（携带实际端口），随后 builtin 工具
 * ensure-registered（memory.write，幂等），并把注册表全部 enabled 能力登记进
 * ToolInvoker 调用接缝（enable/disable/rollback 生命周期事件经 onLifecycle 驱动
 * 注册表的增删改——disable 后 invoke 报 unknown_tool）；close 先停收请求，再中止会话
 * 运行与在跑任务节点并释放 AgentRuntime，然后记账 runtime.stopped（causation 指向
 * started），最后关闭能力注册表、任务投影库与账本落盘。
 */

/** 版本号唯一来源：本包 package.json（main.ts 的 ready 行也从这里取——不再双真相源） */
export const VERSION: string = packageJson.version;

/** pi-adapter 包版本（checkpoint 快照 execution.tool_versions 的可证来源；M1 code-review 填实） */
export const PI_ADAPTER_VERSION: string = piAdapterPackageJson.version;

interface RequestContext {
  ledger: EventLedger;
  replicaId: string;
  sessions: SessionManager;
  providers: ProviderRegistry;
  devices: DeviceRegistry;
  /** 设备配对服务（M3-T2 / Issue #31：配对码 / claim / 撤销 / token 校验） */
  pairing: PairingService;
  tasks: TaskService;
  /** 任务调度器（POST /v1/tasks 规划成功后的后台触发点；生命周期归 startRuntime） */
  scheduler: TaskScheduler;
  /** Checkpoint 服务（M1-T5：pause/resume/restore/checkpoints 端点背后的快照与恢复） */
  checkpoints: CheckpointService;
  memory: MemoryService;
  /** 记忆投影器（票 M1-T3：/v1/memory/project 命令执行体） */
  projector: MemoryProjector;
  /** 能力注册表（票 M2-T1：PermissionEngine 单一入口——注册校验/生命周期/运行时复核） */
  capabilities: PermissionEngine;
  /** 沙箱工具调用接缝（M2-T2：invoke 端点与 Skill steps 共用的统一执行链） */
  sandbox: ToolInvoker;
  /** 能力工厂（票 M2-T3：生成闭环编排——检索/规划/构建/验证/确认门） */
  factory: CapabilityFactory;
  /** Skill 服务（票 M2-T5：案例收集/晋升提案/Owner 决策/重用调用/检索） */
  skills: SkillService;
  /** 同步引擎（M3-T1 / Issue #30：导出/导入/游标/缺口检测；库形态可直用） */
  sync: SyncEngine;
  /** 跨设备冲突元数据（M3-T3 / Issue #32：GET/POST /v1/sync/conflicts 的来源副本信息） */
  syncConflicts: SyncConflictStore;
  /** 执行租约（M3-T4 / Issue #33：单点执行 + fencing token） */
  leases: LeaseStore;
  /** 渠道适配器注册表（M4-T1 / Issue #38：GET /v1/channels + 统一入站路由） */
  channels: ChannelRegistry;
  /** 外发副作用发件箱（M4-T2 / Issue #39：先落库再投递 + outbound.* 审计） */
  outbox: OutboxService;
  /** 通知规则与路由（M4-T7 / Issue #44：账本订阅 → 规则匹配 → 桌面/渠道） */
  notifications: NotificationService;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RequestContext,
  params: string[],
) => void | Promise<void>;

interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
}

export interface RuntimeOptions {
  /**
   * Agent Loop 运行时工厂（PiAdapter 接口注入 seam）。缺省时用默认工厂
   * （createPiAdapter，Provider 配置由 ProviderResolver 按会话解析）；
   * 无任何 Provider 时发消息 503（provider_not_configured）。
   */
  agentAdapterFactory?: (sessionId: string, provider: ResolvedProvider | null) => Promise<AgentRuntime>;
  /**
   * 凭据库注入 seam（票 T5）：缺省按平台探测（macOS Keychain 实测；Windows/Linux
   * 未实测）。测试与宿主可注入内存桩避免触碰用户钥匙串。
   */
  secretStore?: SecretStore;
  /**
   * 任务规划器工厂注入 seam（M1-T4 / Issue #16）：goal → 一次规划用 AgentRuntime
   * （系统提示词要求只输出 JSON 计划）。生产默认 = 默认 Provider + 规划系统提示词；
   * 测试注入 FakePi 脚本。注入时 POST /v1/tasks 不做 Provider 预检（语义对齐会话）。
   */
  taskPlannerFactory?: PlannerFactory;
  /**
   * 任务节点执行工厂注入 seam：节点 → 一次执行用 AgentRuntime。生产默认 =
   * 默认工厂按注册 Provider id 解析 node.model（未命中回退默认 Provider，M1-T6 /
   * FR-TASK-3 模型切换）；测试注入 FakePi 脚本。
   */
  taskNodeAgentFactory?: NodeAgentFactory;
  /** 调度器同时在跑节点上限（默认 2，最小 1；调度器级上限，跨任务成立） */
  taskConcurrency?: number;
  /**
   * 后台抽取器注入 seam（M1-T2 / Issue #14）：缺省 = 确定性启发式（HeuristicExtractor）；
   * 测试注入可控抽取（含失败注入——验证 fire-and-forget 不影响会话主链路），后续可接
   * LLM 抽取（经 PiAdapter）。
   */
  memoryExtractor?: MemoryExtractor;
  /**
   * 沙箱执行 Runner 注入 seam（M2-T2 / Issue #23）：缺省 = DockerRunner（探测本机
   * 容器运行时 docker/podman/OrbStack；无运行时 → sandboxed 调用拒绝）。测试注入
   * FakeRunner（零 docker）；Runner 仅服务 sandboxed 类工具，builtin 不经此路径。
   */
  sandboxRunner?: SandboxRunner;
  /**
   * 权限引擎注入 seam（M2-T2 接口桩，M2-T1 / Issue #22 单一入口合并后接管）：执行前
   * 运行时复核 assertRuntimeUse。缺省 = 确定性本地判定桩（network 矛盾 / workspace
   * 越界的 fail-closed 基线）。
   */
  permissionEngine?: SandboxPermissionEngine;
  /**
   * 能力工厂生成器注入 seam（M2-T3 / Issue #24）：缺省 = 默认 Provider + 工厂系统提示词
   * （经 PiAdapter 一次 prompt 产出计划 JSON）；测试注入脚本化生成器（零网络）。注入时
   * POST /v1/capabilities/request 不做 Provider 预检（fire-and-forget：失败落
   * factory_failed 事件，不以状态码转述）。
   */
  capabilityGenerator?: CapabilityGenerator;
  /**
   * Skill 能力调用接缝注入（M2-T5 / Issue #26）：Skill invoke 逐步调用 steps 引用的
   * capability。缺省 = runtime 的 ToolInvoker（T2 统一调用接缝；#22 修复批起缺省接线
   * 为真——enabled 能力经生命周期同步登记进注册表，执行前运行时复核）。测试仍可注入
   * FakeInvoker（零网络零 docker）。
   */
  skillInvoker?: {
    invoke(name: string, input: unknown, context?: { actorId?: string }): Promise<{ ok: boolean; result?: unknown; error_code?: string; error?: string; via?: string }>;
  };
  /** Skill 自动晋升阈值：同组合连续成功 ≥ N 产生提案（默认 2，最小 1） */
  skillPromotionThreshold?: number;
  /**
   * 同步出站传输注入 seam（M3-T1 / Issue #30；M3 同步接线修复 / Issue #34 起缺省已接线）：
   * 缺省按 devices 表 + SecretStore 构建 DeviceSyncTransport（启动即可同步）；注入
   * InMemorySyncTransport 服务零网络契约测试，注入自定义实现覆盖真机夹具。
   */
  syncTransport?: SyncTransport;
  /**
   * 配对时钟注入 seam（M3-T2 / Issue #31）：配对码 5 分钟 TTL 与撤销时间可被测试
   * 拨快，避免真实等待。缺省系统时间。
   */
  pairingNow?: () => Date;
  /**
   * 执行租约注入（M3-T4 / Issue #33）：缺省按 dataDir 打开 events.sqlite 同库租约表。
   * 注入共享实例用于双副本模拟；注入时本 runtime 不负责关闭。
   */
  leaseStore?: LeaseStore;
  /** 租约时钟注入（过期/续租测试零 sleep）；缺省系统时间 */
  leaseNow?: () => Date;
  /** 租约 TTL（毫秒，默认 30s） */
  leaseTtlMs?: number;
  /** 心跳续租间隔（毫秒，默认 ttl/3） */
  leaseHeartbeatMs?: number;
  /**
   * 跨设备事前互斥（M3 同步接线修复 / Issue #34）：缺省 true = acquire 前向已配对
   * peer 增量拉取并按事件重放远端租约。false 仅供需要纯本地语义的宿主/测试关闭。
   */
  leaseCoordination?: boolean;
  /** 同任务租约前拉取结果复用窗口（毫秒，默认 500；0 = 不节流） */
  leasePullThrottleMs?: number;
  /**
   * 渠道域（M4-T1 / Issue #38）：启用 echo 参考适配器（仅测试/开发）。缺省读
   * MORROW_CHANNEL_ECHO=1；显式 true 用于测试注入。生产适配器在后续票接入。
   */
  enableEchoChannel?: boolean;
  /**
   * Outbox 渠道适配器注入 seam（M4-T2 / Issue #39）：channel 域（M4-T1）启动后经
   * `runtime.outbox.setAdapter` 接线；测试注入计数桩。缺省 null = 未接线，
   * dispatchOnce 明确报 adapter_unavailable（不静默丢消息——消息仍留在 outbox 待发）。
   */
  outboxAdapter?: OutboxChannelAdapter;
  /** Outbox 时钟注入（退避/回执时间测试零 sleep）；缺省系统时间 */
  outboxNow?: () => Date;
  /** Outbox 明确失败的最大自动尝试次数（默认 5；耗尽转 needs_review） */
  outboxMaxAttempts?: number;
  /** Outbox 指数退避基数（毫秒，默认 1000） */
  outboxBackoffBaseMs?: number;
  /** Outbox 退避上限（毫秒，默认 60000） */
  outboxBackoffMaxMs?: number;
  /** Outbox 单次投递超时（毫秒，默认 10000；超时按 delivery_unknown 处理） */
  outboxSendTimeoutMs?: number;
  /** Outbox dispatchOnce 并发上限（默认 4） */
  outboxConcurrency?: number;
  /** 通知时钟注入（免打扰/去重窗口测试零 sleep）；缺省系统时间 */
  notificationNow?: () => Date;
  /** 去重窗口（毫秒，默认 600000 = 10 分钟） */
  notificationDedupeWindowMs?: number;
  /**
   * 通知调度间隔（毫秒）：定期放行到点的免打扰延迟行并投递 queued 渠道通知。
   * 默认 1000；0 = 不启动定时器（测试手动 drain，避免时序不确定）。
   */
  notificationDrainIntervalMs?: number;
}

export interface RuntimeHandle {
  host: string;
  port: number;
  ledger: EventLedger;
  /** Device 记录注册表（票 #3 最小实现；M3-T2 扩展为设备注册表） */
  devices: DeviceRegistry;
  /** 设备配对服务（M3-T2 / Issue #31：码生成/claim/撤销/token 校验，库形态可直用） */
  pairing: PairingService;
  /** 会话管理器（库形态可直用：abort / 订阅等测试与宿主 seam） */
  sessions: SessionManager;
  /** 记忆服务（票 M1-T1 / Issue #13：候选写入 + FTS 检索，库形态可直用） */
  memory: MemoryService;
  /** 记忆投影器（票 M1-T3 / Issue #15：dataDir/memory/*.md，幂等再生成，库形态可直用） */
  projector: MemoryProjector;
  /** 能力注册表（票 M2-T1 / Issue #22：注册表治理 + 五维权限判定，库形态可直用） */
  capabilities: PermissionEngine;
  /** Provider 注册表（库形态可直用：CRUD / 默认 / env 回退解析） */
  providers: ProviderRegistry;
  /** 任务服务（库形态可直用：createTask / 详情 / 状态机迁移；调度经 HTTP 自动触发） */
  tasks: TaskService;
  /** 任务调度器（库形态可直用：schedule/kick/pause/resume/transferExecution） */
  scheduler: TaskScheduler;
  /** Checkpoint 服务（库形态可直用：createCheckpoint / 列表 / restore 落地；M1-T5） */
  checkpoints: CheckpointService;
  /** 沙箱工具调用接缝（M2-T2 / Issue #23：sandboxed 与 builtin Go Worker 的统一注册/调用） */
  sandbox: ToolInvoker;
  /** 能力工厂（M2-T3 / Issue #24：submitRequest / getRequest / confirm，库形态可直用） */
  factory: CapabilityFactory;
  /** Skill 服务（M2-T5 / Issue #26：recordCase / propose / decide / invoke / matchSkills，库形态可直用） */
  skills: SkillService;
  /** 同步引擎（M3-T1 / Issue #30：exportBatch / receivePush / pullFromPeer / pushToPeer / status） */
  sync: SyncEngine;
  /** 删除集合（M3-T3 / Issue #32：fact / event tombstone，导入跳过已删数据） */
  tombstones: TombstoneStore;
  /** 跨设备冲突元数据（M3-T3：来源 replica + 三方版本；冲突本体在 M1 队列） */
  syncConflicts: SyncConflictStore;
  /** 记忆同步语义层（M3-T3：三方合并 + 投影重建；测试/运维可直用） */
  syncMemory: MemorySyncService;
  /** 文件竞争合并（M3-T3：保留 `<name>.conflict-<replica-short>` 双版本） */
  syncFiles: SyncFileMerger;
  /** 记忆投影重建器（M3-T3：rebuild / check） */
  memoryRebuilder: MemoryProjectionRebuilder;
  /** 任务投影重建器（M3 修复批 / #32 #36：从账本重放 task.* 事件；只写投影） */
  taskRebuilder: TaskProjectionRebuilder;
  /** 执行租约（M3-T4 / Issue #33：acquire/renew/release/validate/current，库形态可直用） */
  leases: LeaseStore;
  /** 跨设备执行权协调器（Issue #34：pre-acquire 拉取/远端租约重放；测试与运维可直用） */
  leaseCoordinator: LeaseCoordinator;
  /** 渠道适配器注册表（M4-T1 / Issue #38：清单/健康/入站路由，库形态可直用） */
  channels: ChannelRegistry;
  /** 外发副作用发件箱（M4-T2 / Issue #39：enqueue/dispatchOnce/retry/markSent，库形态可直用） */
  outbox: OutboxService;
  /** 通知规则与路由（M4-T7 / Issue #44：handleEnvelope/flushDue/dispatchQueued，库形态可直用） */
  notifications: NotificationService;
  /**
   * 优雅停止：停止接收请求 → 中止并释放会话运行时与在跑任务节点 → 记账 runtime.stopped
   * → 关闭任务投影库与账本（WAL checkpoint）。signal 传入收到的 POSIX 信号名，
   * 落进 stopped 事件的 payload。
   */
  close(signal?: string): Promise<void>;
}

const routes: Route[] = [
  { method: "GET", re: /^\/v1\/health$/, handler: handleHealth },
  { method: "GET", re: /^\/v1\/devices$/, handler: handleListDevices },
  // M3-T2 配对与设备管理（POST /v1/pairing/codes、POST /v1/pairing/claim、
  // DELETE /v1/devices/:id）——鉴权中间层见 routeRequest + ADR-0008。
  ...pairingRoutes,
  { method: "GET", re: /^\/v1\/events$/, handler: handleEvents },
  { method: "GET", re: /^\/v1\/providers$/, handler: handleListProviders },
  { method: "POST", re: /^\/v1\/providers$/, handler: handleRegisterProvider },
  { method: "GET", re: /^\/v1\/providers\/([^/]+)$/, handler: handleGetProvider },
  { method: "PUT", re: /^\/v1\/providers\/([^/]+)$/, handler: handleUpdateProvider },
  { method: "DELETE", re: /^\/v1\/providers\/([^/]+)$/, handler: handleDeleteProvider },
  { method: "POST", re: /^\/v1\/providers\/([^/]+)\/default$/, handler: handleSetDefaultProvider },
  { method: "POST", re: /^\/v1\/providers\/([^/]+)\/test$/, handler: handleTestProvider },
  { method: "POST", re: /^\/v1\/sessions$/, handler: handleCreateSession },
  { method: "GET", re: /^\/v1\/sessions$/, handler: handleListSessions },
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/messages$/, handler: handleHistory },
  { method: "POST", re: /^\/v1\/sessions\/([^/]+)\/messages$/, handler: handleSendMessage },
  { method: "GET", re: /^\/v1\/sessions\/([^/]+)\/stream$/, handler: handleStream },
  { method: "POST", re: /^\/v1\/tasks$/, handler: handleCreateTask },
  { method: "GET", re: /^\/v1\/tasks$/, handler: handleListTasks },
  { method: "GET", re: /^\/v1\/tasks\/([^/]+)$/, handler: handleGetTask },
  { method: "GET", re: /^\/v1\/tasks\/([^/]+)\/events$/, handler: handleTaskEvents },
  // M1-T5 介入端点（FR-TASK-3 暂停/恢复半边 + FR-TASK-5/6 Checkpoint 与恢复语义）
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/pause$/, handler: handlePauseTask },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/resume$/, handler: handleResumeTask },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/restore$/, handler: handleRestoreTask },
  { method: "GET", re: /^\/v1\/tasks\/([^/]+)\/checkpoints$/, handler: handleListCheckpoints },
  // M1-T6 介入端点（FR-TASK-3 修改/接管半边）：revise 修改未完成节点（版本+1+重算下游
  // +新 checkpoint）；supply 补充上下文（追加节点描述/任务目标，DAG 不变不升版本）；
  // 节点级 takeover/complete/release（actor=owner 审计）
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/revise$/, handler: handleReviseTask },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/supply$/, handler: handleSupplyTask },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/nodes\/([^/]+)\/takeover$/, handler: handleTakeoverNode },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/nodes\/([^/]+)\/complete$/, handler: handleCompleteNode },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/nodes\/([^/]+)\/release$/, handler: handleReleaseNode },
  // M3-T4 执行租约（Issue #33 / FR-DEP-4）：执行权查询/转移 + 双端独立执行的人工裁决
  { method: "GET", re: /^\/v1\/tasks\/([^/]+)\/execution$/, handler: handleTaskExecution },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/transfer-execution$/, handler: handleTransferExecution },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/reconcile$/, handler: handleReconcileTask },
  { method: "POST", re: /^\/v1\/tasks\/([^/]+)\/reconcile\/detect$/, handler: handleDetectReconcile },
  // M2-T5 Skill 族（GET /v1/capabilities/skills[?match=]、proposals、cases、approve/reject、
  // invoke + T6 别名 /v1/skills*）——必须先于 capabilityRoutes 展开：GET /v1/capabilities/:id
  // 的 `[^/]+` 会吞掉 /v1/capabilities/skills（grants 路由同款先具体后通配）
  ...skillRoutes,
  ...syncRoutes,
  ...outboxRoutes,
  ...notificationRoutes,
  ...memoryRoutes,
  ...channelRoutes,
  // 能力调用端点（#22 修复批 / FR-CAP-5）：POST /v1/capabilities/:id/invoke（body = 工具
  // input）——经 ToolInvoker 统一执行链（权限复核在链上），builtin 进程内直呼、sandboxed
  // 走容器；capability.used 审计先落账本后返回。与既有生命周期路由无路径/方法冲突。
  { method: "POST", re: /^\/v1\/capabilities\/([^/]+)\/invoke$/, handler: handleInvokeCapability },
  ...capabilityRoutes,
  // M2-T3 工厂端点（POST /v1/capabilities/request、GET /v1/capabilities/requests/:id、
  // POST /v1/capabilities/:id/confirm）——ctx.factory 桥接到 factory 自有路由签名
  ...factoryRoutes.map((route) => ({
    method: route.method,
    re: route.re,
    handler: (req: IncomingMessage, res: ServerResponse, url: URL, ctx: RequestContext, params: string[]) =>
      route.handler(req, res, url, ctx.factory, params),
  })),
];

export async function startRuntime(config: RuntimeConfig, options: RuntimeOptions = {}): Promise<RuntimeHandle> {
  const ledger = EventLedger.open(config.dataDir);
  // 执行租约（M3-T4 / Issue #33）：与任务投影同库。注入 store 时由宿主共享/关闭。
  const ownsLeases = options.leaseStore === undefined;
  const leases = options.leaseStore ?? new LeaseStore({
    dataDir: config.dataDir,
    ...(options.leaseNow === undefined ? {} : { now: options.leaseNow }),
  });
  const fencingGuard = new FencingGuard(leases);
  // Device 记录（票 #3 的 M0 最小实现 → M3-T2 设备注册表）：启动时从 replica-id
  // 演化出的 config.replicaId 种子本机行；配对/撤销见下 pairing。
  const devices = DeviceRegistry.open(config.dataDir);
  devices.touch(config.replicaId);
  // 设备身份与配对（M3-T2 / Issue #31）：私钥惰性生成进 OS 凭据库（service
  // com.morrow.device + replica_id）——纯本地回环部署不触碰钥匙串；首次配对才供给。
  // 同步传输在下面构建时要用同一个凭据库（读 token:<peer>），故提前到引擎之前。
  const secretStore = options.secretStore ?? detectSecretStore().store;
  // 出站同步传输（M3 同步接线修复 / Issue #34）：启动即按 devices 表接线——
  // base_url 从设备记录读、bearer token 从 SecretStore 读 `token:<peer>`。运行时
  // 设备增删由 DeviceSyncTransport 的读路径惰性重建 + PairingService 变更回调失效。
  // 宿主显式注入 syncTransport 时仍以注入为准（契约测试/真机夹具）。
  const deviceSyncTransport =
    options.syncTransport === undefined
      ? new DeviceSyncTransport({
          selfReplicaId: config.replicaId,
          devices,
          secretStore,
        })
      : undefined;
  const outboundTransport: SyncTransport = options.syncTransport ?? deviceSyncTransport!;
  // 同步引擎（M3-T1 / Issue #30）：游标表与账本同库。M3-T3：删除集合随引擎启动从
  // 账本重建；导入批次末尾回调记忆语义层（晚绑定——MemoryStore/MemorySyncService 在
  // 下方构建）。
  const syncCursors = SyncCursorStore.open(config.dataDir);
  const tombstones = TombstoneStore.open(config.dataDir);
  let afterSyncImport: ((envelopes: EventEnvelope[], peerReplicaId: string) => void) | undefined;
  const sync = new SyncEngine({
    ledger,
    replicaId: config.replicaId,
    cursors: syncCursors,
    tombstones,
    // M3 修复批（Issue #35）：「全部已配对 peer」= devices 表中 trusted、未撤销的远端
    // 设备；status.peers 与 POST /v1/sync/run 共用这一口径。同步成功后写设备
    // last_sync_at（设备列表「最后同步」不再是死字段）。
    knownPeers: () =>
      devices
        .list()
        .filter((device) => device.replica_id !== config.replicaId && device.trusted && !device.revoked)
        .map((device) => device.replica_id),
    onSynced: (peerReplicaId, at) => devices.markSynced(peerReplicaId, at),
    afterImport: (envelopes, peerReplicaId) => afterSyncImport?.(envelopes, peerReplicaId),
    transport: outboundTransport,
  });
  // 跨设备执行权协调（Issue #34）：acquire 前拉取 + 重放远端租约（只 pull 不 push，
  // 同任务 500ms 节流）；纯本地部署 peer 集为空，等价于无网络操作。
  const leaseCoordinator = new LeaseCoordinator({
    ledger,
    replicaId: config.replicaId,
    sync,
    now: options.leaseNow ?? (() => new Date()),
    ...(options.leasePullThrottleMs === undefined ? {} : { pullThrottleMs: options.leasePullThrottleMs }),
  });
  // 外发副作用发件箱（M4-T2 / Issue #39）：与账本/任务投影同库。接线适配器由 channel 域
  // 在启动后注入（options.outboxAdapter 供测试/宿主直连）。恢复在 runtime.started 落账后
  // 执行——先把上次进程「可能已发出」的 pending 行转 needs_review，绝不重发。
  const outbox = new OutboxService({
    dataDir: config.dataDir,
    ledger,
    replicaId: config.replicaId,
    leases,
    adapter: options.outboxAdapter ?? null,
    ...(options.outboxNow === undefined ? {} : { now: options.outboxNow }),
    ...(options.outboxMaxAttempts === undefined ? {} : { maxAttempts: options.outboxMaxAttempts }),
    ...(options.outboxBackoffBaseMs === undefined ? {} : { backoffBaseMs: options.outboxBackoffBaseMs }),
    ...(options.outboxBackoffMaxMs === undefined ? {} : { backoffMaxMs: options.outboxBackoffMaxMs }),
    ...(options.outboxSendTimeoutMs === undefined ? {} : { sendTimeoutMs: options.outboxSendTimeoutMs }),
    ...(options.outboxConcurrency === undefined ? {} : { concurrency: options.outboxConcurrency }),
  });
  // 本机对外基地址在 listen 后才确定；PairingService 通过闭包读取（join 时随 claim
  // 告知对端，对端据此反向出站同步）。
  let selfBaseUrl: string | null = null;
  const deviceIdentity = new DeviceIdentity({
    replicaId: config.replicaId,
    secretStore,
    devices,
    ...(options.pairingNow !== undefined ? { now: options.pairingNow } : {}),
  });
  const pairing = new PairingService({
    dataDir: config.dataDir,
    replicaId: config.replicaId,
    devices,
    identity: deviceIdentity,
    ledger,
    // join 拿到的对端 bearer token 只写本机 OS 凭据库（浏览器 WebView 无法安全持久化）
    secretStore,
    // 本机对外地址（listen 后赋值）：随 join 的 claim 告知对端，供反向出站同步。
    selfBaseUrl: () => selfBaseUrl,
    // 配对/撤销后立刻失效设备传输缓存（读路径也会惰性重建；这里是确定性的即时收回）。
    onDeviceChanged: (replicaId) => deviceSyncTransport?.invalidate(replicaId),
    ...(options.pairingNow !== undefined ? { now: options.pairingNow } : {}),
  });
  // 能力注册表（票 M2-T1 / Issue #22）：会话工具注入改查注册表（disable 即不再注入）；
  // builtin 工具的 ensure-registered 在 runtime.started 之后执行（审计顺序：进程启动 →
  // builtin 注册；幂等，同 dataDir 重启不产生新事件）。
  // 生命周期事件驱动调用面同步（#22 修复批 / FR-CAP-5）：onLifecycle 在注册/启停/回滚
  // 审计事件落账本后回调——把 ToolInvoker 注册表与能力注册表保持同相（disable 即从
  // 调用接缝摘除、enable/rollback 重新登记）。syncInvoker 晚绑定（sandbox 在其后构建）。
  let syncInvoker: ((event: CapabilityLifecycleEvent) => void) | undefined;
  const capabilities = new PermissionEngine({
    dataDir: config.dataDir,
    ledger,
    replicaId: config.replicaId,
    onLifecycle: (event) => syncInvoker?.(event),
  });
  const providers = new ProviderRegistry({
    dataDir: config.dataDir,
    secretStore,
    envFallback: config.provider,
  });
  // 记忆存储（票 M1-T1 / Issue #13）：与账本同库；候选即时写入 + FTS5 检索。
  // 抽取/巩固管线（M1-T2 / Issue #14）：MemoryService 内含可注入 Extractor/Consolidator
  // （默认确定性实现），轮次收尾（message.assistant 落账）由 SessionManager 触发后台抽取。
  // 抽取器选择（M1 code-review 补齐）：注入 > config.memoryExtractor=llm（经 PiAdapter
  // 一次 prompt）> 默认启发式（MemoryService 内建）。
  const memoryStore = MemoryStore.open(config.dataDir);
  // 记忆投影器（票 M1-T3 / Issue #15，FR-MEM-6）：facts → dataDir/memory/*.md；
  // 注入 MemoryService（导入修订后单事实刷新 / 删除后投影文件移除），投影命令走路由。
  const projector = new MemoryProjector({ store: memoryStore, dataDir: config.dataDir });
  const memory = new MemoryService({
    store: memoryStore,
    ledger,
    replicaId: config.replicaId,
    projector,
    // 本机删除 → 删除集合立即生效（离线副本的旧修订在导入时被跳过）
    onFactDeleted: (envelope) => tombstones.recordFactDeletion(envelope, ledger),
    ...(options.memoryExtractor !== undefined
      ? { extractor: options.memoryExtractor }
      : config.memoryExtractor === "llm"
        ? {
            // 默认 Provider + 抽取系统提示词（goal 形参在此工厂路径不消费，传空占位）
            extractor: new LlmMemoryExtractor(
              async () => defaultTaskRuntimeFactory(providers, LLM_EXTRACTOR_SYSTEM_PROMPT)("", undefined),
            ),
          }
        : {}),
  });
  // 记忆同步语义层（M3-T3 / Issue #32）：三方合并 + 冲突入 M1 队列 + 投影重建。
  // 晚绑定到 sync.afterImport：T1 引擎在每批导入落账后调用。
  const syncConflicts = SyncConflictStore.open(config.dataDir);
  const memoryRebuilder = new MemoryProjectionRebuilder({ store: memoryStore, ledger, replicaId: config.replicaId });
  const syncMemory = new MemorySyncService({
    store: memoryStore,
    ledger,
    replicaId: config.replicaId,
    conflicts: syncConflicts,
  });
  const syncFiles = new SyncFileMerger({ dataDir: config.dataDir, ledger, replicaId: config.replicaId });
  afterSyncImport = (envelopes, peerReplicaId) => {
    syncMemory.handleImported(envelopes, peerReplicaId);
    // 任务投影随同步重建（M3 修复批 / #32 #36）：只重建可见投影，不触发调度器——
    // 对端任务只读可见，执行权仍由本地租约与 needs_reconcile 语义决定。
    // 排除纯租约事件（M3 code-review D2）：心跳 task.lease_renewed 每 ttl/3 一次，
    // 若触发全量重放会让每批同步都 O(账本) 重建；这些事件不改变任务/节点投影。
    if (envelopes.some(isProjectionTaskEvent)) {
      try {
        taskRebuilder.rebuild();
      } catch (err) {
        console.error("[morrow] task projection rebuild after sync import failed:", err);
      }
    }
  };
  // 新副本首次启动（账本已从 peer 导入事实事件、记忆表尚空）→ 重建一次投影。
  // 取舍：不无条件全量重建（O(账本) 且重置 FTS）；只在明确的「空表 + 有事实事件」下补建。
  try {
    const hasFactEvents =
      ledger.scan({ eventType: "memory.fact_created" }).length > 0 ||
      ledger.scan({ eventType: "memory.fact_updated" }).length > 0;
    if (hasFactEvents && memoryStore.listAllFacts().length === 0) {
      memoryRebuilder.rebuild();
    }
  } catch (err) {
    console.error("[morrow] memory projection rebuild on startup failed:", err);
  }
  // 沙箱执行 Worker（M2-T2 / Issue #23）：ToolInvoker 统一接缝（先于会话构建——Skill
  // 服务的缺省 invoker 复用同一实例）。runner 缺省 DockerRunner（每次执行前探测容器运行时；
  // 无运行时 → sandboxed 调用拒绝 sandbox_unavailable + install-hint）。权限引擎缺省 =
  // M2-T1 注册表复核适配器（createRegistryPermissionAdapter，本地基线 +
  // capabilities.assertRuntimeUse 双道）；注入 seam（RuntimeOptions.permissionEngine）
  // 保留给测试/宿主。Runner 仅服务 sandboxed 类；builtin（Go Worker）不经容器直跑。
  const workspaceRoot = join(config.dataDir, "workspace");
  const sandboxRunnerInstance = options.sandboxRunner ?? new DockerRunner();
  const sandbox = new ToolInvoker({
    runner: sandboxRunnerInstance,
    permissionEngine: options.permissionEngine ?? createRegistryPermissionAdapter({ registry: capabilities, workspaceRoot }),
    workspaceRoot,
    // 副作用提交前置校验（M3-T4 / Issue #33）：带任务租约上下文的调用在执行前校验
    // fencing token；直接 Owner 调用无任务上下文，按设计跳过。
    fencingGuard: (context) => fencingGuard.assertContext(context),
  });
  // 内置工具实现表（票 M2-T1）：注册表只管 manifest 与启停，实现工厂留在接线层。
  // 新 builtin 工具在此追加工厂并加入 capabilities/builtin.ts 的 manifest 全集。
  const builtinToolFactories: Record<string, (sessionId: string) => MorrowTool> = {
    [MEMORY_WRITE_CAPABILITY_MANIFEST.name]: (sessionId) => createMemoryWriteTool({ service: memory, sessionId }),
  };
  // 能力 → 调用接缝登记（#22 修复批 / FR-CAP-5「能力调用路径做真」）：
  //   builtin 实现存在（memory.write 等 human vetted 内置件）→ sandbox.type=process 进程内执行；
  //   manifest.sandbox.type=container（工厂产物）→ 以最近确认请求的工厂包入口登记容器执行条目；
  //   其余（无实现的 human 注册、无构建产物追踪的 go 注册）→ 跳过并告警（invoke 404，不静默假装可调）。
  const registerCapabilityIntoInvoker = (record: CapabilityRecord): void => {
    if (record.status !== "enabled") {
      sandbox.unregister(record.name);
      return;
    }
    const manifest = record.manifest;
    const builtinFactory = builtinToolFactories[record.name];
    if (builtinFactory !== undefined) {
      sandbox.register({
        manifest: {
          name: manifest.name,
          version: manifest.version,
          author: manifest.author,
          runtime: manifest.runtime,
          permissions: manifest.permissions,
          sandbox: { type: "process", network: "none", filesystem: "none" },
        },
        package: { name: manifest.name, kind: "typescript" },
        inProcess: async (input, context) => {
          // 归属会话：显式携带 sessionId 时用之；否则占位（memory.write 的来源回链要求
          // 会话里有 user message，缺归属的实现自身报错——不伪造归属）
          const tool = builtinFactory(context?.sessionId ?? "capability-invoke");
          const outcome = await tool.execute(`invoke-${Date.now()}`, input ?? {});
          return outcome.isError
            ? { ok: false, error: outcome.text }
            : { ok: true, result: { text: outcome.text } };
        },
      });
      return;
    }
    if (manifest.sandbox.type === "container" && manifest.runtime === "typescript") {
      const requestId = factory.latestConfirmedRequestIdByCapability(record.name);
      const entry = requestId === null ? null : join(config.dataDir, "capability-factory", requestId, "package", "src", "entry.ts");
      if (entry !== null && existsSync(entry)) {
        sandbox.register({
          manifest: {
            name: manifest.name,
            version: manifest.version,
            author: manifest.author,
            runtime: manifest.runtime,
            permissions: manifest.permissions,
            sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
          },
          package: { name: manifest.name, kind: "typescript", entry },
        });
        return;
      }
      console.warn(
        `[morrow] capability "${record.name}" has no factory package entry on disk; invoke will report unknown_tool until it is re-confirmed via the factory`,
      );
      sandbox.unregister(record.name);
      return;
    }
    console.warn(
      `[morrow] capability "${record.name}" (${manifest.runtime}/${manifest.sandbox.type}) has no executable implementation wired; invoke reports unknown_tool`,
    );
    sandbox.unregister(record.name);
  };
  syncInvoker = (event: CapabilityLifecycleEvent) => {
    if (event.eventType === CAPABILITY_EVENT_TYPES.disabled) {
      sandbox.unregister(event.record.name);
      return;
    }
    registerCapabilityIntoInvoker(event.record);
  };
  // Skill 服务（M2-T5 / Issue #26）：案例收集（tool.finished 观测 + 上报端点）→ 晋升
  // 提案 → Owner 批准 → invoke 重用。invoker 缺省 = ToolInvoker（T2 统一调用接缝，
  // 执行前 assertRuntimeUse 复核——Skill 只调用已验证 Tool，不绕过安全边界）。
  const skills = new SkillService({
    dataDir: config.dataDir,
    ledger,
    replicaId: config.replicaId,
    capabilities,
    invoker: options.skillInvoker ?? sandbox,
    // Skill steps 携带任务租约上下文时逐步校验 fencing token（旧 token 在执行前拒绝）
    fencingGuard: (context) => fencingGuard.assertContext(context),
    ...(options.skillPromotionThreshold === undefined ? {} : { promotionThreshold: options.skillPromotionThreshold }),
  });
  // 会话工具注入改查注册表（票 M2-T1）：enabled 且有内置实现的 typescript 能力才实例化
  const sessions = new SessionManager({
    ledger,
    replicaId: config.replicaId,
    factory: options.agentAdapterFactory ?? defaultAgentFactory(),
    providers,
    // 注入工厂（测试/宿主自带 Agent Loop）时不做 Provider 预检（T4 语义）；默认工厂要求有 Provider
    providerRequired: options.agentAdapterFactory === undefined,
    // 记忆（M1-T1）：高价值规则即时写候选；memory.write 工具按会话注入 Agent Loop
    memory,
    // 工具完成观察（M2-T5）：tool.finished → Skill 案例收集（is_error → failure）。
    // 观察是增强路径：失败记日志不阻断会话主链路。
    toolObserver: {
      observeToolFinished: (input) => {
        try {
          skills.recordCase({
            capability: input.toolName,
            outcome: input.isError ? "failure" : "success",
            sourceEventId: input.toolEventId,
            sessionId: input.sessionId,
            occurredAt: input.occurredAt,
          });
        } catch (err) {
          console.error("[morrow] skill case collection failed:", err);
        }
      },
    },
    // 工具注入改查注册表（票 M2-T1）：enabled 且有内置实现的 typescript 能力才实例化
    agentTools: (sessionId) =>
      capabilities
        .list({ status: "enabled", runtime: "typescript" })
        .filter((capability) => builtinToolFactories[capability.name] !== undefined)
        .map((capability) => builtinToolFactories[capability.name](sessionId)),
  });
  // 任务域（M1-T4）：规划器/节点工厂注入语义对齐会话——注入时不做 Provider 预检，
  // 默认工厂路径要求存在可解析的默认 Provider（POST /v1/tasks 预检 503 依据）。
  const taskPlannerInjected = options.taskPlannerFactory !== undefined;
  const defaultPlannerRuntime = defaultTaskRuntimeFactory(providers, PLANNER_SYSTEM_PROMPT);
  const defaultNodeRuntime = defaultTaskRuntimeFactory(providers);
  const tasks = new TaskService({
    dataDir: config.dataDir,
    ledger,
    replicaId: config.replicaId,
    factory: options.taskPlannerFactory !== undefined ? options.taskPlannerFactory : defaultPlannerRuntime,
    providers,
    providerRequired: !taskPlannerInjected,
  });
  const taskRebuilder = new TaskProjectionRebuilder(() => tasks.rebuildProjection());
  // 任务投影补建（M3 修复批 / #32 #36）：新副本首次启动时账本已从 peer 导入 task.* 事件
  // 但投影表尚空 → 重放一次。取舍同记忆投影：不做无条件全量重建（O(账本)），只在
  // 「空表 + 有任务事件」时补建。重建不触发调度，同步来的未完成任务不会自动执行。
  try {
    if (
      tasks.projectionEmpty &&
      ledger.scan({ eventType: "task.created" }).length > 0
    ) {
      taskRebuilder.rebuild();
    }
  } catch (err) {
    console.error("[morrow] task projection rebuild on startup failed:", err);
  }
  // 渠道域（M4-T1 / Issue #38）：适配器注册表 + 统一入站路由。接缝最小化——
  // 生命周期 start/stop、清单/健康端点与 echo 参考适配器（默认关闭）。入站消息
  // 经会话链路处理；Task 关联只经中间路由写入关联列，不覆盖平台原始记录。
  const channels = new ChannelRegistry({
    dataDir: config.dataDir,
    ledger,
    replicaId: config.replicaId,
    sessions,
    ...(options.enableEchoChannel === undefined ? {} : { enableEcho: options.enableEchoChannel }),
    taskExists: (taskId) => tasks.getTask(taskId) !== null,
  });
  // Outbox → ChannelAdapter 桥（M4-T7）：渠道外发（通知及后续主动消息）统一经 Outbox。
  // 宿主注入 outboxAdapter 时以注入为准（T2 契约测试的计数桩）。
  if (options.outboxAdapter === undefined) {
    outbox.setAdapter(createChannelOutboxAdapter(channels));
  }
  // 通知规则与路由（M4-T7 / Issue #44）：订阅账本 task.* 完成类事件 → 规则匹配 →
  // 桌面落本地 pending 表 / 渠道入 Outbox。订阅是增强路径：监听器异常不阻断账本写入。
  const notifications = new NotificationService({
    dataDir: config.dataDir,
    ledger,
    replicaId: config.replicaId,
    outbox,
    ...(options.notificationNow === undefined ? {} : { now: options.notificationNow }),
    ...(options.notificationDedupeWindowMs === undefined
      ? {}
      : { dedupeWindowMs: options.notificationDedupeWindowMs }),
    taskLookup: (taskId) => tasks.getTask(taskId),
    // 渠道正文裁剪的数据源：public 之外（private/locked）一律从正文移除。
    privateMemoryContents: () =>
      memory
        .listFacts()
        .filter((fact) => fact.sensitivity !== "public")
        .map((fact) => fact.content),
    channelAccountId: (channelId) => channels.accountIdForChannel(channelId),
  });
  const unsubscribeNotifications = ledger.subscribe((entry) => {
    try {
      notifications.handleEnvelope(entry.envelope);
    } catch (err) {
      console.error("[morrow] notification routing failed:", err);
    }
  });
  const notificationDrainIntervalMs = options.notificationDrainIntervalMs ?? 1_000;
  let notificationTimer: NodeJS.Timeout | null = null;
  if (notificationDrainIntervalMs > 0) {
    notificationTimer = setInterval(() => {
      void notifications.drain().catch((err: unknown) => {
        console.error("[morrow] notification drain failed:", err);
      });
    }, notificationDrainIntervalMs);
    if (typeof notificationTimer.unref === "function") notificationTimer.unref();
  }
  // Checkpoint 域（M1-T5 / Issue #17）：FR-TASK-5 快照 + 恢复落地；执行配置采集注入
  // runtime 版本、默认 Provider 投影（绝不含密钥）与工具版本表（M1 code-review 填实：
  // pi-adapter 版本可证；逐工具版本无来源——任务执行无工具通道，留空待后续票交付）。
  const checkpoints = new CheckpointService({
    tasks,
    dataDir: config.dataDir,
    ledger,
    replicaId: config.replicaId,
    executionInfo: async () => {
      const toolVersions = { "pi-adapter": PI_ADAPTER_VERSION };
      try {
        const provider = await providers.resolve();
        return {
          runtime_version: VERSION,
          provider:
            provider === null
              ? null
              : { provider_id: provider.providerId, model_id: provider.modelId, base_url: provider.baseUrl },
          tool_versions: toolVersions,
        };
      } catch {
        return { runtime_version: VERSION, provider: null, tool_versions: toolVersions };
      }
    },
  });
  // 工作区隔离与资源锁（M2-T4 / Issue #25，FR-TASK-8）：代码节点（resources.git_repo）
  // 在 <dataDir>/worktrees 下的独立 git worktree 执行，完成后合回主区（冲突 →
  // pending_review）；resources.lock 声明经锁表串行化。锁表与任务投影同库
  // （events.sqlite，独立连接，WAL + busy_timeout 支撑多连接——同 CheckpointService）。
  const worktrees = new WorktreeManager({ root: join(config.dataDir, "worktrees") });
  const locks = new LockTable({ dataDir: config.dataDir });
  const scheduler = new TaskScheduler({
    tasks,
    ledger,
    replicaId: config.replicaId,
    // 节点执行工厂（M1-T6 起执行 node.model）：注入工厂拿到 TaskNodeExecInput.model
    // 自行决定；默认工厂按注册 Provider id 解析 node.model（未命中回退默认 Provider）
    nodeAgentFactory:
      options.taskNodeAgentFactory ??
      ((node: TaskNodeExecInput) => defaultNodeRuntime(node.goal, node.model)),
    checkpoints,
    worktrees,
    locks,
    leases,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
    ...(options.leaseHeartbeatMs === undefined ? {} : { leaseHeartbeatMs: options.leaseHeartbeatMs }),
    ...(options.taskConcurrency === undefined ? {} : { concurrency: options.taskConcurrency }),
    leaseCoordinator: options.leaseCoordination === false ? null : leaseCoordinator,
  });
  // 启动清扫（M2-T4）：崩溃残留的 worktree/分支/孤儿锁；pending_review 节点的冲突
  // worktree 是 Owner 调解证据，清扫保留。清扫失败不阻塞启动（下次启动再清）。
  void scheduler.sweepResidue().catch((err: unknown) => {
    console.error("[morrow] startup residue sweep failed:", err);
  });
  // 能力工厂（M2-T3 / Issue #24）：生成闭环编排。生成器缺省 = 默认 Provider + 工厂系统
  // 提示词（经 PiAdapter 一次 prompt）；注入 seam（RuntimeOptions.capabilityGenerator）供
  // 测试脚本化（FakePi 零网络）。检索注入 MemoryService.search（FR-CAP-1 FTS 记忆半边）。
  // Runner 与 ToolInvoker 共用同一实例（验证即同一条沙箱执行路径）。
  const factory = new CapabilityFactory({
    dataDir: config.dataDir,
    ledger,
    replicaId: config.replicaId,
    capabilities,
    generator:
      options.capabilityGenerator ??
      new PiCapabilityGenerator({ runtimeFactory: defaultFactoryRuntimeFactory(providers) }),
    runner: sandboxRunnerInstance,
    memorySearch: (query) => memory.search(query).map((hit) => ({ content: hit.content, entry_kind: hit.stage })),
    workspaceRoot,
  });
  const ctx: RequestContext = {
    ledger,
    replicaId: config.replicaId,
    sessions,
    providers,
    devices,
    pairing,
    tasks,
    scheduler,
    checkpoints,
    memory,
    projector,
    capabilities,
    sandbox,
    factory,
    skills,
    sync,
    syncConflicts,
    leases,
    channels,
    outbox,
    notifications,
  };
  const server = createServer((req, res) => {
    routeRequest(req, res, ctx);
  });

  let port: number;
  try {
    port = await listen(server, config.host, config.port);
    // listen 之后才能确定实际端口：显式 MORROW_PUBLIC_BASE_URL 优先，否则按监听地址
    // 推导（通配地址对别的设备不可达，退化为 127.0.0.1 并只在本机有意义）。
    selfBaseUrl = resolveSelfBaseUrl(config, port);
  } catch (err) {
    if (notificationTimer !== null) clearInterval(notificationTimer);
    unsubscribeNotifications();
    notifications.close();
    skills.close();
    factory.close();
    tasks.close();
    outbox.close();
    locks.close();
    capabilities.close();
    channels.close();
    memoryStore.close();
    syncCursors.close();
    syncConflicts.close();
    tombstones.close();
    pairing.close();
    devices.close();
    if (ownsLeases) leases.close();
    ledger.close();
    throw err;
  }

  const startedEnvelope = buildEventEnvelope({
    replicaId: config.replicaId,
    actorId: "agent:runtime",
    eventType: "runtime.started",
    payload: { pid: process.pid, host: config.host, port, version: VERSION },
  });
  ledger.append(startedEnvelope);
  // 外发崩溃恢复（M4-T2）：上次进程在 dispatch 途中被杀 → 行仍 pending 且 last_attempt_at
  // 非空 = 请求可能已发出但无回执。转 delivery_unknown → needs_review，绝不自动重发。
  outbox.recoverStartup();
  // builtin 工具 ensure-registered（票 M2-T1）：首见注册落 capability.registered（actor
  // agent:runtime），已注册同版本同内容 → no-op；builtin 常量与历史账本冲突时抛错（fail-fast）。
  ensureBuiltinCapabilities(capabilities);
  // 渠道适配器启动（M4-T1）：在 runtime.started 之后落 channel.adapter_started。
  // 失败按适配器隔离（state=error 可在 GET /v1/channels 诊断），不阻断 runtime 启动。
  await channels.start();
  // 调用接缝初始登记（#22 修复批 / FR-CAP-5）：把注册表里全部 enabled 能力登记进
  // ToolInvoker（本进程新建的经 onLifecycle 已登记；这里覆盖重启场景——历史行不重放
  // registered 事件）。登记失败的条目跳过并告警（invoke 404，不静默假装可调）。
  for (const record of capabilities.list({ status: "enabled" })) {
    registerCapabilityIntoInvoker(record);
  }
  // Skill 案例回填（票 M2-T5）：重启后扫描历史 tool.finished 补齐案例表
  // （source_event 唯一约束幂等；streak 由此跨重启延续）。
  try {
    skills.ingestFromLedger();
  } catch (err) {
    console.error("[morrow] skill case backfill failed:", err);
  }

  let closing = false;
  return {
    host: config.host,
    port,
    ledger,
    sessions,
    providers,
    devices,
    pairing,
    tasks,
    scheduler,
    checkpoints,
    memory,
    projector,
    capabilities,
    sandbox,
    factory,
    skills,
    sync,
    tombstones,
    syncConflicts,
    syncMemory,
    syncFiles,
    memoryRebuilder,
    taskRebuilder,
    leases,
    leaseCoordinator,
    channels,
    outbox,
    notifications,
    async close(signal?: string): Promise<void> {
      if (closing) return;
      closing = true;
      if (notificationTimer !== null) {
        clearInterval(notificationTimer);
        notificationTimer = null;
      }
      unsubscribeNotifications();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // 会话运行先收尾（中止在跑的轮次并释放 AgentRuntime），再记账、再关库
      await sessions.dispose();
      // 任务调度：拒绝排队任务、中止在跑节点（收尾上限 2s），然后关任务投影库
      await scheduler.dispose();
      // 渠道适配器先停（落 channel.adapter_stopped），再记账 runtime.stopped
      await channels.stop();
      tasks.close();
      locks.close();
      checkpoints.close();
      factory.close();
      skills.close();
      capabilities.close();
      try {
        ledger.append(
          buildEventEnvelope({
            replicaId: config.replicaId,
            actorId: "agent:runtime",
            eventType: "runtime.stopped",
            payload: signal === undefined ? { reason: "graceful" } : { reason: "graceful", signal },
            causationId: startedEnvelope.event_id,
          }),
        );
      } catch (err) {
        console.error("[morrow] failed to append runtime.stopped:", err);
      }
      pairing.close();
      devices.close();
      channels.close();
      memoryStore.close();
      syncCursors.close();
      syncConflicts.close();
      tombstones.close();
      outbox.close();
      notifications.close();
      if (ownsLeases) leases.close();
      ledger.close();
    },
  };
}

/**
 * 本机对外基地址：显式配置优先；否则按实际监听地址 + 端口推导。
 * 通配监听（0.0.0.0 / ::）对其它设备不可达，退化为 127.0.0.1——这只在本机回环有意义；
 * 跨网络部署必须设 MORROW_PUBLIC_BASE_URL（Tailscale/LAN 地址），否则对端无法反向同步。
 */
export function resolveSelfBaseUrl(config: RuntimeConfig, port: number): string {
  if (config.publicBaseUrl !== undefined && config.publicBaseUrl !== null && config.publicBaseUrl.length > 0) {
    return config.publicBaseUrl;
  }
  const host =
    config.host === "0.0.0.0" || config.host === "::" || config.host === "[::]" ? "127.0.0.1" : config.host;
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}

/** 生产默认工厂：按会话解析的 Provider → createPiAdapter（OpenAI 兼容协议，ADR-0002）。
 *  extras.tools（M1-T1：memory.write）经 tools 通道注册进 Agent Loop。 */
function defaultAgentFactory(): (
  sessionId: string,
  provider: ResolvedProvider | null,
  extras?: AgentRuntimeExtras,
) => Promise<AgentRuntime> {
  return async (_sessionId, provider, extras) => {
    if (provider === null) {
      throw new Error("no model provider configured");
    }
    return createPiAdapter({
      baseUrl: provider.baseUrl,
      // pi-ai 对空 key 抛 "No API key for provider"；免密端点（vLLM/Ollama）用其自身
      // 的 "unused" 占位约定（这些端点忽略 Authorization 头）
      apiKey: provider.apiKey.length > 0 ? provider.apiKey : "unused",
      model: { id: provider.modelId, contextWindow: provider.contextWindow, maxTokens: provider.maxTokens },
      ...(provider.compat !== undefined ? { compat: provider.compat } : {}),
      tools: extras?.tools ?? [],
    });
  };
}

/**
 * 任务域默认工厂（M1-T4）：默认 Provider → createPiAdapter；planner 带规划系统提示词
 * （FR-TASK-1 的生产路径），节点执行不带专用提示词。Provider 解析失败抛错——规划路径
 * 由 createTask 转 task.failed 留痕，节点路径由调度器落 node failed，均不静默。
 * 模型切换（M1-T6 / FR-TASK-3）：nodeAgentFactory 把 node.model 传入工厂；语义为
 * 「按注册 Provider id 解析」——命中即用该 Provider 执行，未命中（规划器给的是自由
 * 模型名而非 Provider id）回退默认 Provider，不让任务因无法解析的建议模型而失败。
 */
function defaultTaskRuntimeFactory(providers: ProviderRegistry, systemPrompt?: string): (goal: string, modelId?: string) => Promise<AgentRuntime> {
  return async (_goal, modelId) => {
    // 节点 model → Provider 解析（未命中回退默认）；planner 路径 modelId 恒 undefined
    const provider = (modelId !== undefined ? await providers.resolve(modelId) : null) ?? (await providers.resolve());
    if (provider === null) {
      throw new Error("no model provider configured");
    }
    return createPiAdapter({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey.length > 0 ? provider.apiKey : "unused",
      model: { id: provider.modelId, contextWindow: provider.contextWindow, maxTokens: provider.maxTokens },
      ...(provider.compat !== undefined ? { compat: provider.compat } : {}),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    });
  };
}

/**
 * 能力工厂默认生成器运行时（M2-T3）：默认 Provider → createPiAdapter + 工厂系统提示词
 * （一次 prompt 产出计划 JSON）。Provider 解析失败抛错——管线折叠为
 * factory_failed(stage=plan, runtime_error)，不静默。
 */
function defaultFactoryRuntimeFactory(providers: ProviderRegistry): (prompt: string) => Promise<AgentRuntime> {
  return async () => {
    const provider = await providers.resolve();
    if (provider === null) {
      throw new Error("no model provider configured");
    }
    return createPiAdapter({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey.length > 0 ? provider.apiKey : "unused",
      model: { id: provider.modelId, contextWindow: provider.contextWindow, maxTokens: provider.maxTokens },
      ...(provider.compat !== undefined ? { compat: provider.compat } : {}),
      systemPrompt: CAPABILITY_FACTORY_SYSTEM_PROMPT,
    });
  };
}

function routeRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): void {
  // CORS：桌面 WebView 与浏览器联调是跨源客户端（PRD §6.1「渠道适配器亦为 API 客户端」）。
  // 只对本地来源（localhost / 127.0.0.1 / tauri://）放行——互联网页面的 Origin 不在列表内，
  // 其脚本发起的跨源读写会被浏览器拦截。但 CORS 不是 CSRF 的完整防线：不带自定义头的
  // simple POST（safelist content-type 如 text/plain）不经 preflight，请求本身仍会到达——
  // 防线第二道是 readJsonBody 强制 application/json（safelist 外 → 强制 preflight → 204 空
  // 白名单不放行；且服务器端直接 415 拒收）。残余风险见 docs/security/threat-model.md 域 4。
  // last-event-id 供 EventSource 断线重连携带（非 safelist 头，需进 preflight 白名单）。
  const origin = req.headers.origin;
  if (typeof origin === "string" && isLocalOrigin(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, last-event-id, authorization");
    // PUT/DELETE：设置 UI 的 Provider 编辑/删除（票 T7 / Issue #8）——跨源 WebView 需在白名单内
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if ((req.method ?? "").toUpperCase() === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    sendError(res, 400, "bad_request", "malformed request target");
    return;
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method ?? "GET").toUpperCase();

  // 请求鉴权（M3-T2 / Issue #31，ADR-0008）：回环豁免；非回环必须 bearer token，
  // 唯一例外是 POST /v1/pairing/claim（新设备尚无令牌，配对码本身是凭据）。
  // 鉴权先于路由匹配——未认证请求不会因 404/405 泄露路由面。
  const authorization = authorizeRequest(
    {
      remoteAddress: req.socket.remoteAddress,
      method,
      pathname,
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    },
    ctx.pairing,
  );
  if (authorization.kind === "deny") {
    sendError(res, authorization.status, authorization.code, authorization.message);
    return;
  }

  const pathMatches = routes.filter((route) => route.re.test(pathname));
  if (pathMatches.length === 0) {
    sendError(res, 404, "not_found", `no route for ${pathname}`);
    return;
  }
  const route = pathMatches.find((candidate) => candidate.method === method);
  if (!route) {
    res.setHeader("Allow", [...new Set(pathMatches.map((candidate) => candidate.method))].join(", "));
    sendError(res, 405, "method_not_allowed", `${method} is not allowed on ${pathname}`);
    return;
  }
  const params = (route.re.exec(pathname) as RegExpExecArray).slice(1);
  try {
    const result = route.handler(req, res, url, ctx, params);
    if (result instanceof Promise) {
      result.catch((err: unknown) => handleAsyncError(res, err));
    }
  } catch (err) {
    handleAsyncError(res, err);
  }
}

function handleAsyncError(res: ServerResponse, err: unknown): void {
  console.error("[morrow] handler error:", err);
  if (!res.headersSent) {
    sendError(res, 500, "internal_error", "unexpected server error");
  } else {
    res.end();
  }
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): Promise<void> {
  sendJson(res, 200, {
    status: "ok",
    version: VERSION,
    replica_id: ctx.replicaId,
    sandbox: await probeSandbox(),
    ledger: { events: ctx.ledger.count() },
  });
}

/** Device 记录列表（只读；M0 仅本副本一条——多设备是 M3 的事，票 #3） */
function handleListDevices(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): void {
  const devices: DeviceRecord[] = ctx.devices.list();
  sendJson(res, 200, { devices });
}

function handleEvents(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: RequestContext): void {
  const page = parsePaging(url, res, { defaultLimit: 50 });
  if (page === null) return;
  let replicaId: string | undefined;

  const replicaRaw = url.searchParams.get("replica_id");
  if (replicaRaw !== null) {
    if (!UUID_RE.test(replicaRaw.toLowerCase())) {
      sendError(res, 400, "invalid_query", "replica_id must be a lowercase uuid");
      return;
    }
    replicaId = replicaRaw.toLowerCase();
  }

  sendJson(res, 200, ctx.ledger.list({ replicaId, limit: page.limit, offset: page.offset }));
}

/** 本地控制面的放行来源：桌面壳（tauri://localhost、http://tauri.localhost）与浏览器联调 */
function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "tauri.localhost";
    return localHost && (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "tauri:");
  } catch {
    return false;
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error(`unexpected server address: ${String(address)}`));
      }
    });
  });
}

// --- T4 会话族 handlers -----------------------------------------------------

interface CreateSessionBody {
  title?: unknown;
  provider_id?: unknown;
}

async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return; // 响应已在 readJsonBody 里写出
  const { title, provider_id: providerId } = body as CreateSessionBody;
  if (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) {
    sendError(res, 400, "invalid_body", "title must be a non-empty string when present");
    return;
  }
  if (providerId !== undefined && (typeof providerId !== "string" || !ctx.providers.exists(providerId))) {
    sendError(res, 400, "unknown_provider", `provider "${String(providerId)}" is not registered (GET /v1/providers for the list)`);
    return;
  }
  const created = ctx.sessions.createSession(
    title === undefined ? undefined : title.trim(),
    typeof providerId === "string" ? providerId : undefined,
  );
  sendJson(res, 201, {
    session_id: created.sessionId,
    event_id: created.eventId,
    sequence: created.sequence,
    occurred_at: created.occurredAt,
    ...(typeof providerId === "string" ? { provider_id: providerId } : {}),
    ...(title === undefined ? {} : { title: title.trim() }),
  });
}

function handleListSessions(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): void {
  sendJson(res, 200, { sessions: ctx.sessions.listSessions() });
}

interface SendMessageBody {
  text?: unknown;
}

async function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: RequestContext,
  params: string[],
): Promise<void> {
  const sessionId = params[0];
  if (!ctx.sessions.sessionExists(sessionId)) {
    sendError(res, 404, "not_found", `session ${sessionId} does not exist`);
    return;
  }
  if (!ctx.sessions.agentAvailable) {
    sendError(res, 503, "provider_not_configured", ctx.sessions.agentUnavailableReason);
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const { text } = body as SendMessageBody;
  if (typeof text !== "string" || text.trim().length === 0) {
    sendError(res, 400, "invalid_body", "text must be a non-empty string");
    return;
  }
  const ack = ctx.sessions.sendUserMessage(sessionId, text);
  sendJson(res, 202, {
    message_id: ack.messageId,
    event_id: ack.eventId,
    sequence: ack.sequence,
    status: ack.status,
  });
}

function handleHistory(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  const sessionId = params[0];
  if (!ctx.sessions.sessionExists(sessionId)) {
    sendError(res, 404, "not_found", `session ${sessionId} does not exist`);
    return;
  }
  sendJson(res, 200, ctx.sessions.history(sessionId));
}

/**
 * SSE：会话事件流。每帧三类——
 *   event: <event_type> + id: <seq> + data: <信封 JSON>   账本事件（ durable，seq 保序）
 *   event: text_delta            + data: {"delta":"..."}  流式文本增量（易失，不落账本、无 id）
 *   event: done                  + data: {"session_id"}   本轮结束（空闲标记，易失）
 * 连接即重放：无 Last-Event-ID 从会话首事件起全量重放；携带 Last-Event-ID（数字 seq）
 * 只重放其后的账本事件，再接live 帧。重放与 live 之间按 seq 去重，顺序与账本一致。
 */
function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: RequestContext,
  params: string[],
): void {
  const sessionId = params[0];
  if (!ctx.sessions.sessionExists(sessionId)) {
    sendError(res, 404, "not_found", `session ${sessionId} does not exist`);
    return;
  }
  let afterSeq = 0;
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId !== undefined) {
    const parsed = Number(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
    if (!Number.isInteger(parsed) || parsed < 0) {
      sendError(res, 400, "invalid_query", "last-event-id must be a non-negative integer (ledger sequence)");
      return;
    }
    afterSeq = parsed;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  const sentSeqs = new Set<number>();
  const writeEvent = (frame: SessionFrame): void => {
    if (frame.kind === "event") {
      sentSeqs.add(frame.sequence);
      res.write(`event: ${frame.envelope.event_type}\nid: ${frame.sequence}\ndata: ${JSON.stringify(frame.envelope)}\n\n`);
    } else if (frame.kind === "delta") {
      res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: frame.delta })}\n\n`);
    } else {
      res.write(`event: done\ndata: ${JSON.stringify({ session_id: sessionId })}\n\n`);
    }
  };

  // 先订阅（缓存 live 帧）→ 重放历史 → 冲刷缓存（按 seq 去重）→ 切 live
  const buffered: SessionFrame[] = [];
  let live = false;
  const unsubscribe = ctx.sessions.subscribe(sessionId, (frame) => {
    if (!live) {
      buffered.push(frame);
      return;
    }
    if (frame.kind === "event" && sentSeqs.has(frame.sequence)) return;
    writeEvent(frame);
  }) as () => void; // sessionExists 已确认，退订函数必然存在

  for (const { sequence, envelope } of ctx.sessions.sessionEvents(sessionId, afterSeq)) {
    writeEvent({ kind: "event", sequence, envelope });
  }
  live = true;
  for (const frame of buffered.splice(0)) {
    if (frame.kind === "event" && sentSeqs.has(frame.sequence)) continue;
    writeEvent(frame);
  }
  if (!ctx.sessions.isRunning(sessionId)) {
    writeEvent({ kind: "done" });
  }

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  // 注意：req 的 'close' 在请求体读完（GET 立即）就触发；SSE 连接的生命周期要挂在
  // res 的 'close'（响应未 end，只在连接断开时触发）上做清理。
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// --- T5 Provider 族 handlers -------------------------------------------------
// 密钥安全不变量：任何响应/日志只含 has_api_key 投影，绝不回显 api_key（含错误路径——
// ProviderRegistryError 的消息不携带密钥内容；测试覆盖 JSON 全文不含密钥的断言）。

function handleProviderRegistryError(res: ServerResponse, err: unknown): void {
  if (err instanceof ProviderRegistryError) {
    const status = err.code === "invalid_input" ? 400 : err.code === "conflict" ? 409 : 404;
    sendError(res, status, `provider_${err.code}`, err.message);
    return;
  }
  throw err;
}

async function handleListProviders(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): Promise<void> {
  const providers = await ctx.providers.listAll();
  sendJson(res, 200, { providers, default_provider_id: await ctx.providers.defaultProviderId() });
}

async function handleRegisterProvider(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const record = await ctx.providers.register(body);
    sendJson(res, 201, record);
  } catch (err) {
    handleProviderRegistryError(res, err);
  }
}

async function handleGetProvider(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  const record = await ctx.providers.get(params[0]);
  if (record === null) {
    sendError(res, 404, "provider_not_found", `provider "${params[0]}" not found`);
    return;
  }
  sendJson(res, 200, record);
}

async function handleUpdateProvider(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  try {
    const record = await ctx.providers.update(params[0], body);
    sendJson(res, 200, record);
  } catch (err) {
    handleProviderRegistryError(res, err);
  }
}

async function handleDeleteProvider(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  try {
    await ctx.providers.delete(params[0]);
    sendJson(res, 200, { deleted: true, provider_id: params[0] });
  } catch (err) {
    handleProviderRegistryError(res, err);
  }
}

async function handleSetDefaultProvider(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  try {
    await ctx.providers.setDefault(params[0]);
    sendJson(res, 200, { default_provider_id: await ctx.providers.defaultProviderId() });
  } catch (err) {
    handleProviderRegistryError(res, err);
  }
}

/** 连通性测试：对注册 Provider（或 env 回退）发一次最小 OpenAI 兼容请求，三类结果（见 connectivity.ts） */
async function handleTestProvider(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): Promise<void> {
  const providerId = params[0];
  if (!ctx.providers.exists(providerId)) {
    sendError(res, 404, "provider_not_found", `provider "${providerId}" not found`);
    return;
  }
  const resolved = await ctx.providers.resolve(providerId);
  if (resolved === null) {
    sendError(res, 404, "provider_not_found", `provider "${providerId}" not found`);
    return;
  }
  const result = await testProviderConnectivity(resolved);
  sendJson(res, 200, result);
}

// --- M2 修复批：能力调用端点（#22 / FR-CAP-5）---------------------------------
// POST /v1/capabilities/:id/invoke：body 即工具 input（JSON 对象）。执行链与 Skill steps
// 完全同链——ToolInvoker（unknown_tool 404 → assertRuntimeUse 运行时复核 → builtin 进程
// 内直呼 / sandboxed 容器执行）。审计：capability.used 先落账本后返回（成功/失败/耗时/
// via 全留痕，威胁模型域 2 的调用可追踪口径）；HTTP 状态码按 invocation-errors.ts 的
// 统一映射表执行（工具自身失败 502、sandbox_unavailable 503+install-hint、tool_timeout
// 504 等）。

/** capability.used 审计（invoke 端点直呼路径；path=direct 与 Skill 步级 path=skill 区分） */
function appendCapabilityUsed(
  ctx: RequestContext,
  capabilityId: string,
  outcome: { ok: boolean; error_code?: string; error?: string; via?: string },
  durationMs: number,
  sessionId?: string,
): void {
  try {
    ctx.ledger.append(
      buildEventEnvelope({
        replicaId: ctx.replicaId,
        actorId: "owner",
        eventType: CAPABILITY_EVENT_TYPES.used,
        ...(sessionId !== undefined ? { sessionId } : {}),
        payload: {
          capability: capabilityId,
          ok: outcome.ok,
          ...(outcome.error_code !== undefined ? { error_code: outcome.error_code } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(outcome.via !== undefined ? { via: outcome.via } : {}),
          duration_ms: durationMs,
          path: "direct",
        },
      }),
    );
  } catch (err) {
    console.error("[morrow] capability.used audit failed:", err);
  }
}

/** InvocationResult → HTTP 投影（执行证据字段全保留；ok=false 走 502） */
function invocationResponseBody(result: InvocationResult): Record<string, unknown> {
  return {
    ok: result.ok,
    ...(result.result !== undefined ? { result: result.result } : {}),
    ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.via !== undefined ? { via: result.via } : {}),
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
  };
}

async function handleInvokeCapability(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RequestContext,
  params: string[],
): Promise<void> {
  const capabilityId = params[0];
  // 归属上下文走查询串（body 恒为工具 input）：session_id 供需要会话归属的工具
  // （memory.write 的来源回链）使用；缺省 = 无会话上下文，由工具自身语义裁决。
  const sessionRaw = url.searchParams.get("session_id");
  if (sessionRaw !== null && sessionRaw.trim().length === 0) {
    sendError(res, 400, "invalid_query", "session_id must be a non-empty session id when present");
    return;
  }
  const sessionId = sessionRaw?.trim();
  const body = await readJsonBody(req, res);
  if (body === null) return; // 响应已在 readJsonBody 里写出（415/413/400）
  const startedAt = Date.now();
  try {
    const result = await ctx.sandbox.invoke(capabilityId, body, { actorId: "owner", ...(sessionId !== undefined ? { sessionId } : {}) });
    // 先落审计后返回（账本可追踪优先于响应时延；审计失败不改变执行结果口径）
    appendCapabilityUsed(ctx, capabilityId, result, result.duration_ms, sessionId);
    sendJson(res, result.ok ? 200 : 502, invocationResponseBody(result));
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errorCode = err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : undefined;
    appendCapabilityUsed(ctx, capabilityId, { ok: false, ...(errorCode !== undefined ? { error_code: errorCode } : {}), error: err instanceof Error ? err.message : String(err) }, durationMs, sessionId);
    if (sendInvocationError(res, err)) return;
    throw err;
  }
}

// --- M1-T4 任务族 handlers（票 #16，PRD §6.2 任务端点）------------------------
// 语义：POST /v1/tasks 同步规划（FakePi/真实 LLM），201 返回规划快照；规划成功后
// 自动后台调度（PRD 任务族无独立 run 端点；暂停/取消等介入操作是 FR-TASK-3 的范围，
// 状态机迁移已由 TaskService.transition 支撑，客户端经轮询详情观察执行进度）。
// 规划失败不 5xx：任务以 failed 状态持久化（task.planning_failed + task.failed 留痕），
// 响应仍是 201 + failed 详情——创建的资源真实存在，错误在资源与账本里，不靠状态码转述。

interface CreateTaskBody {
  goal?: unknown;
  session_id?: unknown;
}

async function handleCreateTask(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  ctx: RequestContext,
): Promise<void> {
  if (!ctx.tasks.plannerAvailable) {
    sendError(res, 503, "planner_unavailable", ctx.tasks.plannerUnavailableReason);
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === null) return; // 响应已在 readJsonBody 里写出
  const { goal, session_id: sessionId } = body as CreateTaskBody;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    sendError(res, 400, "invalid_body", "goal must be a non-empty string");
    return;
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.trim().length === 0)) {
    sendError(res, 400, "invalid_body", "session_id must be a non-empty string when present");
    return;
  }
  if (typeof sessionId === "string" && !ctx.sessions.sessionExists(sessionId)) {
    sendError(res, 400, "invalid_body", `session "${sessionId}" does not exist`);
    return;
  }
  let detail;
  try {
    detail = await ctx.tasks.createTask(goal.trim(), sessionId === undefined ? {} : { sessionId });
  } catch (err) {
    handleTaskError(res, err);
    return;
  }
  // 规划成功即后台调度：fire-and-forget，schedule 的失败路径已全部落账本
  // （task.failed），这里的 catch 只防未处理拒绝；规则化 POST 立即返回。
  if (detail.status === "planned") {
    void ctx.scheduler.schedule(detail.task_id).catch((err: unknown) => {
      console.error("[morrow] task scheduling crashed:", err);
    });
  }
  sendJson(res, 201, detail);
}

function handleListTasks(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: RequestContext): void {
  const sessionId = url.searchParams.get("session_id");
  if (sessionId !== null && sessionId.trim().length === 0) {
    sendError(res, 400, "invalid_query", "session_id must be a non-empty string");
    return;
  }
  sendJson(res, 200, { tasks: ctx.tasks.listTasks(sessionId === null ? undefined : sessionId) });
}

function handleGetTask(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  const detail = ctx.tasks.getTask(params[0]);
  if (detail === null) {
    sendError(res, 404, "task_not_found", `task "${params[0]}" not found`);
    return;
  }
  sendJson(res, 200, detail);
}

/** 任务事件分页（账本 task_id 专列 + events_task_idx 索引；分页语义与 GET /v1/events 一致） */
function handleTaskEvents(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: RequestContext, params: string[]): void {
  const taskId = params[0];
  if (ctx.tasks.getTask(taskId) === null) {
    sendError(res, 404, "task_not_found", `task "${taskId}" not found`);
    return;
  }
  const page = parsePaging(url, res, { defaultLimit: 50 });
  if (page === null) return;
  sendJson(res, 200, ctx.ledger.list({ taskId, limit: page.limit, offset: page.offset }));
}

/** TaskError → HTTP：not_found 404、invalid_transition/immutable_node 409、
 *  invalid_revision 400、planner_unavailable 503、timeout 504；其余上抛 500 */
function handleTaskError(res: ServerResponse, err: unknown): void {
  if (err instanceof TaskError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "invalid_transition" || err.code === "immutable_node"
          ? 409
          : err.code === "invalid_revision"
            ? 400
            : err.code === "planner_unavailable"
              ? 503
              : err.code === "timeout"
                ? 504
                : err.code === "lease_denied" || err.code === "lease_not_held" || err.code === "lease_lost"
                  ? 409
                  : 500;
    sendError(res, status, `task_${err.code}`, err.message);
    return;
  }
  if (err instanceof CheckpointError) {
    const status = err.code === "checkpoint_not_found" ? 404 : err.code === "task_not_found" ? 404 : 409;
    sendError(res, status, err.code, err.message);
    return;
  }
  throw err;
}

// --- M1-T5 任务介入端点（票 #17，PRD §6.2 pause/resume/restore/checkpoints）-----
// 语义：pause 同步等安全点（在跑节点到边界）后返回 200 + checkpoint；resume/restore
// 完成 reconcile 与状态迁移后 202，后台驱动经返回的 drive promise fire-and-forget
// （失败路径已全部落账本，这里的 catch 只防未处理拒绝）。

function handlePauseTask(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    try {
      const { task, checkpoint } = await ctx.scheduler.pause(params[0]);
      sendJson(res, 200, { task, checkpoint });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

function handleResumeTask(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    try {
      const result = await ctx.scheduler.resume(params[0]);
      void result.drive.catch((err: unknown) => {
        console.error("[morrow] task resume drive crashed:", err);
      });
      sendJson(res, 202, {
        task: result.task,
        checkpoint_id: result.checkpoint_id,
        reconcile: result.report,
      });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

interface RestoreBody {
  checkpoint_id?: unknown;
}

function handleRestoreTask(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    const body = await readJsonBody(req, res);
    if (body === null) return; // 响应已在 readJsonBody 里写出
    const { checkpoint_id: checkpointId } = body as RestoreBody;
    if (typeof checkpointId !== "string" || checkpointId.trim().length === 0) {
      sendError(res, 400, "invalid_body", "checkpoint_id must be a non-empty string");
      return;
    }
    try {
      const result = await ctx.scheduler.restore(params[0], checkpointId);
      void result.drive.catch((err: unknown) => {
        console.error("[morrow] task restore drive crashed:", err);
      });
      sendJson(res, 202, {
        task: result.task,
        checkpoint_id: result.checkpoint_id,
        reconcile: result.report,
      });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

/** checkpoint 列表（新→旧；快照全量返回——M1 量级小，任务工作台直接可渲染） */
function handleListCheckpoints(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  if (ctx.tasks.getTask(params[0]) === null) {
    sendError(res, 404, "task_not_found", `task "${params[0]}" not found`);
    return;
  }
  sendJson(res, 200, { checkpoints: ctx.checkpoints.listCheckpoints(params[0]) });
}

// --- M1-T6 人工介入端点（票 #18，FR-TASK-3 修改/接管半边）------------------------
// 语义：revise = 修改未完成节点（task_version+1、下游重算、task.revised 审计事件）+
// 立即落 reason=revise 的新 checkpoint（旧版本 checkpoint 因版本不匹配自然失效，恢复
// 口径始终对齐当前 DAG）。takeover/complete/release = 节点 actor=owner 标记 → Owner
// 提交结果或交还调度；complete/release 在任务 waiting_input 时自动 kick 重新驱动
// （202 前同步完成状态迁移，驱动 fire-and-forget）。

interface ReviseBody {
  update?: unknown;
  add?: unknown;
  remove?: unknown;
}

function handleReviseTask(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const { update, add, remove } = body as ReviseBody;
    // 修改集字段形状在此校验（服务层校验语义）；透传前确保是数组形态
    for (const [field, value] of [["update", update], ["add", add], ["remove", remove]] as const) {
      if (value !== undefined && !Array.isArray(value)) {
        sendError(res, 400, "invalid_body", `${field} must be an array when present`);
        return;
      }
    }
    try {
      const result = ctx.tasks.reviseTask(params[0], {
        ...(update === undefined ? {} : { update: update as never }),
        ...(add === undefined ? {} : { add: add as never }),
        ...(remove === undefined ? {} : { remove: remove as never }),
      });
      // 修订后立即落新 checkpoint：恢复基准对齐新版本 DAG（reason=revise）
      const checkpoint = await ctx.checkpoints.createCheckpoint(params[0], "revise");
      sendJson(res, 200, { task: result.task, revision: result.revision, checkpoint });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

interface SupplyBody {
  node_id?: unknown;
  context?: unknown;
}

/**
 * 补充上下文（FR-TASK-3）：context 追加节点描述（node_id 给定）或任务目标（缺省），
 * task.context_supplied（actor=owner）留痕；任务 waiting_input 时自动 kick 重新驱动
 * （语义同 complete/release：状态迁移同步完成，驱动 fire-and-forget）。DAG 不变，
 * 不升 task_version、不落 checkpoint。守卫：任务/节点未知 404、终端态或已完成节点 409、
 * body 非法 400。
 */
function handleSupplyTask(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const { node_id: nodeId, context } = body as SupplyBody;
    if (typeof context !== "string" || context.trim().length === 0) {
      sendError(res, 400, "invalid_body", "context must be a non-empty string");
      return;
    }
    if (nodeId !== undefined && (typeof nodeId !== "string" || nodeId.trim().length === 0)) {
      sendError(res, 400, "invalid_body", "node_id must be a non-empty string when present");
      return;
    }
    try {
      const result = ctx.tasks.supplyContext(params[0], {
        context: context.trim(),
        ...(typeof nodeId === "string" ? { nodeId } : {}),
      });
      await ctx.scheduler.kick(params[0], "context_supplied").catch((err: unknown) => {
        console.error("[morrow] task kick after context supply crashed:", err);
      });
      sendJson(res, 200, { task: ctx.tasks.getTask(params[0]) ?? result.task, supplied: result.supplied });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

function handleTakeoverNode(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {  void (async () => {
    try {
      const task = ctx.tasks.takeoverNode(params[0], params[1]);
      sendJson(res, 200, { task });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

interface CompleteNodeBody {
  result?: unknown;
}

function handleCompleteNode(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const { result } = body as CompleteNodeBody;
    if (typeof result !== "string" || result.trim().length === 0) {
      sendError(res, 400, "invalid_body", "result must be a non-empty string");
      return;
    }
    try {
      const task = ctx.tasks.completeNode(params[0], params[1], result);
      // 任务因接管挂起（waiting_input）时自动重新驱动；其余状态由 Owner 显式 resume
      await ctx.scheduler.kick(params[0], "owner_node_completed").catch((err: unknown) => {
        console.error("[morrow] task kick after owner completion crashed:", err);
      });
      sendJson(res, 200, { task: ctx.tasks.getTask(params[0]) ?? task });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

function handleReleaseNode(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    try {
      const task = ctx.tasks.releaseNode(params[0], params[1]);
      await ctx.scheduler.kick(params[0], "owner_node_released").catch((err: unknown) => {
        console.error("[morrow] task kick after owner release crashed:", err);
      });
      sendJson(res, 200, { task: ctx.tasks.getTask(params[0]) ?? task });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

// --- M3-T4 执行租约端点（Issue #33 / FR-DEP-4）----------------------------------
// GET  /v1/tasks/:id/execution         执行权查询（租约 + 双端独立执行证据）
// POST /v1/tasks/:id/transfer-execution 当前持有者释放执行权（目标设备随后 acquire）
// POST /v1/tasks/:id/reconcile           Owner 显式裁决 needs_reconcile → completed/failed
// POST /v1/tasks/:id/reconcile/detect    同步/重启后按账本重新检测双端独立执行并冻结
// 语义：不自动合并任何一侧结果；needs_reconcile 的离开只能由 Owner 的选择触发。

interface TransferExecutionBody {
  target_replica_id?: unknown;
}

function handleTransferExecution(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const { target_replica_id: target } = body as TransferExecutionBody;
    if (typeof target !== "string" || target.trim().length === 0) {
      sendError(res, 400, "invalid_body", "target_replica_id must be a non-empty string");
      return;
    }
    try {
      const result = await ctx.scheduler.transferExecution(params[0], target.trim());
      sendJson(res, 200, {
        task: result.task,
        lease: result.lease,
        transfer_event_id: result.transferEventId,
        sequence: result.sequence,
      });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

/** 执行权查询：租约当前值（含 released/expired 的 token 计数）+ 双端执行证据 */
function handleTaskExecution(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  const detail = ctx.tasks.getTask(params[0]);
  if (detail === null) {
    sendError(res, 404, "task_not_found", `task "${params[0]}" not found`);
    return;
  }
  const evidence = detectDualExecution(ctx.ledger, detail.task_id);
  sendJson(res, 200, {
    task_id: detail.task_id,
    status: detail.status,
    lease: ctx.leases.current(detail.task_id),
    needs_reconcile: detail.status === "needs_reconcile",
    evidence,
  });
}

interface ReconcileBody {
  resolution?: unknown;
  note?: unknown;
}

/** Owner 显式裁决 needs_reconcile：completed | failed（不自动合并；note 进审计事件） */
function handleReconcileTask(req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  void (async () => {
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const { resolution, note } = body as ReconcileBody;
    if (resolution !== "completed" && resolution !== "failed") {
      sendError(res, 400, "invalid_body", "resolution must be \"completed\" or \"failed\"");
      return;
    }
    if (note !== undefined && (typeof note !== "string" || note.trim().length === 0)) {
      sendError(res, 400, "invalid_body", "note must be a non-empty string when present");
      return;
    }
    try {
      const transitioned = ctx.tasks.resolveNeedsReconcile(params[0], {
        resolution,
        ...(typeof note === "string" ? { note } : {}),
      });
      sendJson(res, 200, {
        task: ctx.tasks.getTask(params[0]) ?? transitioned.task,
        reconciliation: {
          resolution,
          event_id: transitioned.eventId,
          sequence: transitioned.sequence,
        },
      });
    } catch (err) {
      handleTaskError(res, err);
    }
  })();
}

/** 按账本重新检测（同步导入/重启后的显式触发入口）：有证据才冻结，幂等 */
function handleDetectReconcile(_req: IncomingMessage, res: ServerResponse, _url: URL, ctx: RequestContext, params: string[]): void {
  const detail = ctx.tasks.getTask(params[0]);
  if (detail === null) {
    sendError(res, 404, "task_not_found", `task "${params[0]}" not found`);
    return;
  }
  const evidence = detectDualExecution(ctx.ledger, detail.task_id);
  if (evidence === null) {
    sendJson(res, 200, { detected: false, task: detail, evidence: null });
    return;
  }
  try {
    const flagged = ctx.tasks.flagNeedsReconcile(detail.task_id, evidence);
    sendJson(res, 200, {
      detected: true,
      task: ctx.tasks.getTask(detail.task_id) ?? flagged.task,
      evidence,
    });
  } catch (err) {
    handleTaskError(res, err);
  }
}

/**
 * 同步导入后是否需要重建任务投影（D2）：纯租约生命周期事件（心跳/拒绝/释放）不改变
 * 任务/节点投影，排除它们避免每次心跳都触发全量重放。execution_transferred 与
 * needs_reconcile/reconciled 仍重建（所有权/状态语义变化）。
 */
const PURE_LEASE_EVENT_TYPES = new Set([
  "task.lease_acquired",
  "task.lease_renewed",
  "task.lease_released",
  "task.lease_lost",
  "task.lease_denied",
]);

function isProjectionTaskEvent(envelope: EventEnvelope): boolean {
  return envelope.event_type.startsWith("task.") && !PURE_LEASE_EVENT_TYPES.has(envelope.event_type);
}
