// 文档抓取与 SSRF 防护（票 M7-B-T4 / Issue #72，FR-B11）。
//
// 每个限制都要有**正面证据**（被拒）与**说明**：这是全项目唯一由外部内容驱动的
// 出网入口，防护漏一条就是一条真实的可利用路径。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_CONTENT_TYPES,
  DOC_MAX_BYTES,
  DOC_TIMEOUT_MS,
  MIN_DOC_CHARS,
  assessDocument,
  fetchDocument,
  hostLiteralBlocked,
  isForbiddenAddress,
} from "../src/skills-package/doc-fetch.ts";

// --- 地址判定 -----------------------------------------------------------------------

test("回环地址被拒（127/8 全域，不只 127.0.0.1）", () => {
  for (const address of ["127.0.0.1", "127.1.2.3", "127.255.255.254"]) {
    assert.equal(isForbiddenAddress(address).forbidden, true, address);
  }
});

test("IPv6 回环与未指定地址被拒", () => {
  for (const address of ["::1", "::"]) {
    assert.equal(isForbiddenAddress(address).forbidden, true, address);
  }
});

test("私网三段被拒（10/8、172.16/12、192.168/16）", () => {
  const privateAddresses = [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "192.168.255.255",
  ];
  for (const address of privateAddresses) {
    assert.equal(isForbiddenAddress(address).forbidden, true, address);
  }
  // 172 段边界：172.15 与 172.32 是公网
  assert.equal(isForbiddenAddress("172.15.0.1").forbidden, false);
  assert.equal(isForbiddenAddress("172.32.0.1").forbidden, false);
});

test("链路本地与云元数据被拒（元数据单独归类）", () => {
  assert.deepEqual(isForbiddenAddress("169.254.1.1"), { forbidden: true, reason: "private" });
  assert.deepEqual(isForbiddenAddress("169.254.169.254"), { forbidden: true, reason: "metadata" });
});

test("CGNAT / 组播 / 保留段被拒", () => {
  for (const address of ["100.64.0.1", "100.127.255.254", "224.0.0.1", "239.255.255.255", "0.0.0.0", "198.18.0.1"]) {
    assert.equal(isForbiddenAddress(address).forbidden, true, address);
  }
});

test("IPv6 ULA 与链路本地被拒", () => {
  for (const address of ["fc00::1", "fd12:3456::1", "fe80::1"]) {
    assert.equal(isForbiddenAddress(address).forbidden, true, address);
  }
});

test("IPv4-mapped IPv6 绕过路径被堵住", () => {
  // ::ffff:127.0.0.1 若只看字符串前缀会被漏掉
  assert.equal(isForbiddenAddress("::ffff:127.0.0.1").forbidden, true);
  assert.equal(isForbiddenAddress("::ffff:10.0.0.1").forbidden, true);
});

test("公网地址放行", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isForbiddenAddress(address).forbidden, false, address);
  }
});

test("非法地址保守拒绝（不是放行）", () => {
  assert.equal(isForbiddenAddress("not-an-ip").forbidden, true);
  assert.equal(isForbiddenAddress("").forbidden, true);
});

test("hostLiteralBlocked：字面 IP 主机名直接判，不走 DNS", () => {
  assert.equal(hostLiteralBlocked("127.0.0.1"), "private_address");
  assert.equal(hostLiteralBlocked("169.254.169.254"), "metadata_address");
  assert.equal(hostLiteralBlocked("1.1.1.1"), null);
  assert.equal(hostLiteralBlocked("example.com"), null);
  // 方括号形态的 IPv6
  assert.equal(hostLiteralBlocked("[::1]"), "private_address");
});

// --- 协议与 URL 校验 ----------------------------------------------------------------

/** 造一个永远不会被调用的 fetch（断言"根本没发请求"） */
function neverFetch(): typeof fetch {
  return (async () => {
    throw new Error("fetch should not have been called");
  }) as unknown as typeof fetch;
}

