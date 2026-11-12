import { useCallback, useEffect, useReducer, useState } from "react";
import {
  api,
  ApiError,
  type ConnectivityResult,
  type ProviderRecord,
  type SessionSummary,
} from "./api.ts";
import { PERSONA_LIMITS } from "@morrow/protocol/browser";
import { describeConnectivity } from "./connectivity-ui.ts";
import { describeRestoreWindow } from "./session-ui.ts";
import {
  COMPAT_SWITCHES,
  emptyProviderForm,
  providerFormFromRecord,
  toCreatePayload,
  validateProviderForm,
  type ProviderFormErrors,
  type ProviderFormValues,
} from "./provider-form.ts";
import {
  describePersonaImpact,
  initialPersonaSaveState,
  personaSaveReducer,
  personaToForm,
  type PersonaFormValues,
} from "./persona-ui.ts";
import { CapabilitiesView } from "./CapabilitiesView.tsx";
import { ChannelsView } from "./ChannelsView.tsx";
import { DevicesView } from "./DevicesView.tsx";
import { useConfirm } from "./design-system/ConfirmDialog.tsx";

/**
 * 设置页（PRD §5.1 设置区）：子页签——「Provider 与模型」（票 T7 / Issue #8）、
 * 「Persona」（M7-A-T1 / Issue #58）、「能力管理」（票 M2-T6 / Issue #27）、
 * 「设备与同步」（票 M3-T6 / Issue #35）、「渠道」（票 M4-T8 / Issue #45）与
 * 「会话管理」（M7-A-T2 / Issue #59：归档/软删恢复）。
 * 能力管理页签可由 Task 视图的能力引用卡跳入（initialCapabilityName 预选详情）。
 */
