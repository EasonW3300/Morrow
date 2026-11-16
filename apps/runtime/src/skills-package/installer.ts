/**
 * Skill 包安装器（票 M7-B-T3 / Issue #68）。
 *
 * 安全模型（为什么这样写）：
 *   1. **绝不执行包内安装脚本**：npm 调用固定带 `--ignore-scripts`。这条不能靠"我们
 *      只解析 manifest"来保证——npm 默认会在 install 后跑 postinstall，那是任意代码执行。
 *      为了能真的断言这件事，npm 调用经 `NpmRunner` 接缝注入，测试用一个"如果被调用就
 *      留下痕迹"的夹具包验证脚本没跑。
 *   2. **只信任包内 manifest**：安装后从**已落盘的包目录**重新读取 `morrow.skill.json`，
 *      不用调用方传入的内容（否则声明与实物可以不一致）。
 *   3. **完整性**：服务端重算 `sha256(canonicalJson(manifest - source_hash))` 并与声明比对。
 *   4. **可执行入口只能沙箱**：`entry` 存在时强制 `sandbox.type === "container"`，并把
 *      capability manifest 的 sandbox 固定为容器的安全默认（`network: none`、
 *      `filesystem: workspace-only`），忽略包内更宽松的声明——包不能给自己放宽。
 *   5. **路径越界**：manifest 层粗筛（绝对路径/`..`）+ 安装后的 realpath 检查兜底
 *      （符号链接能绕过字符串判断，所以必须有第二道）。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  CAPABILITY_CHANNELS,
  SHELL_COMMAND_CATEGORIES,
  type CapabilityChannel,
  type CapabilityManifest,
  type CapabilityPermissions,
  type ShellCommandCategory,
} from "@morrow/protocol";

/** 封闭枚举的运行时集合（用于过滤包声明里的未知类别） */
const SHELL_CATEGORIES: readonly ShellCommandCategory[] = SHELL_COMMAND_CATEGORIES;
const CHANNELS: readonly CapabilityChannel[] = CAPABILITY_CHANNELS;
import {
  SKILL_MANIFEST_FILE,
  canonicalManifestJson,
  isEscapingPath,
  npmInstallArgs,
  validateSkillManifest,
  type SkillPackageManifest,
  type SkillPackagePermissions,
} from "./manifest.ts";

const execFileP = promisify(execFile);

/**
 * npm 调用接缝。
 *
 * 刻意把接缝放在 **exec** 层而不是"install(spec) 抽象方法"层：后者让测试无法看到
 * 真实的 argv，也就无法证明 `--ignore-scripts` 真的传给了 npm（这正是本票最关键的安全
 * 断言）。注入 exec 后，测试能拿到我们构造的完整命令行，并模拟"若缺少该 flag 就会执行
 * 安装脚本"的恶意包。
 */
export type NpmExec = (
  command: string,
  argv: string[],
  options: { maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface NpmRunner {
  /** 把 `spec` 安装到 `targetDir`；返回实际执行的 argv 便于审计与断言 */
  install(spec: string, targetDir: string): Promise<{ argv: string[]; stdout: string }>;
}

export function createNpmRunner(exec: NpmExec = execFileP as unknown as NpmExec): NpmRunner {
  return {
    async install(spec, targetDir) {
      const argv = npmInstallArgs(spec, targetDir);
      const { stdout } = await exec("npm", argv, { maxBuffer: 8 * 1024 * 1024 });
      return { argv, stdout };
    },
  };
}

/** 安装错误（分类便于 HTTP 层映射） */
export type SkillInstallErrorCode =
  | "invalid_spec"
  | "npm_failed"
  | "manifest_missing"
  | "manifest_invalid"
  | "source_hash_mismatch"
  | "entry_escaping_package";

export class SkillInstallError extends Error {
  readonly code: SkillInstallErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: SkillInstallErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SkillInstallError";
    this.code = code;
    this.details = details;
  }
}

export interface InstalledSkillPackage {
  manifest: SkillPackageManifest;
  /** 包根目录（含 package.json 与 morrow.skill.json 的那一层） */
  packageDir: string;
  /** 服务端重算的完整性哈希 */
  sourceHash: string;
  /** 由 manifest 派生的 capability 注册请求（entry 已强制沙箱；steps 走声明式） */
  capability: CapabilityManifest;
}

/**
 * 校验 npm spec：只接受包名（可带版本/scope）或 `npm:` 前缀，不接受任意 URL。
 *
 * 为什么不让用户粘任意 URL：git/http/tarball 源会绕过 registry 的完整性校验，
 * 而本功能的价值是"从 npm 装声明式技能包"，不是通用下载器。
 */
export function validateNpmSpec(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return "包名不能为空";
  if (trimmed.length > 214) return "包名过长（npm 上限 214 字符）";
  const normalized = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  if (/^(?:git|https?|file|link):/.test(normalized) || normalized.startsWith(".")) {
    return "只支持 npm registry 包名（不接受 git/URL/本地路径）";
  }
  // 允许 scope（@scope/name）、版本（name@1.2.3）、tag（name@latest）
  const pattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9A-Za-z^~<>=.*+ -]+)?$/;
  if (!pattern.test(normalized)) return "包名格式不合法（示例：docx-tools、@scope/pkg@1.0.0）";
  return null;
}

