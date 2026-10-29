# Morrow — 个人 Agent 领域术语表

单主人、长期记忆、可自主生成能力的个人 Agent。本表定义领域统一语言；实现与工程选型见 PRD 与 ADR，不在此记录。

## 身份与设备

**Owner（主人）**: 拥有并完全控制此 Agent 实例的唯一自然人。
_Avoid_: 用户、admin、租户（本项目无多租户）

**Trusted Contact（可信联系人）**: 经 Owner 显式授权、可经由渠道与 Agent 交互并访问有限能力的外部人员；默认不可访问 Owner 的私人记忆、文件与开发环境。
_Avoid_: 朋友、协作者

**Pairing Code（配对码）**: 已信任设备生成的一次性短时凭证，用于把新 Device 加入信任网络。

**Invite Code（邀请码）**: Owner 生成的一次性凭证，用于把外部人员的渠道身份绑定为 Trusted Contact。

**Device（设备）**: 运行 Morrow 一份实例的机器，持有独立设备密钥与同步游标。

**Replica（副本）**: 同一 Owner 的数据在一个 Device 上的完整本地拷贝；副本间通过事件同步保持一致。
_Avoid_: 节点

## 渠道与会话

**Channel（渠道）**: Owner 或 Trusted Contact 与 Agent 之间的通信入口（桌面 UI、语音、Telegram、微信、QQ）。

**Channel Adapter（渠道适配器）**: 把某一平台的具体收发行为转换为统一入站/出站消息结构的模块。

**Stable Baseline Channel（稳定基线渠道）**: 由平台官方 API 驱动、承担可靠性验收参照的渠道；首版为飞书 Bot 与 QQ 官方 Bot。

**Experimental Adapter（实验适配器）**: 依赖非官方自动化、出厂默认关闭、需 Owner 显式启用并自担账号风险的渠道适配器；首版为微信个人号。

**Conversation（会话记录）**: 某一渠道上的一段原始消息往来，保留平台来源与权限上下文。
_Avoid_: Chat

**Message（消息）**: Conversation 中的一条入站或出站记录；所有出站消息必须留审计。

**Session**: 一个 Agent 对话上下文；可关联多个渠道，既不等同于 Conversation，也不等同于 Task。

## 任务与执行

**Task（任务）**: 一个有稳定 ID 的工作单元，由 TaskNode 与 TaskEdge 构成 DAG，可关联多个 Session/渠道。
_Avoid_: job、workflow

**Run（执行实例）**: Task 的一次具体执行；任一时刻至多被一个 Runtime 持有执行租约（fencing token）。

**ExecutionEvent（执行事件）**: 执行过程中不可变的事件记录（工具开始/结束、调度、暂停、接管、失败、恢复）。

**Checkpoint（检查点）**: 可从中恢复一次 Run 的完整状态快照。

**SideEffect（外部副作用）**: Agent 对外部世界产生的不可逆或难以核验的改变（发消息、付款、提交表单），按 `reversible | compensatable | irreversible | delivery_unknown` 分类。

**SideEffectOutbox（副作用发件箱）**: 外发副作用先落库再投递、带幂等键与渠道回执跟踪的机制。

## 记忆

**MemorySource（记忆来源）**: 一条记忆所依据的原始证据（消息、任务事件）；事实必须可回链到来源。

**MemoryCandidate（候选记忆）**: 后台抽取产生的、尚未巩固为长期记忆的条目，带来源、置信度与敏感等级。

**MemoryFact（长期记忆）**: 已巩固的结构化事实、偏好或用户画像，有版本与有效期。
_Avoid_: 知识、笔记

**Procedural Memory（程序性记忆）**: Agent 从重复经验中沉淀的操作经验；经测试后才成为正式 Skill。

**Notification Rule（通知规则）**: 事件类型 × 目标渠道 × 免打扰时段构成的通知投放配置；同一任务同类事件按窗口去重。

**Sensitivity Level（敏感等级）**: 记忆的可见性分级，决定其能否跨副本同步、能否对 Trusted Contact 引用、能否自动改写；分为 `public`（可同步、可引用）/ `private`（仅 Owner 会话可读，同步时加密）/ `locked`（禁止一切自动改写，变更必须经 Owner 确认）。

## 能力

**Capability（能力）**: Agent 可调用的一个已注册功能的统称，含版本与权限边界。

**Tool**: 原子级能力，接受 schema 化参数并返回结果。

**Skill**: 由 Tool 组合或经验固化而成的复合能力。

**Capability Factory（能力工厂）**: 从"发现缺失能力"到"生成、验证、注册、重用"的闭环流程。

**PermissionGrant（权限授予）**: Owner 对某能力在文件范围、网络目标、命令类别、渠道、凭据等维度的事先授权；AI 生成的 Tool 权限不得超过授予范围。

**Sandbox（沙箱）**: 运行 AI 生成代码的隔离执行环境；无可用沙箱时禁止执行生成代码。

## 运行时与模型

**Runtime**: Morrow 核心应用的同一份代码在两种宿主形态下的统称——本地作为桌面 sidecar 进程，服务器上作为 Ubuntu 服务进程。

**Provider（模型供应商）**: 一个 OpenAI Chat Completions 兼容的 LLM 接入点，由 base_url、api_key、模型名三元组描述；不区分云端或本地。
_Avoid_: 厂商原生接入、模型名

**Execution Lease（执行租约）**: 保证同一 Run 全局单点执行、可跨设备转移但不可并行的租约机制。
