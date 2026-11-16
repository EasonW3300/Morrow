// 记忆页纯逻辑（票 M7-A-T6 / Issue #62）：视图切换、树/时间线格式化、展开状态、
// 版本链展示、来源回链跳转目标（会话已删/归档给出提示而非报错）、分页文案。
// node:test 直接跑本模块；React 只做装配与 I/O。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clusterLabel,
  entryMeta,
  formatTimestamp,
  isExpanded,
  kindLabel,
  openDirectoryHint,
  overviewViewLabel,
  pagerLabel,
  revisionChainLabel,
  sensitivityLabel,
  scopeOptions,
  sourceJumpHint,
  sourceJumpTarget,
  toggleExpanded,
  type MemoryEntryView,
  type MemorySourceView,
} from "./memory-ui.ts";

const ENTRY: MemoryEntryView = {
  id: "01936b9d-8f7a-7abc-9f2e-000000000001",
  content: "我喜欢用深色主题编辑器",
  kind: "preference",
  sensitivity: "private",
  version: 2,
  scope: "owner",
  occurred_at: "2026-11-12T09:05:00.000Z",
  createdAt: "2026-11-12T09:00:00.000Z",
  updatedAt: "2026-11-12T09:05:00.000Z",
  revisions: [2],
  revision_history: [{ version: 2, createdAt: "2026-11-12T09:05:00.000Z", reason: "preference_update", sourceEventId: "evt-2" }],
  sources: [],
};

test("视图标签与切换文案", () => {
  assert.match(overviewViewLabel("tree"), /树/);
  assert.match(overviewViewLabel("timeline"), /时间线/);
});

test("类型/敏感等级中英文标签固定", () => {
  assert.equal(kindLabel("fact"), "事实");
  assert.equal(kindLabel("preference"), "偏好");
  assert.equal(kindLabel("profile"), "画像");
  assert.equal(kindLabel("procedural"), "操作经验");
  assert.equal(sensitivityLabel("private"), "私有");
  assert.equal(sensitivityLabel("public"), "公开");
  assert.equal(sensitivityLabel("locked"), "锁定");
});

test("时间格式化：ISO → UTC `YYYY-MM-DD HH:mm`（确定性，不依赖本地时区）", () => {
  assert.equal(formatTimestamp("2026-11-12T09:05:00.000Z"), "2026-11-12 09:05");
  assert.equal(formatTimestamp("2026-11-12T09:05:00+08:00"), "2026-11-12 01:05");
  assert.equal(formatTimestamp("not-a-date"), "not-a-date");
});

test("条目摘要：类型 · 敏感等级 · 版本", () => {
  assert.equal(entryMeta(ENTRY), "偏好 · 私有 · v2");
});

test("版本链：v1 为隐式起点，修订版本号去重升序", () => {
  assert.equal(revisionChainLabel(ENTRY), "版本链 v1 → v2");
  assert.equal(revisionChainLabel({ ...ENTRY, version: 1, revisions: [] }), "版本链 v1（无修订）");
  assert.equal(
    revisionChainLabel({ ...ENTRY, version: 3, revisions: [3, 2, 3] }),
    "版本链 v1 → v2 → v3",
  );
});

test("展开状态：toggle 添加/移除，不修改原数组", () => {
  const initial: string[] = [];
  const opened = toggleExpanded(initial, "a");
  assert.deepEqual(initial, [], "原数组不被修改");
  assert.deepEqual(opened, ["a"]);
  assert.equal(isExpanded(opened, "a"), true);
  assert.equal(isExpanded(opened, "b"), false);
  assert.deepEqual(toggleExpanded(opened, "a"), []);
  assert.deepEqual(toggleExpanded(toggleExpanded(opened, "b"), "a"), ["b"]);
});

test("簇标签：有主题用主题；无主题给出稳定的兜底名", () => {
  assert.equal(clusterLabel("部署", 0), "部署");
  assert.equal(clusterLabel(null, 0), "未归类 1");
  assert.equal(clusterLabel(null, 3), "未归类 4");
});

test("来源跳转：活动会话可跳；已归档/已删除/不存在/无会话都给出提示而非抛错", () => {
  const source: MemorySourceView = {
    event_id: "evt-1",
    session_id: "s-1",
    occurred_at: "2026-11-12T09:00:00.000Z",
  };
  assert.deepEqual(sourceJumpTarget(source, [{ session_id: "s-1" }]), {
    kind: "session",
    sessionId: "s-1",
  });
  assert.equal(sourceJumpHint(source, [{ session_id: "s-1" }]), null);

  const archived = sourceJumpTarget(source, [
    { session_id: "s-1", archived_at: "2026-11-12T10:00:00.000Z" },
  ]);
  assert.equal(archived.kind, "unavailable");
  assert.match(sourceJumpHint(source, [{ session_id: "s-1", archived_at: "2026-11-12T10:00:00.000Z" }]) ?? "", /归档/);

  const deleted = sourceJumpHint(source, [
    { session_id: "s-1", deleted_at: "2026-11-12T10:00:00.000Z" },
  ]);
  assert.match(deleted ?? "", /删除/);

  const missing = sourceJumpHint(source, []);
  assert.match(missing ?? "", /不可用|找不到/);

  const orphan = sourceJumpHint({ ...source, session_id: null }, []);
  assert.match(orphan ?? "", /导入|不来自会话/);
});

test("分页文案：1 基区间 + 总数；空页给出提示", () => {
  assert.equal(pagerLabel(42, 20, 0), "第 1–20 条，共 42 条");
  assert.equal(pagerLabel(42, 20, 40), "第 41–42 条，共 42 条");
  assert.equal(pagerLabel(0, 20, 0), "共 0 条");
  assert.equal(pagerLabel(10, 20, 40), "共 10 条");
});

test("scope 选项：owner 恒在；有活动会话时追加 session:<id>", () => {
  assert.deepEqual(scopeOptions(null), [{ value: "owner", label: "长期记忆（owner）" }]);
  const options = scopeOptions("s-9");
  assert.equal(options.length, 2);
  assert.deepEqual(options[1], { value: "session:s-9", label: "当前会话（含长期记忆）" });
});

test("打开目录提示：有目录给出路径；无目录提示先投影", () => {
  assert.match(openDirectoryHint("/tmp/morrow/memory"), /\/tmp\/morrow\/memory/);
  assert.match(openDirectoryHint(null), /目录|投影/);
});
