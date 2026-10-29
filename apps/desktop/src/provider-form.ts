/**
 * Provider 表单：状态类型 + 校验 + payload 映射（票 T7 / Issue #8）。
 *
 * 规则与 runtime ProviderRegistry 对齐（apps/runtime/src/providers.ts 校验工具），
 * 客户端先挡一层；服务端 400 provider_invalid_input 仍是权威。
 *
 * 密钥安全（与 T5 一致）：apiKey 仅在表单内存中存在——create 时随 payload 一次性发送，
 * edit 时留空表示不轮换；providerFormFromRecord 不回填密钥（API 也只给 has_api_key 投影），
 * 保存成功后由组件清空表单态。纯函数，无 DOM 依赖。
 */

/** compat 开关（与 runtime/pi-adapter 的 AdapterCompatConfig 三键一致） */
export const COMPAT_SWITCHES = [
  { key: "supportsDeveloperRole", label: "developer 角色", hint: "用 developer 角色替代 system" },
  { key: "supportsReasoningEffort", label: "reasoning_effort", hint: "推理力度参数" },
  { key: "supportsUsageInStreaming", label: "流式 usage", hint: "流式响应携带用量统计" },
] as const;

export type CompatKey = (typeof COMPAT_SWITCHES)[number]["key"];

export interface ProviderFormValues {
  name: string;
  baseUrl: string;
  model: string;
  /** 仅表单内存持有；永不回显、永不入日志 */
  apiKey: string;
  compat: Record<CompatKey, boolean>;
  /** 表单里以字符串承载，留空 = 用服务端默认；提交时转正整数 */
  contextWindow: string;
  maxTokens: string;
}

export type ProviderFormErrors = Partial<Record<"name" | "baseUrl" | "model" | "contextWindow" | "maxTokens", string>>;

export function emptyProviderForm(): ProviderFormValues {
  return {
    name: "",
    baseUrl: "",
    model: "",
    apiKey: "",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
    contextWindow: "",
    maxTokens: "",
  };
}

export function validateProviderForm(values: ProviderFormValues, mode: "create" | "edit"): ProviderFormErrors {
  const errors: ProviderFormErrors = {};
  if (values.name.trim().length === 0) errors.name = "显示名必填";
  const baseUrl = values.baseUrl.trim();
  if (baseUrl.length === 0) {
    errors.baseUrl = "Base URL 必填";
  } else if (!isHttpUrl(baseUrl)) {
    errors.baseUrl = "必须是 http(s):// 开头的合法 URL";
  }
  if (values.model.trim().length === 0) errors.model = "模型名必填";
  const contextWindow = optionalPositiveInt(values.contextWindow);
  if (contextWindow === "invalid") errors.contextWindow = "必须为正整数";
  const maxTokens = optionalPositiveInt(values.maxTokens);
  if (maxTokens === "invalid") errors.maxTokens = "必须为正整数";
  void mode; // create/edit 目前共用校验；api_key 可空是两种模式的共同语义（edit 留空 = 不轮换）
  return errors;
}

/** 空字符串 = 合法（edit 模式 = 不轮换；create 模式 = 免密端点）。非法输入返回 "invalid" */
function optionalPositiveInt(raw: string): number | "invalid" | undefined {
  if (raw.trim().length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return "invalid";
  return n;
}

function isHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

export interface CreateProviderPayload {
  name: string;
  base_url: string;
  model: string;
  compat: Record<CompatKey, boolean>;
  api_key?: string;
  context_window?: number;
  max_tokens?: number;
}

export function toCreatePayload(values: ProviderFormValues): CreateProviderPayload {
  const payload: CreateProviderPayload = {
    name: values.name.trim(),
    base_url: values.baseUrl.trim().replace(/\/+$/, ""),
    model: values.model.trim(),
    compat: { ...values.compat },
  };
  if (values.apiKey.length > 0) payload.api_key = values.apiKey;
  const contextWindow = optionalPositiveInt(values.contextWindow);
  if (typeof contextWindow === "number") payload.context_window = contextWindow;
  const maxTokens = optionalPositiveInt(values.maxTokens);
  if (typeof maxTokens === "number") payload.max_tokens = maxTokens;
  return payload;
}

export function toUpdatePatch(values: ProviderFormValues): CreateProviderPayload {
  // PATCH 语义：留空的 apiKey 不进 patch（= 不轮换），其余字段按表单全量提交
  return toCreatePayload(values);
}

export interface ProviderRecordLike {
  provider_id: string;
  name: string;
  base_url: string;
  model: string;
  compat: Record<string, boolean>;
  context_window: number;
  max_tokens: number;
  created_at: string;
  has_api_key: boolean;
  is_default: boolean;
}

/** 编辑表单回填：密钥绝不回填（运行时只给 has_api_key 投影，表单也不持有明文） */
export function providerFormFromRecord(record: ProviderRecordLike): ProviderFormValues {
  return {
    name: record.name,
    baseUrl: record.base_url,
    model: record.model,
    apiKey: "",
    compat: {
      supportsDeveloperRole: record.compat.supportsDeveloperRole === true,
      supportsReasoningEffort: record.compat.supportsReasoningEffort === true,
      supportsUsageInStreaming: record.compat.supportsUsageInStreaming === true,
    },
    contextWindow: String(record.context_window),
    maxTokens: String(record.max_tokens),
  };
}
