// PermissionEngine 单元测试（票 M2-T1 / Issue #22）：五维判定口径（glob 包含 /
// host:port / 命令类别 / 渠道 / 凭据）、manifest 校验、注册幂等与版本不可变、
// 生命周期审计、grants 持久化、assertRuntimeUse 双重复核。
// seam：engine 导出的纯判定函数 + PermissionEngine（库形态，tmpdir + 真实账本）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityManifest, PermissionGrant } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import {
  CapabilityError,
  PermissionEngine,
  checkPermissionsWithinGrants,
  computeSourceHash,
  filesystemGlobWithin,
  networkTargetWithin,
  parseHostPort,
  pathWithinGlob,
  shellCategoryWithin,
  validateManifest,
} from "../src/capabilities/engine.ts";
import { CAPABILITY_EVENT_TYPES } from "../src/capabilities/engine.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 最小合法 manifest（五维全空，human）：overrides 覆盖任意字段 */
function makeManifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    name: "docx-to-markdown",
    version: "1.0.0",
    author: "human",
    runtime: "typescript",
    permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: { type: "none", network: "none", filesystem: "none" },
    tests: [],
    ...overrides,
  };
}

interface Harness {
  dir: string;
  ledger: EventLedger;
  engine: PermissionEngine;
  eventTypes(): string[];
}

function openEngine(dir: string): Harness {
  const ledger = EventLedger.open(dir);
  const engine = new PermissionEngine({ dataDir: dir, ledger, replicaId: REPLICA });
  return {
    dir,
    ledger,
    engine,
    eventTypes: () => ledger.scan().map((e) => e.envelope.event_type),
  };
}

// --- filesystem glob 包含判定 -------------------------------------------------

test("filesystem glob 包含：单段通配覆盖字面与自身，不覆盖跨段 **", () => {
  assert.equal(filesystemGlobWithin("workspace://input/a.md", "workspace://input/*"), true);
  assert.equal(filesystemGlobWithin("workspace://input/a.md", "workspace://input/*.md"), true);
  assert.equal(filesystemGlobWithin("workspace://input/**", "workspace://input/*"), false);
  assert.equal(filesystemGlobWithin("*.md", "*"), true);
  assert.equal(filesystemGlobWithin("*", "*.md"), false);
  assert.equal(filesystemGlobWithin("a/*/b", "a/*"), false);
});

test("filesystem glob 包含：** 跨段包含关系", () => {
  assert.equal(filesystemGlobWithin("workspace://input/**", "workspace://**"), true);
  assert.equal(filesystemGlobWithin("workspace://input/x/**", "workspace://input/**"), true);
  assert.equal(filesystemGlobWithin("workspace://input/**", "workspace://input/**"), true);
  assert.equal(filesystemGlobWithin("workspace://other/**", "workspace://input/**"), false);
  assert.equal(filesystemGlobWithin("workspace://**", "workspace://input/**"), false);
  assert.equal(filesystemGlobWithin("a/**/b", "a/**"), true);
  assert.equal(filesystemGlobWithin("a/*", "a/**"), true);
  assert.equal(filesystemGlobWithin("a/b", "a/**"), true);
  assert.equal(filesystemGlobWithin("a", "a/**"), true);
  assert.equal(filesystemGlobWithin("**", "a/**"), false);
});

test("路径匹配（运行时口径）：** 跨段、* 单段内", () => {
  assert.equal(pathWithinGlob("/tmp/morrow/x/y.txt", "/tmp/morrow/**"), true);
  assert.equal(pathWithinGlob("workspace://input/a.md", "workspace://input/**"), true);
  assert.equal(pathWithinGlob("workspace://input/a.md", "workspace://input/*.md"), true);
  assert.equal(pathWithinGlob("workspace://input/sub/a.md", "workspace://input/*.md"), false);
  assert.equal(pathWithinGlob("/etc/passwd", "workspace://**"), false);
});

// --- network 判定 -------------------------------------------------------------

