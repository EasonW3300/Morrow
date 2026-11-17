/**
 * Skill 包（可安装分发单元）的 manifest 校验（票 M7-B-T3 / Issue #68）。
 *
 * GLOSSARY 两个术语必须分清：
 *   - **Skill**：声明式组合（引用已验证 capability，不含代码）；
 *   - **Skill Package**：可安装的分发单元，含 `morrow.skill.json`，可带可执行入口。
 * 本模块只做**纯校验**（无 I/O），便于穷举边界。
 *
 * 安全立场（来自 M7-B 规格决策 #11/#12）：
 *   - 有 `entry` 的包**必须**同时声明 `sandbox` 与 `tests`——否则它会把宿主交出去；
 *   - `entry` 只能注册为 **sandboxed** capability（`sandbox.type` 不得为 `none`/`process`）；
 *   - 纯声明式包（只有 `steps`）不需要 sandbox（它不执行代码），但仍受五维权限约束。
 */

/** 包内 manifest 文件名（固定，不接受自定义） */
export const SKILL_MANIFEST_FILE = "morrow.skill.json";

/** 五维权限（与 capability manifest 同构，避免两套语义） */
export interface SkillPackagePermissions {
  filesystem: string[];
  network: string[];
  shell: string[];
  channels: string[];
  credentials: string[];
}

/** 声明式组合的单步：引用一个已注册 capability + 参数映射 */
export interface SkillPackageStep {
  capability: string;
  /** 模板变量映射，如 `{path: "{{input.path}}"}`；空对象表示透传 */
  args?: Record<string, string>;
}

/** 可执行入口声明 */
export interface SkillPackageEntry {
  /** 包内相对路径（包根为基准，禁止绝对路径与 `..` 越界） */
  path: string;
  /** 运行时类型；与 capability manifest 的 runtime 一致 */
  runtime: "typescript" | "go";
}

export interface SkillPackageManifest {
  name: string;
  version: string;
  description: string;
  permissions: SkillPackagePermissions;
  /** 声明式组合（与 entry 二选一或并存，但至少一个） */
  steps?: SkillPackageStep[];
  /** 可执行入口（必须伴随 sandbox 与 tests） */
  entry?: SkillPackageEntry;
  /** 沙箱声明；有 entry 时必填，且 type 必须是 container */
  sandbox?: {
    type: "container" | "process" | "none";
    network: "none" | "restricted" | "full";
    filesystem: "none" | "workspace-only" | "full";
  };
  /** 测试用例引用；有 entry 时必须非空 */
  tests?: string[];
  /** 包作者声明的完整性哈希（服务端会重算比对） */
  source_hash?: string;
}

/** 校验失败（带具体缺哪个字段，便于 UI 直接展示） */
export interface ManifestProblem {
  field: string;
  message: string;
}

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PERMISSION_KEYS: readonly (keyof SkillPackagePermissions)[] = [
  "filesystem",
  "network",
  "shell",
  "channels",
  "credentials",
];

/**
 * 校验 manifest（纯函数）。
 *
 * 返回问题列表：空数组 = 通过。**按"致命 -> 具体"排序**：先结构性错误，再逐字段，
 * 最后是 entry/sandbox/tests 之间的约束（因为后者依赖前者成立）。
 */
