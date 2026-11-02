/**
 * @morrow/protocol 公共出口。
 * JSON Schema（跨语言真相源）与 TS 类型（创作期形态）由此一并导出。
 */
export type {
  ActorId,
  ChannelReceipt,
  EventEnvelope,
  SchemaVersion,
} from "./event-envelope.ts";
export type {
  ConnectivityResult,
  MemoryEntryKind,
  MemoryWriteInput,
  ProviderCompatConfig,
  ProviderRecord,
  SensitivityLevel,
} from "./api-contracts.ts";
export type {
  NodeGitRepoResource,
  NodeResources,
  SideEffectClass,
  TaskDetail,
  TaskNodeRecord,
  TaskNodeStatus,
  TaskStatus,
  TaskSummary,
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
export {
  canonicalJson,
  computeIntegrityHash,
  type EventEnvelopeWithoutHash,
} from "./integrity.ts";
export { default as eventEnvelopeSchema } from "../schema/event-envelope.schema.json" with { type: "json" };
