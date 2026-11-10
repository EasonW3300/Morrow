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
