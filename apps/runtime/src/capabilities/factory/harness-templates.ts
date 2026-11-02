/**
 * 运行时自有打包模板（票 M2-T3 / Issue #24）——非生成代码，全部工具共用。
 *
 * 生成源码只导出 `run(input)`（纯函数契约：失败 throw，绝不碰 stdin/stdout/exit）；
 * 两份包装模板负责其余一切：
 *   ENTRY_TEMPLATE      独立执行入口：stdin JSON → run() → stdout 单行信封（T2 protocol.ts
 *                       契约）。注册后的运行时调用路径（SandboxToolPackage.entry）。
 *   VERIFY_TEMPLATE     容器内断言脚本：stdin = 单条测试用例规格，执行 run() 并按 expect
 *                       裁决，stdout 信封 result = {case_id, pass, detail}。「测试用例即
 *                       容器内断言脚本」——Verifier 逐条注入规格，pass=false 即断言失败。
 */

/** 独立执行入口（注册后运行时调用的打包入口） */
export const ENTRY_TEMPLATE = `/**
 * 沙箱协议包装（Morrow 运行时模板——非生成代码）：stdin JSON → run() → stdout 单行信封。
 */
import { run } from "./tool.ts";

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}

let input: unknown = {};
try {
  const raw = (await readStdin()).trim();
  if (raw.length > 0) input = JSON.parse(raw) as unknown;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: \`malformed stdin JSON: \${message}\` }) + "\\n");
  process.exit(1);
}

try {
  const result = await run(input);
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\\n");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\\n");
  process.exit(1);
}
`;

/** 容器内断言脚本（Verifier 逐用例注入 stdin 规格并裁决 pass/fail） */
export const VERIFY_TEMPLATE = `/**
 * 容器内断言脚本（Morrow 运行时模板——非生成代码）。stdin = 单条测试用例规格：
 * {case_id, kind, input, expect:{outcome, result?, errorContains?}}；stdout 信封
 * result = {case_id, pass, detail}（pass=false = 断言失败；verifier 聚合为验证报告）。
 */
import { run } from "./tool.ts";

interface CaseSpec {
  case_id: string;
  kind?: string;
  input: unknown;
  expect: { outcome: "success" | "failure"; result?: unknown; errorContains?: string };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (Array.isArray(v)) return v.map((item) => item);
    if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      return Object.fromEntries(entries);
    }
    return v;
  });
}

function truncate(text: string): string {
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}

const raw = (await readStdin()).trim();
let spec: CaseSpec;
try {
  spec = JSON.parse(raw) as CaseSpec;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ ok: false, error: \`malformed case spec JSON: \${message}\` }) + "\\n");
  process.exit(1);
}

let verdict: { case_id: string; pass: boolean; detail: string };
try {
  const result = await run(spec.input);
  if (spec.expect.outcome === "failure") {
    verdict = {
      case_id: spec.case_id,
      pass: false,
      detail: \`expected failure but tool succeeded with \${truncate(stableJson(result))}\`,
    };
  } else if (spec.expect.result !== undefined && stableJson(spec.expect.result) !== stableJson(result)) {
    verdict = {
      case_id: spec.case_id,
      pass: false,
      detail: \`result mismatch: expected \${truncate(stableJson(spec.expect.result))}, got \${truncate(stableJson(result))}\`,
    };
  } else {
    verdict = { case_id: spec.case_id, pass: true, detail: "ok" };
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (spec.expect.outcome !== "failure") {
    verdict = { case_id: spec.case_id, pass: false, detail: \`expected success but tool failed: \${truncate(message)}\` };
  } else if (spec.expect.errorContains !== undefined && !message.includes(spec.expect.errorContains)) {
    verdict = {
      case_id: spec.case_id,
      pass: false,
      detail: \`failed as expected but error "\${truncate(message)}" does not contain "\${spec.expect.errorContains}"\`,
    };
  } else {
    verdict = {
      case_id: spec.case_id,
      pass: true,
      detail: \`\${spec.kind ?? "case"} blocked/failed as expected: \${truncate(message)}\`,
    };
  }
}

process.stdout.write(JSON.stringify({ ok: true, result: verdict }) + "\\n");
`;
