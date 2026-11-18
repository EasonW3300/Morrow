# 变更日志

本文件记录 Morrow 的对外可见变更。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本；当前发布版本为 `0.4.0`，版本号唯一来源是各 workspace `package.json`
（Runtime 的 ready 行与 `/v1/health` 均从 `apps/runtime/package.json` 读取，不设双真相源）。

## [0.4.0] - 2026-11-18

M7-C：自动化编排（Plan 模式 / Thread Goal / Best 模式）。逐项门禁证据见
[`docs/gates/m7c-gate-report.md`](docs/gates/m7c-gate-report.md)。M7 三段至此收官。

### 新增

- **Plan 模式（`/plan`）**：会话进入**真的**只读模式——只读是**装配层硬限制**（写工具根本不出现在工具集里），不是提示词约定；即使模型构造出写调用也会在执行层被拒并留 `plan.write_attempt_blocked` 审计。三阶段对话流（环境探查 → 意图澄清 → 实现细节），其中提问是**阻塞式**的（工具立即返回"已提问"、会话进入等回答态，回答作为下一轮 prompt；不占用悬挂 Promise）。计划以 `<proposed_plan>` 严格解析（缺标题/缺步骤/空块都拒绝并说明原因），解析后三种选择（实现 / 清空上下文后实现 / 继续规划），计划可「转为任务」复用 Task DAG。状态**不持久化**，关闭会话即回默认。
- **Thread Goal（`/goal`）**：会话级长跑意图，**六态状态机**（active / paused / blocked / usage_limited / budget_limited / complete，迁移表逐格验证，`complete` 是终态）。双预算：token（自行累加 Provider 返回的 usage，缺失时按 `chars/4` 估算并**显式标注**）+ 时间（暂停不累计）。任一超限自动停。空闲自动续跑（默认 30s 扫描、30s 静默阈值），**Plan 模式下不续跑**。429/配额错误映射 `usage_limited`；同一阻塞连续 3 轮才判 `blocked`（换错误签名从 1 重数）。创建需**显式确认**，模型侧没有 `create_goal` 工具。落表持久化，跨重启继续。
- **Best 模式（`/best`）**：给一个想法自动走完访谈 → 规格 → 拆票 → 实现。访谈逐轮提问且**每题必带推荐答案**，轮次上限默认 12。规格成稿后**确认门**（被拒停在规格可编辑重提，**不回退访谈**）；拆票不设门（垂直切片 + 阻塞边，已配 gh 建 issues、未配写本地一票一文件 + index 依赖图）；实现前**确认门**——**「完全权限」也不能跳过**（写死在状态迁移里，不查任何权限开关）。实现阶段复用会话工作区建 `feat/<slug>` 分支 + worktree、展开 Task DAG、**提交但不 push**，最后给「推送并开 PR」的指令。
- **用量通道**：适配层新增 `usage` 事件（在 `agent_end` 之前发出），从 Provider 流式响应提取 input/output/cache token；缺失时按 `chars/4` 估算并标 `estimated`。会话级 `usageOf` 累计。

### 修复

- **Plan 的只读工具全是空壳**：白名单写了 6 个"未来会有"的工具名，但项目里只有一个 builtin（且是写工具）→ Plan 模式下工具集为空，「只读研究」什么都做不了。白名单收敛到真实存在的工具，并补真实的只读工具 `memory.search`（记忆 FTS 检索）。
- **Best 中止后承载 goal 仍 active**：已放弃的目标仍被续跑器每 30s 拉起继续烧预算。abort 时把 goal 置 complete。
- **Plan 退出后待回答问题残留**：下次进 Plan 会看到已作废的问题。退出时清理。
- **无预算的 goal 可无限自跑**：两个预算都允许 null，但没有兜底。加 100 轮硬上限，到限转 `budget_limited` 并提示设预算。

### 质量

runtime **1244** / desktop **264** / pi-adapter **46** 全绿；真实容器套件 **12/12**；全 workspace typecheck 干净。阶段 C 新增 171 项测试。code-review 双轴发现 4 项（1 项严重）全部修复并补回归测试。

### 已知限制（增量，接续 0.3.0）

- **`usage_limited` 靠 429 + 文案匹配**：不同网关错误码不统一（PRD §10 开放项），可能误判；原始错误保留在 goal 的 `last_error` 供核对。
- **token 估算对中文系统性偏小**：`chars/4` 是英文近似；估算值时预算判定应当下界。
- **Best 拆票的垂直切片性无法自动判定**：`validateTickets` 会拒无验收/悬空引用/有环的票，但"票是否真的可独立交付"是语义判断。
- **Best 实现阶段不自动 push/开 PR**：设计如此（不可撤销 + 对外可见），只给指令。
- **Plan 的阻塞提问是两段式**：对模型等价，但不占用悬挂 Promise（进程可观测性更好）。
- **桌面端无 DOM 测试环境**：阶段 C 的 UI（Plan/Goal/Best 面板）判定与文案走纯函数测试，无组件级断言。

