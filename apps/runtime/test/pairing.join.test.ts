// 宿主侧加入设备（M3 修复批 / Issue #35，缺口来源 #35 / 归属 #31）：
// POST /v1/pairing/join 让本机 Runtime 作为新设备完成 claim，并把 token 写入本机
// OS 凭据库（内存桩）、对端公钥写入本机设备表；响应绝不含 token 明文。
// 覆盖：全流程 + token 真实性（经鉴权策略对非回环地址放行）、指纹不符回滚、
// 对端不可达、非法 base_url。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceInfo, PairingCodeResponse, PairingJoinResponse } from "@morrow/protocol";
import type { RuntimeConfig } from "../src/config.ts";
import { startRuntime, type RuntimeHandle } from "../src/runtime.ts";
import { createInMemorySecretStore, type SecretStore } from "../src/keyring.ts";
import { authorizeRequest } from "../src/pairing/auth.ts";
import {
  DEVICE_KEY_SERVICE,
  deviceTokenAccount,
  formatFingerprint,
} from "../src/pairing/crypto.ts";
import { json, removeDir, tmpDir } from "./helpers.ts";

const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

interface ApiError {
  error: { code: string; message: string };
}

interface DeviceListBody {
  devices: DeviceInfo[];
}

function testConfig(dir: string, replicaId: string): RuntimeConfig {
  return { host: "127.0.0.1", port: 0, dataDir: dir, replicaId, provider: null };
}

function url(runtime: RuntimeHandle, path: string): string {
  return `http://127.0.0.1:${runtime.port}${path}`;
}

async function boot(): Promise<{ runtime: RuntimeHandle; dir: string; secrets: SecretStore }> {
  const dir = tmpDir("morrow-pairing-join-");
  const secrets = createInMemorySecretStore();
  const runtime = await startRuntime(testConfig(dir, REPLICA_B), { secretStore: secrets });
  return { runtime, dir, secrets };
}

async function bootIssuer(): Promise<{ runtime: RuntimeHandle; dir: string; secrets: SecretStore }> {
  const dir = tmpDir("morrow-pairing-join-issuer-");
  const secrets = createInMemorySecretStore();
  const runtime = await startRuntime(testConfig(dir, REPLICA_A), { secretStore: secrets });
  return { runtime, dir, secrets };
}

async function createCode(issuer: RuntimeHandle): Promise<PairingCodeResponse> {
  const res = await fetch(url(issuer, "/v1/pairing/codes"), { method: "POST" });
  assert.equal(res.status, 201);
  return json<PairingCodeResponse>(res);
}