test("network host:port：grant 侧 * 通配一部分，请求侧必须具体", () => {
  assert.equal(networkTargetWithin("api.example.com:443", "api.example.com:*"), true);
  assert.equal(networkTargetWithin("api.example.com:443", "api.example.com:443"), true);
  assert.equal(networkTargetWithin("api.example.com:443", "*:*"), true);
  assert.equal(networkTargetWithin("api.example.com:443", "*:443"), true);
  assert.equal(networkTargetWithin("api.example.com:443", "api.example.com:8443"), false);
  assert.equal(networkTargetWithin("evil.com:443", "api.example.com:*"), false);
  assert.equal(networkTargetWithin("api.example.com:*", "api.example.com:*"), false, "请求侧通配一律不覆盖");
});

test("parseHostPort 形态判定", () => {
  assert.deepEqual(parseHostPort("api.example.com:443"), { host: "api.example.com", port: "443" });
  assert.deepEqual(parseHostPort("api.example.com:*"), { host: "api.example.com", port: "*" });
  assert.equal(parseHostPort("noport"), null);
  assert.equal(parseHostPort("host:0"), null);
  assert.equal(parseHostPort("host:99999"), null);
});

// --- shell / channels / credentials 判定 --------------------------------------

test("shell 类别：arbitrary 是晶格顶", () => {
  assert.equal(shellCategoryWithin("vcs", ["vcs", "build"]), true);
  assert.equal(shellCategoryWithin("write", ["vcs", "build"]), false);
  assert.equal(shellCategoryWithin("write", ["arbitrary"]), true);
  assert.equal(shellCategoryWithin("arbitrary", ["arbitrary"]), true);
  assert.equal(shellCategoryWithin("arbitrary", ["vcs", "build"]), false, "部分类别不覆盖 arbitrary");
});

// --- 五维逐一判定（负样例口径） ------------------------------------------------

test("checkPermissionsWithinGrants：五维越权各产出一条含维与项的 violation", () => {
  const grant: PermissionGrant = {
    filesystem: ["workspace://input/**"],
    network: ["api.example.com:443"],
    shell: ["read"],
    channels: ["desktop"],
    credentials: ["cred-1"],
  };
  const violations = checkPermissionsWithinGrants(
    {
      filesystem: ["workspace://secrets/**"],
      network: ["evil.com:443"],
      shell: ["arbitrary"],
      channels: ["qq"],
      credentials: ["cred-9"],
    },
    grant,
  );
  const byDim = new Map(violations.map((v) => [v.dimension, v]));
  assert.equal(violations.length, 5, "五维各一条");
  for (const dim of ["filesystem", "network", "shell", "channels", "credentials"] as const) {
    const v = byDim.get(dim);
    assert.ok(v !== undefined, `${dim} 有 violation`);
    assert.match(v.reason, /no grant covers/, `${dim} 的 reason 指明超界项`);
  }
  assert.equal(byDim.get("filesystem")?.requested, "workspace://secrets/**");
  assert.equal(byDim.get("network")?.requested, "evil.com:443");
  assert.equal(byDim.get("shell")?.requested, "arbitrary");
  assert.equal(byDim.get("channels")?.requested, "qq");
  assert.equal(byDim.get("credentials")?.requested, "cred-9");
  assert.deepEqual(checkPermissionsWithinGrants({ filesystem: [], network: [], shell: [], channels: [], credentials: [] }, grant), []);
});

// --- manifest 校验 --------------------------------------------------------------

