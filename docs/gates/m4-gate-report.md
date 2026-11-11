# Morrow M4 门禁报告（T9 / Issue #46）

**归档日期**：2026-11-10 ｜ **分支基线**：`integration/m0` @ 56ca2d2（M4 八张开发票 #38–#45 + QQ 真实联调三轮证据与三处真实缺陷修复；T9 工作树 `m4/t9-gate` 收尾时 merge `integration/m0` 至同 tip） ｜ **真机**：MacBook Pro（Mac16,8，Apple M4 Pro，24 GB，macOS 15.5，Node v24.22.1）
**参考环境**：`docs/prd/ac-baseline-m0.md`（§10 为 M4 校准注记） ｜ **格式基准**：`docs/gates/m3-gate-report.md`

M4 门槛（PRD §9）：**「飞书稳定闭环、QQ 官方闭环、实验适配真实可测且限制清晰」**；对应 AC-09（飞书五面各 20 次）、AC-10（QQ 同法；主动消息受限）、AC-13（通知去重 + 越权 100% 阻断）、AC-15（微信实验适配）、AC-14（端到端集成）。
本票改动力范围：`docs/` + `scripts/real-machine/`；**产品代码零改动**。

**结论先行（双层）**：
- **协议层：达成**。AC-09 五面各 20/20、AC-10 群 @ 与私聊各 20/20、AC-13 越权 100/100 阻断 + 通知去重 160/160、AC-15 白名单收发 20/20 + 风险/健康/日志/关闭全通过；AC-14 两轮 20/20。**桌面通知投递已在 Issue #47 修复后达到端到端**（`tauri-plugin-notification` 系统通知 + 应用内通知中心，权限被拒时降级），见 §2.3-C。
- **真实平台层：未达成（外部依赖阻塞 + QQ 统计未满）**。QQ 官方 Bot 有**累计群 @ 15 次 + 私聊 1 次、0 拒绝**的真实闭环（AC-10 门线 20 次差 5）；**飞书真实平台 0 次（资质未注册）**；**微信真实环境 0 次（需 Owner Windows 机器，真实桥未实现）**。均**不得标完成**。

## 1. CI 证据（integration/m0）

