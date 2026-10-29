// CORS 语义（票 T6 / Issue #7）：桌面 WebView 与浏览器联调是跨源客户端；
// 只对本地来源放行（tauri://localhost、http(s)://(localhost|127.0.0.1|tauri.localhost)），
// 互联网页面的跨源脚本读写会被浏览器拦截。但 CORS 不是 CSRF 完整防线——simple POST
// （text/plain，safelist 内）不经 preflight 仍会到达，故写端点另行强制 application/json
// （safelist 外 → 浏览器强制 preflight；服务器端 415 拒收）。残余风险见 threat-model 域 4。
// preflight 放行 content-type 与 last-event-id（EventSource 断线重连自动携带，非 safelist 头）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime } from "../src/runtime.ts";
import { removeDir, tmpDir } from "./helpers.ts";

function testConfig(dir: string): RuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    replicaId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    provider: null,
  };
}

test("preflight from a local origin returns 204 with echoed origin and method allowlist", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:1420", "access-control-request-method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:1420");
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /last-event-id/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /content-type/);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("preflight 放行 PUT/DELETE（票 T8 前的设置 UI，Issue #8：Provider 编辑与删除）", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    for (const method of ["PUT", "DELETE"]) {
      const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/p1`, {
        method: "OPTIONS",
        headers: { origin: "tauri://localhost", "access-control-request-method": method },
      });
      assert.equal(res.status, 204, `${method} preflight 应 204`);
      assert.match(
        res.headers.get("access-control-allow-methods") ?? "",
        new RegExp(method),
        `${method} 应在 allow-methods 白名单（跨源 WebView 否则拦截编辑/删除）`,
      );
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("PUT/DELETE 实请求带本地来源拿到 CORS 授权（不只是 preflight 空头支票）", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const put = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/p1`, {
      method: "PUT",
      headers: { origin: "http://localhost:1420", "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(put.headers.get("access-control-allow-origin"), "http://localhost:1420");
    const del = await fetch(`http://127.0.0.1:${runtime.port}/v1/providers/p1`, {
      method: "DELETE",
      headers: { origin: "http://localhost:1420" },
    });
    assert.equal(del.headers.get("access-control-allow-origin"), "http://localhost:1420");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("tauri://localhost shell origin is allowed on real requests", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`, {
      headers: { origin: "tauri://localhost" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "tauri://localhost");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("non-local origins get no CORS grant (browser would block the read)", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("no origin header (same-origin / non-browser client) works untouched", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

// --- CSRF 防线（M0 code-review / Issue #11）：写端点强制 application/json -------------------
// 不带自定义头的 simple POST（text/plain 在 CORS safelist 内）不经 preflight，请求本身
// 会到达服务器——防线在服务器端：readJsonBody 对非 application/json 一律 415，伪造写请求
// 无效。合法 JSON body 但 content-type 撒谎（text/plain）同样拒收。

test("simple POST with text/plain (CSRF vector) is rejected 415 even with a valid JSON body", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    // 恶意页面会构造的形态：无预检的 text/plain simple POST，body 是合法 JSON
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ title: "csrf" }),
    });
    assert.equal(res.status, 415);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "unsupported_media_type");
    // 无副作用：会话没有被创建
    const list = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`);
    assert.deepEqual(((await list.json()) as { sessions: unknown[] }).sessions, []);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("missing content-type header on a body-bearing POST is rejected 415", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`, {
      method: "POST",
      headers: { origin: "http://localhost:1420" }, // 无 content-type
      body: JSON.stringify({ title: "x" }),
    });
    assert.equal(res.status, 415);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("application/json with parameters (charset) is accepted on write endpoints", async () => {
  const dir = tmpDir("morrow-cors-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title: "ok" }),
    });
    assert.equal(res.status, 201);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