/**
 * 五维权限映射：包声明（宽字符串）→ capability manifest（shell/channels 是封闭枚举）。
 *
 * 不在枚举内的值**直接丢弃而不是报错**：manifest 校验已保证是字符串数组，但包作者
 * 可能写了未来才有的类别名。丢弃比"整包拒绝"更合适——但必须让调用方知道丢了什么，
 * 所以返回值附带 `dropped`，由安装结果回报给 UI（否则会出现"我声明了却没生效"的黑箱）。
 */
export function toCapabilityPermissions(permissions: SkillPackagePermissions): {
  mapped: CapabilityPermissions;
  dropped: Array<{ dimension: string; value: string }>;
} {
  const shellCategories = new Set(SHELL_CATEGORIES);
  const channelKinds = new Set(CHANNELS);
  const dropped: Array<{ dimension: string; value: string }> = [];
  const keep = <T extends string>(dimension: string, values: string[], allowed: Set<T>): T[] => {
    const kept: T[] = [];
    for (const value of values) {
      if (allowed.has(value as T)) kept.push(value as T);
      else dropped.push({ dimension, value });
    }
    return kept;
  };
  return {
    mapped: {
      filesystem: [...permissions.filesystem],
      network: [...permissions.network],
      shell: keep("shell", permissions.shell, shellCategories),
      channels: keep("channels", permissions.channels, channelKinds),
      credentials: [...permissions.credentials],
    },
    dropped,
  };
}

/**
 * 校验 `entry.path` 解析后仍在包内（realpath 兜底）。
 *
 * 字符串检查（`isEscapingPath`）拦不住符号链接：包里可以放 `dist/tool.js -> /etc/passwd`。
 * 这里在**已落盘的包目录**上取 realpath 再比较，才是真正的边界。
 */
export function assertEntryInsidePackage(packageDir: string, entryPath: string): void {
  const packageRoot = realpathSync(packageDir);
  const target = join(packageDir, entryPath);
  if (!existsSync(target)) {
    throw new SkillInstallError("manifest_invalid", `entry.path 指向的文件不存在：${entryPath}`, {
      entry: entryPath,
    });
  }
  const resolved = realpathSync(target);
  const rel = relative(packageRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new SkillInstallError(
      "entry_escaping_package",
      `entry.path 解析后越出包目录（可能通过符号链接）：${entryPath}`,
      { entry: entryPath, resolved },
    );
  }
}

/**
 * 安装流程：npm 安装 → 读包内 manifest → 校验 → 哈希比对 → 入口边界检查 → 派生 capability。
 *
 * `packageDir` 由调用方给（通常是 `<packagesRoot>/<name>/node_modules/<name>`），
 * 这样同一包多版本可以并存、卸载就是删目录。
 */
