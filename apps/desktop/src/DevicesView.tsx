import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type DeviceInfo,
  type PairingClaimResponse,
  type PairingCodeResponse,
  type SyncConflictView,
} from "./api.ts";
import {
  claimReview,
  conflictSourceLabel,
  describeSyncFailure,
  diffLines,
  isPairingCodeShape,
  joinWizardNext,
  mapSyncStatus,
  normalizePairingCodeInput,
  pairingCountdown,
  toResolveRequest,
  type ConflictResolutionChoice,
  type JoinWizardState,
  type SyncPanelView,
} from "./device-ui.ts";

/**
 * 设置 →「设备与同步」页签（票 M3-T6 / Issue #35，PRD §5.1/§5.2、FR-DEP-2/3/5）。
 *
 * 三块，自上而下：
 *   1. 设备列表：label / 指纹短格式 / 信任与撤销状态 / 配对时间 / 最后同步时间 + 撤销
 *      （二次确认；本机自注册行不可撤销——服务端 409 cannot_revoke_self 的前端同口径）；
 *   2. 配对：已信任侧「生成配对码」（6 位 + mm:ss 倒计时 + 过期提示）与新设备侧
 *      「加入设备」向导（输入码 → claim → 双端指纹核对 → 确认 / 不一致即撤销）；
 *   3. 同步状态面板 + 冲突审核入口（GET /v1/sync/status、GET/POST /v1/sync/conflicts）。
 *
 * 全部走控制面 API；「手动同步」在 Runtime 尚无同步循环端点时如实退化为状态查询，
 * 并在按钮旁注明原因（票面允许：无端点则明确标注查询）。
 */
export function DevicesView({ base }: { base: string }) {
  return (
    <div className="settings-section devices-page">
      <div className="page-head">
        <h2>设备与同步</h2>
        <span className="hint-inline">本机：{base.replace("http://", "")}</span>
      </div>
      <p className="page-hint">
        设备配对 = 一次性配对码 + 双端指纹人工核对。设备之间只同步事件账本（不复制数据库文件）；
        同一任务在两台设备各自执行过时会冻结为「待人工裁决」，由你在这里或任务页决定结论。
      </p>
      <DeviceListSection base={base} />
      <PairingSection base={base} />
      <SyncSection base={base} />
      <ConflictSection base={base} />
    </div>
  );
}

function readableError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "network_error") return `${fallback}：${err.message}`;
    return `${fallback}（${err.code}）：${err.message}`;
  }
  return `${fallback}：${err instanceof Error ? err.message : String(err)}`;
}

function relative(iso: string | null): string {
  if (iso === null) return "从未";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const delta = Date.now() - at;
  if (delta < 60_000) return "刚刚";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return iso.slice(0, 16).replace("T", " ");
}

// --- 设备列表 ---------------------------------------------------------------------

