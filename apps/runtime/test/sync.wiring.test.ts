// 同步启动接线（M3 同步接线修复 / Issue #34）：
//   - 独立进程（main.ts）启动后 POST /v1/sync/run 真的同步（不再 ok=false / 无 transport）；
//   - HttpSyncTransport/DeviceSyncTransport 全请求带 Bearer token，缺失/失效可诊断；
//   - 设备撤销后传输不再尝试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { EventEnvelope, SyncRunReport, SyncStatus } from "@morrow/protocol";
import { DeviceRegistry } from "../src/devices.ts";
import { createInMemorySecretStore } from "../src/keyring.ts";
import { DEVICE_KEY_SERVICE, deviceTokenAccount, generateDeviceKeyPair, hashToken } from "../src/pairing/crypto.ts";
import { DeviceSyncTransport } from "../src/sync/device-transport.ts";
import { SyncError } from "../src/sync/errors.ts";
import { removeDir, tmpDir } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const NODE_FLAGS = ["--experimental-sqlite", "--experimental-strip-types"];

interface ReadyLine {
  ready: boolean;
  port: number;
  pid: number;
  replica_id: string;
}

interface RuntimeProcess {
  child: ChildProcess;
  ready: Promise<ReadyLine>;
  stop(): Promise<number | null>;
}

