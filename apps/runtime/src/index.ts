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
export { probeSandbox } from "./health.ts";
export type { SandboxProbe, SandboxStatus } from "./health.ts";
export { uuidv7 } from "./uuid-v7.ts";
export { openSqlite } from "./db.ts";
export type { SqliteDatabase, SqliteStatement, SqliteParam } from "./db.ts";
