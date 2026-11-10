/**
 * 设备与同步 UI 纯逻辑（票 M3-T6 / Issue #35，PRD §5.1 设置→设备与同步、§5.2 配对流程）。
 *
 * React（DevicesView）只做装配；本模块承载全部可测决策：
 *   - 指纹短格式与人工输入归一化（双端核对的一致性口径与 runtime formatFingerprint 相同）；
 *   - 配对码输入归一化与倒计时（5 分钟 TTL，过期明确提示重新生成）；
 *   - 同步状态面板映射（本副本 seq 范围、各 peer 游标、待上传估算、最后同步时间）；
 *   - 同步失败归因（sync_gap 的 expected/actual 平铺字段、网络/完整性错误）；
 *   - 冲突三方来源文案与行级 diff、裁决请求映射（keep_local/keep_remote/merge →
 *     T3 的 keep_old/keep_new/merge 语义）；
 *   - 加入设备向导（input → claiming → review → done / mismatch）状态机。
 *
 * 类型一律从 `@morrow/protocol/browser` 引（主入口有浏览器守卫测试）。
 */
import type { DeviceInfo, PairingClaimResponse, PairingJoinResponse, SyncStatus } from "@morrow/protocol/browser";

// --- 指纹 -------------------------------------------------------------------------

/** 宽松归一化：去掉分隔符/空白并转小写（与 runtime normalizeFingerprint 同口径） */
export function normalizeFingerprintInput(raw: string): string {
  return raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/**
 * 短格式指纹：大写、每 4 位一组以 `-` 分隔（runtime pairing/crypto.formatFingerprint 同规则）。
 * 输入可以是小写裸 hex，也可以是已带分隔符的展示值（幂等）。
 */
export function shortFingerprint(fingerprint: string): string {
  return normalizeFingerprintInput(fingerprint).toUpperCase().replace(/(.{4})(?=.)/g, "$1-");
}

export interface FingerprintCheck {
  /** null = 无法判定（未填写或不完整），UI 需保持「待人工核对」状态 */
  ok: boolean | null;
  reason: string | null;
}

/**
 * 人工核对结论：期望值（对端屏幕上抄来的指纹）与实际值（服务端返回的指纹）。
 * 未填写不阻断流程但必须提示人工比对；输入不完整时既不算通过也不算不一致——
 * 「我抄了一半」不应被当成「指纹不同」。
 */
export function fingerprintCheck(expected: string, actual: string): FingerprintCheck {
  const want = normalizeFingerprintInput(expected);
  const got = normalizeFingerprintInput(actual);
  if (want.length === 0) {
    return { ok: null, reason: "未填写对端显示值——请在确认页人工比对" };
  }
  if (got.length > 0 && want.length < got.length) {
    return { ok: null, reason: `输入不完整（${want.length}/${got.length} 位），请核对完整指纹` };
  }
  if (want === got) return { ok: true, reason: null };
  return { ok: false, reason: "与对端显示值不一致" };
}

// --- 配对码 -----------------------------------------------------------------------

/** 只留数字并截断 6 位（粘贴「123 456」/「12-34-56」容错） */
export function normalizePairingCodeInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}

/** 6 位数字码形态（与 runtime claim 的正则同口径） */
export function isPairingCodeShape(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export interface PairingCountdown {
  remainingMs: number;
  /** mm:ss；过期后为「已过期」；时间不可解析为「过期时间未知」 */
  label: string;
  expired: boolean;
  tone: "ok" | "warn" | "error";
}

/** 配对码倒计时（TTL 由服务端 expires_at 给出：默认创建后 5 分钟） */
export function pairingCountdown(expiresAt: string, nowMs: number): PairingCountdown {
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    return { remainingMs: 0, label: "过期时间未知", expired: true, tone: "error" };
  }
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) {
    return { remainingMs: 0, label: "已过期", expired: true, tone: "error" };
  }
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    remainingMs,
    label: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    expired: false,
    tone: remainingMs <= 60_000 ? "warn" : "ok",
  };
}

// --- 同步状态面板 -----------------------------------------------------------------

