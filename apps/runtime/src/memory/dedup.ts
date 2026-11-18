/**
 * 记忆候选的近似去重（Issue #56）。
 *
 * ## 问题
 *
 * 一句"记住：我偏好用 TypeScript，不喜欢 Python"会产出**两条**候选：
 *   - `memory.write` 工具写入：`kind=fact`，内容近原文；
 *   - 轮次抽取器写入：`kind=preference`，内容是改写过的。
 *
 * 两者来源事件相同、语义相同、措辞不同。原有的去重只判**完全相同**内容，所以两条
 * 都进库；巩固器又要求"同主题 = kind 相同"，于是各自 `create_fact`，长期记忆里同一
 * 偏好存两条。
 *
 * ## 判定口径（宁严勿松）
 *
 * 去重的代价是不对称的：
 *   - **误合并**（把两条不同的记忆合成一条）→ 信息永久丢失，且用户很难发现；
 *   - **漏合并**（留下两条相似记忆）→ 噪声，但可检索到、可由 Owner 删。
 *
 * 所以阈值取**高**：要求特征集合的 Jaccard 相似度 ≥ 0.7，**且**长度差异不超过 50%。
 * 0.7 是把票面真实例子（原文 vs 加主语的改写）判为重复的最严取值——更低就开始
 * 把"我喜欢 TypeScript"与"我喜欢 Rust"也判成重复了。
 * 具体地：
 *   - 先规范化（去空白、小写、去标点）；
 *   - 用 CJK 字符二元组 + ASCII 词做特征集（单字太容易撞，整句太长太脆）；
 *   - Jaccard 相似度 ≥ 0.7 才算重复。
 *
 * 这个口径能认出"同一句话的两种改写"，但不会把"我喜欢 TypeScript"与"我喜欢 Rust"
 * 判成重复（两者共享"我喜欢"，但差异部分的 token 占比很大）。
 */

/** 去重的相似度阈值（Jaccard）；调低会开始误合并，调高会漏 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.7;

/** 允许的长度差异（短的那个至少是长的这个比例）；防止"包含关系"被当成重复 */
export const DUPLICATE_LENGTH_RATIO = 0.5;

/** 规范化：去标点/空白、转小写（保留 CJK 与字母数字） */
export function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    // 去掉标点与空白（保留 CJK、字母、数字）
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .trim();
}

/**
 * 特征集：CJK 连续段的二元组 + ASCII 词。
 *
 * 为什么 CJK 用二元组：单字（"我"、"的"）几乎出现在任何句子里，用单字会让所有
 * 中文句子都"相似"；整句又太脆（一个词不同就掉到 0）。二元组是中间粒度。
 */
export function memoryTokens(content: string): Set<string> {
  const normalized = normalizeMemoryContent(content);
  const tokens = new Set<string>();
  // ASCII/数字词（≥2 字符）
  for (const match of normalized.matchAll(/[a-z0-9]{2,}/g)) tokens.add(`w:${match[0]}`);
  // CJK 连续段 → 二元组（长度 1 的段退化为单字，避免完全丢失）
  for (const match of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add(`c:${run}`);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(`c:${run.slice(index, index + 2)}`);
    }
  }
  // 注意：**不要**把"整句"当作单个 token。初版这里用 /[\p{Letter}]+/gu 会把
  // `我偏好用typescript写脚本工具不喜欢python` 整段当成一个 `o:` token——它既与任何
  // 其它内容都不相同，又让集合里多出一个"永远不匹配"的元素，把相似度稀释掉
  // （实测票面例子的两条本该是重复，却只有 0.733）。CJK 与 ASCII 都已覆盖，
  // 其余文字（拉丁扩展、西里尔等）按词处理且**排除已处理的 CJK/ASCII**。
  for (const match of normalized.matchAll(/[\p{Letter}\p{Number}]+/gu)) {
    const word = match[0];
    if (/^[a-z0-9]+$/.test(word)) continue; // 已由 ASCII 分支处理
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(word)) continue; // 已由 CJK 分支处理
    if (word.length >= 2) tokens.add(`o:${word}`);
  }
  return tokens;
}

/** Jaccard 相似度（两集合交集 / 并集；任一为空 → 0） */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 两条记忆内容是否应视为重复。
 *
 * 两道闸：相似度 ≥ 阈值 **且** 长度比 ≥ 0.5。后者防"长句包含短句"被误判——
 * `我喜欢 TypeScript` 与 `我喜欢 TypeScript 但不喜欢 Python 的缩进` 的 Jaccard
 * 可能偏高，但它们的信息量不同，不该合并。
 */
export function isLikelyDuplicateContent(left: string, right: string): boolean {
  const leftNorm = normalizeMemoryContent(left);
  const rightNorm = normalizeMemoryContent(right);
  if (leftNorm.length === 0 || rightNorm.length === 0) return false;
  if (leftNorm === rightNorm) return true; // 完全相同的规范化结果
  const shorter = Math.min(leftNorm.length, rightNorm.length);
  const longer = Math.max(leftNorm.length, rightNorm.length);
  if (shorter / longer < DUPLICATE_LENGTH_RATIO) return false;
  return jaccardSimilarity(memoryTokens(left), memoryTokens(right)) >= DUPLICATE_SIMILARITY_THRESHOLD;
}

/** 在一组已有内容里找与新内容重复的那一条（无 → null） */
export function findDuplicateContent(
  candidate: string,
  existing: readonly string[],
): string | null {
  for (const item of existing) {
    if (isLikelyDuplicateContent(candidate, item)) return item;
  }
  return null;
}
