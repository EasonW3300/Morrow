/**
 * 设备与同步 UI 纯逻辑测试（票 M3-T6 / Issue #35，PRD §5.1 设置→设备与同步、§5.2 配对流程）。
 *
 * 覆盖：指纹短格式/人工输入归一化、配对码倒计时与过期、同步状态映射（seq 范围/peer
 * 游标/待上传估算/最后同步时间）、sync_gap 与错误呈现、冲突三方来源与 diff、裁决请求
 * 映射（keep_local/keep_remote/merge → T3 的 keep_old/keep_new/merge），以及「加入设备」
 * 的指纹核对向导状态。node:test + 零网络；React 只做装配。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceInfo, SyncStatus } from "@morrow/protocol/browser";
import {
  claimReview,
  conflictSourceLabel,
  describeSyncFailure,
  diffLines,
  fingerprintCheck,
  mapSyncStatus,
  normalizeFingerprintInput,
  normalizePairingCodeInput,
  pairingCountdown,
  shortFingerprint,
  syncErrorCodeLabel,
  toResolveRequest,
  type JoinWizardState,
  joinWizardNext,
} from "./device-ui.ts";

function device(partial: Partial<DeviceInfo> & { replica_id: string }): DeviceInfo {
  return {
    label: null,
    public_key: null,
    fingerprint: null,
    fingerprint_short: null,
    created_at: "2026-11-01T00:00:00.000Z",
    last_seen_at: "2026-11-01T00:00:00.000Z",
    last_sync_at: null,
    paired_at: null,
    trusted: true,
    revoked: false,
    revoked_at: null,
    ...partial,
  };
}

// --- 指纹 -------------------------------------------------------------------------

test("shortFingerprint：小写 hex 指纹转大写 4 位分组（与 runtime formatFingerprint 同口径）", () => {
  assert.equal(shortFingerprint("ab12cd34ef567890"), "AB12-CD34-EF56-7890");
  assert.equal(
    shortFingerprint("ab12cd34ef567890ab12cd34ef567890"),
    "AB12-CD34-EF56-7890-AB12-CD34-EF56-7890",
  );
  // 已带分隔符的输入也不重复加
  assert.equal(shortFingerprint("AB12-CD34-EF56-7890"), "AB12-CD34-EF56-7890");
});

test("normalizeFingerprintInput：去分隔符/空白、统一小写（人工抄写容错）", () => {
  assert.equal(normalizeFingerprintInput(" AB12-CD34 EF56-7890 \n"), "ab12cd34ef567890");
  assert.equal(normalizeFingerprintInput("zzzz"), "zzzz".replace(/[^0-9a-f]/gi, "").toLowerCase());
});

test("fingerprintCheck：空期望值不阻断（返回未核对），一致/不一致/长度不足分别给明确结论", () => {
  assert.deepEqual(fingerprintCheck("", "ab12cd34"), { ok: null, reason: "未填写对端显示值——请在确认页人工比对" });
  assert.deepEqual(fingerprintCheck("AB12-CD34", "ab12cd34"), { ok: true, reason: null });
  assert.deepEqual(fingerprintCheck("ab12cd34", "ab12c999"), { ok: false, reason: "与对端显示值不一致" });
  assert.deepEqual(fingerprintCheck("abc", "ab12cd34"), { ok: null, reason: "输入不完整（3/8 位），请核对完整指纹" });
});

// --- 配对码 -----------------------------------------------------------------------

test("normalizePairingCodeInput：只留数字并截断 6 位（粘贴带空格/连字符容错）", () => {
  assert.equal(normalizePairingCodeInput(" 123 456 "), "123456");
  assert.equal(normalizePairingCodeInput("12-34-56"), "123456");
  assert.equal(normalizePairingCodeInput("1234567"), "123456");
  assert.equal(normalizePairingCodeInput("12a"), "12");
});

test("pairingCountdown：显示剩余 mm:ss，过期后归零并提示重新生成", () => {
  const now = Date.parse("2026-11-10T10:00:00.000Z");
  const fresh = pairingCountdown("2026-11-10T10:05:00.000Z", now);
  assert.equal(fresh.expired, false);
  assert.equal(fresh.remainingMs, 300_000);
  assert.equal(fresh.label, "05:00");
  assert.equal(fresh.tone, "ok");

  const late = pairingCountdown("2026-11-10T10:00:45.000Z", now);
  assert.equal(late.label, "00:45");
  assert.equal(late.tone, "warn", "不足 1 分钟转警示色");

  const expired = pairingCountdown("2026-11-10T09:59:00.000Z", now);
  assert.equal(expired.expired, true);
  assert.equal(expired.remainingMs, 0);
  assert.equal(expired.label, "已过期");
  assert.equal(expired.tone, "error");

  const malformed = pairingCountdown("not-a-date", now);
  assert.equal(malformed.expired, true);
  assert.equal(malformed.label, "过期时间未知");
});

// --- 同步状态映射 -----------------------------------------------------------------

const SYNC_STATUS: SyncStatus = {
  replica_id: "11111111-1111-4111-8111-111111111111",
  sequence: { min: 3, max: 42, count: 40 },
  cursors: [
    {
      peer_replica_id: "22222222-2222-4222-8222-222222222222",
      last_pulled_sequence: 9,
      last_acked_sequence: 30,
      updated_at: "2026-11-10T09:00:00.000Z",
    },
    {
      peer_replica_id: "33333333-3333-4333-8333-333333333333",
      last_pulled_sequence: 17,
      last_acked_sequence: 42,
      updated_at: "2026-11-10T09:30:00.000Z",
    },
  ],
};

test("mapSyncStatus：本副本 seq 范围/条数、各 peer 游标、最后同步时间取游标最新值", () => {
  const now = Date.parse("2026-11-10T10:00:00.000Z");
  const view = mapSyncStatus(SYNC_STATUS, now);
  assert.equal(view.seqRangeLabel, "3–42");
  assert.equal(view.count, 40);
  assert.equal(view.cursors.length, 2);
  assert.equal(view.cursors[0].peerShort, "22222222");
  assert.equal(view.cursors[0].pulled, 9);
  assert.equal(view.cursors[0].acked, 30);
  assert.equal(view.lastSyncedAt, "2026-11-10T09:30:00.000Z");
  assert.equal(view.lastSyncedLabel, "30 分钟前");
  assert.equal(view.empty, false);
});

test("mapSyncStatus：待上传按 本地 seq 上界 − 已确认 估算（钳到 0 并合计），待下载因缺对端状态标未知", () => {
  const view = mapSyncStatus(SYNC_STATUS, Date.parse("2026-11-10T10:00:00.000Z"));
  assert.equal(view.cursors[0].pendingUpload, 12); // 42 - 30
  assert.equal(view.cursors[1].pendingUpload, 0); // 42 - 42
  assert.equal(view.pendingUpload, 12);
  assert.equal(view.pendingDownload, null);
  assert.match(view.pendingDownloadReason, /对端/);
});

test("mapSyncStatus：无游标（从未同步）时估算为未知、状态面板给出空态", () => {
  const empty = mapSyncStatus(
    { replica_id: "11111111-1111-4111-8111-111111111111", sequence: { min: null, max: null, count: 0 }, cursors: [] },
    Date.parse("2026-11-10T10:00:00.000Z"),
  );
  assert.equal(empty.empty, true);
  assert.equal(empty.seqRangeLabel, "空账本");
  assert.equal(empty.pendingUpload, null);
  assert.equal(empty.lastSyncedAt, null);
  assert.equal(empty.lastSyncedLabel, "从未同步");
});

test("lastSyncedLabel：分钟/小时/天与绝对时间分档（无游标时间戳时回退设备 last_sync_at）", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const at = (iso: string, lastSync: string | null = null) =>
    mapSyncStatus(
      {
        replica_id: "11111111-1111-4111-8111-111111111111",
        sequence: { min: 1, max: 1, count: 1 },
        cursors: [{ peer_replica_id: "22222222-2222-4222-8222-222222222222", last_pulled_sequence: 1, last_acked_sequence: 1, updated_at: iso }],
      },
      now,
      [device({ replica_id: "22222222-2222-4222-8222-222222222222", last_sync_at: lastSync })],
    ).lastSyncedLabel;
  assert.equal(at("2026-11-10T11:59:30.000Z"), "刚刚");
  assert.equal(at("2026-11-10T11:05:00.000Z"), "55 分钟前");
  assert.equal(at("2026-11-10T09:00:00.000Z"), "3 小时前");
  assert.equal(at("2026-11-07T12:00:00.000Z"), "3 天前");
  // 设备 last_sync_at 比游标更新时采用它（同步引擎写入的可信口径）
  const fromDevice = mapSyncStatus(
    {
      replica_id: "11111111-1111-4111-8111-111111111111",
      sequence: { min: 1, max: 1, count: 1 },
      cursors: [{ peer_replica_id: "22222222-2222-4222-8222-222222222222", last_pulled_sequence: 1, last_acked_sequence: 1, updated_at: "2026-11-10T09:00:00.000Z" }],
    },
    now,
    [device({ replica_id: "22222222-2222-4222-8222-222222222222", last_sync_at: "2026-11-10T11:30:00.000Z" })],
  );
  assert.equal(fromDevice.lastSyncedAt, "2026-11-10T11:30:00.000Z");
  assert.equal(fromDevice.lastSyncedLabel, "30 分钟前");
});

test("describeSyncFailure：sync_gap 平铺 expected/actual 明确提示缺口位置", () => {
  const notice = describeSyncFailure("sync_gap", "sequence gap detected", {
    peer_replica_id: "22222222-2222-4222-8222-222222222222",
    expected: 7,
    actual: 9,
  });
  assert.equal(notice.tone, "error");
  assert.match(notice.title, /缺口/);
  assert.match(notice.explanation, /期望 7/);
  assert.match(notice.explanation, /实际 9/);
  assert.match(notice.explanation, /22222222/);
});

test("describeSyncFailure：网络/完整性错误有可读归因，未知码回退原文", () => {
  const net = describeSyncFailure("network_error", "无法连接 Runtime 控制面");
  assert.equal(net.tone, "error");
  assert.match(net.title, /连不上|无法连接/);

  const integrity = describeSyncFailure("sync_integrity_failed", "hash mismatch");
  assert.match(integrity.explanation, /完整性/);

  const unknown = describeSyncFailure("weird_code", "boom");
  assert.equal(unknown.tone, "error");
  assert.match(unknown.explanation, /weird_code/);
  assert.match(unknown.explanation, /boom/);
  assert.equal(syncErrorCodeLabel("sync_gap"), "同步缺口");
});

// --- 冲突 -------------------------------------------------------------------------

test("diffLines：行级 LCS，unchanged/added/removed 三态且保留原文行", () => {
  const rows = diffLines("A\nB\nC", "A\nC\nD");
  assert.deepEqual(rows, [
    { kind: "same", text: "A" },
    { kind: "remove", text: "B" },
    { kind: "same", text: "C" },
    { kind: "add", text: "D" },
  ]);
});

test("diffLines：空文本与完全相同时不出假差异", () => {
  assert.deepEqual(diffLines("", "X"), [{ kind: "add", text: "X" }]);
  assert.deepEqual(diffLines("X", ""), [{ kind: "remove", text: "X" }]);
  assert.deepEqual(diffLines("same", "same"), [{ kind: "same", text: "same" }]);
});

test("conflictSourceLabel：展示来源副本与三方版本，非同步来源明确标本地", () => {
  const remote = conflictSourceLabel({
    origin: "sync",
    local_replica_id: "11111111-1111-4111-8111-111111111111",
    remote_replica_id: "22222222-2222-4222-8222-222222222222",
    local_version: 2,
    remote_version: 3,
    base_version: 2,
  });
  assert.match(remote, /22222222/);
  assert.match(remote, /本地 v2/);
  assert.match(remote, /远端 v3/);
  assert.match(remote, /基线 v2/);

  const local = conflictSourceLabel({
    origin: "local",
    local_replica_id: null,
    remote_replica_id: null,
    local_version: null,
    remote_version: null,
    base_version: null,
  });
  assert.match(local, /本机/);
});

test("toResolveRequest：keep_local→keep_old、keep_remote→keep_new、merge 必填文本", () => {
  assert.deepEqual(toResolveRequest("keep_local"), { ok: true, error: null, body: { resolution: "keep_old" } });
  assert.deepEqual(toResolveRequest("keep_remote"), { ok: true, error: null, body: { resolution: "keep_new" } });

  const missing = toResolveRequest("merge", "   ");
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? "", /合并文本/);

  const merged = toResolveRequest("merge", " 两版合并后的结论 ");
  assert.deepEqual(merged.body, { resolution: "merge", content: "两版合并后的结论" });
});

// --- 加入设备向导状态机 -----------------------------------------------------------

const BASE_JOIN: JoinWizardState = { step: "input", busy: false, error: null };

test("joinWizardNext：input --submit--> claiming --claimed--> review（展示双方指纹待核对）", () => {
  assert.equal(joinWizardNext(BASE_JOIN, { type: "submit" }), "claiming");
  assert.equal(joinWizardNext({ ...BASE_JOIN, step: "claiming", busy: true }, { type: "claimed" }), "review");
  assert.equal(joinWizardNext({ ...BASE_JOIN, step: "claiming", busy: true }, { type: "claim_failed" }), "input");
  assert.equal(joinWizardNext(BASE_JOIN, { type: "claimed" }), "input", "未提交的 claimed 事件不得跳步");
});

test("joinWizardNext：review 必须显式确认或拒绝；拒绝进入 remediation（只能撤销）", () => {
  const review: JoinWizardState = { ...BASE_JOIN, step: "review" };
  assert.equal(joinWizardNext(review, { type: "confirm" }), "done");
  assert.equal(joinWizardNext(review, { type: "reject" }), "mismatch");
  assert.equal(joinWizardNext(review, { type: "reset" }), "input");
  assert.equal(joinWizardNext(review, { type: "submit" }), "review", "review 态重复提交不重入 claim");
});

test("joinWizardNext：claiming 态禁止重复提交；error 态可重试回 input", () => {
  const claiming: JoinWizardState = { ...BASE_JOIN, step: "claiming", busy: true };
  assert.equal(joinWizardNext(claiming, { type: "submit" }), "claiming");
  assert.equal(joinWizardNext(claiming, { type: "claim_failed" }), "input");
  assert.equal(joinWizardNext({ ...BASE_JOIN, step: "done" }, { type: "reset" }), "input");
});

test("claimReview：claim 响应双方指纹 + 期望指纹比对结论（不一致时给撤销指引）", () => {
  const response = {
    token: "mrw_secret",
    paired_at: "2026-11-10T10:00:00.000Z",
    token_account: "token:11111111-1111-4111-8111-111111111111",
    device: {
      replica_id: "44444444-4444-4444-8444-444444444444",
      public_key: "pk",
      fingerprint: "abcd1234abcd1234",
      fingerprint_short: "ABCD-1234-ABCD-1234",
      label: "新笔记本",
    },
    server: {
      replica_id: "11111111-1111-4111-8111-111111111111",
      public_key: "pk2",
      fingerprint: "5678ef995678ef99",
      fingerprint_short: "5678-EF99-5678-EF99",
    },
  };
  const review = claimReview(response, "5678-ef99-5678-ef99");
  assert.equal(review.serverShort, "5678-EF99-5678-EF99");
  assert.equal(review.deviceShort, "ABCD-1234-ABCD-1234");
  assert.equal(review.deviceLabel, "新笔记本");
  assert.equal(review.matchesExpected, true);
  assert.equal(review.rejectAdvice, null);

  const mismatch = claimReview(response, "0000-0000-0000-0000");
  assert.equal(mismatch.matchesExpected, false);
  assert.match(mismatch.rejectAdvice ?? "", /撤销/);
});
