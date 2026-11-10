import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  type KeyObject,
} from "node:crypto";

/**
 * 设备身份密码学（M3-T2 / Issue #31，FR-DEP-2）。
 *
 * - 设备密钥对：ed25519（node:crypto，零第三方依赖）。私钥以 PKCS#8 PEM 存 OS 凭据库
 *   （service `com.morrow.device` + account = replica_id）；公钥只以 raw 32 字节
 *   base64 形式落 devices 表与 API 响应。
 * - 指纹 = SHA-256(raw public key) 前 16 hex（小写 32 字符）；短格式按 4 位分组大写，
 *   供双端人工核对（如 `AB12-CD34-EF56-7890`）。
 * - 请求鉴权（ADR-0008）用 bearer token：256 位随机、前缀 `mrw_`；服务端只存
 *   SHA-256 哈希，明文只在 claim 响应出现一次并应存客户端 OS 凭据库。
 *
 * 本模块不 import 任何 runtime 内部模块（devices/service 反向依赖它），保持无环。
 */

/** OS 凭据库 service 名（ADR-0002：密钥只进 OS 凭据库） */
export const DEVICE_KEY_SERVICE = "com.morrow.device";

/** 设备私钥在凭据库的 account（票面约定：service + replica_id） */
export function deviceKeyAccount(replicaId: string): string {
  return replicaId;
}

/** bearer token 在凭据库的 account（与服务端 replica_id 绑定） */
export function deviceTokenAccount(peerReplicaId: string): string {
  return `token:${peerReplicaId}`;
}

export interface DeviceKeyPair {
  /** PKCS#8 PEM（仅可写 OS 凭据库，绝不可落配置文件/日志/API） */
  privateKeyPem: string;
  /** raw ed25519 public key 32 bytes 的 base64 */
  publicKey: string;
  /** 公钥 SHA-256 前 16 hex */
  fingerprint: string;
}

/** SPKI DER 头（ed25519）：12 字节前缀 + 32 字节 raw key */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** 生成 ed25519 设备密钥对（不落盘；调用方决定私钥去向） */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicRaw = rawPublicKey(publicKey);
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicRaw.toString("base64"),
    fingerprint: fingerprintOfRaw(publicRaw),
  };
}

/** 从已存私钥恢复公钥（凭据库有私钥、devices 表丢公钥时的自愈路径） */
export function derivePublicKey(privateKeyPem: string): { publicKey: string; fingerprint: string } {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
  const raw = rawPublicKey(publicKey);
  return { publicKey: raw.toString("base64"), fingerprint: fingerprintOfRaw(raw) };
}

/** 解析/校验外部提交的 raw 公钥（base64 32 bytes）；非法抛 Error */
export function parseDevicePublicKey(publicKey: string): { raw: Buffer; fingerprint: string } {
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== publicKey) {
    throw new Error("device public key must be the base64 encoding of a raw 32-byte ed25519 key");
  }
  // 结构合法性再验证一遍（防止 base64 解码出 32 字节但并非合法 ed25519 点）
  createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
  return { raw, fingerprint: fingerprintOfRaw(raw) };
}

/** 指纹：公钥 SHA-256 前 16 hex（小写） */
export function fingerprintFromPublicKey(publicKey: string): string {
  return parseDevicePublicKey(publicKey).fingerprint;
}

/** 短格式指纹：AB12-CD34-EF56-7890（大写，4 位分组） */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.toUpperCase().replace(/(.{4})(?=.)/g, "$1-");
}

/** 宽松归一化：去掉分隔符/空白并转小写（用于客户端输入比对） */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** 6 位数字配对码（保持前导零；熵约 20 bit，靠 5 分钟 TTL + 单次 + 限速兜底） */
export function generatePairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** bearer token：`mrw_` + 32 字节随机 base64url（仅在下发时出现一次） */
export function generateBearerToken(): string {
  return `mrw_${randomBytes(32).toString("base64url")}`;
}

/** 服务端落库的 token 摘要（绝不存明文） */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 配对码落库摘要（同理由明文码不落库） */
export function hashPairingCode(code: string): string {
  return createHash("sha256").update(`morrow-pairing:${code}`, "utf8").digest("hex");
}

function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

function fingerprintOfRaw(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
