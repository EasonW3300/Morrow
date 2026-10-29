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