## [0.3.0] - 2026-11-17

M7-B：能力扩展（MCP 接入 / Skill 包安装 / 智能安装 / `/` 命令面板 / 动态 bash）。逐项门禁证据见
[`docs/gates/m7b-gate-report.md`](docs/gates/m7b-gate-report.md)。

### 新增

- **MCP 接入**：粘贴 JSON 配置或启动命令即可安装 Server（含 filesystem/git/fetch 模板，**仅预填**）；安装前展示**完整未截断**启动命令并强制勾选宿主权限风险；新装默认 **disabled**，显式启用后才启动。协议**双代际**（`server/discover` 优先；版本不支持按其 `supported` 换版本且**不回退** `initialize`；其他错误/超时才回退）；进程懒启动、空闲 10 分钟退出、崩溃重启 ≤3 次后 `degraded`；工具注册为 capability（`mcp.<server>.<tool>`），**默认五维权限全空**。「已安装」页统一展示来源/状态/权限/健康（含协议代际与降级原因）。
- **Skill 包安装（npm）**：强制 `--ignore-scripts`（有负向对照测试证明探针不会执行）；只解析 `morrow.skill.json`，服务端重算 `source_hash`；含 `entry` 的包**必须**声明 `sandbox` + `tests`，且只能注册为容器沙箱能力（忽略包内更宽松的声明）。升级为**两步**：先给权限 diff（预览不落盘），扩权还需显式接受 + 全局 grants 放行；卸载删目录并禁用能力，审计永久保留。
- **智能安装**：上传文件 / 粘贴正文 / 内网 URL → LLM 读文档产「安装提案」（需要哪些现有能力、是否要新建工具、权限清单、示例调用）→ 预览 → Owner 确认 → 才落地。需要新工具时转交 **Tool Factory**（生成→沙箱验证→再确认），**不在提案阶段产码或注册**。出网抓取：仅 https、拒绝回环/私网/链路本地/云元数据/CGNAT、DNS 解析后复检（防 rebinding）、≤5MB 流式中止、10s 超时、每次抓取写审计；**公网默认关闭**（`MORROW_ALLOW_PUBLIC_DOC_FETCH=1` 开启）。
- **`/` 命令面板**：命令区（`/plan` `/goal` `/best` `/clear` `/memory` `/skill`）+ 技能区，前缀/中缀/子序列三档逐字过滤，↑↓ 回绕、Enter/Esc。
- **动态 bash**：Agent 写脚本在**容器内**执行（`--network none`、workspace 挂载、根只读 + `/tmp` tmpfs、`--pids-limit`、`no-new-privileges`、超时按容器名 kill、输出按字节上限截断）。会话级执行模式：「每次命令确认」（默认）/「完全权限」，**不持久化**，关闭会话即失效（含「关闭→恢复」的代际号防绕过）。完全权限下**危险命令仍被硬拒绝**（12 条静态规则：删系统路径/写 `~/.ssh`/读凭据库/`curl|sh`/`eval`/强制推送/改 `/etc`/sudoers/fork 炸弹/写块设备/关机重启），执行前**快照**、执行后**审计**。只读命令「会话内首次确认后」免二次确认；写命令逐次确认并回传完整脚本。撤销覆盖会话工作区，边界（`~/.ssh`、`/etc` 等不在保护范围）随响应回传并在 UI 常驻。

### 修复

- **MCP 工具「注册了但不可调」**：`enable` 只注册进 PermissionEngine，未登记进 ToolInvoker，调用永远 `unknown_tool`。补 MCP 分派分支与 `callTool`（含空闲回收后的懒重启）。
- **MCP 空闲回收从未发生**：`reclaimIdle` 零调用点，FR-B4 在生产上是死代码。补 60s 轮询定时器，并在关闭时清理定时器与子进程。
- **「停用」被报成「不存在」**：停用后原实现 `unregister`，invoke 报 404 `unknown_tool`。改为保留注册，由权限层报 `capability_disabled`（403）；执行体仍不会被调用。
- **快照失败无审计**：快照失败正确拒绝执行，但账本上这次执行「从未发生」。补 `phase=snapshot_failed` 审计。
- **Skill 包升级预览会真的装包**：初版预览直接装到正式目录，看一眼 diff 就覆盖了 `node_modules`。改为装到暂存目录算完即删。
- **危险规则漏拦两个变体**：`sudo -u root rm -rf /`（`-u` 带值选项未跳过）、`git push origin +main`（`+refspec`）。
- **输出截断切出替换字符**：按字节切多字节 UTF-8 字符产生 U+FFFD，改为回退到字符边界。
- **关闭→恢复的会话继承「完全权限」/只读豁免**：引入 `executionEpoch` 代际号（两道防线）。

### 质量

runtime **1119** / desktop **244** / Rust 全绿；真实容器套件 **12/12**（本机 Docker：联网失败是隔离的正面证据）。code-review 双轴发现 4 项（全部为「看起来做完、实际不可用」型）已修复并补回归测试。

