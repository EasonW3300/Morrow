// ProviderRegistry seam 测试（票 T5 / Issue #6，ADR-0002 三元组 + GLOSSARY: Provider）。
// 密钥只进 SecretStore（此处用内存桩），元数据只进 <dataDir>/providers.json；
// env（MORROW_PROVIDER_*）作为回退默认，显式 CRUD 优先。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderRegistry } from "../src/providers.ts";
import { createInMemorySecretStore, type SecretStore } from "../src/keyring.ts";
import { tmpDir, removeDir } from "./helpers.ts";

const SECRET = "sk-t5-secret-do-not-leak";

interface Fixture {
  dir: string;
  store: SecretStore;
  service: string;
  registry: ProviderRegistry;
}

function makeRegistry(opts: { envBaseUrl?: string; envModel?: string; envApiKey?: string } = {}): Fixture {
  const dir = tmpDir("morrow-prov-");
  const store = createInMemorySecretStore();
  const service = "com.morrow.t5-test";
  const envFallback =
    opts.envBaseUrl !== undefined && opts.envModel !== undefined
      ? { baseUrl: opts.envBaseUrl, apiKey: opts.envApiKey ?? "", modelId: opts.envModel, contextWindow: 131072, maxTokens: 8192 }
      : null;
  const registry = new ProviderRegistry({
    dataDir: dir,
    secretStore: store,
    keyringService: service,
    envFallback,
  });
  return { dir, store, service, registry };
}

function cleanup(f: Fixture): void {
  removeDir(f.dir);
}

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    api_key: SECRET,
    ...overrides,
  };
}

describe("ProviderRegistry：注册", () => {
  it("注册后可取回元数据；密钥只进凭据库，不进元数据", async () => {
    const f = makeRegistry();
    try {
      const rec = await f.registry.register(baseInput());
      assert.match(rec.provider_id, /^[0-9a-f-]{36}$/);
      assert.equal(rec.name, "DeepSeek");
      assert.equal(rec.base_url, "https://api.deepseek.com/v1");
      assert.equal(rec.model, "deepseek-chat");
      assert.equal("api_key" in rec, false);
      assert.equal("apiKey" in rec, false);
      assert.equal(await f.store.getSecret(f.service, rec.provider_id), SECRET);
    } finally {
      cleanup(f);
    }
  });

  it("显式 provider_id 生效；重复注册 409 冲突", async () => {
    const f = makeRegistry();
    try {
      const rec = await f.registry.register(baseInput({ provider_id: "deepseek" }));
      assert.equal(rec.provider_id, "deepseek");
      await assert.rejects(
        () => f.registry.register(baseInput({ provider_id: "deepseek" })),
        /already exists|conflict/i,
      );
    } finally {
      cleanup(f);
    }
  });

  it("保留 id env 不可注册（env 回退专用）", async () => {
    const f = makeRegistry();
    try {
      await assert.rejects(() => f.registry.register(baseInput({ provider_id: "env" })), /reserved|env/i);
    } finally {
      cleanup(f);
    }
  });

  it("非法入参拒绝：缺 name / 坏 base_url / 缺 model / 非正整数 context_window", async () => {
    const f = makeRegistry();
    try {
      await assert.rejects(() => f.registry.register(baseInput({ name: "  " })), /name/);
      await assert.rejects(() => f.registry.register(baseInput({ base_url: "not-a-url" })), /base_url/);
      await assert.rejects(() => f.registry.register(baseInput({ base_url: "ftp://x" })), /base_url/);
      await assert.rejects(() => f.registry.register(baseInput({ model: "" })), /model/);
      await assert.rejects(() => f.registry.register(baseInput({ context_window: -1 })), /context_window/);
      await assert.rejects(() => f.registry.register(baseInput({ max_tokens: 0 })), /max_tokens/);
      await assert.rejects(() => f.registry.register(baseInput({ compat: { supportsDeveloperRole: "yes" } })), /compat/);
      await assert.rejects(() => f.registry.register(baseInput({ provider_id: "Bad Id!" })), /provider_id/);
    } finally {
      cleanup(f);
    }
  });

  it("api_key 可缺省（vLLM/Ollama 免密端点）", async () => {
    const f = makeRegistry();
    try {
      const rec = await f.registry.register(baseInput({ api_key: undefined }));
      assert.equal(await f.store.getSecret(f.service, rec.provider_id), null);
      assert.equal(rec.has_api_key, false);
    } finally {
      cleanup(f);
    }
  });
});