| 项 | 值 |
|---|---|
| 当前 tip | 56ca2d2（fix(#41): 真实平台主动消息拒绝码 40034105 归入 proactive_rejected + 测试桩六选项生效修复 + 回归测试） |
| 最新 run | [42789125967](https://github.com/EasonW3300/Morrow/actions/runs/42789125967)（push integration/m0，2026-11-10T09:15:07Z，约 4m25s）—— **success**（8 job 全绿） |
| Job 明细 | `build (linux/macos/windows)` success；`gate (linux/macos/windows)` success；`gate report (aggregate)` success；`sandbox tests (ubuntu, real containers)` success |
| 部署冒烟 | `gate (linux)` 的 **Deployment smoke (server form, systemd-equivalent)** step success（与 M3 同一口径） |
| 前一条相关 run | [42787554146](https://github.com/EasonW3300/Morrow/actions/runs/42787554146)（5bd31df，QQ 第二轮证据）success；[42782700300](https://github.com/EasonW3300/Morrow/actions/runs/42782700300)（merge M4-T4 QQ 适配器）success |

M4 专属门禁项（AC-09/10/13/15 协议层复跑、AC-14 两轮演示）不在 CI 判定内，由本报告 §2–§4 在合并态本机补齐——与 M0–M3 报告「CI 边界」同一处置。
**CI 边界**：CI 只跑 `build`（esbuild）、`sandbox tests` 与 gate 探针，**不运行 `tsc --noEmit` 与单元测试**；因此 CI success 不覆盖 §7 记录的合并态 typecheck 基线缺陷。

## 2. 协议层逐项结果（本机，56ca2d2 + T9 工作树；node v24.22.1）

复跑脚本（可重复执行，零真实网络：真实适配器 + 共享 `ChannelTestServer` 平台桩 + 真实 Runtime + 真实 HTTP 控制面）：

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac09-feishu.ts --out docs/gates
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac10-qq.ts --out docs/gates
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac13-notifications-permissions.ts --out docs/gates
node --experimental-sqlite --experimental-strip-types scripts/real-machine/ac15-wechat.ts --out docs/gates
```

### 2.1 AC-09 飞书 Bot（5 面 × 20 轮）—— **20/20 × 5 PASS**

方法：真实 `FeishuChannelAdapter`（Verification Token + AES-256-CBC 解密）+ `ChannelTestServer`（飞书 Open API 形状、HTTP 长轮询模拟事件到达）；每轮固定四类入站（私聊 / 白名单群 @ / 联系人邀请码 / 任务关联消息），每轮四类回复全部经 Outbox 投递并与平台 reply 计数逐条对账。

| 面 | 结果 | 证据 |
|---|---|---|
| 私聊（p2p 入站 → 回复） | **20/20** | 签名/解密 → 统一入站 → 会话 → Outbox → reply API |
| 群 @（白名单 `mention_only`） | **20/20** | 提及 bot 才处理；未 @ 由路由套件锁定不响应 |
| 可信联系人授权 | **20/20** | 一次性邀请码经渠道回复绑定；`permission_context.principal=contact:<id>`，默认仅 `query` |
| 外发审计 | **20/20**（80 条） | 每组 4 条 `outbound.queued`/`outbound.sent`，平台回执 80/80 |
| 任务关联 | **20/20** | 中间路由写入消息 `task_id` 列 + 事件信封 `task_id`；平台原始记录保持原样 |

汇总：入站 80、Outbox queued/sent 80/80、平台回执 80、联系人绑定 20、会话 61。能力声明：`direct=supported / group_mention=supported / group_proactive=limited / attachments=limited / edit=unsupported`。
归档：`docs/gates/m4-ac09-feishu.{md,json}`。

### 2.2 AC-10 QQ 官方 Bot（群 @ 与私聊各 20 轮）—— **20/20 × 2 PASS**

方法：真实 `QqChannelAdapter`（Ed25519 事件签名校验 + access token 缓存/刷新）+ `registerQqTestStub`（官方 API v2 形状：`/app/getAppAccessToken`、`/v2/groups/{id}/messages`、`/v2/users/{id}/messages`）。

| 面 | 结果 | 证据 |
|---|---|---|
| 群 @ | **20/20** | 白名单 `mention_only`；被动回复带原 `msg_id`/`msg_seq`，`proactive=false` |
| 私聊（C2C） | **20/20** | 端点 `/v2/users/{openid}/messages`；与群消息可区分 |
| 外发审计 | **20/20**（40 条） | 每轮 2 条 `outbound.sent` 与平台侧群/私聊计数对账 |
| 主动消息受限 | 声明 + 拒绝分类 **PASS** | `group_proactive=limited`；桩侧拒绝（304046）→ `proactive_rejected` → `needs_review`；`outbound.failed(will_retry=false)` + `outbound.reviewed`；10 分钟后重试尝试 = 0。真实平台 `40034105` 已入不可重试码表（§3） |
| access token 刷新 | **PASS** | 平台侧过期 → 刷新一次后回复成功，仅发一次 |

归档：`docs/gates/m4-ac10-qq.{md,json}`。

### 2.3 AC-13 通知与权限（20 轮）—— **越权 100% 阻断 + 去重 160/160 PASS**

**A. 可信联系人五类越权（5 类 × 20 次 = 100 次）**

| 类别 | 动作 | 尝试 | 阻断 | 原因 |
|---|---|---|---|---|
| private 记忆 | `memory_read(sensitivity=private)` | 20 | **20** | `private_memory_denied` |
| 文件 | `filesystem` | 20 | **20** | `filesystem_denied` |
| 开发工具 | `shell` | 20 | **20** | `dev_tools_denied` |
| 未授权能力 | `capability(memory.write)` | 20 | **20** | `capability_not_granted` |
| 他人会话 | `session(owner_session)` | 20 | **20** | `session_not_owned` |

合计 **100/100 阻断（100%）**，`contact.permission_denied` 审计 100 条；对照组 public 记忆 20/20 放行（额度 `memory_reference`）。

**B. 通知规则与去重**：8 条规则（completed / failed / waiting_input / milestone × desktop / channel:echo）；20 轮每类事件向两个目标各投递 2 次 → **送达 160 条、重复被去重 160 条**（第 2 次投递 100% 抑制）；历史 160 条（desktop pending 80 / channel sent 80），渠道通知全部经 Outbox → echo 适配器实发 80。
口径与既有 `contacts.permissions.test.ts`、`notifications.service.test.ts` 同源。归档：`docs/gates/m4-ac13-notifications-permissions.{md,json}`。

**C. 桌面通知投递（Issue #47 修复后）—— 端到端达成（系统通知 + 应用内通知中心）**

修复前：runtime 的 `GET /v1/notifications/pending` / `POST /v1/notifications/:id/ack` 已实现，但 desktop 从不拉取，pending 行停在数据库里（「服务端达标、端上没接」的假完成）。修复后：

| 环节 | 实现与证据 |
|---|---|
| 系统通知 | Tauri v2 官方 `tauri-plugin-notification`（Rust `2.8.0` + JS `2.8.0`）：`Cargo.toml` 依赖、`main.rs` `.plugin(tauri_plugin_notification::init())`、`capabilities/default.json` 增 `notification:default` |
| 消费闭环 | 默认 10s 轮询 `GET /pending`（URL `?notification_poll_ms=` / `VITE_NOTIFICATION_POLL_MS` 可配，0 关闭）→ 逐条展示 → 成功后 `POST /:id/ack`；ack 失败指数退避重试（上限 3 次），日志只记 id/事件类型/正文长度，不打印正文 |
| 去重 | 同一 notification id 会话内只弹一次（端侧 Set）；服务端 status 兜底（已 ack 的不再出现在 pending） |
| 应用内中心 | 顶栏铃铛 + 未读数（= pending 条数）；列表含时间/事件类型/任务标题（可跳转）/正文摘要；「全部标记已读」逐条 ack；空态文案 |
| 权限降级 | 首次启动请求一次；被拒后写本地标记不再自动弹系统授权框，通知保留在 pending 仅应用内展示，面板顶部有说明与「重新请求权限」按钮 |
| 单元测试 | `apps/desktop/src/notification-center.test.ts` 17 例（轮询状态机、去重、ack 退避、权限降级、未读计数、全部已读、任务 id 解析、间隔配置） |
| 浏览器级走查 | `channel-fixture` 预置 3 条 pending（completed / failed / 免打扰到点）：铃铛 3 条未读 → 面板 3 项 + 权限拒绝文案 → 点任务标题跳转正确任务 → 「全部标记已读」后 `GET /pending` = 0、history 三条 `sent` |

平台边界：macOS 的系统通知权限由 OS 授予（打包应用首次运行弹系统框）；权限被拒时桌面端不重复打扰、功能完整降级为应用内通知中心。浏览器联调（无 Tauri）恒为应用内模式，可用 `?notification_permission=denied` 复现拒绝态文案。

### 2.4 AC-15 微信个人号实验适配器（20 轮）—— **PASS（桩）**

| 项 | 结果 |
|---|---|
| 配置与环境声明 | 出厂 `disabled`；`experimental=true`；`environment={os:"Windows", client:"最新版微信"}`；风险文案常驻（`默认关闭`/`风险自担`） |
| 风险确认 | 未带 `confirm_risk` → **409 `risk_confirmation_required`**；确认后 200，`channel.experimental_enabled` 审计 1 条 |
| 白名单收发 | **20/20**（桥实发 20 条） |
| 非白名单阻断 | **20/20**（无外发；`inbound_rejected reason=conversation_not_allowed`） |
| 健康检查 | 初始 `healthy=false`（stopped）→ 故障注入 `healthy=false / connection=degraded / last_error=bridge crashed`（process=error、login=logged_out、window=unavailable）→ 恢复 `healthy=true` |
| 日志可诊断 | `channel.adapter_started` / `channel.experimental_enabled` / `channel.inbound_received` / `channel.inbound_rejected` 全部留痕 |
| 关闭 | `disable` 200；桥断开；清单 `enabled=false / state=stopped`；禁用后入站 0 条；`channel.adapter_stopped` 审计 |

归档：`docs/gates/m4-ac15-wechat.{md,json}`。

### 2.5 生产接线缺口修复（A1–A4 / Issue #37，#47 同批审查发现）—— **PASS（本机回归）**

T9 报告此前只测到「协议层功能在测试/脚本里成立」，未覆盖生产入口接线。本批修复四项并补测试（`apps/runtime/test/`）：

| 项 | 修复前 | 修复后 | 证据 |
|---|---|---|---|
| **A1 生产入口注入渠道适配器** | `startRuntime` 不注入任何适配器；飞书/QQ/微信只在测试与 `scripts/real-machine/*` 被 `new`。真实桌面/服务器 `/v1/channels` 为空，UI 配好凭据也无效 | `channels/bootstrap.ts` 按 SecretStore 已配置凭据（`channel:feishu:app_id`、`channel:qq:app_id`、`channel:wechat:*`）自动构造并注册；缺省 disabled（`channel_settings` 持久化，读既有状态），缺字段/启动失败降级为 health 可见的 error，不阻断 Runtime；稳定渠道可由 `POST /v1/channels/:id/enable` 显式启用，微信仍出厂 disabled + `confirm_risk` | `channels.bootstrap.test.ts`（飞书+QQ 自动列出/缺省 stopped/health/enable/跨重启持久化；未配置渠道不出现；微信 confirm_risk；缺字段 error 不阻断） |
| **A2 Outbox 自动投递循环** | `dispatchOnce` 只有通知 drain 会调；入站回复 enqueue 后无人投递，人工 retry 也只改状态 | Runtime 启动 `outboxDrainIntervalMs`（默认 1000ms，0 关闭，`unref()`）定时 drain；启动即接 Outbox→Channel 桥，关闭时清理 | `outbox.drain.test.ts`（enqueue 后不手动 dispatch → 一个周期内 sent 且平台桩收到一次；间隔 0 不自投） |
| **A3 通知的渠道目标解析** | 渠道通知目标硬编码 `{kind:"user", id:"owner"}`，飞书/QQ 适配器无法解析 | 新表 `channel_notify_target`（channel→native_conversation_id）+ `GET/PUT /v1/channels/:id/notify-target`（校验会话已存在/已白名单）；未配置时规则保存 400 `notify_target_required`（不再运行时静默失败）；投递 target 为 `{kind:"conversation", id:<指定会话>}` | `notifications.notify-target.test.ts`（未配置 400、未知会话 400、配置后经 Outbox 发到指定会话） |
| **A4 联系人授权接进入站路由** | 入站 `permission_context` 生成后不调用 `authorizeContactUse`，类别授权只存不判 | 入站解析出 `contact:<id>` 后按消息意图（query / task_execute / memory_reference）调用 `PermissionEngine.authorizeContactUse`；拒绝 `channel.inbound_rejected(reason=contact_permission_denied)` 且不回复；判定类别与依据随 `channel.inbound_received.permission_decision` 留痕；联系人会话工具经 `contactCapabilitiesForSession` 收窄 | `channels.contact-authorization.test.ts`（仅 query 联系人触发任务执行 → 拒绝留痕；public 记忆放行、private 拒绝；工具收窄 []） |

**通知去重口径差异（如实登记）**：PRD FR-NOT-1 字面写「去重键 `task_id+event_type`」，实现为 `task_id+event_type+target`（不同目标各自投递一次，Outbox 幂等键 = 去重基键 + 窗口起点）。差异原因：桌面与各渠道目标互不替代，若按 PRD 字面去重，多目标配置下只会有第一个目标收到通知。当前实现与 AC-13 的「通知按规则去重送达」一致，但**不满足 PRD 字面**；已在此登记，需产品确认是否修订 PRD 或收窄实现。

## 3. 真实平台层（逐项登记，不标完成）

| 项 | 状态 | 证据/边界 |
|---|---|---|
| **QQ 官方 Bot** | **部分达成（未达 20 次门线）** | `docs/gates/m4-qq-live-evidence.md`：真实平台累计**群 @ 15 次**（首轮 1 + 第二轮 14；其中 10 次仅 @ 不带正文）+ **私聊 1 次**，**0 拒绝**，Owner 侧确认收到。第二轮单轮表格为「群 @ 14 + 私聊 1 = 15 条入站、15/15 回复」 |
| QQ 主动消息真实限制 | 已实测（分场景） | 群主动消息 **HTTP 400 `code=40034105`「无权限」** → `proactive_rejected`（不可重试）；私聊主动消息 **HTTP 200**（平台额度内可发）。印证 `group_proactive=limited` 的声明；两者不得混为一谈 |
| QQ 真实缺陷与修复（三处） | 已闭环 | ① `unknown_conversation`：WS 可信入站未学习会话形态 → 能收不能回（`73cf438`）；② `40034105` 未入不可重试码表 → 群主动消息被拒会被反复重试（`56ca2d2`）；③ 测试桩六个注入选项声明后未赋值（故障注入静默无效，测试假绿来源，`56ca2d2`）。均有回归测试 |
| QQ 未覆盖 | 如实登记 | 群 @ **20 次门线差 5**；私聊仅 1 次（20 次门线差 19）；真实链路 Outbox 幂等/未知状态与外发审计逐条落库核对未做 |
| **飞书 Bot** | **未达（外部依赖阻塞）** | 自建应用资质未注册（PRD §10 前置清单仍未完成）；真实平台 0 次。协议层证据见 §2.1 |
| **微信个人号实验** | **未达（外部依赖阻塞）** | 需 Owner Windows 机器 + 最新版微信 + 真实本地自动化桥；M4 只交付可注入 `LocalBridge` 接缝与 `StubLocalBridge` 桩验证（§2.4），真实桥未实现 |

**真实平台层判定：未达成**。QQ 有 1 个方向的部分真实闭环（群 @ 15/20 + 私聊 1 次，0 失败），飞书/微信为 0；按票面要求不以协议桩结果冒充真实平台达成。

## 4. AC-14 端到端集成（两轮 × 10 项）—— **20/20 PASS**

方法：每轮独立起两个 Runtime（A/B，独立 dataDir / replica_id / 端口），A 注入真实飞书适配器 + 平台桩；真实 HTTP 接缝完成配对（`POST /v1/pairing/join`）与双向同步（`POST /v1/sync/run`）。入口 `bash scripts/real-machine/m4-demo.sh --out docs/gates/m4-demo-output.md`（薄包装 `m4-demo.ts`）。
归档全文：`docs/gates/m4-demo-output.md`。

| # | 断言 | 结果 |
|---|---|---|
| 1 | 渠道入站（飞书桩 → 统一入站 → 会话） | PASS |
| 2 | 渠道发起任务（`POST /v1/tasks` 携带渠道 `session_id`） | PASS |
| 3 | 任务关联（中间路由 `task_id`，原始记录不改写） | PASS |
| 4 | 自动建能力（request → 沙箱验证 4/4 → Owner 确认注册 `author=ai disabled`） | PASS |
| 5 | 记忆更新（渠道轮次自动抽取 → 巩固为 public 事实 → 检索可查） | PASS |
| 6 | 跨设备查看（同步后 B `GET /v1/tasks/:id`=completed、记忆事实可见） | PASS |
| 7 | 检查点恢复（pause → checkpoint 快照 → restore 202 → completed，节点 a/b 结果齐全） | PASS |
| 8 | 外发审计（3 条渠道回复 → Outbox → `outbound.queued/sent` 3/3） | PASS |
| 9 | 通知去重（完成事件 desktop pending + 重复抑制 1）+ 五类越权 5/5 阻断 | PASS |
| 10 | 语音段（AC-11，打断/字幕/ASR/TTS）—— **M5 未实现，如实标注** | PASS（仅登记事实，不作为达成） |

边界：演示的「渠道发起任务」由脚本把渠道入站文本转为 `POST /v1/tasks`（携带渠道 `session_id`）；产品尚无自然语言任务意图派生路径，任务创建与渠道关联本身是真实端点。能力生成器为脚本化实现（零 LLM），沙箱为本地桩 Runner（与 AC-06 桩路径同源）。

## 5. PRD §9 M4 门槛逐项核对

| 门槛 | 判定 | 证据指针 |
|---|---|---|
| 飞书稳定闭环 | **协议层达成；真实平台未达成（外部阻塞）** | §2.1（五面 20/20）；§3 资质未注册 |
| QQ 官方闭环 | **协议层达成；真实平台部分（群 @ 15/20 + 私聊 1 次，0 失败；主动消息群拒/私聊可发已实测）** | §2.2（两路径 20/20）；§3 `m4-qq-live-evidence.md` |
| 实验适配真实可测且限制清晰 | **限制清晰、协议层可测；真实环境未达（外部阻塞）** | §2.4；§3 需 Owner Windows；风险声明 UI/文档双处（T5/T8） |
| AC-09 五面各 20 次 | **协议层 20/20 × 5** | §2.1；`m4-ac09-feishu.{md,json}` |
| AC-10 同法 + 主动消息受限 | **协议层 20/20 × 2 + 受限拒绝分类** | §2.2；`m4-ac10-qq.{md,json}` |
| AC-13 通知去重 + 越权 100% 阻断 | **达成（协议层 + 桌面消费端）**：100/100 阻断；通知 160 送达/160 去重；桌面 pending 消费闭环（Issue #47） | §2.3 A/B/C；`m4-ac13-notifications-permissions.{md,json}` |
| AC-15 微信实验 | **协议层达成（桩）；真实环境未达** | §2.4；`m4-ac15-wechat.{md,json}` |
| AC-14 端到端 | **达成（两轮 20/20；语音标注 M5）** | §4；`m4-demo-output.md` |
| 全 workspace 测试绿 | **node:test 套件达成（969/969 + Rust 9/9）；严格口径未达成（typecheck 基线缺陷）** | §7：合并态 56ca2d2 的 `tsc --noEmit` 失败于 `QqTestStubOptions` 未声明六个注入选项（非 T9 改动，§6-13） |

**M4 门禁判定：协议层通过；真实平台层未通过（条件性未达成）**。PRD §9 M4 的「飞书稳定闭环」完全依赖尚未注册的飞书自建应用资质；「QQ 官方闭环」真实平台统计为群 @ 15/20；「实验适配真实可测」依赖 Owner Windows 机器。协议层证据充分且可重复，但不能替代真实平台门线。

## 6. 未达项与边界（如实登记）

1. **QQ 真实平台 20 次门线未满**：群 @ 累计 15 次（差 5）、私聊 1 次（差 19）。真实轮次需 Owner 在 QQ 群里配合；本轮不推送、不自动触发。
2. **飞书真实平台未联调**：自建应用资质未注册（PRD §10 前置清单未完成）。飞书长连接为官方 SDK WebSocket，脚本用同 base_url 的 HTTP 长轮询模拟事件到达语义（`packages/channels/README.md`）；真实长连接、签约与限流未验证。
3. **微信真实桥未实现**：M4 只交付 `LocalBridge` 可注入接缝 + `StubLocalBridge`；真实 Windows/最新版微信自动化桥、登录态、窗口句柄与风控对抗均未实现（PRD §10 重大外部风险）。
4. **附件/文件传输未做**：入站只保留平台附件引用；出站附件投递显式报错（`capabilities.attachments=limited`）；飞书/QQ/微信均无文件搬运。PRD FR-DEP-3 的附件引用仅有引用语义。
5. **QQ 频道消息 / `AT_MESSAGE_CREATE` 未接入**：当前只处理群 `GROUP_AT_MESSAGE_CREATE` 与单聊 `C2C_MESSAGE_CREATE`；QQ 频道（guild）事件族未实现。
6. **主动消息真实限制仅部分验证**：QQ 已取得真实分场景证据——群主动消息 `40034105`（无权限）被正确归类为 `proactive_rejected` 且不重试，私聊主动消息平台额度内可发（200）；但飞书主动消息真实限制、QQ 频控/额度上限/多场景拒绝码仍未实测。`proactive_limited` 白名单模式在路由层允许非 @ 处理，实际额度仍以平台为准。
7. **真实外发审计未核对**：真实 QQ 闭环未做 Outbox 幂等键、未知状态（`delivery_unknown`）与账本 `outbound.*` 逐条对账；协议桩层已在 AC-09/10 覆盖。
8. **真实 Tailscale/Wi-Fi 双机未验证**：AC-14 的跨设备查看是 127.0.0.1 单机双实例回环基线（承 M3 §6-8）；非回环认证链路具备接缝，但双机跨网络未实测。
9. **真实 LLM 能力生成未跑**：AC-14 的能力工厂生成器为脚本化实现（FakePi 同款，零网络），沙箱为 `LocalNodeRunner` 本地桩；真实模型生成与真实容器验证由 M2 口径与 CI ubuntu 容器腿承载。
10. **桌面 UI 人工点击走查**：渠道/联系人/通知/Outbox 控制面与 `channel-fixture` 浏览器级验证已完成；桌面通知消费端（Issue #47）已补上并做了浏览器级走查（§2.3-C）。打包 Tauri 应用的系统通知人工点击验收仍归 M6 全量验收；macOS 权限被拒时自动降级为应用内通知中心，不重复弹系统授权框。
11. **语音段属 M5**：AC-11（打断 p95 ≤300ms、字幕、本地/云端切换）无 M4 实现与证据；AC-14 第 10 项只登记该事实。
12. **群聊 proactive_limited 语义**：`proactive_limited` 白名单模式在路由层允许非 @ 处理，但真实平台的主动消息额度/场景仍以平台为准，不承诺无限推送（PRD FR-NOT-4）。
13. **合并态 typecheck 基线缺陷（已修复）**：`QqTestStubOptions`（`apps/runtime/src/channels/testing/qq-stub.ts`）曾缺 `rejectProactive` / `rejectAllTokens` / `failTokenEndpoint` / `rateLimit` / `mode` / `signatureMode` 六个字段，导致 56ca2d2 合并态 `tsc --noEmit` 7 处报错。已由 `4e43c03`（fix(#41)）补齐，本 tip（1ca9cce）的 `pnpm --filter @morrow/runtime test` 前置 typecheck 通过。
14. **生产接线缺口（此前未登记，已修复）**：A1 生产入口不注入适配器、A2 Outbox 无自动投递、A3 通知渠道目标硬编码 owner、A4 联系人授权未接入站路由。四项修复与测试证据见 §2.5；不属于真实平台层，但属于「功能只在测试/脚本成立、生产入口没接」的假完成风险，已按生产入口回归覆盖。

## 7. 测试规模与最终验证

`pnpm install` 后按包执行（runtime 排除两个真实容器套件，精确口径：
`grep -vE "^test/(sandbox\.docker\.test|capability-factory\.harness\.container\.test)\.ts$"`；
desktop 测试前先 `pnpm --filter @morrow/runtime build`）：

| 套件 | 结果 |
|---|---|
| runtime（node:test，排除容器套件） | **733/733 PASS**（新增 A1–A4 生产接线 7 例） |
| protocol | 40/40 |
| pi-adapter | 31/31 |
| desktop（node:test） | **133/133**（Issue #47 新增通知中心 17 例） |
| desktop sidecar（cargo test） | 9/9 |
| packaging | 56/56 |
| **node:test 合计** | **993/993**（M4 收官 969 + Issue #47 通知中心 17 + A1–A4 生产接线 7） |

真实容器套件（`sandbox.docker.test.ts` / `capability-factory.harness.container.test.ts`）按票面要求本机不跑（docker 可能挂起），由 CI ubuntu 腿 `sandbox tests (ubuntu, real containers)` 独立判定（最新 run success，§1）。

**typecheck 现状**：`4e43c03` 已补齐 `QqTestStubOptions` 六字段，本 tip 的 runtime / protocol / pi-adapter / packaging / desktop 的 `tsc --noEmit` 全部通过（desktop 另通过 Tauri 插件 `cargo test` 编译）。Issue #47 的通知中心改动新增 `notification-center.ts` / `notification-system.ts` / `NotificationCenter.tsx` 与 17 例纯逻辑测试；A1–A4 生产接线新增 7 例 runtime 测试，均并入上表。

## 8. 结论

**M4 门禁：协议层通过，真实平台层未达成；另有合并态 typecheck 基线缺陷 —— 双层结论 + 一个基线阻断项，不合并宣称完成。**

- **达成的部分（协议层 + 桌面消费端 + 生产入口）**：AC-09 飞书五面各 20/20；AC-10 QQ 群 @ 与私聊各 20/20 + 主动消息受限/拒绝分类（真实 `40034105` 已入表）+ token 刷新；AC-13 五类越权 100/100 阻断、通知 160 送达/160 去重，且桌面端完成 pending → 系统通知/应用内中心 → ack 闭环（Issue #47）；AC-15 风险确认/白名单收发/健康/日志/关闭 20/20；AC-14 两轮 20/20；A1–A4 生产入口接线（渠道自动装配 / Outbox 自动投递 / 通知目标解析 / 联系人授权入路由）7 例回归；全 workspace 993 node:test + 9 Rust 全绿、typecheck 全绿；CI 8 job success。
- **未达成的部分（真实平台层）**：飞书 0 次（资质未注册）；微信 0 次（真实桥未实现 + 需 Owner Windows）；QQ 累计群 @ 15/20（差 5）+ 私聊 1 次。QQ 真实平台还发现并修复了三处缺陷（`unknown_conversation` 适配器缺陷、`40034105` 不可重试码表缺失、测试桩注入选项失效），这本身是真实层证据，但不改变 20 次门线未满的事实。

**基线阻断项（已解除）**：合并态 56ca2d2 的 `QqTestStubOptions` 缺六个注入选项字段导致 `tsc --noEmit` 失败（§6-13/§7），已由 `4e43c03` 修复；本批 A1–A4 后全 workspace typecheck 仍全绿。

**后续最小闭环建议**：① 完成飞书自建应用注册后，用同一套脚本（仅改 base_url/凭据）跑真实 20 次；② Owner 在 QQ 群补足 5 次群 @ 并做私聊 10+ 次，补齐真实外发审计对账；③ 启动微信真实桥（Windows）或明确降级为实验说明；④ 附件文件传输与 QQ 频道消息按后续票评估；⑤ M5 语音交付后补 AC-11 与 AC-14 语音段。
