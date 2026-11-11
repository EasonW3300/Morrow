# Morrow M6 门禁报告与发布裁决（T4 / Issue #55）

**归档日期**：2026-11-11 ｜ **分支**：`m6/t4`（基线 `integration/m0` @ `dde03f1`；T4 仅文档变更）｜ **真机**：MacBook Pro（Mac16,8，Apple M4 Pro，24 GB，macOS 15.5，node v24.22.1 / darwin-arm64）
**父规格**：M6 #51 ｜ **输入**：T1 #52（安全汇总）、T2 #53（UI 走查）、T3 #54（发布工程）｜ **参考环境**：`docs/prd/ac-baseline-m0.md`（§11 为 M6 最终注记）
**发布基调**（M6 #51 Further Notes）：诚实发布 —— 未达项进 release notes，**不用「部分支持」「基本可用」等模糊措辞**。

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| AC-01..AC-15 裁决 | **达成 9 · 部分 2 · 未达成 1 · 外部依赖 3**（另 AC-10a 为 PRD 明示不设验收承诺） |
| 部分 | AC-10（QQ 真实平台 15/20，差 5，Owner 明确不补）、AC-14（除语音段外达成） |
| 未达成 | AC-11（语音，M5 延后 —— Owner 指示） |
| 外部依赖 | AC-02（真实双 Provider 密钥）、AC-09（飞书资质）、AC-15（微信 Windows + 真实桥） |
| PRD §9 M6 门槛 | **6 项全部达成**（含真机 systemd 部署与回滚演练，证据均已归档）——三 OS 打包 / 故障注入 / 安全测试 / 同步冲突 / 文档与自动化验收达成；**「§8 全部强制项达标」字面未满足**，按 Owner 确认的 M0–M4 范围口径发布 |
| **release blocker（阻塞 v0.1.0 发布的工程项）** | **0 项**；语音按「本版功能范围不含语音，发布说明必须写明」处理，**不是 blocker** |
| 外部依赖 | **4 条**（飞书资质 / 微信 Windows+真实桥 / AC-02 双 Provider 密钥 / Tailscale 双机） |
| **发布建议** | **`v0.1.0` 可发布**（按 Owner 确认的 M0–M4 功能范围口径），发布说明必须逐条写全 §6 的 8 条已知限制并与 `CHANGELOG.md` 措辞一致 |

## 1. 裁决口径

- **达成**：存在可复跑命令或具体文件节证据，且证据覆盖 PRD §8 阈值要求。
- **部分**：核心功能或协议层达成，但 PRD 阈值的一部分明确未满足（写明差多少）。
- **未达成**：无运行时实现或 0 次证据。
- **外部依赖**：协议层/代码侧已交付，但完成验收所需的**外部条件不在工程侧**（资质、他人设备/OS、密钥），当前无法补齐。
- **不设承诺**：PRD 原文明确不设验收项（AC-10a）。
- **证据分级**：CI runner 实跑 > 本机回环实跑 > 平台协议桩 > 无归档证据。**无归档证据一律不计入「达成」**（见 §10）。
- 本次复跑环境：node v24.22.1（FTS5 可用）、`pnpm install --frozen-lockfile`、`export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH"`；时间 2026-11-11。

## 2. AC-01..AC-15 逐项裁决

