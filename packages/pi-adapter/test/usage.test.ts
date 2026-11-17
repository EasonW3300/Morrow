// 用量提取与估算（票 M7-C-T1 / Issue #75）。
//
// 这一层的重点是「不撒谎」：
//   - 供应商给了 usage → 采信真实值，estimated=false；
//   - 供应商没给 → chars/4 估算，estimated=true（绝不伪装成真实值）；
//   - 累加时只要有一段是估算，累计值就不能声称精确。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHARS_PER_TOKEN,
  EMPTY_USAGE,
  addUsage,
  estimateUsage,
  readPiUsage,
  resolveRunUsage,
} from "../src/usage.ts";

// --- 从供应商 usage 提取 ------------------------------------------------------------

test("完整 usage：四个计数与 totalTokens 都正确采信", () => {
  const usage = readPiUsage({
    role: "assistant",
    usage: { input: 120, output: 45, cacheRead: 800, cacheWrite: 0, totalTokens: 965 },
  });
  assert.deepEqual(usage, {
    input: 120,
    output: 45,
    cacheRead: 800,
    cacheWrite: 0,
    total: 965,
    estimated: false,
  });
});

test("供应商没给 totalTokens → 四项相加（不报 0）", () => {
  const usage = readPiUsage({ usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 } });
  assert.equal(usage?.total, 20);
  assert.equal(usage?.estimated, false);
});

test("usage 缺失/malformed → null（交给估算路径，不假装 0）", () => {
  for (const message of [
    undefined,
    null,
    {},
    { role: "assistant" },
    { usage: null },
    { usage: "not-an-object" },
    { usage: {} },
    { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ]) {
    assert.equal(readPiUsage(message), null, JSON.stringify(message));
  }
});

test("负数与 NaN 计数按 0 处理（不污染累计值）", () => {
  const usage = readPiUsage({ usage: { input: -5, output: Number.NaN, cacheRead: 10 } });
  assert.deepEqual(usage, { input: 0, output: 0, cacheRead: 10, cacheWrite: 0, total: 10, estimated: false });
});

test("小数计数向下取整（token 是整数）", () => {
  const usage = readPiUsage({ usage: { input: 10.9, output: 3.2 } });
  assert.equal(usage?.input, 10);
  assert.equal(usage?.output, 3);
});

// --- 估算 ---------------------------------------------------------------------------

test("估算：按 chars/4，且标记 estimated", () => {
  const usage = estimateUsage(400, 80);
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 20);
  assert.equal(usage.total, 120);
  assert.equal(usage.estimated, true);
});

test("估算：非 4 的倍数向上取整（宁可略高，不报 0）", () => {
  assert.equal(estimateUsage(1, 0).input, 1);
  assert.equal(estimateUsage(5, 0).input, 2);
});

test("估算：空输入给 0（不是负或 NaN）", () => {
  const usage = estimateUsage(0, 0);
  assert.deepEqual(usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, estimated: true });
});

test("估算：畸形入参（负数/NaN/Infinity）不给脏数字", () => {
  for (const bad of [-100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const usage = estimateUsage(bad, bad);
    assert.equal(usage.input, 0);
    assert.equal(usage.output, 0);
  }
});

test("CHARS_PER_TOKEN 常量是 4（口径可见、可断言）", () => {
  assert.equal(CHARS_PER_TOKEN, 4);
});

// --- 选择路径 -----------------------------------------------------------------------

test("resolveRunUsage：有供应商 usage 就用它，忽略字符数", () => {
  const usage = resolveRunUsage({
    assistantMessage: { usage: { input: 999, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 } },
    promptChars: 4,
    outputChars: 4,
  });
  assert.equal(usage.input, 999);
  assert.equal(usage.estimated, false);
});

test("resolveRunUsage：没有 usage 就估算，并标 estimated", () => {
  const usage = resolveRunUsage({ assistantMessage: { role: "assistant" }, promptChars: 400, outputChars: 40 });
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 10);
  assert.equal(usage.estimated, true);
});

// --- 累加 ---------------------------------------------------------------------------

test("累加：两段真实值相加，estimated 仍为 false", () => {
  const a = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, estimated: false };
  const b = { input: 20, output: 8, cacheRead: 2, cacheWrite: 0, total: 30, estimated: false };
  assert.deepEqual(addUsage(a, b), {
    input: 30,
    output: 13,
    cacheRead: 2,
    cacheWrite: 0,
    total: 45,
    estimated: false,
  });
});

test("累加：只要有一段估算，累计就标 estimated（不能声称精确）", () => {
  const real = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, estimated: false };
  const est = estimateUsage(400, 0);
  const sum = addUsage(real, est);
  assert.equal(sum.estimated, true, "混合来源的累计值不得声称精确");
  assert.equal(sum.total, 15 + 100);
});

test("累加：零值不改变结果", () => {
  const real = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, estimated: false };
  assert.deepEqual(addUsage(real, EMPTY_USAGE), real);
  assert.deepEqual(addUsage(EMPTY_USAGE, real), real);
});
