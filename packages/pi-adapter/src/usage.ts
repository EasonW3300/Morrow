/**
 * 运行用量的提取与估算（票 M7-C-T1 / Issue #75）。
 *
 * 两个来源，一个出口：
 *   1. **供应商返回的 usage**（Pi 在 assistant 消息上带 `usage`，字段是
 *      `{input, output, cacheRead, cacheWrite, totalTokens, cost}`）→ 直接采信。
 *   2. **供应商没给**（流式未开 `include_usage`、某些网关不返回、错误轮）→ 按
 *      `chars/4` 估算，并置 `estimated: true`。
 *
 * `chars/4` 是业界常用的粗估（英文约 4 字符/token）。它对中文偏低（中文约 1-2 字符
 * 一个 token），所以估算值**系统性偏小**——这在本文件里如实写清，而不是假装准确。
 * 预算判定因此应把估算值当作**下界**。
 *
 * 关键纪律：**估算绝不被伪装成真实值**。`estimated` 标记会一路传到 Goal 的
 * budget 判定与 UI 展示（PRD 决策 #34）。
 */

import type { MorrowRunUsage } from "./types.ts";

/** 估算口径：每 4 个字符算 1 token（英文近似；中文会低估） */
export const CHARS_PER_TOKEN = 4;

/** 从任意对象里安全读数字（Pi 的 usage 字段可能是 undefined / 畸形） */
function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** 从 Pi 的 assistant 消息里读 usage（形态畸形 → null，交给估算路径） */
export function readPiUsage(assistantMessage: unknown): MorrowRunUsage | null {
  if (typeof assistantMessage !== "object" || assistantMessage === null) return null;
  const usage = (assistantMessage as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const input = readCount(record.input);
  const output = readCount(record.output);
  const cacheRead = readCount(record.cacheRead);
  const cacheWrite = readCount(record.cacheWrite);
  // 供应商给了 totalTokens 就用它的（口径可能与四项之和不完全一致）；
  // 没给就自己加——两者都为 0 说明这条 usage 没有意义，视为缺失。
  const declaredTotal = readCount(record.totalTokens);
  const computedTotal = input + output + cacheRead + cacheWrite;
  const total = declaredTotal > 0 ? declaredTotal : computedTotal;
  if (total === 0 && input === 0 && output === 0) return null;
  return { input, output, cacheRead, cacheWrite, total, estimated: false };
}

/**
 * 按字符数估算用量。
 *
 * `promptChars` 是发给模型的文本长度（system + 历史 + 本轮输入），`outputChars`
 * 是模型产出的文本长度。两者都按 `chars/4` 折算。
 */
export function estimateUsage(promptChars: number, outputChars: number): MorrowRunUsage {
  const safe = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const input = Math.ceil(safe(promptChars) / CHARS_PER_TOKEN);
  const output = Math.ceil(safe(outputChars) / CHARS_PER_TOKEN);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    total: input + output,
    estimated: true,
  };
}

/** 累加两次用量（Goal 预算的累加点）。任一为估算 → 结果标记估算。 */
export function addUsage(left: MorrowRunUsage, right: MorrowRunUsage): MorrowRunUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
    // 只要有一段是估算，累计值就不能声称精确
    estimated: left.estimated || right.estimated,
  };
}

/** 空用量（会话/目标初始化时的零值） */
export const EMPTY_USAGE: MorrowRunUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  estimated: false,
};

/**
 * 选出这一轮该报的用量：优先供应商值，缺失则估算。
 *
 * `promptChars`/`outputChars` 只在估算路径用到，但始终传入——让调用方不必判断。
 */
export function resolveRunUsage(input: {
  assistantMessage: unknown;
  promptChars: number;
  outputChars: number;
}): MorrowRunUsage {
  const fromProvider = readPiUsage(input.assistantMessage);
  if (fromProvider !== null) return fromProvider;
  return estimateUsage(input.promptChars, input.outputChars);
}
