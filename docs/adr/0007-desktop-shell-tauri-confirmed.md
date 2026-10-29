# 桌面壳定案 Tauri 2（冒烟门通过，不切换 Electron）

M0 的桌面壳裁决依据 PRD §2/§5.7 的门标准（三平台打包冒烟门）做出：**Tauri 2 保留为桌面壳，Electron 不切换**。本 ADR 记录判据、证据与已知限制；Electron 作为回退选项在此关闭（除非后续出现本 ADR 限制清单无法容忍的阻断项，届时补记新 ADR）。

## 判据与证据（2026-10-29，M0 冒烟门）

**判据（PRD §2 桌面 UI 行）：** Tauri 2 三平台打包 + sidecar 生命周期 + UI↔Runtime 控制面通信全部通过冒烟门；失败才评估 Electron。

| 判据项 | 证据 | 结论 |
|---|---|---|
| 三平台打包 | CI run [40884305224](https://github.com/EasonW3300/Morrow/actions/runs/40884305224)：macos `.app` / linux `.deb` / windows `.nsis` 三腿 build + gate + aggregate 全 success（T9 / Issue #10） | 通过 |
| standalone/sidecar 通信契约 | 同 run 三平台 gate 探针：ready JSON 握手 → `/v1/health` 200 → 对话探针（真实 PiAdapter 经 mock OpenAI 端点）→ 退出契约；聚合报告 `m0-gate-report` PASS | 通过 |
| 桌面 GUI 真机启动（本机 MacBook Pro M4 Pro / macOS 15.5） | T10 真机门禁：`launchctl setenv MORROW_SIDECAR_COMMAND` 注入 node 绝对路径后 `open` 启动 → sidecar 子进程就绪（ready 帧，随机端口）→ health 200 → 退出 → 子进程 SIGTERM 优雅回收（`{"stopped":true,"signal":"SIGTERM"}` 落日志）→ 重启周期复现 | 通过（含限制 R-1，见下） |
| sidecar 生命周期契约（真机） | 父退出 → SIGTERM → 优雅落盘退出；账本 `runtime.started/stopped` 计数平衡（11/11，含 GUI 门禁两对） | 通过 |
| 单二进制就位路径 | T8 已验证 bun compile（ADR-0006）；壳经 `MORROW_SIDECAR_COMMAND/ARGS` 换单二进制不改代码（`apps/desktop/README.md`） | 通过 |

真机证据明细见 `docs/gates/m0-gate-report.md`。

## 已知限制清单（真机发现 + 既有记录）

| # | 限制 | 事实 | 缓解 / 归属 |
|---|---|---|---|
| R-1 | **TCC 受保护目录下的启动挂起**（T10 真机发现） | .app 位于 `~/Desktop` 等受保护目录时，sidecar 的 node 在模块解析的 package.json 逐级上溯中 `open()` 被 TCC 静默阻塞（launchd 上下文无法弹授权框），ready 超时 20s；换非保护路径（`/tmp` 实测，`/Applications` 等价）启动立即就绪。sample 栈证据：`GetNearestParentPackageJSONType → ReadFileSync → open` 挂起 | 部署指导：.app 安装到 `/Applications`（最终用户的正常路径，不受影响）；开发/验收从非保护目录启动。根治 = T8 单二进制（bun compile 产物无模块上溯，Tauri resources 路径走法同被消除）。Owner 手动授权桌面访问亦可解除 |
| R-2 | launchd PATH 不含用户级 node | `open` 拉起的 .app 环境 PATH 只有系统目录，sidecar 默认命令 `node` 找不到（T6 发现） | `launchctl setenv MORROW_SIDECAR_COMMAND <node 绝对路径>`；根治同 R-1（单二进制） |
| R-3 | .app 未签名 | Gatekeeper 首次打开需右键 → 打开（T6 记录）；签名/公证不在 M0 范围 | M6 三 OS 打包阶段处理 |
| R-4 | Windows 无 SIGTERM | OS 级无优雅终止信号，`terminate()` 强杀、信号转发 no-op——Windows 上 Runtime 优雅落盘仅覆盖窗口关闭等正常退出路径（T6/T9 记录，CI gate 按 terminate-process 语义分平台判定） | 已分平台契约化（#10）；M6 故障注入轮次复核 |
| R-5 | 工具事件历史回看未入投影 | 历史轮次工具事件不在 `GET /v1/sessions/:id/messages` 投影（T7 已知边界，非壳缺陷） | Runtime 提供会话级事件查询后补 |

## Considered Options

- **Tauri 2——采用（维持 ADR-0003 时代的选型判断）**。三平台打包冒烟门全绿；壳体积 6.79 MiB（对照 Electron 动辄 80MB+ 的壳自重）；sidecar 生命周期契约（ready 帧/SIGTERM/资源目录注入）经 CI 与真机双重验证；已知限制均为环境/部署事项，不动摇架构。
- **Electron 回退——不切换**。切换动因仅在打包或 sidecar 通信不可达；两者均已三平台验证。Electron 的收益（自带运行时摆脱 R-1/R-2 的 PATH 类问题）被 T8 单二进制路径覆盖，无需为此付出全壳重写与包体代价。
- **纯 Web（浏览器 + 独立 Runtime 进程）**——不采用：丢掉"开箱即用的桌面应用"形态，且 R-1/R-2 本就不触及 Tauri 壳本身。

## Consequences

- M1+ 的桌面功能（Chat 完善/Task 视图/设置族）直接在 Tauri 壳上迭代，不再评估壳选型。
- R-1/R-2 写入部署文档与 `apps/desktop/README.md` 已知边界：**.app 的正确安装位是 `/Applications`；开发验收从非 TCC 保护目录启动**。
- T8 单二进制合入后 R-1/R-2 自动消除（sidecar 不再依赖 PATH 上的 node，也无模块上溯）；届时本 ADR 限制清单更新。
- Electron 回退路线关闭；重开需新 ADR 并列明 R-1..R-5 之外的新阻断证据。
