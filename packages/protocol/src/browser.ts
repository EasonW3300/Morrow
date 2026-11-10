/**
 * @morrow/protocol 浏览器安全入口（`@morrow/protocol/browser`）。
 *
 * 与默认出口（./index.ts）的差异：不导出 integrity.ts（node:crypto 依赖）与
 * event-envelope JSON Schema——二者仅服务 Node 侧运行时；浏览器 bundle（desktop
 * 的 vite build）只允许从本入口取类型与纯 JS 常量，避免 node 内置模块被拖进
 * 浏览器构建（CI 三平台 build 腿回归的根因，见 Issue #27 / #24）。
 *
 * 演进规则：本文件只允许追加「无 node 内置模块、无副作用」的导出；任何
 * node 依赖一律留在默认出口。
 */
export type {
  ActorId,
  ChannelReceipt,
  EventEnvelope,
  SchemaVersion,
} from "./event-envelope.ts";
export type {
  ConnectivityResult,
  DeviceIdentityInfo,
  DeviceInfo,
  PairingClaimRequest,
  PairingClaimResponse,
  PairingCodeResponse,
  MemoryEntryKind,
  MemoryWriteInput,
  ProviderCompatConfig,
  ProviderRecord,
  SensitivityLevel,
} from "./api-contracts.ts";
export type {
  ExecutionLease,
  ExecutionReconcileEvidence,
  ExecutionTransferRecord,
  NodeGitRepoResource,
  NodeResources,
  ReconcileEvidenceSource,
  SideEffectClass,
  TaskDetail,
  TaskExecutionState,
  TaskNodeRecord,
  TaskNodeStatus,
  TaskStatus,
  TaskSummary,
  TransferExecutionRequest,
  TransferExecutionResponse,
} from "./task-contracts.ts";
export type {
  CapabilityAuthor,
  CapabilityChannel,
  CapabilityManifest,
  CapabilityPermissions,
  CapabilityRecord,
  CapabilityRuntimeKind,
  CapabilitySandboxSpec,
  CapabilityStatus,
  CapabilityUseRequest,
  CapabilityVersionRecord,
  PermissionGrant,
  PermissionViolation,
  ShellCommandCategory,
} from "./capability-contracts.ts";
export {
  CAPABILITY_CHANNELS,
  SHELL_COMMAND_CATEGORIES,
} from "./capability-contracts.ts";