export function SettingsView({
  base,
  initialCapabilityName = null,
}: {
  base: string;
  initialCapabilityName?: string | null;
}) {
  const [section, setSection] = useState<
    "providers" | "persona" | "capabilities" | "devices" | "channels" | "sessions"
  >(
    initialCapabilityName !== null ? "capabilities" : "providers",
  );

  // 引用卡跳转在页已挂载后到达时，同样切到能力管理
  useEffect(() => {
    if (initialCapabilityName !== null) setSection("capabilities");
  }, [initialCapabilityName]);

  return (
    <div className="page settings-page">
      <div className="settings-subnav">
        {(
          [
            ["providers", "Provider 与模型"],
            ["persona", "Persona"],
            ["capabilities", "能力管理"],
            ["devices", "设备与同步"],
            ["channels", "渠道"],
            ["sessions", "会话管理"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={section === key ? "subnav-item selected" : "subnav-item"}
            onClick={() => setSection(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {section === "providers" && <ProvidersSection base={base} />}
      {section === "persona" && <PersonaSection base={base} />}
      {section === "capabilities" && (
        <CapabilitiesView base={base} initialCapabilityName={initialCapabilityName} />
      )}
      {section === "devices" && <DevicesView base={base} />}
      {section === "channels" && <ChannelsView base={base} />}
      {section === "sessions" && <SessionManagementSection base={base} />}
    </div>
  );
}

/**
 * Persona 页（票 M7-A-T1 / Issue #58，FR-A1/A4/A5）：结构化四字段 + 其他自由文本。
 * 保存前读取会话总数并弹确认（列出受影响会话数与三类后果）；取消不写入。
 */
function PersonaSection({ base }: { base: string }) {
  const [form, setForm] = useState<PersonaFormValues>(() => personaToForm());
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, dispatch] = useReducer(personaSaveReducer, initialPersonaSaveState);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const persona = await api.getPersona(base);
        if (cancelled) return;
        setForm(personaToForm(persona));
        setLoadState("ready");
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadState("error");
        setLoadError(readableError(err, "加载 Persona 失败"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  /** 点「保存」：先取受影响会话数（GET /v1/sessions 计数），再交给状态机校验/确认。 */
  const startSave = async () => {
    if (saveState.status === "saving" || saveState.status === "confirming") return;
    try {
      const sessions = await api.listSessions(base);
      dispatch({ type: "submit", values: form, sessionCount: sessions.length });
    } catch (err) {
      setLoadError(readableError(err, "读取受影响会话数失败"));
    }
  };

  const confirmSave = async () => {
    if (saveState.status !== "confirming") return;
    const persona = saveState.persona;
    dispatch({ type: "confirm" });
    try {
      const updated = await api.updatePersona(base, persona);
      setForm(personaToForm(updated));
      dispatch({ type: "saved", persona: updated });
    } catch (err) {
      dispatch({ type: "failed", message: readableError(err, "保存 Persona 失败") });
    }
  };

  const errors = saveState.status === "idle" ? saveState.errors : {};
  const confirming = saveState.status === "confirming" || saveState.status === "saving";

  return (
    <div className="settings-section">
      <div className="page-head">
        <h2>Persona</h2>
        <button
          className="btn primary"
          onClick={() => void startSave()}
          disabled={loadState !== "ready" || saveState.status === "saving" || saveState.status === "confirming"}
        >
          保存
        </button>
      </div>
      <p className="page-hint">
        全局人设：同时注入每个会话的 system prompt 与记忆抽取器（不注入任务规划器）。
        拼装顺序固定为 名字 → 语气 → 职责 → 禁止行为 → 其他，不可调整。
      </p>
      {loadError !== null && <div className="banner-error">{loadError}</div>}
      {saveState.status === "saved" && (
        <div className="banner-note">
          已保存。新建会话将使用新 Persona；进行中的会话保持原人设与上下文。
          <button className="btn" onClick={() => dispatch({ type: "reset" })}>
            知道了
          </button>
        </div>
      )}
      {saveState.status === "error" && (
        <div className="banner-error">
          {saveState.message}
          <button className="btn" onClick={() => dispatch({ type: "reset" })}>
            关闭
          </button>
        </div>
      )}

      {loadState === "loading" && <div className="empty-note">正在加载 Persona…</div>}

      {loadState === "ready" && (
        <div className="form-card">
          <div className="form-grid">
            <Field label="名字" error={errors.name} hint={`默认 Morrow；最多 ${PERSONA_LIMITS.name} 字符`}>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：Morrow"
                autoFocus
              />
            </Field>
            <Field label="语气" error={errors.tone} hint="默认「简洁直接」">
              <input
                value={form.tone}
                onChange={(e) => setForm({ ...form, tone: e.target.value })}
                placeholder="例如：简洁直接"
              />
            </Field>
          </div>
          <Field
            label="职责"
            error={errors.responsibilities}
            hint="每行一条；默认「个人助理与开发助手」"
          >
            <textarea
              rows={4}
              value={form.responsibilities}
              onChange={(e) => setForm({ ...form, responsibilities: e.target.value })}
              placeholder={"个人助理\n开发助手"}
            />
          </Field>
          <Field label="禁止行为" error={errors.prohibitions} hint="每行一条；默认空">
            <textarea
              rows={3}
              value={form.prohibitions}
              onChange={(e) => setForm({ ...form, prohibitions: e.target.value })}
              placeholder="例如：不要编造事实"
            />
          </Field>
          <Field label="其他设定" error={errors.extra} hint={`自由补充；最多 ${PERSONA_LIMITS.extra} 字符；默认空`}>
            <textarea
              rows={4}
              value={form.extra}
              onChange={(e) => setForm({ ...form, extra: e.target.value })}
              placeholder="例如：回答先给结论，再展开细节。"
            />
          </Field>
        </div>
      )}

      {confirming && (() => {
        const notice = describePersonaImpact(
          saveState.status === "confirming" || saveState.status === "saving" ? saveState.sessionCount : 0,
        );
        const saving = saveState.status === "saving";
        return (
          <div className="form-card" role="dialog" aria-label={notice.title}>
            <h3>{notice.title}</h3>
            <ul className="page-hint">
              {notice.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="page-hint">取消将不会写入任何变更。</p>
            <div className="form-actions">
              <button className="btn primary" onClick={() => void confirmSave()} disabled={saving}>
                {saving ? "保存中…" : notice.confirmLabel}
              </button>
              <button className="btn" onClick={() => dispatch({ type: "cancel" })} disabled={saving}>
                取消
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/**
 * 会话管理（M7-A-T2 / Issue #59）：列出归档与已删除（30 天内）会话；
 * 归档可取消归档，已删除可恢复。删除不影响记忆，过期删除由服务端折叠剔除。
 */
function SessionManagementSection({ base }: { base: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await api.listSessions(base, "all");
      setSessions(all.filter((session) => session.archived_at !== undefined || session.deleted_at !== undefined));
      setListError(null);
    } catch (err) {
      setListError(readableError(err, "加载会话列表失败"));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (sessionId: string, action: "restore" | "unarchive"): Promise<void> => {
    setBusyId(sessionId);
    try {
      if (action === "restore") await api.restoreSession(base, sessionId);
      else await api.unarchiveSession(base, sessionId);
      await load();
    } catch (err) {
      setListError(readableError(err, action === "restore" ? "恢复失败" : "取消归档失败"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="settings-section">
      <div className="page-head">
        <h2>会话管理</h2>
        <button className="btn" onClick={() => void load()} disabled={busyId !== null}>
          刷新
        </button>
      </div>
      <p className="page-hint">
        归档与已删除的会话。软删后 30 天内可恢复；删除只影响会话列表，记忆不受影响。
      </p>
      {listError !== null && <div className="banner-error">{listError}</div>}
      {sessions.length === 0 && listError === null && (
        <div className="empty-note">没有归档或已删除的会话。</div>
      )}
      <ul className="managed-sessions">
        {sessions.map((session) => {
          const deleted = session.deleted_at !== undefined;
          const title = session.title ?? `会话 ${session.session_id.slice(0, 8)}`;
          return (
            <li key={session.session_id} className="managed-session-row">
              <div className="managed-session-main">
                <strong>{title}</strong>
                <div className="managed-session-meta">
                  {deleted ? (
                    <>
                      <span className="badge">已删除</span>
                      <span>{session.deleted_at === undefined ? "" : describeRestoreWindow(session.deleted_at)}</span>
                    </>
                  ) : (
                    <>
                      <span className="badge">已归档</span>
                      <span>{session.archived_at === undefined ? "" : shortDate(session.archived_at)}</span>
                    </>
                  )}
                </div>
              </div>
              <button
                className="btn"
                disabled={busyId === session.session_id}
                onClick={() => void mutate(session.session_id, deleted ? "restore" : "unarchive")}
              >
                {busyId === session.session_id ? "处理中…" : deleted ? "恢复" : "取消归档"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ProvidersSection({ base }: { base: string }) {
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
  const [confirm, confirmDialog] = useConfirm();

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
    const errors = validateProviderForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (editingId === null) {
        await api.createProvider(base, toCreatePayload(form));
      } else {
        // PATCH 语义：toCreatePayload 里留空的 apiKey 不进 payload（= 不轮换），其余全量提交
        await api.updateProvider(base, editingId, toCreatePayload(form));
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
    const ok = await confirm({
      title: "删除 Provider",
      message: `删除 Provider「${record.name}」？元数据与已存密钥将一并清除。`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
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
    <div className="settings-section">
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
                  {/* 已是默认时不再渲染一个灰掉且无说明的按钮（v0.1.1 修）：
                      旧实现 disabled 但不给原因，看起来像"功能坏了"。改为静态标识。 */}
                  {record.provider_id === defaultId ? (
                    <span className="provider-default-flag" title="该 Provider 已是默认，新会话会使用它">
                      已是默认
                    </span>
                  ) : (
                    <button
                      className="btn"
                      onClick={() => void makeDefault(record)}
                      disabled={busyId === record.provider_id}
                      title="新会话将使用该 Provider"
                    >
                      设为默认
                    </button>
                  )}
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
      {confirmDialog}
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
