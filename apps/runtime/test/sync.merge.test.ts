// 事实三方合并分类器测试（票 M3-T3 / Issue #32，PRD §4.2 FR-DEP-5 / AC-05 前置）：
// 20 个竞争事实样本的分类必须与 M1 巩固器（DefaultConsolidator）同一口径——
// preference 自动合并、locked / sensitivity_change / fact_conflict 上报；
// 两侧并发修改的自动合并结果必须与角色无关（两端收敛到同一文本与版本）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntryKind, SensitivityLevel } from "@morrow/protocol";
import { DefaultConsolidator } from "../src/memory/consolidator.ts";
import { classifyFactMerge, deterministicWinner, type FactVersionView } from "../src/sync/merge.ts";

interface Sample {
  name: string;
  kind: MemoryEntryKind;
  localSensitivity: SensitivityLevel;
  remoteSensitivity: SensitivityLevel;
  localContent: string;
  remoteContent: string;
  /** 期望的 consolidator 分支（用于断言测试样本本身覆盖了哪些分支） */
  expect: "auto" | "locked" | "sensitivity_change" | "fact_conflict";
}

const FACT_ID = "01936b9d-8f7a-7abc-9f2e-00000000abcd";

/** 20 个竞争事实样本：6 偏好自动 + 6 重大事实 + 3 locked + 5 敏感等级变更 */
const SAMPLES: Sample[] = [
  { name: "pref-vim-emacs", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 偏好使用 vim 编辑器。", remoteContent: "Owner 偏好使用 emacs 编辑器。", expect: "auto" },
  { name: "pref-theme", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "I prefer the dark theme for the editor.", remoteContent: "I prefer the light theme for the editor.", expect: "auto" },
  { name: "pref-dark-light", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 喜欢深色主题。", remoteContent: "Owner 喜欢浅色主题。", expect: "auto" },
  { name: "pref-pnpm-npm", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 默认使用 pnpm 安装依赖。", remoteContent: "Owner 默认使用 npm 安装依赖。", expect: "auto" },
  { name: "pref-tabs-spaces", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner prefers tabs in TypeScript files.", remoteContent: "Owner prefers spaces in TypeScript files.", expect: "auto" },
  { name: "pref-font", kind: "preference", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 的编辑器字体是 JetBrains Mono。", remoteContent: "Owner 的编辑器字体是 Fira Code。", expect: "auto" },
  { name: "fact-database", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "项目使用 PostgreSQL 作为主数据库。", remoteContent: "项目使用 MySQL 作为主数据库。", expect: "fact_conflict" },
  { name: "fact-ubuntu-debian", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "部署目标是 Ubuntu 24.04。", remoteContent: "部署目标是 Debian 12。", expect: "fact_conflict" },
  { name: "fact-port", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "服务监听端口 8787。", remoteContent: "服务监听端口 9000。", expect: "fact_conflict" },
  { name: "fact-sqlite", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "Morrow runtime 使用 node:sqlite。", remoteContent: "Morrow runtime 使用 better-sqlite3。", expect: "fact_conflict" },
  { name: "fact-city", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "Owner 住在杭州。", remoteContent: "Owner 住在上海。", expect: "fact_conflict" },
  { name: "fact-branch", kind: "fact", localSensitivity: "private", remoteSensitivity: "private", localContent: "发布分支是 integration/m0。", remoteContent: "发布分支是 main。", expect: "fact_conflict" },
  { name: "locked-passport", kind: "profile", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "Owner 的护照号是 E12345678。", remoteContent: "Owner 的护照号是 E87654321。", expect: "locked" },
  { name: "locked-birthday", kind: "profile", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "Owner 的生日是 1990-01-01。", remoteContent: "Owner 的生日是 1991-01-01。", expect: "locked" },
  { name: "locked-credential", kind: "fact", localSensitivity: "locked", remoteSensitivity: "locked", localContent: "服务器根密码已托管在 1Password。", remoteContent: "服务器根密码已托管在 Bitwarden。", expect: "locked" },
  { name: "sens-address", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的家庭地址是杭州西湖区。", remoteContent: "Owner 的家庭地址是杭州滨江区。", expect: "sensitivity_change" },
  { name: "sens-phone", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的手机号是 13800000000。", remoteContent: "Owner 的手机号是 13900000000。", expect: "sensitivity_change" },
  { name: "sens-medical", kind: "fact", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的医疗记录保存在家庭医生处。", remoteContent: "Owner 的医疗记录保存在私人诊所。", expect: "sensitivity_change" },
  { name: "sens-apikey", kind: "fact", localSensitivity: "private", remoteSensitivity: "public", localContent: "客户的 API key 存放在 vault。", remoteContent: "客户的 API key 存放在环境变量。", expect: "sensitivity_change" },
  { name: "sens-bank", kind: "profile", localSensitivity: "private", remoteSensitivity: "public", localContent: "Owner 的银行账户尾号 1234。", remoteContent: "Owner 的银行账户尾号 5678。", expect: "sensitivity_change" },
];

function view(overrides: Partial<FactVersionView> & { content: string; kind: MemoryEntryKind; sensitivity: SensitivityLevel; version: number }): FactVersionView {
  return { factId: FACT_ID, updatedAt: "2026-11-10T00:00:00.000Z", ...overrides };
}

/** 三方输入：base 与 local/remote 均不同 → 两侧都算并发修改 */
function inputFor(sample: Sample): { base: FactVersionView; local: FactVersionView; remote: FactVersionView } {
  return {
    base: view({ content: `基线内容：${sample.localContent}`, kind: sample.kind, sensitivity: sample.localSensitivity, version: 2 }),
    local: view({ content: sample.localContent, kind: sample.kind, sensitivity: sample.localSensitivity, version: 3, updatedAt: "2026-11-10T01:00:00.000Z" }),
    remote: view({ content: sample.remoteContent, kind: sample.kind, sensitivity: sample.remoteSensitivity, version: 3, updatedAt: "2026-11-10T02:00:00.000Z" }),
  };
}

/** 以远端修订为候选、本地事实为既有事实，跑 M1 巩固器 */
function consolidatorAction(sample: Sample) {
  const consolidator = new DefaultConsolidator();
  const { local, remote } = inputFor(sample);
  const [action] = consolidator.consolidate({
    candidates: [{ candidateId: "remote", content: remote.content, kind: remote.kind, sensitivity: remote.sensitivity, confidence: 1, sourceId: "sync" }],
    facts: [{ factId: local.factId, content: local.content, kind: local.kind, sensitivity: local.sensitivity, version: local.version }],
  });
  assert.ok(action !== undefined);
  return action;
}

test("20 个竞争事实样本：分类与 M1 巩固器逐项一致（自动/待审核）", () => {
  assert.equal(SAMPLES.length, 20);
  const counts = { auto: 0, locked: 0, sensitivity_change: 0, fact_conflict: 0 };
  for (const sample of SAMPLES) {
    const { base, local, remote } = inputFor(sample);
    const decision = classifyFactMerge({ base, local, remote });
    const action = consolidatorAction(sample);
    if (action.action === "update_fact") {
      assert.equal(decision.action, "auto_merge", `${sample.name}: 巩固器 update_fact → 同步自动合并`);
      assert.equal((decision as { reason: string }).reason, "preference_update", sample.name);
      counts.auto += 1;
      continue;
    }
    assert.equal(action.action, "escalate", `${sample.name}: 竞争样本应上报`);
    assert.equal(decision.action, "escalate", `${sample.name}: 同步侧也应上报`);
    assert.equal((decision as { reason: string }).reason, (action as { reason: string }).reason, `${sample.name}: 上报原因一致`);
    counts[(action as { reason: "locked" | "sensitivity_change" | "fact_conflict" }).reason] += 1;
  }
  assert.deepEqual(counts, { auto: 6, locked: 3, sensitivity_change: 5, fact_conflict: 6 });
});

test("自动合并结果与角色无关：交换 local/remote 后文本与结果版本一致", () => {
  for (const sample of SAMPLES.filter((item) => item.expect === "auto")) {
    const { base, local, remote } = inputFor(sample);
    const forward = classifyFactMerge({ base, local, remote });
    const backward = classifyFactMerge({ base, local: remote, remote: local });
    assert.equal(forward.action, "auto_merge");
    assert.equal(backward.action, "auto_merge");
    assert.equal((forward as { content: string }).content, (backward as { content: string }).content, sample.name);
    assert.equal((forward as { resultVersion: number }).resultVersion, (backward as { resultVersion: number }).resultVersion, sample.name);
    assert.ok((forward as { resultVersion: number }).resultVersion > 3, "结果版本高于两侧");
  }
});

test("deterministicWinner：版本优先，其次更新时间，最后内容字典序（两端确定性）", () => {
  const a = view({ content: "a", kind: "preference", sensitivity: "private", version: 5, updatedAt: "2026-11-10T01:00:00.000Z" });
  const b = view({ content: "b", kind: "preference", sensitivity: "private", version: 4, updatedAt: "2026-11-10T09:00:00.000Z" });
  assert.deepEqual(deterministicWinner(a, b), { content: "a", sensitivity: "private" });
  const sameVersionLater = { ...b, version: 5, updatedAt: "2026-11-10T10:00:00.000Z" };
  assert.deepEqual(deterministicWinner(a, sameVersionLater), { content: "b", sensitivity: "private" });
  const sameTime = { ...sameVersionLater, updatedAt: a.updatedAt };
  assert.deepEqual(deterministicWinner(a, sameTime), { content: "b", sensitivity: "private" }, "版本/时间并列取字典序大者");
});

test("非并发情形：内容相同 → identical；远端等于基线 → stale；本地等于基线 → fast-forward", () => {
  const base = view({ content: "Owner 使用 pnpm。", kind: "preference", sensitivity: "private", version: 3 });
  const same = view({ content: "Owner 使用 pnpm。", kind: "preference", sensitivity: "private", version: 3 });
  assert.equal(classifyFactMerge({ base, local: same, remote: same }).action, "identical");

  const local = view({ content: "Owner 使用 pnpm。", kind: "preference", sensitivity: "private", version: 3 });
  const remoteChanged = view({ content: "Owner 使用 yarn。", kind: "preference", sensitivity: "private", version: 4 });
  const stale = classifyFactMerge({ base: local, local, remote: local });
  assert.equal(stale.action, "identical");

  const fastForward = classifyFactMerge({ base: local, local, remote: remoteChanged });
  assert.equal(fastForward.action, "fast_forward");
  assert.equal((fastForward as { content: string }).content, remoteChanged.content);

  const remoteIsBase = classifyFactMerge({ base, local: remoteChanged, remote: base });
  assert.equal(remoteIsBase.action, "remote_is_base");
});

test("locked 变更永不 fast-forward：即使本地内容等于基线也上报 locked", () => {
  const base = view({ content: "Owner 的护照号是 E12345678。", kind: "profile", sensitivity: "locked", version: 3 });
  const remote = view({ content: "Owner 的护照号是 E87654321。", kind: "profile", sensitivity: "locked", version: 4 });
  const decision = classifyFactMerge({ base, local: base, remote });
  assert.equal(decision.action, "escalate");
  assert.equal((decision as { reason: string }).reason, "locked");
});