| AC | 名称 | 裁决 | 证据指针（文件节 / 命令） | 备注 |
|---|---|---|---|---|
| AC-01 | 三系统运行 | **达成** | CI run `42975490317`（`dde03f1`）：`build (macos/linux/windows)` + `gate (macos/linux/windows)` 全 success；`docs/gates/m0-gate-report.md` §1（三平台产物 + 探针）、§2.1（macOS 真机启动/退出/重启 + 审计贯通）；复跑 `gh run view 42975490317 --repo EasonW3300/Morrow --json jobs`（逐 job 结论见 §7） | 判定口径承 M0 §4：三平台 CI 实跑单二进制 + 桌面 bundle 产出与探针（含启动/退出/重启、一次对话、工具调用）；**Windows/Linux 桌面安装向导（.nsis/.deb）未在 Owner 真机人工实装**，属验证边界非产品缺陷（§10-V1） |
| AC-02 | 多供应商切换 | **外部依赖（待 Owner 配置）** | 切换 UI/CRUD/四类连通性结果：`docs/gates/m6-ui-walkthrough.md` §1-3；真实双端点证据 **0 次**：`docs/prd/ac-baseline-m0.md` §4（全部证据走本地 mock OpenAI） | 需 Owner 提供两家真实供应商密钥（推荐 DeepSeek + OpenAI 官方）后复跑；现有测试只证明「切换机制不丢任务/不污染会话」，不能替代真实端点验收 |
| AC-03 | 记忆可追溯 | **达成** | `docs/gates/m1-gate-report.md` §2.1（100 条回链 100/100、hash 500/500）；数据集/脚本 `apps/runtime/scripts/memory-ac03.ts`；复跑 `pnpm --filter @morrow/runtime memory:ac03` | 抽取/巩固为确定性启发式（真实 LLM 抽取同 AC-02 边界） |
| AC-04 | 增量双向同步 | **达成（本机回环基线）** | `docs/gates/m3-gate-report.md` §2.1；归档 `docs/gates/m3-ac04-sync.{md,json}`；复跑 `node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac04-sync.ts` | 2 副本各离线 50 条 → 双向对账 **缺失 0 / 重复 0 / 顺序一致**；p95 2.43–2.54 ms ≤10 s。**网络口径仅 127.0.0.1 回环**，真实 Tailscale/Wi-Fi 双机为外部依赖 E4 |
| AC-05 | 冲突和删除 | **达成** | `docs/gates/m3-gate-report.md` §2.2；`docs/gates/m3-ac05-conflicts.{md,json}`；复跑 `… scripts/real-machine/ac05-conflicts.ts` | 20 个竞争事实：**6 自动合并 + 14 待审核**（locked 3 / sensitivity_change 5 / fact_conflict 6），分类 20/20；删除双向不复活（`sync.tombstone_skipped`）；曾登记的跨端可见值缺陷已修复（§6-5/6） |
| AC-06 | 自主 Tool Factory | **达成** | `docs/gates/m2-gate-report.md` §2.1；复跑 `pnpm --filter @morrow/runtime factory:ac06`（桩 20/20：18 走通 + 越权 3 组 100% 阻断）与 `factory:harness:container`（真实容器 1/1）；CI `sandbox tests (ubuntu, real containers)` success | 生成器为脚本化（零 LLM），真实模型生成同 AC-02 边界；分母/走通线已由 ac-baseline §8 定版 |
| AC-07 | Checkpoint/恢复 | **达成** | `docs/gates/m1-gate-report.md` §2.2：**25 点 25/25**（20 恢复 + 5 守卫）；`apps/runtime/test/checkpoint.faults.test.ts` | 门线 ≥19 恢复，分母固定 20；未知状态不自动重发由 `delivery_unknown` 语义 + Outbox 覆盖 |
| AC-08 | 并行子 Agent | **达成** | `docs/gates/m2-gate-report.md` §2.2：**6/6**；`apps/runtime/test/tasks.parallel.test.ts`（真实 git worktree） | 覆盖独立工作区并行、资源锁、冲突 → `pending_review`、verify 失败回滚、残留清扫 |
| AC-09 | 飞书 Bot 稳定闭环 | **外部依赖（协议层达成）** | 协议层 `docs/gates/m4-gate-report.md` §2.1（五面 × **20/20**）+ `docs/gates/m4-ac09-feishu.{md,json}`；复跑 `node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac09-feishu.ts` | **真实平台 0 次**：`app_id/app_secret/verification_token/encrypt_key` 资质未在开放平台注册（CHANGELOG L3）。协议层结果不得冒充真实平台达成 |
| AC-10 | QQ 官方 Bot 闭环 | **部分** | 协议层 `docs/gates/m4-gate-report.md` §2.2（群 @ 20/20、私聊 20/20、主动消息拒绝分类、token 刷新）+ `docs/gates/m4-ac10-qq.{md,json}`；真实平台 `docs/gates/m4-qq-live-evidence.md` §1/§2（**群 @ 15 次 + 私聊 1 次，0 拒绝**） | **真实门线未满：群 @ 15/20（差 5）、私聊 1/20（差 19）**。Owner 明确不再补测，差距如实计入本报告与发布说明；QQ 频道（guild）事件族未接入。这是**部分**，不是外部依赖——补测只需 Owner 在群里 @ 5 次，属未执行而非不可执行 |
| AC-10a | QQ 个人号（原 AC-10 拆分） | **不设验收承诺** | PRD §8 AC-10a（「实验研究项，不设验收承诺」）；PRD §10（重大外部风险） | 不入达成统计 |
| AC-11 | 语音可打断 | **未达成** | `packages/voice/README.md`（「状态（0.1.0）：未实现」）；`CHANGELOG.md` 已知限制 L1；麦克风前置 `docs/gates/m0-gate-report.md` §2.2（待 Owner 手动授权一次） | **M5 延后（Owner 指示）**：VAD / 流式 ASR（字幕）/ 流式 TTS / 打断 **0 行运行时实现**，桌面 Voice 视图为占位；无任何延迟数据，p95 ≤300 ms 无从判定 |
| AC-12 | 人工介入 | **达成** | `docs/gates/m1-gate-report.md` §3：暂停 12 / 修改 5 / 接管 7 / 切模型 5 个独立场景 / 恢复 ≥20 / 交还 5，均 ≥5 且全程审计；M6 正式验收形态 = 真实 UI 点击：`docs/gates/m6-ui-walkthrough.md` §1-2（暂停→修改→接管→完成→恢复、`needs_reconcile` 裁决后落 `task.reconciled`/`task.completed`） | M1 报告登记的「桌面 UI 人工点击」缺口已由 T2 关闭 |
| AC-13 | 通知与权限 | **达成** | `docs/gates/m4-gate-report.md` §2.3 A/B/C：五类越权 **100/100 阻断**、通知 **送达 160 / 去重 160**、桌面消费闭环（`apps/desktop/src/notification-center.test.ts` 17 例）；归档 `docs/gates/m4-ac13-notifications-permissions.{md,json}`；安全汇总域 1/5 `docs/gates/m6-security-summary.md` §2 | 口径差异（如实）：去重键实现为 `task_id+event_type+target`，PRD FR-NOT-1 字面为 `task_id+event_type`；已在 m4-gate §2.5 登记待产品确认 |
| AC-14 | 端到端集成 | **部分（语音段未达成）** | `docs/gates/m4-gate-report.md` §4 + `docs/gates/m4-demo-output.md`（两轮 × 10 项，**20/20 PASS**；第 10 项仅登记语音事实）；复跑 `bash scripts/real-machine/m4-demo.sh` | 链路（渠道发起任务 → 自动建 Tool → 记忆更新 → 并行子任务 → 跨设备查看 → 检查点恢复）**除语音段外全通**；**语音段属 AC-11，未达成**。边界：能力生成器脚本化（零 LLM）、跨设备为 127.0.0.1 双实例回环 |
| AC-15 | 微信个人号实验 | **外部依赖（协议层达成）** | 协议层 `docs/gates/m4-gate-report.md` §2.4 + `docs/gates/m4-ac15-wechat.{md,json}`：白名单收发 20/20、非白名单阻断 20/20、风险确认 409、健康降级/恢复、四类审计、disable 后入站 0；复跑 `… scripts/real-machine/ac15-wechat.ts` | **真实环境 0 次**：需 Owner 的 Windows 机器 + 最新版微信 + 真实本地自动化桥；当前仅可注入 `LocalBridge` 接缝 + `StubLocalBridge`（CHANGELOG L4） |

