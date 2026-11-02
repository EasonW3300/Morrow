/**
 * 能力检索（票 M2-T3 / Issue #24，FR-CAP-1：先查现有 Tool/Skill/MCP，避免重复造轮子）。
 *
 * 三个确定性检索源（无 LLM——复用判定必须可测试、可复现）：
 *   registry       PermissionEngine 注册表：能力 name 分词（- . _ 拆分，停用词过滤）被
 *                  需求**全部**提及（coverage=1）才算命中——部分分词不算（"markdown" 单词
 *                  不足以复用 docx-to-markdown）。
 *   factory-index  工厂历史产物描述索引（generator 产出的 description 字段；注册表
 *                  manifest 无该字段）：需求与描述的 token Jaccard ≥ 0.5 视为同一能力。
 *   memory         FTS 记忆检索（MemoryService.search 注入——相关经验上下文）；记忆命中
 *                  只进生成上下文，不单独触发复用（经验 ≠ 已有能力）。
 *
 * reused=true 时工厂走复用路径：落 capability.factory_retrieved(reused:true) 后结束，
 * 不规划、不构建、不注册（测试断言复用不产生后续阶段事件）。
 */

import type { PermissionEngine } from "../engine.ts";

export interface RetrievalMatch {
  source: "registry" | "factory-index";
  name: string;
  description: string | null;
  /** registry = name 分词覆盖率；factory-index = Jaccard 相似度（均 0..1） */
  score: number;
}

export interface MemoryMatch {
  content: string;
  entry_kind: string;
}

export interface RetrievalResult {
  /** true = 命中已有能力，走复用路径不重建 */
  reused: boolean;
  /** 能力命中（registry + factory-index 合并，score 降序） */
  matches: RetrievalMatch[];
  /** FTS 记忆命中（相关经验；供生成上下文） */
  memoryHits: MemoryMatch[];
  /** 参与比对的注册表能力数（可观测性） */
  considered: number;
}

export interface CapabilityRetriever {
  retrieve(description: string): RetrievalResult;
}

export interface DefaultCapabilityRetrieverOptions {
  capabilities: PermissionEngine;
  /** 工厂描述索引投影（service 提供 store 查询；空数组 = 无历史产物） */
  describeCapabilities: () => Array<{ name: string; description: string | null }>;
  /** FTS 记忆检索（MemoryService.search 绑定注入；缺省 = 无记忆域） */
  memorySearch?: (query: string) => Array<{ content: string; entry_kind: string }>;
  /** 复用判定阈值：registry 覆盖率（默认 1 = 全分词命中） */
  registryCoverageThreshold?: number;
  /** factory-index Jaccard 阈值（默认 0.5） */
  descriptionJaccardThreshold?: number;
}

/** 泛化停用词：不参与能力名比对（避免 "use"/"write" 之类的误命中） */
const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "with", "and", "or", "my", "me", "i",
  "please", "want", "need", "can", "you", "it", "into", "from", "by", "at", "be", "is",
  "are", "do", "does", "this", "that", "some", "use", "using", "make", "get", "give",
  "help", "let", "should", "would", "could", "new", "create", "工具", "帮", "帮我",
  "我", "的", "了", "吗", "请", "想要", "需要", "一个", "生成", "写", "做",
]);

export function capabilityTokens(text: string): string[] {
  const raw = text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return [...new Set(raw)];
}

export class DefaultCapabilityRetriever implements CapabilityRetriever {
  readonly #capabilities: PermissionEngine;
  readonly #describeCapabilities: () => Array<{ name: string; description: string | null }>;
  readonly #memorySearch?: (query: string) => Array<{ content: string; entry_kind: string }>;
  readonly #registryThreshold: number;
  readonly #jaccardThreshold: number;

  constructor(options: DefaultCapabilityRetrieverOptions) {
    this.#capabilities = options.capabilities;
    this.#describeCapabilities = options.describeCapabilities;
    this.#memorySearch = options.memorySearch;
    this.#registryThreshold = options.registryCoverageThreshold ?? 1;
    this.#jaccardThreshold = options.descriptionJaccardThreshold ?? 0.5;
  }

  retrieve(description: string): RetrievalResult {
    const requestTokens = new Set(capabilityTokens(description));

    const registered = this.#capabilities.list();
    const matches: RetrievalMatch[] = [];

    // 1. 注册表：能力 name 全分词被需求提及 → 命中（score = 覆盖率）
    for (const record of registered) {
      const nameTokens = capabilityTokens(record.name);
      if (nameTokens.length === 0) continue;
      const overlap = nameTokens.filter((token) => requestTokens.has(token)).length;
      const coverage = overlap / nameTokens.length;
      if (coverage >= this.#registryThreshold) {
        matches.push({ source: "registry", name: record.name, description: null, score: coverage });
      }
    }

    // 2. 工厂描述索引：历史产物 description 与需求 Jaccard 相似
    for (const entry of this.#describeCapabilities()) {
      const descriptionTokens = capabilityTokens(`${entry.name} ${entry.description ?? ""}`);
      if (descriptionTokens.length === 0) continue;
      const overlap = descriptionTokens.filter((token) => requestTokens.has(token)).length;
      const union = new Set([...requestTokens, ...descriptionTokens]).size;
      const jaccard = overlap / union;
      if (jaccard >= this.#jaccardThreshold) {
        matches.push({ source: "factory-index", name: entry.name, description: entry.description, score: jaccard });
      }
    }

    matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    // 3. FTS 记忆（相关经验；不触发复用）
    let memoryHits: MemoryMatch[] = [];
    if (this.#memorySearch !== undefined && requestTokens.size > 0) {
      try {
        memoryHits = this.#memorySearch([...requestTokens].join(" ")).map((hit) => ({
          content: hit.content,
          entry_kind: hit.entry_kind,
        }));
      } catch {
        memoryHits = []; // 记忆域故障不阻断检索（检索降级为仅注册表）
      }
    }

    return { reused: matches.length > 0, matches, memoryHits, considered: registered.length };
  }
}
