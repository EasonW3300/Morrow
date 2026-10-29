// Device 记录（票 #3 的 M0 最小实现）：启动种子 + 只读端点。
// 边界：不做配对/撤销/多设备——M3 范围（PRD §5.2、AC-04/05）。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../src/config.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { startRuntime } from "../src/runtime.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const REPLICA = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function testConfig(dir: string): RuntimeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    replicaId: REPLICA,
    provider: null,
  };
}

test("DeviceRegistry.touch：首见插入，再见只刷 last_seen_at（created_at 保持首见）", () => {
  const dir = tmpDir("morrow-devices-");
  const registry = DeviceRegistry.open(dir);
  try {
    const t0 = new Date("2026-10-29T10:00:00.000Z");
    const t1 = new Date("2026-10-29T12:00:00.000Z");
    registry.touch(REPLICA, t0);
    registry.touch(REPLICA, t1); // 重启种子：同 replica_id
    const devices = registry.list();
    assert.equal(devices.length, 1, "同一 replica_id 不产生重复记录");
    assert.equal(devices[0].replica_id, REPLICA);
    assert.equal(devices[0].created_at, t0.toISOString(), "created_at 是首见时间");
    assert.equal(devices[0].last_seen_at, t1.toISOString(), "last_seen_at 刷新为最近一次启动");
    assert.equal(devices[0].label, null, "M0 无命名机制，label 恒 null");
  } finally {
    registry.close();
    removeDir(dir);
  }
});

test("startRuntime 启动即种子本副本；GET /v1/devices 可读", async () => {
  const dir = tmpDir("morrow-devices-");
  const runtime = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/devices`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      devices: Array<{ replica_id: string; label: string | null; created_at: string; last_seen_at: string }>;
    };
    assert.equal(body.devices.length, 1);
    const device = body.devices[0];
    assert.equal(device.replica_id, REPLICA);
    assert.match(device.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.match(device.last_seen_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(device.label, null);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("重启同一 dataDir：记录不重复，last_seen_at 前移，created_at 不变", async () => {
  const dir = tmpDir("morrow-devices-");
  const first = await startRuntime(testConfig(dir));
  let firstRow: { created_at: string; last_seen_at: string };
  try {
    const res = await fetch(`http://127.0.0.1:${first.port}/v1/devices`);
    firstRow = ((await res.json()) as { devices: Array<{ created_at: string; last_seen_at: string }> }).devices[0];
  } finally {
    await first.close();
  }
  // created_at 与 last_seen_at 同批写入，可能有毫秒差；留 2ms 余量后重启
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await startRuntime(testConfig(dir));
  try {
    const res = await fetch(`http://127.0.0.1:${second.port}/v1/devices`);
    const body = (await res.json()) as {
      devices: Array<{ replica_id: string; created_at: string; last_seen_at: string }>;
    };
    assert.equal(body.devices.length, 1, "重启不产生第二条设备记录");
    assert.equal(body.devices[0].created_at, firstRow.created_at, "created_at 保持首见");
    assert.ok(
      body.devices[0].last_seen_at >= firstRow.last_seen_at,
      "last_seen_at 至少不早于上一次（重启即刷新）",
    );
  } finally {
    await second.close();
    removeDir(dir);
  }
});