test("manifest 校验：五维缺一不可；ai 作者强制 tests 非空与沙箱", () => {
  assert.doesNotThrow(() => validateManifest(makeManifest()));
  const missing = makeManifest();
  delete (missing.permissions as unknown as Record<string, unknown>).network;
  assert.throws(() => validateManifest(missing), (err: CapabilityError) => err.code === "invalid_manifest");
  assert.throws(
    () => validateManifest(makeManifest({ author: "ai", tests: [] })),
    (err: CapabilityError) => err.code === "invalid_manifest",
  );
  assert.throws(
    () => validateManifest(makeManifest({ author: "ai", tests: ["t.yaml"], sandbox: { type: "none", network: "none", filesystem: "none" } })),
    (err: CapabilityError) => err.code === "sandbox_required",
  );
  assert.doesNotThrow(() =>
    validateManifest(makeManifest({ author: "ai", tests: ["t.yaml"], sandbox: { type: "container", network: "none", filesystem: "workspace-only" } })),
  );
  assert.throws(
    () => validateManifest(makeManifest({ name: "Bad Name" })),
    (err: CapabilityError) => err.code === "invalid_manifest",
  );
  assert.throws(
    () => validateManifest(makeManifest({ version: "1.0" })),
    (err: CapabilityError) => err.code === "invalid_manifest",
  );
  assert.throws(
    () => validateManifest(makeManifest({ permissions: { filesystem: [], network: ["h:*"], shell: [], channels: [], credentials: [] } })),
    (err: CapabilityError) => err.code === "invalid_manifest",
    "请求侧 network 通配拒绝",
  );
});

test("computeSourceHash：去 source_hash 后 canonicalJson 的 sha256；内容变则哈希变", () => {
  const m1 = makeManifest();
  const m2 = makeManifest({ version: "1.1.0" });
  const h1 = computeSourceHash(m1);
  assert.match(h1, /^sha256-[0-9a-f]{64}$/);
  assert.equal(computeSourceHash({ ...m1, source_hash: "sha256-" + "0".repeat(64) }), h1, "source_hash 字段本身不参与哈希");
  assert.notEqual(computeSourceHash(m2), h1);
});

// --- 注册 / 幂等 / 版本不可变 ---------------------------------------------------

function cleanup(t: { after(fn: () => unknown): void }, dir: string): void {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
}

test("注册：human 默认 enabled + capability.registered 审计；重复注册幂等不再审计", (t) => {
  const dir = tmpDir("morrow-cap-eng-");
  cleanup(t, dir);
  const h = openEngine(dir);
  const first = h.engine.register(makeManifest());
  assert.equal(first.created, true);
  assert.equal(first.record.status, "enabled");
  assert.equal(first.record.source_hash, computeSourceHash(makeManifest()));
  assert.ok(first.eventId !== null);
  assert.ok(h.eventTypes().includes(CAPABILITY_EVENT_TYPES.registered));

  const second = h.engine.register(makeManifest());
  assert.equal(second.created, false);
  assert.equal(second.eventId, null);
  assert.equal(h.eventTypes().filter((e) => e === CAPABILITY_EVENT_TYPES.registered).length, 1);
  h.engine.close();
  h.ledger.close();
});

test("注册：ai 默认 disabled（允许生成≠允许扩权）", (t) => {
  const dir = tmpDir("morrow-cap-ai-");
  cleanup(t, dir);
  const h = openEngine(dir);
  const result = h.engine.register(
    makeManifest({ author: "ai", tests: ["t.yaml"], sandbox: { type: "container", network: "none", filesystem: "workspace-only" } }),
  );
  assert.equal(result.record.status, "disabled");
  h.engine.close();
  h.ledger.close();
});

test("同版本不同内容 → version_conflict（版本不可变，rollback 的依据）", (t) => {
  const dir = tmpDir("morrow-cap-imm-");
  cleanup(t, dir);
  const h = openEngine(dir);
  h.engine.register(makeManifest());
  assert.throws(
    () => h.engine.register(makeManifest({ input_schema: { type: "object", required: ["file"] } })),
    (err: CapabilityError) => err.code === "version_conflict",
  );
  h.engine.close();
  h.ledger.close();
});

