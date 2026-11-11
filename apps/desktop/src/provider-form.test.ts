/**
 * Provider 表单校验（票 T7 / Issue #8 验收核心）。
 *
 * 三元组（base_url + api_key + 模型名，GLOSSARY: Provider）+ compat 开关 + 窗口参数。
 * 校验规则与 runtime ProviderRegistry 一致（apps/runtime/src/providers.ts），
 * 客户端先挡一层，服务端 400 provider_invalid_input 仍是权威。
 * 两个模式：create（api_key 可空——vLLM/Ollama 免密端点）与 edit（空 key = 不轮换）。
 * 纯函数，无 DOM 依赖 —— node:test 直接跑（--experimental-strip-types）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyProviderForm, providerFormFromRecord, toCreatePayload, validateProviderForm } from "./provider-form.ts";

test("合法三元组通过：create 模式 api_key 可空（免密本地端点）", () => {
  const errors = validateProviderForm({
    ...emptyProviderForm(),
    name: "本地 vLLM",
    baseUrl: "http://127.0.0.1:8000",
    model: "qwen2.5-7b",
  });
  assert.deepEqual(errors, {});
});

test("name / base_url / model 缺失各自报错，互不掩盖", () => {
  const errors = validateProviderForm({ ...emptyProviderForm(), name: "  ", baseUrl: "", model: "" });
  assert.ok(errors.name !== undefined);
  assert.ok(errors.baseUrl !== undefined);
  assert.ok(errors.model !== undefined);
  assert.equal(Object.keys(errors).length, 3);
});

test("base_url 必须是 http(s) URL：拒绝非协议与 ftp", () => {
  for (const bad of ["not-a-url", "ftp://x.example", "localhost:8000"]) {
    const errors = validateProviderForm({
      ...emptyProviderForm(),
      name: "n",
      baseUrl: bad,
      model: "m",
    });
    assert.ok(errors.baseUrl !== undefined, `${bad} 应报错`);
  }
});

test("context_window / max_tokens 留空合法，填了必须是正整数", () => {
  const ok = validateProviderForm({ ...emptyProviderForm(), name: "n", baseUrl: "http://a.b", model: "m" });
  assert.deepEqual(ok, {});
  const bad = validateProviderForm({
    ...emptyProviderForm(),
    name: "n",
    baseUrl: "http://a.b",
    model: "m",
    contextWindow: "abc",
    maxTokens: "-1",
  });
  assert.ok(bad.contextWindow !== undefined);
  assert.ok(bad.maxTokens !== undefined);
});

test("edit 模式：api_key 留空 = 不轮换，合法；非空也合法（轮换）", () => {
  const base = { name: "n", baseUrl: "http://a.b", model: "m" };
  assert.deepEqual(validateProviderForm({ ...emptyProviderForm(), ...base, apiKey: "" }), {});
  assert.deepEqual(validateProviderForm({ ...emptyProviderForm(), ...base, apiKey: "sk-new" }), {});
});

test("toCreatePayload：空 api_key 不发送字段（免密端点语义），非空才带", () => {
  const form = { ...emptyProviderForm(), name: "n", baseUrl: "http://a.b/", model: "m", apiKey: "" };
  const payload = toCreatePayload(form);
  assert.equal("api_key" in payload, false, "空 key 不应出现在 payload");
  const keyed = toCreatePayload({ ...form, apiKey: "sk-x", contextWindow: "4096", maxTokens: "1024" });
  assert.equal(keyed.api_key, "sk-x");
  assert.equal(keyed.context_window, 4096);
  assert.equal(keyed.max_tokens, 1024);
});

test("toCreatePayload 即编辑 patch（原 toUpdatePatch 纯转发已删）：api_key 仅在非空时轮换", () => {
  const form = { ...emptyProviderForm(), name: "n", baseUrl: "http://a.b", model: "m", apiKey: "" };
  const patch = toCreatePayload(form);
  assert.equal("api_key" in patch, false, "空 key 编辑不应触发轮换");
  const rotated = toCreatePayload({ ...form, apiKey: "sk-new" });
  assert.equal(rotated.api_key, "sk-new");
});

test("providerFormFromRecord → toCreatePayload 往返：api_key 不回填明文（has_api_key 投影之外没有密钥）", () => {
  const form = providerFormFromRecord({
    provider_id: "p1",
    name: "云上",
    base_url: "https://api.example.com/v1",
    model: "gpt-x",
    compat: { supportsDeveloperRole: true },
    context_window: 8192,
    max_tokens: 2048,
    created_at: "2026-01-01T00:00:00Z",
    has_api_key: true,
    is_default: true,
  });
  assert.equal(form.apiKey, "", "编辑表单不得持有/回显已保存的密钥");
  assert.equal(form.contextWindow, "8192");
  const patch = toCreatePayload(form); // 编辑保存直用同一 payload 构造器
  assert.equal("api_key" in patch, false);
  assert.equal(patch.compat.supportsDeveloperRole, true);
});
