import type { ChannelSecretsView } from "@morrow/protocol";
import type { SecretStore } from "../keyring.ts";
import {
  FEISHU_SECRET_FIELDS,
  FEISHU_SECRET_SERVICE,
} from "./adapters/feishu/config.ts";
import { QQ_SECRET_FIELDS, QQ_SECRET_SERVICE } from "./adapters/qq/config.ts";
import { WECHAT_SECRET_FIELDS, WECHAT_SECRET_SERVICE } from "./bootstrap.ts";

/**
 * 渠道凭据配置投影（M4-T8 / Issue #45：渠道管理 UI 的凭据表单）。
 *
 * 稳定适配器（飞书/QQ）的凭据只进 SecretStore（ADR-0002），服务名固定
 * `channel:<channel_id>`，account = 字段名。本模块只提供两件事：
 *   - 字段清单与必填性（UI 表单结构 + 运行时启动缺字段诊断同口径）；
 *   - 读写之后的**投影**：configured = 非空，绝不回传密文（与 Provider has_api_key 同原则）。
 *
 * 实验适配器（微信）没有平台凭据（本地桥），返回 null → 路由层 400
 * channel_not_configurable。写入语义：只提交本次要改的字段；空字符串 = 删除该字段
 * （可选字段的清空路径），必填字段不允许写空。
 */

export interface ChannelCredentialFieldSpec {
  field: string;
  required: boolean;
}

export interface ChannelCredentialSpec {
  channelId: string;
  service: string;
  fields: readonly ChannelCredentialFieldSpec[];
}

const FEISHU_SPEC: ChannelCredentialSpec = {
  channelId: "feishu",
  service: FEISHU_SECRET_SERVICE,
  // bot_open_id 非必填（未配置时群 @ 一律保守视为未提及）
  fields: FEISHU_SECRET_FIELDS.map((field) => ({
    field,
    required: field !== "bot_open_id",
  })),
};

const QQ_SPEC: ChannelCredentialSpec = {
  channelId: "qq",
  service: QQ_SECRET_SERVICE,
  // bot_secret 仅 webhook 签名校验需要；token_endpoint 是可选的联调覆盖
  fields: QQ_SECRET_FIELDS.map((field) => ({
    field,
    required: field === "app_id" || field === "app_secret",
  })),
};

/**
 * 微信实验适配器没有平台凭据，但有一个可配置项：本地桥（`bridge_command` 或
 * `bridge_endpoint`，二选一）。此前不在规格内 → UI 无法配置微信桥，与实际能力不符。
 * 两个字段都非必填（任一即可），由启动装配判定。
 */
const WECHAT_SPEC: ChannelCredentialSpec = {
  channelId: "wechat",
  service: WECHAT_SECRET_SERVICE,
  fields: WECHAT_SECRET_FIELDS.map((field) => ({ field, required: false })),
};

const SPECS: readonly ChannelCredentialSpec[] = [FEISHU_SPEC, QQ_SPEC, WECHAT_SPEC];

/** channel_id → 凭据字段规格；无凭据概念的渠道返回 null */
export function channelCredentialSpec(channelId: string): ChannelCredentialSpec | null {
  return SPECS.find((spec) => spec.channelId === channelId) ?? null;
}

/** 读取 SecretStore 并生成投影（不回显任何值） */
export async function readChannelSecrets(
  secretStore: SecretStore,
  spec: ChannelCredentialSpec,
): Promise<ChannelSecretsView> {
  const fields = await Promise.all(
    spec.fields.map(async (field) => {
      const value = await secretStore.getSecret(spec.service, field.field);
      return {
        field: field.field,
        configured: value !== null && value.trim().length > 0,
        required: field.required,
      };
    }),
  );
  return { channel_id: spec.channelId, secret_service: spec.service, fields };
}

export type ChannelSecretWriteResult =
  | { ok: true; view: ChannelSecretsView }
  | { ok: false; code: string; message: string };

/**
 * 写入/删除字段后返回新投影。
 * 入参形态：{ [field]: string }——未出现的字段保持不变，空字符串删除，必填字段空值拒绝。
 */
export async function writeChannelSecrets(
  secretStore: SecretStore,
  spec: ChannelCredentialSpec,
  input: unknown,
): Promise<ChannelSecretWriteResult> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, code: "invalid_body", message: "secrets must be a JSON object of field → value" };
  }
  const known = new Map(spec.fields.map((field) => [field.field, field]));
  const writes: Array<{ field: string; value: string; required: boolean }> = [];
  for (const [field, raw] of Object.entries(input)) {
    const meta = known.get(field);
    if (meta === undefined) {
      return {
        ok: false,
        code: "invalid_body",
        message: `unknown secret field "${field}" (expected: ${[...known.keys()].join(", ")})`,
      };
    }
    if (typeof raw !== "string") {
      return { ok: false, code: "invalid_body", message: `secret field "${field}" must be a string` };
    }
    const value = raw.trim();
    if (value.length === 0 && meta.required) {
      return {
        ok: false,
        code: "invalid_body",
        message: `secret field "${field}" is required and cannot be cleared`,
      };
    }
    writes.push({ field, value, required: meta.required });
  }
  if (writes.length === 0) {
    return { ok: false, code: "invalid_body", message: "no secret fields were provided" };
  }
  for (const write of writes) {
    if (write.value.length === 0) {
      await secretStore.deleteSecret(spec.service, write.field);
    } else {
      await secretStore.setSecret(spec.service, write.field, write.value);
    }
  }
  return { ok: true, view: await readChannelSecrets(secretStore, spec) };
}
