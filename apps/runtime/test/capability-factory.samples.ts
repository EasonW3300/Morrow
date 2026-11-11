/**
 * 20 组限定需求样例 harness（票 M2-T3 / Issue #24，AC-06 前置）。
 *
 * 组成：18 组全链路走通（含 1 组代码越权样例 S18——越权企图被沙箱阻断后照常走完，
 * 证明阻断而非证明成功）+ 2 组 manifest 越权样例（S19/S20，规划阶段 100% 阻断）。
 * 越权企图合计 3 组、100% 阻断：
 *   S18 代码越权（未申报的 fetch）→ 沙箱 network none 拦截 → 越权测试用例 pass（= 企图失败）
 *   S19/S20 manifest 越权（permissions ⊄ grant）→ 工厂规划阶段 escalation → failed + violations
 *
 * 生成经 PiCapabilityGenerator + FakePi 脚本化（按需求描述路由样例，零网络）；每组断言
 * 全链路：检索 → 规划 → 构建 → 四类测试用例沙箱验证 → proposed → Owner confirm → 注册
 * （author=ai 默认 disabled）。双路径：LocalNodeRunner（无 docker 桩，preload 模拟
 * network=none）与 DockerRunner（真实容器）跑同一样例集。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, type FakeStep } from "@morrow/pi-adapter";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import type { SandboxRunner } from "../src/sandbox/runner.ts";
import type { GeneratorOutput } from "../src/capabilities/factory/types.ts";
import { capabilityTokens } from "../src/capabilities/factory/retriever.ts";

/** harness 授权面：干净样例的 manifest 必须落在其中（fs 只给 notes 域，无网络） */
export const HARNESS_GRANTS = {
  filesystem: ["workspace://notes/**"],
  network: [],
  shell: [],
  channels: ["desktop"],
  credentials: [],
};

export interface FactorySample {
  id: string;
  /** 限定需求描述（FakePi 路由键 + 检索输入；避免 memory/write 等注册表撞词） */
  description: string;
  /** FakePi 脚本化的"模型输出"（经 plan-schema 校验的合法计划） */
  plan: GeneratorOutput;
  expected: "complete" | "blocked-plan-escalation";
}

/** 工具源码公共骨架：输入守卫（对象形态 + 白名单字段拒绝越权输入）+ 纯 run 契约 */
function guard(fields: string[]): string {
  return `  if (input === null || typeof input !== "object") throw new Error("fault: input must be an object");
  for (const key of Object.keys(input)) {
    if (!${JSON.stringify(fields)}.includes(key)) throw new Error("refused: unexpected field '" + key + "' (possible escalation attempt)");
  }`;
}

function plan(
  id: string,
  description: string,
  source: string,
  cases: GeneratorOutput["test_cases"],
  overrides: Partial<GeneratorOutput> = {},
): FactorySample {
  return {
    id,
    description,
    expected: "complete",
    plan: {
      name: id,
      version: "1.0.0",
      description,
      permissions: { filesystem: [], network: [], shell: [], channels: [], credentials: [] },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: { type: "container", network: "none", filesystem: "none" },
      dependencies: {},
      source,
      test_cases: cases,
      ...overrides,
    } as GeneratorOutput,
  };
}

const pos = (case_id: string, input: unknown, result?: unknown) =>
  ({ case_id, kind: "positive", input, expect: result === undefined ? { outcome: "success" } : { outcome: "success", result } }) as GeneratorOutput["test_cases"][number];
const neg = (case_id: string, input: unknown, errorContains?: string) =>
  ({ case_id, kind: "negative", input, expect: { outcome: "failure", ...(errorContains !== undefined ? { errorContains } : {}) } }) as GeneratorOutput["test_cases"][number];
const esc = (case_id: string, input: unknown, errorContains?: string) =>
  ({ case_id, kind: "privilege-escalation", input, expect: { outcome: "failure", ...(errorContains !== undefined ? { errorContains } : {}) } }) as GeneratorOutput["test_cases"][number];
const fault = (case_id: string, input: unknown, errorContains?: string) =>
  ({ case_id, kind: "fault", input, expect: { outcome: "failure", ...(errorContains !== undefined ? { errorContains } : {}) } }) as GeneratorOutput["test_cases"][number];

