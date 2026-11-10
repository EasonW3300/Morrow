import { createHash } from "node:crypto";
import {
  CAPABILITY_CHANNELS,
  SHELL_COMMAND_CATEGORIES,
  canonicalJson,
  type ActorId,
  type CapabilityAuthor,
  type CapabilityManifest,
  type CapabilityPermissions,
  type CapabilityRecord,
  type CapabilityRuntimeKind,
  type CapabilitySandboxSpec,
  type CapabilityStatus,
  type CapabilityUseRequest,
  type CapabilityVersionRecord,
  type ContactCapabilityCategory,
  type PermissionGrant,
  type PermissionViolation,
  type SensitivityLevel,
  type ShellCommandCategory,
} from "@morrow/protocol";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { CONTACT_EVENT_TYPES } from "../contacts/events.ts";
import { ContactStore } from "../contacts/store.ts";
import {
  CapabilityStore,
  type CapabilityRow,
} from "./store.ts";

/**
 * PermissionEngine —— 能力注册与权限判定的单一入口（票 M2-T1 / Issue #22；FR-CAP-5/7、
 * PRD §6.3 manifest v1、§5「允许生成 ≠ 允许扩权」）。注册路径（POST /v1/capabilities）
 * 与运行时路径（assertRuntimeUse，T2 接执行链）共用同一套五维判定函数。
 *
 * 五维判定口径（permissions ⊆ PermissionGrant，逐维逐项）：
 *   filesystem  请求 glob 被 grant glob **包含**（请求 glob 匹配的每个路径也被 grant
 *               匹配）：按 `/` 分段判定——grant `**` 段覆盖其后任意内容；grant 单段通配
 *               （如 `*`、`*.md`）只覆盖请求的**字面段**（能被其匹配的），仅 grant 为
 *               纯 `*` 时才覆盖请求的单段通配；请求 `**` 只有 grant `**` 能覆盖；
 *               请求耗尽后 grant 余段必须全为 `**`。运行时（assertRuntimeUse）请求侧
 *               给具体路径，按同一分段规则做 glob 匹配。
 *   network     `host:port` 按最后一个 `:` 拆分；请求侧必须具体（host/port 均不可为
 *               `*`，注册校验强制）；grant 侧任一部分可为 `*`（通配该部分），否则精确相等。
 *   shell       封闭类别枚举：请求类别出现在 grant 列表即放行；grant 含 `arbitrary`
 *               覆盖全部类别；请求 `arbitrary` 只有 grant 含 `arbitrary` 才放行（晶格顶）。
 *   channels    封闭渠道枚举，grant 精确包含。
 *   credentials 凭据 id 精确包含（最敏感维度，不支持通配）。
 *
 * manifest 校验（PRD §6.3 字段集）：name/version 形态、author/runtime 枚举、permissions
 * 五维齐全、schemas 对象形态、sandbox 三键枚举、tests 数组；author=ai 追加两条注册
 * 政策（§2/FR-CAP-2/4）：tests 非空、sandbox.type 不得为 none（无沙箱的 AI 代码拒绝注册）。
 * source_hash 在注册时计算存档：sha256(canonicalJson(manifest − source_hash))；调用方
 * 携带的 source_hash 与复算不符 → source_hash_mismatch（完整性声明被篡改即拒绝）。
 *
 * 生命周期：注册幂等（同 name+version 同内容 → created:false 不重复审计）；同版本不同
 * 内容 409（版本不可变——rollback 的依据）；新版本 = 追加版本行 + 当前指针前移；
 * enable/disable/rollback 均留 capability.* 审计事件（事件在行落定之后记账）。
 */

export type CapabilityErrorCode =
  | "invalid_input"
  | "invalid_manifest"
  | "source_hash_mismatch"
  | "sandbox_required"
  | "escalation"
  | "not_found"
  | "version_not_found"
  | "version_conflict"
  | "invalid_state";

export class CapabilityError extends Error {
  code: CapabilityErrorCode;
  violations?: PermissionViolation[];

  constructor(code: CapabilityErrorCode, message: string, violations?: PermissionViolation[]) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
    this.violations = violations;
  }
}

/** capability.* 事件族（event_type 清单只增不减；点分风格同 PRD §6.3） */
export const CAPABILITY_EVENT_TYPES = {
  registered: "capability.registered",
  enabled: "capability.enabled",
  disabled: "capability.disabled",
  rolledBack: "capability.rolled_back",
  grantsUpdated: "capability.grants_updated",
  used: "capability.used",
} as const;

/**
 * 生命周期审计事件（#22 修复批：事件驱动接线的载荷形状）。注册/启停/回滚每次
 * 迁移的审计事件落账本后同步回调——runtime 用它把 ToolInvoker 注册表与能力
 * 注册表保持同相（disable 即从调用接缝摘除，enable/rollback 重新登记）。
 */
export interface CapabilityLifecycleEvent {
  eventType:
    | typeof CAPABILITY_EVENT_TYPES.registered
    | typeof CAPABILITY_EVENT_TYPES.enabled
    | typeof CAPABILITY_EVENT_TYPES.disabled
    | typeof CAPABILITY_EVENT_TYPES.rolledBack;
  /** 迁移后的当前记录投影（registered 仅 created=true 时回调） */
  record: CapabilityRecord;
}

// --- 形态常量 ---------------------------------------------------------------

const NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^sha256-[0-9a-f]{64}$/;
const AUTHORS: readonly CapabilityAuthor[] = ["human", "ai"];
const RUNTIMES: readonly CapabilityRuntimeKind[] = ["typescript", "go"];
const SANDBOX_TYPES = ["container", "process", "none"] as const;
const SANDBOX_NETWORKS = ["none", "restricted", "full"] as const;
const SANDBOX_FILESYSTEMS = ["none", "workspace-only", "full"] as const;

export const ALL_DIMENSIONS = ["filesystem", "network", "shell", "channels", "credentials"] as const;

/** 未设置过授权时的默认 grant：五维全空（最小授权起点） */
export const EMPTY_GRANT: PermissionGrant = {
  filesystem: [],
  network: [],
  shell: [],
  channels: [],
  credentials: [],
};

// --- 五维判定（纯函数；注册与运行时共用） ------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSingleSpanWildcard(segment: string): boolean {
  return segment !== "**" && segment.includes("*");
}

/** 单段内 glob 匹配：`*` 匹配段内任意字符（不含 `/`）；其余按字面 */
function matchSingleSegment(text: string, pattern: string): boolean {
  if (!pattern.includes("*")) return text === pattern;
  const regex = new RegExp(
    `^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
  );
  return regex.test(text);
}

/**
 * 请求 glob 是否被单个 grant glob 包含（判定口径见模块注释 filesystem 一行）。
 * 返回 true 当且仅当：任何被 requestGlob 匹配的路径也必然被 grantGlob 匹配。
 */
export function filesystemGlobWithin(requestGlob: string, grantGlob: string): boolean {
  const req = requestGlob.split("/");
  const grant = grantGlob.split("/");
  return globSegmentsWithin(req, 0, grant, 0);
}

function globSegmentsWithin(req: string[], ri: number, grant: string[], gi: number): boolean {
  if (ri === req.length) {
    // 请求耗尽：grant 余段必须都能零宽匹配（只能是 `**`）
    return grant.slice(gi).every((segment) => segment === "**");
  }
  if (gi === grant.length) return false;
  const g = grant[gi];
  const r = req[ri];
  if (g === "**") {
    // 覆盖一个请求段（grant 原地）或零宽跳过（grant 前进）
    return globSegmentsWithin(req, ri + 1, grant, gi) || globSegmentsWithin(req, ri, grant, gi + 1);
  }
  if (!grantSegmentCovers(g, r)) return false;
  return globSegmentsWithin(req, ri + 1, grant, gi + 1);
}

function grantSegmentCovers(grantSeg: string, requestSeg: string): boolean {
  if (requestSeg === "**") return grantSeg === "**"; // 已在调用处排除，防御性兜底
  if (grantSeg === "**") return true;
  if (grantSeg === "*") return true; // 单段全覆盖：字面段与单段通配都被包含
  if (isSingleSpanWildcard(grantSeg)) {
    // 单段通配 grant 只可靠覆盖字面段；对请求通配不做子集分析（保守拒绝）
    return !isSingleSpanWildcard(requestSeg) && matchSingleSegment(requestSeg, grantSeg);
  }
  return grantSeg === requestSeg;
}

/** 具体路径是否被 glob 匹配（运行时判定口径：`**` 跨段、`*` 单段内、其余字面） */
export function pathWithinGlob(path: string, glob: string): boolean {
  const req = path.split("/");
  const grant = glob.split("/");
  return pathSegmentsWithin(req, 0, grant, 0);
}

function pathSegmentsWithin(req: string[], ri: number, grant: string[], gi: number): boolean {
  if (ri === req.length) {
    return grant.slice(gi).every((segment) => segment === "**");
  }
  if (gi === grant.length) return false;
  const g = grant[gi];
  if (g === "**") {
    return pathSegmentsWithin(req, ri + 1, grant, gi) || pathSegmentsWithin(req, ri, grant, gi + 1);
  }
  if (!matchSingleSegment(req[ri], g)) return false;
  return pathSegmentsWithin(req, ri + 1, grant, gi + 1);
}

/**
 * host:port 解析（最后一个 `:` 拆分）。port 为 `*` 或 1-65535 数字；host 非空。
 * 返回 null = 形态非法。
 */
export function parseHostPort(target: string): { host: string; port: string } | null {
  const idx = target.lastIndexOf(":");
  if (idx <= 0 || idx === target.length - 1) return null;
  const host = target.slice(0, idx);
  const port = target.slice(idx + 1);
  if (host.length === 0) return null;
  if (port !== "*" && !/^\d+$/.test(port)) return null;
  if (port !== "*" && !(Number(port) >= 1 && Number(port) <= 65535)) return null;
  return { host, port };
}

/**
 * network 目标判定：请求侧必须具体（host/port 都不能是 `*`——注册校验强制）；grant
 * 侧任一部分为 `*` 即通配该部分，否则精确相等。
 */
export function networkTargetWithin(request: string, grant: string): boolean {
  const req = parseHostPort(request);
  const g = parseHostPort(grant);
  if (req === null || g === null) return false;
  if (req.host === "*" || req.port === "*") return false; // 请求侧不允许通配
  return (g.host === "*" || g.host === req.host) && (g.port === "*" || g.port === req.port);
}

/** shell 类别判定：grant 含该类别，或 grant 含晶格顶 `arbitrary`（请求 arbitrary 只认 arbitrary） */
export function shellCategoryWithin(request: ShellCommandCategory, grant: readonly ShellCommandCategory[]): boolean {
  if (request === "arbitrary") return grant.includes("arbitrary");
  return grant.includes(request) || grant.includes("arbitrary");
}

function dimensionWithin(dimension: keyof CapabilityPermissions, requested: string, grant: CapabilityPermissions): boolean {
  const list = grant[dimension] as readonly string[];
  switch (dimension) {
    case "filesystem":
      return list.some((pattern) => filesystemGlobWithin(requested, pattern));
    case "network":
      return list.some((target) => networkTargetWithin(requested, target));
    case "shell":
      return shellCategoryWithin(requested as ShellCommandCategory, list as readonly ShellCommandCategory[]);
    case "channels":
    case "credentials":
      return list.includes(requested);
  }
}

function grantSummary(dimension: keyof CapabilityPermissions, grant: CapabilityPermissions): string {
  const list = grant[dimension] as readonly string[];
  return list.length === 0 ? "(empty)" : `[${list.join(", ")}]`;
}

/**
 * 五维逐一判定：permissions 的每一项必须被 grant 覆盖。返回全部越权项
 * （每维每项一条，含具体超界原因）；空请求 = 无越权。
 */
export function checkPermissionsWithinGrants(
  permissions: CapabilityPermissions,
  grant: CapabilityPermissions,
): PermissionViolation[] {
  const violations: PermissionViolation[] = [];
  for (const dimension of ALL_DIMENSIONS) {
    const list = permissions[dimension] as readonly string[];
    for (const item of list) {
      if (!dimensionWithin(dimension, item, grant)) {
        violations.push({
          dimension,
          requested: item,
          reason: `no grant covers "${item}" in dimension "${dimension}" (grant: ${grantSummary(dimension, grant)})`,
        });
      }
    }
  }
  return violations;
}

/**
 * 越权拒绝消息单源（#22 修复批 / C8）：注册预检（PermissionEngine.register）与工厂
 * 越权预检（CapabilityFactory 管线 plan 阶段）共用同一文案——逐维逐项可读，计数在先。
 */
export function escalationMessage(violations: PermissionViolation[]): string {
  return (
    `manifest permissions exceed the PermissionGrant (${violations.length} violation(s)): ` +
    violations.map((v) => `${v.dimension}: ${v.reason}`).join("; ")
  );
}

// --- manifest / grant 校验 ---------------------------------------------------

function failInvalid(message: string): never {
  throw new CapabilityError("invalid_manifest", message);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    failInvalid(`${field} must be an array of strings`);
  }
  return value as string[];
}

function nonEmptyStringArray(value: unknown, field: string): string[] {
  const list = stringArray(value, field);
  if (list.some((v) => v.trim().length === 0)) {
    failInvalid(`${field} entries must be non-empty strings`);
  }
  return list;
}

/** host:port 请求侧校验：必须具体（host/port 不得为 `*`） */
function validateNetworkRequestEntries(entries: string[]): string[] {
  for (const entry of entries) {
    const parsed = parseHostPort(entry);
    if (parsed === null) {
      failInvalid(`permissions.network entry "${entry}" must be "host:port" (port 1-65535)`);
    }
    if (parsed.host === "*" || parsed.port === "*") {
      failInvalid(`permissions.network entry "${entry}" must be concrete (wildcards are grant-side only)`);
    }
  }
  return entries;
}

function validateJsonSchemaObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    failInvalid(`${field} must be a JSON Schema object`);
  }
  const type = value.type;
  if (type !== undefined && type !== "object") {
    failInvalid(`${field}.type must be "object" (manifest v1 covers object-shaped tool I/O)`);
  }
  return value;
}

/**
 * manifest v1 校验（PRD §6.3 字段集）。通过则返回规范形态的 manifest
 * （source_hash 透传 undefined 时由注册流程计算）。
 */
export function validateManifest(input: unknown): CapabilityManifest {
  if (!isPlainObject(input)) {
    failInvalid("manifest must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  const name = body.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    failInvalid("name must be a lowercase dotted identifier like `docx-to-markdown` or `memory.write`");
  }
  const version = body.version;
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    failInvalid("version must be semantic version like `1.0.0` (optional -suffix)");
  }
  const author = body.author;
  if (author !== "human" && author !== "ai") {
    failInvalid("author must be `human` or `ai`");
  }
  const runtime = body.runtime;
  if (runtime !== "typescript" && runtime !== "go") {
    failInvalid("runtime must be `typescript` or `go`");
  }
  if (!isPlainObject(body.permissions)) {
    failInvalid("permissions must be an object with all five dimensions (filesystem/network/shell/channels/credentials)");
  }
  const permissions = body.permissions as Record<string, unknown>;
  for (const dimension of ALL_DIMENSIONS) {
    if (!(dimension in permissions)) {
      failInvalid(`permissions.${dimension} is required (state it explicitly, even when empty)`);
    }
  }
  const filesystem = nonEmptyStringArray(permissions.filesystem, "permissions.filesystem");
  const network = validateNetworkRequestEntries(nonEmptyStringArray(permissions.network, "permissions.network"));
  const shellRaw = stringArray(permissions.shell, "permissions.shell");
  for (const category of shellRaw) {
    if (!(SHELL_COMMAND_CATEGORIES as readonly string[]).includes(category)) {
      failInvalid(`permissions.shell entry "${category}" must be one of ${SHELL_COMMAND_CATEGORIES.join(" | ")}`);
    }
  }
  const channelsRaw = stringArray(permissions.channels, "permissions.channels");
  for (const channel of channelsRaw) {
    if (!(CAPABILITY_CHANNELS as readonly string[]).includes(channel)) {
      failInvalid(`permissions.channels entry "${channel}" must be one of ${CAPABILITY_CHANNELS.join(" | ")}`);
    }
  }
  const credentials = nonEmptyStringArray(permissions.credentials, "permissions.credentials");
  if (new Set(credentials).size !== credentials.length) {
    failInvalid("permissions.credentials entries must be unique");
  }
  const manifestPermissions: CapabilityPermissions = {
    filesystem,
    network,
    shell: shellRaw as ShellCommandCategory[],
    channels: channelsRaw as CapabilityManifest["permissions"]["channels"],
    credentials,
  };
  const inputSchema = validateJsonSchemaObject(body.input_schema, "input_schema");
  const outputSchema = validateJsonSchemaObject(body.output_schema, "output_schema");
  if (!isPlainObject(body.sandbox)) {
    failInvalid("sandbox must be an object with type/network/filesystem");
  }
  const sandbox = body.sandbox as Record<string, unknown>;
  for (const [key, allowed] of [
    ["type", SANDBOX_TYPES],
    ["network", SANDBOX_NETWORKS],
    ["filesystem", SANDBOX_FILESYSTEMS],
  ] as const) {
    if (!(allowed as readonly string[]).includes(String(sandbox[key]))) {
      failInvalid(`sandbox.${key} must be one of ${(allowed as readonly string[]).join(" | ")}`);
    }
  }
  const tests = stringArray(body.tests, "tests");
  if (tests.some((v) => v.trim().length === 0)) {
    failInvalid("tests entries must be non-empty strings");
  }
  if (author === "ai" && tests.length === 0) {
    // FR-CAP-2：能力工厂产物必须携带测试用例（沙箱验证的输入，T2 消费）
    failInvalid("author=ai manifests must declare at least one test case");
  }
  if (body.source_hash !== undefined && (typeof body.source_hash !== "string" || !SHA256_RE.test(body.source_hash))) {
    failInvalid("source_hash must match /^sha256-[0-9a-f]{64}$/ when present");
  }
  const manifest: CapabilityManifest = {
    name,
    version,
    author,
    runtime,
    permissions: manifestPermissions,
    input_schema: inputSchema,
    output_schema: outputSchema,
    sandbox: {
      type: sandbox.type as CapabilitySandboxSpec["type"],
      network: sandbox.network as CapabilitySandboxSpec["network"],
      filesystem: sandbox.filesystem as CapabilitySandboxSpec["filesystem"],
    },
    tests,
  };
  if (typeof body.source_hash === "string") manifest.source_hash = body.source_hash;
  if (author === "ai" && manifest.sandbox.type === "none") {
    // §2 执行隔离 / FR-CAP-4：无沙箱的 AI 生成代码不得注册（human/builtin 不受限）
    throw new CapabilityError(
      "sandbox_required",
      `author=ai capability "${name}" declares sandbox.type "none": AI-generated code requires a sandbox (container/process) to register`,
    );
  }
  return manifest;
}

/** grant 文档校验（PUT /v1/capabilities/grants 的 Owner 授权面；grant 侧允许 `*`） */
export function validatePermissionGrant(input: unknown): PermissionGrant {
  if (!isPlainObject(input)) {
    throw new CapabilityError("invalid_input", "grants must be a JSON object with all five dimensions");
  }
  for (const dimension of ALL_DIMENSIONS) {
    if (!(dimension in input)) {
      throw new CapabilityError("invalid_input", `grants.${dimension} is required (state it explicitly, even when empty)`);
    }
  }
  const body = input as Record<string, unknown>;
  const filesystem = nonEmptyStringArrayGrant(body.filesystem, "grants.filesystem");
  const network = stringArray(body.network, "grants.network");
  for (const entry of network) {
    if (parseHostPort(entry) === null) {
      throw new CapabilityError("invalid_input", `grants.network entry "${entry}" must be "host:port" (port 1-65535 or "*")`);
    }
  }
  const shellRaw = stringArray(body.shell, "grants.shell");
  for (const category of shellRaw) {
    if (!(SHELL_COMMAND_CATEGORIES as readonly string[]).includes(category)) {
      throw new CapabilityError("invalid_input", `grants.shell entry "${category}" must be one of ${SHELL_COMMAND_CATEGORIES.join(" | ")}`);
    }
  }
  const channelsRaw = stringArray(body.channels, "grants.channels");
  for (const channel of channelsRaw) {
    if (!(CAPABILITY_CHANNELS as readonly string[]).includes(channel)) {
      throw new CapabilityError("invalid_input", `grants.channels entry "${channel}" must be one of ${CAPABILITY_CHANNELS.join(" | ")}`);
    }
  }
  const credentials = stringArray(body.credentials, "grants.credentials");
  if (credentials.some((v) => v.trim().length === 0)) {
    throw new CapabilityError("invalid_input", "grants.credentials entries must be non-empty strings");
  }
  return {
    filesystem,
    network,
    shell: shellRaw as ShellCommandCategory[],
    channels: channelsRaw as PermissionGrant["channels"],
    credentials,
  };
}

function nonEmptyStringArrayGrant(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim().length === 0)) {
    throw new CapabilityError("invalid_input", `${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

/** 注册时的完整性口径：sha256(canonicalJson(manifest − source_hash))，`sha256-<hex>` */
export function computeSourceHash(manifest: CapabilityManifest): string {
  const { source_hash: _ignored, ...rest } = manifest;
  const digest = createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
  return `sha256-${digest}`;
}

// --- PermissionEngine ---------------------------------------------------------

export interface PermissionEngineOptions {
  dataDir: string;
  ledger: EventLedger;
  replicaId: string;
  /**
   * 生命周期观察者（#22 修复批：事件驱动接线）：注册（首见）/启用/停用/回滚的审计
   * 事件落账本后同步回调——runtime 用它同步 ToolInvoker 调用注册表（disable 即摘除、
   * enable/rollback 重新登记），调用面与注册表不出现相位移。
   */
  onLifecycle?: (event: CapabilityLifecycleEvent) => void;
}

export interface RegisterResult {
  record: CapabilityRecord;
  created: boolean;
  eventId: string | null;
}

export interface RuntimeUseDecision {
  allowed: true;
  name: string;
  version: string;
}

// --- 可信联系人授权（M4-T6 / Issue #43） -------------------------------------

/**
 * 联系人越权请求的五类（AC-13 前置，全部阻断并留痕）：
 *   memory_read  读记忆（仅 memory_reference 类别 + sensitivity=public）
 *   filesystem   读文件（联系人默认不可访问）
 *   shell        开发工具/命令（联系人默认不可访问）
 *   capability   执行未授权能力（scope 未声明的能力名 → 拒绝；再走全局运行时复核）
 *   session      读他人会话（只允许该联系人自己经渠道建立的会话）
 */
export type ContactAccessRequest =
  | { contact_id: string; action: "memory_read"; sensitivity?: SensitivityLevel }
  | { contact_id: string; action: "filesystem"; path: string }
  | { contact_id: string; action: "shell"; category: string }
  | { contact_id: string; action: "capability"; capability: string }
  | { contact_id: string; action: "session"; session_id: string }
  /**
   * 渠道入站消息的授权类别判定（A4 修复批 / Issue #37）：消息意图 → 类别
   * （query / task_execute / memory_reference）。联系人仅能触达其已授权类别；
   * 拒绝落 contact.permission_denied（与其余五类同一审计出口）。
   */
  | { contact_id: string; action: "category"; category: ContactCapabilityCategory };

export interface ContactAccessDecision {
  allowed: boolean;
  /** 拒绝原因（allowed=false 时存在；同时已落 contact.permission_denied 审计） */
  reason?: string;
  /** 拒绝审计事件 id */
  event_id?: string;
}

export class PermissionEngine {
  readonly #store: CapabilityStore;
  readonly #contacts: ContactStore;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;
  readonly #onLifecycle: ((event: CapabilityLifecycleEvent) => void) | undefined;
  #closed = false;

  constructor(options: PermissionEngineOptions) {
    this.#store = CapabilityStore.open(options.dataDir);
    this.#contacts = ContactStore.open(options.dataDir);
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
    this.#onLifecycle = options.onLifecycle;
  }

  /**
   * 注册（单一入口）：manifest 校验 → permissions ⊆ grants 五维校验（越权即拒，
   * 具体到维与项）→ source_hash 计算存档 → 落行 → capability.registered 审计。
   * 幂等：同 name+version 同内容返回既有记录（created:false，不重复审计）；
   * 同版本不同内容 → version_conflict（版本不可变）。
   * 状态默认：author=human → enabled（Owner 批准即注册启用，PRD §5.2）；
   * author=ai → disabled（允许生成 ≠ 允许扩权，Owner enable 后才可调用）。
   * verified（GLOSSARY「已验证」）：工厂确认路径（options.verified，沙箱逐用例验证
   * 先于 confirm）与 builtin（options.builtin，Owner 交付的 vetted 内置件）直接为
   * true；human 注册按 manifest.tests 非空判定；其余（无测试 human、直注 ai）= false。
   */
  register(
    manifestInput: unknown,
    options: { actorId?: ActorId; builtin?: boolean; verified?: boolean; now?: Date } = {},
  ): RegisterResult {
    this.#assertOpen();
    const manifest = validateManifest(manifestInput);
    const sourceHash = computeSourceHash(manifest);
    if (manifest.source_hash !== undefined && manifest.source_hash !== sourceHash) {
      throw new CapabilityError(
        "source_hash_mismatch",
        `manifest.source_hash ${manifest.source_hash} does not match the recomputed content hash ${sourceHash}`,
      );
    }
    const violations = checkPermissionsWithinGrants(manifest.permissions, this.getGrants());
    if (violations.length > 0) {
      throw new CapabilityError("escalation", escalationMessage(violations), violations);
    }
    const now = (options.now ?? new Date()).toISOString();
    const verified: boolean =
      options.verified === true ||
      options.builtin === true ||
      (manifest.author === "human" && manifest.tests.length > 0);
    const existing = this.#store.get(manifest.name);
    if (existing !== null && existing.version === manifest.version) {
      if (existing.source_hash === sourceHash) {
        return { record: this.#project(existing), created: false, eventId: null };
      }
      throw new CapabilityError(
        "version_conflict",
        `capability "${manifest.name}" version ${manifest.version} is already registered with different content; versions are immutable (bump the version or rollback)`,
      );
    }
    const manifestJson = canonicalJson({ ...manifest, source_hash: sourceHash });
    const status: CapabilityStatus = manifest.author === "human" ? "enabled" : "disabled";
    const fields = {
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      runtime: manifest.runtime,
      verified: verified ? 1 : 0,
      source_hash: sourceHash,
      manifest: manifestJson,
    };
    if (existing === null) {
      this.#store.insertNew({
        ...fields,
        status,
        created_at: now,
        updated_at: now,
      });
    } else {
      this.#store.appendVersion({
        ...fields,
        updated_at: now,
      });
    }
    const eventId = this.#append(
      CAPABILITY_EVENT_TYPES.registered,
      options.actorId ?? "owner",
      {
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        runtime: manifest.runtime,
        status,
        verified,
        source_hash: sourceHash,
        ...(options.builtin === true ? { builtin: true } : {}),
      },
    );
    const row = this.#store.get(manifest.name) as CapabilityRow;
    const record = this.#project(row);
    if (existing === null) {
      // 首见注册才回调生命周期（created:false 幂等路径不重复驱动接线）
      this.#emitLifecycle({ eventType: CAPABILITY_EVENT_TYPES.registered, record });
    }
    return { record, created: true, eventId };
  }

  /** 启用（幂等：已启用不重复审计）。审计事件留痕。 */
  enable(name: string, options: { actorId?: ActorId; now?: Date } = {}): { record: CapabilityRecord; changed: boolean } {
    return this.#setStatusTransition(name, "enabled", options);
  }

  /** 停用（幂等）。停用后运行时调用被 assertRuntimeUse 拒绝（capability_disabled）。 */
  disable(name: string, options: { actorId?: ActorId; now?: Date } = {}): { record: CapabilityRecord; changed: boolean } {
    return this.#setStatusTransition(name, "disabled", options);
  }

  /**
   * 回滚：当前指针指回历史版本（目标版本必须存在于 capability_versions；已在目标版本
   * 409）。status 保持不变（enabled 的能力以旧版本继续 enabled——回滚是修代码不是停用）。
   */
  rollback(
    name: string,
    targetVersion: string,
    options: { actorId?: ActorId; now?: Date } = {},
  ): { record: CapabilityRecord; from_version: string; to_version: string } {
    this.#assertOpen();
    const row = this.#store.get(name);
    if (row === null) {
      throw new CapabilityError("not_found", `capability "${name}" is not registered`);
    }
    const target = this.#store.getVersion(name, targetVersion);
    if (target === null) {
      const known = this.#store.versions(name).map((v) => v.version);
      throw new CapabilityError(
        "version_not_found",
        `capability "${name}" has no version ${targetVersion} (known versions: ${known.join(", ") || "none"})`,
      );
    }
    if (row.version === targetVersion) {
      throw new CapabilityError("invalid_state", `capability "${name}" is already at version ${targetVersion}`);
    }
    const now = (options.now ?? new Date()).toISOString();
    const targetManifest = JSON.parse(target.manifest) as CapabilityManifest;
    this.#store.rollbackTo({
      name,
      version: target.version,
      author: target.author,
      runtime: targetManifest.runtime,
      verified: target.verified,
      source_hash: target.source_hash,
      manifest: target.manifest,
      updated_at: now,
    });
    this.#append(
      CAPABILITY_EVENT_TYPES.rolledBack,
      options.actorId ?? "owner",
      { name, from_version: row.version, to_version: target.version },
    );
    const record = this.#project(this.#store.get(name) as CapabilityRow);
    this.#emitLifecycle({ eventType: CAPABILITY_EVENT_TYPES.rolledBack, record });
    return { record, from_version: row.version, to_version: target.version };
  }

  /**
   * 运行时复核（单一入口的运行时半边；T2 执行链接入）：能力必须存在且 enabled，
   * 请求的五维每一项必须同时被 manifest 声明与当前 grant 覆盖（双重复核——grant 收窄
   * 立即约束运行时，Owner 收权不需要等能力重新注册）。任一越权 → escalation（含
   * violations）；停用 → invalid_state；未注册 → not_found。
   */
  assertRuntimeUse(name: string, request: CapabilityUseRequest = {}): RuntimeUseDecision {
    this.#assertOpen();
    const row = this.#store.get(name);
    if (row === null) {
      throw new CapabilityError("not_found", `capability "${name}" is not registered`);
    }
    if (row.status !== "enabled") {
      throw new CapabilityError("invalid_state", `capability "${name}" is ${row.status} (runtime use denied)`);
    }
    const manifest = JSON.parse(row.manifest) as CapabilityManifest;
    const grant = this.getGrants();
    const violations: PermissionViolation[] = [];
    const pushAll = (dimension: keyof CapabilityPermissions, items: readonly string[], source: CapabilityPermissions): void => {
      for (const item of items) {
        if (!dimensionWithin(dimension, item, source)) {
          violations.push({
            dimension,
            requested: item,
            reason: `not covered by capability ${dimension} permissions (declared: ${grantSummary(dimension, source)})`,
          });
        }
      }
    };
    const req = request ?? {};
    if (req.filesystem !== undefined) {
      const paths = stringList(req.filesystem, "filesystem");
      pushAll("filesystem", paths, manifest.permissions);
      if (violations.length === 0) pushAll("filesystem", paths, grant);
    }
    if (req.network !== undefined) {
      const targets = stringList(req.network, "network");
      for (const target of targets) {
        if (parseHostPort(target) === null || parseHostPort(target)?.host === "*" || parseHostPort(target)?.port === "*") {
          violations.push({ dimension: "network", requested: target, reason: 'malformed target (expected concrete "host:port")' });
        }
      }
      pushAll("network", targets, manifest.permissions);
      if (violations.length === 0) pushAll("network", targets, grant);
    }
    if (req.shell !== undefined) {
      if (!Array.isArray(req.shell)) {
        throw new CapabilityError("invalid_input", "request.shell must be an array");
      }
      const categories = (req.shell as Array<string | { category?: unknown }>).map((entry) => {
        const category = typeof entry === "string" ? entry : entry?.category;
        if (typeof category !== "string" || !(SHELL_COMMAND_CATEGORIES as readonly string[]).includes(category)) {
          throw new CapabilityError("invalid_input", `request.shell entries must be shell command categories (${SHELL_COMMAND_CATEGORIES.join(" | ")})`);
        }
        return category;
      });
      pushAll("shell", categories, manifest.permissions);
      if (violations.length === 0) pushAll("shell", categories, grant);
    }
    if (req.channels !== undefined) {
      const channels = stringList(req.channels, "channels");
      for (const channel of channels) {
        if (!(CAPABILITY_CHANNELS as readonly string[]).includes(channel)) {
          violations.push({ dimension: "channels", requested: channel, reason: "unknown channel id" });
        }
      }
      pushAll("channels", channels, manifest.permissions);
      if (violations.length === 0) pushAll("channels", channels, grant);
    }
    if (req.credentials !== undefined) {
      const credentialIds = stringList(req.credentials, "credentials");
      pushAll("credentials", credentialIds, manifest.permissions);
      if (violations.length === 0) pushAll("credentials", credentialIds, grant);
    }
    if (violations.length > 0) {
      throw new CapabilityError(
        "escalation",
        `runtime use of "${name}" denied (${violations.length} violation(s)): ` +
          violations.map((v) => `${v.dimension}: ${v.reason}`).join("; "),
        violations,
      );
    }
    return { allowed: true, name: row.name, version: row.version };
  }

  /**
   * 联系人授权类别（联系人 → 类别 → 能力集）。未登记的联系人返回 null（调用方回退
   * 旧的身份快照）；已登记但无显式授权行时按 FR-NOT-3 默认仅 query。
   */
  contactCategories(contactId: string): ContactCapabilityCategory[] | null {
    this.#assertOpen();
    if (this.#contacts.getContact(contactId) === null) return null;
    const categories = this.#contacts.listGrants(contactId).map((grant) => grant.category);
    return categories.length === 0 ? ["query"] : [...new Set(categories)];
  }

  /**
   * 联系人会话可用的能力名（scope 并集）。返回值语义：
   *   null  该会话不是联系人会话（Owner/普通会话）→ 不施加联系人收窄
   *   []    联系人会话但没有能力 scope → 不注入任何能力工具
   * 这是「执行未授权能力」在 Agent 工具注入面的落点：会话拿不到未授权工具。
   */
  contactCapabilitiesForSession(sessionId: string): string[] | null {
    this.#assertOpen();
    const contactId = this.#contacts.findContactBySession(sessionId);
    if (contactId === null) return null;
    const scopes = this.#contacts
      .listGrants(contactId)
      .flatMap((grant) => grant.scope);
    return [...new Set(scopes)];
  }

  /**
   * 联系人越权判定（单一入口，AC-13 前置）：五类请求逐类判定；拒绝时落
   * contact.permission_denied 审计并返回原因。**没有第二条判定路径**——渠道入站、
   * 记忆引用、能力调用都从这里出结论。
   */
  authorizeContactUse(request: ContactAccessRequest): ContactAccessDecision {
    this.#assertOpen();
    const contact = this.#contacts.getContact(request.contact_id);
    if (contact === null || contact.status !== "active") {
      return this.#denyContact(request, "contact_not_found");
    }
    const grants = this.#contacts.listGrants(request.contact_id);
    // 未显式授权 = 默认仅 query（PRD FR-NOT-3 / 与 contactCategories 同口径）；
    // 其它动作（记忆/能力/会话）不会因该默认值获得任何开口。
    const categories = new Set(
      grants.length === 0 ? (["query"] as ContactCapabilityCategory[]) : grants.map((grant) => grant.category),
    );

    switch (request.action) {
      case "memory_read": {
        if (!categories.has("memory_reference")) {
          return this.#denyContact(request, "memory_reference_not_granted");
        }
        if (request.sensitivity !== "public") {
          return this.#denyContact(request, "private_memory_denied");
        }
        return { allowed: true };
      }
      case "filesystem":
        // 联系人默认不可访问 Owner 文件（FR-NOT-3）；授权模型不提供文件维度开口子
        return this.#denyContact(request, "filesystem_denied");
      case "shell":
        // 联系人不得使用开发工具/命令
        return this.#denyContact(request, "dev_tools_denied");
      case "capability": {
        const scoped = grants.some((grant) => grant.scope.includes(request.capability));
        if (!scoped) {
          return this.#denyContact(request, "capability_not_granted");
        }
        try {
          // 联系人 scope 只是第一道闸；全局运行时复核（enabled + 五维）仍必须通过
          this.assertRuntimeUse(request.capability);
        } catch (err) {
          return this.#denyContact(
            request,
            err instanceof CapabilityError ? `capability_${err.code}` : "capability_unavailable",
          );
        }
        return { allowed: true };
      }
      case "session": {
        if (!this.#contacts.hasContactSession(request.contact_id, request.session_id)) {
          return this.#denyContact(request, "session_not_owned");
        }
        return { allowed: true };
      }
      case "category": {
        // A4 修复批：消息意图类别必须显式授权（默认仅 query）。
        if (!categories.has(request.category)) {
          return this.#denyContact(request, `${request.category}_not_granted`);
        }
        return { allowed: true };
      }
    }
  }

  /** 当前五维授权（未设置过 = 全空默认） */
  getGrants(): PermissionGrant {
    this.#assertOpen();
    const row = this.#store.getGrants();
    if (row === null) return { ...EMPTY_GRANT };
    return validatePermissionGrant(JSON.parse(row.grants));
  }

  /** 更新授权面（Owner PUT）：校验 → 落库 → capability.grants_updated 审计 */
  setGrants(grantInput: unknown, options: { actorId?: ActorId; now?: Date } = {}): { grants: PermissionGrant; eventId: string } {
    this.#assertOpen();
    const grants = validatePermissionGrant(grantInput);
    const now = (options.now ?? new Date()).toISOString();
    this.#store.setGrants(canonicalJson(grants), now);
    const eventId = this.#append(CAPABILITY_EVENT_TYPES.grantsUpdated, options.actorId ?? "owner", {
      grants: { ...grants },
    });
    return { grants, eventId };
  }

  list(filter: { status?: CapabilityStatus; author?: CapabilityAuthor; runtime?: CapabilityRuntimeKind } = {}): CapabilityRecord[] {
    this.#assertOpen();
    return this.#store
      .list({
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.author !== undefined ? { author: filter.author } : {}),
        ...(filter.runtime !== undefined ? { runtime: filter.runtime } : {}),
      })
      .map((row) => this.#project(row));
  }

  /** 详情：当前记录 + 版本历史（GET /v1/capabilities/:id） */
  get(name: string): { record: CapabilityRecord; versions: CapabilityVersionRecord[] } | null {
    this.#assertOpen();
    const row = this.#store.get(name);
    if (row === null) return null;
    return {
      record: this.#project(row),
      versions: this.#store.versions(name).map((version) => ({
        name: version.name,
        version: version.version,
        author: version.author as CapabilityAuthor,
        source_hash: version.source_hash,
        manifest: JSON.parse(version.manifest) as CapabilityManifest,
        created_at: version.created_at,
      })),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#contacts.close();
    this.#store.close();
  }

  // --- 内部 ------------------------------------------------------------------

  /** 联系人越权拒绝：原因落 contact.permission_denied（actor = contact:<id>） */
  #denyContact(request: ContactAccessRequest, reason: string): ContactAccessDecision {
    const payload: Record<string, unknown> = {
      contact_id: request.contact_id,
      action: request.action,
      reason,
    };
    if (request.action === "memory_read") payload.sensitivity = request.sensitivity ?? "private";
    if (request.action === "filesystem") payload.path = request.path;
    if (request.action === "shell") payload.category = request.category;
    if (request.action === "capability") payload.capability = request.capability;
    if (request.action === "session") payload.session_id = request.session_id;
    if (request.action === "category") payload.category = request.category;
    const eventId = this.#append(
      CONTACT_EVENT_TYPES.permissionDenied,
      `contact:${request.contact_id}`,
      payload,
    );
    return { allowed: false, reason, event_id: eventId };
  }

  #setStatusTransition(
    name: string,
    status: CapabilityStatus,
    options: { actorId?: ActorId; now?: Date },
  ): { record: CapabilityRecord; changed: boolean } {
    this.#assertOpen();
    const row = this.#store.get(name);
    if (row === null) {
      throw new CapabilityError("not_found", `capability "${name}" is not registered`);
    }
    if (row.status === status) {
      return { record: this.#project(row), changed: false };
    }
    const now = (options.now ?? new Date()).toISOString();
    this.#store.setStatus(name, status, now);
    this.#append(
      status === "enabled" ? CAPABILITY_EVENT_TYPES.enabled : CAPABILITY_EVENT_TYPES.disabled,
      options.actorId ?? "owner",
      { name, version: row.version },
    );
    const record = this.#project(this.#store.get(name) as CapabilityRow);
    this.#emitLifecycle({
      eventType: status === "enabled" ? CAPABILITY_EVENT_TYPES.enabled : CAPABILITY_EVENT_TYPES.disabled,
      record,
    });
    return { record, changed: true };
  }

  #append(eventType: string, actorId: ActorId, payload: Record<string, unknown>): string {
    const envelope = buildEventEnvelope({
      replicaId: this.#replicaId,
      actorId,
      eventType,
      payload,
    });
    this.#ledger.append(envelope);
    return envelope.event_id;
  }

  #emitLifecycle(event: CapabilityLifecycleEvent): void {
    this.#onLifecycle?.(event);
  }

  #project(row: CapabilityRow): CapabilityRecord {
    const manifest = JSON.parse(row.manifest) as CapabilityManifest;
    return {
      name: row.name,
      version: row.version,
      author: row.author as CapabilityAuthor,
      runtime: row.runtime as CapabilityRuntimeKind,
      status: row.status as CapabilityStatus,
      verified: row.verified === 1,
      source_hash: row.source_hash,
      manifest,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("permission engine is closed");
  }
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new CapabilityError("invalid_input", `request.${field} must be an array of strings`);
  }
  return value as string[];
}
