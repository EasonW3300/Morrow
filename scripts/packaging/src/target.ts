/**
 * 编译目标与二进制产物命名（T8 / Issue #9）。
 *
 * 目标命名对齐 pi-mono 的 build-binaries.sh（morrow-research/NOTES-bun.md §2）：
 * - 平台矩阵 darwin/linux/windows × arm64/x64；
 * - x64 一律带 `-baseline` 后缀（SSE2 兼容基线，老 CPU 可跑）；
 * - arm64 无后缀。
 *
 * 文件命名用 process.platform 原值（darwin/linux/win32），windows 产物带 .exe。
 */

const BUN_PLATFORM: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

const SUPPORTED_ARCH = new Set(["arm64", "x64"]);

/**
 * bun build --compile 固定旗标（morrow-research/NOTES-bun.md §2）：
 * - `--no-compile-autoload-bunfig` / `--no-compile-autoload-dotenv`：禁用宿主目录的
 *   bunfig.toml / .env 自动加载（sidecar 场景下宿主 cwd 不可信，避免 preload 与环境泄漏，
 *   pi issue #7684、#10473）；
 * - `--target` 由 compileTarget 按平台给出。
 */
export const COMPILE_FLAGS: readonly string[] = [
  "--compile",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-dotenv",
];

/** bun build --compile 的 --target 值；不支持的平台/架构组合抛错 */
export function compileTarget(platform: string, arch: string): string {
  const bunPlatform = BUN_PLATFORM[platform];
  if (bunPlatform === undefined) {
    throw new Error(`unsupported platform for bun compile: ${platform}`);
  }
  if (!SUPPORTED_ARCH.has(arch)) {
    throw new Error(`unsupported architecture for bun compile: ${arch}`);
  }
  const baseline = arch === "x64" ? "-baseline" : "";
  return `bun-${bunPlatform}-${arch}${baseline}`;
}

/** 产物文件名（无目录）；win32 带 .exe */
export function binaryFileName(platform: string, arch: string): string {
  const ext = platform === "win32" ? ".exe" : "";
  return `morrow-runtime-${platform}-${arch}${ext}`;
}

/** 组装 bun build --compile 命令行（纯函数，单测锁定：首个子命令必须是 build） */
export function compileCommand(
  bunPath: string,
  platform: string,
  arch: string,
  entry: string,
  outfile: string,
): { command: string; args: string[] } {
  return {
    command: bunPath,
    args: [
      "build",
      ...COMPILE_FLAGS,
      `--target=${compileTarget(platform, arch)}`,
      entry,
      "--outfile",
      outfile,
    ],
  };
}
