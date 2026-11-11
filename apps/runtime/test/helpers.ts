// 共享测试夹具：合法信封工厂（hash 由 protocol 真实计算）与临时目录。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeIntegrityHash, type EventEnvelope } from "@morrow/protocol";

export function tmpDir(prefix = "morrow-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** fetch 响应的类型化 JSON 读取（node 的 res.json() 返回 unknown） */
export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export const REPLICA_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
export const REPLICA_B = "9a3f6c1e-4b2d-4c8a-8f1e-2a7b3c4d5e6f";

let seq = 0;
export function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  seq += 1;
  const envelope: EventEnvelope = {
    event_id: `01936b9d-8f7a-7abc-9f2e-${String(seq).padStart(12, "0")}`,
    replica_id: REPLICA_A,
    actor_id: "agent:runtime",
    event_type: "runtime.started",
    occurred_at: "2026-10-29T12:00:00.000Z",
    schema_version: 1,
    payload: {},
    integrity_hash: "",
    ...overrides,
  };
  envelope.integrity_hash = computeIntegrityHash(envelope);
  return envelope;
}