export async function installSkillPackage(options: {
  spec: string;
  targetDir: string;
  packageDir: string;
  npmRunner?: NpmRunner;
  /** 调用方声明的期望哈希（来自清单页/升级 diff），与重算值不符则拒绝 */
  expectedHash?: string;
}): Promise<InstalledSkillPackage> {
  const specProblem = validateNpmSpec(options.spec);
  if (specProblem !== null) {
    throw new SkillInstallError("invalid_spec", specProblem, { spec: options.spec });
  }

  const runner = options.npmRunner ?? createNpmRunner();
  try {
    await runner.install(options.spec.trim(), options.targetDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillInstallError("npm_failed", `npm 安装失败：${message}`, { spec: options.spec });
  }

  const manifestPath = join(options.packageDir, SKILL_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new SkillInstallError(
      "manifest_missing",
      `包内没有 ${SKILL_MANIFEST_FILE}（本系统只接受声明式技能包）`,
      { packageDir: options.packageDir },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillInstallError("manifest_invalid", `${SKILL_MANIFEST_FILE} 不是合法 JSON：${message}`);
  }

  const problems = validateSkillManifest(raw);
  if (problems.length > 0) {
    throw new SkillInstallError("manifest_invalid", "manifest 校验未通过", { problems });
  }
  const manifest = raw as SkillPackageManifest;

  // 完整性：服务端重算（排除 source_hash 自身）
  const sourceHash = `sha256-${createHash("sha256")
    .update(canonicalManifestJson(raw as Record<string, unknown>))
    .digest("hex")}`;
  const declared = manifest.source_hash;
  const expected = options.expectedHash ?? declared;
  if (expected !== undefined && expected !== sourceHash) {
    throw new SkillInstallError("source_hash_mismatch", "包内容与声明的 source_hash 不符", {
      expected,
      actual: sourceHash,
    });
  }

  // 入口边界（realpath 兜底，拦符号链接越界）
  if (manifest.entry !== undefined) {
    if (isEscapingPath(manifest.entry.path)) {
      throw new SkillInstallError("entry_escaping_package", "entry.path 越出包目录", {
        entry: manifest.entry.path,
      });
    }
    assertEntryInsidePackage(options.packageDir, manifest.entry.path);
  }

  return {
    manifest,
    packageDir: options.packageDir,
    sourceHash,
    capability: deriveCapabilityManifest(manifest, sourceHash),
  };
}

/**
 * 由技能包 manifest 派生 capability manifest。
 *
 * 两条硬规则：
 *   - 有 `entry` → `sandbox` 固定为容器安全默认（**忽略包内更宽松的声明**）；
 *   - 只有 `steps` → 声明式组合本身不执行代码，`sandbox.type = "none"` 是对的。
 */
export function deriveCapabilityManifest(
  manifest: SkillPackageManifest,
  sourceHash: string,
): CapabilityManifest {
  const hasEntry = manifest.entry !== undefined;
  return {
    name: manifest.name,
    version: manifest.version,
    author: "human", // 安装是 Owner 显式动作；AI 生成仍走 Tool Factory 的 author=ai
    runtime: manifest.entry?.runtime ?? "typescript",
    permissions: toCapabilityPermissions(manifest.permissions).mapped,
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    sandbox: hasEntry
      ? { type: "container", network: "none", filesystem: "workspace-only" }
      : { type: "none", network: "none", filesystem: "none" },
    tests: manifest.tests === undefined ? [] : [...manifest.tests],
    source_hash: sourceHash,
  };
}

/**
 * 比较两个版本的权限，产出升级前的 diff（决策 #14：升级必须能看到权限变化）。
 *
 * 分类：`added`（新版本新增的条目，可能扩大授权）、`removed`（收窄或不再需要）、
 * `unchanged`。**只有 added 会扩大权力**，UI 应重点提示它。
 */
export interface PermissionDiff {
  added: Array<{ dimension: string; value: string }>;
  removed: Array<{ dimension: string; value: string }>;
  unchanged: Array<{ dimension: string; value: string }>;
  /** 任一维度出现新增即为 true（升级需显式确认） */
  widens: boolean;
}

export function diffPermissions(
  from: SkillPackagePermissions,
  to: SkillPackagePermissions,
): PermissionDiff {
  const added: PermissionDiff["added"] = [];
  const removed: PermissionDiff["removed"] = [];
  const unchanged: PermissionDiff["unchanged"] = [];
  for (const dimension of Object.keys(to) as Array<keyof SkillPackagePermissions>) {
    const before = new Set(from[dimension] ?? []);
    const after = new Set(to[dimension] ?? []);
    for (const value of after) {
      if (before.has(value)) unchanged.push({ dimension, value });
      else added.push({ dimension, value });
    }
    for (const value of before) {
      if (!after.has(value)) removed.push({ dimension, value });
    }
  }
  return { added, removed, unchanged, widens: added.length > 0 };
}