**统计**：达成 9（AC-01/03/04/05/06/07/08/12/13）｜部分 2（AC-10/AC-14）｜未达成 1（AC-11）｜外部依赖 3（AC-02/09/15）｜不设承诺 1（AC-10a）。

## 3. PRD §9 M6 门槛核对

PRD §9 M6 行：**「三 OS 打包、故障注入、安全测试、同步冲突、回滚、文档与自动化验收」**，门槛「§8 全部强制项达标，未达项明确为 release blocker」。

| # | 门槛 | 判定 | 证据指针 |
|---|---|---|---|
| 1 | 三 OS 打包 | **达成** | CI run `42975490317`：`build (macos/linux/windows)` + `gate (macos/linux/windows)` success，产物 `.app` / `.deb` / `.nsis` + `runtime-binary-*`；`docs/gates/m0-gate-report.md` §1；`docs/release/m6-checklist.md` §3；workflow `.github/workflows/m0.yml` |
| 2 | 故障注入 | **达成** | Checkpoint 25 点（m1 §2.2）；安全汇总域 4/6：沙箱不可用 fail-closed、越界拒绝、租约双持有冻结（`docs/gates/m6-security-summary.md` §3-4/§3-6）；渠道层：QQ 主动消息真实 `40034105` → `proactive_rejected` 不重试（m4-qq-live-evidence §2b）、微信桥崩溃 → `healthy=false/degraded` 并恢复（m4-gate §2.4） |
| 3 | 安全测试 | **达成** | `docs/gates/m6-security-summary.md` §2：**六域 264/264 PASS**；单入口 `pnpm security:suite`（退出码 0/1）；域→断言映射 `docs/security/README.md` |
| 4 | 同步冲突 | **达成** | AC-05：20 竞争事实分类 20/20、双向删除不复活、`needs_reconcile` 冻结交 Owner 裁决（m3 §2.2/§4；`docs/gates/m3-ac05-conflicts.md`） |
| 5 | 回滚 | **达成** | 真机演练通过：`docs/gates/m6-rollback-drill.md`（安装 v1 → `--uninstall` 保留数据 → 校验二进制/unit 移除而数据/身份/env 仍在 → 重装 → **`replica_id` 前后一致**、账本事件 2→4、health 200 → `--purge` 清场无残留）；流程文档 `deploy/README.md` §升级与回滚、发布回滚 `docs/release/m6-checklist.md` §8；复跑 `scripts/real-machine/server-rollback-drill.sh`。未覆盖：跨版本回滚（当前仅一版）与 schema 降级迁移 |
| 6 | 文档与自动化验收 | **达成** | CI 新增 `typecheck + unit tests` job（run `42975490317` success，不再是「CI 只 build 不测」）；文档一致性自检 `docs/release/m6-checklist.md` §4 命令；本报告 §6/§7；README/CHANGELOG/检查表/deploy README 已由 T3 对齐 |

