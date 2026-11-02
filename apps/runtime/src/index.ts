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
export type { NodeAgentFactory, TaskNodeExecInput, TaskSchedulerOptions } from "./scheduler.ts";
export { ensureTaskTables, TASK_TABLES_SQL } from "./task-migrations.ts";
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
