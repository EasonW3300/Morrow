import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ConnectivityResult,
  type ProviderRecord,
} from "./api.ts";
import { describeConnectivity } from "./connectivity-ui.ts";
import {
  COMPAT_SWITCHES,
  emptyProviderForm,
  providerFormFromRecord,
  toCreatePayload,
  toUpdatePatch,
  validateProviderForm,
  type ProviderFormErrors,
  type ProviderFormValues,
} from "./provider-form.ts";

/**
 * Provider 管理页（票 T7 / Issue #8）：三元组增删改 + 连通性测试 + 设默认。
 *
 * 密钥安全（与 T5 不变量一致）：输入框 type=password 不回显；apiKey 只在表单内存里
 * 存活到保存成功，保存后立即丢弃表单态；列表只呈现 has_api_key 投影；文案不落密钥。
 * env 回退条目（provider_id === "env"）只读：来源是 MORROW_PROVIDER_* 环境变量，
 * 仅允许测试与设默认（CRUD 由 runtime 拒绝）。
 */
export function SettingsView({ base }: { base: string }) {
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormValues | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<ProviderFormErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** provider_id → 测试状态：testing / 结果 / 端点本身失败（区别于连通性四类结果） */
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api.listProviders(base);
      setProviders(res.providers);
      setDefaultId(res.default_provider_id);
      setListError(null);
    } catch (err) {
      setListError(readableError(err, "加载 Provider 列表失败"));
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyProviderForm());
    setFormErrors({});
    setSaveError(null);
  };

  const openEdit = (record: ProviderRecord) => {
    setEditingId(record.provider_id);
    setForm(providerFormFromRecord(record)); // 密钥不回填（服务端只有 has_api_key 投影）
    setFormErrors({});
    setSaveError(null);
  };

  const closeForm = () => {
    setForm(null); // 表单态（含内存中的 apiKey）立即丢弃
    setEditingId(null);
    setSaveError(null);
  };

  const save = async () => {
    if (form === null || saving) return;
    const errors = validateProviderForm(form, editingId === null ? "create" : "edit");
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (editingId === null) {
        await api.createProvider(base, toCreatePayload(form));
      } else {
        await api.updateProvider(base, editingId, toUpdatePatch(form));
      }
      closeForm();
      await reload();
    } catch (err) {
      setSaveError(readableError(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (record: ProviderRecord) => {
    if (!window.confirm(`删除 Provider「${record.name}」？元数据与已存密钥将一并清除。`)) return;
    setBusyId(record.provider_id);
    try {
      await api.deleteProvider(base, record.provider_id);
      await reload();
    } catch (err) {
      setListError(readableError(err, "删除失败"));
    } finally {
      setBusyId(null);
    }
  };

  const makeDefault = async (record: ProviderRecord) => {
    setBusyId(record.provider_id);
    try {
      await api.setDefaultProvider(base, record.provider_id);
      await reload();
    } catch (err) {
      setListError(readableError(err, "设为默认失败"));
    } finally {
      setBusyId(null);
    }
  };

  const runTest = async (record: ProviderRecord) => {
    if (tests[record.provider_id]?.state === "testing") return;
    setTests((prev) => ({ ...prev, [record.provider_id]: { state: "testing" } }));
    try {
      const result = await api.testProvider(base, record.provider_id);
      setTests((prev) => ({ ...prev, [record.provider_id]: { state: "done", result } }));
    } catch (err) {
      // 测试端点本身失败（连不上 Runtime 等），与连通性四类结果分开呈现
      setTests((prev) => ({ ...prev, [record.provider_id]: { state: "failed", message: readableError(err, "测试请求失败") } }));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Provider 与模型</h2>
        <button className="btn primary" onClick={openCreate} disabled={form !== null}>
          新增 Provider
        </button>
      </div>
      <p className="page-hint">
        一个 Provider = Base URL + API Key + 模型名（OpenAI Chat Completions 兼容）。密钥保存后只进系统凭据库，不再回显。
      </p>
      {listError !== null && <div className="banner-error">{listError}</div>}

      {providers.length === 0 && listError === null && (
        <div className="empty-note">还没有 Provider。点右上角「新增 Provider」配置第一个模型接入点。</div>
      )}

      <ul className="provider-list">
        {providers.map((record) => {
          const isEnv = record.provider_id === "env";
          const test = tests[record.provider_id];
          return (
            <li key={record.provider_id} className={`provider-row${record.provider_id === defaultId ? " default" : ""}`}>
              <div className="provider-main">
                <div className="provider-title">
                  <strong>{record.name}</strong>
                  {record.provider_id === defaultId && <span className="badge badge-default">默认</span>}
                  {isEnv && <span className="badge">环境变量回退</span>}
                  <span className="badge">{record.has_api_key ? "密钥已存" : "免密"}</span>
                </div>
                <div className="provider-meta">
                  <span className="mono">{record.base_url}</span>
                  <span>模型 {record.model}</span>
                  <span className="compat-tags">{compatLabel(record)}</span>
                </div>
                <div className="provider-actions">
                  <button className="btn" onClick={() => void runTest(record)} disabled={test?.state === "testing"}>
                    {test?.state === "testing" ? "测试中…" : "测试连通"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => void makeDefault(record)}
                    disabled={busyId === record.provider_id || record.provider_id === defaultId}
                  >
                    设为默认
                  </button>
                  {!isEnv && (
                    <>
                      <button className="btn" onClick={() => openEdit(record)}>编辑</button>
                      <button
                        className="btn danger"
                        onClick={() => void remove(record)}
                        disabled={busyId === record.provider_id}
                      >
                        删除
                      </button>
                    </>
                  )}
                  {isEnv && <span className="hint-inline">只读条目：由 MORROW_PROVIDER_* 环境变量提供</span>}
                </div>
              </div>
              {test !== undefined && <TestBlock state={test} />}
            </li>
          );
        })}
      </ul>

      {form !== null && (
        <div className="form-card" role="dialog" aria-label={editingId === null ? "新增 Provider" : "编辑 Provider"}>
          <h3>{editingId === null ? "新增 Provider" : "编辑 Provider"}</h3>
          {saveError !== null && <div className="banner-error">{saveError}</div>}
          <div className="form-grid">
            <Field label="显示名" error={formErrors.name}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：云端主力 / 本地 vLLM"
                autoFocus
              />
            </Field>
            <Field label="Base URL" error={formErrors.baseUrl}>
              <input
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
              />
            </Field>
            <Field label="模型名" error={formErrors.model}>
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="例如：gpt-4o-mini / qwen2.5-7b"
                spellCheck={false}
              />
            </Field>
            <Field
              label="API Key"
              error={undefined}
              hint={editingId === null ? "留空 = 免密端点（本地 vLLM/Ollama）；保存后不回显" : "留空 = 保持现有密钥不变"}
            >
              <input
                type="password"
                autoComplete="new-password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder="••••••••"
              />
            </Field>
          </div>
          <fieldset className="compat-group">
            <legend>兼容开关（不确定就保持关闭）</legend>
            {COMPAT_SWITCHES.map((sw) => (
              <label key={sw.key} className="compat-switch" title={sw.hint}>
                <input
                  type="checkbox"
                  checked={form.compat[sw.key]}
                  onChange={(e) => setForm({ ...form, compat: { ...form.compat, [sw.key]: e.target.checked } })}
                />
                {sw.label}
              </label>
            ))}
          </fieldset>
          <div className="form-grid small">
            <Field label="上下文窗口" error={formErrors.contextWindow} hint="留空 = 131072">
              <input
                inputMode="numeric"
                value={form.contextWindow}
                onChange={(e) => setForm({ ...form, contextWindow: e.target.value })}
                placeholder="131072"
              />
            </Field>
            <Field label="单次生成上限" error={formErrors.maxTokens} hint="留空 = 8192">
              <input
                inputMode="numeric"
                value={form.maxTokens}
                onChange={(e) => setForm({ ...form, maxTokens: e.target.value })}
                placeholder="8192"
              />
            </Field>
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
            <button className="btn" onClick={closeForm} disabled={saving}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type TestState =
  | { state: "testing" }
  | { state: "done"; result: ConnectivityResult }
  | { state: "failed"; message: string };

/** 连通性结果块：四类归类呈现（tone 颜色档 + 解释 + 下一步建议） */
function TestBlock({ state }: { state: TestState }) {
  if (state.state === "testing") {
    return <div className="test-block">正在向端点发送最小测试请求（≤10s）…</div>;
  }
  if (state.state === "failed") {
    return (
      <div className="test-block tone-error">
        <strong>测试请求失败</strong>
        <p>{state.message}</p>
      </div>
    );
  }
  const out = describeConnectivity(state.result);
  return (
    <div className={`test-block tone-${out.tone}`}>
      <strong>{out.title}</strong>
      <p>{out.explanation}</p>
      <p className="test-advice">下一步：{out.advice}</p>
    </div>
  );
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error !== undefined ? <span className="field-error">{error}</span> : hint !== undefined ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function compatLabel(record: ProviderRecord): string {
  const enabled = COMPAT_SWITCHES.filter((sw) => record.compat[sw.key] === true).map((sw) => sw.label);
  return enabled.length > 0 ? `兼容：${enabled.join(" / ")}` : "兼容：默认";
}

/** API 错误 → Owner 可读；网络层（连不上 Runtime）与 Runtime 拒绝分开说清（票 T7 可诊断性） */
function readableError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "network_error") {
      return `${fallback}：${err.message}`;
    }
    const label = apiCodeLabel(err.code);
    return `${fallback}：${label}（${err.code}）—— ${err.message}`;
  }
  return `${fallback}：${err instanceof Error ? err.message : String(err)}`;
}

function apiCodeLabel(code: string): string {
  switch (code) {
    case "provider_invalid_input":
      return "配置不合法";
    case "provider_conflict":
      return "Provider 已存在";
    case "provider_not_found":
      return "Provider 不存在";
    case "invalid_body":
      return "请求体非法";
    case "http_404":
      return "接口不存在（Runtime 版本不匹配？）";
    case "http_405":
      return "接口方法不允许";
    default:
      return "请求失败";
  }
}