export interface PeerCursorView {
  peer: string;
  /** 前 8 位（列表里可读且足够区分；完整值在 title） */
  peerShort: string;
  pulled: number;
  acked: number;
  updatedAt: string | null;
  /** 最近一次成功同步时间（Runtime 的 peers[].last_synced_at；旧状态无此字段时回退 null） */
  lastSyncedAt: string | null;
  /**
   * 待上传 = 本地 seq 上界 − 已确认（钳到 0）。优先用 Runtime 的 peers[].pending_upload
   * （M3 修复批起真实提供）；旧版状态回退到前端同口径估算。
   */
  pendingUpload: number | null;
  /** 待下载（Runtime 实时探测对端账本上界；对端不可达为 null） */
  pendingDownload: number | null;
  /** 该 peer 本次查询是否不可达 */
  unreachable: boolean;
}

export interface SyncPanelView {
  replicaId: string;
  /** 「3–42」或「空账本」 */
  seqRangeLabel: string;
  count: number;
  cursors: PeerCursorView[];
  /** 最近一次同步时间（游标 last_synced_at / updated_at 与设备 last_sync_at 取最大） */
  lastSyncedAt: string | null;
  lastSyncedLabel: string;
  /** 待上传合计；无 peer 时为 null（未知） */
  pendingUpload: number | null;
  /** 待下载合计；任一 peer 不可达/未提供时为 null（不臆造数字） */
  pendingDownload: number | null;
  pendingDownloadReason: string;
  empty: boolean;
}

/** 相对时间（分档：刚刚 / N 分钟前 / N 小时前 / N 天前 / 绝对时间） */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const deltaMs = nowMs - at;
  if (deltaMs < 60_000) return "刚刚";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * `GET /v1/sync/status` → 面板视图。
 * Runtime（M3 修复批 / Issue #35）在 `peers[]` 里直接给出 pending_upload /
 * pending_download / last_synced_at；旧版状态没有 peers 时回退到前端估算（待下载未知）。
 * `devices` 是可选增强：设备的 last_sync_at 由同步引擎写入，可能比游标更新时间更可信。
 */
export function mapSyncStatus(status: SyncStatus, nowMs: number, devices: DeviceInfo[] = []): SyncPanelView {
  const localMax = status.sequence.max;
  const peers = status.peers ?? [];
  const peerById = new Map(peers.map((peer) => [peer.peer_replica_id, peer]));
  const cursors: PeerCursorView[] = status.cursors.map((cursor) => {
    const peer = peerById.get(cursor.peer_replica_id);
    return {
      peer: cursor.peer_replica_id,
      peerShort: cursor.peer_replica_id.slice(0, 8),
      pulled: cursor.last_pulled_sequence,
      acked: cursor.last_acked_sequence,
      updatedAt: cursor.updated_at,
      lastSyncedAt: peer?.last_synced_at ?? cursor.last_synced_at ?? null,
      pendingUpload:
        peer?.pending_upload ??
        (localMax === null ? null : Math.max(0, localMax - cursor.last_acked_sequence)),
      pendingDownload: peer === undefined ? null : peer.pending_download,
      unreachable: peer?.unreachable === true,
    };
  });
  const pendingValues = cursors.map((c) => c.pendingUpload);
  const pendingUpload =
    pendingValues.length === 0 || pendingValues.some((v) => v === null)
      ? null
      : pendingValues.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const downloadValues = cursors.map((c) => c.pendingDownload);
  const pendingDownload =
    downloadValues.length === 0 || downloadValues.some((v) => v === null)
      ? null
      : downloadValues.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const unreachable = cursors.some((cursor) => cursor.unreachable);
  const pendingDownloadReason =
    pendingDownload !== null
      ? "各 peer 待下载合计（Runtime 实时查询对端账本上界）"
      : unreachable
        ? "对端不可达，待下载未知（Runtime 如实返回 null，不臆造 0）"
        : cursors.length === 0
          ? "还没有已配对 peer"
          : "Runtime 未提供对端账本上界";

  const timestamps = [
    ...status.cursors.map((c) => c.updated_at),
    ...status.cursors.map((c) => c.last_synced_at),
    ...peers.map((p) => p.last_synced_at),
    ...devices.map((d) => d.last_sync_at),
  ].filter((v): v is string => v !== null && v !== undefined);
  const lastSyncedAt = timestamps.length === 0 ? null : timestamps.reduce((a, b) => (a >= b ? a : b));

  return {
    replicaId: status.replica_id,
    seqRangeLabel:
      status.sequence.max === null ? "空账本" : `${status.sequence.min ?? 0}–${status.sequence.max}`,
    count: status.sequence.count,
    cursors,
    lastSyncedAt,
    lastSyncedLabel: lastSyncedAt === null ? "从未同步" : formatRelativeTime(lastSyncedAt, nowMs),
    pendingUpload,
    pendingDownload,
    pendingDownloadReason,
    empty: status.cursors.length === 0 && peers.length === 0,
  };
}

