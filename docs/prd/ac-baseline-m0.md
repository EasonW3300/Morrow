# M0 验收基线记录（PRD §8 / Issue #11）

**状态**：M0 基线 —— PRD §8「阈值均为初始候选：M0 记录参考硬件/网络/模型/测试数据，M1/M2 校准」的落地文档。后续校准直接修订本文件并注明日期，不另开文档。
**参考设备**：下表第 1 节的本机（Owner 的 MacBook，同时是 AC-11 的声明参考设备）。
**原则**：分母、模型版本、测试环境固定，禁止排除失败样本制造达标（PRD §8）——本文件记录的就是那个"固定分母"的环境条件。

## 1. 参考硬件（2026-10-29，system_profiler）

| 项 | 值 |
|---|---|
| 型号 | MacBook Pro（Mac16,8） |
| 芯片 | Apple M4 Pro（12 核：8 性能 + 4 能效），arm64 |
| 内存 | 24 GB |
| OS | macOS 15.5（Build 24F74） |
| 磁盘加密 | FileVault 状态未列入本基线（威胁模型域 1 建议 Owner 开启，见 `docs/security/threat-model.md`） |

> 注意：M0 CI 矩阵跑的是 x64（ubuntu-latest / windows-latest，macos-latest 为 arm64）；AC-01 的三系统口径以 CI runner 机型 + 本机为准，arm64 Windows 待定（PRD §8 AC-01「arm64 待定」）。

## 2. 工具链版本（本机实测，2026-10-29）

| 工具 | 版本 | 备注 |
|---|---|---|
| node | v22.12.0 | `~/.local/node`（launchd PATH 外，桌面壳经 `MORROW_SIDECAR_COMMAND` 绝对路径注入） |
| bun | 1.4.4 | 官方 installer，`~/.bun/bin/bun`（ADR-0006，与 CI pin 一致） |
| pnpm | 9.12.0 | package.json packageManager |
| rustc / cargo | 1.98.1 | Tauri 构建链 |
| swift（CLT） | 6.1.2 | 麦克风探针用（`scripts/real-machine/mic-probe.swift`） |

CI 侧：node 22（runner 托管）、bun 1.4.4（oven-sh setup-bun pin）、Rust stable + rust-cache——与 `package.json` engines / workflow env 为准。

## 3. 网络环境

| 项 | 值 |
|---|---|
| 出口 | 家庭/办公私有网络经 Wi-Fi（`networksetup` 服务列表：Wi-Fi 主用，Thunderbolt Bridge 备用） |
| 私有隧道 | Tailscale 已接入（本机 tailnet IP 10.11.188.4）——ADR-0004 的默认部署形态在参考设备上已具备网络前提 |
| Runtime 监听 | 默认 `127.0.0.1` + 随机端口（`MORROW_PORT=0`），无网络暴露面 |
| LLM 端点连通性 | 待 Owner 配置真实 Provider 后实测（当前 M0 探针走本地 mock，见 §4） |

校准注意：AC-04 的同步 p95、AC-11 的打断 p95 均受网络往返影响——校准时须记录当次 Wi-Fi/Tailscale 路径（本地直连 or 隧道），并区分「同机回环」「局域网」「tailnet」三种路径分别给数。

## 4. 模型配置现状

| 项 | 状态 |
|---|---|
| Provider 协议 | 就绪：仅 OpenAI Chat Completions 兼容协议，`base_url + api_key + model` 三元组（ADR-0002）；Provider CRUD + 连通性测试四类结果（200→ok / 401→auth_failed / 不可达→unreachable / 5xx→error）已交付（T7） |
| 密钥存储 | 就绪：OS 凭据库（macOS Keychain 经 `security` CLI 本机实测；Windows/Linux 接口 + 桩测试，真机待测） |
| 真实端点 | **待 Owner 密钥**：AC-02 要求两个不同供应商端点（推荐 DeepSeek + OpenAI 官方）；M0 所有对话证据（CI 三平台探针 + 本机门禁）均走 `mock-openai` 本地 mock，真实模型行为不在 M0 证据内 |
| 流式与工具调用 | 真实 PiAdapter（`@earendil-works/pi-agent-core` + `pi-ai`）经 mock SSE 全链路验证（五类窄事件 + 工具事件进 UI） |

## 5. 测试数据现状

| 数据集 | 位置 | 用途 |
|---|---|---|
| OpenAI 兼容 mock 服务器 | `scripts/packaging/src/mock-openai.ts` | 门禁对话探针（CI 三平台 + 本机），请求/事件级契约断言 |
| 脚本化 Agent fixture | `apps/runtime/scripts/dev-fixture.ts` | 浏览器联调：流式/工具/错误可复现 |
| 设置与健康页 fixture | `apps/desktop/scripts/settings-fixture.ts` | Provider CRUD + 四类连通性路径 |
| 门禁报告 | `scripts/packaging/src/gate.ts` + `assemble-gate-report.ts` | 三平台冒烟门与聚合报告 |
| 麦克风探针 | `scripts/real-machine/mic-probe.swift` | AC-11 前置：输入设备枚举 + 1s 请求级捕获 |

> AC-03/05/06/07 等的专用测试数据集（100 条记忆记录、20 组 Tool 需求、20 个故障注入点）**尚未建立**——随各里程碑交付时建立并登记到本节。

## 6. AC 阈值「待校准」登记

以下阈值保持 PRD §8 的初始候选值，**校准前置条件未满足前不得当作已达标承诺**：

| AC | 初始候选阈值 | 待校准 | 校准前置条件 |
|---|---|---|---|
| AC-01 | 三系统安装/启动/退出/重启 + 一次对话+工具调用 100% | 是 | 真实 Provider 端点（当前证据用 mock）；Windows/Linux 真机（当前证据 = CI runner） |
| AC-02 | 两端点切换，失败不丢任务 | 是 | Owner 两家真实供应商密钥；切换 UI（M1） |
| AC-04 | 小事件同步 p95 ≤10s | 是 | M3 同步引擎 + 双真机；须按 §3 的三种网络路径分别给数 |
| AC-06 | 20 组需求 ≥18 组走通；越权 100% 阻断 | 是 | M2 容器沙箱 + 能力工厂；测试数据集建立 |
| AC-11 | 打断到停播 p95 ≤300ms；参考设备 = MacBook 内置麦+扬声器 | 是 | M5 语音管线；麦克风 TCC 授权（本机探针现状：**待 Owner 手动授权一次**，见 `docs/gates/m0-gate-report.md`）；参考设备即本机（§1），sherpa-onnx 模型选型实测后定 |
| 其余（AC-03/05/07/08/09/10/12/13/14/15） | 按 PRD §8 | 属性待定 | 各自里程碑交付时建立测试数据集与方法（登记到 §5） |

> 校准动作本身（跑多少轮、怎么统计三类成功率分母）在 M1 第一个校准票里定稿；本文件只锁定环境与前置条件。
