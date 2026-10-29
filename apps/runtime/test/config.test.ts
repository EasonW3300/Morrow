// 配置 seam 测试：env 覆盖、默认值、副本身份持久化。
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultDataDir } from "../src/config.ts";
import { removeDir, tmpDir } from "./helpers.ts";

test("loadConfig falls back to safe defaults", () => {
  const dir = tmpDir("morrow-def-");
  const config = loadConfig({ MORROW_DATA_DIR: dir });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 0);
  assert.equal(defaultDataDir(), join(homedir(), ".morrow", "data"));
  assert.match(config.replicaId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  removeDir(dir);
});

test("loadConfig honors MORROW_* environment overrides", () => {
  const dir = tmpDir("morrow-cfg-");
  const config = loadConfig({
    MORROW_HOST: "0.0.0.0",
    MORROW_PORT: "7333",
    MORROW_DATA_DIR: dir,
    MORROW_REPLICA_ID: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 7333);
  assert.equal(config.dataDir, dir);
  assert.equal(config.replicaId, "f47ac10b-58cc-4372-a567-0e02b2c3d479");
  removeDir(dir);
});

test("replica identity is persisted per data dir across restarts", () => {
  const dir = tmpDir("morrow-replica-");
  const first = loadConfig({ MORROW_DATA_DIR: dir });
  const second = loadConfig({ MORROW_DATA_DIR: dir });
  assert.equal(first.replicaId, second.replicaId);
  removeDir(dir);
});

test("loadConfig rejects a malformed MORROW_REPLICA_ID", () => {
  assert.throws(() => loadConfig({ MORROW_REPLICA_ID: "nope" }), /replica/i);
});

test("loadConfig rejects a non-numeric MORROW_PORT", () => {
  assert.throws(() => loadConfig({ MORROW_PORT: "http" }), /port/i);
});