**M6 门槛总判定**：**六项全部达成（按 Owner 确认的发布范围口径）**——三 OS 打包、故障注入、安全测试、同步冲突、**回滚（真机演练）**、文档与自动化验收；**PRD §9「§8 全部强制项达标」字面未满足**（AC-10/11/14 部分或未达、AC-02/09/15 外部依赖）。若 Owner 要求严格按「§8 全部强制项达标」才可发布，则本版**不可发布**；本报告的发布建议基于 M6 #51 已确认的「M0–M4 功能集 + 已知限制明示」基调。

## 4. release blocker 清单

### 4.1 阻塞 v0.1.0 发布的工程项：**0 项**

M6 前置工程门（版本统一、全 workspace typecheck、单测、打包产物、双探针、CI 9/9、文档一致性）全部通过（§7）。不存在「未修完就必须拦发布」的代码缺陷。

**语音缺失不是 blocker，是本版功能范围外，发布说明必须写明**：

> Owner 已决定 M5 实时语音延后。`0.1.0` 的功能范围是 **M0–M4**，**不含语音**。发布说明必须明确写「本版不含语音（VAD/ASR/字幕/TTS/打断均未实现）」，**不得暗示已具备或『即将可用』**。
> —— 依据：M6 #51「已确认的范围决定（Owner 指示）」；`CHANGELOG.md` 已知限制 L1；`packages/voice/README.md`。

