/**
 * Generator 接缝与默认实现（票 M2-T3 / Issue #24，FR-CAP-2 能力规划）。
 *
 * 新内部接缝 CapabilityGenerator：输入 = 需求描述 + 检索上下文（现有能力、FTS 记忆命中、
 * 当前 grant 面），输出 = GeneratorResult（成功携带 GeneratorOutput 原始计划；失败结构化，
 * 绝不抛——调用方 CapabilityFactory 把失败落成 capability.factory_failed(stage=plan)）。
 *
 * 默认实现 PiCapabilityGenerator 经 AgentRuntime 冻结接口（ADR-0001）走一次 prompt：
 * 订阅 text_delta 拼接全文 → agent_end 收尾 → extractJsonObject 定位首个平衡 JSON 对象
 * （剥 code fence / 剔除散文噪声）→ JSON.parse。输出是否合法由 plan-schema.ts 单独裁决
 * （生成器只负责搬运，不做语义校验——单一职责）。
 *
 * 测试经 FakePi 脚本化（零网络）；生产接线见 runtime.ts（默认 Provider + 工厂系统提示词）。
 */

import type { AgentRuntime, MorrowAgentEvent } from "@morrow/pi-adapter";
import type { GeneratorResult, GeneratorOutput } from "./types.ts";

export interface CapabilityGeneratorContext {
  /** Owner/渠道提出的缺失能力需求描述（原文） */
  description: string;
  /** 当前五维授权面（生成 manifest 的硬上界：permissions ⊆ grants） */
  grants: {
    filesystem: string[];
    network: string[];
    shell: string[];
    channels: string[];
    credentials: string[];
  };
  /** 现有能力（注册表 + 工厂描述索引投影） */
  existing: Array<{ name: string; description: string | null }>;
  /** FTS 记忆命中（相关经验，FR-CAP-1 检索半边） */
  memoryHits: Array<{ content: string; entry_kind: string }>;
}

/** 生成器接缝：实现不得抛异常——一切失败折叠进 GeneratorResult */
export interface CapabilityGenerator {
  generate(ctx: CapabilityGeneratorContext): Promise<GeneratorResult>;
}

/**
 * 工厂系统提示词（生产默认）：只输出单个 JSON 对象；run() 打包契约；四类测试用例
 * 各至少一条且期望方向固定；权限最小化 ⊆ grant；零依赖优先、依赖必须锁精确版本。
 */
export const CAPABILITY_FACTORY_SYSTEM_PROMPT = `You are the Morrow Capability Factory planner.
Given a capability requirement, produce a plan for a new sandboxed TypeScript tool.
Respond with ONE JSON object and nothing else (no markdown fences, no prose). Shape:
{
  "name": "<lowercase-dotted-id>",
  "version": "1.0.0",
  "description": "<one line: what the tool does>",
  "permissions": {"filesystem":[],"network":[],"shell":[],"channels":[],"credentials":[]},
  "input_schema": {...}, "output_schema": {...},
  "sandbox": {"type":"container","network":"none","filesystem":"workspace-only"},
  "dependencies": {},
  "source": "<TypeScript module exporting: export async function run(input: T): Promise<R>>",
  "test_cases": [
    {"case_id":"...","kind":"positive","input":...,"expect":{"outcome":"success","result":...}},
    {"case_id":"...","kind":"negative","input":...,"expect":{"outcome":"failure","errorContains":"..."}},
    {"case_id":"...","kind":"privilege-escalation","input":...,"expect":{"outcome":"failure"}},
    {"case_id":"...","kind":"fault","input":...,"expect":{"outcome":"failure"}}
  ]
}
Hard rules:
- source must export "async function run"; throw an Error on invalid input or failure (never call process.exit, never read stdin/write stdout — the runtime wraps it).
- Declare the MINIMAL permissions needed; every declared item must be covered by the owner grant listed in the prompt. Never declare anything beyond it (escalation is rejected).
- Include at least one test case of EACH kind: positive, negative, privilege-escalation, fault. privilege-escalation input must try to make the tool exceed its declared permissions; the tool must refuse (throw).
- Prefer ZERO dependencies (node: builtins only). If a dependency is essential, pin the exact version (e.g. "2.4.5"); ranges are rejected.
- The tool runs in a container with network disabled and only the workspace mounted; pure computation tools should declare empty permissions.
- Use double quotes; output valid JSON only.`;

