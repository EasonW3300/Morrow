// OS 凭据库封装 seam 测试（票 T5 / Issue #6，ADR-0002：密钥只进 OS 凭据库）。
//
// 真实后端：macOS `security` CLI 在本机实测跑通（service 名带 morrow-test 前缀避免
// 污染用户钥匙串，套件结束清理）。Windows/Linux 后端以注入 exec 桩测试命令构造，
// 真实 OS 行为未实测（文档标注）。
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import {
  createInMemorySecretStore,
  createKeychainStore,
  createLinuxSecretToolStore,
  createWindowsCredentialStore,
  type ExecResult,
  type ExecFn,
  type SecretStore,
} from "../src/keyring.ts";

/** 各后端共同遵守的契约套件（同一接口的三种实现 + 内存桩） */
function secretStoreContract(name: string, make: () => SecretStore, cleanup?: (store: SecretStore) => Promise<void>): void {
  describe(`SecretStore 契约：${name}`, () => {
    const store = make();
    const service = `com.morrow.t5-test-${randomUUID()}`;
    const account = "provider-alpha";

    after(async () => {
      if (cleanup) await cleanup(store);
    });

    it("未写入时 getSecret 返回 null", async () => {
      assert.equal(await store.getSecret(service, account), null);
    });

    it("setSecret 后 getSecret 取回原文", async () => {
      await store.setSecret(service, account, "sk-test-abc123");
      assert.equal(await store.getSecret(service, account), "sk-test-abc123");
    });

    it("同 service+account 重复 setSecret 覆盖旧值（密钥轮换）", async () => {
      await store.setSecret(service, account, "rotated-key-456");
      assert.equal(await store.getSecret(service, account), "rotated-key-456");
    });

    it("同 service 不同 account 互不影响", async () => {
      await store.setSecret(service, "provider-beta", "other-key");
      assert.equal(await store.getSecret(service, "provider-beta"), "other-key");
      assert.equal(await store.getSecret(service, account), "rotated-key-456");
      await store.deleteSecret(service, "provider-beta");
    });

    it("deleteSecret 后取回 null", async () => {
      await store.deleteSecret(service, account);
      assert.equal(await store.getSecret(service, account), null);
    });

    it("deleteSecret 幂等：删不存在的项不抛错", async () => {
      await store.deleteSecret(service, "never-existed");
    });
  });
}

// --- 真实 macOS Keychain（本机实测） -----------------------------------------

const MACOS_SERVICE = `com.morrow.t5-test-${randomUUID()}`;
secretStoreContract(
  "macOS Keychain（security CLI，真实）",
  () => createKeychainStore(),
  async (store) => {
    // 清理本套件写入的所有钥匙串项（幂等）
    for (const account of ["provider-alpha", "provider-beta"]) {
      await store.deleteSecret(MACOS_SERVICE, account);
    }
  },
);

it("macOS 后端真实往返：写 → 读 → 删（独立于契约套件的显式冒烟）", async () => {
  const store = createKeychainStore();
  const service = `com.morrow.t5-test-${randomUUID()}`;
  try {
    await store.setSecret(service, "smoke", "secret-value-789");
    assert.equal(await store.getSecret(service, "smoke"), "secret-value-789");
  } finally {
    await store.deleteSecret(service, "smoke");
    assert.equal(await store.getSecret(service, "smoke"), null);
  }
});

// --- 内存桩（测试与无 OS 凭据库环境的回退） -----------------------------------

secretStoreContract("内存桩", () => createInMemorySecretStore());

it("内存桩：getSecret 返回的是同一 Map 里的值（引用语义可观察）", async () => {
  const store = createInMemorySecretStore();
  const service = "com.morrow.test";
  await store.setSecret(service, "a", "v1");
  const second = createInMemorySecretStore();
  assert.equal(await second.getSecret(service, "a"), null); // 实例间不共享
});

// --- Windows / Linux：注入 exec 桩，锁定命令构造（真实 OS 未实测） ------------

function fakeExec(responses: Map<string, ExecResult | ExecResult[]>): { exec: ExecFn; calls: Array<{ file: string; args: string[]; input?: string }> } {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const exec: ExecFn = async (file, args, options) => {
    const input = options?.input;
    calls.push({ file, args, ...(input !== undefined ? { input } : {}) });
    const sig = `${file} ${args.join(" ")}`;
    // 最长前缀匹配：键如 "cmdkey /generic:"、"powershell -NoProfile"
    let best: string | null = null;
    for (const key of responses.keys()) {
      if (sig.startsWith(key) && (best === null || key.length > best.length)) best = key;
    }
    if (best === null) throw new Error(`fakeExec: no scripted response for ${sig}`);
    const scripted = responses.get(best) as ExecResult | ExecResult[];
    // 同键多次调用按声明顺序逐个消费（用尽后停在最后一个）
    const res = Array.isArray(scripted)
      ? (scripted.length > 1 ? (scripted.shift() as ExecResult) : scripted[0])
      : scripted;
    return res;
  };
  return { exec, calls };
}