### 4.2 按 PRD §9 字面须登记的未达项及处置（不是「先写 blocker 又照发」）

| 未达项 | 裁决 | 处置决定 | 是否拦发布 |
|---|---|---|---|
| 语音（AC-11 + AC-14 语音段） | 未达成 | **移出本版范围**；发布说明首段声明不含语音 | **否**（Owner 已定 M5 延后） |
| 附件文件传输 | 未实现（非 AC 项，FR-DEP-3） | 已知限制明示：只有引用语义，出站附件显式报错 | **否**（不在 v0.1.0 范围，CHANGELOG L2） |
| 飞书真实层（AC-09） | 外部依赖 | 资质注册后按既有脚本复跑 20 次；发布说明写明「协议层已验收，真实平台未联调」 | **否**（外部条件） |
| 微信真实层（AC-15） | 外部依赖 | Owner Windows + 真实桥就绪后补测；发布说明写明「实验适配器，真实环境 0 次」 | **否**（外部条件） |
| QQ 真实层未满（AC-10） | 部分 | 群 @ 15/20 + 私聊 1 次如实写入发布说明；**Owner 明确不补** | **否**（部分达成且差距明示） |
| AC-02 真实双 Provider | 外部依赖 | 发布说明写明「待 Owner 配置密钥」 | **否**（外部条件） |

> 结论：**v0.1.0 无 release blocker**；所有未达项均有明确处置且进入发布说明。**唯一硬性发布条件**是发布说明与 `CHANGELOG.md` 的 8 条已知限制逐条一致（§6）。

## 5. 外部依赖清单

| # | 外部依赖 | 阻塞的验收 | Owner 侧动作 | 当前状态 |
|---|---|---|---|---|
| E1 | **飞书自建应用资质** | AC-09 真实平台 20 次 × 5 面 | 在飞书开放平台注册应用，提供 `app_id` / `app_secret` / `verification_token` / `encrypt_key` | 0 次（资质未注册） |
| E2 | **微信 Windows 环境 + 真实本地桥** | AC-15 真实环境 | 提供 Windows 机器 + 最新版微信；真实自动化桥尚需实现（当前仅 `StubLocalBridge`） | 0 次 |
| E3 | **AC-02 两家 Provider 密钥** | AC-02 真实双端点切换 | 在前端「设置 → Provider 与模型」配置两家 OpenAI 兼容端点 | 0 次（证据全为本地 mock） |
| E4 | **Tailscale 双机** | AC-04 真实网络 p95、AC-14 跨设备真实链路 | 第二台设备加入同一 tailnet；验证非回环 bearer token 双向方向 | 0 次（仅 127.0.0.1 双实例回环） |

> E1–E4 均为**外部条件**，工程侧无阻塞动作。E1/E2/E3 关闭后对应 AC 可由既有脚本复跑；E4 还需补「服务端→加入方」反向 token 发放协议（m3-gate §6-3）。

## 6. 已知限制（与 CHANGELOG 逐条一致，发布说明口径）

`CHANGELOG.md` §「已知限制（0.1.0 如实登记）」共 **8 条**。**发布说明必须直接引用该节 8 条原文**，不得增删、不得改写为更弱的措辞：