### 已知限制（增量，接续 0.2.0）

- **DNS rebinding 复检有 TOCTOU 窗口**：Node 原生 `fetch` 自行解析 DNS，无法把已校验 IP 钉进连接；当前是连接前后两次独立解析。完美方案需自定义 agent。
- **MCP 只支持 tools**：resources/prompts 不支持，协商时如实记为 `unsupportedCapabilities` 并在健康详情展示。
- **MCP Server 不是沙箱**：它是宿主进程，拥有与 Morrow 同等的宿主权限；Morrow 只能约束*经其注册的工具调用*。风险文案原文落库以便取证。
- **「完全权限」不是无边界**：静态规则集是「宁严勿松」的黑名单，无法覆盖所有危险写法（例如混淆脚本）。兜底是快照 + 审计 + 可撤销。
- **快照只覆盖会话工作区**：`~/.ssh`、`/etc`、其他项目目录、OS 凭据库、远端仓库都不在保护范围。
- 真实容器验证采用本机 macOS/Docker；CI 的 ubuntu 腿会跑但本轮未在 CI 复验。
- 桌面端无 DOM 测试环境，「安装后默认未启用」等状态仅有纯逻辑断言，无组件级断言。

## [0.2.0] - 2026-11-16

M7-A：会话体验（Persona / 临时会话 / 会话管理 / 会话工作区 / 记忆视图）。逐项门禁证据见
[`docs/gates/m7a-gate-report.md`](docs/gates/m7a-gate-report.md)。

### 新增

- **Persona（全局人设）**：设置内编辑名字/语气/职责/禁止行为/其他，固定顺序拼装；注入会话 system prompt **与**记忆抽取器（每次抽取读最新值）；`persona.updated` 事件持久化。保存前提示影响范围（**只影响新建会话**，进行中的保持原人设）。
- **临时会话**：右上角独立面板；可读全局记忆、写入隔离在 `scope=session:<id>`；单条「提升为长期记忆」；关闭后 24h 可恢复；写入类能力在能力网关/skill invoke/任务创建三处统一拒绝。
- **会话管理**：改名 / 归档 / 软删（30 天可恢复）/ 恢复，全部走账本事件，列表仍是对账本的折叠（无 sessions 表）；删除**不影响记忆**。
- **会话工作区**：新建会话可选本地项目目录 / GitHub 仓库（已有副本按 remote URL 关联，否则 clone）/ 新建分支；只读会话附件（注入 user 消息）；同仓库多会话自动 worktree 隔离，同分支 409；关闭时未提交改动强制三选一（提交/保留/丢弃）。
- **记忆视图**：只读树视图（按类型分组 + 主题聚类，复用 consolidator 词元）与时间线；展开见版本链与来源事件；无任何写端点。

### 修复

- **GitHub PAT 只注入白名单 host**：原实现用全局 `http.extraHeader`，粘贴任意 URL 即可把 PAT 送出去；现按 `http.https://github.com/.extraHeader` 精确限定，并清除 `GIT_CURL_VERBOSE`、对错误详情脱敏。
- **默认分支名唯一性**：原取 uuidv7 前 6 位（时间戳高位），约 4.7 小时内新建的会话会撞名导致第二个 GitHub 绑定必然 409；现取尾部随机位，撞名自动追加 `-2..-5`。
- **临时会话过期不再复活**：过期状态改由 `ephemeral_closed.closed_at + 24h` 与当前时间推导（重放可复原），`overview`/`promote` 入口补 sweep。
- **`checkpoint.faults` 挂起 878 秒**（Issue #65，自 M1 引入）：根因是 `slow` 工具默认 60 秒且用例未显式设 kill 窗口，错过窗口即等满 60 秒并叠加；默认降到 5 秒且每个用例显式 700ms。连续 5 次全文件跑 15–17 秒。
- 附件上限改累计校验（原按单次请求）；`discard` 对本地绑定返回专用错误码而非伪装 `not_isolated`；realpath 校验改为「必须仍在 worktreesRoot 之下」（原实现两值恒等，symlink 逃逸拦不住）。

### 质量

runtime **824** / desktop **179** / Rust **9** 全绿（首次含 `checkpoint.faults` 的完整通过）；Docker Linux 的 workspace+session+ephemeral 套件 **63/63**。code-review 双轴发现 10 项（含 2 个安全级）全部修复。

### 已知限制（增量，接续 0.1.0 的 8 条）

- 临时会话「禁写入类能力」在**注册/生成**入口仍无法在 HTTP 层拒绝（这些端点无会话归属参数），只做到调用层 403 + UI 禁用。
- 新建会话的本地目录是**文本路径输入**（未接 Tauri dialog 插件）。
- 记忆视图不含 `confidence`（该属性属于候选记忆，长期事实没有）。
- `open_memory_dir` 唤起 Finder 未真机验证（cargo 编译与测试已过）。
- 会话工作区为**设备本地**，不随同步传播（仓库内容通过 git 远程共享）。

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
