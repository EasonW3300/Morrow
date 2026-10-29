/**
 * bun 可执行解析（T9 / Issue #10）：with-bun 启动器与 build.ts 共用。
 *
 * 背景（merger 发现，票 #10 交付 1）：`pnpm pack:runtime` 链条经 pnpm 的脚本 shell 执行
 * `bun run src/build.ts`，而本机 bun 由官方 installer 装在 `~/.bun/bin/bun` 且不写 shell
 * 配置（ADR-0006），shell PATH 上没有 bun → 脚本层直接 ENOENT。修复：所有经 package.json
 * 脚本触发的 bun 调用先经本模块解析（PATH 优先，回退用户级安装位）。
 *
 * CI（windows runner）：官方 installer 落点为 `%USERPROFILE%\.bun\bin\bun.exe`，
 * 故 win32 候选带 .exe 扩展名（NOTES-bun §2 / ADR-0006 的版本 pin 口径）。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** bun 用户级安装位候选（顺序即优先级）；官方 installer 默认落点 */
export function bunCandidatePaths(home: string, platform: string): string[] {
  const base = join(home, ".bun", "bin");
  return [platform === "win32" ? join(base, "bun.exe") : join(base, "bun")];
}

export interface ResolveBunDeps {
  /** 探测 PATH 上的命令是否可执行（生产：spawnSync <cmd> --version） */
  pathProbe: (command: string) => boolean;
  /** 探测文件是否存在且可执行（生产：spawnSync <path> --version） */
  fileProbe: (path: string) => boolean;
  home: string;
  platform: string;
}

/** 解析 bun：PATH → 用户级安装位；两者皆无返回 null（调用方给出安装指引） */
export function resolveBun(deps: ResolveBunDeps): string | null {
  if (deps.pathProbe("bun")) return "bun";
  for (const candidate of bunCandidatePaths(deps.home, deps.platform)) {
    if (deps.fileProbe(candidate)) return candidate;
  }
  return null;
}

/** 生产探测适配：spawnSync <cmd> --version 成功即视为可用（探测失败/ENOENT 均算不可用） */
function canRun(command: string): boolean {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/** 默认依赖的生产入口：当前用户/平台的 bun 路径，找不到返回 null */
export function resolveBunOnThisMachine(): string | null {
  return resolveBun({
    pathProbe: canRun,
    fileProbe: (path) => existsSync(path) && canRun(path),
    home: homedir(),
    platform: process.platform,
  });
}
