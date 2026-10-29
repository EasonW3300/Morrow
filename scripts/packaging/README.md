# @morrow/packaging

Runtime 单二进制打包与启动探针（票 T8 / Issue #9，ADR-0003/0006）。产物是 bun compile 的
当前平台单二进制；探针以 standalone 与 sidecar 两种形态验证同一直接收口。

## 用法

```bash
pnpm pack:runtime              # bun build --compile → scripts/packaging/dist/morrow-runtime-<platform>-<arch>
pnpm probe:runtime:standalone  # standalone 探针（health + sqlite + 对话探针 → 退出码 0）
pnpm probe:runtime:sidecar     # sidecar 探针（父进程拉起 / ready 握手 / SIGTERM 优雅退出 + 同套探针）
pnpm --filter @morrow/packaging test   # 探针脚本关键函数单测（node:test）
```

两个探针脚本都接受 `--binary <path>`（缺省为当前平台 dist 产物）。bun 由本机用户级安装
（本机：官方 installer 装到 `~/.bun`，见 ADR-0006 的版本记录；CI 用 pin 版本）。

## 打包要点（morrow-research/NOTES-bun.md §2，对齐 pi-mono build-binaries.sh）

- `--target=bun-<platform>-<arch>`，**x64 一律 `-baseline`**（SSE2 基线，老 CPU 可跑）；
- `--no-compile-autoload-bunfig --no-compile-autoload-dotenv`：sidecar 被任意 cwd 拉起，
  宿主目录的 bunfig/.env 不得先行加载（pi issue #7684、#10473）；
- Runtime 目前无 `new Worker`；将来引入 worker 时**必须把 worker 文件与主入口一起列为
  entrypoint** 才会被嵌入（bun 按所有 entrypoint 的公共路径前缀摆放相对路径）；
- 目标矩阵与命名见 `src/target.ts`（单测覆盖）。

## 入口与模式

`src/entry.ts` 是唯一 entrypoint：

- **常规模式**（sidecar / 服务器）：动态 import `apps/runtime/src/main.ts`——生产启动代码
  零复制零改动（ready JSON、SIGINT/SIGTERM 优雅退出全走原实现）；
- **`--probe` 模式**（打包探针）：见下。

## 探针设计（验收要求的"选一并文档化"）

对话探针选**复用 pi-adapter 真实接线测试的本地 OpenAI 兼容 mock 服务器**（`src/mock-openai.ts`
改编自 `packages/pi-adapter/test/pi-adapter.live.test.ts` 的伪 SSE 服务器），而非 FakePi 内置模式。
理由：

1. 验收要证明的是**编译产物**能驱动完整栈——真实 PiAdapter 走 `@earendil-works/pi-agent-core +
   pi-ai` 的流式协议，是对 bun compile 对生产依赖树的直接验证；FakePi 是零依赖内存实现，
   二进制能跑起来它就必然能跑，证据力弱；
2. mock 服务器由探针脚本拉起（`127.0.0.1` 随机端口），二进制经 `MORROW_PROBE_LLM_BASE_URL`
   指向它，请求级契约（Bearer / model / stream / messages 形状）在探针脚本断言，
   事件级契约（五类窄事件）在二进制内断言；
3. T4 落地后 Runtime 有了对话 HTTP API，sidecar 对话探针可升级为 HTTP 级，内嵌探针保留为
   冒烟手段。

`--probe` 模式输出两行 JSON：首行与 main.ts 的 ready 行**同形状**（sidecar 启动协议），
末行为探针报告：

```json
{"probe":"pass","version":"0.1.0","runtime":{"name":"bun","bun":"1.4.4","node":"24.x"},"checks":{
  "health":{"ok":true,"http_status":200,"ledger_events":1},
  "sqlite":{"ok":true,"driver":"node:sqlite","sqlite_version":"3.x","roundtrip_rows":1},
  "dialogue":{"ok":true,"stop_reason":"stop","text":"探针正常"}}}
```

## sidecar 探针的阶段

- **阶段 A（生命周期契约）**：常规模式拉起 → 读 ready JSON 拿端口 → GET /v1/health →
  SIGTERM → 断言 `{stopped:true, signal:"SIGTERM"}` 行 + 退出码 0；
- **阶段 B（同样探针）**：以被父进程拉起的方式再跑一遍 `--probe` 套件。

## 结构

```
src/
  entry.ts             bun compile entrypoint（常规 = 动态 import runtime main.ts；--probe = 探针）
  probe-mode.ts        二进制内嵌探针套件（ready → health → sqlite → 对话 → 优雅退出）
  build.ts             bun compile 包装（target 探测、旗标、产物路径）
  target.ts            编译目标/产物命名 + 固定旗标（纯函数，单测覆盖）
  mock-openai.ts       OpenAI 兼容 mock 服务器（改编自 pi-adapter live test）
  probe-lib.ts         JSON 行流 / ready 握手 / 探针 HTTP / 嵌入探针套件（纯函数部分单测覆盖）
  probe-standalone.ts  standalone 探针入口
  probe-sidecar.ts     sidecar 探针入口（两阶段）
test/                 node:test 单测（target / probe-lib）
dist/                 产物（gitignored）
```
