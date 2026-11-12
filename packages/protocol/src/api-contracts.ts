/**
 * 控制面 API 合约类型（PRD §6.1：UI ↔ Runtime 本地 HTTP + JSON）。
 *
 * 唯一真相源：apps/runtime（生产方）与 apps/desktop（消费方）都从这里 import，
 * 不再各自维护拷贝（M0 code-review / Issue #11：ProviderRecord/ConnectivityResult
 * 曾在 runtime、desktop api、provider-form 三处各有一份）。
 *
 * 演进规则与 event-envelope 一致：字段只加不减、不改名、不收窄已有类型。
 */

/**
 * compat 开关（OpenAI 兼容端点的行为差异开关，语义见 @morrow/pi-adapter 的
 * AdapterCompatConfig——与后者三键同构；protocol 不反向依赖 adapter 包，
 * 故以结构类型在此定版，两侧结构赋值兼容）。
 */
export interface ProviderCompatConfig {
  /** false → system prompt 走 system 消息而非 developer（vLLM/Ollama 等常需） */
  supportsDeveloperRole?: boolean;
  /** false → 不发送 reasoning_effort */
  supportsReasoningEffort?: boolean;
  /** false → 不请求 stream_options.include_usage */
  supportsUsageInStreaming?: boolean;
}

/** Provider 元数据投影（GET/POST /v1/providers 等）——绝无密钥字段，has_api_key/is_default 为投影值 */
export interface ProviderRecord {
  provider_id: string;
  name: string;
  base_url: string;
  model: string;
  compat: ProviderCompatConfig;
  context_window: number;
  max_tokens: number;
  created_at: string;
  has_api_key: boolean;
  is_default: boolean;
}

/**
 * Provider 连通性测试结果（POST /v1/providers/:id/test）：
 *   ok            2xx
 *   auth_failed   401 / 403（密钥无效或无权限）
 *   unreachable   连接失败 / DNS 失败 / 超时——kind 区分超时与连接失败（结构化字段，
 *                 UI 不再嗅探英文 detail 串；M0 code-review / Issue #11）
 *   error         其余 HTTP 状态（端点可达但行为异常，如 404/500）
 * 安全：载荷只含状态码 / 类别 / 延迟 / 错误摘要，绝不含密钥，也不含供应商响应体。
 */
export type ConnectivityResult =
  | { result: "ok"; http_status: number; latency_ms: number }
  | { result: "auth_failed"; http_status: number; latency_ms: number }
  | { result: "unreachable"; kind: "timeout" | "connect_error"; detail: string; latency_ms: number }
  | { result: "error"; http_status: number; latency_ms: number };

// --- 记忆（票 M1-T1 / Issue #13；GLOSSARY Memory* 与 PRD §6.4 对齐）------------

/** 敏感等级（GLOSSARY: Sensitivity Level）；新记忆默认 private */
export type SensitivityLevel = "public" | "private" | "locked";

/** 记忆条目类型（PRD §6.4 frontmatter `type` 字段的取值集合） */
export type MemoryEntryKind = "fact" | "preference" | "profile" | "procedural";

/**
 * memory.write 工具入参（经 PiAdapter tools 通道注册，M1-T1）。
 * confidence/sensitivity 省略时的默认值由 runtime 侧定义：confidence 0.9（显式写入）、
 * sensitivity private（GLOSSARY：新记忆默认仅 Owner 会话可读）。
 */
export interface MemoryWriteInput {
  /** 记忆内容（非空陈述） */
  content: string;
  /** 条目类型；缺省 fact */
  kind?: MemoryEntryKind;
  /** 置信度 [0,1]；缺省 0.9 */
  confidence?: number;
  /** 敏感等级；缺省 private */
  sensitivity?: SensitivityLevel;
}

// --- Persona（票 M7-A-T1 / Issue #58；GLOSSARY Persona、ADR-0009）------------
//
// 全局人设 = 结构化字段（名字/语气/职责/禁止行为）+ 自由补充。字段顺序固定不可配置：
// 拼装顺序为 名字 → 语气 → 职责 → 禁止 → 其他（缓存前缀稳定性依赖这个顺序）。
// `GET/PUT /v1/persona` 的请求/响应形状即此类型；每次 PUT 写入 `persona.updated`
// 事件（payload 为全量 Persona），随账本同步传播。
export interface Persona {
  /** 助手名字（非空且 ≤ PERSONA_LIMITS.name 字符） */
  name: string;
  /** 语气设定（≤ PERSONA_LIMITS.tone 字符） */
  tone: string;
  /** 职责清单（每项 ≤ PERSONA_LIMITS.responsibilityItem 字符，最多 responsibilities 项） */
  responsibilities: string[];
  /** 禁止行为清单（每项 ≤ PERSONA_LIMITS.prohibitionItem 字符，最多 prohibitions 项） */
  prohibitions: string[];
  /** 其他自由设定（≤ PERSONA_LIMITS.extra 字符） */
  extra: string;
}

/**
 * Persona 字段长度上限（服务端校验与桌面表单共用的唯一真相源）。
 * name 的 40 字符上限来自票面验收；其余为 ADR-0009「结构化优于纯文本」的防呆边界
 * （避免把整段提示词塞进单个字段，也避免无限增长破坏缓存前缀的稳定性）。
 */
export const PERSONA_LIMITS = {
  name: 40,
  tone: 200,
  responsibilityItem: 120,
  responsibilities: 20,
  prohibitionItem: 120,
  prohibitions: 20,
  extra: 2000,
} as const;

/** Persona 默认值：首次无 `persona.updated` 事件时 GET 返回这一份（缺省即默认）。 */
export const DEFAULT_PERSONA: Persona = {
  name: "Morrow",
  tone: "简洁直接",
  responsibilities: ["个人助理与开发助手"],
  prohibitions: [],
  extra: "",
};