describe("ProviderRegistry：元数据持久化（providers.json，无密钥）", () => {
  it("元数据写入 <dataDir>/providers.json；文件内容不含 api_key", async () => {
    const f = makeRegistry();
    try {
      await f.registry.register(baseInput({ provider_id: "deepseek" }));
      const raw = readFileSync(join(f.dir, "providers.json"), "utf8");
      assert.ok(raw.includes("deepseek"));
      assert.ok(raw.includes("api.deepseek.com"));
      assert.ok(!raw.includes(SECRET), "providers.json 不得含密钥");
    } finally {
      cleanup(f);
    }
  });

  it("重启（新实例指向同 dataDir）后元数据仍在，密钥仍可解析", async () => {
    const f = makeRegistry();
    try {
      await f.registry.register(baseInput({ provider_id: "deepseek" }));
      const reopened = new ProviderRegistry({
        dataDir: f.dir,
        secretStore: f.store,
        keyringService: f.service,
        envFallback: null,
      });
      const rec = await reopened.get("deepseek");
      assert.ok(rec, "重启后应能取回 provider");
      assert.equal(rec?.model, "deepseek-chat");
      const resolved = await reopened.resolve("deepseek");
      assert.equal(resolved?.apiKey, SECRET);
    } finally {
      cleanup(f);
    }
  });
});

describe("ProviderRegistry：更新", () => {
  it("更新 base_url/model/name；未提供的字段不变", async () => {
    const f = makeRegistry();
    try {
      await f.registry.register(baseInput({ provider_id: "ds" }));
      const updated = await f.registry.update("ds", { model: "deepseek-reasoner" });
      assert.equal(updated.model, "deepseek-reasoner");
      assert.equal(updated.base_url, "https://api.deepseek.com/v1");
      assert.equal(updated.name, "DeepSeek");
    } finally {
      cleanup(f);
    }
  });

  it("更新 api_key 轮换凭据库中的密钥", async () => {
    const f = makeRegistry();
    try {
      const rec = await f.registry.register(baseInput({ provider_id: "ds" }));
      await f.registry.update("ds", { api_key: "sk-rotated" });
      assert.equal(await f.store.getSecret(f.service, "ds"), "sk-rotated");
      assert.equal(await f.registry.resolveKey("ds"), "sk-rotated");
      assert.equal(rec.has_api_key, true);
    } finally {
      cleanup(f);
    }
  });

  it("更新未知 provider → NotFound 错误；compat/context_window 可更新", async () => {
    const f = makeRegistry();
    try {
      await assert.rejects(() => f.registry.update("ghost", { model: "m" }), /not found/i);
      await f.registry.register(baseInput({ provider_id: "ds" }));
      const updated = await f.registry.update("ds", {
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false },
        context_window: 65536,
      });
      assert.deepEqual(updated.compat, {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
      });
      assert.equal(updated.context_window, 65536);
    } finally {
      cleanup(f);
    }
  });
});

describe("ProviderRegistry：删除", () => {
  it("删除后元数据消失、凭据库条目清除；再删 404", async () => {
    const f = makeRegistry();
    try {
      await f.registry.register(baseInput({ provider_id: "ds" }));
      await f.registry.delete("ds");
      assert.equal(await f.registry.get("ds"), null);
      assert.equal(await f.store.getSecret(f.service, "ds"), null);
      await assert.rejects(() => f.registry.delete("ds"), /not found/i);
    } finally {
      cleanup(f);
    }
  });

  it("删除默认 Provider 后默认指针落到剩余第一个（无剩余则 null）", async () => {
    const f = makeRegistry();
    try {
      await f.registry.register(baseInput({ provider_id: "a", name: "A" }));
      await f.registry.register(baseInput({ provider_id: "b", name: "B" }));
      assert.equal((await f.registry.defaultProviderId()), "a"); // 首个注册自动成为默认
      await f.registry.delete("a");
      assert.equal((await f.registry.defaultProviderId()), "b");
      await f.registry.delete("b");
      assert.equal(await f.registry.defaultProviderId(), null);
    } finally {
      cleanup(f);
    }
  });
});

