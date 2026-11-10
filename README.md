# Morrow

单主人、长期记忆、可自主生成能力的个人 Agent。

**当前状态**：M4 收官（渠道与通知域**协议层达成**：飞书/QQ 适配器、Outbox 外发审计、可信联系人、群聊白名单、通知规则、微信实验适配；**真实平台层未达成**——QQ 真实平台累计群 @ 15/20 + 私聊 1 次、飞书资质未注册、微信需 Owner Windows，见 [M4 门禁报告](docs/gates/m4-gate-report.md) 的双层结论）。M3 收官（三种部署形态、同步引擎、设备配对、离线回放、执行租约交付，见 [M3 门禁报告](docs/gates/m3-gate-report.md)；M2「缺能力→造工具→安全验证→重用」演示达成，见 [M2 门禁报告](docs/gates/m2-gate-report.md)；M1 两项主线门槛达成，见 [M1 门禁报告](docs/gates/m1-gate-report.md)；M0 冒烟门全绿，见 [M0 门禁报告](docs/gates/m0-gate-report.md)）。

## 文档导航

- [PRD v1.0](docs/prd/PRD-v1.0.md) —— 唯一需求真相源
- [GLOSSARY](GLOSSARY.md) —— 领域统一语言
- [ADR 目录](docs/adr/) —— 工程决策记录（含 0007 桌面壳裁决）
- [部署指南](deploy/README.md) —— 三种部署形态（纯本地 / Ubuntu systemd / 本地+服务器混合）、私有网络（Tailscale/WireGuard）、安装升级回滚与备份、部署冒烟脚本
- [M0 门禁报告](docs/gates/m0-gate-report.md) —— CI 三平台 + 真机门禁证据、PRD §9 门槛核对
- [M1 门禁报告](docs/gates/m1-gate-report.md) —— 记忆回链 / 故障注入 / 人工介入覆盖盘点、PRD §9 M1 门槛核对
- [M2 门禁报告](docs/gates/m2-gate-report.md) —— 能力工厂 harness 双路径 / 并行隔离 / 完整演示脚本（[归档输出](docs/gates/m2-demo-output.md)）、PRD §9 M2 门槛核对
- [M3 门禁报告](docs/gates/m3-gate-report.md) —— AC-04 双向同步 50×2 + p95 / AC-05 20 竞争事实 + 删除不复活 / 三部署与 needs_reconcile 证据、PRD §9 M3 门槛核对（[演示输出](docs/gates/m3-demo-output.md)、[AC-04](docs/gates/m3-ac04-sync.md)、[AC-05](docs/gates/m3-ac05-conflicts.md)）
- [M4 门禁报告](docs/gates/m4-gate-report.md) —— 协议层：AC-09 飞书五面 20/20、AC-10 QQ 两路径 20/20、AC-13 越权 100/100 阻断、AC-15 微信实验 20/20、AC-14 两轮 20/20；**真实平台层如实登记为未达成/外部阻塞**（[AC-09](docs/gates/m4-ac09-feishu.md)、[AC-10](docs/gates/m4-ac10-qq.md)、[AC-13](docs/gates/m4-ac13-notifications-permissions.md)、[AC-15](docs/gates/m4-ac15-wechat.md)、[端到端演示](docs/gates/m4-demo-output.md)）
- [QQ 真实平台联调证据](docs/gates/m4-qq-live-evidence.md) —— 真实 QQ 官方 Bot 群 @ 15 次 + 私聊 1 次、0 拒绝；`unknown_conversation` 缺陷发现与修复（未达 AC-10 的 20 次门线）
- [威胁模型](docs/security/threat-model.md) —— 四域威胁、对策与残余风险（PRD §7）
- [M0 验收基线](docs/prd/ac-baseline-m0.md) —— 参考硬件/网络/模型/测试数据（PRD §8 校准基准；§7–§10 为 M1–M4 校准注记）
- [决策稿 V0.6](docs/history/decision-baseline-v0.6.md) —— 归档的 PRD 输入基线