test("新版本：版本历史追加 + 当前指针前移 + status 保持；回滚指回历史版本并审计", (t) => {
  const dir = tmpDir("morrow-cap-ver-");
  cleanup(t, dir);
  const h = openEngine(dir);
  h.engine.register(makeManifest({ version: "1.0.0" }));
  h.engine.disable("docx-to-markdown");
  const v2 = h.engine.register(makeManifest({ version: "1.1.0", input_schema: { type: "object", required: ["file"] } }));
  assert.equal(v2.record.version, "1.1.0");
  assert.equal(v2.record.status, "disabled", "状态不随注册变化");

  const detail = h.engine.get("docx-to-markdown");
  assert.ok(detail !== null);
  assert.deepEqual(detail.versions.map((v) => v.version), ["1.0.0", "1.1.0"]);

  const rolled = h.engine.rollback("docx-to-markdown", "1.0.0");
  assert.equal(rolled.from_version, "1.1.0");
  assert.equal(rolled.to_version, "1.0.0");
  assert.equal(rolled.record.version, "1.0.0");
  const { source_hash: _hash, ...rolledManifest } = rolled.record.manifest;
  assert.deepEqual(rolledManifest, makeManifest({ version: "1.0.0" }));

  assert.throws(
    () => h.engine.rollback("docx-to-markdown", "9.9.9"),
    (err: CapabilityError) => err.code === "version_not_found",
  );
  assert.throws(
    () => h.engine.rollback("docx-to-markdown", "1.0.0"),
    (err: CapabilityError) => err.code === "invalid_state",
  );
  const types = h.eventTypes();
  assert.ok(types.includes(CAPABILITY_EVENT_TYPES.disabled));
  assert.ok(types.includes(CAPABILITY_EVENT_TYPES.rolledBack));
  h.engine.close();
  h.ledger.close();
});

test("enable/disable：状态迁移审计；重复 enable 不重复审计；未知能力 404 语义", (t) => {
  const dir = tmpDir("morrow-cap-life-");
  cleanup(t, dir);
  const h = openEngine(dir);
  h.engine.register(makeManifest());
  const disabled = h.engine.disable("docx-to-markdown");
  assert.equal(disabled.changed, true);
  assert.equal(disabled.record.status, "disabled");
  const again = h.engine.disable("docx-to-markdown");
  assert.equal(again.changed, false);
  assert.equal(h.eventTypes().filter((e) => e === CAPABILITY_EVENT_TYPES.disabled).length, 1);
  const enabled = h.engine.enable("docx-to-markdown");
  assert.equal(enabled.changed, true);
  assert.throws(
    () => h.engine.enable("nope"),
    (err: CapabilityError) => err.code === "not_found",
  );
  h.engine.close();
  h.ledger.close();
});

// --- grants 与注册越权 -----------------------------------------------------------

test("注册越权：permissions ⊄ grants 拒绝（escalation，含逐维 violations）", (t) => {
  const dir = tmpDir("morrow-cap-esc-");
  cleanup(t, dir);
  const h = openEngine(dir);
  h.engine.setGrants({
    filesystem: ["workspace://input/**"],
    network: ["api.example.com:443"],
    shell: ["read"],
    channels: ["desktop"],
    credentials: ["cred-1"],
  });
  assert.throws(
    () =>
      h.engine.register(
        makeManifest({
          permissions: {
            filesystem: ["workspace://secrets/**"],
            network: ["evil.com:443"],
            shell: ["arbitrary"],
            channels: ["qq"],
            credentials: ["cred-9"],
          },
        }),
      ),
    (err: CapabilityError) => {
      assert.equal(err.code, "escalation");
      assert.equal(err.violations?.length, 5);
      return true;
    },
  );
  // 授权面内的注册放行
  const ok = h.engine.register(
    makeManifest({
      permissions: {
        filesystem: ["workspace://input/**"],
        network: [],
        shell: [],
        channels: [],
        credentials: ["cred-1"],
      },
    }),
  );
  assert.equal(ok.created, true);
  h.engine.close();
  h.ledger.close();
});