export interface PiCapabilityGeneratorOptions {
  /**
   * 一次生成用 AgentRuntime 工厂（入参 = 组装好的用户提示词；系统提示词由宿主在创建
   * 适配器时携带——与任务域 defaultTaskRuntimeFactory 同一接线口径）。
   */
  runtimeFactory: (prompt: string) => Promise<AgentRuntime>;
  systemPrompt?: string;
}

const RAW_TAIL_LIMIT = 800;

export class PiCapabilityGenerator implements CapabilityGenerator {
  readonly #runtimeFactory: (prompt: string) => Promise<AgentRuntime>;
  readonly #systemPrompt: string;

  constructor(options: PiCapabilityGeneratorOptions) {
    this.#runtimeFactory = options.runtimeFactory;
    this.#systemPrompt = options.systemPrompt ?? CAPABILITY_FACTORY_SYSTEM_PROMPT;
  }

  get systemPrompt(): string {
    return this.#systemPrompt;
  }

  async generate(ctx: CapabilityGeneratorContext): Promise<GeneratorResult> {
    const prompt = buildUserPrompt(ctx);
    let runtime: AgentRuntime;
    try {
      runtime = await this.#runtimeFactory(prompt);
    } catch (err) {
      return {
        ok: false,
        code: "runtime_error",
        detail: `generator runtime failed to start: ${errorMessage(err)}`,
      };
    }

    let text = "";
    let runtimeError: string | null = null;
    const unsubscribe = runtime.subscribe((event: MorrowAgentEvent) => {
      if (event.type === "text_delta") text += event.delta;
      else if (event.type === "error") runtimeError = event.message;
    });
    try {
      await runtime.prompt(prompt);
    } catch (err) {
      // prompt 只在误用（并发/已 dispose）时 reject；一并折进 runtime_error
      unsubscribe();
      runtime.dispose();
      return { ok: false, code: "runtime_error", detail: `generator prompt rejected: ${errorMessage(err)}` };
    }
    unsubscribe();
    runtime.dispose();

    if (runtimeError !== null) {
      return { ok: false, code: "runtime_error", detail: `generator runtime error: ${runtimeError}`, raw: tail(text) };
    }
    const parsed = extractJsonObject(text);
    if (parsed === null) {
      return {
        ok: false,
        code: "no_output",
        detail: "model output contained no parsable JSON object (expected a single plan object)",
        raw: tail(text),
      };
    }
    return { ok: true, output: parsed as GeneratorOutput, raw: text };
  }
}

/** 用户提示词：需求原文 + grant 面 + 检索上下文（现有能力与记忆经验） */
export function buildUserPrompt(ctx: CapabilityGeneratorContext): string {
  const lines: string[] = [];
  lines.push(`Capability requirement: ${ctx.description}`);
  lines.push("");
  lines.push("Owner permission grant (the manifest permissions MUST stay within this):");
  lines.push(JSON.stringify(ctx.grants));
  if (ctx.existing.length > 0) {
    lines.push("");
    lines.push("Existing registered capabilities (do not rebuild these):");
    for (const item of ctx.existing) {
      lines.push(`- ${item.name}${item.description === null ? "" : `: ${item.description}`}`);
    }
  }
  if (ctx.memoryHits.length > 0) {
    lines.push("");
    lines.push("Relevant memory (past experience):");
    for (const hit of ctx.memoryHits) {
      lines.push(`- ${hit.content}`);
    }
  }
  return lines.join("\n");
}

/**
 * 从模型输出定位首个平衡的 JSON 对象：先试全文直解（含 fence 内裸 JSON），
 * 再扫首个 "{" 起的平衡子串（字符串字面量感知）。找不到/解析失败 → null。
 */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const direct = tryParse(trimmed);
  if (direct !== unset) return direct;

  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const parsed = tryParse(trimmed.slice(start, i + 1));
        if (parsed !== unset) return parsed;
        return null;
      }
    }
  }
  return null;
}

const unset = Symbol("unset");
function tryParse(candidate: string): unknown | typeof unset {
  // 剥 ```json ... ``` 围栏后直解
  const stripped = candidate
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return unset;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= RAW_TAIL_LIMIT ? trimmed : `…${trimmed.slice(-RAW_TAIL_LIMIT)}`;
}