// --- 设备与配对（M3-T2 / Issue #31；FR-DEP-2、GLOSSARY Device/Replica）--------
//
// 设备身份 = ed25519 公钥；指纹 = 公钥原始 32 字节的 SHA-256 前 16 hex。
// 请求鉴权方案见 ADR-0008（bearer token，配对时下发；私钥/令牌只进 OS 凭据库）。
// 演进规则同上：字段只加不减。

/** 设备身份投影（配对响应与设备列表共用；绝无私有字段——私钥/令牌哈希不出现在任何 API 响应） */
export interface DeviceIdentityInfo {
  replica_id: string;
  /** ed25519 公钥原始 32 字节的 base64（标准字母表，带 padding） */
  public_key: string;
  /** 公钥 SHA-256 前 16 hex（小写，32 字符） */
  fingerprint: string;
  /** 短格式指纹：AB12-CD34-EF56-7890（大写、4 位分组，UI 双端核对用） */
  fingerprint_short: string;
}

/** GET /v1/devices 的元素（已注册设备投影；未配对的本机行 public_key/fingerprint 为 null） */
export interface DeviceInfo {
  replica_id: string;
  label: string | null;
  /** 已配对设备必有；本机惰性供给身份前为 null */
  public_key: string | null;
  /** 已配对设备必有；本机惰性供给身份前为 null */
  fingerprint: string | null;
  fingerprint_short: string | null;
  created_at: string;
  last_seen_at: string;
  /** 最近一次成功同步时间（M3-T3 同步引擎写入；本票前恒 null） */
  last_sync_at: string | null;
  /** 首次配对成功时间（本机自注册设备为 null） */
  paired_at: string | null;
  /** 可信状态（撤销后仍为 true，但 revoked 同时为 true——两者独立记录） */
  trusted: boolean;
  revoked: boolean;
  revoked_at: string | null;
}

/** POST /v1/pairing/codes 响应：一次性 6 位数字码 + 本机身份（供对端核对指纹） */
export interface PairingCodeResponse {
  code: string;
  /** ISO 时间；默认创建后 5 分钟过期 */
  expires_at: string;
  server: DeviceIdentityInfo;
}

/** POST /v1/pairing/claim 请求体（PRD §5.2：新设备凭码加入信任网络） */
export interface PairingClaimRequest {
  /** 已信任设备生成的 6 位数字码 */
  code: string;
  /** 新设备的 ed25519 公钥（raw 32 bytes base64） */
  device_public_key: string;
  /** 人工可读设备名 */
  device_label?: string;
  /**
   * 新设备的 replica_id（uuid）。纯协议上服务端可代为生成并返回；
   * 携带时用于保持新设备既有副本身份（推荐客户端生成并随 claim 提交）。
   */
  device_replica_id?: string;
  /**
   * 新设备自身的 HTTP 基地址（M3 同步接线修复 / Issue #34）：服务端把它写进 devices
   * 表的 base_url，使服务端也能作为发起方向该设备出站同步（对端地址不能被猜）。
   * 浏览器 claim 无法可靠提供时缺省；该方向的同步会以 `no_base_url` 明确不可达。
   */
  device_base_url?: string;
  /**
   * 可选：客户端从配对方（已信任设备）离线获得的指纹。服务端比对自身指纹，
   * 不一致立即 409 fingerprint_mismatch 且不消耗配对码——双端指纹不一致的
   * 明确失败路径（而不是静默建立信任）。
   */
  server_fingerprint?: string;
}

/** POST /v1/pairing/claim 响应：双方指纹 + 一次性 bearer token（客户端应存 OS 凭据库） */
export interface PairingClaimResponse {
  /** 该设备后续请求的 bearer token（仅此响应出现一次；服务端只存哈希） */
  token: string;
  /** 新设备身份（服务端落库后的投影） */
  device: DeviceIdentityInfo & { label: string | null };
  /** 服务端（本机）身份，供客户端核对指纹 */
  server: DeviceIdentityInfo;
  /** 客户端存 token 的 OS 凭据库 account（service 固定 `com.morrow.device`） */
  token_account: string;
  paired_at: string;
}

/**
 * POST /v1/pairing/join 请求体（M3 修复批 / Issue #35，PRD §5.2 流程 1）：
 * **本机 Runtime 作为新设备**加入 `base_url` 指向的已信任 Runtime。
 *
 * 与浏览器的区别：Runtime 可以在宿主侧完成 claim、校验指纹，并把拿到的 bearer token
 * 写入本机 OS 凭据库（浏览器 WebView 无法安全持久化），因此「加入设备」真正可用。
 */
export interface PairingJoinRequest {
  /** 要加入的 Runtime 基地址（http/https，不含末尾斜杠亦可） */
  base_url: string;
  /** 已信任设备生成的一次性 6 位配对码 */
  code: string;
  /** 本机设备标签（对端设备列表里显示） */
  device_label?: string;
  /**
   * 可选：从对端屏幕离线获得的指纹。**本机校验对端 claim 响应里的指纹**；
   * 不一致立即中止并撤销对端刚建立的信任（rollback），不落任何本地凭据。
   */
  expect_server_fingerprint?: string;
}

/**
 * POST /v1/pairing/join 响应：**绝不含 bearer token 明文**（token 只写本机凭据库）。
 * `device` 是加入后本机 devices 表中对端（服务端）的可信投影。
 */
export interface PairingJoinResponse {
  device: DeviceInfo;
  /** 对端（服务端）指纹（完整 16 hex，供 UI 展示/留档） */
  server_fingerprint: string;
  /** 短格式指纹（AB12-CD34-EF56-7890） */
  server_fingerprint_short: string;
}
