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

## 7. M1 校准注记（2026-11-02，M1-T7 / Issue #19 合并态实测）

基线补记（PRD §8「M1 校准」的 M1 部分，环境仍以 §1/§2 为准）：

**工具链补充（§2 的 M1 边界）**：

| 项 | 值 | 备注 |
|---|---|---|
| node（homebrew，M1 记忆/测试套件实际使用） | v24.22.1 | `/opt/homebrew/bin/node`，FTS5 可用 |
| node（`~/.local/node`，M0 登记值） | v22.12.0 | **无 FTS5**：跑记忆套件建表报 `no such module: fts5` |

- **FTS5 的 Node 版本要求（新约束）**：Node 内建 SQLite 在 **22.16+ / 24** 才编入 FTS5 模块。M1 起凡涉及记忆检索的运行/测试/打包（含桌面壳 `MORROW_SIDECAR_COMMAND` 注入与 CI runner node 版本）须满足 ≥22.16，否则 AC-03 路径不可用。
- **测试规模（M1 合并态 c690a77 实测）**：runtime 283（M0 时点 61 → M1 合并态 283）；全 workspace node:test 合计 **449**（runtime 283 + protocol 40 + pi-adapter 31 + desktop 39 + packaging 56）+ desktop sidecar Rust 9，全部绿（exit 0）。
- **故障注入结果（AC-07 前置数据集，登记入 §5 测试数据）**：`apps/runtime/test/checkpoint.faults.test.ts`，两层注入（进程级 kill -9 + 进程内半写/损坏），**25 点 = 20 恢复 + 5 守卫，合并态复跑 25/25 通过**（耗时 8.4s）。AC-07「≥19 恢复」的分母由此固定为 20 个恢复点。
- **AC-03 测试数据集（登记入 §5）**：`apps/runtime/scripts/memory-ac03.ts`（`pnpm --filter @morrow/runtime memory:ac03`），100 条设计记录 写入→抽取→巩固→投影→检索→回链→hash 全断言，确定性可重复，合并态复跑 100/100 通过（0.66s）。
- **AC-12 现状**：介入操作端到端覆盖盘点见 `docs/gates/m1-gate-report.md` §3——暂停/接管/恢复达标；修改正向 4 次、切模型独立场景 3 个、交还正向 4 次，尚不足 5（缺口如实登记，M6 全量验收前补齐）。AC-12 正式验收形态（含桌面 UI 人工走查）在 M6。
- **仍未校准**：AC-03/05/07/12 的正式阈值校准（成功率分类统计等）待多轮实测数据，本节只登记 M1 实测现状与新增环境约束；真实 LLM 抽取冒烟仍待 Owner 密钥（§4）。

## 8. M2 校准注记（2026-11-02，M2-T7 / Issue #28 合并态实测）

基线补记（PRD §8「M2 校准」的 M2 部分，环境仍以 §1/§2 为准，Docker 29.6.1 本机可用）：

