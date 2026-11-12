// 只读记忆视图端到端测试（票 M7-A-T6 / Issue #62）：
//   GET /v1/memory/overview?view=tree|timeline&scope=owner|session:<id>
//   - tree 按 kind 分组 + 弱主题聚类（复用 consolidator 显著词元），确定性稳定
//   - timeline 按 occurred_at 倒序分页（limit/offset）
//   - 每条含 revisions 版本链（版本号列表）与 sources（event_id + session_id + occurred_at）
//   - scope 隔离：临时会话记忆不出现在 owner 树，在 session 作用域可见
//   - 只读：PUT/DELETE /v1/memory/overview → 405
// 接缝：HTTP 控制 API（与 memory.*.api.test.ts 同款黑盒口径，FakePi 无网络）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, type FakeStep, type MorrowTool } from "@morrow/pi-adapter";
import type { EventEnvelope } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

interface ApiError {
  error: { code: string; message: string };
}

interface OverviewSource {
  event_id: string;
  session_id: string | null;
  occurred_at: string;
}

interface OverviewRevision {
  version: number;
  created_at: string;
  reason: string | null;
}

interface OverviewEntry {
  id: string;
  content: string;
  kind: string;
  sensitivity: string;
  version: number;
  scope: string;
  occurred_at: string;
  revisions: number[];
  revision_history: OverviewRevision[];
  sources: OverviewSource[];
}

interface TreeCluster {
  theme: string | null;
  entries: OverviewEntry[];
}

interface TreeGroup {
  kind: string;
  count: number;
  clusters: TreeCluster[];
}

interface TreeBody {
  view: "tree";
  scope: string;
  directory: string;
  total: number;
  groups: TreeGroup[];
}

interface TimelineBody {
  view: "timeline";
  scope: string;
  directory: string;
  total: number;
  limit: number;
  offset: number;
  entries: OverviewEntry[];
}

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

function fakeFactory(script: FakeStep[]) {
  return async (_sessionId: string, _provider: unknown, extras?: { tools?: MorrowTool[] }) =>
    createFakePi({ script, tools: extras?.tools ?? [] });
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function allEvents(port: number): Promise<EventEnvelope[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<{ events: EventEnvelope[] }>(res)).events;
}

async function createSession(port: number, body: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  return (await json<{ session_id: string }>(res)).session_id;
}

/** 发消息并等本轮后台抽取/巩固落定（看到本轮 memory.extracted 即整轮完成） */
async function sendAndSettle(port: number, sessionId: string, text: string): Promise<void> {
  const before = (await allEvents(port)).filter((e) => e.event_type === "message.assistant").length;
  const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 202);
  await waitFor("message.assistant", async () =>
    (await allEvents(port)).filter((e) => e.event_type === "message.assistant").length > before,
  );
  const assistantId = (await allEvents(port))
    .filter((e) => e.event_type === "message.assistant")
    .at(-1)?.event_id;
  await waitFor("memory.extracted for this turn", async () =>
    (await allEvents(port)).some((e) => e.event_type === "memory.extracted" && e.causation_id === assistantId),
  );
}

/** 采纳全部待确认候选（让低置信规则命中也变成长期事实；accept 即授权巩固） */
async function acceptAllPending(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/candidates?status=pending`);
  assert.equal(res.status, 200);
  const { candidates } = await json<{ candidates: Array<{ candidate_id: string }> }>(res);
  for (const candidate of candidates) {
    const decided = await fetch(
      `http://127.0.0.1:${port}/v1/memory/candidates/${candidate.candidate_id}/decide`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "accept" }),
      },
    );
    assert.equal(decided.status, 200, await decided.text());
  }
}

async function overview(
  port: number,
  query: Record<string, string | number> = {},
): Promise<{ status: number; body: TreeBody | TimelineBody | ApiError }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  const res = await fetch(`http://127.0.0.1:${port}/v1/memory/overview?${params.toString()}`);
  return { status: res.status, body: (await res.json()) as TreeBody | TimelineBody | ApiError };
}

