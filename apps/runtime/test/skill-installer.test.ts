// Skill 包安装器测试（票 M7-B-T3 / Issue #68）。
// 核心：证明 postinstall 没有被执行、entry 只能沙箱、路径越界（含符号链接）被拦、
// source_hash 不符被拒、升级 diff 分类正确。
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createNpmRunner,
  diffPermissions,
  deriveCapabilityManifest,
  installSkillPackage,
  SkillInstallError,
  validateNpmSpec,
  type NpmExec,
  type NpmRunner,
} from "../src/skills-package/installer.ts";
import { canonicalManifestJson, npmInstallArgs, SKILL_MANIFEST_FILE } from "../src/skills-package/manifest.ts";
import { removeDir, tmpDir } from "./helpers.ts";
import { createHash } from "node:crypto";

const PERMS = { filesystem: ["workspace://**"], network: [], shell: [], channels: [], credentials: [] };

/** 造一个"已安装"的包目录（模拟 npm 落盘后的结果），返回 packageDir 与哈希 */
function makePackage(manifestOverrides: Record<string, unknown> = {}, options: { entryFile?: boolean } = {}) {
  const root = tmpDir("morrow-skillpkg-");
  const packageDir = join(root, "package");
  mkdirSync(packageDir, { recursive: true });
  const manifest = {
    name: "docx-tools",
    version: "1.0.0",
    description: "处理 docx",
    permissions: PERMS,
    steps: [{ capability: "docx.toMarkdown" }],
    ...manifestOverrides,
  };
  writeFileSync(join(packageDir, SKILL_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  if (options.entryFile !== false && typeof manifestOverrides.entry === "object") {
    const entry = manifestOverrides.entry as { path: string };
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    writeFileSync(join(packageDir, entry.path), "export function run() { return 1; }\n");
  }
  const hash = `sha256-${createHash("sha256").update(canonicalManifestJson(manifest)).digest("hex")}`;
  return { root, packageDir, manifest, hash };
}

/** 假 npm：不动网络，仅记录；可选模拟"没有 --ignore-scripts 就会跑安装脚本" */
function fakeNpm(): NpmRunner & { calls: Array<{ spec: string; targetDir: string; argv: string[] }> } {
  const calls: Array<{ spec: string; targetDir: string; argv: string[] }> = [];
  return {
    calls,
    async install(spec, targetDir) {
      const argv = npmInstallArgs(spec, targetDir);
      calls.push({ spec, targetDir, argv });
      return { argv, stdout: "" };
    },
  };
}

/**
 * 走**真实 argv 构造路径**的假 exec：用 createNpmRunner 注入。
 * 如果缺少 `--ignore-scripts`，就像真的恶意 postinstall 那样写痕迹文件 ——
 * 这样"痕迹不存在"才真正证明了参数传递正确。
 */
function npmExecWithPostinstallTrap(tracePath: string) {
  const seen: string[][] = [];
  const exec: NpmExec = async (_command, argv) => {
    seen.push(argv);
    const targetDir = argv[argv.indexOf("--prefix") + 1] ?? "";
    if (!argv.includes("--ignore-scripts") && targetDir.length > 0) {
      writeFileSync(join(targetDir, tracePath), "pwned");
    }
    return { stdout: "" };
  };
  return { exec, seen };
}

// --- spec 校验 ----------------------------------------------------------------------

test("validateNpmSpec：接受包名/scope/版本/tag，拒绝 URL 与本地路径", () => {
  for (const ok of ["docx-tools", "@scope/pkg", "docx-tools@1.2.3", "@scope/pkg@latest", "npm:docx-tools"]) {
    assert.equal(validateNpmSpec(ok), null, `${ok} 应通过`);
  }
  for (const bad of ["", "https://evil.example/x.tgz", "git+ssh://x/y.git", "file:../local", "../local", "./x"]) {
    assert.notEqual(validateNpmSpec(bad), null, `${bad} 应被拒`);
  }
});

// --- postinstall 不执行（本票最关键的安全断言）----------------------------------------

test("安装固定带 --ignore-scripts：恶意 postinstall 不留痕迹", async () => {
  const { root, packageDir } = makePackage();
  const targetDir = join(root, "node_modules");
  mkdirSync(targetDir, { recursive: true });
  const { exec, seen } = npmExecWithPostinstallTrap("PWNED_BY_POSTINSTALL");
  try {
    await installSkillPackage({
      spec: "docx-tools@1.0.0",
      targetDir,
      packageDir,
      npmRunner: createNpmRunner(exec),
    });
    // 陷阱只在 argv 缺 --ignore-scripts 时写痕迹；不存在 = 我们确实传了该 flag
    assert.equal(existsSync(join(targetDir, "PWNED_BY_POSTINSTALL")), false, "postinstall 不得执行");
    assert.equal(seen.length, 1, "只调用一次 npm");
    assert.ok(seen[0].includes("--ignore-scripts"), "argv 必须含 --ignore-scripts");
  } finally {
    removeDir(root);
  }
});

test("反证：去掉 --ignore-scripts 时陷阱会触发（证明上面的断言有牙齿）", async () => {
  const { root, packageDir } = makePackage();
  const targetDir = join(root, "node_modules");
  mkdirSync(targetDir, { recursive: true });
  const { exec } = npmExecWithPostinstallTrap("PWNED_BY_POSTINSTALL");
  try {
    // 直接手搓一个"忘记该 flag"的 argv，验证陷阱本身有效
    await exec("npm", ["install", "--prefix", targetDir, "docx-tools"], { maxBuffer: 1024 });
    assert.equal(
      existsSync(join(targetDir, "PWNED_BY_POSTINSTALL")),
      true,
      "陷阱必须能触发，否则正向断言不成立",
    );
  } finally {
    removeDir(root);
  }
});

// --- 完整性 -------------------------------------------------------------------------

test("source_hash 声明不符 → 拒绝并给出 expected/actual", async () => {
  const { root, packageDir } = makePackage({ source_hash: "sha256-0000" });
  try {
    await assert.rejects(
      () =>
        installSkillPackage({
          spec: "docx-tools@1.0.0",
          targetDir: join(root, "nm"),
          packageDir,
          npmRunner: fakeNpm(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof SkillInstallError);
        assert.equal(err.code, "source_hash_mismatch");
        assert.ok(err.details?.expected !== undefined && err.details?.actual !== undefined);
        return true;
      },
    );
  } finally {
    removeDir(root);
  }
});

test("正确声明 source_hash 时通过（哈希口径与 manifest 模块一致）", async () => {
  const first = makePackage();
  const hash = first.hash;
  removeDir(first.root);
  const { root, packageDir } = makePackage({ source_hash: hash });
  try {
    const installed = await installSkillPackage({
      spec: "docx-tools@1.0.0",
      targetDir: join(root, "nm"),
      packageDir,
      npmRunner: fakeNpm(),
      expectedHash: hash,
    });
    assert.equal(installed.sourceHash, hash);
  } finally {
    removeDir(root);
  }
});

// --- 缺 manifest / 校验失败 ---------------------------------------------------------

test("包内没有 morrow.skill.json → manifest_missing", async () => {
  const root = tmpDir("morrow-skillpkg-nomanifest-");
  const packageDir = join(root, "package");
  mkdirSync(packageDir, { recursive: true });
  try {
    await assert.rejects(
      () =>
        installSkillPackage({
          spec: "docx-tools",
          targetDir: join(root, "nm"),
          packageDir,
          npmRunner: fakeNpm(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof SkillInstallError);
        assert.equal(err.code, "manifest_missing");
        return true;
      },
    );
  } finally {
    removeDir(root);
  }
});

test("manifest 校验失败 → manifest_invalid 且带逐字段问题", async () => {
  const { root, packageDir } = makePackage({ permissions: { filesystem: [] } });
  try {
    await assert.rejects(
      () =>
        installSkillPackage({
          spec: "docx-tools",
          targetDir: join(root, "nm"),
          packageDir,
          npmRunner: fakeNpm(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof SkillInstallError);
        assert.equal(err.code, "manifest_invalid");
        assert.ok(Array.isArray(err.details?.problems));
        return true;
      },
    );
  } finally {
    removeDir(root);
  }
});

// --- 入口边界（字符串 + 符号链接两层）----------------------------------------------

test("entry 缺失实体文件 → manifest_invalid（不能声明一个不存在的入口）", async () => {
  const { root, packageDir } = makePackage(
    {
      steps: undefined,
      entry: { path: "dist/missing.js", runtime: "typescript" },
      sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
      tests: ["t.yaml"],
    },
    { entryFile: false },
  );
  try {
    await assert.rejects(
      () =>
        installSkillPackage({
          spec: "docx-tools",
          targetDir: join(root, "nm"),
          packageDir,
          npmRunner: fakeNpm(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof SkillInstallError);
        assert.equal(err.code, "manifest_invalid");
        return true;
      },
    );
  } finally {
    removeDir(root);
  }
});

test("entry 通过符号链接越出包目录 → entry_escaping_package（realpath 兜底）", async () => {
  const { root, packageDir } = makePackage({
    steps: undefined,
    entry: { path: "dist/link.js", runtime: "typescript" },
    sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
    tests: ["t.yaml"],
  });
  try {
    const outside = join(root, "outside.js");
    writeFileSync(outside, "宿主文件");
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    // makePackage 已在那儿写了实体文件；符号链接测试要先移除它
    rmSync(join(packageDir, "dist/link.js"), { force: true });
    symlinkSync(outside, join(packageDir, "dist/link.js"));
    await assert.rejects(
      () =>
        installSkillPackage({
          spec: "docx-tools",
          targetDir: join(root, "nm"),
          packageDir,
          npmRunner: fakeNpm(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof SkillInstallError);
        assert.equal(err.code, "entry_escaping_package");
        return true;
      },
    );
  } finally {
    removeDir(root);
  }
});

// --- 派生 capability：entry 只能沙箱 -------------------------------------------------

test("有 entry 时 capability.sandbox 固定为容器安全默认（忽略包内更宽松声明）", () => {
  const capability = deriveCapabilityManifest(
    {
      name: "x",
      version: "1.0.0",
      description: "d",
      permissions: PERMS,
      entry: { path: "dist/x.js", runtime: "typescript" },
      // 包内声明想要 full 网络 + full 文件系统
      sandbox: { type: "container", network: "full", filesystem: "full" },
      tests: ["t"],
    },
    "sha256-abc",
  );
  assert.equal(capability.sandbox.type, "container");
  assert.equal(capability.sandbox.network, "none", "包不能给自己放宽网络");
  assert.equal(capability.sandbox.filesystem, "workspace-only");
});

test("纯声明式包（steps）的 capability.sandbox 为 none（它不执行代码）", () => {
  const capability = deriveCapabilityManifest(
    { name: "x", version: "1.0.0", description: "d", permissions: PERMS, steps: [{ capability: "a.b" }] },
    "sha256-abc",
  );
  assert.equal(capability.sandbox.type, "none");
  assert.equal(capability.author, "human");
  assert.equal(capability.source_hash, "sha256-abc");
});

// --- 升级 diff ----------------------------------------------------------------------

test("diffPermissions：新增权限置 widens=true，收窄只列 removed", () => {
  // 用空五维做基线，避免 filesystem 的同项混入 unchanged 干扰断言
  const empty = { filesystem: [], network: [], shell: [], channels: [], credentials: [] };
  const widened = diffPermissions(empty, { ...empty, network: ["api.example.com:443"] });
  assert.equal(widened.widens, true);
  assert.deepEqual(widened.added, [{ dimension: "network", value: "api.example.com:443" }]);

  const narrowed = diffPermissions(
    { ...empty, network: ["a:1", "b:2"] },
    { ...empty, network: ["a:1"] },
  );
  assert.equal(narrowed.widens, false, "收窄不算扩大");
  assert.deepEqual(narrowed.removed, [{ dimension: "network", value: "b:2" }]);
  assert.deepEqual(narrowed.unchanged, [{ dimension: "network", value: "a:1" }]);
});

test("diffPermissions：完全相同 → 全 unchanged、widens=false", () => {
  const diff = diffPermissions(PERMS, PERMS);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.widens, false);
});
