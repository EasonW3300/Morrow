/**
 * bun 启动器（T9 / Issue #10 交付 1）：package.json 脚本层显式解析 bun 再转发。
 *
 * 问题（merger 发现）：pnpm 的脚本 shell 只认 PATH，本机 bun 由官方 installer 装在
 * `~/.bun/bin/bun`（ADR-0006，不写 shell 配置）→ `bun run …` 直接 spawn ENOENT。
 *
 * 用法（脚本内经 node 调起，node 必在 PATH）：
 *   node --experimental-strip-types src/with-bun.ts <bun args...>
 *   例：package.json "binary": "node --experimental-strip-types src/with-bun.ts run src/build.ts"
 *
 * 退出码：bun 未找到 → 1（附安装指引）；转发 bun 的退出码。
 */
import { spawnSync } from "node:child_process";
import { resolveBunOnThisMachine } from "./bun-path.ts";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("[with-bun] usage: node --experimental-strip-types src/with-bun.ts <bun args...>");
  process.exit(2);
}

const bun = resolveBunOnThisMachine();
if (bun === null) {
  console.error("[with-bun] bun not found (PATH and ~/.bun/bin/bun). install it first:");
  console.error('  curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"   # → ~/.bun, 无系统配置');
  process.exit(1);
}

const result = spawnSync(bun, args, { stdio: "inherit" });
if (result.error !== undefined) {
  console.error(`[with-bun] failed to spawn bun (${bun}): ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
