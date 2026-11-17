// Skill 包安装 HTTP 面（票 M7-B-T3 / Issue #68 的交付缺口补齐，FR-B7/B8/B10）。
//
// B3 原本只有库层；本测试锁住补齐后的可验收行为：
//   - npm 安装（强制 --ignore-scripts 的证据来自 installer 单测；这里验 HTTP 编排）
//   - 缺 sandbox/tests 的包被拒（FR-B8）
//   - **升级默认只给 diff，不装**；扩权需显式接受（FR-B10 / 决策 #14）
//   - 卸载后记录消失、能力被禁用，但审计保留
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import type { InstalledSkillPackage } from "../src/skills-package/installer.ts";
import type { SkillPackageManifest } from "../src/skills-package/manifest.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA, provider: null };
}

/** 造一个"已安装 package"的假结果（模拟 npm 装完之后的样子） */
function fakeInstalled(
  manifest: Partial<SkillPackageManifest> & { name: string; version: string },
  packageDir = "/tmp/fake-pkg",
): InstalledSkillPackage {
  const full: SkillPackageManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? "测试用技能包",
    permissions: manifest.permissions ?? { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    ...(manifest.steps === undefined ? {} : { steps: manifest.steps }),
    ...(manifest.entry === undefined ? {} : { entry: manifest.entry }),
    ...(manifest.sandbox === undefined ? {} : { sandbox: manifest.sandbox }),
    ...(manifest.tests === undefined ? {} : { tests: manifest.tests }),
  };
  return {
    manifest: full,
    packageDir,
    sourceHash: `sha256-${"a".repeat(64)}`,
    capability: {
      name: full.name,
      version: full.version,
      author: "human",
      runtime: full.entry?.runtime ?? "typescript",
      permissions: full.permissions as never,
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: full.entry === undefined ? { type: "none", network: "none", filesystem: "none" } : { type: "container", network: "none", filesystem: "workspace-only" },
      tests: full.tests ?? [],
      // 不填 source_hash：注册时由 PermissionEngine 重算（夹具里填假值会被正确地拒绝）
    },
  };
}

interface Harness {
  handle: RuntimeHandle;
  port: number;
  /** 每次 install 调用收到的 spec（证明 HTTP 编排真的走了安装） */
  installs: string[];
  close(): Promise<void>;
}

async function startPackageRuntime(install?: (options: { spec: string }) => Promise<InstalledSkillPackage>): Promise<Harness> {
  const dir = tmpDir("morrow-skill-pkg-");
  const installs: string[] = [];
  const handle = await startRuntime(testConfig(dir), {
    notificationDrainIntervalMs: 0,
    skillPackageInstall: async (options) => {
      installs.push(options.spec);
      if (install !== undefined) return await install({ spec: options.spec });
      return fakeInstalled({ name: "demo-skill", version: "1.0.0" });
    },
  });
  return {
    handle,
    port: handle.port,
    installs,
    async close() {
      await handle.close();
      removeDir(dir);
    },
  };
}