| ID | CHANGELOG 条目（标题 + 关键事实） | 关联 AC | 本报告位置 |
|---|---|---|---|
| L1 | **语音（M5）未实现**：VAD / 流式 ASR（字幕）/ 流式 TTS / 打断处理均无运行时实现 | AC-11、AC-14 语音段 | §2 AC-11/AC-14、§4.1 |
| L2 | **附件文件传输未实现**：只有引用语义接缝，无 HTTP 路由/附件目录同步/大文件分块 | 无 AC（FR-DEP-3） | §4.2、§5 |
| L3 | **飞书需自建应用资质**：资质未注册前真实平台 0 次，AC-09 的 20/20 仅证明协议层 | AC-09 | §2 AC-09、§5 E1 |
| L4 | **微信需 Windows + 最新客户端（实验）**：真实本地自动化桥未实现，真实环境 0 次 | AC-15 | §2 AC-15、§5 E2 |
| L5 | **AC-02 真实双 Provider 待 Owner 配置**：CI 与本机证据走本地 mock | AC-02 | §2 AC-02、§5 E3 |
| L6 | **Tailscale 双机未验证**：混合形态只在 127.0.0.1 双进程验证 | AC-04/AC-14（网络口径） | §2 AC-04、§5 E4 |
| L7 | **QQ 真实平台 AC-10 未满**：累计群 @ 15/20 + 私聊 1 次，差 5 次群 @；频道事件族未接入 | AC-10 | §2 AC-10 |
| L8 | **敏感数据加密落盘未实现**：账本与记忆投影明文落盘，依赖 OS 磁盘加密 | PRD §7 残余风险 | §7 残余风险 |

**一致性核对结果**：本报告 §2/§4/§5/§6 与 CHANGELOG 8 条**条目数一致（8/8）、结论一致、无新增/删减**；`docs/release/m6-checklist.md` §0 第 5 项要求的「已知限制与 CHANGELOG 一致」成立。README「当前状态」已知限制摘要已同步为同一 8 条（T4 修订，见 §9）。

## 7. 质量证据汇总

每条只给指针与数值，不复制全文。

