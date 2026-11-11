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
  DeviceIdentityInfo,
  DeviceInfo,
  PairingClaimRequest,
  PairingClaimResponse,
  PairingCodeResponse,
  PairingJoinRequest,
  PairingJoinResponse,
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
  ChannelAdapterState,
  ChannelCapabilities,
  ChannelConversationKind,
  ChannelEnvironment,
  ChannelFeatureSupport,
  ChannelHealth,
  ChannelLocalBridgeHealth,
  ChannelPermissionContext,
  ChannelPrincipal,
  ChannelSecretFieldView,
  ChannelSecretsView,
  ChannelSendReceipt,
  ChannelSummary,
  InboundAttachment,
  InboundMention,
  InboundMessage,
  InboundSender,
  OutboundMessage,
} from "./channel-contracts.ts";
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
export type {
  ChannelAllowMode,
  ChannelAllowlistEntryView,
  ContactAmbiguityView,
  ContactCapabilityCategory,
  ContactGrantView,
  ContactIdentityView,
  ContactInviteView,
  ContactView,
} from "./contact-contracts.ts";
export { CONTACT_CAPABILITY_CATEGORIES } from "./contact-contracts.ts";
export type {
  OutboxListPage,
  OutboxMessageRecord,
  OutboxReceipt,
  OutboxStatus,
  OutboxTarget,
  OutboxTargetKind,
} from "./outbox-contracts.ts";
export type {
  NotificationDeliveryKind,
  NotificationDeliveryStatus,
  NotificationEventType,
  NotificationHistoryPage,
  NotificationQuietHours,
  NotificationRecord,
  NotificationRule,
  NotificationRuleInput,
} from "./notification-contracts.ts";
export { NOTIFICATION_EVENT_TYPE_VALUES } from "./notification-contracts.ts";
export {
  CAPABILITY_CHANNELS,
  SHELL_COMMAND_CATEGORIES,
} from "./capability-contracts.ts";
export type {
  SyncCursorRecord,
  SyncEnvelope,
  SyncGapDetails,
  SyncPeerRunResult,
  SyncPeerStatus,
  SyncPullBatch,
  SyncPushOutcome,
  SyncPushRequest,
  SyncRunReport,
  SyncRunRequest,
  SyncStatus,
} from "./sync-contracts.ts";
export {
  canonicalJson,
  computeIntegrityHash,
  type EventEnvelopeWithoutHash,
} from "./integrity.ts";
export { default as eventEnvelopeSchema } from "../schema/event-envelope.schema.json" with { type: "json" };
