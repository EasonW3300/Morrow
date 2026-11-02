/**
 * 能力域合约类型（票 M2-T1 / Issue #22；GLOSSARY Capability/Tool/Skill/PermissionGrant，
 * PRD §4.2 FR-CAP-5/7、§6.3 Tool manifest v1、§5 安全语义「允许生成 ≠ 允许扩权」）。
 *
 * 唯一真相源：apps/runtime（生产方）与后续消费方都从这里 import。演进规则与
 * api-contracts 一致：字段只加不减、不改名、不收窄已有类型。
 *
 * 五维权限模型（FR-CAP-7 预授权维度）：
 *   filesystem  路径 glob 列表（`**` 跨段、`*` 单段内）
 *   network     目标 host:port 列表（grant 侧 port 可为 `*`）
 *   shell       命令类别枚举（封闭集合；`arbitrary` 覆盖其余全部类别）
 *   channels    渠道枚举（GLOSSARY Channel 集合）
 *   credentials 凭据 id 列表（精确匹配，不支持通配——最敏感维度）
 */

/** manifest 作者：human（Owner/builtin，注册默认启用）| ai（能力工厂生成，注册默认禁用） */
export type CapabilityAuthor = "human" | "ai";

/** 能力实现运行时（PRD §2：TS 或 Go 生成） */
export type CapabilityRuntimeKind = "typescript" | "go";

/**
 * shell 命令类别（封闭枚举，PRD「命令类别」维度）。
 * `arbitrary` 是超集类别：grant 含 arbitrary 即授权全部类别；请求 arbitrary 只有
 * grant 含 arbitrary 才放行（晶格顶，不允许被部分类别掩盖）。
 */
export type ShellCommandCategory =
  | "read"
  | "vcs"
  | "build"
  | "test"
  | "package"
  | "process"
  | "write"
  | "arbitrary";

export const SHELL_COMMAND_CATEGORIES: readonly ShellCommandCategory[] = [
  "read",
  "vcs",
  "build",
  "test",
  "package",
  "process",
  "write",
  "arbitrary",
];

/** 渠道枚举（GLOSSARY Channel；第一批渠道 + 桌面/语音本地入口，Telegram 预留） */
export type CapabilityChannel = "desktop" | "voice" | "feishu" | "qq" | "wechat" | "telegram";

export const CAPABILITY_CHANNELS: readonly CapabilityChannel[] = [
  "desktop",
  "voice",
  "feishu",
  "qq",
  "wechat",
  "telegram",
];

/** 五维权限声明（manifest 侧）/ 五维预授权（grant 侧）共用的维度形状 */
export interface CapabilityPermissions {
  filesystem: string[];
  network: string[];
  shell: ShellCommandCategory[];
  channels: CapabilityChannel[];
  credentials: string[];
}

/**
 * PermissionGrant（GLOSSARY）：Owner 的事先授权面。当前为**单份全局授权**
 * （GET/PUT /v1/capabilities/grants）——注册校验 permissions ⊆ grants 的判定基准；
 * 收窄立即约束运行时（assertRuntimeUse 同时对 manifest 声明与当前 grant 复核）。
 */
export type PermissionGrant = CapabilityPermissions;

/** 沙箱规格（PRD §6.3；§2 执行隔离：AI 生成代码无沙箱不得注册执行） */
export interface CapabilitySandboxSpec {
  type: "container" | "process" | "none";
  network: "none" | "restricted" | "full";
  filesystem: "none" | "workspace-only" | "full";
}

/**
 * Tool manifest v1（PRD §6.3 字段集）。source_hash 由注册方（runtime）在注册时
 * 计算存档：sha256(canonicalJson(manifest 去除 source_hash))；调用方可携带该字段
 * 作完整性声明，与复算值不符 → 400 source_hash_mismatch。
 */
export interface CapabilityManifest {
  /** 能力稳定 id（点分小写标识，如 memory.write；注册表主键） */
  name: string;
  /** 语义化版本；同 name+version 的 manifest 内容不可变（回滚依据） */
  version: string;
  author: CapabilityAuthor;
  runtime: CapabilityRuntimeKind;
  permissions: CapabilityPermissions;
  /** 入参 JSON Schema（对象形态；PiAdapter 侧做参数校验） */
  input_schema: Record<string, unknown>;
  /** 出参 JSON Schema（对象形态） */
  output_schema: Record<string, unknown>;
  sandbox: CapabilitySandboxSpec;
  /** 测试用例引用（FR-CAP-2 生成；author=ai 必须非空） */
  tests: string[];
  /** 注册时计算的完整性哈希（sha256-<hex>）；见类型注释的口径 */
  source_hash?: string;
}

/** 注册表状态（GLOSSARY：注册后可调用 ⇔ enabled） */
export type CapabilityStatus = "enabled" | "disabled";

/** 能力注册记录投影（GET /v1/capabilities 条目） */
export interface CapabilityRecord {
  name: string;
  version: string;
  author: CapabilityAuthor;
  runtime: CapabilityRuntimeKind;
  status: CapabilityStatus;
  /**
   * 已验证标记（GLOSSARY「已验证」；FR-CAP-5 调用路径）：能力是否经测试/沙箱验证——
   * 工厂确认（沙箱逐用例验证）= true；builtin（Owner 交付的 vetted 内置件）= true；
   * human 注册且 manifest.tests 非空 = true；其余（无测试的 human 注册、未经工厂
   * 验证直注的 ai 注册）= false。Skill 引用校验要求 enabled AND verified。
   */
  verified: boolean;
  source_hash: string;
  manifest: CapabilityManifest;
  created_at: string;
  updated_at: string;
}

/** 版本历史条目（capability_versions 表投影；rollback 目标） */
export interface CapabilityVersionRecord {
  name: string;
  version: string;
  author: CapabilityAuthor;
  source_hash: string;
  manifest: CapabilityManifest;
  created_at: string;
}

/** 运行时使用请求（assertRuntimeUse 的 actualRequest；T2 执行链接入） */
export interface CapabilityUseRequest {
  /** 本次要触达的具体路径（glob 已在 manifest 声明，运行时给具体路径） */
  filesystem?: string[];
  /** 本次要连接的具体 host:port */
  network?: string[];
  /** 本次要执行的命令类别 */
  shell?: Array<ShellCommandCategory | { category: ShellCommandCategory }>;
  /** 本次要外发的渠道 */
  channels?: CapabilityChannel[];
  /** 本次要使用的凭据 id */
  credentials?: string[];
}

/** 越权判定结果项：具体哪一维、哪一项、为何超界（注册 400 / 运行时拒绝的依据） */
export interface PermissionViolation {
  dimension: keyof CapabilityPermissions;
  /** 被拒的请求项（glob / host:port / 类别 / 渠道 / 凭据 id / 路径） */
  requested: string;
  reason: string;
}