## 仓库结构

```
apps/desktop        Tauri 2 + React 桌面壳（Chat / Task / Voice / 设置）
apps/runtime        核心 Node 应用：编排、记忆、能力、API（单二进制打包）
packages/protocol   事件 schema、API 合约、共享类型（TS + JSON Schema）
packages/pi-adapter Pi 内核版本锁定适配层（ADR-0001）
packages/memory     记忆管线：抽取 / 巩固 / 冲突 / Markdown 投影
packages/sync       副本同步引擎：增量、租约、配对
packages/channels   渠道网关：飞书 / QQ 官方 / 微信实验
packages/capability 能力工厂：生成 / 沙箱验证 / 注册 / 演进
packages/voice      语音管线：VAD / ASR / TTS / 打断
workers/go          Go 组件（系统适配、性能敏感服务、CLI）
docs/prd, docs/adr  PRD 与决策记录
docs/gates          门禁报告归档（docs/security 威胁模型）
docs/history        归档文档
```

## 部署（三形态）

同一个 Runtime（单二进制/同一源码）支持三种形态，详见 [部署指南](deploy/README.md)：

- **纯本地**：桌面壳拉起 Runtime，默认只监听 `127.0.0.1`，零配置可用；
- **纯服务器**：Ubuntu 单二进制 + systemd（`deploy/systemd/morrow.service`、`/etc/morrow/morrow.env`、数据 `/var/lib/morrow`），一键幂等安装 `scripts/deploy/install-ubuntu.sh`；
- **混合**：本地优先、离线可用，重连后经增量同步与服务器对账。

传输默认走私有网络（[ADR-0004](docs/adr/0004-private-network-first-transport.md)：Tailscale/WireGuard），
Runtime 默认不监听公网；非回环访问必须持配对下发的 bearer token。发布前三形态冒烟：
`scripts/deploy/smoke-{local,server,hybrid}.sh`。

## Runtime HTTP API（能力域摘要）

完整端点清单见 PRD §6.2；能力域（M2）端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | /v1/capabilities | 能力清单 / 注册（permissions ⊆ grants 五维判定） |
| GET/PUT | /v1/capabilities/grants | Owner 五维预授权 |
| GET | /v1/capabilities/:id | 详情（当前记录 + verified 已验证标记 + 版本历史） |
| POST | /v1/capabilities/:id/{enable,disable,rollback} | 生命周期（事件驱动同步调用注册表） |
| POST | /v1/capabilities/:id/invoke | **能力调用**（body = 工具 input；`?session_id=` 供归属）。经 ToolInvoker 统一执行链：builtin 进程内直呼、sandboxed 容器执行，权限复核在链上 |
| POST | /v1/capabilities/request | 发起能力生成（工厂闭环） |
| POST | /v1/capabilities/:id/confirm | Owner 确认门（沙箱验证 → 注册，verified=1） |
| GET/POST | /v1/capabilities/skills[...]、/v1/skills[...] | Skill 提案/决策/重用（T6 合约别名） |