| 项 | 结果 | 证据指针 / 复跑命令 |
|---|---|---|
| Runtime 单测 | **738/738 PASS**（40.0s） | `pnpm --filter @morrow/runtime test:unit`（排除 `sandbox.docker.test.ts`、`capability-factory.harness.container.test.ts`；排除口径见 m4-gate §7） |
| Desktop UI/逻辑 | **139/139 PASS** | `pnpm --filter @morrow/desktop test:ui`（T2 的 8 处修复 +6 例：133→139，m6-ui-walkthrough §2.1） |
| Protocol | **40/40 PASS** | `pnpm --filter @morrow/protocol test` |
| PiAdapter | **31/31 PASS** | `pnpm --filter @morrow/pi-adapter test` |
| Packaging 脚本 | **56/56 PASS** | `pnpm --filter @morrow/packaging test` |
| Desktop sidecar（Rust） | **9/9 PASS** | `cd apps/desktop/src-tauri && cargo test`（需 PATH 内含 node ≥22.16；否则 smoke 例失败） |
| **node:test 合计** | **1004/1004**（738+139+40+31+56）；含 Rust 共 **1013** | 上述命令汇总；与 M4 收官 993（m4-gate §7）相比 +11（TECH-DEBT #49/#50 + T2 UI 修复） |
| Typecheck | **5 包全 PASS**（protocol / pi-adapter / runtime / desktop / packaging） | `pnpm -r typecheck`（本次 T4 复跑 exit 0） |
| 安全与故障注入 | **六域 264/264 PASS**（越权 41 / 密钥 61 / CSRF 20 / 沙箱 75 / 同步 44 / 租约 23，非去重） | `pnpm security:suite`；`docs/gates/m6-security-summary.{md,json}`；`docs/security/README.md` |
| CI（发布基线） | run **42975490317**（`dde03f1`）**9/9 success**：typecheck+unit、build ×3、gate ×3、gate report、sandbox 真容器 | `gh run view 42975490317 --repo EasonW3300/Morrow --json jobs` |
| CI（T3 发布准备） | run **42953367507**（`0236012`）9/9 success（版本 0.1.0 / 探针 / gate 结果见检查表） | `docs/release/m6-checklist.md` §5 + §附 |
| 打包产物与探针 | 单二进制 `morrow-runtime-darwin-arm64`；standalone / sidecar 探针 PASS；`gate:runtime` verdict PASS | `docs/release/m6-checklist.md` §附；复跑 `pnpm pack:runtime && pnpm probe:runtime` |
| UI 人工走查 | 7 视图全部通过；**已修 8 处**（F1–F8）；**登记 4 项**（P1–P4） | `docs/gates/m6-ui-walkthrough.md` §1/§2/§3；复跑命令 §5 |
| 真机：macOS GUI | 启动/ready/health/退出/重启 + 审计贯通 PASS | `docs/gates/m0-gate-report.md` §2.1 |
| 真机：QQ 真实收发 | 群 @ 15 次 + 私聊 1 次，15/15 回复，0 拒绝；发现并修复 3 处真实缺陷 | `docs/gates/m4-qq-live-evidence.md` §1/§2/§2b/§2c |
| AC-03 数据 | 100/100 回链、hash 500/500 | m1-gate §2.1 |
| AC-07 故障注入 | 25/25（20 恢复 + 5 守卫） | m1-gate §2.2 |
| AC-04 同步 | 50×2 无丢失/重复/乱序；p95 2.43–2.54 ms | m3-gate §2.1；`m3-ac04-sync.md` |
| AC-05 冲突 | 20/20 分类；删除双向不复活 | m3-gate §2.2；`m3-ac05-conflicts.md` |
| AC-06 工厂 | 桩 20/20（18 走通 + 越权 3 组全阻断）；容器 1/1 | m2-gate §2.1 |
| AC-08 并行 | 6/6 | m2-gate §2.2 |
| AC-09/10/13/15 协议层 | 20/20×5、20/20×2、100/100 + 160/160、20/20 | m4-gate §2.1–§2.4 与各归档 JSON |
| 演示脚本 | m2-demo 10/10 × 2；m3-demo 两轮 20/20；m4-demo 两轮 20/20 | `docs/gates/m2-demo-output.md`、`m3-demo-output.md`、`m4-demo-output.md` |
| **真机：回滚演练** | **达成** | `docs/gates/m6-rollback-drill.md`：安装→卸载(保留数据)→重装，`replica_id` 一致、事件 2→4、清场无残留 |
| **真机：Ubuntu systemd** | **达成** | 证据归档 `docs/gates/m6-ubuntu-systemd-evidence.md`：Ubuntu 22.04.5 / systemd 249，9 项检查全 PASS（active/enabled/health 就绪轮询/数据目录归属/账本落盘/`runtime.started`/重启后健康与账本/`--probe` 含 node:sqlite 3.53.4 与真实 PiAdapter 对话）；清理后各路径为空、端口无残留、磁盘回到验证前水位。复跑：`scripts/real-machine/server-verify.sh` |

## 8. 发布建议

**`v0.1.0` 可以发布**，但**仅限** Owner 已确认的「M0–M4 功能集」口径，并须满足下列发布说明要求：

1. **首段范围声明**：`0.1.0` = M0–M4；**不含语音**（M5 延后）。不得使用「部分支持」「基本可用」「语音即将上线」等措辞。
2. **已知限制**：直接引用 `CHANGELOG.md`「已知限制」8 条原文（L1–L8，§6），不得增删或弱化。
3. **验收状态**：写明「协议层已验收、真实平台未验收」的区分（飞书 0 次 / 微信 0 次 / QQ 15/20 / AC-02 待配置 / Tailscale 未验证）。
4. **发布动作**：合并 `main`、打 `v0.1.0` tag、push **由 Owner 执行**，命令见 `docs/release/m6-checklist.md` §6；Agent 不代跑（本次未执行）。
5. **发布前 Owner 勾选**：`docs/release/m6-checklist.md` §0–§5（其中 §5 的 CI 需在发布 tip 上重新确认——T4 为纯文档提交，最新代码基线 CI 为 run `42975490317` @ `dde03f1`）。
6. **不建议**在关闭 E1/E2/E3 之前对外宣称「飞书/微信可用」「多供应商已验收」。