export function validateSkillManifest(raw: unknown): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [{ field: "", message: "manifest 必须是一个 JSON 对象" }];
  }
  const manifest = raw as Record<string, unknown>;

  // --- 必填标量 ---
  const name = manifest.name;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    problems.push({
      field: "name",
      message: "name 必填，须为小写字母/数字开头结尾，可含 ._-（1–64 字符）",
    });
  }
  const version = manifest.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    problems.push({ field: "version", message: "version 必填，须为语义化版本如 1.0.0" });
  }
  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) {
    problems.push({ field: "description", message: "description 必填且不能为空" });
  }

  // --- 权限五维 ---
  const permissions = manifest.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    problems.push({ field: "permissions", message: "permissions 必填，且须为对象（五维）" });
  } else {
    const perms = permissions as Record<string, unknown>;
    for (const key of PERMISSION_KEYS) {
      const value = perms[key];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        problems.push({
          field: `permissions.${key}`,
          message: `permissions.${key} 必须是字符串数组（空数组表示不申请该维度）`,
        });
      }
    }
  }

  // --- steps ---
  const steps = manifest.steps;
  let stepsValid = false;
  if (steps !== undefined) {
    if (!Array.isArray(steps) || steps.length === 0) {
      problems.push({ field: "steps", message: "steps 若提供则必须是非空数组" });
    } else {
      stepsValid = true;
      steps.forEach((step, index) => {
        if (typeof step !== "object" || step === null || Array.isArray(step)) {
          problems.push({ field: `steps[${index}]`, message: "每步须为对象" });
          stepsValid = false;
          return;
        }
        const record = step as Record<string, unknown>;
        if (typeof record.capability !== "string" || record.capability.length === 0) {
          problems.push({ field: `steps[${index}].capability`, message: "capability 必填" });
          stepsValid = false;
        }
        if (record.args !== undefined) {
          const args = record.args;
          if (typeof args !== "object" || args === null || Array.isArray(args)) {
            problems.push({ field: `steps[${index}].args`, message: "args 若提供须为对象" });
            stepsValid = false;
          }
        }
      });
    }
  }

  // --- entry ---
  const entry = manifest.entry;
  const hasEntry = entry !== undefined;
  if (hasEntry) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({ field: "entry", message: "entry 若提供须为对象" });
    } else {
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== "string" || record.path.length === 0) {
        problems.push({ field: "entry.path", message: "entry.path 必填" });
      } else if (isEscapingPath(record.path)) {
        // 越界路径能把"包内入口"变成"宿主任意文件执行"
        problems.push({
          field: "entry.path",
          message: "entry.path 必须是包内相对路径（不允许绝对路径或以 .. 越界）",
        });
      }
      if (record.runtime !== "typescript" && record.runtime !== "go") {
        problems.push({ field: "entry.runtime", message: 'entry.runtime 必须是 "typescript" 或 "go"' });
      }
    }
  }

  if (!hasEntry && !stepsValid) {
    problems.push({ field: "steps", message: "至少需要 steps（声明式组合）或 entry（可执行入口）之一" });
  }

  // --- entry 的伴随约束（最关键的三条）---
  if (hasEntry) {
    const sandbox = manifest.sandbox;
    if (sandbox === undefined) {
      problems.push({
        field: "sandbox",
        message: "含 entry 的包必须声明 sandbox（否则可执行代码会直接跑在宿主上）",
      });
    } else if (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox)) {
      problems.push({ field: "sandbox", message: "sandbox 须为对象" });
    } else {
      const spec = sandbox as Record<string, unknown>;
      if (spec.type !== "container") {
        problems.push({
          field: "sandbox.type",
          message: 'entry 的 sandbox.type 必须是 "container"（process/none 会把代码交给宿主）',
        });
      }
      if (spec.network !== "none" && spec.network !== "restricted" && spec.network !== "full") {
        problems.push({ field: "sandbox.network", message: "sandbox.network 必须是 none/restricted/full" });
      }
      if (
        spec.filesystem !== "none" &&
        spec.filesystem !== "workspace-only" &&
        spec.filesystem !== "full"
      ) {
        problems.push({
          field: "sandbox.filesystem",
          message: "sandbox.filesystem 必须是 none/workspace-only/full",
        });
      }
    }

    const tests = manifest.tests;
    if (!Array.isArray(tests) || tests.length === 0) {
      problems.push({
        field: "tests",
        message: "含 entry 的包必须提供非空 tests（未经测试的代码不允许注册）",
      });
    }
  }

  return problems;
}

/**
 * 路径是否越界（绝对路径、`..`、Windows 盘符/UNC）。
 *
 * 只在**声明层**做粗筛；真正的越界由安装时的 realpath 检查兜底（符号链接可以绕过
 * 字符串判断）。两处都要有，因为前者能给出好的错误信息、后者才是安全边界。
 */
export function isEscapingPath(path: string): boolean {
  if (path.length === 0) return true;
  if (path.startsWith("/") || path.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true; // Windows 盘符
  if (path.startsWith("//") || path.startsWith("\\\\")) return true; // UNC
  const segments = path.split(/[\\/]+/);
  return segments.includes("..");
}

/**
 * 计算包的完整性哈希（canonical JSON + sha256）。
 *
 * 口径与 capability manifest 一致：**排除 `source_hash` 自身**，按键名排序序列化。
 * 参数是"已解析的 manifest 对象"，调用方负责保证它与包内文件一致。
 */
export function canonicalManifestJson(manifest: Record<string, unknown>): string {
  const { source_hash: _ignored, ...rest } = manifest;
  return canonicalJson(rest);
}

/** 递归键排序的 JSON（确定性序列化；数组顺序保持） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(",")}}`;
}

/** 从 argv 判断这次 npm 调用是否禁止了安装脚本（供断言与文档引用） */
export function npmInstallArgs(spec: string, targetDir: string): string[] {
  // --ignore-scripts 必须在最前：任何位置都能生效，但放前面便于日志审计时一眼看到
  return [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--prefix",
    targetDir,
    spec,
  ];
}
