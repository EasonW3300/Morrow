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

## 冒烟门（T9 / Issue #10）

单平台门禁流水线（本机与 CI `.github/workflows/m0.yml` 同口径）：

```bash
pnpm gate:runtime   # 快速门禁：runtime 二进制 + standalone/sidecar 探针 → 报告（bundle 项跳过）
# 完整门禁（CI 形态，含桌面 bundle 校验）：
node --experimental-strip-types src/gate.ts --binary <path> --bundle-dir <dir> --report <out.md> --summary
```

- 产物校验（二进制 + bundle 目录）失败 → 不跑探针，报告 `gate-result: fail`，退出码 1
  （负向路径单测：`test/gate-cli.test.ts`）；
- 清单四项：#1 启动、#2 健康探针/对话、#3 sidecar 通信由 CI 探针验证；**#4 麦克风捕获探针
  与桌面 GUI 真机启动为真机门禁项**——CI runner 无音频设备与 GUI 会话，由 T10 在真机执行，
  报告标注「待真机」且不计入 CI 门禁判定（`gateVerdict`）；
- 三平台报告由 `src/assemble-gate-report.ts` 聚合为 `m0-gate-report`（任一平台报告缺失或
  非 pass → 汇总红，单测：`test/assemble.test.ts`）。

## bun 解析（merger 发现的修复）

`pack:runtime` 链条经 pnpm 脚本 shell 执行 bun，而本机 bun 由官方 installer 装在
`~/.bun/bin/bun`（不写 shell 配置，ADR-0006）→ 脚本层曾直接 ENOENT。现所有脚本层 bun 调用
经 `src/with-bun.ts` 显式解析（PATH → 用户级安装位，win32 候选带 `.exe`），
`build.ts` 复用同一 resolver（`src/bun-path.ts`，单测：`test/bun-path.test.ts`）。

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
  bun-path.ts          bun 解析（PATH → ~/.bun/bin/bun，win32 .exe；with-bun 与 build.ts 共用）
  with-bun.ts          脚本层 bun 启动器（package.json binary 脚本的显式解析入口）
  gate-lib.ts          冒烟门库：产物校验 / 二进制发现 / verdict / 报告构建 / 汇总（单测覆盖）
  gate.ts              冒烟门 CLI（本机与 CI 同口径）
  assemble-gate-report.ts  三平台门禁报告聚合 CLI（report job 用）
test/                 node:test 单测（target / probe-lib / bun-path / gate-lib / gate-cli / assemble）
dist/                 产物（gitignored）
```
