import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type CapabilityDetail,
  type CapabilityRecord,
  type FactoryRequest,
  type PermissionGrant,
  type SkillProposal,
  type SkillSummary,
} from "./api.ts";
import {
  beginConfirm,
  cancelConfirm,
  completeConfirm,
  confirmGate,
  describeGrantsDiff,
  describePermissionRows,
  describeProposal,
  describeVerification,
  factoryStageIndex,
  factoryStageLabel,
  factoryStageOf,
  FACTORY_STAGE_ORDER,
  grantsDiffSummary,
  grantsFormFromGrant,
  parseGrantsForm,
  validateGrantsForm,
  type ConfirmAction,
  type ConfirmGateState,
  type GrantsFormErrors,
  type GrantsFormValues,
} from "./capability-ui.ts";
import { CAPABILITY_CHANNELS, SHELL_COMMAND_CATEGORIES } from "@morrow/protocol/browser";

/**
 * 能力管理页（票 M2-T6 / Issue #27，PRD §5.1 设置→能力管理）：四个子面板——
 *
 *   能力清单  name/version/author(human|ai)/runtime(ts|go)/status(enabled|disabled) 徽标 +
 *            详情（manifest 五维权限、input/output schema、tests 清单、版本历史时间线、
 *            source_hash）+ enable/disable/rollback（破坏性操作确认门：disable 已启用
 *            能力与 rollback 需二次确认——capability-ui 的确认门状态机）
 *   预授权    五维 grant 查看 + 编辑（filesystem/network/credentials 多行文本、shell/channels
 *            勾选）；保存走 PUT /v1/capabilities/grants，保存区呈现 diff + 审计提示
 *            （收窄立即约束已注册能力的运行时复核）
 *   工厂      真实工厂链路（T3 已合入）：提交需求描述 → 进度轮询（检索→规划→构建→验证→
 *            待确认，真实 status×stage 双轴投影）→ 验证报告（真实 VerifyReport 逐用例
 *            归组）→ 确认注册（POST /v1/capabilities/:id/confirm）；检索命中既有
 *            能力/Skill 时呈现重用路径（FR-CAP-1）
 *   Skill     真实 Skill 链路（T5 已合入）：清单（组合了哪些 capability）+ 提案批准/
 *            拒绝（悬空引用提案被拒有呈现）
 */
