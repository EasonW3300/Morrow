// 进程边界 seam 测试：以独立进程启动 main.ts（与生产一致），验证
// ready 行、health、优雅退出（SIGTERM/SIGINT）与重启后账本完整。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@morrow/protocol";
import { EventLedger } from "../src/ledger.ts";
import { json, makeEvent, removeDir, tmpDir } from "./helpers.ts";

interface HealthBody {
  status: string;
  replica_id: string;
  sandbox: { status: string };
}

interface EventPage {
  events: EventEnvelope[];
  total: number;
}

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const NODE_FLAGS = ["--experimental-sqlite", "--experimental-strip-types"];

interface ReadyLine {
  ready: boolean;
  port: number;
  pid: number;
  data_dir: string;
}

interface RuntimeProcess {
  child: ChildProcess;
  ready: Promise<ReadyLine>;
  stop(signal: "SIGTERM" | "SIGINT"): Promise<number | null>;
}

function startProcess(env: Record<string, string>): RuntimeProcess {
  const child = spawn(process.execPath, [...NODE_FLAGS, MAIN], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  const ready = new Promise<ReadyLine>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as ReadyLine;
          if (parsed.ready === true) resolve(parsed);
        } catch {
          // 非 JSON 行忽略（目前没有其他 stdout 输出）
        }
      }
    });
    child.once("exit", (code) => reject(new Error(`runtime exited before ready (code ${code})`)));
    child.once("error", reject);
  });
  return {
    child,
    ready,
    stop(signal) {
      return new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.kill(signal);
      });
    },
  };
}

/** 起进程并注册兜底清理：测试中途断言失败也不能留下活进程挂住 runner */
function startManaged(
  t: { after(fn: () => unknown): void },
  env: Record<string, string>,
): RuntimeProcess {
  const proc = startProcess(env);
  t.after(() => {
    if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
  });
  return proc;
}

test("runtime process serves health and records its startup event", { timeout: 20000 }, async (t) => {
  const dir = tmpDir("morrow-proc-");
  t.after(() => removeDir(dir));
  const proc = startManaged(t, { MORROW_DATA_DIR: dir, MORROW_PORT: "0" });
  const ready = await proc.ready;
  assert.ok(ready.port > 0);
  assert.equal(ready.data_dir, dir);

  const health = await json<HealthBody>(await fetch(`http://127.0.0.1:${ready.port}/v1/health`));
  assert.equal(health.status, "ok");
  assert.equal(health.sandbox.status, "not-configured");

  const events = await json<EventPage>(await fetch(`http://127.0.0.1:${ready.port}/v1/events`));
  assert.ok(events.events.some((e) => e.event_type === "runtime.started"));

  assert.equal(await proc.stop("SIGTERM"), 0);
});

test("events recorded before shutdown survive a restart", { timeout: 30000 }, async (t) => {
  const dir = tmpDir("morrow-restart-");
  t.after(() => removeDir(dir));

  // 重启前预置两笔事件（模拟历史账本）
  const pre = EventLedger.open(dir);
  const e1 = makeEvent({ payload: { note: "before restart 1" } });
  const e2 = makeEvent({ payload: { note: "before restart 2" } });
  pre.append(e1);
  pre.append(e2);
  pre.close();

  // 第一次运行：2 笔预置 + 1 笔 started；SIGTERM 优雅退出再记 1 笔 stopped
  const first = startManaged(t, { MORROW_DATA_DIR: dir, MORROW_PORT: "0" });
  const ready1 = await first.ready;
  const health1 = await json<HealthBody>(await fetch(`http://127.0.0.1:${ready1.port}/v1/health`));
  const replicaId = health1.replica_id;
  const run1 = await json<EventPage>(await fetch(`http://127.0.0.1:${ready1.port}/v1/events?limit=200`));
  assert.equal(run1.total, 3);
  assert.equal(await first.stop("SIGTERM"), 0);

  // 第二次运行：退出前全部事件仍在（含 run1 的 started 与 stopped），再加 1 笔新 started
  const second = startManaged(t, { MORROW_DATA_DIR: dir, MORROW_PORT: "0" });
  const ready2 = await second.ready;
  const health2 = await json<HealthBody>(await fetch(`http://127.0.0.1:${ready2.port}/v1/health`));
  assert.equal(health2.replica_id, replicaId, "replica identity is stable across restarts");
  const run2 = await json<EventPage>(await fetch(`http://127.0.0.1:${ready2.port}/v1/events?limit=200`));
  assert.equal(run2.total, 5, "seeded 2 + run1 started/stopped + run2 started");
  const run2Ids = new Set<string>(run2.events.map((e) => e.event_id));
  for (const id of run1.events.map((e) => e.event_id)) {
    assert.ok(run2Ids.has(id), `event ${id} must survive the restart`);
  }
  const stopped1 = run2.events.find((e) => e.event_type === "runtime.stopped");
  assert.ok(stopped1, "run1's graceful-shutdown event is persisted and queryable");
  assert.equal(stopped1?.payload.signal, "SIGTERM");
  assert.equal(await second.stop("SIGTERM"), 0);
});

test("SIGINT also exits gracefully and records a stopped event with the signal", { timeout: 20000 }, async (t) => {
  const dir = tmpDir("morrow-sigint-");
  t.after(() => removeDir(dir));
  const proc = startManaged(t, { MORROW_DATA_DIR: dir, MORROW_PORT: "0" });
  await proc.ready;
  assert.equal(await proc.stop("SIGINT"), 0);

  const ledger = EventLedger.open(dir);
  const events = ledger.list({ limit: 200 }).events;
  const stopped = events.find((e) => e.event_type === "runtime.stopped");
  assert.ok(stopped, "runtime.stopped recorded");
  assert.equal(stopped?.payload.signal, "SIGINT");
  const started = events.find((e) => e.event_type === "runtime.started");
  assert.equal(stopped?.causation_id, started?.event_id);
  ledger.close();
});
