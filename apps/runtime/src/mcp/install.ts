/**
 * MCP 安装输入解析与风险门槛（票 M7-B-T2 / Issue #71，FR-B1/B2/B3）。
 *
 * 两种输入形态（访谈要求「粘贴 JSON 或启动命令」）：
 *   1. **JSON 配置**：`{"mcpServers": {"name": {"command": "...", "args": [...], "env": {...}}}}`
 *      —— 这是 MCP 客户端生态的事实标准格式（Claude Desktop / Cursor 等都用它），
 *      支持一台或多台。
 *   2. **启动命令**：`npx -y @modelcontextprotocol/server-filesystem /tmp`
 *      —— 按 shell 词法切分（**不**执行 shell，只分词）。名字从命令推断（可覆盖）。
 *
 * 风险门槛（SEP-1024 的 MUST，规格硬要求）：
 *   - 安装前必须展示**完整未截断**的启动命令；
 *   - 必须勾选确认「该 Server 拥有与 Morrow 同等的宿主权限」；
 *   - `acknowledged !== true` 时**拒绝安装**，而不是"记个警告照装"。
 *
 * 分词器的边界（写清楚比"看起来能用"重要）：
 *   - 支持单双引号、反斜杠转义；
 *   - **不**展开 `~`、**不**解析变量、**不**处理管道/重定向——这些是 shell 语义，
 *     在这里静默解释会让"展示的命令"与"实际执行的 argv"不一致；
 *   - 遇到未闭合引号直接报错（宁可装不上，也不猜）。
 */

import { createHash } from "node:crypto";

/** 解析出来的待安装配置（尚未落库） */
export interface McpServerDraft {
  display_name: string;
  command: string;
  args: string[];
  /** 环境变量键名（值不进库；安装时提示 Owner 用凭据库注入） */
  env_keys: string[];
  cwd: string | null;
  source: "manual" | "template" | "document" | "npm" | "builtin";
}

export class McpInstallInputError extends Error {
  readonly code: "invalid_input" | "unsupported_shape" | "empty_input" | "risk_not_acknowledged";
  constructor(code: McpInstallInputError["code"], message: string) {
    super(message);
    this.name = "McpInstallInputError";
    this.code = code;
  }
}

/**
 * 风险确认文案（原文落库：事后能证明"当时告知了什么"）。
 *
 * 措辞必须准确：MCP server 是**宿主进程**（ADR-0011），不是沙箱。写成"沙箱隔离"
 * 就是对我们自己安全模型的谎报。
 */
export const MCP_RISK_ACK_TEXT =
  "我了解：该 MCP Server 作为普通宿主进程运行，拥有与 Morrow 同等的宿主权限——" +
  "它可以读写宿主机上 Morrow 能访问的文件、可以出网、可以执行命令。" +
  "它不是沙箱，Morrow 无法限制它的实际行为；只有它通过 Morrow 注册的工具调用才受五维权限约束。";

/**
 * 把命令与参数拼成**展示用**的完整命令字符串。
 *
 * 加引号规则：含空白或 shell 元字符的参数用单引号包起来（单引号内不转义），
 * 便于 Owner 原样复制到终端核对。展示串**不**参与执行——执行永远走 argv。
 */
export function formatCommandPreview(command: string, args: readonly string[]): string {
  const quote = (value: string): string => {
    if (value.length === 0) return "''";
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
  };
  return [command, ...args].map(quote).join(" ");
}

/**
 * shell 风格分词（只分词，不执行）。
 *
 * 实现要点：**不用正则一次性切**——引号内的空格不该切、反斜杠要按下一个字符处理，
 * 这些用正则表达会变成不可维护的泥团。逐字符状态机更短也更容易验证。
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      } else {
        current += char;
      }
      continue;
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false;
      } else if (char === "\\" && index + 1 < input.length) {
        // 双引号内反斜杠只对少数字符生效；这里保守处理：任何字符都吃掉转义
        index += 1;
        current += input[index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (char === "\\" && index + 1 < input.length) {
      index += 1;
      current += input[index];
      hasContent = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (hasContent || current.length > 0) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }

  if (inSingle || inDouble) {
    throw new McpInstallInputError(
      "invalid_input",
      inSingle ? "unterminated single quote in command" : "unterminated double quote in command",
    );
  }
  if (hasContent || current.length > 0) tokens.push(current);
  return tokens;
}

/** 从命令推断显示名：`@scope/pkg` → `pkg`，`./server.js` → `server` */
export function inferDisplayName(command: string, args: readonly string[]): string {
  // 优先看参数里第一个"像模块/脚本"的（`npx -y @scope/server-fs /tmp` → server-fs）
  const candidate = args.find((arg) => !arg.startsWith("-") && arg.trim().length > 0) ?? command;
  const base = candidate.split(/[/\\]/).pop() ?? candidate;
  const withoutExt = base.replace(/\.(js|mjs|cjs|ts|py|sh|exe)$/i, "");
  const withoutScope = withoutExt.includes("/") ? (withoutExt.split("/").pop() ?? withoutExt) : withoutExt;
  return withoutScope.length > 0 ? withoutScope : "mcp-server";
}