- **AC-06 分母/阈值定版**：20 组限定需求样例 = `apps/runtime/test/capability-factory.samples.ts`（S01–S18 走通组含 1 组代码越权被沙箱阻断；S19/S20 manifest 越权规划期阻断）——**分母 20、走通线 ≥18、越权样例 3 组 100% 阻断**就此固定，禁止剔除失败样本（PRD §8）。执行口径双路径：`pnpm --filter @morrow/runtime factory:ac06`（LocalNodeRunner 桩，合并态 20/20、5.2s）与 `factory:harness:container`（DockerRunner 真容器，合并态 1/1、34.7s，node:22-alpine）；CI ubuntu 容器腿独立判定（`sandbox tests (ubuntu, real containers)` job）。登记入 §5 测试数据集。
- **沙箱容器测试环境登记（§5 测试数据）**：T2 套件 `apps/runtime/test/sandbox.*.test.ts`（11 套件 69 用例）为本机 docker 实跑（M2 合并态 69/69、10.1s）；CI 侧由 ubuntu runner 真容器 job 承载。沙箱契约 v1 只支持 `network: none`（fail-closed）——声明网络工具的放行面未建（见 m2-gate-report §5-2）。
- **AC-08 前置测试数据（登记入 §5）**：`apps/runtime/test/tasks.parallel.test.ts`，6 用例（worktree 隔离并行/资源锁串行化/冲突 pending_review/verify 失败回滚/节点内沙箱指向 worktree/残留清扫），真实 git worktree 夹具，合并态 6/6（2.2s）。
- **测试规模（M2 合并态 b461a8d + T7 接缝收尾实测）**：runtime 520（M1 收官 298 → 520）、desktop 67（39 → 67）+ sidecar Rust 9、protocol 40、pi-adapter 31、packaging 56；全 workspace node:test 合计 **714**（M1 收官 464 → 714），全部绿（exit 0）。
- **M2 门槛演示数据（登记入 §5）**：`scripts/real-machine/m2-demo.sh`（可重复执行，PASS=10 FAIL=0 × 2 次）+ 归档输出 `docs/gates/m2-demo-output.md`；生成口径为夹具注入的脚本化生成器（FakePi 同款，零 LLM）——AC-06 的「生成成功率」在真实 LLM 接入前以该口径为分母，真实模型行为待 Owner 密钥（§4）。
- **新登记的 runtime 缺口（待修复票）**：Skill invoke 缺省接线（ToolInvoker 未注册任何工具 → 缺省 unknown_tool）——AC-06/PRD §4.2 重用调用在真实 Runtime 缺省配置下不成立，见 `docs/gates/m2-gate-report.md` §5-1。
- **仍未校准**：AC-06 的三类成功率分类统计（正式口径）、AC-08 的并行度量化指标待多轮实测；本节只登记 M2 实测现状与分母定版。

## 9. M3 校准注记（2026-11-10，M3-T7 / Issue #36 合并态实测）

基线补记（PRD §8「M3 校准」的 M3 部分，环境仍以 §1/§2 为准；本机 node 24.22.1、macOS 15.5、M4 Pro 24 GB）：