设备、配对与同步（M3）端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /v1/devices | 设备列表（`last_sync_at` 由同步引擎在每次成功同步后按 peer 写入） |
| POST | /v1/pairing/codes | 已信任设备生成一次性 6 位配对码（5 分钟 TTL）+ 本机指纹 |
| POST | /v1/pairing/claim | 新设备凭码换取 bearer token（服务端只存哈希） |
| POST | /v1/pairing/join | **本机作为新设备**加入对端：宿主侧 claim + 本地指纹校验 + token 写本机 OS 凭据库 + 对端公钥与地址写设备表；指纹不符则撤销对端信任（rollback）。claim 携带 `device_base_url` 使对端也能反向出站同步。响应 `{device, server_fingerprint}`，**绝不回传 token** |
| DELETE | /v1/devices/:id | 撤销设备（revoked + 审计墓碑） |
| GET | /v1/sync/status | 本副本 sequence + `peers[]`：`last_pulled_sequence` / `last_acked_sequence` / `last_synced_at` / `pending_upload` / `pending_download` / `unreachable` / `unreachable_reason`；顶层 `last_sync_at`。缺省实时探测对端账本上界；`?probe=local` 只回本地快照（传输层防递归）。不可达原因（`no_base_url` / `device_revoked` / `missing_token` / 网络错误）写入 `unreachable_reason` |
| POST | /v1/sync/run | **立即同步一轮**：body 可选 `{peer_replica_id?}`（缺省全部已配对 peer）。对每个 peer 执行 pull→push→push→pull，返回 `{peers[], totals}`（`pulled/pushed/duplicates/gaps/errors`）；单 peer 失败不中断其他 peer，落 `sync.run_completed` 审计 |
| GET | /v1/sync/pull?since=&limit= | 按来源账本 sequence 增量导出事件信封（不复制 DB 文件） |
| POST | /v1/sync/push | 幂等导入（event_id 去重 + integrity 复算 + 缺口拒绝） |
| GET | /v1/sync/conflicts?status= | 跨设备冲突汇总（复用 M1 冲突队列） |

**待同步量口径**：`pending_upload = max(0, 本副本账本最大 seq − 该 peer 的 last_acked_sequence)`；
`pending_download = max(0, 对端账本最大 seq − last_pulled_sequence)`。对端不可达时
`pending_download = null` 且 `unreachable = true`（不伪造 0）。一次 `sync/run` 结束后
`pending_upload` 可能残留少量 `sync.*` 审计事件（本轮 pull 带入的对端审计 + 本条
`sync.run_completed` 尚未推送），下次同步会继续推进。

**附件引用**：M3 只有引用语义接缝——`SyncFileMerger` 提供「整文件按内容寻址 + 双版本保留」的库形态，
无 HTTP 路由、无附件目录同步、无大文件分块；**文件传输未实现**（门禁报告 §6-7）。

**投影随同步重建**：账本是唯一事实源，`memory_facts` 与 `tasks`/`task_nodes`/`task_edges`
都是事件派生投影。同步只传事件信封，因此导入批次落账后会触发投影重建：

- **记忆投影**（`memory/rebuild.ts`）：`memory.*` 事件按序重放 facts / revisions / 来源 / FTS；
- **任务投影**（`task-rebuild.ts`）：`task.*` 事件按序重放任务状态、`task_version`、节点
  状态/结果/attempts/resources/actor 与依赖边。对端任务在 `GET /v1/tasks` 可见、
  `GET /v1/tasks/:id` 返回真实状态（不再是 404）。启动时若「任务表为空但账本有
  `task.*` 事件」也会补建一次；重建是幂等的（重跑同结果）。
- **不自动接管执行权**：重建只写投影，不触发调度器。同步来的未完成任务只读可见，
  执行仍须本地显式 `resume`/`kick` 并经租约；双端独立执行过的任务由
  `needs_reconcile` 冻结交 Owner 裁决。
- **冲突可见值**：待审核冲突期间，`sync.conflict` 的 `remote_event_ids` 只在重放时
  压制**非本副本创作**的远端修订；本地已合并版本保持可见（不会回落到基线）。
  冲突记录同时保留本地版本引用（`local_version`/`local_revision_id`/`local_event_id`）
  与远端事件引用。自动合并结果版本 = `max(本地, 远端) + 1`，重复同步/重放不再递增。

**同步启动接线（M3 同步接线修复 / Issue #34）**：`startRuntime` 启动时即按 `devices`
表构建 `DeviceSyncTransport` 并注入 `SyncEngine`——**独立进程（`main.ts`）的
`POST /v1/sync/run` 不再返回 `ok=false`**。base URL 取设备记录的 `base_url`（join 的
`base_url` 与 claim 的 `device_base_url` 双向写入），bearer token 取本机 OS 凭据库的
`token:<peer replica_id>`；所有出站请求带 `Authorization: Bearer <token>`，无 token 时
不带（回环豁免）并在错误/detail 中标注 `auth: "none"`。设备配对/撤销经回调立即失效
传输缓存，读路径也会按设备表惰性重建。跨网络部署需设 `MORROW_PUBLIC_BASE_URL`
（通配监听地址退化为 127.0.0.1，仅本机可用）。