test("仅 https：http/file/ftp 一律拒，且不发请求", async () => {
  for (const url of ["http://example.com/doc.md", "file:///etc/passwd", "ftp://example.com/x"]) {
    const result = await fetchDocument(url, {
      resolve: async () => ["1.1.1.1"],
      fetchImpl: neverFetch(),
      allowPublicNetwork: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "not_https", url);
  }
});

test("非法 URL 报 invalid_url", async () => {
  const result = await fetchDocument("not a url", { fetchImpl: neverFetch() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid_url");
});

test("字面私网 IP 不发请求就拒", async () => {
  const result = await fetchDocument("https://127.0.0.1/x", {
    resolve: async () => ["127.0.0.1"],
    fetchImpl: neverFetch(),
    allowPublicNetwork: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "private_address");
    assert.match(result.message, /private\/loopback/);
  }
});

test("DNS 解析到私网 → 拒绝（rebinding 第一步）", async () => {
  const result = await fetchDocument("https://evil.example.com/doc", {
    resolve: async () => ["192.168.1.5"],
    fetchImpl: neverFetch(),
    allowPublicNetwork: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "private_address");
    assert.match(result.message, /DNS rebinding/);
  }
});

test("DNS 解析到云元数据地址 → metadata_address（单独归类）", async () => {
  const result = await fetchDocument("https://metadata.example.com/", {
    resolve: async () => ["169.254.169.254"],
    fetchImpl: neverFetch(),
    allowPublicNetwork: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "metadata_address");
});

test("DNS 解析失败 → dns_failed（不崩）", async () => {
  const result = await fetchDocument("https://nx.example.com/", {
    resolve: async () => {
      throw new Error("ENOTFOUND");
    },
    fetchImpl: neverFetch(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "dns_failed");
    assert.match(result.message, /ENOTFOUND/);
  }
});

test("DNS 返回空列表 → dns_failed", async () => {
  const result = await fetchDocument("https://empty.example.com/", {
    resolve: async () => [],
    fetchImpl: neverFetch(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "dns_failed");
});

// --- 公网开关 -----------------------------------------------------------------------

test("公网地址默认拒绝，并提示如何开启", async () => {
  const result = await fetchDocument("https://example.com/doc.md", {
    resolve: async () => ["93.184.216.34"],
    fetchImpl: neverFetch(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "public_not_allowed");
    assert.match(result.message, /allow public document fetching/);
  }
});

test("显式开启后公网放行（真正发起请求）", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("# 文档内容\n\n这是一份足够长的说明文档，用于生成安装提案。", {
      status: 200,
      headers: { "content-type": "text/markdown" },
    });
  }) as unknown as typeof fetch;
  const result = await fetchDocument("https://example.com/doc.md", {
    resolve: async () => ["93.184.216.34"],
    fetchImpl,
    allowPublicNetwork: true,
  });
  assert.equal(called, true);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.bytes > 0, true);
    assert.match(result.text, /文档内容/);
  }
});

// --- 大小与超时 ---------------------------------------------------------------------

test("超过大小上限 → too_large，且不把全部内容读进内存", async () => {
  const big = new Uint8Array(DOC_MAX_BYTES + 1024);
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(big);
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/plain" } },
    )) as unknown as typeof fetch;
  const result = await fetchDocument("https://example.com/big.txt", {
    resolve: async () => ["1.1.1.1"],
    fetchImpl,
    allowPublicNetwork: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "too_large");
    assert.match(result.message, /5|limit/);
  }
});

test("超时 → timeout（AbortController 生效）", async () => {
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as unknown as typeof fetch;
  const result = await fetchDocument("https://slow.example.com/", {
    resolve: async () => ["1.1.1.1"],
    fetchImpl,
    allowPublicNetwork: true,
    timeoutMs: 50,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "timeout");
});

test("HTTP 错误状态 → http_error 并带回状态码", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
  const result = await fetchDocument("https://example.com/missing", {
    resolve: async () => ["1.1.1.1"],
    fetchImpl,
    allowPublicNetwork: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "http_error");
    assert.equal(result.status, 404);
  }
});

test("不支持的 content-type → unsupported_content_type（不做二进制解析）", async () => {
  const fetchImpl = (async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png" },
    })) as unknown as typeof fetch;
  const result = await fetchDocument("https://example.com/x.png", {
    resolve: async () => ["1.1.1.1"],
    fetchImpl,
    allowPublicNetwork: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unsupported_content_type");
});

test("抓取后的 DNS 复检发现 rebinding → dns_rebinding", async () => {
  let calls = 0;
  const resolve = async (): Promise<string[]> => {
    calls += 1;
    // 第一次公网（通过连接前校验），第二次私网（复检抓到）
    return calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
  };
  const fetchImpl = (async () =>
    new Response("# title\n\ncontent long enough to pass the minimum length check", {
      status: 200,
      headers: { "content-type": "text/markdown" },
    })) as unknown as typeof fetch;
  const result = await fetchDocument("https://rebind.example.com/", {
    resolve,
    fetchImpl,
    allowPublicNetwork: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "dns_rebinding");
    assert.match(result.message, /changed to 127\.0\.0\.1/);
  }
});

test("允许的 MIME 列表覆盖 md/txt/html/json", () => {
  for (const type of ["text/plain", "text/markdown", "text/html", "application/json"]) {
    assert.ok(ALLOWED_CONTENT_TYPES.includes(type), type);
  }
});

test("默认上限与超时与规格一致（5MB / 10s）", () => {
  assert.equal(DOC_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(DOC_TIMEOUT_MS, 10_000);
});

// --- 文档可用性 ---------------------------------------------------------------------

test("空文档与过短文档被判定为不可用（不产生半成品提案）", () => {
  assert.equal(assessDocument("").usable, false);
  assert.equal(assessDocument("   \n\t ").usable, false);
  const short = assessDocument("装这个");
  assert.equal(short.usable, false);
  if (!short.usable) assert.match(short.reason, /过短/);
});

test("足够长的文档可用", () => {
  assert.equal(assessDocument("x".repeat(MIN_DOC_CHARS)).usable, true);
});