/** 四条不同 kind 的长期记忆（同一会话；消息间隔 5ms 保证 occurred_at 严格递增） */
async function seedOwnerMemory(port: number, sessionId: string): Promise<void> {
  await sendAndSettle(port, sessionId, "请记住 周五下午三点复盘");
  await acceptAllPending(port);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sendAndSettle(port, sessionId, "我喜欢用深色主题编辑器");
  await acceptAllPending(port);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sendAndSettle(port, sessionId, "我是软件工程师");
  await acceptAllPending(port);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sendAndSettle(port, sessionId, "以后每次部署前先跑完整测试");
  await acceptAllPending(port);
}

test("tree：按 kind 分组（固定顺序），组内弱主题聚类稳定，条目带类型/敏感/版本", async () => {
  const dir = tmpDir("morrow-ov-tree-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["好的"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port, { title: "记忆树" });
    await seedOwnerMemory(runtime.port, sessionId);

    const first = await overview(runtime.port, { view: "tree" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const tree = first.body as TreeBody;
    assert.equal(tree.view, "tree");
    assert.equal(tree.scope, "owner");
    assert.equal(tree.total, 4);
    assert.deepEqual(tree.groups.map((group) => group.kind), ["fact", "preference", "profile", "procedural"]);
    assert.deepEqual(tree.groups.map((group) => group.count), [1, 1, 1, 1]);
    const flat = tree.groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.entries));
    assert.equal(flat.length, 4);
    for (const entry of flat) {
      assert.equal(typeof entry.id, "string");
      assert.equal(entry.scope, "owner");
      assert.equal(entry.sensitivity, "private");
      assert.equal(entry.version, 1);
      assert.deepEqual(entry.revisions, []);
      assert.ok(entry.sources.length >= 1, "每条事实至少一个来源事件");
    }
    assert.ok(tree.directory.endsWith("memory"), "响应带记忆投影目录（打开目录入口用）");

    // 确定性：同一输入两次结果完全一致
    const second = await overview(runtime.port, { view: "tree" });
    assert.deepEqual(second.body, first.body);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("tree 聚类结构：同 kind 的多条事实各自/按主题成簇，响应稳定可重复", async () => {
  const dir = tmpDir("morrow-ov-cluster-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["好的"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port, {});
    // 两条 fact kind、显著词元互不相交 → 巩固新建两条事实，树里各成一簇
    await sendAndSettle(runtime.port, sessionId, "请记住 周五下午三点复盘");
    await acceptAllPending(runtime.port);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sendAndSettle(runtime.port, sessionId, "请记住 备用钥匙放在书房抽屉");
    await acceptAllPending(runtime.port);

    const res = await overview(runtime.port, { view: "tree" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const tree = res.body as TreeBody;
    const group = tree.groups.find((item) => item.kind === "fact");
    assert.ok(group);
    assert.equal(group.count, 2);
    assert.equal(group.clusters.length, 2, "词元不相交 → 两个簇");
    for (const cluster of group.clusters) {
      assert.equal(cluster.entries.length, 1);
      assert.notEqual(cluster.theme, null, "有显著词元的条目有主题标签");
    }
    const themes = group.clusters.map((cluster) => cluster.theme);
    assert.equal(new Set(themes).size, themes.length, "不同簇主题标签不同");
    // 同一输入两次结果完全一致（聚类只做展示分组，不持久化）
    assert.deepEqual((await overview(runtime.port, { view: "tree" })).body, tree);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("timeline：occurred_at 倒序分页（limit/offset），total 为全集", async () => {
  const dir = tmpDir("morrow-ov-timeline-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["好的"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port, {});
    await seedOwnerMemory(runtime.port, sessionId);

    const all = await overview(runtime.port, { view: "timeline", limit: 200, offset: 0 });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const full = all.body as TimelineBody;
    assert.equal(full.total, 4);
    assert.equal(full.entries.length, 4);
    const occurred = full.entries.map((entry) => Date.parse(entry.occurred_at));
    assert.deepEqual(occurred, [...occurred].sort((a, b) => b - a), "倒序");
    assert.match(full.entries[0].content, /部署前先跑完整测试/, "最后说出的记忆排最前");

    const page1 = (await overview(runtime.port, { view: "timeline", limit: 2, offset: 0 })).body as TimelineBody;
    const page2 = (await overview(runtime.port, { view: "timeline", limit: 2, offset: 2 })).body as TimelineBody;
    assert.equal(page1.limit, 2);
    assert.equal(page2.offset, 2);
    assert.deepEqual(
      [...page1.entries, ...page2.entries].map((entry) => entry.id),
      full.entries.map((entry) => entry.id),
      "两页拼起来等于全集，不丢不重",
    );

    const bad = await overview(runtime.port, { view: "timeline", limit: 0 });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as ApiError).error.code, "invalid_query");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("revisions：偏好更新留版本链（版本号列表 + 概要），且 sources 可回链账本事件", async () => {
  const dir = tmpDir("morrow-ov-revisions-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["好的"] }]),
  });
  try {
    const sessionId = await createSession(runtime.port, {});
    await sendAndSettle(runtime.port, sessionId, "我喜欢用深色主题编辑器");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sendAndSettle(runtime.port, sessionId, "我喜欢用浅色主题编辑器");

    const res = await overview(runtime.port, { view: "timeline" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const entries = (res.body as TimelineBody).entries;
    const preference = entries.find((entry) => entry.kind === "preference");
    assert.ok(preference);
    assert.equal(preference.version, 2, "偏好自动更新推进版本");
    assert.deepEqual(preference.revisions, [2], "revisions 是版本号列表");
    assert.equal(preference.revision_history.length, 1);
    assert.equal(preference.revision_history[0].version, 2);
    assert.equal(preference.revision_history[0].reason, "preference_update");

    // 来源回链可解析到账本事件：event_id 存在，session_id/occurred_at 与账本一致
    const events = await allEvents(runtime.port);
    assert.ok(preference.sources.length >= 2, "两条偏好陈述各贡献一个来源");
    for (const source of preference.sources) {
      const event = events.find((item) => item.event_id === source.event_id);
      assert.ok(event, `来源事件 ${source.event_id} 在账本中`);
      assert.equal(source.session_id, sessionId);
      assert.equal(source.occurred_at, event.occurred_at);
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("scope 隔离：临时会话记忆不进 owner 树；session:<id> 返回 owner ∪ 该会话", async () => {
  const dir = tmpDir("morrow-ov-scope-");
  const runtime = await startRuntime(testConfig(dir), {
    agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["记住了"] }]),
  });
  try {
    const normal = await createSession(runtime.port, {});
    await sendAndSettle(runtime.port, normal, "请记住 周五下午三点复盘");
    const ephemeral = await createSession(runtime.port, { kind: "ephemeral" });
    await sendAndSettle(runtime.port, ephemeral, "请记住 我的备用钥匙放在书房抽屉");

    const owner = (await overview(runtime.port, { view: "tree" })).body as TreeBody;
    const ownerContents = owner.groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.entries.map((entry) => entry.content)));
    assert.ok(ownerContents.some((content) => content.includes("周五下午三点复盘")));
    assert.equal(
      ownerContents.some((content) => content.includes("备用钥匙")),
      false,
      "临时会话记忆不出现在全局树",
    );
    for (const group of owner.groups) {
      for (const cluster of group.clusters) {
        for (const entry of cluster.entries) assert.equal(entry.scope, "owner");
      }
    }

    const scoped = (await overview(runtime.port, { view: "tree", scope: `session:${ephemeral}` })).body as TreeBody;
    assert.equal(scoped.scope, `session:${ephemeral}`);
    assert.equal(scoped.total, 2, "session 作用域 = owner ∪ 该会话");
    const scopedContents = scoped.groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.entries.map((entry) => entry.content)));
    assert.ok(scopedContents.some((content) => content.includes("备用钥匙")));
    assert.ok(scopedContents.some((content) => content.includes("周五下午三点复盘")));

    // 非法 scope / view
    const badScope = await overview(runtime.port, { view: "tree", scope: "session:" });
    assert.equal(badScope.status, 400);
    const badView = await overview(runtime.port, { view: "graph" });
    assert.equal(badView.status, 400);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("只读：overview 无写端点（PUT/DELETE → 405，Allow: GET）", async () => {
  const dir = tmpDir("morrow-ov-readonly-");
  const runtime = await startRuntime(testConfig(dir), { agentAdapterFactory: fakeFactory([{ kind: "text", deltas: ["ok"] }]) });
  try {
    for (const method of ["PUT", "DELETE", "POST", "PATCH"]) {
      const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/memory/overview`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({}),
      });
      assert.equal(res.status, 405, `${method} 不允许`);
      const body = (await res.json()) as ApiError;
      assert.equal(body.error.code, "method_not_allowed");
      assert.equal(res.headers.get("allow"), "GET");
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
