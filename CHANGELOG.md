# 变更日志

本文件记录 Morrow 的对外可见变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本；当前发布版本为 `0.1.0`，版本号唯一来源是各 workspace `package.json`
（Runtime 的 ready 行与 `/v1/health` 均从 `apps/runtime/package.json` 读取，不设双真相源）。

## [0.1.0] - 2026-11-11

首个可发布版本：M0–M4 里程碑合并态（M5 语音不在范围内）。逐项门禁证据见
[`docs/gates/`](docs/gates/)，发布步骤见 [`docs/release/m6-checklist.md`](docs/release/m6-checklist.md)。

### M0 —— 骨架、对话与冒烟门

- 事件信封 schema v1：统一事件族、前后向兼容校验、完整性 hash
- Runtime 骨架 + append-only SQLite 事件账本（`node:sqlite`，WAL、幂等导入、缺口拒绝）
- PiAdapter 版本锁定适配层 + FakePi 契约套件（ADR-0001）
- 对话贯通：Session API、SSE 流式事件、对话全量落账
- Provider 配置、OS 凭据库（Keychain / 凭据管理器 / secret-tool / 内存回退）与切换
- 桌面壳（Tauri 2 + React）+ Runtime sidecar + Chat 视图；设置与健康 UI
- Runtime 单二进制打包（bun compile）+ standalone / sidecar 启动探针
- 三平台 CI 矩阵（macOS / Linux / Windows）与冒烟门；ADR-0001..0008、威胁模型、AC 基线

### M1 —— 记忆与任务

- `memory.write` 工具 + 高价值规则即时写入候选 + FTS5 检索
- 后台抽取与巩固管线：MemoryFact + MemoryRevision 版本链，冲突进待确认队列
- 长期记忆 Markdown 投影（幂等再生成）、受控导入、软删 tombstone（重投影不复活）
- 任务 DAG 与调度器；Checkpoint 与中断恢复
- 人工介入（awaiting_input / 审批）与 Task 视图

### M2 —— 能力工厂

- 能力注册表与五维权限模型（permissions ⊆ grants）
- 沙箱执行 Worker：Docker 容器、`--network none`、超时与输出上限
- Tool Factory 生成闭环：propose → 沙箱验证 → Owner confirm → 注册（author=ai，默认 disabled）
- 动态多 Agent 与工作区隔离
- Skill 提案 / 决策 / 进化 / 重用
- 能力管理 UI（清单、详情、启用/停用/回滚、调用）

### M3 —— 同步、配对与部署

- 同步引擎：按 `(replica_id, sequence)` 增量 pull/push，`event_id` 幂等去重，缺口拒绝，不复制活跃 SQLite
- 设备配对与设备身份：一次性配对码 + 公钥指纹 + bearer token（服务端只存摘要）
- 记忆 / 删除 / 冲突同步语义：tombstone 不复活、冲突可见值、`needs_reconcile` 冻结交 Owner 裁决
- 执行租约与 fencing token：跨设备不重复执行同一任务（事前互斥 + 二次采样）
- 三种部署形态（纯本地 / Ubuntu systemd / 混合）+ 私有网络优先（ADR-0004）+ 安装升级回滚备份与部署冒烟
- 同步与设备 UI

### M4 —— 渠道、联系人与通知

- `ChannelAdapter` 契约 + 统一入站路由（账号 / 本地身份 / 群白名单 / @ 判定，fail-closed）
- Outbox 外发：幂等键唯一、退避重试、`delivery_unknown` 不自动重发、人工重试/标记已送达、全量审计
- 飞书 Bot 适配器：签名校验 + AES 解密、长连接优先、reply API、token 缓存刷新 + `ChannelTestServer`
- QQ 官方 Bot 适配器：Ed25519 事件签名、access token 刷新、群 @ 与私聊、WebSocket 网关事件传输
- 微信个人号实验适配器：可注入 `LocalBridge` 接缝 + `StubLocalBridge`、白名单收发、风险确认与健康/日志
- 可信联系人与群聊权限：一次性邀请码绑定、默认仅 `query`、五类越权 100% 阻断
- 通知规则与路由 + 桌面通知投递（系统通知 + 应用内通知中心，权限被拒自动降级）
- 渠道与联系人 UI

### 已知限制（0.1.0 如实登记）

- **语音（M5）未实现**：VAD / 流式 ASR（字幕）/ 流式 TTS / 打断处理均无运行时实现；桌面 Voice 视图为占位，
  `packages/voice` 仅接口说明。AC-11 与 AC-14 语音段未达成。
- **附件文件传输未实现**：只有引用语义接缝（`SyncFileMerger` 库形态），无 HTTP 路由、无附件目录同步、
  无大文件分块；渠道出站附件投递显式报错（capabilities 声明的 `attachments=limited` 只覆盖入站引用）。
- **飞书需自建应用资质**：`app_id` / `app_secret` / `verification_token` / `encrypt_key` 需在开放平台注册；
  资质未注册前真实平台 0 次，AC-09 的 20/20 仅证明协议层（适配器 + `ChannelTestServer`）。
- **微信需 Windows + 最新客户端（实验）**：真实本地自动化桥未实现（仅 `StubLocalBridge`），需 Owner 的
  Windows 机器 + 最新版微信；真实环境 0 次，适配器按实验能力声明，不承诺稳定收发。
- **AC-02 真实双 Provider 待 Owner 配置**：所有 CI 与本机证据走本地 mock OpenAI 端点；切换 UI 已交付，
  真实两家供应商端点的失败切换验证需 Owner 提供密钥后复跑。
- **Tailscale 双机未验证**：混合形态同步只在 127.0.0.1 双进程（`smoke-hybrid.sh`）验证；真实 Tailscale
  双机跨网络同步与反向 token 方向未在真机执行。
- **QQ 真实平台 AC-10 未满**：累计群 @ 15/20 + 私聊 1 次（0 拒绝），差 5 次群 @；QQ 频道（guild）事件族未接入。
- **敏感数据加密落盘未实现**：账本与记忆投影明文落盘，依赖 OS 磁盘加密（PRD §7 残余风险）。