/** JSON 配置里单台 server 的形状（宽松读，逐字段校验） */
interface RawServerConfig {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
  name?: unknown;
  /**
   * 可选的"更友好"字段：有些配置给人写 `displayName`。
   * 我们**不接受**它决定 server_id（id 由 display_name 派生），只作为名字来源之一。
   */
  displayName?: unknown;
}

/**
 * 解析安装输入。
 *
 * 返回**多台**（JSON 可带多台 server）与一个 `warnings` 数组——warnings 只能
 * 提示（如 env 值被丢弃），不能改变判定结果。
 */
export function parseInstallInput(
  raw: string,
  options: { displayName?: string; source?: McpServerDraft["source"] } = {},
): { drafts: McpServerDraft[]; warnings: string[] } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new McpInstallInputError("empty_input", "installation input is empty");
  }
  const source = options.source ?? "manual";
  const warnings: string[] = [];

  // JSON 形态判定要看首字符**和**整体可解析性：只判 `{` 会让 `[` / `"` / 数字
  // 被当成"命令"去分词（`[]` 会被解析成可执行文件名为 `[]` 的 server，荒谬且危险）。
  if (/^[{[]/.test(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new McpInstallInputError(
        "invalid_input",
        `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { drafts: parseJsonConfig(parsed, source, options.displayName, warnings), warnings };
  }
  // 明显不是命令的输入（JSON 字面量残片：[] / null / 引号 / 纯数字）不该被当可执行
  // 文件名：显式拒绝比让用户装上一个名叫 "null" 的 server 更诚实。
  if (/^(\[|null$|true$|false$|["'0-9-])/.test(trimmed)) {
    throw new McpInstallInputError(
      "unsupported_shape",
      "input looks like a JSON literal but is not an object config; provide a JSON object or a launch command",
    );
  }

  // 命令形态：拒绝显式 shell 语法（我们不做 shell 解释，静默忽略会让展示与实际不一致）
  if (/(?:^|[^\\])(?:\||&&|\|\||;|>|<|`|\$\()/.test(trimmed)) {
    throw new McpInstallInputError(
      "unsupported_shape",
      "shell operators (|, &&, ;, >, <, $(), backticks) are not supported in MCP launch commands; " +
        "provide a single executable with plain arguments",
    );
  }
  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) {
    throw new McpInstallInputError("empty_input", "command produced no tokens");
  }
  const [command, ...args] = tokens;
  return {
    drafts: [
      {
        display_name: options.displayName?.trim() || inferDisplayName(command, args),
        command,
        args,
        env_keys: [],
        cwd: null,
        source,
      },
    ],
    warnings,
  };
}

function parseJsonConfig(
  parsed: unknown,
  source: McpServerDraft["source"],
  displayNameOverride: string | undefined,
  warnings: string[],
): McpServerDraft[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new McpInstallInputError("unsupported_shape", "JSON config must be an object");
  }
  const record = parsed as Record<string, unknown>;
  // 支持三种形状：{mcpServers:{...}} / {servers:{...}} / 单台 {...command}
  const container =
    typeof record.mcpServers === "object" && record.mcpServers !== null
      ? (record.mcpServers as Record<string, unknown>)
      : typeof record.servers === "object" && record.servers !== null
        ? (record.servers as Record<string, unknown>)
        : null;

  if (container === null) {
    if (typeof record.command !== "string") {
      throw new McpInstallInputError(
        "unsupported_shape",
        'JSON config must contain a "mcpServers" (or "servers") object, or a single server with a "command" field',
      );
    }
    const single = toDraft(record as RawServerConfig, displayNameOverride ?? "mcp-server", source, warnings);
    return [single];
  }

  const entries = Object.entries(container);
  if (entries.length === 0) {
    throw new McpInstallInputError("empty_input", 'the "mcpServers" object is empty');
  }
  return entries.map(([name, value]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new McpInstallInputError("unsupported_shape", `mcpServers.${name} must be an object`);
    }
    // JSON 里的 key 就是名字；override 只对单台形状有意义
    return toDraft(value as RawServerConfig, name, source, warnings);
  });
}