test("grants：默认全空；setGrants 持久化（重开引擎仍在）+ 审计", (t) => {
  const dir = tmpDir("morrow-cap-grant-");
  cleanup(t, dir);
  const h = openEngine(dir);
  assert.deepEqual(h.engine.getGrants(), { filesystem: [], network: [], shell: [], channels: [], credentials: [] });
  h.engine.setGrants({ filesystem: ["workspace://**"], network: [], shell: [], channels: [], credentials: [] });
  assert.deepEqual(h.engine.getGrants().filesystem, ["workspace://**"]);
  assert.ok(h.eventTypes().includes(CAPABILITY_EVENT_TYPES.grantsUpdated));
  h.engine.close();
  h.ledger.close();

  const h2 = openEngine(dir);
  assert.deepEqual(h2.engine.getGrants().filesystem, ["workspace://**"], "grants 落盘持久");
  h2.engine.close();
  h2.ledger.close();
});

test("setGrants 形态非法 → invalid_input；未注册能力 get 返回 null", (t) => {
  const dir = tmpDir("morrow-cap-grant2-");
  cleanup(t, dir);
  const h = openEngine(dir);
  assert.throws(
    () => h.engine.setGrants({ filesystem: [] }),
    (err: CapabilityError) => err.code === "invalid_input",
  );
  assert.equal(h.engine.get("nope"), null);
  h.engine.close();
  h.ledger.close();
});

// --- assertRuntimeUse（运行时复核）---------------------------------------------

function registerRunnable(h: Harness): void {
  h.engine.setGrants({
    filesystem: ["workspace://input/**"],
    network: ["api.example.com:*"],
    shell: ["read", "arbitrary"],
    channels: ["desktop"],
    credentials: ["cred-1"],
  });
  h.engine.register(
    makeManifest({
      permissions: {
        filesystem: ["workspace://input/**"],
        network: ["api.example.com:443"],
        shell: ["read"],
        channels: ["desktop"],
        credentials: ["cred-1"],
      },
    }),
  );
}

test("assertRuntimeUse：未注册 not_found、停用 invalid_state、越权 escalation", (t) => {
  const dir = tmpDir("morrow-cap-rt-");
  cleanup(t, dir);
  const h = openEngine(dir);
  registerRunnable(h);
  assert.throws(
    () => h.engine.assertRuntimeUse("nope", {}),
    (err: CapabilityError) => err.code === "not_found",
  );
  const ok = h.engine.assertRuntimeUse("docx-to-markdown", {
    filesystem: ["workspace://input/a.md"],
    network: ["api.example.com:443"],
    shell: [{ category: "read" }],
    channels: ["desktop"],
    credentials: ["cred-1"],
  });
  assert.deepEqual(ok, { allowed: true, name: "docx-to-markdown", version: "1.0.0" });

  // 超出 manifest 声明（尽管在 grant 内）→ 拒绝
  assert.throws(
    () => h.engine.assertRuntimeUse("docx-to-markdown", { filesystem: ["/etc/passwd"] }),
    (err: CapabilityError) => {
      assert.equal(err.code, "escalation");
      assert.equal(err.violations?.[0]?.dimension, "filesystem");
      return true;
    },
  );
  assert.throws(
    () => h.engine.assertRuntimeUse("docx-to-markdown", { shell: [{ category: "arbitrary" }] }),
    (err: CapabilityError) => err.code === "escalation",
  );
  // 停用后全部拒绝
  h.engine.disable("docx-to-markdown");
  assert.throws(
    () => h.engine.assertRuntimeUse("docx-to-markdown", {}),
    (err: CapabilityError) => err.code === "invalid_state",
  );
  h.engine.close();
  h.ledger.close();
});

test("assertRuntimeUse：grant 收窄立即约束运行时（无需重新注册）", (t) => {
  const dir = tmpDir("morrow-cap-rt2-");
  cleanup(t, dir);
  const h = openEngine(dir);
  registerRunnable(h);
  h.engine.setGrants({
    filesystem: ["workspace://input/**"],
    network: [],
    shell: [],
    channels: [],
    credentials: [],
  });
  assert.throws(
    () => h.engine.assertRuntimeUse("docx-to-markdown", { network: ["api.example.com:443"] }),
    (err: CapabilityError) => err.code === "escalation",
  );
  assert.doesNotThrow(() => h.engine.assertRuntimeUse("docx-to-markdown", { filesystem: ["workspace://input/a.md"] }));
  h.engine.close();
  h.ledger.close();
});