function DeviceListSection({ base }: { base: string }) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [localReplicaId, setLocalReplicaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [list, health] = await Promise.all([api.listDevices(base), api.health(base)]);
      setDevices(list);
      setLocalReplicaId(health.replica_id);
      setError(null);
    } catch (err) {
      setError(readableError(err, "加载设备列表失败"));
    }
  }, [base]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const revoke = async (record: DeviceInfo) => {
    const name = record.label ?? record.fingerprint_short ?? record.replica_id.slice(0, 8);
    // 二次确认：撤销是终态（该设备令牌立即失效，且不能凭旧码复活）
    if (!window.confirm(`撤销设备「${name}」？\n撤销后该设备的令牌立即失效，且不能凭旧配对码重新加入。`)) {
      return;
    }
    setBusyId(record.replica_id);
    try {
      await api.revokeDevice(base, record.replica_id);
      await reload();
    } catch (err) {
      setError(readableError(err, "撤销设备失败"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="task-section device-section">
      <div className="section-head">
        <h4>设备列表</h4>
        <button className="btn" onClick={() => void reload()}>
          刷新
        </button>
      </div>
      {error !== null && <div className="banner-error">{error}</div>}
      {devices.length === 0 && error === null && <p className="empty-note">暂无设备记录。</p>}
      <ul className="device-list">
        {devices.map((record) => {
          const isSelf = record.replica_id === localReplicaId;
          const revoked = record.revoked;
          return (
            <li key={record.replica_id} className={`device-row${revoked ? " device-revoked" : ""}`}>
              <div className="device-main">
                <div className="device-title">
                  <strong>{record.label ?? (isSelf ? "本机" : "未命名设备")}</strong>
                  {isSelf && <span className="badge badge-default">本机</span>}
                  {record.trusted && !revoked && <span className="badge tone-ok">可信</span>}
                  {revoked && <span className="badge tone-error">已撤销</span>}
                  {record.paired_at === null && !isSelf && <span className="badge tone-warn">未配对</span>}
                </div>
                <div className="device-meta">
                  <span className="mono" title={record.fingerprint ?? "尚未生成设备身份"}>
                    指纹 {record.fingerprint_short ?? "未生成"}
                  </span>
                  <span className="mono" title={record.replica_id}>
                    副本 {record.replica_id.slice(0, 8)}
                  </span>
                  <span>配对时间 {record.paired_at === null ? "—（本机自注册）" : relative(record.paired_at)}</span>
                  <span>最后同步 {relative(record.last_sync_at)}</span>
                  {revoked && <span>撤销时间 {relative(record.revoked_at)}</span>}
                </div>
              </div>
              <div className="device-actions">
                {revoked ? (
                  <span className="hint-inline">撤销为终态；重新加入需在新设备上重新配对</span>
                ) : isSelf ? (
                  <span className="hint-inline">本机不可撤销（锁死管理面）</span>
                ) : (
                  <button
                    className="btn danger"
                    disabled={busyId === record.replica_id}
                    onClick={() => void revoke(record)}
                  >
                    {busyId === record.replica_id ? "撤销中…" : "撤销…"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="hint-inline">
        「最后同步」取自设备的 last_sync_at（由 Runtime 同步引擎写入）；从未同步过显示「从未」。
      </p>
    </section>
  );
}

// --- 配对 -------------------------------------------------------------------------

function PairingSection({ base }: { base: string }) {
  const [code, setCode] = useState<PairingCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [joined, setJoined] = useState(false);

  // 倒计时每秒重绘；过期后仍重绘（提示文案不依赖额外状态）
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const generate = async () => {
    setCreating(true);
    setError(null);
    try {
      setCode(await api.createPairingCode(base));
    } catch (err) {
      setError(readableError(err, "生成配对码失败"));
    } finally {
      setCreating(false);
    }
  };

  const countdown = code === null ? null : pairingCountdown(code.expires_at, nowMs);

  return (
    <section className="task-section device-section">
      <h4>配对</h4>
      <div className="pairing-grid">
        <div className="pairing-card">
          <h5>生成配对码（本机是已信任设备）</h5>
          <p className="hint-inline">
            在另一台设备的「加入设备」里输入此码；码一次性、5 分钟有效。请让对方核对下方指纹。
          </p>
          {error !== null && <div className="banner-error">{error}</div>}
          {code === null ? (
            <button className="btn primary" onClick={() => void generate()} disabled={creating}>
              {creating ? "生成中…" : "生成配对码"}
            </button>
          ) : (
            <div className="pairing-code-box">
              <div className="pairing-code mono" aria-label="配对码">
                {code.code}
              </div>
              {countdown !== null && (
                <div className={`pairing-countdown tone-${countdown.tone}`}>
                  {countdown.expired ? (
                    <>配对码已过期——请重新生成</>
                  ) : (
                    <>
                      剩余 <span className="mono">{countdown.label}</span>
                    </>
                  )}
                  <span className="pairing-expires-at">（{new Date(code.expires_at).toLocaleTimeString()} 过期）</span>
                </div>
              )}
              <div className="pairing-fingerprint">
                本机指纹 <span className="mono fingerprint">{code.server.fingerprint_short}</span>
                <span className="hint-inline">—— 对方应显示同一值</span>
              </div>
              <button className="btn" onClick={() => void generate()} disabled={creating}>
                {countdown?.expired === true ? "重新生成" : "换一个码"}
              </button>
            </div>
          )}
        </div>
        <JoinDeviceCard
          defaultBase={base}
          onJoined={() => {
            setJoined(true);
          }}
        />
      </div>
      {joined && (
        <p className="hint-inline">
          加入操作已完成一轮：请在上方设备列表点「刷新」确认新设备（撤销也在那里）。
        </p>
      )}
    </section>
  );
}

// --- 加入设备向导 -----------------------------------------------------------------

interface ClaimOutcome {
  response: PairingClaimResponse;
  /** 被加入的 Runtime 地址（撤销时也要回到它） */
  peerBase: string;
  expected: string;
}

/**
 * 新设备侧向导（PRD §5.2 流程 1）：
 *   input --submit--> claiming --claimed--> review --confirm--> done
 *                                \--claim_failed--> input
 *   review --reject--> mismatch（信任已建立，补救 = 撤销该设备）
 *
 * 设备公钥在浏览器里用 WebCrypto 现生成（ed25519 raw 32B），只用于本次 claim；
 * 响应里的 bearer token 仅此一次出现，本 UI **不展示也不持久化**（桌面壳应存 OS
 * 凭据库），避免令牌落进 WebView 存储。
 */
function JoinDeviceCard({ defaultBase, onJoined }: { defaultBase: string; onJoined: () => void }) {
  const [state, setState] = useState<JoinWizardState>({ step: "input", busy: false, error: null });
  const [peerBase, setPeerBase] = useState(defaultBase);
  const [codeInput, setCodeInput] = useState("");
  const [label, setLabel] = useState("");
  const [expected, setExpected] = useState("");
  const [outcome, setOutcome] = useState<ClaimOutcome | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const advance = (event: Parameters<typeof joinWizardNext>[1], patch: Partial<JoinWizardState> = {}) => {
    setState((prev) => ({ ...prev, step: joinWizardNext(prev, event), ...patch }));
  };

  const submit = async () => {
    if (state.step !== "input") return;
    const peer = peerBase.trim().replace(/\/+$/, "");
    if (!isPairingCodeShape(codeInput)) {
      setState({ ...state, error: "配对码须为 6 位数字" });
      return;
    }
    if (!/^https?:\/\//.test(peer)) {
      setState({ ...state, error: "设备地址需形如 http://host:port" });
      return;
    }
    setState({ ...state, step: joinWizardNext(state, { type: "submit" }), busy: true, error: null });
    try {
      const key = await generateDevicePublicKey();
      if (!key.ok) {
        setState({ step: "input", busy: false, error: key.error });
        return;
      }
      const response = await api.claimPairing(peer, {
        code: codeInput,
        device_public_key: key.base64,
        device_label: label.trim().length > 0 ? label.trim() : undefined,
        device_replica_id: crypto.randomUUID(),
        ...(expected.trim().length > 0 ? { server_fingerprint: expected.trim() } : {}),
      });
      setOutcome({ response, peerBase: peer, expected });
      advance({ type: "claimed" }, { busy: false });
    } catch (err) {
      if (err instanceof ApiError && err.code === "fingerprint_mismatch") {
        // 服务端口径：指纹不一致立即 409 且不消耗配对码——改期望值后可重试
        setState({
          step: "input",
          busy: false,
          error: `指纹不一致：${err.message}\n配对码未被消耗，请核对对端显示的指纹后重试。`,
        });
        return;
      }
      setState({ step: "input", busy: false, error: readableError(err, "加入设备失败") });
    }
  };

  const revokeJustJoined = async () => {
    if (outcome === null) return;
    setRevokeBusy(true);
    try {
      await api.revokeDevice(outcome.peerBase, outcome.response.device.replica_id);
      onJoined();
      setOutcome(null);
      setCodeInput("");
      setState({ step: "input", busy: false, error: null });
    } catch (err) {
      setState({ step: "mismatch", busy: false, error: readableError(err, "撤销刚加入的设备失败") });
    } finally {
      setRevokeBusy(false);
    }
  };

  const review = outcome === null ? null : claimReview(outcome.response, outcome.expected);

  return (
    <div className="pairing-card">
      <h5>加入另一台设备（本机作为新设备）</h5>
      <p className="hint-inline">
        输入对端「生成配对码」页显示的 6 位码与指纹；claim 成功后双端指纹必须一致才继续使用。
      </p>
      {state.error !== null && <div className="banner-error">{state.error}</div>}

      {(state.step === "input" || state.step === "claiming") && (
        <div className="join-form">
          <label className="field">
            <span className="field-label">设备地址（要加入的 Runtime）</span>
            <input
              value={peerBase}
              onChange={(e) => setPeerBase(e.target.value)}
              placeholder="http://127.0.0.1:7319"
              spellCheck={false}
              disabled={state.step === "claiming"}
            />
          </label>
          <label className="field">
            <span className="field-label">6 位配对码</span>
            <input
              className="mono pairing-code-input"
              inputMode="numeric"
              value={codeInput}
              onChange={(e) => setCodeInput(normalizePairingCodeInput(e.target.value))}
              placeholder="123456"
              disabled={state.step === "claiming"}
            />
          </label>
          <label className="field">
            <span className="field-label">设备名（对端列表里显示）</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如：办公室台式机"
              disabled={state.step === "claiming"}
            />
          </label>
          <label className="field">
            <span className="field-label">对端指纹（可选，推荐抄写）</span>
            <input
              className="mono"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder="ABCD-EF01-2345-6789"
              spellCheck={false}
              disabled={state.step === "claiming"}
            />
            <span className="field-hint">
              填写后服务端会先比对：不一致立即失败且不消耗配对码（明确失败而非静默建立信任）。
            </span>
          </label>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={state.step === "claiming" || !isPairingCodeShape(codeInput)}
          >
            {state.step === "claiming" ? "核对并加入中…" : "核对并加入"}
          </button>
        </div>
      )}

      {state.step === "review" && review !== null && (
        <div className="claim-review">
          <h6>双端指纹核对</h6>
          <div className="fingerprint-pair">
            <div>
              <span className="field-label">对端（服务端）指纹</span>
              <div className="mono fingerprint">{review.serverShort}</div>
            </div>
            <div>
              <span className="field-label">本设备指纹</span>
              <div className="mono fingerprint">{review.deviceShort}</div>
            </div>
          </div>
          <p className={`claim-check tone-${review.matchesExpected === true ? "ok" : review.matchesExpected === false ? "error" : "warn"}`}>
            {review.matchesExpected === true
              ? "与你抄写的对端指纹一致。"
              : review.matchesExpected === false
                ? "与你抄写的对端指纹不一致！"
                : "未填写对端显示值：请人工比对两个指纹是否与对端屏幕一致。"}
          </p>
          <p className="hint-inline">
            设备已作为「{review.deviceLabel}」加入对端。两端指纹一致才继续使用；不一致请选择「指纹不一致」并撤销。
          </p>
          <div className="form-actions">
            <button className="btn primary" onClick={() => advance({ type: "confirm" })}>
              两端指纹一致，完成
            </button>
            <button className="btn danger" onClick={() => advance({ type: "reject" })}>
              指纹不一致
            </button>
          </div>
        </div>
      )}

      {state.step === "done" && (
        <div className="claim-done">
          <p>已加入「{outcome?.response.server.replica_id.slice(0, 8)}」的信任网络。</p>
          <p className="hint-inline">
            bearer token 仅在 claim 响应中出现一次，本页面不展示也不保存；桌面壳应把它写入操作系统凭据库。
          </p>
          <button
            className="btn"
            onClick={() => {
              setOutcome(null);
              setCodeInput("");
              advance({ type: "reset" });
              onJoined();
            }}
          >
            再加入一台 / 继续
          </button>
        </div>
      )}

      {state.step === "mismatch" && (
        <div className="claim-mismatch">
          <p className="banner-error">
            指纹不一致：信任已由 claim 建立，唯一安全的补救是立即撤销刚加入的设备。
          </p>
          <button className="btn danger" onClick={() => void revokeJustJoined()} disabled={revokeBusy}>
            {revokeBusy ? "撤销中…" : "立即撤销该设备"}
          </button>
          <button className="btn" onClick={() => advance({ type: "reset" })} disabled={revokeBusy}>
            先不处理，返回
          </button>
        </div>
      )}
    </div>
  );
}

/** 浏览器侧生成 ed25519 公钥（raw 32B base64）；不支持的运行时给明确错误 */
type DeviceKeyResult = { ok: true; base64: string } | { ok: false; error: string };

async function generateDevicePublicKey(): Promise<DeviceKeyResult> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
      return { ok: false, error: "当前环境没有 WebCrypto，无法生成设备密钥。" };
    }
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    if (raw.byteLength !== 32) {
      return { ok: false, error: `公钥长度异常（${raw.byteLength}B），要求 32B raw ed25519。` };
    }
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    return { ok: true, base64: btoa(binary) };
  } catch (err) {
    return {
      ok: false,
      error: `当前浏览器不支持 Ed25519 密钥生成（${err instanceof Error ? err.message : String(err)}）。请用较新的桌面 WebView 打开。`,
    };
  }
}

// --- 同步状态面板 -----------------------------------------------------------------

const SYNC_POLL_MS = 5000;

function SyncSection({ base }: { base: string }) {
  const [panel, setPanel] = useState<SyncPanelView | null>(null);
  const [error, setError] = useState<{ code: string; message: string; details: Record<string, unknown> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [status, devices] = await Promise.all([api.syncStatus(base), api.listDevices(base)]);
      setPanel(mapSyncStatus(status, Date.now(), devices));
      setError(null);
      setCheckedAt(Date.now());
    } catch (err) {
      if (err instanceof ApiError) {
        setError({ code: err.code, message: err.message, details: err.details });
      } else {
        setError({ code: "unknown", message: err instanceof Error ? err.message : String(err), details: {} });
      }
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const notice = error === null ? null : describeSyncFailure(error.code, error.message, error.details);

  return (
    <section className="task-section device-section">
      <div className="section-head">
        <h4>同步状态</h4>
        <div className="sync-actions">
          {checkedAt !== null && <span className="hint-inline">状态查询于 {relative(new Date(checkedAt).toISOString())}</span>}
          {/* Runtime（M3-T1/T4）只提供 pull/push 端点与状态查询，没有「立即同步一轮」的控制端点；
              按票面允许，按钮退化为状态查询并明确标注，避免假装触发同步。 */}
          <button className="btn" onClick={() => void load()} disabled={loading} title="Runtime 暂无手动同步端点，此按钮只重新查询状态">
            {loading ? "查询中…" : "刷新同步状态"}
          </button>
        </div>
      </div>
      <p className="hint-inline">
        同步由 Runtime 同步引擎在事件交换时推进；本页的「刷新同步状态」只读查询（Runtime 未提供手动同步循环端点）。
      </p>
      {notice !== null && (
        <div className={`sync-notice tone-${notice.tone}`}>
          <strong>{notice.title}</strong>
          <p>{notice.explanation}</p>
        </div>
      )}
      {panel === null && error === null && <p className="empty-note">正在读取同步状态…</p>}
      {panel !== null && (
        <div className="sync-panel">
          <div className="sync-cards">
            <div className="sync-card">
              <span className="field-label">本副本</span>
              <span className="mono" title={panel.replicaId}>
                {panel.replicaId.slice(0, 8)}
              </span>
            </div>
            <div className="sync-card">
              <span className="field-label">本地 seq 范围</span>
              <span className="mono">
                {panel.seqRangeLabel}（{panel.count} 条事件）
              </span>
            </div>
            <div className="sync-card">
              <span className="field-label">最后同步</span>
              <span>{panel.lastSyncedLabel}</span>
            </div>
            <div className="sync-card">
              <span className="field-label">待上传（估算）</span>
              <span>{panel.pendingUpload === null ? "未知" : `${panel.pendingUpload} 条`}</span>
            </div>
            <div className="sync-card" title={panel.pendingDownloadReason}>
              <span className="field-label">待下载</span>
              <span>未知</span>
            </div>
          </div>
          <p className="hint-inline">{panel.pendingDownloadReason}（因此只显示未知，不臆造数字）。</p>
          {panel.empty ? (
            <p className="empty-note">还没有任何 peer 游标：从未与另一台设备同步过。</p>
          ) : (
            <table className="cursor-table">
              <thead>
                <tr>
                  <th>Peer 副本</th>
                  <th>已拉取</th>
                  <th>已确认</th>
                  <th>待上传估算</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {panel.cursors.map((cursor) => (
                  <tr key={cursor.peer}>
                    <td className="mono" title={cursor.peer}>
                      {cursor.peerShort}
                    </td>
                    <td className="mono">seq {cursor.pulled}</td>
                    <td className="mono">seq {cursor.acked}</td>
                    <td>{cursor.pendingUpload === null ? "未知" : `${cursor.pendingUpload} 条`}</td>
                    <td>{relative(cursor.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

// --- 冲突审核 ---------------------------------------------------------------------

const CONFLICT_REASON_LABELS: Record<string, string> = {
  locked: "locked 记忆禁止自动改写",
  sensitivity_change: "可见性分级变更",
};

function ConflictSection({ base }: { base: string }) {
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mergeDraft, setMergeDraft] = useState<Record<string, string>>({});
  const [mergingId, setMergingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setConflicts(await api.syncConflicts(base, showResolved ? undefined : "open"));
      setError(null);
    } catch (err) {
      setError(readableError(err, "加载冲突队列失败"));
    }
  }, [base, showResolved]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const resolve = async (conflict: SyncConflictView, choice: ConflictResolutionChoice) => {
    const request = toResolveRequest(choice, mergeDraft[conflict.conflict_id] ?? "");
    if (!request.ok || request.body === null) {
      setError(request.error);
      return;
    }
    setBusyId(conflict.conflict_id);
    try {
      await api.resolveSyncConflict(base, conflict.conflict_id, request.body);
      setMergingId(null);
      await reload();
    } catch (err) {
      setError(readableError(err, "裁决失败"));
    } finally {
      setBusyId(null);
    }
  };

  const open = conflicts.filter((c) => c.status === "open");
  const resolved = conflicts.filter((c) => c.status !== "open");

  return (
    <section className="task-section device-section">
      <div className="section-head">
        <h4>冲突审核（跨设备）</h4>
        <div className="sync-actions">
          <label className="compat-switch">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            显示已裁决
          </label>
          <button className="btn" onClick={() => void reload()}>
            刷新
          </button>
        </div>
      </div>
      <p className="hint-inline">
        同一事实在两台设备上被改成不同内容时进入此队列（与记忆冲突队列同一份数据）。
        裁决语义：保留本地 = keep_old，采用远端 = keep_new，合并 = 你提供最终文本。
      </p>
      {error !== null && <div className="banner-error">{error}</div>}
      {conflicts.length === 0 && error === null && <p className="empty-note">没有待裁决的冲突。</p>}
      <ul className="conflict-list">
        {[...open, ...resolved].map((conflict) => {
          const isOpen = conflict.status === "open";
          const rows = diffLines(conflict.existing_content, conflict.incoming_content);
          const reason = CONFLICT_REASON_LABELS[conflict.reason] ?? conflict.reason;
          return (
            <li key={conflict.conflict_id} className={`conflict-card${isOpen ? "" : " conflict-resolved"}`}>
              <div className="conflict-head">
                <span className={`badge tone-${isOpen ? "warn" : "ok"}`}>{isOpen ? "待裁决" : "已裁决"}</span>
                <span className="mono">事实 {conflict.fact_id.slice(0, 8)}</span>
                <span className="conflict-reason">{reason}</span>
                <span className="hint-inline">{conflictSourceLabel(conflict)}</span>
              </div>
              <div className="conflict-sides">
                <span className="field-label">
                  本地（v{conflict.local_version ?? "?"} · {conflict.existing_sensitivity}）
                </span>
                <span className="field-label">
                  远端（v{conflict.remote_version ?? "?"} · {conflict.incoming_sensitivity}）
                </span>
              </div>
              <pre className="conflict-diff" aria-label="本地与远端内容差异">
                {rows.map((row, index) => (
                  <div key={index} className={`diff-line diff-${row.kind}`}>
                    <span className="diff-marker">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>
                    {row.text}
                  </div>
                ))}
              </pre>
              {isOpen ? (
                <div className="conflict-actions">
                  <button className="btn" disabled={busyId === conflict.conflict_id} onClick={() => void resolve(conflict, "keep_local")}>
                    保留本地（keep_old）
                  </button>
                  <button className="btn" disabled={busyId === conflict.conflict_id} onClick={() => void resolve(conflict, "keep_remote")}>
                    采用远端（keep_new）
                  </button>
                  <button
                    className="btn"
                    disabled={busyId === conflict.conflict_id}
                    onClick={() => setMergingId(mergingId === conflict.conflict_id ? null : conflict.conflict_id)}
                  >
                    {mergingId === conflict.conflict_id ? "收起合并" : "合并…"}
                  </button>
                  {mergingId === conflict.conflict_id && (
                    <div className="merge-box">
                      <textarea
                        rows={3}
                        value={mergeDraft[conflict.conflict_id] ?? ""}
                        onChange={(e) =>
                          setMergeDraft((prev) => ({ ...prev, [conflict.conflict_id]: e.target.value }))
                        }
                        placeholder="填写两版合并后的最终内容（必填）"
                      />
                      <button
                        className="btn primary"
                        disabled={busyId === conflict.conflict_id}
                        onClick={() => void resolve(conflict, "merge")}
                      >
                        提交合并
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="hint-inline">
                  裁决：{conflict.resolution ?? "?"}
                  {conflict.resolved_content !== null && `；合并文本：${conflict.resolved_content}`}
                  {conflict.resolved_at !== null && `（${relative(conflict.resolved_at)}）`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
