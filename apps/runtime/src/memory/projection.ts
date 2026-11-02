import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFactRow } from "./store.ts";
import type { MemoryStore } from "./store.ts";
import { UUID_RE } from "../uuid-v7.ts";

/**
 * Markdown 投影（票 M1-T3 / Issue #15，FR-MEM-6，PRD §6.4）：
 * 长期记忆（memory_facts 现存有效事实）投影为 `dataDir/memory/{fact_id}.md`。
 *
 * 格式（PRD §6.4 字段集，严格按票面清单的键序）：frontmatter 十字段
 *   id / type / sensitivity / confidence / valid_from / valid_until / sources /
 *   created_at / updated_at / version
 * 正文 = 人类可读内容（fact.content 原文）。已删（deleted_at 非空）与已过期
 * （valid_until 非空）事实不投影；projectAll 同时清理「非现存事实」的孤儿投影文件。
 *
 * 幂等口径：渲染是 store 状态的纯函数——同状态产出同字节（写入端统一 LF + 尾随换行，
 * 不需要换行归一这一层），projectAll 只在字节差异时写盘（避免 mtime 抖动），再跑同状态
 * 的投影目录逐字节不变。文件清理只碰 `{uuid}.md` 形态的孤儿，外来文件（用户自己的笔记）
 * 一律不动。
 *
 * 值格式说明（与 PRD 示例的两处刻意偏差，取无损/一致性优先）：
 *   - id 用 fact_id 原文（uuid v7，不带 `mem_` 前缀）——与 GET /v1/memory/facts 的 `id`
 *     和文件名同一真相源，导入按 id 直达事实；
 *   - valid_from/valid_until/created_at/updated_at 用完整 ISO 8601 UTC（示例中的日期只有
 *     年月日是无损性妥协）——投影→导入往返不丢时间信息。
 *   - confidence：事实无置信度（GLOSSARY：置信度是候选的属性），字段按 §6.4 字段集保留，
 *     值写 `null`。
 */

/** 投影运行摘要（POST /v1/memory/project 的响应体） */
export interface ProjectionResult {
  /** 新写或内容有变的 fact_id（含新建投影） */
  written: string[];
  /** 内容逐字节未变、跳过写盘的 fact_id */
  unchanged: string[];
  /** 清理掉的孤儿投影文件（对应 fact 已删除/不存在）的 fact_id */
  removed: string[];
}

/**
 * 渲染单条事实为 §6.4 Markdown。纯函数：同 (fact, sources) 同字节。
 * sources = 事实的来源账本事件 id 数组（回链审计的投影面）。
 */
export function renderFactMarkdown(fact: MemoryFactRow, sources: string[]): string {
  return [
    "---",
    `id: ${fact.fact_id}`,
    `type: ${fact.kind}`,
    `sensitivity: ${fact.sensitivity}`,
    "confidence: null",
    `valid_from: ${fact.valid_from}`,
    `valid_until: ${fact.valid_until ?? "null"}`,
    `sources: ${JSON.stringify(sources)}`,
    `created_at: ${fact.created_at}`,
    `updated_at: ${fact.updated_at}`,
    `version: ${fact.version}`,
    "---",
    "",
    fact.content,
    "",
  ].join("\n");
}

/** 受控导入的 Markdown 解析失败（缺 frontmatter/分隔符/字段形态非法） */
export class MarkdownParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownParseError";
  }
}

/**
 * 解析 §6.4 Markdown（受控导入入口）：frontmatter 键值（原样字符串）+ 正文。
 * 键值不做类型转换——version/sensitivity 等由导入方按业务校验解释；
 * sources 等复合值保持原文本（导入方需要时自行 JSON.parse）。
 * 行内注释（PRD 示例中的 `# ...`）不剥离——解析器只服务本投影器写出的形态。
 */
export function parseFactMarkdown(text: string): { fields: Record<string, string>; body: string } {
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw new MarkdownParseError("frontmatter opening `---` line missing");
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    throw new MarkdownParseError("frontmatter closing `---` line missing");
  }
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    if (line.trim().length === 0) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) {
      throw new MarkdownParseError(`malformed frontmatter line: ${JSON.stringify(line)}`);
    }
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");
  return { fields, body };
}

/**
 * 投影器：facts 表 → dataDir/memory/*.md。持有 store 只读面（listFacts/getFact/
 * factSourceEventIds），自身无资源需要关闭。生产接线在 runtime.ts；导入修订后单事实
 * 刷新走 writeFact，删除后文件移除走 removeFact（由 MemoryService 回调，保证三操作
 * 与投影目录一致），全量再生成走 projectAll（幂等命令）。
 */
export class MemoryProjector {
  /** 投影目录（dataDir/memory） */
  readonly dir: string;
  readonly #store: MemoryStore;

  constructor(deps: { store: MemoryStore; dataDir: string }) {
    this.#store = deps.store;
    this.dir = join(deps.dataDir, "memory");
  }

  /**
   * 全量再生成（幂等）：现存有效事实逐条渲染，字节有差才写盘；清理孤儿
   * （`{uuid}.md` 形态但不在现存事实集内——已删除/已过期/行已消失），外来文件不动。
   */
  projectAll(): ProjectionResult {
    mkdirSync(this.dir, { recursive: true });
    const facts = this.#store.listFacts();
    const live = new Map<string, string>();
    for (const fact of facts) {
      live.set(fact.fact_id, renderFactMarkdown(fact, this.#store.factSourceEventIds(fact.fact_id)));
    }
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const [factId, markdown] of live) {
      const file = join(this.dir, `${factId}.md`);
      const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (existing === markdown) {
        unchanged.push(factId);
      } else {
        writeFileSync(file, markdown, "utf8");
        written.push(factId);
      }
    }
    const removed: string[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".md")) continue;
      const stem = name.slice(0, -".md".length);
      // 只清理本投影器的命名形态（uuid.md）；用户放置的其他文件一律不动
      if (!UUID_RE.test(stem) || live.has(stem)) continue;
      rmSync(join(this.dir, name));
      removed.push(stem);
    }
    return { written, unchanged, removed };
  }

  /** 单事实刷新（导入修订落定后调用）；事实不存在或已删时不写并返回 false */
  writeFact(factId: string): boolean {
    const fact = this.#store.getFact(factId);
    if (fact === null || fact.deleted_at !== null) return false;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${factId}.md`), renderFactMarkdown(fact, this.#store.factSourceEventIds(factId)), "utf8");
    return true;
  }

  /** 移除单事实投影文件（删除标记落定后调用）；文件不存在时静默返回 false */
  removeFact(factId: string): boolean {
    if (!UUID_RE.test(factId)) return false;
    const file = join(this.dir, `${factId}.md`);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }
}
