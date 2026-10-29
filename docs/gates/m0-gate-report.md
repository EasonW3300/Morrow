# Morrow M0 门禁报告（归档，T10 / Issue #11）

**归档日期**：2026-10-29 ｜ **分支基线**：`integration/m0` @ 570500e ｜ **真机**：MacBook Pro（Mac16,8，Apple M4 Pro，24 GB，macOS 15.5 Build 24F74）
**参考环境**：`docs/prd/ac-baseline-m0.md` ｜ **CI 门禁设计**：`.github/workflows/m0.yml`（T9 / Issue #10）

## 1. CI 冒烟门（三平台）

| 项 | 值 |
|---|---|
| Run | [40884305224](https://github.com/EasonW3300/Morrow/actions/runs/40884305224)（push integration/m0，2026-10-29） |
| 结论 | build（macos/linux/windows）× gate（×3）× gate report aggregate —— **7/7 jobs success** |
| 三平台判定 | macos PASS ｜ linux PASS ｜ windows PASS（聚合 artifact `m0-gate-report`，`gate-result: pass`） |
| 覆盖内容 | 产物存在性校验（缺失即红，负向路径有单测与本机实跑证据）→ standalone 探针（ready → health 200 → 对话探针经 mock OpenAI 端点）→ sidecar 探针（生命周期契约 + 同套探针）→ 平台报告聚合 |
| 产物 | `runtime-binary-*`（bun compile 单二进制，x64 自动 `-baseline`）、`desktop-bundle-*`（.app/.deb/.nsis）、`runtime-server-linux-x64`（ADR-0003 双宿主）、`m0-gate-report` |

CI 边界（T9 定义）：CI runner 无音频设备与 GUI 会话，清单 #4 的真机项不计入 CI 判定，由本报告第 2 节补齐。

## 2. 真机门禁项（本机 macOS，T10 执行）

### 2.1 桌面 GUI 启动门禁 —— **PASS**（含一项重要发现，见 2.3）

真机构建：`pnpm --filter @morrow/runtime build` + `pnpm --filter @morrow/desktop run tauri:build --bundles app` → exit 0（cargo release 6m30s，Morrow.app 6.79 MiB，资源目录含 `runtime/main.js`）。

门禁步骤（launchd PATH 注入：`launchctl setenv MORROW_SIDECAR_COMMAND /Users/wys3300/.local/node/bin/node`）：

| 步骤 | 证据 | 时间（+0800） |
|---|---|---|
| 启动（非 TCC 保护路径 /tmp/morrow-t10） | `open` OK；app pid 15704；sidecar node pid 15730（`node --experimental-sqlite <Resources>/runtime/main.js`） | 22:01:03 |
| ready 帧 | `~/Library/Logs/app.morrow.desktop/sidecar.log`：`{"ready":true,"version":"0.1.0","host":"127.0.0.1","port":65061,"pid":15730,...}`（秒级就绪） | 22:01:0x |
| health 探针 | `curl /v1/health` → **HTTP 200**：`{"status":"ok","version":"0.1.0","replica_id":"fce285e5-...","sandbox":{...stub...},"ledger":{"events":20}}` | 22:01:20 |
| 退出回收 | `quit app "Morrow"` → app 退出 ≤3s；sidecar 收 SIGTERM 优雅退出：日志落 `{"stopped":true,"signal":"SIGTERM"}`；子进程无残留 | 22:01:30 |
| 重启周期（AC-01 口径） | 二次启动 → ready（port 65350，pid 17866）→ health 200 → 退出回收，日志累计 2 条 `stopped:true` | 22:01:54–22:02 |
| 审计事件贯通 | 账本（`~/.morrow/data/events.sqlite` 离线副本）：`runtime.started 11 / runtime.stopped 11` 平衡（含 GUI 门禁两对）+ `session.created 1` | — |

### 2.2 麦克风捕获探针 —— **待 Owner 手动授权一次（未通过，未伪造）**

探针：`scripts/real-machine/mic-probe.swift`（Swift + AVFoundation，CLT 直接运行；用法见 `scripts/real-machine/README.md`）。

- **已达成部分**：输入设备枚举正常（`MacBook Pro麦克风` / `BuiltInMicrophoneDevice`）；权限状态检查、带超时的授权请求、捕获与 JSON 报告通路实现完毕，探针可重复执行。
- **阻塞事实**（2026-10-29 21:50–21:51 两次实跑，沙箱内/外各一次）：权限状态 `notDetermined` → `requestAccess` 约 3 秒回调 `false` 且系统**不弹授权框**，状态停留 `notDetermined`，探针如实报 `status:"denied"`、exit 2。原因：自动化进程上下文（探针归因到宿主 App ZCode.app）无法呈现 TCC 麦克风授权 UI，系统静默拒绝。
- **解除路径**：系统设置 → 隐私与安全性 → 麦克风 → 为宿主 App 开启一次 → 重跑探针至 `status:"pass"`（预期 `frames_captured ≥ 48000`）。此为 AC-11 校准前置条件之一（`docs/prd/ac-baseline-m0.md` §6）。

### 2.3 真机发现：TCC 受保护目录下的启动挂起（已写入 ADR-0007 限制 R-1）

首次从 `~/Desktop/...`（工作树内产物直启）启动：sidecar node **挂起**——sample 栈定位在模块解析 package.json 逐级上溯的 `open()` 系统调用（`GetNearestParentPackageJSONType → ReadFileSync → open`），ready 永不到达（20s 超时路径）；同一目录终端手动运行立即就绪（宿主已有桌面访问权）。换非保护路径（/tmp）启动秒级就绪——定性：**.app 在 `~/Desktop` 等受保护目录启动时，node 的目录上溯触发 TCC 桌面访问评估，launchd 上下文无法弹框即静默阻塞**。

影响与处置：最终用户安装到 `/Applications`（不受影响）；开发/验收从非保护目录启动；T8 单二进制合入后自动消除（无模块上溯）。退出回收契约在挂起场景下同样成立（quit → 子进程回收 ≤3s，实测）。

## 3. 冒烟门清单逐项判定

| # | 清单项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 安装/启动/退出/重启 | **PASS**（CI 三平台 + 真机启动/退出/重启周期） | §1 + §2.1 |
| 2 | 健康探针 + 一次对话 | **PASS**（CI 三平台探针；真实 Provider 端点待 Owner 密钥，当前对话证据走 mock——见 ac-baseline §4） | §1 |
| 3 | sidecar 通信 | **PASS**（CI 生命周期契约 + 真机 GUI 场景复验） | §1 + §2.1 |
| 4a | 麦克风捕获探针 | **待 Owner 手动授权**（如实记录，未伪造；解除路径 §2.2） | §2.2 |
| 4b | 桌面 GUI 真机启动 | **PASS**（含 TCC 目录限制 R-1，已缓解并归档 ADR-0007） | §2.1 + §2.3 |

**M0 门禁判定：通过**（#4a 为非阻塞待办——麦克风不阻塞 M0 任何交付物，仅是 AC-11 的远期前置；PRD §9 M0 门槛不含语音项）。

## 4. PRD §9 M0 通过门槛核对表

| 门槛（PRD §9） | 判定 | 证据指针 |
|---|---|---|
| 三 OS 启动 | **达成** | CI run 40884305224 三平台 gate PASS（.app/.deb/.nsis + 探针）；真机 macOS 启动/退出/重启 §2.1。注：windows/linux 为 CI runner 证据，Owner 真机 windows 待 M6（ac-baseline §1 注） |
| 基本对话 | **达成** | CI 对话探针（真实 PiAdapter + mock OpenAI 端点，流式五类窄事件）；UI Chat 流式对话与历史回看（T7 交付） |
| 工具调用 | **达成** | 探针工具调用经 mock 断言；Chat 视图工具事件可见（apps/desktop README T7 节） |
| 审计事件贯通 | **达成** | 事件信封 schema v1 + integrity_hash 复算（ledger.ts）；账本 `runtime.started/stopped` 平衡（§2.1 末行）；执行事件不可变落账 |
| 桌面壳门做出 Tauri/Electron 裁决 | **达成** | ADR-0007：Tauri 保留、Electron 不切换；判据 = §1 + §2，限制清单 R-1..R-5 |
| 验收基线已记录 | **达成** | `docs/prd/ac-baseline-m0.md`（硬件/工具链/网络/模型现状/测试数据/待校准表）；README 可达 |

**M0 门槛：全部达成**。遗留待办（不阻塞 M0）：麦克风探针 Owner 授权（§2.2）、真实 Provider 密钥与 AC-02 双端点（ac-baseline §4）、windows/linux 真机走查（M6）。