**若 Owner 选择严格 PRD §9 字面门槛（§8 全部强制项达标）**：则 `v0.1.0` **不可发布**，需先关闭 AC-10（补 5 次群 @ + 私聊）、AC-11（M5）、AC-02/09/15（外部条件）。本报告不替 Owner 做该取舍，只把两条路径的结论并列。

## 9. T4 自身改动与验证

| 文件 | 改动 |
|---|---|
| `docs/gates/m6-gate-report.md` | 本报告（新建） |
| `docs/prd/ac-baseline-m0.md` | 新增 §11 M6 最终注记（最终测试规模、各 AC 判定环境、M5 延后决定） |
| `README.md` | 文档导航去重（M6 UI 走查重复条目）；「当前状态」已知限制摘要补齐为与 CHANGELOG 相同的 8 条；确认 `docs/gates/m6-gate-report.md` 链接可达 |
| `docs/release/m6-checklist.md` | 仅修正「发布提交」表述：`0236012` 标注为发布准备基线，发布 tip 以 §0 `git rev-parse` 为准（M6-T1/T2/T4 合并后前移） |

验证：`pnpm -r typecheck`（5 包 PASS）、runtime 738、desktop 139、protocol 40、pi-adapter 31、packaging 56、Rust 9、安全 264 —— 全部复跑于本工作树，结果与上表一致。**未执行**：合并 `main`、打 tag、push。

## 10. 未验证项与报告边界（如实登记）

| ID | 未验证项 | 为什么不计「达成」 | 关闭方式 |
|---|---|---|---|
| V1 | Windows/Linux 桌面安装向导（.nsis/.deb）人工实装与 GUI 走查 | CI 只验证产物存在 + 单二进制/探针；无 Owner 真机人工安装记录 | Owner 在 Windows/Linux 机器安装并走查；命令见 m6-checklist §3 |
| V2 | ~~升级→回滚→数据恢复演练~~ | **已闭合**（2026-11-11）：真机全流程 PASS，证据 `docs/gates/m6-rollback-drill.md` | — |
| V3 | ~~Ubuntu systemd 真机部署~~ | **已闭合**（2026-11-11）：真机 9 项全 PASS，证据 `docs/gates/m6-ubuntu-systemd-evidence.md` | — |
| V4 | Tailscale/Wi-Fi 真实双机同步 | 全部证据为 127.0.0.1 回环 | E4 |
| V5 | 飞书真实平台 / 微信真实环境 / 真实双 Provider | 外部条件未满足 | E1/E2/E3 |
| V6 | 真实 LLM 的记忆抽取与能力生成 | 证据为确定性启发式/脚本化生成器 | E3 后复跑 `smoke-real-provider` 与 `factory:ac06` 真实模型口径 |
| V7 | Windows/Linux 真实 OS 凭据库 | 仅 macOS Keychain 实测；其余为 exec 桩 | 真机读写一次（m0 §5-1） |
| V8 | 真实容器套件在本机 | 本机不跑 `sandbox.docker.test.ts` / `capability-factory.harness.container.test.ts`（可能挂起）；由 CI ubuntu 腿判定 | CI `sandbox tests (ubuntu, real containers)` |

**报告边界**：本报告只做汇总与裁决，不新增功能、不改产品代码。所有「达成」均可由 §2/§7 的命令或文件节复核；无归档证据的项已在 §10 降级登记，未计入达成。