describe("ProviderRegistry：默认与 env 回退（显式 CRUD > 环境变量）", () => {
  it("无 CRUD、有 env → resolve() 得 env 回退（id=env，密钥来自环境变量，不入凭据库）", async () => {
    const f = makeRegistry({ envBaseUrl: "https://api.env.com/v1", envModel: "env-model", envApiKey: "env-key" });
    try {
      assert.equal(f.registry.hasDefault(), true);
      const resolved = await f.registry.resolve();
      assert.ok(resolved);
      assert.equal(resolved.providerId, "env");
      assert.equal(resolved.baseUrl, "https://api.env.com/v1");
      assert.equal(resolved.modelId, "env-model");
      assert.equal(resolved.apiKey, "env-key");
      assert.equal(await f.store.getSecret(f.service, "env"), null);
    } finally {
      cleanup(f);
    }
  });

  it("有显式默认 → env 被忽略（优先级：CRUD > env）", async () => {
    const f = makeRegistry({ envBaseUrl: "https://api.env.com/v1", envModel: "env-model", envApiKey: "env-key" });
    try {
      await f.registry.register(baseInput({ provider_id: "ds" }));
      const resolved = await f.registry.resolve();
      assert.equal(resolved?.providerId, "ds");
      assert.equal(resolved?.baseUrl, "https://api.deepseek.com/v1");
      // 显式点名 env 仍可用
      const envResolved = await f.registry.resolve("env");
      assert.equal(envResolved?.providerId, "env");
    } finally {
      cleanup(f);
    }
  });

  it("无任何 Provider → resolve() 返回 null，hasDefault false", async () => {
    const f = makeRegistry();
    try {
      assert.equal(f.registry.hasDefault(), false);
      assert.equal(await f.registry.resolve(), null);
      assert.equal(await f.registry.resolve("ghost"), null);
    } finally {
      cleanup(f);
    }
  });

  it("is_default 显式切换默认；resolve(id) 精确点名", async () => {
    const f = makeRegistry();
    try {
      await f.registry.register(baseInput({ provider_id: "a" }));
      await f.registry.register(baseInput({ provider_id: "b", base_url: "https://b.example.com/v1" }));
      await f.registry.setDefault("b");
      assert.equal(await f.registry.defaultProviderId(), "b");
      const resolved = await f.registry.resolve();
      assert.equal(resolved?.providerId, "b");
    } finally {
      cleanup(f);
    }
  });

  it("resolve 返回完整运行时配置（含 compat 透传与密钥）", async () => {
    const f = makeRegistry();
    try {
      await f.registry.register(
        baseInput({
          provider_id: "vllm",
          compat: { supportsDeveloperRole: false, supportsUsageInStreaming: false },
          context_window: 32768,
          max_tokens: 4096,
        }),
      );
      const resolved = await f.registry.resolve("vllm");
      assert.deepEqual(resolved, {
        providerId: "vllm",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: SECRET,
        modelId: "deepseek-chat",
        contextWindow: 32768,
        maxTokens: 4096,
        compat: { supportsDeveloperRole: false, supportsUsageInStreaming: false },
      });
    } finally {
      cleanup(f);
    }
  });
});

describe("ProviderRegistry：列表与 has_api_key", () => {
  it("list 含 has_api_key / is_default 投影，绝无密钥字段", async () => {
    const f = makeRegistry();
    try {
      await f.registry.register(baseInput({ provider_id: "with-key" }));
      await f.registry.register(baseInput({ provider_id: "no-key", api_key: undefined, base_url: "https://local.example.com" }));
      const list = await f.registry.listAll();
      assert.equal(list.length, 2);
      const withKey = list.find((p) => p.provider_id === "with-key");
      const noKey = list.find((p) => p.provider_id === "no-key");
      assert.equal(withKey?.has_api_key, true);
      assert.equal(withKey?.is_default, true);
      assert.equal(noKey?.has_api_key, false);
      for (const p of list) {
        assert.equal("api_key" in p, false);
        assert.equal("apiKey" in p, false);
      }
    } finally {
      cleanup(f);
    }
  });
});

describe("ProviderRegistry：异常安全", () => {
  it("凭据库写入失败 → register 整体失败，不留半条元数据", async () => {
    const dir = tmpDir("morrow-prov-fail-");
    try {
      const failingStore: SecretStore = {
        setSecret: async () => {
          throw new Error("keychain unavailable");
        },
        getSecret: async () => null,
        deleteSecret: async () => {},
      };
      const registry = new ProviderRegistry({ dataDir: dir, secretStore: failingStore, keyringService: "svc", envFallback: null });
      await assert.rejects(() => registry.register(baseInput()), /keychain unavailable/);
      assert.equal(await registry.get("deepseek"), null, "失败的注册不得留下元数据");
      assert.equal((await registry.listAll()).length, 0);
    } finally {
      removeDir(dir);
    }
  });
});