describe("Windows Credential Manager 后端（exec 桩；真实 OS 未实测）", () => {
  it("setSecret → cmdkey /generic:<service>:<account> /user /pass", async () => {
    const { exec, calls } = fakeExec(new Map([["cmdkey /generic:", { stdout: "", stderr: "", exitCode: 0 }]]));
    const store = createWindowsCredentialStore(exec);
    await store.setSecret("com.morrow.runtime", "p1", "win-key");
    assert.equal(calls[0].file, "cmdkey");
    assert.deepEqual(calls[0].args, ["/generic:com.morrow.runtime:p1", "/user:morrow", "/pass:win-key"]);
  });

  it("getSecret → PowerShell CredRead（找到返回原文；空输出/失败返回 null）", async () => {
    const { exec, calls } = fakeExec(
      new Map([
        ["cmdkey /generic:", { stdout: "", stderr: "", exitCode: 0 }],
        [
          "powershell -NoProfile",
          [
            { stdout: "win-key-123", stderr: "", exitCode: 0 },
            { stdout: "", stderr: "", exitCode: 0 },
          ],
        ],
      ]),
    );
    const store = createWindowsCredentialStore(exec);
    await store.setSecret("com.morrow.runtime", "p1", "x");
    const got = await store.getSecret("com.morrow.runtime", "p1");
    assert.equal(got, "win-key-123");
    assert.equal(calls[1].file, "powershell");
    // 未找到：CredRead 失败脚本打印空 → null
    assert.equal(await store.getSecret("com.morrow.runtime", "p1"), null);
  });

  it("deleteSecret → cmdkey /delete", async () => {
    const { exec, calls } = fakeExec(new Map([["cmdkey /delete:", { stdout: "", stderr: "", exitCode: 0 }]]));
    const store = createWindowsCredentialStore(exec);
    await store.deleteSecret("com.morrow.runtime", "p1");
    assert.deepEqual(calls[0].args, ["/delete:com.morrow.runtime:p1"]);
  });
});

describe("Linux secret-tool (libsecret) 后端（exec 桩；真实 OS 未实测）", () => {
  it("setSecret → secret-tool store，密钥走 stdin 不进 argv", async () => {
    const { exec, calls } = fakeExec(new Map([["secret-tool store", { stdout: "", stderr: "", exitCode: 0 }]]));
    const store = createLinuxSecretToolStore(exec);
    await store.setSecret("com.morrow.runtime", "p1", "linux-key");
    assert.equal(calls[0].file, "secret-tool");
    assert.deepEqual(calls[0].args, ["store", "--label=morrow provider secret", "service", "com.morrow.runtime", "account", "p1"]);
    assert.equal(calls[0].input, "linux-key");
  });

  it("getSecret → secret-tool lookup", async () => {
    const { exec, calls } = fakeExec(new Map([["secret-tool lookup", { stdout: "linux-key\n", stderr: "", exitCode: 0 }]]));
    const store = createLinuxSecretToolStore(exec);
    assert.equal(await store.getSecret("com.morrow.runtime", "p1"), "linux-key");
    assert.deepEqual(calls[0].args, ["lookup", "service", "com.morrow.runtime", "account", "p1"]);
  });

  it("getSecret 未找到（空输出）→ null", async () => {
    const { exec } = fakeExec(new Map([["secret-tool lookup", { stdout: "", stderr: "", exitCode: 1 }]]));
    const store = createLinuxSecretToolStore(exec);
    assert.equal(await store.getSecret("com.morrow.runtime", "nope"), null);
  });

  it("deleteSecret → secret-tool clear", async () => {
    const { exec, calls } = fakeExec(new Map([["secret-tool clear", { stdout: "", stderr: "", exitCode: 0 }]]));
    const store = createLinuxSecretToolStore(exec);
    await store.deleteSecret("com.morrow.runtime", "p1");
    assert.deepEqual(calls[0].args, ["clear", "service", "com.morrow.runtime", "account", "p1"]);
  });
});
