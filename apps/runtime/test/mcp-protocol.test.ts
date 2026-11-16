// MCP 协议层测试（票 M7-B-T1 / Issue #67）。
// 重点：双代际探测的三条分支（尤其"版本不支持时不得回退 initialize"）、
// 能力协商的如实回报、版本协商。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRequest,
  classifyCapabilities,
  isUnsupportedVersionError,
  negotiateVersion,
  supportedVersionsFromError,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcErrorObject,
} from "../src/mcp/protocol.ts";

/** 构造"版本不支持"错误（规范形态：code -32000 + data.error 标记） */
function unsupportedVersionError(supported: string[]): JsonRpcErrorObject {
  return {
    code: -32000,
    message: "Unsupported protocol version",
    data: { error: "UnsupportedProtocolVersionError", supported },
  };
}

// --- 版本协商 -----------------------------------------------------------------------

test("negotiateVersion：取双方交集里我们最新的那个", () => {
  assert.equal(negotiateVersion(["2026-07-28", "2025-11-25"]), "2026-07-28");
  assert.equal(negotiateVersion(["2025-11-25"]), "2025-11-25");
  assert.equal(negotiateVersion(["2024-01-01"]), null, "无交集返回 null");
  assert.equal(negotiateVersion([]), null);
});

test("SUPPORTED_PROTOCOL_VERSIONS 按新到旧排列（协商依赖这个顺序）", () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ["2026-07-28", "2025-11-25"]);
});

// --- 错误判别（三条分支的分水岭）----------------------------------------------------

test("isUnsupportedVersionError：识别 data.error 标记与 supported 列表", () => {
  assert.equal(isUnsupportedVersionError(unsupportedVersionError(["2025-11-25"])), true);
  assert.equal(
    isUnsupportedVersionError({ code: -32000, message: "x", data: { supported: ["a"] } }),
    true,
    "带 supported 列表也算",
  );
  assert.equal(
    isUnsupportedVersionError({ code: -32000, message: "UnsupportedProtocolVersionError" }),
    true,
    "消息特征兜底",
  );
});

test("isUnsupportedVersionError：其他 -32000 错误不算（否则会误判成版本问题）", () => {
  assert.equal(
    isUnsupportedVersionError({ code: -32000, message: "Server is busy", data: { retry: 3 } }),
    false,
  );
  assert.equal(isUnsupportedVersionError({ code: -32601, message: "Method not found" }), false);
  assert.equal(isUnsupportedVersionError(null), false);
  assert.equal(isUnsupportedVersionError(undefined), false);
});

test("isUnsupportedVersionError：method not found 必须返回 false（那才是回退 initialize 的信号）", () => {
  // 老 server 收到 server/discover 的典型反应就是 -32601
  const legacySignal: JsonRpcErrorObject = { code: -32601, message: "Method not found" };
  assert.equal(isUnsupportedVersionError(legacySignal), false);
});

test("supportedVersionsFromError：取出 server 声明的版本列表，非法项被过滤", () => {
  assert.deepEqual(supportedVersionsFromError(unsupportedVersionError(["a", "b"])), ["a", "b"]);
  assert.deepEqual(
    supportedVersionsFromError({ code: -32000, message: "x", data: { supported: ["a", 1, null] } }),
    ["a"],
  );
  assert.deepEqual(supportedVersionsFromError({ code: -32000, message: "x" }), []);
});

// --- 能力协商 -----------------------------------------------------------------------

test("classifyCapabilities：只接 tools；resources/prompts 记为不支持", () => {
  const result = classifyCapabilities({ tools: {}, resources: {}, prompts: {} });
  assert.equal(result.tools, true);
  assert.deepEqual(result.unsupported.sort(), ["prompts", "resources"], "如实回报不支持");
});

test("classifyCapabilities：未知能力也记为不支持（未来能力不静默吞掉）", () => {
  const result = classifyCapabilities({ tools: {}, sampling: {}, experimentalX: {} });
  assert.equal(result.tools, true);
  assert.deepEqual(result.unsupported.sort(), ["experimentalX", "sampling"]);
});

test("classifyCapabilities：空/非法输入不崩，全部记为不支持且 tools=false", () => {
  for (const raw of [undefined, null, 42, "str", []]) {
    const result = classifyCapabilities(raw);
    assert.equal(result.tools, false);
    assert.equal(result.resources, false);
    assert.deepEqual(result.unsupported, []);
  }
});

test("classifyCapabilities：值为 null 视为未声明该能力（不算支持）", () => {
  const result = classifyCapabilities({ tools: null, resources: null });
  assert.equal(result.tools, false);
  assert.equal(result.resources, false);
});

// --- 请求构造 -----------------------------------------------------------------------

test("buildRequest：无 params 时不带该字段（部分 server 对多余字段敏感）", () => {
  assert.deepEqual(buildRequest(1, "tools/list"), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(buildRequest(2, "tools/call", { name: "x" }), {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "x" },
  });
});
