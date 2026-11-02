/**
 * @morrow/runtime 公共出口。
 * 库形态供桌面宿主内嵌与测试使用；独立进程入口是 src/main.ts。
 */
export { EventLedger, LedgerError, DB_FILE_NAME } from "./ledger.ts";
export type {
  IntegrityMismatch,
  IntegrityReport,
  LedgerEntry,
  LedgerListOptions,
  LedgerPage,
  LedgerScanSelector,
  LedgerErrorCode,
  VerifyIntegrityOptions,
} from "./ledger.ts";
export { startRuntime } from "./runtime.ts";
export { DeviceRegistry } from "./devices.ts";
export type { DeviceRecord } from "./devices.ts";
export type { RuntimeHandle, RuntimeOptions } from "./runtime.ts";
export { loadConfig, defaultDataDir, resolveReplicaId, parseProviderConfig } from "./config.ts";
export type { RuntimeConfig, ProviderConfig } from "./config.ts";
export {
  SessionManager,
  SESSION_EVENT_TYPES,
  type AgentAdapterFactory,
  type AgentRuntimeExtras,
  type MemoryObserver,
  type MessageRecord,
  type SessionFrame,
  type SessionHistory,
  type SessionSummary,
} from "./sessions.ts";
export {
  TaskService,
  TaskError,
  TASK_EVENT_TYPES,
  TASK_TRANSITIONS,
  PLANNER_SYSTEM_PROMPT,
  validatePlannedDag,
  planWithRuntime,
} from "./tasks.ts";
export type {
  PlannerFactory,
  PlannedNodeInput,
  PlannedNode,
  PlannedDag,
  TaskServiceOptions,
  TransitionOptions,
  TransitionResult,
  TaskErrorCode,
} from "./tasks.ts";
export { TaskScheduler, DEFAULT_TASK_CONCURRENCY } from "./scheduler.ts";
export type {
  NodeAgentFactory,
  TaskNodeExecInput,
  TaskSchedulerOptions,
  PauseResult,
  ResumeResult,
} from "./scheduler.ts";
export {
  CheckpointService,
  CheckpointStore,
  CheckpointError,
  CHECKPOINT_SNAPSHOT_SCHEMA,
  TASK_CHECKPOINT_EVENT_TYPES,
  planReconcile,
} from "./checkpoint.ts";
export type {
  CheckpointNodeSnapshot,
  CheckpointPendingSideEffect,
  CheckpointRecord,
  CheckpointSnapshot,
  CheckpointTaskView,
  CheckpointErrorCode,
  ReconcileAction,
  ReconcileActionKind,
  ReconcileReport,
  RestoreOutcome,
} from "./checkpoint.ts";
export { ensureTaskTables, TASK_TABLES_SQL } from "./task-migrations.ts";
export {
  PermissionEngine,
  CapabilityError,
  CAPABILITY_EVENT_TYPES,
  EMPTY_GRANT,
  checkPermissionsWithinGrants,
  computeSourceHash,
  filesystemGlobWithin,
  networkTargetWithin,
  parseHostPort,
  pathWithinGlob,
  shellCategoryWithin,
  validateManifest,
  validatePermissionGrant,
} from "./capabilities/engine.ts";
export type {
  CapabilityErrorCode,
  PermissionEngineOptions,
  RegisterResult,
  RuntimeUseDecision,
} from "./capabilities/engine.ts";
export { CapabilityStore } from "./capabilities/store.ts";
export type { CapabilityRow, CapabilityVersionRow, CapabilityListFilter } from "./capabilities/store.ts";
export { ensureCapabilityTables, CAPABILITY_TABLES_SQL } from "./capabilities/migrations.ts";
export { capabilityRoutes } from "./capabilities/routes.ts";
export { ensureBuiltinCapabilities, builtinCapabilityManifests, MEMORY_WRITE_CAPABILITY_MANIFEST } from "./capabilities/builtin.ts";
export { MemoryStore, normalizeForFts, buildFtsQuery } from "./memory/store.ts";
export type {
  CandidateStatus,
  ConflictReason,
  ConflictResolution,
  CreateCandidateInput,
  MemoryCandidateRow,
  MemoryConflictRow,
  MemoryFactRow,
  MemoryRevisionRow,
  MemorySearchHit,
  MemorySourceRow,
} from "./memory/store.ts";
export {
  MemoryService,
  MemoryWriteError,
  MemoryControlError,
  MEMORY_EVENT_TYPES,
  MEMORY_WRITE_RULE,
  AUTO_CONSOLIDATE_MIN_CONFIDENCE,
} from "./memory/service.ts";
export type {
  MemoryWriteResult,
  ObserveUserMessageInput,
  MemoryControlErrorCode,
  ConsolidationRunSummary,
} from "./memory/service.ts";
export { HeuristicExtractor } from "./memory/extraction.ts";
export type { ExtractedCandidate, ExtractionInput, MemoryExtractor } from "./memory/extraction.ts";
export { DefaultConsolidator, salientTokens } from "./memory/consolidator.ts";
export type {
  ConsolidationAction,
  ConsolidationCandidateView,
  ConsolidationFactView,
  ConsolidationInput,
  MemoryConsolidator,
} from "./memory/consolidator.ts";
export { createMemoryWriteTool, MEMORY_WRITE_TOOL_NAME } from "./memory/tool.ts";
export { detectHighValue } from "./memory/heuristics.ts";
export type { HighValueMatch, HighValueRule } from "./memory/heuristics.ts";
export { probeSandbox } from "./health.ts";
export type { SandboxProbe, SandboxStatus } from "./health.ts";
export { uuidv7 } from "./uuid-v7.ts";
export { openSqlite } from "./db.ts";
export type { SqliteDatabase, SqliteStatement, SqliteParam } from "./db.ts";
export {
  ProviderRegistry,
  ProviderRegistryError,
  ENV_PROVIDER_ID,
} from "./providers.ts";
export type {
  ProviderRecord,
  ProviderRegistryOptions,
  ProviderResolver,
  ResolvedProvider,
} from "./providers.ts";
export { testProviderConnectivity } from "./connectivity.ts";
export type { ConnectivityProbeInput, ConnectivityResult } from "./connectivity.ts";
export {
  createInMemorySecretStore,
  createKeychainStore,
  createLinuxSecretToolStore,
  createWindowsCredentialStore,
  defaultExec,
  detectSecretStore,
} from "./keyring.ts";
export type { DetectedSecretStore, ExecFn, ExecResult, SecretStore } from "./keyring.ts";
