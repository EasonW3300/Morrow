/** bun 解析（T9 / Issue #10）：seam = with-bun 启动器与 build.ts 共用的解析函数。
 *
 * 背景（merger 发现）：pnpm 脚本经 sh 执行 `bun run …`，本机 bun 装在 ~/.bun/bin/bun
 * 且不在 shell PATH，脚本层直接失败。修复 = 脚本层显式解析：PATH → 用户级安装位。
 * 纯函数 + 注入探测，便于锁定回退顺序与 win32 扩展名。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bunCandidatePaths, resolveBun } from "../src/bun-path.ts";

describe("bunCandidatePaths", () => {
  it("非 win32：用户级安装位 ~/.bun/bin/bun（官方 installer 默认落点，ADR-0006）", () => {
    assert.deepEqual(bunCandidatePaths("/home/u", "darwin"), ["/home/u/.bun/bin/bun"]);
    assert.deepEqual(bunCandidatePaths("/home/u", "linux"), ["/home/u/.bun/bin/bun"]);
  });

  it("win32：官方 installer 落点带 .exe 扩展名", () => {
    // 断言做分隔符归一化：join 的分隔符语义随宿主平台（生产在真 win32 上是 \），
    // 契约是 <home>/.bun/bin/bun.exe 的目录结构与扩展名
    const normalized = bunCandidatePaths("C:\\Users\\u", "win32").map((p) => p.replaceAll("\\", "/"));
    assert.deepEqual(normalized, ["C:/Users/u/.bun/bin/bun.exe"]);
  });
});

describe("resolveBun", () => {
  const base = { home: "/home/u", platform: "darwin" };

  it("PATH 上有 bun：直接用（优先于用户级安装位）", () => {
    const bun = resolveBun({
      ...base,
      pathProbe: (cmd) => cmd === "bun",
      fileProbe: () => false,
    });
    assert.equal(bun, "bun");
  });

  it("PATH 没有 bun：回退 ~/.bun/bin/bun（merger 发现的 pnpm 脚本 shell 找不到 bun 的修复路径）", () => {
    const bun = resolveBun({
      ...base,
      pathProbe: () => false,
      fileProbe: (p) => p === "/home/u/.bun/bin/bun",
    });
    assert.equal(bun, "/home/u/.bun/bin/bun");
  });

  it("两者皆无：null（调用方给出安装指引并失败）", () => {
    const bun = resolveBun({ ...base, pathProbe: () => false, fileProbe: () => false });
    assert.equal(bun, null);
  });

  it("win32 回退路径带 .exe", () => {
    const bun = resolveBun({
      home: "C:\\Users\\u",
      platform: "win32",
      pathProbe: () => false,
      fileProbe: (p) => p.replaceAll("\\", "/") === "C:/Users/u/.bun/bin/bun.exe",
    });
    assert.notEqual(bun, null);
    assert.equal(bun?.replaceAll("\\", "/"), "C:/Users/u/.bun/bin/bun.exe");
  });
});
