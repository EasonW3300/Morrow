// Go Worker 真实测试（票 M2-T2 / Issue #23：Go 工具经同一注册 + 调用接口走通）。
// 本机有 go → build.sh 真编译真跑；无 go 且无预构建产物 → skip（注明理由）。
// 期望值是独立字面量（"hello world\nmorrow sandbox\n" = 27 字节 / 2 行 / 4 词），不重算。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runGoWorker } from "../src/sandbox/go-worker.ts";
import { ToolInvoker } from "../src/sandbox/invoker.ts";
import { createLocalPermissionEngine } from "../src/sandbox/permission.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKERS_ROOT = fileURLToPath(new URL("../../../workers/go/", import.meta.url));
const BIN = join(WORKERS_ROOT, "bin", process.platform === "win32" ? "textstats.exe" : "textstats");
const BUILD_SH = join(WORKERS_ROOT, "build.sh");

let built = false;
let buildNote = "";
if (!existsSync(BIN)) {
  built = await new Promise<boolean>((resolve) => {
    execFile("/bin/bash", [BUILD_SH], (err, stdout) => {
      if (err) {
        buildNote = `无预构建产物且构建失败（go 未安装或脚本不可执行）：${String(err).slice(0, 200)}`;
        resolve(false);
        return;
      }
      buildNote = stdout.trim();
      resolve(true);
    });
  });
} else {
  built = true;
}

const SKIP = built ? false : `Go Worker 跳过：${buildNote}`;

describe("Go Worker（textstats，真实编译产物）", { skip: SKIP }, () => {
  it("stdio JSON 协议：count 模式 → 行/词/字节（独立字面量 27/2/4）", async () => {
    const r = await runGoWorker({ binPath: BIN, input: { mode: "count", text: "hello world\nmorrow sandbox\n" } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { lines: 2, words: 4, bytes: 27 });
    assert.equal(r.exit_code, 0);
    assert.equal(r.via, "builtin-go");
  });

  it("normalize 模式：折叠空白 + 小写", async () => {
    const r = await runGoWorker({ binPath: BIN, input: { mode: "normalize", text: "  Morrow   SANDBOX\tTool\n" } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { text: "morrow sandbox tool" });
  });

  it("工具自报错误：未知 mode → ok=false + tool_error + 非零退出码", async () => {
    const r = await runGoWorker({ binPath: BIN, input: { mode: "nope", text: "x" } });
    assert.equal(r.ok, false);
    assert.equal(r.error_code, "tool_error");
    assert.equal(r.exit_code, 1);
    assert.match(r.error ?? "", /unknown mode/);
  });

  it("同一注册 + 调用接缝：manifest{author=human, runtime=go, sandbox=builtin} 经 ToolInvoker 走通", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "morrow-go-ws-"));
    const invoker = new ToolInvoker({
      runner: {
        async run() {
          throw new Error("sandboxed runner must not be called for builtin tools");
        },
      },
      permissionEngine: createLocalPermissionEngine({ workspaceRoot: workspace }),
      workspaceRoot: workspace,
    });
    invoker.register({
      manifest: {
        name: "textstats",
        version: "1.0.0",
        author: "human",
        runtime: "go",
        permissions: {},
        sandbox: { type: "builtin" },
      },
      package: { name: "textstats", kind: "go", binPath: BIN },
    });
    assert.deepEqual(invoker.listTools(), [{ name: "textstats", version: "1.0.0", author: "human", runtime: "go", sandboxType: "builtin" }]);
    const out = await invoker.invoke("textstats", { mode: "count", text: "hello world\nmorrow sandbox\n" }, { actorId: "owner" });
    assert.equal(out.ok, true);
    assert.equal(out.via, "builtin-go");
    assert.deepEqual(out.result, { lines: 2, words: 4, bytes: 27 });
  });

  it("构建产物可执行位存在（build.sh 交付物契约）", () => {
    accessSync(BIN, constants.X_OK);
  });
});