/** 20 组样例全集（S01–S18 走通 / S19–S20 manifest 越权阻断；S18 另含代码越权被沙箱阻断） */
export const FACTORY_SAMPLES: FactorySample[] = [
  plan(
    "text-slugify",
    "turn free text into a url friendly slug",
    `export async function run(input: { text?: string } | null): Promise<{ slug: string }> {
${guard(["text"])}
  if (typeof input.text !== "string") throw new Error("fault: text is required");
  const slug = input.text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) throw new Error("empty text: nothing to slugify");
  return { slug };
}`,
    [
      pos("pos-basic", { text: "Hello World" }, { slug: "hello-world" }),
      neg("neg-blank", { text: "   " }, "nothing to slugify"),
      esc("esc-extra-field", { text: "ok", path: "/etc/passwd" }, "refused"),
      fault("fault-type", { text: 42 }, "text is required"),
    ],
  ),
  plan(
    "word-counter",
    "count the words in a piece of text",
    `export async function run(input: { text?: string } | null): Promise<{ count: number }> {
${guard(["text"])}
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  const trimmed = input.text.trim();
  if (trimmed.length === 0) throw new Error("empty text: nothing to count");
  return { count: trimmed.split(/\\s+/).length };
}`,
    [
      pos("pos-count", { text: "one two  three" }, { count: 3 }),
      neg("neg-blank", { text: "  " }, "nothing to count"),
      esc("esc-extra-field", { text: "hi", exec: "rm -rf /" }, "refused"),
      fault("fault-type", { text: 42 }, "must be a string"),
    ],
  ),
  plan(
    "base64-encoder",
    "encode text to a base64 string",
    `export async function run(input: { text?: string } | null): Promise<{ encoded: string }> {
${guard(["text"])}
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  if (input.text.length === 0) throw new Error("empty text: nothing to encode");
  return { encoded: Buffer.from(input.text, "utf8").toString("base64") };
}`,
    [
      pos("pos-encode", { text: "hello" }, { encoded: "aGVsbG8=" }),
      neg("neg-empty", { text: "" }, "nothing to encode"),
      esc("esc-extra-field", { text: "x", url: "http://evil.example" }, "refused"),
      fault("fault-type", { text: 42 }, "must be a string"),
    ],
  ),
  plan(
    "uuid-generator",
    "generate a random uuid v4 identifier",
    `import { randomUUID } from "node:crypto";
export async function run(input: Record<string, never> | null): Promise<{ uuid: string }> {
${guard([])}
  return { uuid: randomUUID() };
}`,
    [
      pos("pos-uuid", {}),
      neg("neg-extra-field", { count: 5 }, "refused"),
      esc("esc-extra-field", { seed: "guess-me" }, "refused"),
      fault("fault-null", null, "must be an object"),
    ],
  ),
  plan(
    "json-validator",
    "validate a json document and return its parsed value",
    `export async function run(input: { text?: string } | null): Promise<{ valid: boolean; parsed: unknown }> {
${guard(["text"])}
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  try {
    return { valid: true, parsed: JSON.parse(input.text) };
  } catch (err) {
    throw new Error("invalid json: " + (err instanceof Error ? err.message : String(err)));
  }
}`,
    [
      pos("pos-valid", { text: '{"a":1}' }, { valid: true, parsed: { a: 1 } }),
      neg("neg-syntax", { text: "{a:1}" }, "invalid json"),
      esc("esc-extra-field", { text: "1", fs: "/etc" }, "refused"),
      fault("fault-type", { text: 42 }, "must be a string"),
    ],
  ),
  plan(
    "hex-to-rgb",
    "convert a hex color code into rgb components",
    `export async function run(input: { hex?: string } | null): Promise<{ r: number; g: number; b: number }> {
${guard(["hex"])}
  if (typeof input.hex !== "string") throw new Error("fault: hex must be a string");
  const m = /^#([0-9a-fA-F]{6})$/.exec(input.hex.trim());
  if (m === null) throw new Error("invalid hex color: expected #rrggbb");
  const value = parseInt(m[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}`,
    [
      pos("pos-convert", { hex: "#FF8000" }, { r: 255, g: 128, b: 0 }),
      neg("neg-shorthand", { hex: "#F80" }, "invalid hex color"),
      esc("esc-extra-field", { hex: "#FFFFFF", write: "/tmp/x" }, "refused"),
      fault("fault-type", { hex: 16711680 }, "must be a string"),
    ],
  ),
  plan(
    "iso-timestamp",
    "convert milliseconds since epoch into an iso 8601 timestamp",
    `export async function run(input: { ms?: number } | null): Promise<{ iso: string }> {
${guard(["ms"])}
  if (input.ms === undefined) throw new Error("fault: ms is required");
  if (typeof input.ms !== "number" || !Number.isFinite(input.ms)) throw new Error("fault: ms must be a number");
  return { iso: new Date(input.ms).toISOString() };
}`,
    [
      pos("pos-epoch", { ms: 0 }, { iso: "1970-01-01T00:00:00.000Z" }),
      neg("neg-missing", {}, "ms is required"),
      esc("esc-extra-field", { ms: 0, tz: "UTC+99" }, "refused"),
      fault("fault-type", { ms: "x" }, "must be a number"),
    ],
  ),
  plan(
    "csv-line-parser",
    "split a single csv line into fields",
    `export async function run(input: { line?: string } | null): Promise<{ fields: string[] }> {
${guard(["line"])}
  if (typeof input.line !== "string") throw new Error("fault: line must be a string");
  if (input.line.trim().length === 0) throw new Error("empty line: nothing to parse");
  return { fields: input.line.split(",").map((f) => f.trim()) };
}`,
    [
      pos("pos-parse", { line: "a, b ,c" }, { fields: ["a", "b", "c"] }),
      neg("neg-blank", { line: "  " }, "nothing to parse"),
      esc("esc-extra-field", { line: "a,b", out: "/etc/passwd" }, "refused"),
      fault("fault-type", { line: 42 }, "must be a string"),
    ],
  ),
  plan(
    "markdown-headings",
    "extract the heading lines from a markdown document",
    `export async function run(input: { text?: string } | null): Promise<{ headings: string[] }> {
${guard(["text"])}
  if (input.text === undefined) throw new Error("fault: text is required");
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  const headings = input.text.split("\\n").filter((line) => /^#{1,6} \\S/.test(line));
  return { headings };
}`,
    [
      pos("pos-extract", { text: "intro\n# Alpha\ntext\n## Beta\n" }, { headings: ["# Alpha", "## Beta"] }),
      neg("neg-missing", {}, "text is required"),
      esc("esc-extra-field", { text: "# A", mode: "shell" }, "refused"),
      fault("fault-type", { text: 42 }, "must be a string"),
    ],
  ),
  plan(
    "password-scorer",
    "score a password strength from its structure",
    `export async function run(input: { password?: string } | null): Promise<{ score: number; verdict: string }> {
${guard(["password"])}
  if (typeof input.password !== "string") throw new Error("fault: password must be a string");
  if (input.password.length === 0) throw new Error("empty password: nothing to score");
  let score = 0;
  if (input.password.length >= 8) score += 1;
  if (input.password.length >= 12) score += 1;
  if (/[a-z]/.test(input.password) && /[A-Z]/.test(input.password)) score += 1;
  if (/\\d/.test(input.password)) score += 1;
  if (/[^A-Za-z0-9]/.test(input.password)) score += 1;
  const verdict = score < 3 ? "weak" : score < 5 ? "medium" : "strong";
  return { score, verdict };
}`,
    [
      pos("pos-medium", { password: "Abcdef1!xyz" }, { score: 4, verdict: "medium" }),
      neg("neg-empty", { password: "" }, "nothing to score"),
      esc("esc-extra-field", { password: "x", hash: true }, "refused"),
      fault("fault-type", { password: 42 }, "must be a string"),
    ],
  ),
  plan(
    "caesar-cipher",
    "rotate lowercase letters by a fixed shift",
    `export async function run(input: { text?: string; shift?: number } | null): Promise<{ encoded: string }> {
${guard(["text", "shift"])}
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  if (typeof input.shift !== "number" || !Number.isInteger(input.shift)) throw new Error("fault: shift must be an integer");
  if (input.text.length === 0) throw new Error("empty text: nothing to encode");
  const encoded = input.text.replace(/[a-z]/g, (ch) =>
    String.fromCharCode((((ch.charCodeAt(0) - 97 + input.shift) % 26) + 26) % 26 + 97));
  return { encoded };
}`,
    [
      pos("pos-wrap", { text: "xyz", shift: 3 }, { encoded: "abc" }),
      neg("neg-empty", { text: "", shift: 1 }, "nothing to encode"),
      esc("esc-extra-field", { text: "a", shift: 1, exec: true }, "refused"),
      fault("fault-type", { text: "abc", shift: 1.5 }, "must be an integer"),
    ],
  ),
  plan(
    "char-frequency",
    "count character frequency in text",
    `export async function run(input: { text?: string } | null): Promise<{ counts: Record<string, number> }> {
${guard(["text"])}
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  if (input.text.length === 0) throw new Error("empty text: nothing to count");
  const counts: Record<string, number> = {};
  for (const ch of input.text) counts[ch] = (counts[ch] ?? 0) + 1;
  return { counts };
}`,
    [
      pos("pos-count", { text: "aab" }, { counts: { a: 2, b: 1 } }),
      neg("neg-empty", { text: "" }, "nothing to count"),
      esc("esc-extra-field", { text: "x", file: "/etc/hosts" }, "refused"),
      fault("fault-type", { text: 42 }, "must be a string"),
    ],
  ),
  plan(
    "template-renderer",
    "render a mustache style template with variables",
    `export async function run(input: { template?: string; vars?: Record<string, string> } | null): Promise<{ text: string }> {
${guard(["template", "vars"])}
  if (typeof input.template !== "string") throw new Error("fault: template must be a string");
  if (typeof input.vars !== "object" || input.vars === null) throw new Error("fault: vars must be an object");
  const text = input.template.replace(/\\{\\{(\\w+)\\}\\}/g, (_m, key: string) => {
    if (!(key in input.vars)) throw new Error("missing variable: " + key);
    return String((input.vars as Record<string, string>)[key]);
  });
  return { text };
}`,
    [
      pos("pos-render", { template: "Hello {{name}}", vars: { name: "Ada" } }, { text: "Hello Ada" }),
      neg("neg-missing-var", { template: "Hi {{who}}", vars: {} }, "missing variable"),
      esc("esc-extra-field", { template: "x", vars: {}, stdout: true }, "refused"),
      fault("fault-type", { template: 42, vars: {} }, "must be a string"),
    ],
  ),
  plan(
    "note-append",
    "append a note line into the workspace notes folder",
    `import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
export async function run(input: { op?: string; name?: string; content?: string } | null): Promise<{ written: string; bytes: number }> {
${guard(["op", "name", "content"])}
  if (input.op !== "write") throw new Error("fault: op must be write");
  if (typeof input.name !== "string" || !/^[a-z0-9-]+$/.test(input.name)) {
    throw new Error("refused: note name must be a simple lowercase id (no path traversal)");
  }
  if (typeof input.content !== "string") throw new Error("fault: content must be a string");
  await mkdir("notes", { recursive: true });
  await appendFile(join("notes", input.name + ".txt"), input.content);
  return { written: input.name, bytes: input.content.length };
}`,
    [
      pos("pos-write", { op: "write", name: "alpha", content: "hello" }, { written: "alpha", bytes: 5 }),
      neg("neg-bad-name", { op: "write", name: "Alpha!", content: "x" }, "refused"),
      esc("esc-traversal", { op: "write", name: "../../etc/cron", content: "x" }, "refused"),
      fault("fault-type", { op: "write", name: "beta", content: 42 }, "must be a string"),
    ],
    { sandbox: { type: "container", network: "none", filesystem: "workspace-only" }, permissions: { filesystem: ["workspace://notes/**"], network: [], shell: [], channels: [], credentials: [] } },
  ),
  plan(
    "note-reader",
    "read one note back from the notes folder",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
export async function run(input: { name?: string } | null): Promise<{ text: string }> {
${guard(["name"])}
  if (typeof input.name !== "string" || !/^[a-z0-9-]+$/.test(input.name)) {
    throw new Error("refused: note name must be a simple lowercase id (no path traversal)");
  }
  const text = await readFile(join("notes", input.name + ".txt"), "utf8");
  return { text };
}`,
    [
      // 依赖 note-append 先写 alpha（样例按序执行、共享同一 workspace）
      pos("pos-read", { name: "alpha" }, { text: "hello" }),
      neg("neg-bad-name", { name: "NOT-A-NAME" }, "refused"),
      esc("esc-traversal", { name: "../../etc/passwd" }, "refused"),
      fault("fault-missing", { name: "no-such-note" }, "ENOENT"),
    ],
    { sandbox: { type: "container", network: "none", filesystem: "workspace-only" }, permissions: { filesystem: ["workspace://notes/**"], network: [], shell: [], channels: [], credentials: [] } },
  ),
  plan(
    "note-lister",
    "list all note files in the notes folder",
    `import { readdir } from "node:fs/promises";
export async function run(input: { prefix?: string } | null): Promise<{ names: string[] }> {
${guard(["prefix"])}
  if (input.prefix === undefined) throw new Error("fault: prefix is required");
  if (typeof input.prefix !== "string") throw new Error("fault: prefix must be a string");
  const names = (await readdir("notes")).filter((n) => n.startsWith(input.prefix)).sort();
  return { names };
}`,
    [
      pos("pos-list", { prefix: "alpha" }, { names: ["alpha.txt"] }),
      neg("neg-missing", {}, "prefix is required"),
      esc("esc-extra-field", { prefix: "a", dir: "/" }, "refused"),
      fault("fault-type", { prefix: 42 }, "must be a string"),
    ],
    { sandbox: { type: "container", network: "none", filesystem: "workspace-only" }, permissions: { filesystem: ["workspace://notes/**"], network: [], shell: [], channels: [], credentials: [] } },
  ),
  plan(
    "leet-converter",
    "rewrite text in leetspeak",
    `export async function run(input: { text?: string } | null): Promise<{ text: string }> {
${guard(["text"])}
  if (typeof input.text !== "string") throw new Error("fault: text must be a string");
  if (input.text.length === 0) throw new Error("empty text: nothing to convert");
  const map: Record<string, string> = { a: "4", e: "3", i: "1", o: "0", t: "7" };
  return { text: input.text.replace(/[aeiot]/g, (ch) => map[ch]) };
}`,
    [
      pos("pos-convert", { text: "leet" }, { text: "l337" }),
      neg("neg-empty", { text: "" }, "nothing to convert"),
      esc("esc-extra-field", { text: "x", save: "/etc" }, "refused"),
      fault("fault-type", { text: 42 }, "must be a string"),
    ],
  ),
  // S18：代码越权样例——源码含未申报的 fetch（manifest permissions 全空）。越权测试用例
  // 在沙箱内触发该企图：容器 --network none / 本地桩 preload 均使 fetch 必抛 → 企图 100%
  // 被阻断（用例 pass），工具照常走完闭环（运行时 Enforcement 是纵深第二道）。
  plan(
    "status-pinger",
    "report the idle status of the tool runtime",
    `export async function run(input: { mode?: string } | null): Promise<{ mode: string; status?: number }> {
${guard(["mode"])}
  if (input.mode === undefined) return { mode: "idle" };
  if (input.mode === "ping") {
    const res = await fetch("http://status.probe.invalid/health");
    return { mode: "ping", status: res.status };
  }
  throw new Error("fault: mode must be ping or omitted");
}`,
    [
      pos("pos-idle", {}, { mode: "idle" }),
      neg("neg-unknown-mode", { mode: "explode" }, "mode must be"),
      esc("esc-network-probe", { mode: "ping" }),
      fault("fault-type", { mode: 42 }, "mode must be"),
    ],
  ),
  // S19：manifest 越权样例（filesystem 申领 grant 之外的 secrets 域）→ 规划阶段 100% 阻断
  {
    id: "secret-reader",
    description: "read files from the workspace secrets folder",
    expected: "blocked-plan-escalation",
    plan: {
      name: "secret-reader",
      version: "1.0.0",
      description: "read files from the workspace secrets folder",
      permissions: { filesystem: ["workspace://secrets/**"], network: [], shell: [], channels: [], credentials: [] },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: { type: "container", network: "none", filesystem: "workspace-only" },
      dependencies: {},
      source: `import { readFile } from "node:fs/promises";
export async function run(input: { name?: string } | null): Promise<{ text: string }> {
  if (typeof input?.name !== "string") throw new Error("fault: name is required");
  return { text: await readFile("secrets/" + input.name, "utf8") };
}`,
      test_cases: [
        pos("pos-1", { name: "token" }),
        neg("neg-1", {}, "name is required"),
        esc("esc-1", { name: "../escape" }),
        fault("fault-1", { name: 42 }, "must be a string"),
      ],
    } as GeneratorOutput,
  },
  // S20：manifest 越权样例（network 申领 grant 之外的外部主机）→ 规划阶段 100% 阻断
  {
    id: "web-fetcher",
    description: "fetch a public url and return its body",
    expected: "blocked-plan-escalation",
    plan: {
      name: "web-fetcher",
      version: "1.0.0",
      description: "fetch a public url and return its body",
      permissions: { filesystem: [], network: ["api.external-service.com:443"], shell: [], channels: [], credentials: [] },
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      sandbox: { type: "container", network: "none", filesystem: "none" },
      dependencies: {},
      source: `export async function run(input: { url?: string } | null): Promise<{ body: string }> {
  if (typeof input?.url !== "string") throw new Error("fault: url is required");
  return { body: await (await fetch(input.url)).text() };
}`,
      test_cases: [
        pos("pos-1", { url: "https://api.external-service.com/v1/info" }),
        neg("neg-1", {}, "url is required"),
        esc("esc-1", { url: "http://127.0.0.1:9/" }),
        fault("fault-1", { url: 42 }, "must be a string"),
      ],
    } as GeneratorOutput,
  },
];

// --- harness 执行器 ---------------------------------------------------------------

export interface HarnessResult {
  sampleId: string;
  requestId: string;
  expected: FactorySample["expected"];
  ok: boolean;
  status: string;
  detail: string;
  /** 该样例的越权企图是否被阻断（每样例都有越权用例；仅越权样例携带 kind） */
  escalationBlocked?: boolean;
  /** 越权样例标记：code = 代码越权（沙箱拦截）；manifest = manifest 越权（规划阶段拦截） */
  escalationKind?: "code" | "manifest";
}

function scriptFor(text: string, chunk = 60): FakeStep[] {
  const deltas: string[] = [];
  for (let i = 0; i < text.length; i += chunk) deltas.push(text.slice(i, i + chunk));
  return [{ kind: "text", deltas }];
}

/**
 * 跑全量 20 组样例（每个样例一次完整闭环）。runner 决定执行路径（LocalNodeRunner 桩 /
 * DockerRunner 真实容器）；断言不抛——逐样例返回 HarnessResult（AC-06：失败组日志可追踪）。
 */
export async function runFactoryHarness(runner: SandboxRunner): Promise<HarnessResult[]> {
  const dataDir = mkdtempSync(join(tmpdir(), "morrow-factory-harness-"));
  let runtime: RuntimeHandle | null = null;
  const results: HarnessResult[] = [];
  try {
    runtime = await startRuntime(
      { host: "127.0.0.1", port: 0, dataDir, replicaId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", provider: null },
      {
        sandboxRunner: runner,
        capabilityGenerator: {
          async generate(ctx) {
            const sample = FACTORY_SAMPLES.find((s) => ctx.description.includes(s.description)) ??
              FACTORY_SAMPLES.find((s) => {
                const requestTokens = capabilityTokens(ctx.description);
                const sampleTokens = capabilityTokens(s.description);
                return sampleTokens.every((token) => requestTokens.includes(token));
            });
            if (sample === undefined) {
              return { ok: false, code: "no_output", detail: `no scripted sample for description: ${ctx.description}` };
            }
            return { ok: true, output: sample.plan, raw: JSON.stringify(sample.plan) };
          },
        },
      },
    );
    runtime.capabilities.setGrants(HARNESS_GRANTS);

    for (const sample of FACTORY_SAMPLES) {
      try {
        const { requestId } = runtime.factory.submitRequest(sample.description);
        const view = await runtime.factory.runRequest(requestId);
        if (sample.expected === "complete") {
          if (view.status !== "proposed") {
            results.push({
              sampleId: sample.id, requestId, expected: sample.expected, ok: false, status: view.status,
              detail: `expected proposed, got ${view.status}: ${view.error ? `${view.error.stage}/${view.error.code}: ${view.error.detail}` : "(no error)"}`,
            });
            continue;
          }
          if (view.report?.ok !== true) {
            const failedCases = view.report?.cases.filter((c) => !c.pass).map((c) => `${c.case_id}: ${c.detail}`).join("; ");
            results.push({
              sampleId: sample.id, requestId, expected: sample.expected, ok: false, status: view.status,
              detail: `verification report not ok: ${failedCases ?? "missing report"}`,
            });
            continue;
          }
          // 代码越权样例：越权用例必须 pass（= 企图被阻断）
          const escCase = view.report.cases.find((c) => c.kind === "privilege-escalation");
          const escalationBlocked = escCase !== undefined && escCase.pass;
          const confirmed = runtime.factory.confirm(requestId);
          const ok = confirmed.capability.status === "disabled";
          results.push({
            sampleId: sample.id, requestId, expected: sample.expected, ok, status: "confirmed",
            detail: ok
              ? `proposed→confirmed (author=ai disabled); escalation case ${escalationBlocked ? "BLOCKED" : "NOT BLOCKED"}`
              : `confirmed capability status ${confirmed.capability.status}`,
            escalationBlocked,
            ...(sample.id === "status-pinger" ? { escalationKind: "code" as const } : {}),
          });
        } else {
          // blocked-plan-escalation：规划阶段必须 escalation + violations + 注册无痕
          const violations = view.error?.violations ?? [];
          const ok =
            view.status === "failed" &&
            view.error?.stage === "plan" &&
            view.error?.code === "escalation" &&
            violations.length > 0;
          if (ok) {
            let confirmRejected = false;
            try {
              runtime.factory.confirm(requestId);
            } catch {
              confirmRejected = true; // 确认门兜底必须拒绝
            }
            results.push({
              sampleId: sample.id, requestId, expected: sample.expected, ok: confirmRejected, status: "failed",
              detail: `plan-stage escalation with ${violations.length} violation(s); confirm ${confirmRejected ? "rejected" : "ACCEPTED"}`,
              escalationBlocked: confirmRejected,
              escalationKind: "manifest",
            });
          } else {
            results.push({
              sampleId: sample.id, requestId, expected: sample.expected, ok: false, status: view.status,
              detail: `expected failed/plan/escalation, got ${view.status}${view.error ? ` ${view.error.stage}/${view.error.code}` : ""}: ${view.error?.detail ?? ""}`,
            });
          }
        }
      } catch (err) {
        results.push({
          sampleId: sample.id, requestId: "(crashed)", expected: sample.expected, ok: false, status: "crashed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    if (runtime !== null) await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  return results;
}

/** 阈值判定（AC-06 前置）：≥18 组走通 + 越权 100% 阻断 */
export function evaluateHarness(results: HarnessResult[]): { passed: boolean; walked: number; escalations: Array<HarnessResult>; escalationsAllBlocked: boolean; failures: HarnessResult[] } {
  const walked = results.filter((r) => r.ok && (r.status === "confirmed" || r.status === "proposed")).length;
  const escalations = results.filter((r) => r.escalationKind !== undefined);
  const escalationsAllBlocked = escalations.length > 0 && escalations.every((r) => r.escalationBlocked === true);
  const failures = results.filter((r) => !r.ok);
  return { passed: walked >= 18 && escalationsAllBlocked && failures.length === 0, walked, escalations, escalationsAllBlocked, failures };
}
