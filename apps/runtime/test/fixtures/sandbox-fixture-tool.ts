/**
 * 沙箱测试夹具工具（真实容器测试用；FakePi/零网络——本工具只在容器内跑）。
 * stdin: {"mode": "...", ...}；stdout: 单行 JSON 信封（protocol.ts 契约）。
 * 覆盖网络探针 / 文件读写 / 睡眠 / 大内存分配 / 退出码，供 sandbox.docker.test.ts 断言
 * network none、workspace 越界、超时强杀、资源限额、结构化回传。
 */

import { readFile, writeFile } from "node:fs/promises";

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Input {
  mode?: string;
  text?: unknown;
  path?: string;
  content?: string;
  ms?: number;
  mb?: number;
}

const raw = await readStdin();
let input: Input;
try {
  input = JSON.parse(raw) as Input;
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: "malformed stdin JSON" }) + "\n");
  process.exit(1);
}

function done(result: unknown): never {
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  process.exit(0);
}
function fail(error: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error }) + "\n");
  process.exit(1);
}

switch (input.mode) {
  case "echo":
    done({ echo: input.text ?? null });
    break;
  case "network-probe": {
    // 网络探针：network none 下任何出网尝试都必须失败。.invalid TLD + 显式超时双保险。
    try {
      const res = await fetch("http://morrow-sandbox-network-probe.invalid/", { signal: AbortSignal.timeout(2500) });
      // 到这里说明出网成功——这本身是失败结论
      fail(`network unexpectedly reachable: status ${res.status}`);
    } catch (err) {
      done({ networkBlocked: true, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
    break;
  }
  case "read-file":
    try {
      const content = await readFile(input.path ?? "", "utf8");
      done({ content });
    } catch (err) {
      fail(`read failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    break;
  case "write-file":
    try {
      await writeFile(input.path ?? "", input.content ?? "");
      done({ written: true, bytes: (input.content ?? "").length });
    } catch (err) {
      fail(`write failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    break;
  case "sleep":
    await sleep(input.ms ?? 0);
    done({ slept: input.ms ?? 0 });
    break;
  case "alloc": {
    const mb = Math.max(1, input.mb ?? 1);
    const buf = Buffer.alloc(mb * 1024 * 1024);
    buf.fill(1); // 触碰每一页，确保 RSS 实涨（触发 cgroup OOM）
    done({ allocatedMb: mb, checksum: buf[0] + buf[buf.length - 1] });
    break;
  }
  case "fail":
    process.stderr.write("fixture: intentional failure\n");
    process.exit(3);
    break;
  default:
    fail(`unknown mode: ${String(input.mode)}`);
}
