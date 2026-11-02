import type { MemoryEntryKind } from "@morrow/protocol";

/**
 * 高价值记忆启发式（票 M1-T1 / Issue #13，FR-MEM-2「即时写入」）。
 *
 * 确定性规则（不依赖模型），对话文本命中即产生 MemoryCandidate；独立成模块便于
 * T2 后台抽取（FR-MEM-3）复用与单测。规则按优先级排列，取第一个命中：
 *
 *   1. explicit-remember     显式委托："记住 X / 记一下 X / remember that X / make a note"
 *                            内容 = 命中句中关键词之后的部分（剥离前导标点）
 *   2. preference-statement  偏好陈述："我喜欢/我不喜欢/我偏好/我偏爱/我习惯/我讨厌"、
 *                            "I like/prefer/love/hate/enjoy…"；内容 = 命中句全文
 *   3. fact-statement        事实陈述："我是/我在/我住在/我叫"、"I am / I live in /
 *                            I work at / My … is"；内容 = 命中句全文
 *
 * 置信度为各规则固有的确定性值（显式委托 > 偏好 > 事实）。已知边界（如实）：
 * 规则按句匹配、无法理解语义——反讽/引用对话中的误报与漏报都存在，由 T2 巩固
 * （置信度整合 + 冲突审核）兜底；本模块只负责"宁可多存候选，不静默丢弃"。
 */

/** 命中的高价值规则名（T2 复用） */
export type HighValueRule = "explicit-remember" | "preference-statement" | "fact-statement";

/** 一次高价值命中：规则名、条目类型、提取出的记忆内容与确定性置信度 */
export interface HighValueMatch {
  rule: HighValueRule;
  kind: MemoryEntryKind;
  content: string;
  confidence: number;
}

/** 显式委托（中文：可选敬语 + 记住/记下/记着/记一下；英文：remember/make a note/memorize） */
const REMEMBER_RE = /(?:帮我|请|麻烦你?|劳驾)?\s*(?:记一下|记住|记着|记下)|remember(?: that)?|make a note(?: that)?|memorize/i;
/** 偏好陈述（中文以"我"起头；英文第一人称 + 好恶动词） */
const PREFERENCE_RE = /我(?:不喜欢|讨厌|偏好|偏爱|喜欢|习惯)|\b(?:i|we)\s+(?:really\s+|usually\s+|always\s+)?(?:like|love|hate|prefer|enjoy)\b/i;
/** 事实陈述（"我是/我在/我住在/我叫"；"I am / I live in / I work at / I was born / My … is"） */
const FACT_RE = /我(?:是|在|住在|叫|就职于|目前住)|\bi\s+(?:am|live in|work at|study at|was born)\b|\bmy\b[^。！？!?\n]{0,40}?\bis\b/i;

/** 关键词之后内容的前导杂字符（冒号、逗号、空白） */
const LEADING_NOISE_RE = /^[：:，,、\s]+/;

/** 句子分隔：中英句读与换行（启发式只看句内，避免把相邻闲聊句带进记忆内容） */
const SENTENCE_SPLIT_RE = /[。！？!?\n]+/;

/**
 * 检测一条用户文本是否命中高价值记忆规则；返回第一个命中（规则优先级从高到低），
 * 无命中（闲聊、提问、请求）返回 null。
 */
export function detectHighValue(text: string): HighValueMatch | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const sentences = trimmed.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter((s) => s.length > 0);
  return matchSentences(sentences, REMEMBER_RE, "explicit-remember", "fact", 0.9, extractAfterKeyword)
    ?? matchSentences(sentences, PREFERENCE_RE, "preference-statement", "preference", 0.8)
    ?? matchSentences(sentences, FACT_RE, "fact-statement", "profile", 0.7);
}

function matchSentences(
  sentences: string[],
  re: RegExp,
  rule: HighValueRule,
  kind: MemoryEntryKind,
  confidence: number,
  extract: (sentence: string) => string | null = wholeSentence,
): HighValueMatch | null {
  for (const sentence of sentences) {
    if (!re.test(sentence)) continue;
    const content = extract(sentence);
    if (content === null) return null; // 命中但提不出内容（如只说了"记住"）：不产生空候选
    return { rule, kind, content, confidence };
  }
  return null;
}

function wholeSentence(sentence: string): string {
  return sentence;
}

/** explicit-remember：取关键词之后的部分；为空说明没有可记的内容 */
function extractAfterKeyword(sentence: string): string | null {
  const match = REMEMBER_RE.exec(sentence);
  if (match === null) return null;
  const rest = sentence.slice(match.index + match[0].length).replace(LEADING_NOISE_RE, "").trim();
  return rest.length > 0 ? rest : null;
}
