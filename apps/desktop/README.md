# @morrow/desktop

Tauri 2 + React 桌面壳（票 T6 / Issue #7）。Chat 视图完成流式对话（增量渲染、工具事件可见）
与历史回看；UI 与 Runtime 全部通过本地控制面 API（HTTP + SSE）通信，壳不建私有 IPC 通道。

## 结构

```
src/          React 前端（Vite）：App / SessionList / ChatView
  api.ts                控制面 fetch 封装（错误统一 { error: { code, message } } → ApiError）
  sse.ts                帧 → Chat 投影的纯归约（durable/易失帧语义，node:test 覆盖）
  runtime-endpoint.ts   控制面地址解析（壳内轮询 sidecar_status；浏览器联调用 ?runtime=）
src-tauri/    Tauri 壳（Rust）
  src/sidecar.rs        sidecar 生命周期：拉起 Runtime、stdout ready 协议、SIGTERM 退出
  src/main.rs           装配：setup 拉起 sidecar，sidecar_status 命令暴露给前端
```

## sidecar 启动协议

壳启动时拉起 Runtime 子进程，读取 stdout 的**单行 JSON ready 帧**拿控制面地址
（`{"ready":true,"host":"127.0.0.1","port":<随机>,"pid":...}`）；`MORROW_PORT` 默认 0
（随机空闲），无端口冲突。父进程退出 → SIGTERM 子进程 → Runtime 优雅落盘退出
（2s 内未退则 SIGKILL）。ready 等待上限 20s；子进程提前退出/超时通过
`sidecar_status` 命令以 error 态呈现给前端。

### 启动命令可配置（T8 单二进制 / T9 预留）

解析优先级：环境变量 > 默认值。

| 环境变量 | 默认（dev/debug 构建） | 说明 |
| --- | --- | --- |
| `MORROW_SIDECAR_COMMAND` | `node` | sidecar 可执行文件 |
| `MORROW_SIDECAR_ARGS` | `["--experimental-sqlite", <runtime 入口>]` | **JSON 数组**，非法即启动失败 |
| `MORROW_SIDECAR_CWD` | runtime 入口所在目录 | 子进程工作目录 |

runtime 入口：dev（debug 构建）= 仓库内 `apps/runtime/dist/main.js`（esbuild 自包含产物，
`pnpm --filter @morrow/runtime build` 生成）；release 打包 = Tauri 资源目录
`runtime/main.js`（tauri.conf.json `bundle.resources` 注入，随 .app 分发）。
换单二进制（T8）：设 `MORROW_SIDECAR_COMMAND=<binary>`、`MORROW_SIDECAR_ARGS=[]` 即可，壳不改。

Node < 22.13 需要 `--experimental-sqlite`（22.13+ 默认开启，标志保留无害）。
子进程继承壳的环境变量，`MORROW_PROVIDER_*` / `MORROW_DATA_DIR` 等照常生效。

## 命令

```bash
pnpm --filter @morrow/runtime build   # 先产 dist（sidecar 与打包资源的前置）
pnpm --filter @morrow/desktop dev     # vite dev（壳内调试用 tauri dev）
pnpm --filter @morrow/desktop tauri dev    # 完整桌面壳开发模式
pnpm --filter @morrow/desktop tauri build  # 产出 macOS .app（target/release/bundle/macos/）
pnpm --filter @morrow/desktop test    # tsc + node:test（sse 归约）+ cargo test（sidecar，含 dist 全链路冒烟）
```

### 浏览器联调（无壳）

```bash
MORROW_DATA_DIR=/tmp/morrow-fixture node --experimental-sqlite --experimental-strip-types \
  apps/runtime/scripts/dev-fixture.ts   # 脚本化 Agent 的 Runtime（流式/工具/错误可复现）
# 打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<fixture端口>
```

`?runtime=` 仅用于浏览器联调的端点发现；打包应用内一律走 sidecar 上报的地址，
且无论哪种方式 UI 与 Runtime 都只有控制面 HTTP/SSE 一种通道。

## 已知边界（M0）

- 历史回看来自 `GET /v1/sessions/:id/messages` 投影（user/assistant 消息）；历史轮次的
  工具事件不在该投影里，重启后 SSE 重放也只补 `lastSeq` 之后的 durable 帧——工具事件
  的持久回看等 Runtime 提供会话级事件查询后再补。
- .app 未签名（Gatekeeper 首次打开需右键 → 打开）；sidecar 依赖本机 `node`（PATH），
  自包含单二进制是 T8 的事。
