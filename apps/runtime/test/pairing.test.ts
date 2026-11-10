// 设备配对与设备身份（M3-T2 / Issue #31，FR-DEP-2 / ADR-0008）。
//
// 测试缝 = HTTP 控制面（startRuntime 起的真实 node:http 服务）+ 鉴权纯策略函数
// （authorizeRequest 不依赖真实网卡即可断言非回环拒绝）。凭据库一律注入内存桩，
// 绝不触碰真实 Keychain/凭据库。
//
// 覆盖：配对码 5 分钟有效/单次使用/过期与复用拒绝；双端指纹一致（含不一致明确失败
// 且不烧码）；撤销后令牌失效；回环豁免与非回环强制；私钥/令牌不泄漏到配置、账本、
// API 响应与 SQLite 文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeviceInfo, PairingClaimResponse, PairingCodeResponse } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { createInMemorySecretStore, type SecretStore } from "../src/keyring.ts";
import { authorizeRequest, isLoopbackAddress } from "../src/pairing/auth.ts";
import {
  DEVICE_KEY_SERVICE,
  deviceKeyAccount,
  deviceTokenAccount,
  fingerprintFromPublicKey,
  formatFingerprint,
  generateDeviceKeyPair,
  type DeviceKeyPair,
} from "../src/pairing/crypto.ts";
import { PairingError } from "../src/pairing/service.ts";
import { json, removeDir, REPLICA_A, tmpDir } from "./helpers.ts";

interface ApiError {
  error: { code: string; message: string };
}

interface DeviceListBody {
  devices: DeviceInfo[];
}

interface EventPage {
  events: Array<{ event_type: string; payload: Record<string, unknown> }>;
}

const CLIENT_REPLICA = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

function testConfig(dir: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId: REPLICA_A, provider: null };
}

/** 起一个注入内存凭据库与可控时钟的 runtime */
async function boot(options: { clock?: { value: Date } } = {}): Promise<{
  runtime: RuntimeHandle;
  dir: string;
  secrets: SecretStore;
}> {
  const dir = tmpDir("morrow-pairing-");
  const secrets = createInMemorySecretStore();
  const runtime = await startRuntime(testConfig(dir), {
    secretStore: secrets,
    ...(options.clock === undefined ? {} : { pairingNow: () => new Date(options.clock!.value.getTime()) }),
  });
  return { runtime, dir, secrets };
}

async function createCode(runtime: RuntimeHandle): Promise<PairingCodeResponse> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/pairing/codes`, { method: "POST" });
  assert.equal(res.status, 201);
  return json<PairingCodeResponse>(res);
}

async function claim(
  runtime: RuntimeHandle,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${runtime.port}/v1/pairing/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listDevices(runtime: RuntimeHandle): Promise<DeviceInfo[]> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/devices`);
  assert.equal(res.status, 200);
  return (await json<DeviceListBody>(res)).devices;
}

