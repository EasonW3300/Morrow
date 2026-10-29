/**
 * 探针公共库的关键函数（seam：standalone/sidecar 探针脚本共用）。
 *
 * - parseJsonObjectLine / asReadyEvent：sidecar 启动协议的 stdout 单行 JSON 握手；
 * - createJsonLineSource：子进程 stdout 的 JSON 行流（分块边界、噪声容错、超时）；
 * - fetchJson：探针请求（/v1/health）；
 * - ensureExecutable：CI 产物执行位自愈（download-artifact 不保留 mode，#10 gate 腿 EACCES）；
 * - describeChildDiagnostics：探针失败附子进程退出码/stderr/stdout 噪声（CI 可维护性）。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { after, describe, it } from "node:test";
import {
  asReadyEvent,
  createJsonLineSource,
  describeChildDiagnostics,
  ensureExecutable,
  fetchJson,
  parseJsonObjectLine,
} from "../src/probe-lib.ts";
import type { ReadyEvent } from "../src/probe-lib.ts";

describe("parseJsonObjectLine", () => {
  it("JSON 对象行解析为对象", () => {
    assert.deepEqual(parseJsonObjectLine('{"ready":true,"port":3000}'), { ready: true, port: 3000 });
  });

  it("前后空白容忍", () => {
    assert.deepEqual(parseJsonObjectLine('  {"a":1}  \n'), { a: 1 });
  });

  it("非 JSON 行返回 undefined（噪声容错，不抛错）", () => {
    assert.equal(parseJsonObjectLine("bun v1.4.4 starting..."), undefined);
    assert.equal(parseJsonObjectLine("[morrow] fatal: boom"), undefined);
  });

  it("空行与纯空白返回 undefined", () => {
    assert.equal(parseJsonObjectLine(""), undefined);
    assert.equal(parseJsonObjectLine("   \n"), undefined);
  });

  it("JSON 数组/标量不是对象，返回 undefined", () => {
    assert.equal(parseJsonObjectLine("[1,2]"), undefined);
    assert.equal(parseJsonObjectLine('"hello"'), undefined);
    assert.equal(parseJsonObjectLine("42"), undefined);
    assert.equal(parseJsonObjectLine("null"), undefined);
  });
});

describe("asReadyEvent", () => {
  const READY_RAW = {
    ready: true,
    version: "0.1.0",
    host: "127.0.0.1",
    port: 51234,
    pid: 4242,
    data_dir: "/tmp/x",
    replica_id: "018f6d2a-7c1f-7c22-9b3e-3f5c8a1d2e4f",
  };

  it("ready 事件收窄出端口等字段", () => {
    const ready: ReadyEvent | undefined = asReadyEvent(READY_RAW);
    assert.ok(ready);
    assert.equal(ready.port, 51234);
    assert.equal(ready.version, "0.1.0");
    assert.equal(ready.replica_id, READY_RAW.replica_id);
  });

  it("缺 ready:true 或端口非法时返回 undefined", () => {
    assert.equal(asReadyEvent({ ...READY_RAW, ready: false }), undefined);
    assert.equal(asReadyEvent({ ...READY_RAW, port: "not-a-number" }), undefined);
    assert.equal(asReadyEvent({ hello: 1 }), undefined);
    assert.equal(asReadyEvent(undefined), undefined);
    assert.equal(asReadyEvent("nope"), undefined);
  });
});

describe("createJsonLineSource", () => {
  it("跨 chunk 边界的行能拼全后交付", async () => {
    const src = createJsonLineSource();
    src.push('{"ready":tr');
    const pending = src.next(1000);
    src.push('ue,"port":1}\n');
    assert.deepEqual(await pending, { ready: true, port: 1 });
  });

  it("一次 push 多行按序交付", async () => {
    const src = createJsonLineSource();
    src.push('{"a":1}\n{"b":2}\n');
    assert.deepEqual(await src.next(1000), { a: 1 });
    assert.deepEqual(await src.next(1000), { b: 2 });
  });

  it("跳过非 JSON 噪声行，噪声保留在 noise 供诊断", async () => {
    const src = createJsonLineSource();
    src.push("warning: something\n");
    src.push('{"ok":true}\n');
    assert.deepEqual(await src.next(1000), { ok: true });
    assert.deepEqual(src.noise, ["warning: something"]);
  });

  it("空行不计入噪声", async () => {
    const src = createJsonLineSource();
    src.push("\n\n{\"a\":1}\n");
    assert.deepEqual(await src.next(1000), { a: 1 });
    assert.deepEqual(src.noise, []);
  });

  it("超时 reject 且不再阻塞后续 next", async () => {
    const src = createJsonLineSource();
    await assert.rejects(src.next(30), /timeout/);
    src.push('{"late":true}\n');
    assert.deepEqual(await src.next(1000), { late: true });
  });

  it("end() 交付无换行的最后一行（完整 JSON），再 next() 以 EOF reject；真残缺半行归噪声", async () => {
    const src = createJsonLineSource();
    src.push('{"tail": true}');
    src.end();
    assert.deepEqual(await src.next(1000), { tail: true });
    await assert.rejects(src.next(1000), /EOF/);

    const src2 = createJsonLineSource();
    src2.push('{"truncat');
    src2.end();
    await assert.rejects(src2.next(1000), /EOF/);
    assert.equal(src2.noise.length, 1);
  });

  it("无残留时 end() 直接 EOF", async () => {
    const src = createJsonLineSource();
    src.end();
    await assert.rejects(src.next(1000), /EOF/);
  });
});

describe("fetchJson", () => {
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of cleanups.reverse()) await fn();
  });

  async function startServer(status: number, body: string): Promise<string> {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr !== null && typeof addr === "object");
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return `http://127.0.0.1:${addr.port}`;
  }

  it("200 返回状态码与解析后的 JSON body", async () => {
    const url = await startServer(200, '{"status":"ok","ledger":{"events":1}}');
    const res = await fetchJson(`${url}/v1/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok", ledger: { events: 1 } });
  });

  it("非 200 照常返回（由调用方断言状态码）", async () => {
    const url = await startServer(500, '{"error":{"code":"internal_error","message":"x"}}');
    const res = await fetchJson(`${url}/v1/health`);
    assert.equal(res.status, 500);
    assert.deepEqual((res.body as { error: { code: string } }).error.code, "internal_error");
  });

  it("连接拒绝按错误抛出（含 url 信息）", async () => {
    // 端口 1（tcpmux）常规无监听，连接立即被拒
    await assert.rejects(fetchJson("http://127.0.0.1:1/v1/health", 2000), /health check failed|fetch failed/i);
  });
});

describe("ensureExecutable", () => {
  it("非可执行文件自愈为 0755（run 40872208364 EACCES：download-artifact 不保留 mode 位）", () => {
    if (process.platform === "win32") return; // Windows 无可执行位概念，ensureExecutable 直接跳过
    const dir = mkdtempSync(join(tmpdir(), "morrow-chmod-"));
    const file = join(dir, "morrow-runtime-fake");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o644);
    ensureExecutable(file);
    assert.equal(statSync(file).mode & 0o777, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });

  it("已是可执行文件保持不变（幂等）", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "morrow-chmod-"));
    const file = join(dir, "already-exec");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o700);
    ensureExecutable(file);
    assert.equal(statSync(file).mode & 0o777, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("describeChildDiagnostics", () => {
  it("已退出的子进程带退出码与 stderr 尾部", () => {
    const source = createJsonLineSource();
    const child = { exitCode: 1, signalCode: null } as unknown as ChildProcess;
    const diag = describeChildDiagnostics(child, "[morrow] fatal: boom\n", source);
    assert.match(diag, /child exit=1/);
    assert.match(diag, /stderr tail: \[morrow\] fatal: boom/);
  });

  it("EOF 场景带 stdout 噪声行（非 JSON 输出不再丢失）", () => {
    const source = createJsonLineSource();
    source.push("panic: runtime error\n");
    const child = { exitCode: 101, signalCode: null } as unknown as ChildProcess;
    const diag = describeChildDiagnostics(child, "", source);
    assert.match(diag, /child exit=101/);
    assert.match(diag, /stdout noise: \["panic: runtime error"\]/);
  });

  it("信号终止的子进程带 signal；未退出标 still running", () => {
    const source = createJsonLineSource();
    const signaled = { exitCode: null, signalCode: "SIGKILL" } as unknown as ChildProcess;
    assert.match(describeChildDiagnostics(signaled, "", source), /killed by signal SIGKILL/);
    const alive = { exitCode: null, signalCode: null } as unknown as ChildProcess;
    assert.match(describeChildDiagnostics(alive, "", source), /still running/);
  });
});
