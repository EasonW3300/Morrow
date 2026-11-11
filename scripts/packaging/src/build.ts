/**
 * 单二进制构建脚本（T8 / Issue #9，ADR-0003）：可重复执行的 bun compile 包装。
 *
 * 用法：`bun run src/build.ts`（或根目录 `pnpm pack:runtime`）。
 * 产物：scripts/packaging/dist/<binaryFileName（当前平台）>（gitignored）。
 *
 * 坑位来源（morrow-research/NOTES-bun.md §2，对齐 pi-mono/scripts/build-binaries.sh）：
 * - x64 目标一律 -baseline；
 * - --no-compile-autoload-bunfig / --no-compile-autoload-dotenv（宿主 cwd 不可信）；
 * - 当前 Runtime 无 new Worker，无需额外 worker entrypoint；将来引入 worker 时
 *   必须把 worker 文件与主入口一起列为 entrypoint（bun 按公共路径前缀摆放）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBunOnThisMachine } from "./bun-path.ts";
import { binaryFileName, compileCommand, compileTarget } from "./target.ts";

const entryPath = fileURLToPath(new URL("./entry.ts", import.meta.url));
const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

/** 组装 bun build --compile 命令行（见 target.ts；单测锁定首个子命令必须是 build） */

function main(): void {
  const platform = process.platform;
  const arch = process.arch;
  const outfile = join(distDir, binaryFileName(platform, arch));

  // 定位 bun：PATH → 用户级安装位（共享 resolver，见 bun-path.ts；与 with-bun.ts 同口径）
  const bun = resolveBunOnThisMachine();
  if (bun === null) {
    console.error("[pack] bun not found (PATH and ~/.bun/bin/bun). install it first:");
    console.error("  curl -fsSL https://bun.sh/install | bash -s \"bun-v1.4.4\"   # → ~/.bun, 无系统配置");
    process.exit(1);
  }
  const bunVersion = spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout?.trim();
  console.log(`[pack] bun=${bun} (v${bunVersion ?? "?"})`);

  mkdirSync(distDir, { recursive: true });
  const { command, args } = compileCommand(bun, platform, arch, entryPath, outfile);
  console.log(`[pack] target=${compileTarget(platform, arch)}`);
  console.log(`[pack] entry=${entryPath}`);
  console.log(`[pack] outfile=${outfile}`);
  console.log(`[pack] cmd=${command} ${args.join(" ")}`);

  const result = spawnSync(command, args, {
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    console.error(`[pack] failed to spawn bun (${bun}): ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[pack] bun build failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
  if (!existsSync(outfile)) {
    console.error(`[pack] bun build reported success but outfile is missing: ${outfile}`);
    process.exit(1);
  }
  const sizeMb = (statSync(outfile).size / (1024 * 1024)).toFixed(1);
  console.log(`[pack] done: ${outfile} (${sizeMb} MB)`);
}

main();