async function allEvents(runtime: RuntimeHandle): Promise<EventPage["events"]> {
  const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/events?limit=200`);
  assert.equal(res.status, 200);
  return (await json<EventPage>(res)).events;
}

async function pairClient(
  runtime: RuntimeHandle,
  client: DeviceKeyPair,
  label = "Laptop",
  replicaId = CLIENT_REPLICA,
): Promise<PairingClaimResponse> {
  const pending = await createCode(runtime);
  const res = await claim(runtime, {
    code: pending.code,
    device_public_key: client.publicKey,
    device_label: label,
    device_replica_id: replicaId,
  });
  assert.equal(res.status, 200);
  return json<PairingClaimResponse>(res);
}

test("POST /v1/pairing/codes：6 位码 + 5 分钟 TTL + 本机指纹；私钥只进注入的凭据库", async () => {
  const clock = { value: new Date("2026-11-10T08:00:00.000Z") };
  const { runtime, dir, secrets } = await boot({ clock });
  try {
    const pending = await createCode(runtime);
    assert.match(pending.code, /^\d{6}$/, "配对码必须是 6 位数字（前导零保留）");
    assert.equal(pending.expires_at, "2026-11-10T08:05:00.000Z", "默认 TTL = 5 分钟");
    assert.match(pending.server.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(pending.server.fingerprint_short, formatFingerprint(pending.server.fingerprint));
    assert.match(pending.server.fingerprint_short, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    assert.equal(pending.server.replica_id, REPLICA_A);
    assert.equal(fingerprintFromPublicKey(pending.server.public_key), pending.server.fingerprint);

    // 私钥只应在注入的内存凭据库（service=com.morrow.device, account=replica_id）
    const privateKey = await secrets.getSecret(DEVICE_KEY_SERVICE, deviceKeyAccount(REPLICA_A));
    assert.ok(privateKey !== null && privateKey.includes("BEGIN PRIVATE KEY"));
    // 服务端凭据库不存 bearer token（还没 claim）——更不存 token 明文
    assert.equal(await secrets.getSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(REPLICA_A)), null);

    // 本机行因惰性供给身份获得了公钥/指纹，且仍是可信、未撤销
    const own = (await listDevices(runtime)).find((d) => d.replica_id === REPLICA_A);
    assert.ok(own !== undefined);
    assert.equal(own.fingerprint, pending.server.fingerprint);
    assert.equal(own.trusted, true);
    assert.equal(own.revoked, false);
    assert.equal(own.paired_at, null, "本机自注册不是配对事件");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("claim：交换双方公钥与指纹、落可信设备、下发一次性 token，并写 device.paired 审计", async () => {
  const { runtime, dir, secrets } = await boot();
  try {
    const client = generateDeviceKeyPair();
    const pending = await createCode(runtime);
    const res = await claim(runtime, {
      code: pending.code,
      device_public_key: client.publicKey,
      device_label: "  Laptop  ",
      device_replica_id: CLIENT_REPLICA,
    });
    assert.equal(res.status, 200);
    const claimed = await json<PairingClaimResponse>(res);
    assert.match(claimed.token, /^mrw_[A-Za-z0-9_-]{43}$/);
    assert.equal(claimed.token_account, deviceTokenAccount(REPLICA_A));
    assert.equal(claimed.device.replica_id, CLIENT_REPLICA);
    assert.equal(claimed.device.label, "Laptop", "label 去首尾空白");
    assert.equal(claimed.device.fingerprint, client.fingerprint);
    assert.equal(claimed.server.fingerprint, pending.server.fingerprint, "claim 响应带服务端指纹");
    assert.equal(claimed.device.fingerprint_short, formatFingerprint(client.fingerprint));

    const devices = await listDevices(runtime);
    assert.equal(devices.length, 2);
    const remote = devices.find((d) => d.replica_id === CLIENT_REPLICA);
    assert.ok(remote !== undefined);
    assert.equal(remote.label, "Laptop");
    assert.equal(remote.public_key, client.publicKey);
    assert.equal(remote.fingerprint, client.fingerprint);
    assert.equal(remote.trusted, true);
    assert.equal(remote.revoked, false);
    assert.ok(remote.paired_at !== null);
    assert.equal(remote.last_sync_at, null, "同步引擎归 M3-T3，本票恒 null");
    assert.equal(remote.fingerprint_short, formatFingerprint(client.fingerprint));

    const events = await allEvents(runtime);
    const paired = events.find((e) => e.event_type === "device.paired");
    assert.ok(paired !== undefined, "配对必须留审计事件");
    assert.equal(paired.payload.replica_id, CLIENT_REPLICA);
    assert.equal(paired.payload.fingerprint, client.fingerprint);
    assert.equal(paired.payload.server_fingerprint, claimed.server.fingerprint);

    // 服务端只存 token 摘要，不存明文；审计事件也不含 token
    assert.equal(await secrets.getSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(REPLICA_A)), null);
    assert.ok(!JSON.stringify(events).includes(claimed.token), "事件账本不得出现 token 明文");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("配对码单次使用：第二次 claim 返回 409 code_already_used", async () => {
  const { runtime, dir } = await boot();
  try {
    const client = generateDeviceKeyPair();
    const pending = await createCode(runtime);
    assert.equal((await claim(runtime, { code: pending.code, device_public_key: client.publicKey })).status, 200);
    const second = await claim(runtime, { code: pending.code, device_public_key: generateDeviceKeyPair().publicKey });
    assert.equal(second.status, 409);
    assert.equal((await json<ApiError>(second)).error.code, "code_already_used");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("配对码 5 分钟过期：过期后 claim 返回 410 code_expired", async () => {
  const clock = { value: new Date("2026-11-10T08:00:00.000Z") };
  const { runtime, dir } = await boot({ clock });
  try {
    const client = generateDeviceKeyPair();
    const pending = await createCode(runtime);
    clock.value = new Date("2026-11-10T08:04:59.000Z");
    // 未过期前可用（这里直接跨到过期——先验证边界内仍有效会消耗码，故只测过期侧）
    clock.value = new Date("2026-11-10T08:05:01.000Z");
    const res = await claim(runtime, { code: pending.code, device_public_key: client.publicKey });
    assert.equal(res.status, 410);
    assert.equal((await json<ApiError>(res)).error.code, "code_expired");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("双端指纹不一致：409 fingerprint_mismatch 且不消耗配对码（修正后可重试）", async () => {
  const { runtime, dir } = await boot();
  try {
    const client = generateDeviceKeyPair();
    const pending = await createCode(runtime);
    const mismatch = await claim(runtime, {
      code: pending.code,
      device_public_key: client.publicKey,
      server_fingerprint: "0000-0000-0000-0000",
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await json<ApiError>(mismatch)).error.code, "fingerprint_mismatch");

    // 同一个码仍可用：不一致失败不能烧掉一次性码
    const ok = await claim(runtime, {
      code: pending.code,
      device_public_key: client.publicKey,
      device_replica_id: CLIENT_REPLICA,
      server_fingerprint: pending.server.fingerprint_short,
    });
    assert.equal(ok.status, 200);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("非法公钥/非法码在消费前拒绝：400 invalid_device_public_key / invalid_code", async () => {
  const { runtime, dir } = await boot();
  try {
    const pending = await createCode(runtime);
    const badKey = await claim(runtime, { code: pending.code, device_public_key: "not-a-key" });
    assert.equal(badKey.status, 400);
    assert.equal((await json<ApiError>(badKey)).error.code, "invalid_device_public_key");

    const badCode = await claim(runtime, { code: "12ab", device_public_key: generateDeviceKeyPair().publicKey });
    assert.equal(badCode.status, 400);
    assert.equal((await json<ApiError>(badCode)).error.code, "invalid_code");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("鉴权策略：回环豁免；非回环无令牌 401、有效令牌放行、撤销后 403", async () => {
  const { runtime, dir } = await boot();
  try {
    const client = generateDeviceKeyPair();
    const claimed = await pairClient(runtime, client);

    // 回环豁免（含 IPv4-mapped）
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "::1%lo0"]) {
      assert.equal(isLoopbackAddress(address), true, address);
      const decision = authorizeRequest(
        { remoteAddress: address, method: "GET", pathname: "/v1/devices", authorization: undefined },
        runtime.pairing,
      );
      assert.equal(decision.kind, "allow");
    }

    // 非回环：无令牌 → 401；claim 例外（码即凭据）
    const missing = authorizeRequest(
      { remoteAddress: "100.64.0.9", method: "GET", pathname: "/v1/devices", authorization: undefined },
      runtime.pairing,
    );
    assert.deepEqual(missing, {
      kind: "deny",
      status: 401,
      code: "unauthorized",
      message: "non-loopback requests require Authorization: Bearer <device token>",
    });
    const claimExempt = authorizeRequest(
      { remoteAddress: "100.64.0.9", method: "POST", pathname: "/v1/pairing/claim", authorization: undefined },
      runtime.pairing,
    );
    assert.equal(claimExempt.kind, "allow");

    // 错误令牌 → 401 invalid_token
    const wrong = authorizeRequest(
      { remoteAddress: "100.64.0.9", method: "GET", pathname: "/v1/devices", authorization: "Bearer mrw_bogus" },
      runtime.pairing,
    );
    assert.equal(wrong.kind, "deny");
    if (wrong.kind === "deny") {
      assert.equal(wrong.status, 401);
      assert.equal(wrong.code, "invalid_token");
    }

    // 有效令牌 → 放行且标识设备
    const allowed = authorizeRequest(
      {
        remoteAddress: "100.64.0.9",
        method: "GET",
        pathname: "/v1/devices",
        authorization: `Bearer ${claimed.token}`,
      },
      runtime.pairing,
    );
    assert.equal(allowed.kind, "allow");
    if (allowed.kind === "allow") assert.equal(allowed.device?.replica_id, CLIENT_REPLICA);

    // 撤销后同一令牌 → 403 device_revoked（撤销清空 token_hash 的直接效果）
    const revokedRes = await fetch(`http://127.0.0.1:${runtime.port}/v1/devices/${CLIENT_REPLICA}`, {
      method: "DELETE",
    });
    assert.equal(revokedRes.status, 200);
    const after = authorizeRequest(
      {
        remoteAddress: "100.64.0.9",
        method: "GET",
        pathname: "/v1/devices",
        authorization: `Bearer ${claimed.token}`,
      },
      runtime.pairing,
    );
    assert.equal(after.kind, "deny");
    if (after.kind === "deny") {
      assert.equal(after.status, 403);
      assert.equal(after.code, "device_revoked");
    }
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("DELETE /v1/devices/:id：撤销幂等、写审计；未知 404；不可撤销本机", async () => {
  const { runtime, dir } = await boot();
  try {
    const claimed = await pairClient(runtime, generateDeviceKeyPair());
    assert.ok(claimed.token.length > 0);

    const first = await fetch(`http://127.0.0.1:${runtime.port}/v1/devices/${CLIENT_REPLICA}`, { method: "DELETE" });
    assert.equal(first.status, 200);
    const firstBody = (await json<{ device: DeviceInfo; changed: boolean }>(first));
    assert.equal(firstBody.changed, true);
    assert.equal(firstBody.device.revoked, true);
    assert.ok(firstBody.device.revoked_at !== null);

    const second = await fetch(`http://127.0.0.1:${runtime.port}/v1/devices/${CLIENT_REPLICA}`, { method: "DELETE" });
    assert.equal(second.status, 200);
    assert.equal((await json<{ changed: boolean }>(second)).changed, false, "重复撤销幂等");

    const unknown = await fetch(`http://127.0.0.1:${runtime.port}/v1/devices/${randomUUID()}`, { method: "DELETE" });
    assert.equal(unknown.status, 404);

    const self = await fetch(`http://127.0.0.1:${runtime.port}/v1/devices/${REPLICA_A}`, { method: "DELETE" });
    assert.equal(self.status, 409);
    assert.equal((await json<ApiError>(self)).error.code, "cannot_revoke_self");

    // 撤销后设备行仍在（审计保留），列表可见 revoked=true；配对事件 + 撤销事件都在
    const listed = (await listDevices(runtime)).find((d) => d.replica_id === CLIENT_REPLICA);
    assert.ok(listed !== undefined);
    assert.equal(listed.revoked, true);
    const events = await allEvents(runtime);
    assert.ok(events.some((e) => e.event_type === "device.revoked"));
    assert.equal(events.filter((e) => e.event_type === "device.revoked").length, 1, "重复撤销不重复审计");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("只有已信任设备能生成配对码（未注册 issuer → PairingError issuer_not_trusted）", async () => {
  const { runtime, dir } = await boot();
  try {
    await assert.rejects(
      () => runtime.pairing.createCode(randomUUID()),
      (err: unknown) => err instanceof PairingError && err.code === "issuer_not_trusted" && err.httpStatus === 403,
    );
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("6 位码暴力尝试限速：同一来源 10 次失败后 429 too_many_attempts", async () => {
  const { runtime, dir } = await boot();
  try {
    const client = generateDeviceKeyPair();
    for (let i = 0; i < 10; i++) {
      const res = await claim(runtime, { code: "000000", device_public_key: client.publicKey });
      assert.equal(res.status, 400, `attempt ${i + 1} should be a normal invalid_code`);
    }
    const limited = await claim(runtime, { code: "000000", device_public_key: client.publicKey });
    assert.equal(limited.status, 429);
    assert.equal((await json<ApiError>(limited)).error.code, "too_many_attempts");
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});

test("私钥/令牌不泄漏：API 响应、事件账本、dataDir 文件与 SQLite 均无 PEM/明文 token", async () => {
  const { runtime, dir, secrets } = await boot();
  try {
    const client = generateDeviceKeyPair();
    const pending = await createCode(runtime);
    const pendingJson = JSON.stringify(pending);

    const res = await claim(runtime, {
      code: pending.code,
      device_public_key: client.publicKey,
      device_label: "Leak Check",
      device_replica_id: CLIENT_REPLICA,
    });
    assert.equal(res.status, 200);
    const claimed = await json<PairingClaimResponse>(res);
    const claimJson = JSON.stringify(claimed);

    const devicesJson = JSON.stringify(await listDevices(runtime));
    const eventsJson = JSON.stringify(await allEvents(runtime));
    const serverPrivateKey = await secrets.getSecret(DEVICE_KEY_SERVICE, deviceKeyAccount(REPLICA_A));
    assert.ok(serverPrivateKey !== null);
    const privateKeyBody = serverPrivateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
    assert.ok(privateKeyBody.length > 0);
    const clientPrivateBody = client.privateKeyPem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");

    for (const [name, text] of [
      ["pairing/codes response", pendingJson],
      ["pairing/claim response", claimJson],
      ["devices response", devicesJson],
      ["events response", eventsJson],
    ] as const) {
      assert.ok(!text.includes("PRIVATE KEY"), `${name} 不得含私钥 PEM 头`);
      assert.ok(!text.includes(privateKeyBody), `${name} 不得含服务端私钥正文`);
      assert.ok(!text.includes(clientPrivateBody), `${name} 不得含客户端私钥正文`);
      assert.ok(!text.includes("token_hash"), `${name} 不得暴露 token 摘要字段`);
    }
    // token 明文只允许出现在 claim 响应一次
    assert.ok(claimJson.includes(claimed.token));
    assert.ok(!pendingJson.includes(claimed.token));
    assert.ok(!devicesJson.includes(claimed.token));
    assert.ok(!eventsJson.includes(claimed.token));

    // 落盘扫描：dataDir 文本 + SQLite（含 WAL）不得出现私钥 PEM / 私钥正文 / token 明文
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue; // 目录/不可读文件跳过
      }
      const text = bytes.toString("latin1");
      assert.ok(!text.includes("PRIVATE KEY"), `${name} 不得含私钥 PEM 头`);
      assert.ok(!text.includes(privateKeyBody), `${name} 不得含服务端私钥正文`);
      assert.ok(!text.includes(claimed.token), `${name} 不得含 token 明文`);
    }

    // 服务端保存的是摘要而非明文（反证：用明文令牌可认证回同一设备）
    const auth = runtime.pairing.authenticate(claimed.token);
    assert.ok("device" in auth);
    assert.equal(auth.device.replica_id, CLIENT_REPLICA);
  } finally {
    await runtime.close();
    removeDir(dir);
  }
});