- **AC-04 测试数据与复跑（登记入 §5）**：可重复脚本 `scripts/real-machine/ac04-sync.ts`（两独立 Runtime + `POST /v1/pairing/join` 配对 + 真实 HTTP `POST /v1/sync/run`）。合并态 79c8fa8 实测：A/B 各离线 50 条 `session.created` → 双向同步 → 两侧各 100 条业务事件，**缺失 0 / 重复 0 / 同一来源相对顺序一致（4 项顺序断言全 true）**。归档 `docs/gates/m3-ac04-sync.md` + `.json`。
- **AC-04 p95 实测（本机回环基线）**：100 个样本 = 每轮 1 条 `session.created`（最大 406 B ≤1KB）→ 一次 `POST /v1/sync/run` 完成（pull→push→push→pull）的墙钟。**p50 1.66 ms / p90 2.35 ms / p95 2.54 ms / p99 3.74 ms**（min 1.39 / max 5.71 / mean 1.83 ms）；100/100 样本到达对端。阈值 ≤10 s（PRD §8 初始候选）在回环基线下 MET。**环境口径**：127.0.0.1 单机双实例，非 Tailscale/Wi-Fi；真实网络待 Owner 环境校准（当前 HTTP 传输未携带 bearer token，见 `docs/gates/m3-gate-report.md` §6-3）。按 §3 要求，本值只作为「同机回环」路径的数。
- **AC-05 样本集登记（登记入 §5）**：`scripts/real-machine/ac05-conflicts.ts`，20 个竞争事实（与 `apps/runtime/test/sync.merge.test.ts` 同集合）：**6 preference 自动合并 + 14 待审核（locked 3 / sensitivity_change 5 / fact_conflict 6）**。合并态复跑：自动合并 6/6（两端收敛同一 v3 内容/版本），待审核 14/14（A/B 两侧冲突原因均与 M1 巩固器分支一致）；同步审计每侧 `sync.merged` 6、`sync.conflict` 28。删除不复活双向：A 删/B 离线改、B 删/A 离线改 → 双方 `deleted_at` 非空、旧修订未导入、`sync.tombstone_skipped` 审计命中。归档 `docs/gates/m3-ac05-conflicts.md` + `.json`。
- **AC-05 缺陷登记**：两端同时竞争时，跨端 `sync.conflict` 的 `remote_event_ids` 会把对方**本地**修订也视为「不采纳」，重放后待审核事实的可见值回落到基线 v1（本地 v2 可见 0/14）；冲突队列仍完整保留两侧内容。分类与删除判定不受影响。详见 `docs/gates/m3-gate-report.md` §6-5/6。
- **三部署证据（登记入 §5）**：本机 `scripts/deploy/smoke-{local,server,hybrid}.sh` 三形态全 PASS（server 的真实 systemd 标注 SKIPPED 待 Owner）；CI 最新 run [42767124433](https://github.com/EasonW3300/Morrow/actions/runs/42767124433)（79c8fa8）8 job 全绿，`gate (linux)` 的 Deployment smoke（服务器单二进制、systemd 等价前台）success。纯本地/混合未加入 CI。
- **needs_reconcile 证据（登记入 §5）**：`apps/runtime/test/lease.scheduler.test.ts`（双端独立执行 → `task.needs_reconcile`，Owner 裁决 → `task.reconciled` + `task.completed` actor=owner）与 `lease.api.test.ts`（detect/reconcile 端点）合并态全绿；`scripts/real-machine/m3-demo.sh` 两轮 20/20。边界：跨实例租约表独立，B 侧 acquire 仍从 token=1 起（无事前跨设备互斥）；任务投影不随同步重建（对端任务详情 404）。见门禁报告 §6-1/4。
- **M3 门槛演示数据（登记入 §5）**：`scripts/real-machine/m3-demo.sh`（两轮独立执行，每轮 10 项断言，20/20 PASS）+ 归档 `docs/gates/m3-demo-output.md`；覆盖 join 配对、双向同步、删除传播、冲突分类（自动/待审核）、执行权转移、needs_reconcile 检测与裁决。
- **测试规模（M3 合并态 79c8fa8 实测）**：runtime **603**（M2 合并态 520 → 603，排除两个真实容器套件）、desktop 95（67 → 95）+ sidecar Rust 9、protocol 40、pi-adapter 31、packaging 56；全 workspace node:test 合计 **825**（M2 714 → 825），全部绿（exit 0）。真实容器套件由 CI ubuntu 腿独立判定。
- **仍未校准/未达成**：AC-04 的**真实网络**（Tailscale/Wi-Fi）p95 未测；跨设备「同一任务单点执行」缺共享租约与事前互斥（只有事后 `needs_reconcile`）；真实 systemd、附件/大文件传输、桌面 UI 人工走查保持开放。详见 `docs/gates/m3-gate-report.md` §5/§6。

## 10. M4 校准注记（2026-11-10，M4-T9 / Issue #46 合并态实测）

基线补记（PRD §8「M4 校准」的 M4 部分，环境仍以 §1/§2 为准；本机 node 24.22.1、macOS 15.5、M4 Pro 24 GB，合并态 `integration/m0` @ 56ca2d2）：

- **AC-09 测试数据与复跑（登记入 §5）**：可重复脚本 `scripts/real-machine/ac09-feishu.ts`（真实 `FeishuChannelAdapter` + `ChannelTestServer` 平台桩 + 真实 Runtime）。20 轮 × 五面：私聊 **20/20**、群 @（白名单 `mention_only`）**20/20**、可信联系人授权（一次性邀请码，默认仅 `query`）**20/20**、外发审计 **20/20（80 条 `outbound.sent`，平台回执 80/80）**、任务关联 **20/20（消息 `task_id` 列 + 事件信封 `task_id`，原始记录不改写）**。入站 80、会话 61。归档 `docs/gates/m4-ac09-feishu.md` + `.json`。
- **AC-10 测试数据与复跑（登记入 §5）**：`scripts/real-machine/ac10-qq.ts`（真实 `QqChannelAdapter`（Ed25519 签名）+ `registerQqTestStub`）。20 轮 × 两路径：群 @ **20/20**、私聊（C2C）**20/20**、外发审计 **20/20（40 条）**；主动消息受限声明 + 平台拒绝 `proactive_rejected`（304046）→ `needs_review` 不重试 **PASS**；access token 过期刷新一次 **PASS**。归档 `docs/gates/m4-ac10-qq.md` + `.json`。
- **AC-10 真实平台层登记（登记入 §5，未达 20 次门线）**：`docs/gates/m4-qq-live-evidence.md` —— 真实 QQ 官方 Bot（AppID 1906368184）累计**群 @ 15 次**（首轮 1 + 第二轮 14，其中 10 次仅 @ 不带正文）+ **私聊 1 次**，**15/15 回复成功、0 拒绝**，Owner 侧确认收到。**主动消息真实限制**：群主动消息 HTTP 400 `code=40034105`「无权限」→ `proactive_rejected`（不可重试）；私聊主动消息 HTTP 200（平台额度内可发）——分场景受限，不得混为一谈。真实平台发现并修复三处缺陷：`unknown_conversation`（WS 可信入站未学习会话形态，`73cf438`）、`40034105` 未入不可重试码表、测试桩六个注入选项声明后未赋值（后两者 `56ca2d2`）。**未达**：群 @ 20 次（差 5）、私聊 20 次（当前 1）、真实链路 Outbox/审计逐条对账。
- **AC-13 测试数据与复跑（登记入 §5）**：`scripts/real-machine/ac13-notifications-permissions.ts`。五类越权（private 记忆/文件/开发工具/未授权能力/他人会话）× 20 次 = **100/100 阻断（100%）**，`contact.permission_denied` 审计 100 条；public 记忆对照组 20/20 放行。通知 8 条规则（四类事件 × desktop/channel:echo），20 轮每类投递 2 次 → **送达 160 / 重复去重 160**（第 2 次 100% 抑制），渠道 80 条经 Outbox 实发。归档 `docs/gates/m4-ac13-notifications-permissions.md` + `.json`。
- **AC-15 测试数据与复跑（登记入 §5）**：`scripts/real-machine/ac15-wechat.ts`（真实 `WeChatChannelAdapter` + `StubLocalBridge`）。出厂 disabled、未确认风险 409、确认后启用 + 审计；白名单收发 **20/20**、非白名单阻断 **20/20**；健康检查故障降级/恢复；四类审计事件齐全；disable 后入站 0。归档 `docs/gates/m4-ac15-wechat.md` + `.json`。**真实微信环境未做**（需 Owner Windows + 真实桥，外部阻塞）。
- **AC-14 演示数据（登记入 §5）**：`scripts/real-machine/m4-demo.ts`（两轮独立执行，每轮 10 项断言，**20/20 PASS**）+ 归档 `docs/gates/m4-demo-output.md`。覆盖渠道入站 → 渠道发起任务 → 任务关联 → 自动建能力（沙箱验证 4/4 → 确认注册 `author=ai disabled`）→ 记忆更新（public 事实）→ pause/checkpoint/restore → 外发审计 → 通知去重 + 五类越权阻断 → 跨设备查看（A→B 同步，任务 completed + 事实可见）；**语音段标注 M5 未实现**。能力生成器为脚本化实现（零 LLM），沙箱为 `LocalNodeRunner` 本地桩，跨设备为 127.0.0.1 单机双实例回环基线。
- **测试规模（M4 合并态 56ca2d2 实测）**：runtime **726**（M3 收官 603 → 726，排除两个真实容器套件）、desktop 116（95 → 116）+ sidecar Rust 9、protocol 40、pi-adapter 31、packaging 56；全 workspace node:test 合计 **969**（M3 收官 831 → 969），全部绿（exit 0）。真实容器套件由 CI ubuntu 腿独立判定（最新 run [42789125967](https://github.com/EasonW3300/Morrow/actions/runs/42789125967) success）。
- **合并态 typecheck 基线缺陷（登记，未修复）**：56ca2d2 起 `QqTestStubOptions` 缺六个注入选项字段（`rejectProactive`/`rejectAllTokens`/`failTokenEndpoint`/`rateLimit`/`mode`/`signatureMode`），`tsc --noEmit` 7 处失败；CI 不跑 typecheck/单测故未暴露。node:test 969 仍绿；严格口径「全 workspace 测试绿」不成立，待后续修复票。详见 `docs/gates/m4-gate-report.md` §6-13/§7。
- **仍未校准/未达成**：飞书真实平台（资质未注册，0 次）；QQ 真实平台群 @ 20 次门线（15/20）与私聊 20 次（1 次）；微信真实环境（Owner Windows + 真实桥未实现）；附件文件传输；QQ 频道 `AT_MESSAGE_CREATE`；真实 Tailscale/Wi-Fi 双机；真实 LLM 生成；桌面 UI 人工走查（M6）。详见 `docs/gates/m4-gate-report.md` §3/§6。

## 11. M6 最终注记（2026-11-11，M6-T4 / Issue #55 合并态实测）

M6 是 PRD §8 验收的**最终裁决**，不是又一次里程碑校准。逐项裁决全文见
[`docs/gates/m6-gate-report.md`](../gates/m6-gate-report.md)；本节只锁定最终规模、判定环境与 Owner 范围决定。

- **最终测试规模（本工作树 `m6/t4` = `integration/m0` @ `dde03f1` + T4 文档实测，node v24.22.1）**：runtime **738**（排除两个真实容器套件）、desktop **139**、protocol **40**、pi-adapter **31**、packaging **56** —— node:test 合计 **1004/1004**；desktop sidecar Rust **9/9**；**总计 1013**。`pnpm -r typecheck` 5 包全绿。安全汇总单入口 **264/264**（六域非去重计数，见 `docs/gates/m6-security-summary.md` §1）。与 M4 门禁 993（`m4-gate-report.md` §7）相比 +11（TECH-DEBT #49/#50 + M6-T2 UI 修复补测 6 例）。
- **裁决统计（AC-01..AC-15）**：达成 **9**（AC-01/03/04/05/06/07/08/12/13）、部分 **2**（AC-10、AC-14）、未达成 **1**（AC-11）、外部依赖 **3**（AC-02/09/15）；AC-10a 按 PRD 原文不设验收承诺、不入统计。
- **各 AC 判定环境（固定分母的口径）**：

| AC | 判定 | 判定环境 |
|---|---|---|
| AC-01 | 达成 | CI runner：macOS arm64 / linux x64 / windows x64（build+gate 实跑产物与探针）；本机 macOS 真机 GUI 启动/退出/重启。Windows/Linux 桌面安装向导未人工实装（验证边界） |
| AC-02 | 外部依赖 | **未在真实端点执行**；切换机制证据走本地 mock OpenAI |
| AC-03 | 达成 | 本机 macOS + 确定性启发式抽取（100 条数据集） |
| AC-04 | 达成（回环基线） | 127.0.0.1 单机双 Runtime；p95 2.43–2.54 ms |
| AC-05 | 达成（回环基线） | 127.0.0.1 单机双 Runtime；20 竞争事实 |
| AC-06 | 达成 | 本机 `LocalNodeRunner` 桩 + 本机 Docker 真容器 1/1 + CI ubuntu 容器腿 |
| AC-07 | 达成 | 本机进程级 kill -9 + 进程内注入（25 点） |
| AC-08 | 达成 | 本机真实 git worktree 夹具（6 例） |
| AC-09 | 外部依赖 | 平台协议桩（`ChannelTestServer`）+ 本机 Runtime；真实飞书平台 **0 次** |
| AC-10 | 部分 | 协议桩 20/20 × 2；真实 QQ 平台群 @ 15 + 私聊 1（0 拒绝） |
| AC-11 | 未达成 | **无运行时**（`packages/voice` 仅 README；桌面 Voice 视图占位） |
| AC-12 | 达成 | 本机测试（五类 ≥5）+ M6 真实浏览器逐操作点击 |
| AC-13 | 达成 | 本机回环 20 轮（越权 100/100、去重 160/160）+ 桌面通知中心浏览器走查 |
| AC-14 | 部分 | 本机回环双 Runtime + 飞书协议桩；两轮 20/20；**语音段未达成** |
| AC-15 | 外部依赖 | `StubLocalBridge` 桩；真实微信环境 **0 次** |

- **M5 语音延后（Owner 决定，2026-11-11 确认口径）**：`0.1.0` 的功能范围是 M0–M4，**不含语音**。AC-11 判定**未达成**、AC-14 标注**语音段未达成**；发布说明必须写明「本版不含语音」，不得暗示已具备。`docs/gates/m6-gate-report.md` §4.1 明确：语音**不是 release blocker**，是范围外项。
- **AC-02 与 QQ 真实层的 Owner 决定**：AC-02 的真实双 Provider 验收**待 Owner 配置密钥**（外部依赖，不计达成）；AC-10 真实平台停在群 @ 15/20 + 私聊 1，**Owner 明确不再补测**，按「部分」登记。
- **验证边界（不影响上述判定，但不得宣称已验证）**：真实 Ubuntu systemd 部署（脚本 `scripts/real-machine/server-verify.sh` 已交付并经真机迭代，但**无归档 PASS 日志**）、升级回滚演练、Tailscale 双机、飞书/微信真实层、Windows/Linux 真机桌面安装与凭据库 —— 逐条见门禁报告 §10。
