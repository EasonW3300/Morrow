/**
 * @morrow/runtime 公共出口。
 * 库形态供桌面宿主内嵌与测试使用；独立进程入口是 src/main.ts。
 */
export { EventLedger, LedgerError, DB_FILE_NAME } from "./ledger.ts";
export type {  IntegrityMismatch,
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
export type {  PlannerFactory,
  PlannedNodeInput,
  PlannedNode,
  PlannedDag,
  TaskServiceOptions,
  TransitionOptions,
  TransitionResult,
  TaskErrorCode,
} from "./tasks.ts";
export { TaskScheduler, DEFAULT_TASK_CONCURRENCY } from "./scheduler.ts";
export type {  NodeAgentFactory,
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
export type {  CheckpointNodeSnapshot,
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
export type {  CapabilityErrorCode,
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
export type {  CandidateStatus,
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
export type {  MemoryWriteResult,
  ObserveUserMessageInput,
  MemoryControlErrorCode,
  ConsolidationRunSummary,
} from "./memory/service.ts";
export { HeuristicExtractor } from "./memory/extraction.ts";
export type { ExtractedCandidate, ExtractionInput, MemoryExtractor } from "./memory/extraction.ts";
export { DefaultConsolidator, salientTokens } from "./memory/consolidator.ts";
export type {  ConsolidationAction,
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
// 沙箱执行 Worker（M2-T2 / Issue #23）：SandboxRunner 接缝 + 默认容器实现 + 检测器 + 调用接缝
export { ToolInvoker, UnknownToolError } from "./sandbox/invoker.ts";
export type { InvocationResult, InvokeContext, ToolRegistration, ToolInvokerOptions } from "./sandbox/invoker.ts";
export { DockerRunner, DEFAULT_SANDBOX_IMAGE, defaultDockerExec } from "./sandbox/docker-runner.ts";
export { SandboxError, SandboxUnavailableError } from "./sandbox/runner.ts";
export type { SandboxErrorCode, SandboxResult, SandboxRunner, SandboxToolPackage } from "./sandbox/runner.ts";
export { detectContainerRuntime, INSTALL_HINT } from "./sandbox/detect.ts";
export type {  ContainerEngine,
  ContainerRuntimeInfo,
  DetectContainerRuntimeOptions,
  SandboxAvailability,
} from "./sandbox/detect.ts";
export { DEFAULT_SANDBOX_RESOURCES, normalizeSandboxContract, SandboxContractError } from "./sandbox/contract.ts";
export type { SandboxContract, SandboxContractInput, SandboxResources } from "./sandbox/contract.ts";
export { buildDockerRunArgs } from "./sandbox/docker-args.ts";
export { errorEnvelope, parseToolEnvelope, resultEnvelope } from "./sandbox/protocol.ts";
export { runGoWorker } from "./sandbox/go-worker.ts";
export type { GoWorkerResult } from "./sandbox/go-worker.ts";
export { createLocalPermissionEngine, createRegistryPermissionAdapter, PermissionDeniedError } from "./sandbox/permission.ts";
export type {
  RegistryRuntimeChecker,
  RuntimeUseContext,
  RuntimeUseRequest,
  SandboxPermissionEngine,
  ToolManifestLite,
  ToolPermissions,
} from "./sandbox/permission.ts";
export { uuidv7 } from "./uuid-v7.ts";
export { openSqlite } from "./db.ts";
export type { SqliteDatabase, SqliteStatement, SqliteParam } from "./db.ts";
export {
  ProviderRegistry,
  ProviderRegistryError,
  ENV_PROVIDER_ID,
} from "./providers.ts";
export type {  ProviderRecord,
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
// 能力工厂（M2-T3 / Issue #24）：生成闭环——检索/规划/构建/验证/确认门 + 事件留痕
export { CapabilityFactory, CAPABILITY_FACTORY_EVENT_TYPES } from "./capabilities/factory/service.ts";
export type { CapabilityFactoryOptions } from "./capabilities/factory/service.ts";
export { CapabilityFactoryStore } from "./capabilities/factory/store.ts";
export type { FactoryRequestRow } from "./capabilities/factory/store.ts";
export { factoryRoutes } from "./capabilities/factory/routes.ts";
export {
  CAPABILITY_FACTORY_SYSTEM_PROMPT,
  PiCapabilityGenerator,
  buildUserPrompt,
  extractJsonObject,
} from "./capabilities/factory/generator.ts";
export type { CapabilityGenerator, CapabilityGeneratorContext, PiCapabilityGeneratorOptions } from "./capabilities/factory/generator.ts";
export { DefaultCapabilityRetriever, capabilityTokens } from "./capabilities/factory/retriever.ts";
export type { CapabilityRetriever, RetrievalMatch, RetrievalResult, MemoryMatch, DefaultCapabilityRetrieverOptions } from "./capabilities/factory/retriever.ts";
export { CapabilityBuilder } from "./capabilities/factory/builder.ts";
export type { BuildResult, CapabilityBuilderOptions } from "./capabilities/factory/builder.ts";
export { CapabilityVerifier } from "./capabilities/factory/verifier.ts";
export type { VerifyInput, CapabilityVerifierOptions } from "./capabilities/factory/verifier.ts";
export { validateGeneratorOutput } from "./capabilities/factory/plan-schema.ts";
export type { PlanValidationResult } from "./capabilities/factory/plan-schema.ts";
export type {
  FactoryTestCaseKind,
  FactoryTestCaseSpec,
  GeneratorOutput,
  GeneratorFailureCode,
  GeneratorResult,
  ValidatedPlan,
  FactoryRequestStatus,
  FactoryRequestStage,
  FactoryRequestError,
  VerifyReport,
  FactoryRequestView,
  TestCaseVerdict,
} from "./capabilities/factory/types.ts";
export { FACTORY_TEST_CASE_KINDS } from "./capabilities/factory/types.ts";
export { ENTRY_TEMPLATE, VERIFY_TEMPLATE } from "./capabilities/factory/harness-templates.ts";