export interface SyncNotice {
  tone: "error" | "warn";
  title: string;
  explanation: string;
}

const SYNC_ERROR_LABELS: Record<string, string> = {
  sync_gap: "同步缺口",
  sync_integrity_failed: "数据完整性校验失败",
  sync_transport_unavailable: "对端不可达",
  network_error: "无法连接 Runtime",
  http_404: "接口不存在",
};

export function syncErrorCodeLabel(code: string): string {
  return SYNC_ERROR_LABELS[code] ?? code;
}

/**
 * 同步失败 → Owner 可读归因。`sync_gap` 的 expected/actual/peer_replica_id 由服务端
 * 在错误信封里平铺（见 sync/routes.ts sendSyncError），必须显式呈现缺口位置。
 */
export function describeSyncFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): SyncNotice {
  if (code === "sync_gap") {
    const expected = typeof details.expected === "number" ? details.expected : null;
    const actual = typeof details.actual === "number" ? details.actual : null;
    const peer = typeof details.peer_replica_id === "string" ? details.peer_replica_id.slice(0, 8) : "对端";
    const position =
      expected !== null && actual !== null
        ? `期望 ${expected}，实际 ${actual}`
        : "序列不连续";
    return {
      tone: "error",
      title: "同步缺口（sync_gap）",
      explanation: `${peer} 的账本序列不连续：${position}。整批未导入、游标未推进；请先补齐对端事件（或从对端重新完整拉取）后重试。`,
    };
  }
  if (code === "sync_integrity_failed") {
    return {
      tone: "error",
      title: "同步数据完整性校验失败",
      explanation: `完整性校验未通过：${message}——整批被拒绝（本地账本未改动）。可能来自传输损坏或对端数据异常，请重试或从对端重新拉取。`,
    };
  }
  if (code === "sync_transport_unavailable") {
    return { tone: "warn", title: "对端不可达", explanation: message };
  }
  if (code === "network_error") {
    return { tone: "error", title: "无法连接 Runtime 控制面", explanation: message };
  }
  return {
    tone: "error",
    title: `同步操作失败（${syncErrorCodeLabel(code)}）`,
    explanation: `${code}：${message}`,
  };
}

// --- 冲突 -------------------------------------------------------------------------

export type ConflictResolutionChoice = "keep_local" | "keep_remote" | "merge";

/** T3 裁决语义：keep_old = 本地既有值，keep_new = 远端入站值，merge 需 Owner 文本 */
export interface ConflictResolveBody {
  resolution: "keep_old" | "keep_new" | "merge";
  content?: string;
}

export interface ResolveRequestResult {
  ok: boolean;
  error: string | null;
  body: ConflictResolveBody | null;
}

export function toResolveRequest(choice: ConflictResolutionChoice, mergeText = ""): ResolveRequestResult {
  if (choice === "keep_local") return { ok: true, error: null, body: { resolution: "keep_old" } };
  if (choice === "keep_remote") return { ok: true, error: null, body: { resolution: "keep_new" } };
  const content = mergeText.trim();
  if (content.length === 0) {
    return { ok: false, error: "merge 裁决必须填写合并文本", body: null };
  }
  return { ok: true, error: null, body: { resolution: "merge", content } };
}

export type DiffKind = "same" | "add" | "remove";

export interface DiffRow {
  kind: DiffKind;
  text: string;
}

/**
 * 行级 LCS diff（本地既有 vs 远端入站）。冲突内容通常是短句/短段，O(n·m) 足够；
 * 相同行保持原文，便于 Owner 直接读裁决依据。
 */
