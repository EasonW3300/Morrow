# SQLite 绑定定 node:sqlite（bun compile 实测验证）

Runtime 的账本需要 SQLite，且运行形态是"本地开发跑 Node 源码、交付物是 bun compile 单二进制"
（ADR-0003）。决定：**定 `node:sqlite`（`DatabaseSync`）为唯一 SQLite 绑定**，经
`apps/runtime/src/db.ts` 薄 facade（exec/prepare/close + WAL/busy_timeout/synchronous pragma）访问；
`bun:sqlite` 仅作为 facade 后备（换驱动只动一个文件）；`better-sqlite3` 不进依赖树。
本 ADR 记录 M0 冒烟的 bun compile 实测结论（研究底稿：`morrow-research/NOTES-bun.md`）。

## 本机实测证据（2026-10-29，票 T8 / Issue #9）

- **bun 版本与安装**：bun 1.4.4（registry latest）。本机 Homebrew 前缀为非默认路径（`~/.homebrew`），
  brew 无 bottle 可用、触发 rust 源码编译，故弃用；改用官方 installer 落点到 `~/.bun/bin/bun`
  （用户级，无 shell 配置变更）。构建脚本会依次探测 PATH 与 `~/.bun/bin/bun`。
- **编译**：`bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv
  --target=bun-darwin-arm64` 一次通过：1030 modules（含 `@earendil-works/pi-agent-core`、
  `pi-ai` 及其 SDK 依赖树、ajv）→ bundle 452ms + compile 106ms → **86.6 MB 单二进制**。
- **node:sqlite 在编译产物内零标志可用**：对照 Node 22.12.0 直接运行报
  `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`（需 `--experimental-sqlite`，
  仓库 node 脚本已带该标志）；bun 运行时（dev 模式 `bun src/entry.ts` 与编译产物）均**不需要任何标志**。
  编译产物内 `sqlite_version()` 实测 **3.43.2**（macOS 系统 `libsqlite3.dylib`，与 NOTES-bun §1
  记录的 Bun-on-macOS 行为一致）；建表/参数化写入/读回 roundtrip、WAL pragma、账本
  `runtime.started/stopped` 记账全部通过。
- **探针**：standalone 与 sidecar 两形态启动探针均 PASS（`/v1/health` 200 + 真实 PiAdapter
  经本地 OpenAI 兼容 mock 服务器完成流式对话 + 退出码 0），可重复执行入口：
  `pnpm probe:runtime`（脚本与探针设计见 `scripts/packaging/README.md`）。
- **引擎兼容**：bun 1.4.4 报 `process.versions.node = 26.3.0`，满足 Pi 1.4.0 声明的
  `node >= 22.19.0`；真实 Pi 依赖树在编译产物内的对话探针通过即为其运行时证据。
- **跨运行时文件互换**：bun 优雅关闭（`db.close()` 触发 WAL checkpoint）后，Node 侧
  `node:sqlite`（捆绑 3.47.0）读同一账本文件正常（实测 CLEAN-SWAP 通过）。**注意**：
  进程被 SIGKILL 后遗留 hot WAL，恢复由下一个打开方执行——本机实测曾出现 Node 侧对
  bun 侧异常退出遗留的 hot WAL 首次打开报 `SQLITE_ERROR`、由 `sqlite3` CLI 先行恢复后
  读取正常的个案。开发期（Node/bun 混用同一 `MORROW_DATA_DIR`）遇异常退出后建议先用
  同版或更新版 SQLite（系统 `sqlite3` CLI）打开一次；生产单一运行时不受影响。

## Considered Options

- **`node:sqlite`（`DatabaseSync`）——采用**。零 native 依赖：Node ≥22.5 内建、Bun 1.4.4 官方
  兼容表标记 fully implemented 且本机实测通过；Pi 生产同款选择（pi-mono `packages/chord` 的
  `SqliteDatabase` 适配器即基于它）。与 facade 组合后，换驱动的成本收敛到单文件。
- **`bun:sqlite`——后备**。Bun 内建、官方口径性能最优，但 Node 侧无此模块，代码需双实现；
  仅当 `node:sqlite` 在未来 Bun 版本暴露缺陷（如 NOTES-bun §1 列出的 `backup()` 同步阻塞——
  本项目不使用 `backup()`）时按 facade 单文件切换。
- **`better-sqlite3`——不采用**。native N-API 插件，6 平台 prebuild/编译链与供应链成本高，
  收益仅为同步 API 舒适性；pi 全仓库未采用。
- **Node SEA 回退（ADR-0003 预留）——未触发**。bun compile 一次通过且 node:sqlite/
  worker 路径（当前无 worker；将来 worker 须列为显式 entrypoint）均无阻塞，SEA 工具链
  更糙（postject 注入/签名/资源管理手写），仅在 bun 路线不达标时启用。

## Consequences

- 不引入任何 SQLite native 依赖；依赖面收敛为 `ajv` + `@morrow/protocol` + `@morrow/pi-adapter`
  （纯 JS，可打包）。
- 不使用 `backup()`（Bun 下同步阻塞事件循环）；WAL checkpoint 走干净关闭默认路径
  （`ledger.close()` → `db.close()`），与 T2 的 durability 设计一致。
- 跨运行时共享数据目录时遵守上述 hot WAL 恢复注意事项；CI 平台矩阵（ADR-0003）扩展到
  linux/windows 时按 `scripts/packaging/src/target.ts` 的目标规则（x64 加 `-baseline`）重跑探针。
- SQLite 版本随运行时而定（macOS 上 bun = 系统库，Node = 自带捆绑），账本 schema 保持
  基线兼容，不使用版本相关特性。