export function CapabilitiesView({
  base,
  initialCapabilityName,
}: {
  base: string;
  /** Task 视图能力引用卡跳转带过来的预选能力（App state 传递，路由从简） */
  initialCapabilityName: string | null;
}) {
  const [section, setSection] = useState<"registry" | "grants" | "factory" | "skills">("registry");
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // 引用卡跳转：Task 视图点能力芯片 → 切到清单页签并打开该能力详情
  useEffect(() => {
    if (initialCapabilityName !== null) {
      setSection("registry");
      setSelectedName(initialCapabilityName);
    }
  }, [initialCapabilityName]);

  return (
    <div className="settings-section">
      <div className="settings-subnav">
        {(
          [
            ["registry", "能力清单"],
            ["grants", "预授权"],
            ["factory", "工厂"],
            ["skills", "Skill"],
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
      {section === "registry" && (
        <CapabilityRegistryPanel base={base} selectedName={selectedName} onSelect={setSelectedName} />
      )}
      {section === "grants" && <GrantsPanel base={base} />}
      {section === "factory" && (
        <FactoryPanel
          base={base}
          onRegistered={() => {
            setSection("registry");
          }}
        />
      )}
      {section === "skills" && <SkillsPanel base={base} />}
    </div>
  );
}

// --- 能力清单 + 详情 ------------------------------------------------------------

function CapabilityRegistryPanel({
  base,
  selectedName,
  onSelect,
}: {
  base: string;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
}) {
  const [records, setRecords] = useState<CapabilityRecord[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  /** 确认门：key = `${name}:${kind}:${targetVersion ?? ""}`（rollback 按目标版本各自成门） */
  const [gates, setGates] = useState<Record<string, ConfirmGateState>>({});
  /** 详情缓存：name → detail（选中即拉取；操作后失效重拉） */
  const [details, setDetails] = useState<Record<string, CapabilityDetail>>({});
  const [detailError, setDetailError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRecords(await api.listCapabilities(base));
      setListError(null);
    } catch (err) {
      setListError(readableError(err, "加载能力清单失败"));
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadDetail = useCallback(
    async (name: string) => {
      try {
        const detail = await api.getCapability(base, name);
        setDetails((prev) => ({ ...prev, [name]: detail }));
        setDetailError(null);
      } catch (err) {
        setDetailError(readableError(err, `加载「${name}」详情失败`));
      }
    },
    [base],
  );

  useEffect(() => {
    if (selectedName !== null && details[selectedName] === undefined) void loadDetail(selectedName);
  }, [selectedName, details, loadDetail]);

  const run = useCallback(
    async (name: string, action: () => Promise<unknown>) => {
      setBusyName(name);
      try {
        await action();
        await reload();
        setDetails((prev) => {
          const next = { ...prev };
          delete next[name]; // 详情含当前记录，失效重拉
          return next;
        });
        if (selectedName !== null) void loadDetail(selectedName);
      } catch (err) {
        setListError(readableError(err, "操作失败"));
      } finally {
        setBusyName(null);
      }
    },
    [base, reload, loadDetail, selectedName],
  );

  const gateKey = (action: ConfirmAction): string =>
    `${action.name}:${action.kind}:${action.kind === "rollback" ? action.targetVersion : ""}`;

  const start = (action: ConfirmAction): void => {
    setGates((prev) => ({ ...prev, [gateKey(action)]: beginConfirm(action) }));
  };
  const setGate = (key: string, state: ConfirmGateState): void => {
    setGates((prev) => ({ ...prev, [key]: state }));
  };
  const clearGate = (key: string): void => setGates((prev) => ({ ...prev, [key]: cancelConfirm({ phase: "idle" }) }));

  const execute = (action: ConfirmAction, key: string): void => {
    const executing = confirmGate(gates[key] ?? { phase: "idle" });
    if (executing.phase !== "executing") return;
    setGate(key, executing);
    const name = action.name;
    void run(name, async () => {
      if (action.kind === "enable") await api.setCapabilityStatus(base, name, "enable");
      else if (action.kind === "disable") await api.setCapabilityStatus(base, name, "disable");
      else await api.rollbackCapability(base, name, action.targetVersion);
    }).finally(() => clearGate(key));
  };

  return (
    <>
      <div className="page-head">
        <h2>能力管理</h2>
        <button className="btn" onClick={() => void reload()} disabled={busyName !== null}>
          刷新
        </button>
      </div>
      <p className="page-hint">
        注册表 = 可被 Agent 调用的全部能力（builtin + 工厂生成）。启停立即生效：停用后运行时调用被拒绝；
        回滚把执行指回历史版本。作者 human 为内置件，ai 为工厂生成（默认停用、必须带沙箱）。
      </p>
      {listError !== null && <div className="banner-error">{listError}</div>}
      {detailError !== null && <div className="banner-error">{detailError}</div>}

      <ul className="capability-list">
        {records.map((record) => {
          const disableKey = gateKey({ kind: "disable", name: record.name, currentStatus: record.status });
          const disableGate = gates[disableKey] ?? { phase: "idle" as const };
          return (
            <li key={record.name} className="capability-row">
              <button className="capability-title" onClick={() => onSelect(record.name)}>
                <strong>{record.name}</strong>
                <span className="mono">v{record.version}</span>
              </button>
              <span className={`badge badge-author-${record.author}`}>{record.author}</span>
              <span className="badge badge-runtime">{record.runtime}</span>
              <span className={`badge tone-${record.status === "enabled" ? "ok" : "dim"}`}>
                {record.status === "enabled" ? "已启用" : "已停用"}
              </span>
              <span className="capability-actions">
                {record.status === "enabled" ? (
                  disableGate.phase === "armed" ? (
                    <ConfirmGateInline
                      state={disableGate}
                      confirmLabel="确认停用"
                      onConfirm={() => execute({ kind: "disable", name: record.name, currentStatus: record.status }, disableKey)}
                      onCancel={() => clearGate(disableKey)}
                    />
                  ) : (
                    <button
                      className="btn danger"
                      disabled={busyName === record.name}
                      onClick={() => start({ kind: "disable", name: record.name, currentStatus: record.status })}
                    >
                      停用
                    </button>
                  )
                ) : (
                  <button
                    className="btn primary"
                    disabled={busyName === record.name}
                    onClick={() => execute({ kind: "enable", name: record.name }, gateKey({ kind: "enable", name: record.name }))}
                  >
                    启用
                  </button>
                )}
              </span>
            </li>
          );
        })}
        {records.length === 0 && listError === null && <li className="empty-note">注册表为空。</li>}
      </ul>

      {selectedName !== null && (
        <CapabilityDetailCard
          name={selectedName}
          detail={details[selectedName] ?? null}
          gates={gates}
          busy={busyName === selectedName}
          onStart={start}
          onExecute={execute}
          onClearGate={clearGate}
          onClose={() => onSelect(null)}
        />
      )}
    </>
  );
}

function ConfirmGateInline({
  state,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  state: ConfirmGateState;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (state.phase === "armed") {
    return (
      <span className="confirm-gate">
        <span className="confirm-reason">{state.reason}</span>
        <button className="btn danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </span>
    );
  }
  return <span className="hint-inline">执行中…</span>;
}

function CapabilityDetailCard({
  name,
  detail,
  gates,
  busy,
  onStart,
  onExecute,
  onClearGate,
  onClose,
}: {
  name: string;
  detail: CapabilityDetail | null;
  gates: Record<string, ConfirmGateState>;
  busy: boolean;
  onStart: (action: ConfirmAction) => void;
  onExecute: (action: ConfirmAction, key: string) => void;
  onClearGate: (key: string) => void;
  onClose: () => void;
}) {
  if (detail === null) {
    return (
      <div className="form-card">
        <div className="detail-head">
          <h3>{name}</h3>
          <button className="btn" onClick={onClose}>
            收起
          </button>
        </div>
        <p className="empty-note">正在读取详情…</p>
      </div>
    );
  }
  const { record, versions } = detail;
  const manifest = record.manifest;
  const currentVersionKey = (version: string): string => `${name}:rollback:${version}`;
  return (
    <div className="form-card capability-detail">
      <div className="detail-head">
        <h3>
          {record.name} <span className="mono">v{record.version}</span>
        </h3>
        <button className="btn" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="detail-badges">
        <span className={`badge badge-author-${record.author}`}>作者 {record.author}</span>
        <span className="badge badge-runtime">运行时 {record.runtime}</span>
        <span className={`badge tone-${record.status === "enabled" ? "ok" : "dim"}`}>
          {record.status === "enabled" ? "已启用" : "已停用"}
        </span>
      </div>

      <h4>五维权限声明（manifest）</h4>
      <div className="dimension-grid">
        {describePermissionRows(manifest.permissions).map((row) => (
          <div key={row.dimension} className={`dimension-card${row.empty ? " dimension-empty" : ""}`}>
            <div className="dimension-head">
              <strong>{row.label}</strong>
              {row.empty && <span className="badge tone-dim">空（无声明）</span>}
            </div>
            <p className="dimension-hint">{row.hint}</p>
            {row.items.map((item) => (
              <code key={item} className="dimension-item">
                {item}
              </code>
            ))}
          </div>
        ))}
      </div>

      <h4>沙箱与测试</h4>
      <p className="mono sandbox-line">
        sandbox: type={manifest.sandbox.type} / network={manifest.sandbox.network} / filesystem={manifest.sandbox.filesystem}
      </p>
      {manifest.tests.length === 0 ? (
        <p className="empty-note">无测试用例（human builtin 允许为空；ai 生成能力必须非空）。</p>
      ) : (
        <ul className="tests-list">
          {manifest.tests.map((test) => (
            <li key={test} className="mono">
              {test}
            </li>
          ))}
        </ul>
      )}

      <h4>输入 / 输出 Schema</h4>
      <div className="schema-pair">
        <div>
          <p className="schema-label">input_schema</p>
          <pre className="mono">{JSON.stringify(manifest.input_schema, null, 2)}</pre>
        </div>
        <div>
          <p className="schema-label">output_schema</p>
          <pre className="mono">{JSON.stringify(manifest.output_schema, null, 2)}</pre>
        </div>
      </div>

      <h4>版本历史</h4>
      <p className="hint-inline">当前版本 v{record.version} · source_hash {record.source_hash}</p>
      <ol className="version-timeline">
        {versions.map((v) => {
          const key = currentVersionKey(v.version);
          const gate = gates[key] ?? { phase: "idle" as const };
          const isCurrent = v.version === record.version;
          return (
            <li key={v.version} className={`version-row${isCurrent ? " current" : ""}`}>
              <span className="version-dot" aria-hidden />
              <span className="mono">v{v.version}</span>
              <span className={`badge badge-author-${v.author}`}>{v.author}</span>
              <span className="mono version-hash" title={v.source_hash}>
                {v.source_hash.slice(0, 18)}…
              </span>
              <span className="version-time">{new Date(v.created_at).toLocaleString()}</span>
              {isCurrent ? (
                <span className="hint-inline">当前版本</span>
              ) : gate.phase === "armed" ? (
                <ConfirmGateInline
                  state={gate}
                  confirmLabel={`确认回滚到 v${v.version}`}
                  onConfirm={() => onExecute({ kind: "rollback", name, targetVersion: v.version }, key)}
                  onCancel={() => onClearGate(key)}
                />
              ) : (
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() => onStart({ kind: "rollback", name, targetVersion: v.version })}
                >
                  回滚到此版本
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="page-hint">rollback 需二次确认：回滚是修代码不是停用——状态保持不变，以旧版本继续运行。</p>
    </div>
  );
}

// --- 预授权面板 ------------------------------------------------------------------

function GrantsPanel({ base }: { base: string }) {
  const [current, setCurrent] = useState<PermissionGrant | null>(null);
  const [form, setForm] = useState<GrantsFormValues | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const grants = await api.getGrants(base);
      setCurrent(grants);
      setForm(grantsFormFromGrant(grants));
      setLoadError(null);
    } catch (err) {
      setLoadError(readableError(err, "加载授权面失败"));
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError !== null) {
    return (
      <>
        <div className="page-head">
          <h2>预授权（PermissionGrant）</h2>
        </div>
        <div className="banner-error">{loadError}</div>
      </>
    );
  }
  if (current === null || form === null) {
    return <p className="empty-note">正在读取授权面…</p>;
  }

  const errors: GrantsFormErrors = validateGrantsForm(form);
  const parsed = parseGrantsForm(form);
  const diffs = parsed !== null ? grantsDiffSummary(current, parsed) : [];
  const auditNote = parsed !== null ? describeGrantsDiff(diffs) : null;

  const save = async (): Promise<void> => {
    if (parsed === null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { grants } = await api.putGrants(base, parsed);
      setCurrent(grants);
      setForm(grantsFormFromGrant(grants));
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setSaveError(readableError(err, "保存授权面失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>预授权（PermissionGrant）</h2>
      </div>
      <p className="page-hint">
        Owner 的事先授权面：能力注册要求 manifest 五维权限 ⊆ 授权面；运行时对每次调用按
        「manifest 声明 + 当前授权面」双重复核——收窄立即生效，已注册能力不再被覆盖的调用会被拒绝。
      </p>
      {saveError !== null && <div className="banner-error">{saveError}</div>}
      {savedAt !== null && <div className="banner-ok">已保存（{savedAt}）——capability.grants_updated 审计事件已写入账本。</div>}

      <div className="form-card grants-editor">
        <div className="grants-grid">
          <label className="field">
            <span className="field-label">文件系统（路径 glob，一行一条）</span>
            <textarea
              rows={4}
              spellCheck={false}
              value={form.filesystem}
              onChange={(e) => setForm({ ...form, filesystem: e.target.value })}
              placeholder={"workspace/**\ndocs/*.md"}
            />
            {errors.filesystem !== undefined && <span className="field-error">{errors.filesystem}</span>}
          </label>
          <label className="field">
            <span className="field-label">网络（host:port，一行一条；port 可为 *）</span>
            <textarea
              rows={4}
              spellCheck={false}
              value={form.network}
              onChange={(e) => setForm({ ...form, network: e.target.value })}
              placeholder={"api.example.com:443\n*:8080"}
            />
            {errors.network !== undefined && <span className="field-error">{errors.network}</span>}
          </label>
          <label className="field">
            <span className="field-label">凭据 id（一行一条；精确匹配，不支持通配）</span>
            <textarea
              rows={3}
              spellCheck={false}
              value={form.credentials}
              onChange={(e) => setForm({ ...form, credentials: e.target.value })}
              placeholder={"github-token"}
            />
            {errors.credentials !== undefined && <span className="field-error">{errors.credentials}</span>}
          </label>
          <fieldset className="compat-group">
            <legend>Shell 命令类别（arbitrary = 全部类别，晶格顶）</legend>
            {SHELL_COMMAND_CATEGORIES.map((category) => (
              <label key={category} className="compat-switch">
                <input
                  type="checkbox"
                  checked={form.shell.includes(category)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      shell: e.target.checked
                        ? [...form.shell, category]
                        : form.shell.filter((c) => c !== category),
                    })
                  }
                />
                {category}
              </label>
            ))}
            {errors.shell !== undefined && <span className="field-error">{errors.shell}</span>}
          </fieldset>
          <fieldset className="compat-group">
            <legend>渠道</legend>
            {CAPABILITY_CHANNELS.map((channel) => (
              <label key={channel} className="compat-switch">
                <input
                  type="checkbox"
                  checked={form.channels.includes(channel)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      channels: e.target.checked
                        ? [...form.channels, channel]
                        : form.channels.filter((c) => c !== channel),
                    })
                  }
                />
                {channel}
              </label>
            ))}
            {errors.channels !== undefined && <span className="field-error">{errors.channels}</span>}
          </fieldset>
        </div>
        {auditNote !== null && (
          <div className={`audit-note${diffs.length > 0 ? " audit-dirty" : ""}`}>{auditNote}</div>
        )}
        <div className="form-actions">
          <button
            className="btn primary"
            disabled={saving || parsed === null || diffs.length === 0}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存授权面"}
          </button>
          <button className="btn" disabled={saving} onClick={() => setForm(grantsFormFromGrant(current))}>
            还原
          </button>
        </div>
      </div>
    </>
  );
}

// --- 工厂入口（真实链路；T3 已合入）------------------------------------------------

const FACTORY_POLL_MS = 1500;

/** 轮询终态（真实 status 轴）：proposed=等待 Owner 确认；reused=命中重用不新建 */
const FACTORY_SETTLED = new Set(["proposed", "confirmed", "failed", "reused"]);

function FactoryPanel({ base, onRegistered }: { base: string; onRegistered: () => void }) {
  const [requirement, setRequirement] = useState("");
  const [request, setRequest] = useState<FactoryRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const pollRef = useRef<number | null>(null);

  const stopPoll = (): void => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const poll = useCallback(
    (requestId: string) => {
      stopPoll();
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const next = await api.getCapabilityFactoryRequest(base, requestId);
            setRequest(next);
            if (FACTORY_SETTLED.has(next.status)) stopPoll();
          } catch (err) {
            setError(readableError(err, "进度轮询失败"));
            stopPoll();
          }
        })();
      }, FACTORY_POLL_MS);
    },
    [base],
  );

  useEffect(() => stopPoll, []);

  const submit = async (): Promise<void> => {
    if (requirement.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    setRequest(null);
    try {
      const created = await api.requestCapabilityFactory(base, requirement.trim());
      setRequest(created);
      poll(created.request_id);
    } catch (err) {
      setError(readableError(err, "提交能力生成需求失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (request === null || confirming) return;
    setConfirming(true);
    setError(null);
    try {
      const done = await api.confirmCapabilityFactory(base, request.request_id);
      setRequest(done);
      if (done.status === "confirmed") onRegistered();
    } catch (err) {
      setError(readableError(err, "确认注册失败"));
    } finally {
      setConfirming(false);
    }
  };

  const currentStage = request !== null ? factoryStageOf(request) : undefined;
  const currentIndex = currentStage !== undefined ? factoryStageIndex(currentStage) : -1;
  const verification =
    request !== null && (request.status === "proposed" || request.status === "confirmed")
      ? describeVerification(request.report)
      : null;

  return (
    <>
      <div className="page-head">
        <h2>Tool Factory（能力工厂）</h2>
      </div>
      <p className="page-hint">
        提交需求描述 → 工厂检索/规划/构建/验证 → 呈现验证报告 → Owner 确认注册。允许生成 ≠ 允许扩权：
        生成的 manifest 仍受预授权面约束（permissions ⊆ grants），越权在验证阶段即被阻断。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}

      <div className="form-card">
        <label className="field">
          <span className="field-label">需求描述</span>
          <textarea
            rows={3}
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="例如：需要一个把 markdown 表格转成 CSV 的能力，输入限制 1MB。"
          />
        </label>
        <div className="form-actions">
          <button className="btn primary" disabled={submitting || request?.status === "proposed"} onClick={() => void submit()}>
            {submitting ? "提交中…" : "提交需求"}
          </button>
        </div>
      </div>

      {request !== null && (
        <div className="form-card factory-progress">
          <h4>
            进度 <span className="mono">{request.request_id}</span>
          </h4>
          <div className="factory-steps">
            {FACTORY_STAGE_ORDER.map((stage, index) => {
              const state =
                currentStage === "failed" && index === 0
                  ? "failed"
                  : currentIndex > index
                    ? "done"
                    : currentIndex === index
                      ? currentStage === "failed"
                        ? "failed"
                        : "active"
                      : "todo";
              return (
                <span key={stage} className={`factory-step step-${state}`}>
                  {factoryStageLabel(stage)}
                </span>
              );
            })}
          </div>
          {request.status === "failed" && (
            <div className="banner-error">
              工厂失败（{request.error?.stage ?? "?"}/{request.error?.code ?? "unknown"}）：{request.error?.detail ?? "未知原因"}
              {request.error?.violations !== undefined && request.error.violations.length > 0 && (
                <ul className="verification-list">
                  {request.error.violations.map((v) => (
                    <li key={`${v.dimension}:${v.requested}`} className="tone-error">
                      <strong>{v.dimension}</strong>
                      <span className="verification-summary">{v.requested}——{v.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {request.status === "reused" && (
            <div className="banner-ok">
              检索命中既有能力/Skill，无需新建（重用路径）
              {request.reuse_matches !== undefined && request.reuse_matches.length > 0 && (
                <>：{request.reuse_matches.map((m) => m.name ?? m.source).join("、")}</>
              )}
            </div>
          )}

          {request.report !== undefined && verification !== null && (
            <>
              <h4>验证报告（四类测试）</h4>
              <ul className="verification-list">
                {verification.rows.map((row) => (
                  <li key={row.label} className={row.passed ? "tone-ok" : "tone-error"}>
                    <span className="verification-state">{row.passed ? "✓" : "✗"}</span>
                    <strong>{row.label}</strong>
                    <span className="verification-summary">{row.summary}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {request.manifest !== undefined && currentStage === "awaiting_confirmation" && (
            <>
              <h4>候选 manifest（注册前请核对权限请求）</h4>
              <pre className="mono">{JSON.stringify(request.manifest, null, 2)}</pre>
            </>
          )}

          {request.status === "proposed" && (
            <div className="form-actions">
              <button
                className="btn primary"
                disabled={confirming || !verification?.allPassed}
                onClick={() => void confirm()}
              >
                {verification?.allPassed === false
                  ? "验证未全过，不可注册"
                  : confirming
                    ? "注册中…"
                    : "确认注册（注册默认停用，可在清单中启用）"}
              </button>
            </div>
          )}
          {request.status === "confirmed" && (
            <div className="banner-ok">
              能力已注册（默认停用）。到「能力清单」启用并核对五维权限。
            </div>
          )}
        </div>
      )}
    </>
  );
}

// --- Skill 列表与提案批准（T5 接缝）----------------------------------------------

function SkillsPanel({ base }: { base: string }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [proposals, setProposals] = useState<SkillProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [skillList, proposalList] = await Promise.all([api.listSkills(base), api.listSkillProposals(base)]);
      setSkills(skillList);
      setProposals(proposalList);
      setError(null);
    } catch (err) {
      setError(readableError(err, "加载 Skill 数据失败"));
      setSkills((prev) => prev ?? []);
      setProposals((prev) => prev ?? []);
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const decide = async (proposal: SkillProposal, decision: "approve" | "reject"): Promise<void> => {
    setBusyId(proposal.proposal_id);
    try {
      const updated = await api.decideSkillProposal(base, proposal.proposal_id, decision);
      setProposals((prev) => (prev ?? []).map((p) => (p.proposal_id === updated.proposal_id ? updated : p)));
    } catch (err) {
      // 拒绝理由（含悬空引用清单）以错误信封回传时就地呈现到提案行
      const message = err instanceof ApiError ? err.message : String(err);
      setProposals((prev) =>
        (prev ?? []).map((p) =>
          p.proposal_id === proposal.proposal_id
            ? { ...p, status: "rejected" as const, reason: message, missing_capabilities: p.missing_capabilities }
            : p,
        ),
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Skill 与提案</h2>
        <button className="btn" onClick={() => void reload()}>
          刷新
        </button>
      </div>
      <p className="page-hint">
        Skill = 能力的组合与复用单元。提案由工厂/Skill 进化产出，Owner 批准后才注册；
        引用了未注册能力（悬空引用）的提案会被拒绝。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}

      <h4>Skill 清单</h4>
      {(skills ?? []).length === 0 ? (
        <p className="empty-note">暂无 Skill。</p>
      ) : (
        <ul className="skill-list">
          {(skills ?? []).map((skill) => (
            <li key={skill.skill_id} className="skill-row">
              <strong>{skill.title}</strong>
              <span className="mono">v{skill.version}</span>
              {skill.enabled === true && <span className="badge tone-ok">已启用</span>}
              <span className="skill-composed">
                组合：
                {skill.capabilities.length === 0 ? (
                  <span className="hint-inline">（无）</span>
                ) : (
                  skill.capabilities.map((name) => (
                    <code key={name} className="dimension-item">
                      {name}
                    </code>
                  ))
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4>提案（需要 Owner 裁决）</h4>
      {(proposals ?? []).length === 0 ? (
        <p className="empty-note">暂无待处理提案。</p>
      ) : (
        <ul className="proposal-list">
          {(proposals ?? []).map((proposal) => {
            const presentation = describeProposal(proposal);
            return (
              <li key={proposal.proposal_id} className={`proposal-row tone-border-${presentation.tone === "ok" ? "ok" : presentation.tone === "warn" ? "warn" : "dim"}`}>
                <div className="proposal-head">
                  <strong>{proposal.title}</strong>
                  <span className={`badge tone-${presentation.tone === "ok" ? "ok" : presentation.tone === "warn" ? "warn" : "dim"}`}>
                    {presentation.statusLabel}
                  </span>
                </div>
                <span className="skill-composed">
                  引用能力：
                  {proposal.capabilities.map((name) => (
                    <code key={name} className="dimension-item">
                      {name}
                    </code>
                  ))}
                </span>
                {presentation.note !== null && <p className="proposal-note">{presentation.note}</p>}
                {proposal.status === "pending" && (
                  <div className="proposal-actions">
                    <button
                      className="btn primary"
                      disabled={busyId === proposal.proposal_id}
                      onClick={() => void decide(proposal, "approve")}
                    >
                      批准
                    </button>
                    <button
                      className="btn danger"
                      disabled={busyId === proposal.proposal_id}
                      onClick={() => void decide(proposal, "reject")}
                    >
                      拒绝
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// --- 工具 ------------------------------------------------------------------------

/** 能力域错误码 → Owner 可读前缀（与 runtime capability_routes 的错误信封对齐） */
function readableError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "network_error") return `${fallback}：${err.message}`;
    return `${fallback}（${err.code}）—— ${err.message}`;
  }
  return `${fallback}：${err instanceof Error ? err.message : String(err)}`;
}