export function diffLines(local: string, remote: string): DiffRow[] {
  const a = local.length === 0 ? [] : local.split("\n");
  const b = remote.length === 0 ? [] : remote.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "remove", text: a[i] });
      i += 1;
    } else {
      rows.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) rows.push({ kind: "remove", text: a[i++] });
  while (j < b.length) rows.push({ kind: "add", text: b[j++] });
  return rows;
}

/** 冲突来源一行文案：来源副本 + 三方版本（local = 本地既有，remote = 远端入站） */
export function conflictSourceLabel(view: {
  origin: "sync" | "local";
  local_replica_id: string | null;
  remote_replica_id: string | null;
  local_version: number | null;
  remote_version: number | null;
  base_version: number | null;
}): string {
  if (view.origin !== "sync" || view.remote_replica_id === null) {
    return "本机冲突（同一设备内闭合，无跨设备来源）";
  }
  const base = view.base_version === null ? "无（无共同基线）" : `v${view.base_version}`;
  return [
    `来源副本 ${view.remote_replica_id.slice(0, 8)}`,
    `本地 v${view.local_version ?? "?"}`,
    `远端 v${view.remote_version ?? "?"}`,
    `基线 ${base}`,
  ].join(" · ");
}

// --- 加入设备向导 ----------------------------------------------------------------

export type JoinStep = "input" | "claiming" | "review" | "done" | "mismatch";

export interface JoinWizardState {
  step: JoinStep;
  busy: boolean;
  error: string | null;
}

export type JoinEvent =
  | { type: "submit" }
  | { type: "claimed" }
  | { type: "claim_failed" }
  | { type: "confirm" }
  | { type: "reject" }
  | { type: "reset" };

/**
 * 加入设备状态机（PRD §5.2 流程 1 的客户端侧）：
 *   input --submit--> claiming --claimed--> review --confirm--> done
 *                                    \--claim_failed--> input
 *   review --reject--> mismatch（信任已由 claim 建立，唯一补救是撤销该设备）
 *   review --submit--> review（防重复 claim：码是一次性的，重提会烧码）
 *   claiming --submit--> claiming（防抖）
 */
export function joinWizardNext(state: JoinWizardState, event: JoinEvent): JoinStep {
  switch (event.type) {
    case "submit":
      return state.step === "input" ? "claiming" : state.step;
    case "claimed":
      return state.step === "claiming" ? "review" : state.step;
    case "claim_failed":
      return state.step === "claiming" ? "input" : state.step;
    case "confirm":
      return state.step === "review" ? "done" : state.step;
    case "reject":
      return state.step === "review" ? "mismatch" : state.step;
    case "reset":
      return state.step === "claiming" ? "claiming" : "input";
  }
}

export interface ClaimReview {
  deviceShort: string;
  deviceLabel: string;
  serverShort: string;
  /** null = 用户未填写对端显示值（只能人工比对） */
  matchesExpected: boolean | null;
  /** 不一致时给 Owner 的唯一补救指引（撤销刚建立的信任） */
  rejectAdvice: string | null;
}

/** 宿主侧 join 响应 → 双端指纹核对视图（token 由 Runtime 写凭据库，UI 从不接触） */
export function joinReview(response: PairingJoinResponse, expectedFingerprint: string): ClaimReview {
  const check = fingerprintCheck(expectedFingerprint, response.server_fingerprint);
  return {
    deviceShort: response.server_fingerprint_short,
    deviceLabel: response.device.label ?? "对端 Runtime",
    serverShort: response.server_fingerprint_short,
    matchesExpected: check.ok,
    rejectAdvice:
      check.ok === false
        ? "指纹不一致（Runtime 应已回滚对端信任）：请刷新设备列表确认；若仍存在，手动撤销该设备并核对地址。"
        : null,
  };
}

/** claim 响应 → 双端指纹核对视图（token 不进入任何展示字段） */
export function claimReview(response: PairingClaimResponse, expectedFingerprint: string): ClaimReview {
  const check = fingerprintCheck(expectedFingerprint, response.server.fingerprint);
  return {
    deviceShort: response.device.fingerprint_short,
    deviceLabel: response.device.label ?? "未命名设备",
    serverShort: response.server.fingerprint_short,
    matchesExpected: check.ok,
    rejectAdvice:
      check.ok === false
        ? "指纹不一致：信任已由 claim 建立，请立即在设备列表撤销该设备，核对地址与两端显示值后重新配对。"
        : null,
  };
}
