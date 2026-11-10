/**
 * 跨设备/渠道通知的内容裁剪（M4-T7 / Issue #44，FR-NOT-2，AC-13）。
 *
 * 渠道目标是可信联系人或跨设备接收者，**不等同于 Owner**：正文只保留任务级摘要，
 * 以下内容一律替换为 [已裁剪]（通知本身照发，不是整条丢弃）：
 * - private/locked 记忆事实的原文（由 MemoryService 注入）；
 * - 本机文件路径（/Users、/home、~/…、Windows 盘符）；
 * - 凭据形态（sk-/ghp_/Bearer/api_key=/password= 等、PEM 私钥块）。
 *
 * 桌面目标不走本函数：本机 UI 属于 Owner，保留完整正文。
 */

export const REDACTED = "[已裁剪]";

const PATH_PATTERNS: RegExp[] = [
  /(?:~\/|\/(?:Users|home|var|tmp|opt|etc|private|root|mnt|Volumes)\/)[^\s"'`)\]}>,;]*/g,
  /[A-Za-z]:\\[^\s"'`)\]}>,;]*/g,
];

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|ghp|gho|ghu|ghs|xoxb|xoxp|AKIA)[-_A-Za-z0-9]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)\s*[:=]\s*["']?[^\s"',;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** 渠道正文裁剪；privateContents 只做字面替换（不含内容的语义推断）。 */
export function sanitizeForExternalRecipient(text: string, privateContents: readonly string[]): string {
  let out = text;
  for (const content of privateContents) {
    const needle = content.trim();
    // 过短的内容（如「密码」两个字）全局替换会造成过度裁剪，低于 4 字符不处理。
    if (needle.length < 4) continue;
    out = out.split(needle).join(REDACTED);
  }
  for (const pattern of PATH_PATTERNS) out = out.replace(pattern, REDACTED);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
