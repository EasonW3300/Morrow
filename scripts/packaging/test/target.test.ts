/** 编译目标命名（ seam：build.ts 与探针脚本共用的纯函数；x64-baseline 是 NOTES-bun §2 的坑位） */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { binaryFileName, COMPILE_FLAGS, compileCommand, compileTarget } from "../src/target.ts";

describe("compileCommand", () => {
  it("首个子命令必须是 build（回归：漏掉 build 会把 entry 当脚本执行成常驻服务）", () => {
    const { command, args } = compileCommand("bun", "darwin", "arm64", "/e/entry.ts", "/d/morrow-runtime");
    assert.equal(command, "bun");
    assert.equal(args[0], "build");
    assert.ok(args.includes("--compile"));
    assert.ok(args.includes("--no-compile-autoload-bunfig"));
    assert.ok(args.includes("--no-compile-autoload-dotenv"));
    assert.ok(args.includes("--target=bun-darwin-arm64"));
    assert.ok(args.includes("/e/entry.ts"));
    const outfileIndex = args.indexOf("--outfile");
    assert.equal(args[outfileIndex + 1], "/d/morrow-runtime");
  });
});

describe("COMPILE_FLAGS", () => {
  it("包含 --compile 与禁用 bunfig/.env 自动加载的旗标（NOTES-bun §2 坑位）", () => {
    assert.ok(COMPILE_FLAGS.includes("--compile"));
    assert.ok(COMPILE_FLAGS.includes("--no-compile-autoload-bunfig"));
    assert.ok(COMPILE_FLAGS.includes("--no-compile-autoload-dotenv"));
  });
});

describe("compileTarget", () => {
  it("arm64 目标无 baseline 后缀", () => {
    assert.equal(compileTarget("darwin", "arm64"), "bun-darwin-arm64");
    assert.equal(compileTarget("linux", "arm64"), "bun-linux-arm64");
  });

  it("x64 目标一律 -baseline（SSE2 兼容基线，对齐 pi build-binaries.sh）", () => {
    assert.equal(compileTarget("darwin", "x64"), "bun-darwin-x64-baseline");
    assert.equal(compileTarget("linux", "x64"), "bun-linux-x64-baseline");
    assert.equal(compileTarget("win32", "x64"), "bun-windows-x64-baseline");
  });

  it("win32 映射为 bun-windows", () => {
    assert.equal(compileTarget("win32", "arm64"), "bun-windows-arm64");
  });

  it("不支持的平台/架构抛错（宁可失败不静默产出错目标）", () => {
    assert.throws(() => compileTarget("sunos", "x64"), /unsupported platform/);
    assert.throws(() => compileTarget("darwin", "ppc64"), /unsupported architecture/);
  });
});

describe("binaryFileName", () => {
  it("posix 平台无扩展名", () => {
    assert.equal(binaryFileName("darwin", "arm64"), "morrow-runtime-darwin-arm64");
    assert.equal(binaryFileName("linux", "x64"), "morrow-runtime-linux-x64");
  });

  it("win32 带 .exe", () => {
    assert.equal(binaryFileName("win32", "x64"), "morrow-runtime-win32-x64.exe");
  });
});
