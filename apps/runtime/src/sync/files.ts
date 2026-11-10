import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { buildEventEnvelope } from "../envelope.ts";
import type { EventLedger } from "../ledger.ts";
import { SYNC_EVENT_TYPES } from "./engine.ts";

/**
 * 文件竞争合并（票 M3-T3 / Issue #32；PRD §4.2 FR-DEP-5「文件竞争保留双版本并提示，
 * 不承诺任意二进制自动合并」）。
 *
 * 附件 / 记忆投影文件走「整文件按内容寻址」语义：本地已有同名文件且字节不同 →
 * **两份都保留**——本地原文件原地不动，来件写为 `<name>.conflict-<replica-short>`，
 * 并落 sync.file_conflict 审计事件提示 Owner。绝不删除任何一份，也不尝试二进制合并。
 *
 * 幂等：来件与现有文件字节相同 → unchanged；同名竞争文件已存在且字节相同 → 复用。
 * 路径边界：只接受 dataDir（或调用方显式 baseDir）内的相对路径；`..`/绝对路径拒绝。
 */

export interface FileMergeResult {
  status: "written" | "unchanged" | "conflict";
  /** 相对 baseDir 的目标路径 */
  path: string;
  /** status=conflict：保留来件的相对路径 */
  conflict_path?: string;
  /** status=written/conflict：实际写入字节数 */
  bytes: number;
  /** 本地保留版本的 sha256（status=conflict） */
  existing_sha256?: string;
  /** 来件的 sha256 */
  incoming_sha256?: string;
  /** 保留来件所用的副本短标识（status=conflict） */
  replica_short?: string;
}

export interface SyncFileMergerOptions {
  /** 数据目录（默认 baseDir = dataDir；可经 receive 的 baseDir 覆盖） */
  dataDir: string;
  ledger: EventLedger;
  /** 本副本 id（来件未标注来源时作为竞争副本标识） */
  replicaId: string;
}

export class SyncFileMerger {
  readonly #dataDir: string;
  readonly #ledger: EventLedger;
  readonly #replicaId: string;

  constructor(options: SyncFileMergerOptions) {
    this.#dataDir = options.dataDir;
    this.#ledger = options.ledger;
    this.#replicaId = options.replicaId;
  }

  /**
   * 接收一个文件（来自同步对端或本地导入）：
   *   - 目标不存在 → 写入，status=written；
   *   - 字节相同 → status=unchanged；
   *   - 字节不同 → 目标不动，来件写 `<name>.conflict-<replica-short>`，status=conflict
   *     并落 sync.file_conflict。
   */
  receive(
    relativePath: string,
    content: string | Uint8Array,
    options: { sourceReplicaId?: string; baseDir?: string } = {},
  ): FileMergeResult {
    const baseDir = options.baseDir ?? this.#dataDir;
    const safeRelative = normalizeRelative(relativePath);
    const target = join(baseDir, safeRelative);
    assertInside(baseDir, target);
    mkdirSync(dirname(target), { recursive: true });
    const incoming = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const incomingHash = sha256(incoming);

    if (!existsSync(target)) {
      writeFileSync(target, incoming);
      return { status: "written", path: safeRelative, bytes: incoming.byteLength, incoming_sha256: incomingHash };
    }
    const existing = readFileSync(target);
    if (existing.equals(incoming)) {
      return { status: "unchanged", path: safeRelative, bytes: incoming.byteLength, incoming_sha256: incomingHash };
    }

    const sourceReplicaId = options.sourceReplicaId ?? this.#replicaId;
    const short = replicaShort(sourceReplicaId);
    const conflictRelative = conflictPathFor(baseDir, safeRelative, short);
    const conflictAbsolute = join(baseDir, conflictRelative);
    assertInside(baseDir, conflictAbsolute);
    writeFileSync(conflictAbsolute, incoming);
    const existingHash = sha256(existing);
    this.#ledger.append(
      buildEventEnvelope({
        replicaId: this.#replicaId,
        actorId: "agent:runtime",
        eventType: SYNC_EVENT_TYPES.fileConflict,
        payload: {
          relative_path: safeRelative,
          conflict_path: conflictRelative,
          source_replica_id: sourceReplicaId,
          replica_short: short,
          existing_sha256: existingHash,
          incoming_sha256: incomingHash,
          existing_bytes: existing.byteLength,
          incoming_bytes: incoming.byteLength,
        },
      }),
    );
    return {
      status: "conflict",
      path: safeRelative,
      conflict_path: conflictRelative,
      bytes: incoming.byteLength,
      existing_sha256: existingHash,
      incoming_sha256: incomingHash,
      replica_short: short,
    };
  }
}

/** 相对路径规范化：拒绝绝对路径、空路径与 `..` 越界段；统一为 `/` 分隔 */
export function normalizeRelative(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new Error("file path must be a non-empty relative path");
  }
  if (isAbsolute(relativePath)) throw new Error(`absolute path is not allowed: ${relativePath}`);
  const normalized = relativePath.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  if (normalized.length === 0) throw new Error(`invalid file path: ${relativePath}`);
  if (normalized.some((part) => part === "..")) throw new Error(`path traversal is not allowed: ${relativePath}`);
  return normalized.join("/");
}

function assertInside(baseDir: string, target: string): void {
  const base = resolve(baseDir) + sep;
  const resolved = resolve(target);
  if (!(resolved + sep).startsWith(base) && resolved !== resolve(baseDir)) {
    throw new Error(`file path escapes base directory: ${target}`);
  }
}

function replicateSuffixStem(name: string, suffix: string, index: number): string {
  const extra = index > 0 ? `-${index + 1}` : "";
  const slash = name.lastIndexOf("/");
  const dir = slash === -1 ? "" : name.slice(0, slash + 1);
  const file = slash === -1 ? name : name.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  return `${dir}${stem}.conflict-${suffix}${extra}${ext}`;
}

function conflictPathFor(baseDir: string, relativePath: string, short: string): string {
  for (let index = 0; index < 1000; index++) {
    const candidate = replicateSuffixStem(relativePath, short, index);
    const absolute = join(baseDir, candidate);
    assertInside(baseDir, absolute);
    if (!existsSync(absolute)) return candidate;
  }
  throw new Error(`cannot allocate conflict path for ${relativePath}`);
}

/** 副本短标识：uuid 去连字符取前 8 位（与文件名可移植性一致） */
export function replicaShort(replicaId: string): string {
  const compact = replicaId.replace(/-/g, "");
  return (compact.length > 0 ? compact : replicaId).slice(0, 8);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 供外部确认路径是否落在 baseDir 内（附件传输入口的防御性检查） */
export function isInsideBase(baseDir: string, relativePath: string): boolean {
  try {
    assertInside(baseDir, join(baseDir, normalizeRelative(relativePath)));
    return true;
  } catch {
    return false;
  }
}
