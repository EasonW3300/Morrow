// 配置 seam 测试：env 覆盖、默认值、副本身份持久化。
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultDataDir, parseProviderConfig, parseSecretBackend } from "../src/config.ts";
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

test("default bind address is loopback only, never a wildcard/public interface (ADR-0004)", () => {
  const dir = tmpDir("morrow-bind-");
  const config = loadConfig({ MORROW_DATA_DIR: dir });
  // 默认值必须只监听回环；0.0.0.0 / :: 会把私网部署意外暴露到所有网卡（含公网）。
  assert.equal(config.host, "127.0.0.1");
  assert.notEqual(config.host, "0.0.0.0");
  assert.notEqual(config.host, "::");
  // 非回环地址只能显式配置（部署文档：Tailscale/WireGuard 接口地址）。
  const explicit = loadConfig({ MORROW_DATA_DIR: dir, MORROW_HOST: "100.64.0.7" });
  assert.equal(explicit.host, "100.64.0.7");
  removeDir(dir);
});

test("MORROW_SECRET_BACKEND: auto default, memory opt-in for hermetic smokes, unknown rejected", () => {
  assert.equal(parseSecretBackend({}), "auto");
  assert.equal(parseSecretBackend({ MORROW_SECRET_BACKEND: "" }), "auto");
  assert.equal(parseSecretBackend({ MORROW_SECRET_BACKEND: "auto" }), "auto");
  assert.equal(parseSecretBackend({ MORROW_SECRET_BACKEND: "memory" }), "memory");
  assert.throws(() => parseSecretBackend({ MORROW_SECRET_BACKEND: "keychain" }), /MORROW_SECRET_BACKEND/);
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

test("parseProviderConfig: absent env -> null; full trio -> provider config", () => {
  assert.equal(parseProviderConfig({}), null);
  const provider = parseProviderConfig({
    MORROW_PROVIDER_BASE_URL: "http://127.0.0.1:11434/v1",
    MORROW_PROVIDER_API_KEY: "",
    MORROW_PROVIDER_MODEL: "qwen3:8b",
  });
  assert.deepEqual(provider, {
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    modelId: "qwen3:8b",
    contextWindow: 131072,
    maxTokens: 8192,
  });
});

test("parseProviderConfig: partial config and bad numbers are rejected", () => {
  assert.throws(() => parseProviderConfig({ MORROW_PROVIDER_BASE_URL: "http://x" }), /MORROW_PROVIDER_MODEL/);
  assert.throws(
    () =>
      parseProviderConfig({
        MORROW_PROVIDER_BASE_URL: "http://x",
        MORROW_PROVIDER_MODEL: "m",
        MORROW_PROVIDER_CONTEXT_WINDOW: "0",
      }),
    /CONTEXT_WINDOW/,
  );
});

test("loadConfig carries the parsed provider into the runtime config", () => {
  const dir = tmpDir("morrow-prov-");
  const config = loadConfig({
    MORROW_DATA_DIR: dir,
    MORROW_PROVIDER_BASE_URL: "https://api.example.com/v1",
    MORROW_PROVIDER_API_KEY: "sk-test",
    MORROW_PROVIDER_MODEL: "gpt-test",
  });
  assert.equal(config.provider?.baseUrl, "https://api.example.com/v1");
  assert.equal(config.provider?.apiKey, "sk-test");
  assert.equal(config.provider?.modelId, "gpt-test");
  removeDir(dir);
});

// 记忆抽取器选择（M1 code-review / Issue #14 补齐）：默认启发式，显式可选 llm。
test("MORROW_MEMORY_EXTRACTOR: heuristic default, llm opt-in, unknown value rejected", () => {
  const dir = tmpDir("morrow-extractor-");
  const fallback = loadConfig({ MORROW_DATA_DIR: dir });
  assert.equal(fallback.memoryExtractor, "heuristic");
  const llm = loadConfig({ MORROW_DATA_DIR: dir, MORROW_MEMORY_EXTRACTOR: "llm" });
  assert.equal(llm.memoryExtractor, "llm");
  assert.throws(() => loadConfig({ MORROW_DATA_DIR: dir, MORROW_MEMORY_EXTRACTOR: "gpt-5" }), /MORROW_MEMORY_EXTRACTOR/);
  removeDir(dir);
});

test("MORROW_OWNER_<CHANNEL>_IDS：解析为 ownerNativeIds（逗号分隔、去重、空串忽略）", () => {
  // 回归（v0.1.0 真机联调）：ownerNativeIds 在装配层支持但**没有任何配置入口**，
  // 导致 Owner 自己在 QQ 里发消息被 unknown_sender 拒绝。这里锁住环境变量解析。
  const loaded = loadConfig({
    MORROW_PORT: "0",
    MORROW_DATA_DIR: "/tmp/morrow-owner-ids-test",
    MORROW_REPLICA_ID: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    MORROW_OWNER_QQ_IDS: " FBE72705F609C036A8E7C3D59970721D , ,FBE72705F609C036A8E7C3D59970721D,ABC123 ",
    MORROW_OWNER_FEISHU_IDS: "ou_abc",
  });
  assert.deepEqual(loaded.ownerNativeIds?.qq, ["FBE72705F609C036A8E7C3D59970721D", "ABC123"]);
  assert.deepEqual(loaded.ownerNativeIds?.feishu, ["ou_abc"]);
  assert.deepEqual(loaded.ownerNativeIds?.wechat, []);
});

test("ownerNativeIds：未配置时为空数组（不是 undefined 崩溃）", () => {
  const loaded = loadConfig({
    MORROW_PORT: "0",
    MORROW_DATA_DIR: "/tmp/morrow-owner-ids-test2",
    MORROW_REPLICA_ID: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  });
  assert.deepEqual(loaded.ownerNativeIds, { feishu: [], qq: [], wechat: [] });
});
