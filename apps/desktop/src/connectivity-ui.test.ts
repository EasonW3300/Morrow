/**
 * 连通性结果的 UI 归类呈现（票 T7 / Issue #8 验收核心）。
 *
 * 输入是 runtime `POST /v1/providers/:id/test` 的四类结果（apps/runtime/src/connectivity.ts），
 * 输出 Owner 可读的归类：tone（绿/橙/红）、标题、解释、下一步建议。
 * 纯函数，无 DOM / fetch 依赖 —— node:test 直接跑（--experimental-strip-types）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { describeConnectivity, type ConnectivityResult } from "./connectivity-ui.ts";

test("ok：绿调，标题含 HTTP 状态与延迟，建议可直接投入使用", () => {
  const out = describeConnectivity({ result: "ok", http_status: 200, latency_ms: 87 });
  assert.equal(out.tone, "ok");
  assert.match(out.title, /200/);
  assert.match(out.title, /87/);
  assert.ok(out.advice.length > 0, "应有下一步建议");
});

test("auth_failed：红调，指明密钥被拒并给出换密钥的下一步", () => {
  const out = describeConnectivity({ result: "auth_failed", http_status: 401, latency_ms: 120 });
  assert.equal(out.tone, "error");
  assert.match(out.title, /401/);
  assert.match(out.explanation, /密钥|认证/);
  assert.match(out.advice, /密钥/);
});

test("unreachable：橙调，透出 detail 错误码，建议核对地址与服务状态", () => {
  const out = describeConnectivity({ result: "unreachable", kind: "connect_error", detail: "connect ECONNREFUSED 127.0.0.1:9", latency_ms: 5 });
  assert.equal(out.tone, "warn");
  assert.match(out.explanation, /ECONNREFUSED/);
  assert.match(out.advice, /地址|服务/);
});

test("unreachable kind=timeout：提示超时而非笼统网络错误（结构化字段，非 detail 嗅探）", () => {
  const out = describeConnectivity({ result: "unreachable", kind: "timeout", detail: "timed out after 10000ms", latency_ms: 10001 });
  assert.equal(out.tone, "warn");
  assert.match(out.explanation, /超时/);
});

test("unreachable kind=connect_error 但 detail 恰好含 timeout 字样：按连接失败呈现（detail 不是合约）", () => {
  const out = describeConnectivity({ result: "unreachable", kind: "connect_error", detail: "upstream timeout flag reset", latency_ms: 7 });
  assert.equal(out.tone, "warn");
  assert.match(out.explanation, /连接未能建立/);
});

test("error：红调，含 HTTP 状态，建议核对端点形态与模型名", () => {
  const out = describeConnectivity({ result: "error", http_status: 404, latency_ms: 30 });
  assert.equal(out.tone, "error");
  assert.match(out.title, /404/);
  assert.match(out.advice, /chat\/completions|模型/);
});

test("呈现文案绝不含密钥字段（结果载荷契约里没有，函数也不引入）", () => {
  for (const result of [
    { result: "ok", http_status: 200, latency_ms: 1 },
    { result: "auth_failed", http_status: 403, latency_ms: 1 },
    { result: "unreachable", kind: "connect_error", detail: "ECONNREFUSED", latency_ms: 1 },
    { result: "error", http_status: 500, latency_ms: 1 },
  ] as ConnectivityResult[]) {
    const out = describeConnectivity(result);
    const text = `${out.title}${out.explanation}${out.advice}`;
    assert.ok(!/(api_key|apikey|bearer\s)/i.test(text), "文案不应出现密钥相关字段");
  }
});