async function join(
  joiner: RuntimeHandle,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(url(joiner, "/v1/pairing/join"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listDevices(runtime: RuntimeHandle): Promise<DeviceInfo[]> {
  const res = await fetch(url(runtime, "/v1/devices"));
  assert.equal(res.status, 200);
  return (await json<DeviceListBody>(res)).devices;
}

test("POST /v1/pairing/join：本机作为新设备加入对端——token 进凭据库、对端公钥进设备表、响应无 token 明文", async () => {
  const issuer = await bootIssuer();
  const joiner = await boot();
  try {
    const code = await createCode(issuer.runtime);

    const res = await join(joiner.runtime, {
      base_url: url(issuer.runtime, "").replace(/\/$/, ""),
      code: code.code,
      device_label: "Joiner Laptop",
      expect_server_fingerprint: code.server.fingerprint,
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    const body = JSON.parse(raw) as PairingJoinResponse & { token?: string };
    assert.equal(body.token, undefined, "响应不得包含 token 字段");
    assert.equal(raw.includes("mrw_"), false, "响应全文不得出现 bearer token 明文");
    assert.equal(body.device.replica_id, REPLICA_A, "device 是加入后本机设备表中的对端");
    assert.equal(body.device.trusted, true);
    assert.equal(body.device.revoked, false);
    assert.equal(body.server_fingerprint, code.server.fingerprint);
    assert.equal(body.server_fingerprint_short, formatFingerprint(code.server.fingerprint));

    // token 已写入本机凭据库（account = token:<对端 replica_id>），明文只存在这里
    const token = await joiner.secrets.getSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(REPLICA_A));
    assert.ok(token !== null && token.startsWith("mrw_"), "token 必须写入本机 SecretStore");

    // token 有效性：对端鉴权策略对非回环地址必须放行，且解析为本机（joiner）身份
    const allowed = authorizeRequest(
      {
        remoteAddress: "100.64.0.7",
        method: "GET",
        pathname: "/v1/devices",
        authorization: `Bearer ${token}`,
      },
      issuer.runtime.pairing,
    );
    assert.equal(allowed.kind, "allow");
    if (allowed.kind === "allow") {
      assert.equal(allowed.device?.replica_id, REPLICA_B, "token 对应 joiner 的 replica_id");
    }
    const denied = authorizeRequest(
      { remoteAddress: "100.64.0.7", method: "GET", pathname: "/v1/devices", authorization: undefined },
      issuer.runtime.pairing,
    );
    assert.equal(denied.kind, "deny");
    assert.equal(denied.kind === "deny" ? denied.status : 0, 401);

    // 本机设备表：对端 trusted + 公钥/指纹一致；本机自己的身份也已供给
    const joinerDevices = await listDevices(joiner.runtime);
    const peerOnJoiner = joinerDevices.find((device) => device.replica_id === REPLICA_A);
    assert.ok(peerOnJoiner);
    assert.equal(peerOnJoiner.trusted, true);
    assert.equal(peerOnJoiner.public_key, code.server.public_key);
    assert.equal(peerOnJoiner.fingerprint, code.server.fingerprint);
    assert.notEqual(peerOnJoiner.paired_at, null);

    // 对端设备表：joiner trusted，公钥等于 joiner 本机供给的身份公钥
    const issuerDevices = await listDevices(issuer.runtime);
    const joinerOnIssuer = issuerDevices.find((device) => device.replica_id === REPLICA_B);
    assert.ok(joinerOnIssuer);
    assert.equal(joinerOnIssuer.trusted, true);
    assert.equal(joinerOnIssuer.revoked, false);
    assert.equal(joinerOnIssuer.label, "Joiner Laptop");
    assert.equal(joinerOnIssuer.public_key, joiner.runtime.devices.get(REPLICA_B)?.public_key);
    assert.equal(joinerOnIssuer.fingerprint, joiner.runtime.devices.get(REPLICA_B)?.fingerprint);

    // 对端落 device.paired 审计，且账本/响应均无 token 摘要以外的令牌材料
    const paired = issuer.runtime.ledger.scan({ eventType: "device.paired" });
    assert.equal(paired.length, 1);
    assert.equal(JSON.stringify(paired[0].envelope).includes("mrw_"), false);
  } finally {
    await joiner.runtime.close();
    await issuer.runtime.close();
    removeDir(joiner.dir);
    removeDir(issuer.dir);
  }
});

test("POST /v1/pairing/join 指纹不符：中止并撤销对端刚建立的信任（rollback），本地不留任何凭据", async () => {
  const issuer = await bootIssuer();
  const joiner = await boot();
  try {
    const code = await createCode(issuer.runtime);
    const wrongFingerprint = "0000000000000000";

    const res = await join(joiner.runtime, {
      base_url: `http://127.0.0.1:${issuer.runtime.port}`,
      code: code.code,
      device_label: "Joiner Laptop",
      expect_server_fingerprint: wrongFingerprint,
    });
    assert.equal(res.status, 409);
    const error = await json<ApiError>(res);
    assert.equal(error.error.code, "fingerprint_mismatch");

    // 本地：没有任何 token / 对端设备行
    assert.equal(await joiner.secrets.getSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(REPLICA_A)), null);
    assert.equal(joiner.runtime.devices.get(REPLICA_A), null);

    // 对端：claim 已发生但被回滚——设备行存在且 revoked=true（审计墓碑保留）
    const issuerDevices = await listDevices(issuer.runtime);
    const joinerOnIssuer = issuerDevices.find((device) => device.replica_id === REPLICA_B);
    assert.ok(joinerOnIssuer, "claim 曾建立设备行（可审计）");
    assert.equal(joinerOnIssuer.revoked, true, "回滚必须撤销该设备");
    assert.notEqual(joinerOnIssuer.revoked_at, null);
    const revokedAudit = issuer.runtime.ledger.scan({ eventType: "device.revoked" });
    assert.equal(revokedAudit.length, 1, "回滚走真实撤销路径并留审计");
  } finally {
    await joiner.runtime.close();
    await issuer.runtime.close();
    removeDir(joiner.dir);
    removeDir(issuer.dir);
  }
});

test("POST /v1/pairing/join 对端不可达 → 502 peer_unreachable；非法 base_url → 400", async () => {
  const joiner = await boot();
  try {
    const unreachable = await join(joiner.runtime, {
      base_url: "http://127.0.0.1:1",
      code: "123456",
    });
    assert.equal(unreachable.status, 502);
    assert.equal((await json<ApiError>(unreachable)).error.code, "peer_unreachable");

    for (const base_url of ["ftp://example.com", "not a url", "http://example.com/path?x=1"]) {
      const res = await join(joiner.runtime, { base_url, code: "123456" });
      assert.equal(res.status, 400, `${base_url} 应 400`);
      assert.equal((await json<ApiError>(res)).error.code, "invalid_base_url");
    }

    const missing = await fetch(url(joiner.runtime, "/v1/pairing/join"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await json<ApiError>(missing)).error.code, "invalid_body");
  } finally {
    await joiner.runtime.close();
    removeDir(joiner.dir);
  }
});