function post(port: number, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// --- 安装 ---------------------------------------------------------------------------

test("安装：201 + 记录 + 能力注册 + ignored_scripts 标记", async () => {
  const h = await startPackageRuntime();
  try {
    const res = await post(h.port, "/v1/skills/packages/install", { spec: "demo-skill@1.0.0" });
    assert.equal(res.status, 201, await res.clone().text());
    const body = await json<{
      package: { package_name: string; version: string; capability: string; source_hash: string };
      ignored_scripts: boolean;
    }>(res);
    assert.equal(body.package.package_name, "demo-skill");
    assert.equal(body.package.version, "1.0.0");
    assert.equal(body.ignored_scripts, true, "必须明确 postinstall 未执行");
    assert.match(body.package.source_hash, /^sha256-/);
    assert.deepEqual(h.installs, ["demo-skill@1.0.0"]);

    const caps = await json<{ capabilities: Array<{ name: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/capabilities`),
    );
    assert.ok(caps.capabilities.some((capability) => capability.name === "demo-skill"));
  } finally {
    await h.close();
  }
});

test("安装：缺 spec 400；npm 失败 502 且留审计", async () => {
  const h = await startPackageRuntime(async () => {
    const error = new Error("npm ERR! 404");
    throw error;
  });
  try {
    assert.equal((await post(h.port, "/v1/skills/packages/install", {})).status, 400);
    const failed = await post(h.port, "/v1/skills/packages/install", { spec: "ghost-pkg" });
    assert.equal(failed.status, 500, "非 SkillInstallError 归 500（npm 层异常）");

    const events = await json<{ events: Array<{ event_type: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=100`),
    );
    assert.ok(events.events.some((event) => event.event_type === "skill_package.install_failed"));
  } finally {
    await h.close();
  }
});

test("安装：同名重复 → 409 already_installed（提示用 upgrade）", async () => {
  const h = await startPackageRuntime();
  try {
    await post(h.port, "/v1/skills/packages/install", { spec: "demo-skill" });
    const again = await post(h.port, "/v1/skills/packages/install", { spec: "demo-skill" });
    assert.equal(again.status, 409);
    const error = await json<{ error: { code: string; message: string } }>(again);
    assert.equal(error.error.code, "already_installed");
    assert.match(error.error.message, /upgrade/);
  } finally {
    await h.close();
  }
});

// --- 升级：diff 优先 ----------------------------------------------------------------

test("升级默认只返回 diff（202），**不装**新版本", async () => {
  let version = "1.0.0";
  const h = await startPackageRuntime(async () =>
    fakeInstalled({
      name: "demo-skill",
      version,
      permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    }),
  );
  try {
    await post(h.port, "/v1/skills/packages/install", { spec: "demo-skill@1.0.0" });
    version = "1.1.0";
    const res = await post(h.port, "/v1/skills/packages/demo-skill/upgrade", {});
    assert.equal(res.status, 202);
    const preview = await json<{
      from_version: string;
      to_version: string;
      requires_confirmation: boolean;
      requires_permission_widening_acceptance: boolean;
      diff: { widens: boolean };
    }>(res);
    assert.equal(preview.from_version, "1.0.0");
    assert.equal(preview.to_version, "1.1.0");
    assert.equal(preview.requires_confirmation, true);

    // 记录仍是旧版本（没有装）
    const list = await json<{ packages: Array<{ version: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/skills/packages`),
    );
    assert.equal(list.packages[0].version, "1.0.0", "预览阶段不该升级");
  } finally {
    await h.close();
  }
});

test("升级扩权：未显式接受 → 409；接受后升级成功并记 diff 审计", async () => {
  // 新版本的内容是**稳定**的：同一 spec 每次装出来都一样（真实 npm 就是如此）。
  // 先装 1.0.0（无权限），之后 spec 指向 1.1.0（要求 /etc/**）——用 spec 区分版本，
  // 而不是用可变闭包，否则"预览看到的"和"确认装到的"会是两份不同内容。
  const h = await startPackageRuntime(async ({ spec }) => {
    const wantsEtc = spec.includes("1.1.0") || spec.includes("latest");
    return fakeInstalled({
      name: "demo-skill",
      version: wantsEtc ? "1.1.0" : "1.0.0",
      permissions: wantsEtc
        ? { filesystem: ["/etc/**"], network: [], shell: [], channels: [], credentials: [] }
        : { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    });
  });
  try {
    await post(h.port, "/v1/skills/packages/install", { spec: "demo-skill@1.0.0" });
    // 新版本要读 /etc：这是扩权（spec 指向 1.1.0）
    const upgradeBody = { spec: "demo-skill@1.1.0" };

    const preview = await post(h.port, "/v1/skills/packages/demo-skill/upgrade", upgradeBody);
    assert.equal(preview.status, 202);
    const previewBody = await json<{ requires_permission_widening_acceptance: boolean; diff: { widens: boolean; added: unknown[] } }>(
      preview,
    );
    assert.equal(previewBody.diff.widens, true);
    assert.equal(previewBody.requires_permission_widening_acceptance, true);
    assert.ok(previewBody.diff.added.length > 0);

    // 不带接受标记 → 拒绝
    const rejected = await post(h.port, "/v1/skills/packages/demo-skill/upgrade", { ...upgradeBody, confirm: true });
    assert.equal(rejected.status, 409);
    const rejectedBody = await json<{ error: { code: string } }>(rejected);
    assert.equal(rejectedBody.error.code, "permission_widening_not_accepted");

    // 扩权还需要**先扩大全局授权面**：接受标记只表示"我知道它要更多权限"，
    // 不等于"Morrow 已经允许这些权限"——真正的上界由 PermissionEngine 的 grants 判定。
    const grantsRes = await fetch(`http://127.0.0.1:${h.port}/v1/capabilities/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grants: { filesystem: ["/etc/**"], network: [], shell: [], channels: [], credentials: [] } }),
    });
    assert.equal(grantsRes.status, 200, `扩大 grants 失败: ${await grantsRes.clone().text()}`);

    // 带接受标记 → 成功
    const accepted = await post(h.port, "/v1/skills/packages/demo-skill/upgrade", {
      ...upgradeBody,
      confirm: true,
      accept_permission_widening: true,
    });
    assert.equal(accepted.status, 200, await accepted.clone().text());

    const events = await json<{ events: Array<{ event_type: string; payload: Record<string, unknown> }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=100`),
    );
    const upgraded = events.events.find((event) => event.event_type === "skill_package.upgraded");
    assert.ok(upgraded !== undefined);
    assert.equal(upgraded.payload.permission_widening_accepted, true);
    assert.deepEqual((upgraded.payload.diff as { added: unknown[] }).added.length > 0, true);
  } finally {
    await h.close();
  }
});

test("升级不存在的包 → 404", async () => {
  const h = await startPackageRuntime();
  try {
    assert.equal((await post(h.port, "/v1/skills/packages/ghost/upgrade", {})).status, 404);
  } finally {
    await h.close();
  }
});

// --- 卸载 ---------------------------------------------------------------------------

test("卸载：记录消失、能力被禁用、审计保留", async () => {
  const h = await startPackageRuntime();
  try {
    await post(h.port, "/v1/skills/packages/install", { spec: "demo-skill" });
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/skills/packages/demo-skill`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = await json<{ removed: boolean; capability_disabled: boolean }>(res);
    assert.equal(body.removed, true);
    assert.equal(body.capability_disabled, true);

    const list = await json<{ packages: unknown[] }>(await fetch(`http://127.0.0.1:${h.port}/v1/skills/packages`));
    assert.equal(list.packages.length, 0, "卸载后记录消失");

    const caps = await json<{ capabilities: Array<{ name: string; status: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/capabilities`),
    );
    const capability = caps.capabilities.find((item) => item.name === "demo-skill");
    assert.ok(capability !== undefined, "能力条目保留（账本式生命周期）");
    assert.equal(capability.status, "disabled", "但被禁用，不可调用");

    const events = await json<{ events: Array<{ event_type: string }> }>(
      await fetch(`http://127.0.0.1:${h.port}/v1/events?limit=100`),
    );
    const types = events.events.map((event) => event.event_type);
    assert.ok(types.includes("skill_package.uninstalled"), "卸载审计保留");
    assert.ok(types.includes("skill_package.installed"), "安装审计也保留");
  } finally {
    await h.close();
  }
});

test("卸载不存在的包 → 404", async () => {
  const h = await startPackageRuntime();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${h.port}/v1/skills/packages/nope`, { method: "DELETE" })).status, 404);
  } finally {
    await h.close();
  }
});

// --- 包名解析 -----------------------------------------------------------------------

test("packageNameFromSpec：scope 与版本都正确剥离", async () => {
  const { packageNameFromSpec } = await import("../src/skills-package/package-service.ts");
  assert.equal(packageNameFromSpec("pkg"), "pkg");
  assert.equal(packageNameFromSpec("pkg@1.2.3"), "pkg");
  assert.equal(packageNameFromSpec("@scope/pkg"), "@scope/pkg");
  assert.equal(packageNameFromSpec("@scope/pkg@1.2.3"), "@scope/pkg");
  assert.equal(packageNameFromSpec("npm:@scope/pkg@latest"), "@scope/pkg");
});