function toDraft(
  config: RawServerConfig,
  fallbackName: string,
  source: McpServerDraft["source"],
  warnings: string[],
): McpServerDraft {
  if (typeof config.command !== "string" || config.command.trim().length === 0) {
    throw new McpInstallInputError("unsupported_shape", `server "${fallbackName}" is missing a "command" string`);
  }
  const args: string[] = [];
  if (config.args !== undefined) {
    if (!Array.isArray(config.args)) {
      throw new McpInstallInputError("unsupported_shape", `server "${fallbackName}": "args" must be an array`);
    }
    for (const arg of config.args) {
      if (typeof arg !== "string") {
        throw new McpInstallInputError(
          "unsupported_shape",
          `server "${fallbackName}": every entry in "args" must be a string (got ${typeof arg})`,
        );
      }
      args.push(arg);
    }
  }
  const envKeys: string[] = [];
  if (config.env !== undefined) {
    if (typeof config.env !== "object" || config.env === null || Array.isArray(config.env)) {
      throw new McpInstallInputError("unsupported_shape", `server "${fallbackName}": "env" must be an object`);
    }
    const entries = Object.entries(config.env as Record<string, unknown>);
    if (entries.length > 0) {
      // 只留键名：把 env 值写进库等于把凭据明文落盘
      for (const [key] of entries) envKeys.push(key);
      warnings.push(
        `server "${fallbackName}": env values were discarded (keys: ${entries.map(([key]) => key).join(", ")}); ` +
          "store secrets in the OS credential store and inject them at launch",
      );
    }
  }
  let cwd: string | null = null;
  if (config.cwd !== undefined) {
    if (typeof config.cwd !== "string") {
      throw new McpInstallInputError("unsupported_shape", `server "${fallbackName}": "cwd" must be a string`);
    }
    cwd = config.cwd;
  }
  const name =
    typeof config.displayName === "string" && config.displayName.trim().length > 0
      ? config.displayName.trim()
      : fallbackName;
  return { display_name: name, command: config.command.trim(), args, env_keys: envKeys, cwd, source };
}

/** 风险确认未勾选 → 拒绝（这是安装路径上的硬门槛，不是 UI 提示） */
export function assertRiskAcknowledged(acknowledged: unknown): void {
  if (acknowledged !== true) {
    throw new McpInstallInputError(
      "risk_not_acknowledged",
      "MCP server installation requires explicit risk acknowledgment: the server runs with host-level " +
        "privileges. Pass risk_acknowledged=true only after showing the full launch command to the Owner.",
    );
  }
}

/**
 * server_id：由显示名派生（稳定、可读、便于在工具名前缀里认出来）。
 *
 * 不用随机 uuid 的理由：MCP 工具名是 `mcp.<server>.<tool>`，server 段若是不透明
 * uuid，UI/日志里就没法一眼看出工具来自哪台 server。
 */
export function serverIdFor(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (slug.length > 0) return slug;
  // 纯中文名等无法 slug 化：用哈希后缀保证唯一性与稳定性
  const digest = createHash("sha256").update(displayName, "utf8").digest("hex").slice(0, 8);
  return `server-${digest}`;
}

/** 模板：**只预填表单**，不预装不预授权（FR-B2 的明确要求） */
export interface McpTemplate {
  /** 模板 id（UI 的 key） */
  id: string;
  label: string;
  description: string;
  /** 预填的启动命令（未安装、未授权，仅文本） */
  command: string;
  args: string[];
  /** 该 server 的典型用途说明（不承诺权限） */
  notes: string;
}

export const MCP_TEMPLATES: readonly McpTemplate[] = [
  {
    id: "filesystem",
    label: "Filesystem",
    description: "读写指定目录下的文件（作为 MCP 工具暴露给 Agent）",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
    notes: "它本身以宿主进程运行，能读写的范围由参数决定；Morrow 只约束经其注册的工具调用。",
  },
  {
    id: "git",
    label: "Git",
    description: "对本地仓库执行 git 只读/写操作",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-git", "--repository", "/path/to/repo"],
    notes: "可改写仓库内容（commit/checkout）。建议先在测试仓库试用。",
  },
  {
    id: "fetch",
    label: "Fetch",
    description: "抓取网页内容并转成 Markdown",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    notes: "会出网。抓取目标由 Agent 决定，Morrow 不审查内容。",
  },
];

/** 模板 → 可编辑的表单值（**不**产生任何安装副作用） */
export function templateToDraft(template: McpTemplate): McpServerDraft {
  return {
    display_name: template.label.toLowerCase(),
    command: template.command,
    args: [...template.args],
    env_keys: [],
    cwd: null,
    source: "template",
  };
}