**跨设备不重复执行（事前互斥）**：任务 acquire 租约前，调度器向全部已配对 peer 做
**一次增量拉取（只 pull 不 push，同任务 500ms 内复用）**，并按
`task.lease_acquired / .renewed / .released / .lost / .execution_transferred` 事件重放
远端租约：远端持有未过期租约 → 本机拒绝 acquire，记 `task.lease_denied`（payload 带
持有者、token、到期、`source: "remote_lease"` 与来源事件），任务保持 planned /
waiting_input；acquire 成功后强制二次采样，若检测到双持有 → 立即释放本地租约并把任务
置 `needs_reconcile`，不执行任何节点。fencing token 仍是副作用提交前的最终护栏。
**残余窗口（诚实边界）**：拉取与 acquire 之间没有共识协议，两端仍可能各自认为对方未
持有；二次采样只能缩小窗口，最终靠 fencing token + Owner 裁决兜底。服务端→加入方的
反向同步在回环下可用；非回环需要部署方为该方向提供 token（当前 join 只向加入方发放
token），见门禁报告 §6。

**调用错误码**：`POST .../invoke`（能力与 Skill 重用共用）的 HTTP 状态按统一契约表映射（单源 `apps/runtime/src/invocation-errors.ts`）：`unknown_tool`→404、`permission_denied`→403、`invalid_sandbox_contract`/`tool_package_unsupported`/`capability_escalation`→400、`sandbox_unavailable`/`image_pull_failed`→503（附 install-hint）、`tool_timeout`→504、`tool_build_failed`→500、工具自身失败（`tool_error`/`tool_exit_nonzero`/`tool_protocol_error`/`tool_output_too_large`）→502。每次调用先落 `capability.used` 审计后返回（Skill 重用另落 `skill.invoked`）。

## 渠道域（M4）

渠道适配器（`ChannelAdapter`）只做平台协议转换；入站统一归一化为 `InboundMessage` 后经
账号/本地身份映射/群白名单/@ 判定进入既有会话链路；助手回复先落 **Outbox**（幂等键唯一），
`dispatchOnce` 经适配器发送，全部外发留 `outbound.*` 审计。管理端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /v1/channels | 适配器清单（账号、状态、capabilities、experimental） |
| GET | /v1/channels/:id/health | 健康检查（状态、连接、token 到期、最近错误） |
| GET | /v1/outbox?status=&limit=&offset= | 外发审计列表 |
| POST | /v1/outbox/:id/retry | 人工重试（needs_review 需 `{"confirmed": true}`） |
| POST | /v1/outbox/:id/mark-sent | 人工标记已送达 |

**飞书 Bot（M4-T3）**：自建应用配置经 SecretStore（`channel:feishu:app_id|app_secret|
verification_token|encrypt_key|bot_open_id`）；事件订阅**优先长连接**（ADR-0004 私有网络，
无需公网回调），签名校验 + Encrypt Key AES 解密，失败事件落
`channel.inbound_rejected`；回复走 reply API 引用原消息；`tenant_access_token` 缓存并在
到期前刷新（失效时刷新一次，仍失败则健康降级）；429/权限不足/主动消息受限按
`explicit` 退避，超时/网络中断归 `delivery_unknown` 不自动重发。`capabilities()` 如实
声明私聊/群 @ supported、群主动消息 limited、附件 limited、编辑 unsupported。
**真实飞书平台联调未做**（开放平台资质未注册）——配置项、联调步骤与
`ChannelTestServer` 复用接口见 [packages/channels/README.md](packages/channels/README.md)。

里程碑与验收标准见 PRD §8/§9。