/** 独立进程启动（与生产同一条 main.ts）；MORROW_SECRET_BACKEND=memory 使 token 留在进程内 */
function startProcess(t: { after(fn: () => unknown): void }, dataDir: string): RuntimeProcess {
  const child = spawn(process.execPath, [...NODE_FLAGS, MAIN], {
    env: {
      ...process.env,
      MORROW_DATA_DIR: dataDir,
      MORROW_PORT: "0",
      MORROW_SECRET_BACKEND: "memory",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const ready = new Promise<ReadyLine>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as ReadyLine;
          if (parsed.ready === true) resolve(parsed);
        } catch {
          // 忽略非 JSON 输出
        }
      }
    });
    child.once("exit", (code) => reject(new Error(`runtime exited before ready (code ${code})`)));
    child.once("error", reject);
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  return {
    child,
    ready,
    stop() {
      return new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.kill("SIGTERM");
      });
    },
  };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function post<T>(base: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function pair(joinerBase: string, targetBase: string): Promise<void> {
  const codeRes = await post<{ code: string }>(targetBase, "/v1/pairing/codes", {});
  assert.equal(codeRes.status, 201);
  const { code } = await json<{ code: string }>(codeRes);
  const joinRes = await post(joinerBase, "/v1/pairing/join", { base_url: targetBase, code, device_label: "joiner" });
  assert.equal(joinRes.status, 200);
}

test("独立 main.ts 进程：配对后 /v1/sync/run 真实双向同步（ok=1，非 no-transport 空转）", { timeout: 60000 }, async (t) => {
  const dirA = tmpDir("morrow-wire-proc-a-");
  const dirB = tmpDir("morrow-wire-proc-b-");
  t.after(() => {
    removeDir(dirA);
    removeDir(dirB);
  });
  const a = startProcess(t, dirA);
  const b = startProcess(t, dirB);
  const readyA = await a.ready;
  const readyB = await b.ready;
  const baseA = `http://127.0.0.1:${readyA.port}`;
  const baseB = `http://127.0.0.1:${readyB.port}`;

  await pair(baseB, baseA);

  // 两端各写一条离线业务事件，再各自从本机入口触发同步
  assert.equal((await post(baseA, "/v1/sessions", { title: "from-a" })).status, 201);
  assert.equal((await post(baseB, "/v1/sessions", { title: "from-b" })).status, 201);

  const bRun = await post<SyncRunReport>(baseB, "/v1/sync/run", {});
  assert.equal(bRun.status, 200);
  const bReport = await json<SyncRunReport>(bRun);
  assert.equal(bReport.totals.peers, 1, "B 认识已配对的 A");
  assert.equal(bReport.totals.ok, 1, "启动接线后 B 的出站同步真实可用");
  assert.equal(bReport.totals.failed, 0);
  assert.deepEqual(bReport.peers[0]?.errors, []);
  assert.ok(bReport.totals.pulled >= 1, "B 从 A 拉到离线事件");
  assert.ok(bReport.totals.pushed >= 1, "B 把本机事件推给 A");

  // A 的反向出站也可用：B 的 claim 携带了 device_base_url，A 的设备行有地址
  const aRun = await post<SyncRunReport>(baseA, "/v1/sync/run", {});
  assert.equal(aRun.status, 200);
  const aReport = await json<SyncRunReport>(aRun);
  assert.equal(aReport.totals.peers, 1);
  assert.equal(aReport.totals.ok, 1, "A 也能按 devices.base_url 出站");
  assert.equal(aReport.totals.failed, 0);

  const aEvents = await json<{ events: EventEnvelope[] }>(await fetch(`${baseA}/v1/events?limit=200`));
  const bEvents = await json<{ events: EventEnvelope[] }>(await fetch(`${baseB}/v1/events?limit=200`));
  for (const base of [aEvents.events, bEvents.events]) {
    assert.ok(base.some((event) => event.event_type === "session.created" && event.replica_id === readyA.replica_id));
    assert.ok(base.some((event) => event.event_type === "session.created" && event.replica_id === readyB.replica_id));
  }

  const status = await json<SyncStatus>(await fetch(`${baseB}/v1/sync/status`));
  assert.equal(status.peers[0]?.unreachable, false);
  assert.equal(status.peers[0]?.unreachable_reason, null);

  assert.equal(await b.stop(), 0);
  assert.equal(await a.stop(), 0);
});

// --- token 透传 / 缺失可诊断（对端强制校验）-----------------------------------

interface AuthServer {
  server: Server;
  base: string;
  requests: Array<{ path: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

async function startAuthServer(requiredToken: string): Promise<AuthServer> {
  const requests: AuthServer["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${requiredToken}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_token", message: "device token is not valid" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ replica_id: "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f", sequence: { min: 1, max: 7, count: 7 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("token 透传：DeviceSyncTransport 从 SecretStore 读 token 并带 Authorization；缺失/失效 → 401 可诊断", async () => {
  const dir = tmpDir("morrow-wire-auth-");
  const peerId = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
  const required = "mrw_fixture_token";
  const peer = await startAuthServer(required);
  const devices = DeviceRegistry.open(dir);
  const secrets = createInMemorySecretStore();
  try {
    const keys = generateDeviceKeyPair();
    devices.markPaired({
      replicaId: peerId,
      label: "auth-peer",
      publicKey: keys.publicKey,
      fingerprint: keys.fingerprint,
      tokenHash: hashToken(required),
      baseUrl: peer.base,
      now: new Date(),
    });
    const transport = new DeviceSyncTransport({
      selfReplicaId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      devices,
      secretStore: secrets,
    });

    // 有 token：请求头带 Bearer，对端放行
    await secrets.setSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(peerId), required);
    const probe = await transport.status(peerId);
    assert.equal(probe.max_sequence, 7);
    assert.equal(peer.requests.at(-1)?.authorization, `Bearer ${required}`);

    // 缺 token：不注入 Authorization，对端 401 → details 明确 auth=none / reason=missing_token
    await secrets.deleteSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(peerId));
    transport.invalidate(peerId);
    await assert.rejects(
      () => transport.status(peerId),
      (err: unknown) => {
        assert.ok(err instanceof SyncError);
        // 对端错误码原样透传（比统一折叠成 transport_unavailable 更可诊断）
        assert.equal(err.code, "invalid_token");
        assert.equal(err.details?.status, 401);
        assert.equal(err.details?.auth, "none");
        assert.equal(err.details?.reason, "missing_token");
        return true;
      },
    );
    assert.equal(peer.requests.at(-1)?.authorization, undefined, "无 token 时不伪造 Authorization");

    // token 失效：Bearer 已带但被拒 → 错误保留 auth=bearer 与 401
    await secrets.setSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(peerId), "mrw_wrong");
    transport.invalidate(peerId);
    await assert.rejects(
      () => transport.status(peerId),
      (err: unknown) => {
        assert.ok(err instanceof SyncError);
        assert.equal(err.details?.status, 401);
        assert.equal(err.details?.auth, "bearer");
        return true;
      },
    );
  } finally {
    devices.close();
    await peer.close();
    removeDir(dir);
  }
});

test("设备撤销后 DeviceSyncTransport 不再发请求（device_revoked）", async () => {
  const dir = tmpDir("morrow-wire-revoke-");
  const peerId = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";
  const peer = await startAuthServer("mrw_fixture_token");
  const devices = DeviceRegistry.open(dir);
  const secrets = createInMemorySecretStore();
  try {
    const keys = generateDeviceKeyPair();
    devices.markPaired({
      replicaId: peerId,
      label: "to-revoke",
      publicKey: keys.publicKey,
      fingerprint: keys.fingerprint,
      tokenHash: hashToken("mrw_fixture_token"),
      baseUrl: peer.base,
      now: new Date(),
    });
    await secrets.setSecret(DEVICE_KEY_SERVICE, deviceTokenAccount(peerId), "mrw_fixture_token");
    const transport = new DeviceSyncTransport({
      selfReplicaId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      devices,
      secretStore: secrets,
    });
    await transport.status(peerId);
    const before = peer.requests.length;
    assert.equal(before, 1);

    devices.revoke(peerId);
    transport.invalidate(peerId);
    await assert.rejects(
      () => transport.status(peerId),
      (err: unknown) => err instanceof SyncError && err.details?.reason === "device_revoked",
    );
    assert.equal(peer.requests.length, before, "撤销后不再尝试任何请求");
  } finally {
    devices.close();
    await peer.close();
    removeDir(dir);
  }
});
