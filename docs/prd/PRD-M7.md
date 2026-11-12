# Morrow PRD — M7 增补（会话体验 · 能力扩展 · 自动化编排）

**状态**：访谈完结（Q1–Q47 全部落定），本文件是 M7 的唯一需求真相源；与 PRD v1.0 冲突处以此为准。
**术语**：见根 `GLOSSARY.md`（Plan Mode / Thread Goal / Best Mode / Session Workspace / Session Attachment / Full Permission Mode / Ephemeral Session / Skill Package / MCP Server）。
**工程决策**：ADR-0009（Persona）、ADR-0010（临时会话记忆作用域）、ADR-0011（MCP 进程信任）、ADR-0012（会话工作区）。

---

## 1. 背景与范围

v0.1.0 交付了 M0–M4（记忆、任务、能力工厂、同步部署、渠道）。M7 面向"日常能不能顺手用"与"能不能扩展与自动化"，分三段交付：

| 阶段 | 主题 | 内容 |
|---|---|---|
| **A** | 会话体验 | 全局 Persona、临时会话、会话改名/归档/软删、**会话工作区**、记忆可视化 |
| **B** | 能力扩展 | MCP Server 接入、Skill 包安装（npm / 智能安装）、`/` 命令面板、动态 bash |
| **C** | 自动化编排 | Plan 模式、Thread Goal、**Best 模式**（自动走完访谈→规格→拆票→实现） |

依赖：**C 依赖 A 的会话工作区与 B 的 bash 执行边界**；B 的安装类能力依赖既有的五维权限与沙箱。

---

## 2. 决策摘要

| # | 决策 |
|---|---|
| 1 | 三段交付，各段独立可验收 |
| 2 | Persona = 结构化字段（名字/语气/职责/禁止行为）+ 自由补充；注入会话**与**记忆抽取器，不注入任务规划器；以 `persona.updated` 事件持久化 |
| 3 | 修改 Persona 使所有既有会话 KV 缓存前缀失效；保存前列出受影响会话数并二次确认，不做 token 数字估算 |
| 4 | 临时会话：**可读全局记忆、写入隔离**（`scope=session`），关闭后保留 24h，提供「提升为长期记忆」 |
| 5 | 临时会话禁用写入类能力（注册能力/生成代码/写操作） |
| 6 | 会话改名/归档/**软删（30 天可恢复）**；三者均**不影响记忆**；操作入口 = 行内「⋯」+ 右键菜单 |
| 7 | MCP：首版**只接 tools、只支持 stdio**；Server 以**宿主子进程**运行（非沙箱），安装时展示完整命令 + 风险勾选；默认 disabled |
| 8 | MCP 双代际：先 `server/discover`；`UnsupportedProtocolVersionError` 按其 supported 换版本且**不回退**；其他错误/超时才回退 `initialize` |
| 9 | MCP 进程：懒启动、空闲 10 分钟退出、崩溃指数退避重启 ≤3 次后标 `degraded` |
| 10 | MCP 安装栏支持 JSON/命令输入 + 常用模板预填（不预装、不预授权） |
| 11 | Skill 包最小字段：`name`/`version`/`description`/`permissions` + (`steps` 或 `entry`)；有 `entry` 必须有 `sandbox` 与 `tests` |
| 12 | npm 安装强制 `--ignore-scripts`，只解析 `morrow.skill.json`；可执行部分只能注册为 sandboxed capability；服务端重算 `source_hash` 校验 |
| 13 | 智能安装（文档→技能）= 提案 → 预览 → Owner 确认；LLM 不得直接生成并注册代码 |
| 14 | Skill 包升级手动触发，升级前展示 permissions diff；卸载保留审计与调用历史 |
| 15 | `/` 面板：命令区（`/plan` `/goal` `/best` `/clear` `/memory` `/skill`）+ 技能区，逐字过滤 |
| 16 | 记忆展示：**只读**树（按 kind 分组 + 弱主题聚类）与时间线两种视图；每条可展开版本链与来源事件；提供「打开记忆文件目录」 |
| 17 | 动态 bash：**只允许容器沙箱执行**（`network none`、workspace 挂载、超时/输出上限） |
| 18 | 执行模式为**会话级**开关：「每次命令确认」/「完全权限」；默认每次确认 |
| 19 | 「完全权限」= 跳过逐次确认，但**危险模式硬拦截 + 执行前快照 + 审计照做**（不问 ≠ 无边界） |
| 20 | 沙箱预演**不能**证明宿主无害（环境不同：网络/凭据/文件系统）；因此不把"沙箱通过"作为放行依据 |
| 21 | 只读类命令在会话内首次确认后免二次确认；写/网络/危险命令逐次确认 |
| 22 | 快照承诺仅限**会话工作区**（git stash/临时 commit；非 git 用 `cp -a`）；`~/.ssh`、`/etc`、其他项目不在保护范围并明示 |
| 23 | 允许 Runtime 出网：仅 https、禁回环/私网/云元数据地址、单次 ≤5MB、10s 超时、每次抓取记审计 |
| 24 | 会话工作区 = 目录 + 分支；单文件仅作**会话附件**（只读） |
| 25 | 远程仓库：已存在则关联，不存在则 clone 到 `~/.morrow/workspaces/`；clone 需确认（网络动作） |
| 26 | 分支：默认从默认分支新建 `morrow/<6位id>`（可编辑）；会话结束时有改动必须三选一（提交/保留/丢弃），**不自动丢弃** |
| 27 | 执行与写操作默认限工作区；工作区外写入需会话内显式授权并审计 |
| 28 | 同仓库多会话自动 **git worktree 隔离**；同分支被占用则拒绝并提示持有者 |
| 29 | GitHub 凭据：优先 `gh auth token`，缺失则提示填 PAT 入 OS 凭据库；**push/PR 永远需确认** |
| 30 | Plan 模式：照 codex 的三阶段对话流 + `<proposed_plan>` + 批准弹窗；**同时**在工具注册层硬限制为只读工具集 |
| 31 | Plan 模式下禁用 `update_plan` 类清单工具；`request_user_input` 为阻塞式提问；自动回合不得自行进入/离开 Plan |
| 32 | Thread Goal：照 codex（`active/paused/blocked/usage_limited/budget_limited/complete` + token/时间预算 + 空闲续跑）；`create_goal` 仅显式发起；`blocked` 需同一阻塞连续 3 轮 |
| 33 | Goal 与 Task 分工：Goal = 跨轮次长跑意图（轻、有预算）；Task = 一次可拆解执行（重、有 DAG/Checkpoint）；goal 的某轮可创建 Task |
| 34 | 用量：自行累加 Provider 返回的 usage；流式缺失时按 `chars/4` 粗估并标注"估算"；429/配额错误映射 `usage_limited` |
| 35 | 完全权限 × Goal：允许，但创建 goal 需人工确认 objective 与预算；`budget_limited` 自动停 |
| 36 | Best 模式：Morrow 内**复刻**四阶段流程（不依赖外部 skills CLI）；四阶段 = 访谈 → 规格 → 拆票 → 实现 |
| 37 | Best 模式两道门：**规格成稿确认**、**实现前确认**；拆票不设确认门 |
| 38 | Best 模式内部以一个 Thread Goal 承载，实现阶段展开为 Task DAG（复用 Checkpoint/暂停接管） |
| 39 | Best 模式产物：spec → `docs/specs/<slug>.md`；tickets → GitHub issues（未配置则本地 `docs/specs/<slug>/issues/`）；实现 → `feat/<slug>` 分支 + worktree，提交但不 push，提供「推送并开 PR」按钮 |
| 40 | `/best` 下「完全权限」**不得**跳过"实现前确认" |
| 41 | Plan 产出提供「转为任务」按钮（需确认），复用调度/Checkpoint；Plan 文本作为任务描述保留 |

---

## 3. 阶段 A — 会话体验

### 3.1 Persona

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-A1 | 设置内提供 Persona 编辑：名字（默认 Morrow）、语气（默认"简洁直接"）、职责、禁止行为、其他设定 | 字段可保存并持久化 |
| FR-A2 | 生成 prompt 时按固定顺序拼装，顺序不可配置 | 单测锁定拼装顺序 |
| FR-A3 | Persona 注入会话 system prompt **与**记忆抽取器提示词 | 抽取器输出人称随 Persona 变化（测试断言） |
| FR-A4 | 保存前展示：受影响会话数 + "所有既有会话缓存前缀失效"的后果说明 | 确认弹窗存在；取消则不写入 |
| FR-A5 | 变更以 `persona.updated` 事件入账本，随同步传播 | 事件可查、跨设备可见 |

### 3.2 临时会话

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-A6 | 右上角「临时会话」按钮，在右侧独立打开 | 视觉与普通会话可区分（标注"临时"） |
| FR-A7 | 可读全局记忆；写入的候选/事实 `scope=session:<id>` | 临时会话内说"记住 X"，全局检索不到；临时会话内检索能得到 |
| FR-A8 | 提供「提升为长期记忆」操作 | 提升后 `scope` 变 `owner` 并可全局检索 |
| FR-A9 | 关闭后 24h 内可恢复；到期逻辑清理（账本保留） | 过期后检索不到、账本事件仍在 |
| FR-A10 | 临时会话禁用写入类能力（注册能力/生成代码/写操作） | UI 禁用 + 服务端 403 双保险 |

### 3.3 会话管理

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-A11 | 重命名（`session.renamed`） | 列表即时更新 |
| FR-A12 | 归档：默认列表收起，设置内「会话管理」可恢复 | 归档后不出现在主列表 |
| FR-A13 | 软删：30 天可恢复，到期清除消息投影 | 删除后主列表消失、记忆不受影响（断言） |
| FR-A14 | 操作入口：行内「⋯」+ 右键菜单 | 两种入口均可用 |

### 3.4 会话工作区

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-A15 | 新建会话可选：本地项目目录 / GitHub 仓库 / 不绑定 | 三种均可创建 |
| FR-A16 | 选 GitHub：本地已有 clone 则关联，否则 clone 到 `~/.morrow/workspaces/`（需确认） | 两种路径均有测试/走查 |
| FR-A17 | 可选新建分支：默认 `morrow/<6位id>`，基线默认主分支，可编辑 | 分支真实创建（`git branch --show-current` 断言） |
| FR-A18 | 会话附件：可选多个文件，只读注入上下文 | 文件内容进入上下文且不写入 |
| FR-A19 | 同仓库不同分支自动 worktree 隔离；同分支占用则拒绝 | 两会话并行互不可见；第二会话同分支被拒 |
| FR-A20 | 会话结束：有改动时三选一（提交/保留/丢弃），不自动丢弃 | 关闭会话时弹选择；选"保留"后改动仍在 |

### 3.5 记忆可视化

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-A21 | 只读记忆页：树视图（按 kind 分组 + 弱主题聚类）+ 时间线视图 | 两种视图可切换 |
| FR-A22 | 每条可展开：版本链、来源事件（可跳原始消息）、confidence、sensitivity | 展开可见且只读 |
| FR-A23 | 提供「打开记忆文件目录」入口（编辑走 Markdown 受控导入） | 链接可打开目录 |

---

## 4. 阶段 B — 能力扩展

### 4.1 MCP

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-B1 | 「扩展 → MCP」页：粘贴 JSON/命令安装；模板列表预填 | 安装表单可用；模板仅预填 |
| FR-B2 | 安装时展示完整未截断启动命令 + 宿主权限风险勾选；默认 disabled | 不勾选不能安装；安装后 state=disabled |
| FR-B3 | 协议双代际：`server/discover` 优先；`UnsupportedProtocolVersionError` 换版本不回退；其他错误回退 `initialize` | 三种结果各有测试 |
| FR-B4 | 进程：懒启动、空闲 10min 退出、崩溃重启 ≤3 次后 `degraded` | 生命周期测试 |
| FR-B5 | 工具注册为 capability，受五维权限；默认无 shell、无网络 | 未授权调用被拒 |
| FR-B6 | 「已安装」页统一展示来源（npm/文档/内置/MCP）、状态、权限 | 数据与真实一致 |

### 4.2 Skill 包

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-B7 | npm 源安装：`--ignore-scripts`、解析 `morrow.skill.json`、`source_hash` 校验 | 缺字段/哈希不符拒绝；postinstall 未执行 |
| FR-B8 | 包内 `entry` 只能注册为 sandboxed capability（须有 `sandbox` + `tests`） | 无 sandbox 声明拒绝 |
| FR-B9 | 智能安装：文档（文件/文本/私网 URL）→ 提案（需哪些能力、是否新建工具、权限清单）→ 预览 → 确认 | 未确认不落地 |
| FR-B10 | 升级手动、展示 permissions diff；卸载保留审计 | diff 展示；卸载后注册项消失 |
| FR-B11 | 出网抓取：仅 https、禁回环/私网/元数据、≤5MB、10s、审计 | 各限制有测试 |

### 4.3 命令面板与 bash

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-B12 | `/` 面板：命令区 + 技能区、逐字过滤、键盘选择 | 输入 `/` 即出现 |
| FR-B13 | 动态 bash：容器沙箱 `network none` + workspace 挂载 + 超时/输出上限 | 容器内执行；联网失败 |
| FR-B14 | 会话级执行模式开关（每次确认 / 完全权限），默认每次确认，关闭会话失效 | 切换生效；新会话回到默认 |
| FR-B15 | 完全权限下：危险模式硬拦截 + 执行前快照 + 审计照做 | 命中拦截规则时拒绝执行（非"确认"） |
| FR-B16 | 只读命令白名单会话内首确认后免确认；写/网络/危险命令逐次确认并展示完整脚本 | 两类路径各有测试 |

---

## 5. 阶段 C — 自动化

### 5.1 Plan

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-C1 | `/plan` 进入只读模式：工具层只暴露只读工具；禁止写文件/执行变更命令 | 尝试写工具被拒（代码层断言） |
| FR-C2 | 三阶段对话流（环境探查 → 意图澄清 → 实现细节），提问阻塞等待 | 提问会挂起等待回答 |
| FR-C3 | 计划以 `<proposed_plan>` 产出，解析后弹「实现这份计划？」 | 三种选择（实现/清空上下文实现/继续规划） |
| FR-C4 | 自动回合不得自行进入/离开 Plan | 测试断言 |
| FR-C5 | 计划可「转为任务」（需确认），复用 Task DAG | 转换后任务视图可见 |

### 5.2 Thread Goal

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-C6 | 每会话至多一个未完成 goal；六态状态机 | 状态迁移测试；重复创建被拒 |
| FR-C7 | `create_goal` 仅显式发起（不从普通对话推断） | 普通对话不自动建 goal |
| FR-C8 | 预算：token（自累加/缺失估算）+ 时间；`budget_limited` 自动停 | 超预算停止续跑 |
| FR-C9 | `usage_limited`：429/配额错误映射 | 注入 429 后状态正确 |
| FR-C10 | 空闲续跑；**Plan 模式下不续跑** | 两种模式行为断言 |
| FR-C11 | `blocked` 需同一阻塞连续 3 轮 | 状态机测试 |

### 5.3 Best 模式

| 编号 | 需求 | 验收 |
|---|---|---|
| FR-C12 | `/best` 输入一个想法 → 自动进入访谈阶段（逐轮提问、每题给推荐答案） | 访谈轮次可见 |
| FR-C13 | 规格成稿 → 确认门；拆票（垂直切片 + 阻塞边）不设确认门 | 确认后继续；拒绝则停在规格 |
| FR-C14 | 实现前确认门（`/best` 下完全权限不得跳过） | 未确认不执行写操作 |
| FR-C15 | 实现阶段：建 `feat/<slug>` 分支 + worktree，展开 Task DAG，提交但不 push | 分支存在；无远端变更 |
| FR-C16 | 产物：`docs/specs/<slug>.md`、tickets（issues 或本地）、最终「推送并开 PR」按钮 | 三类产物落位正确 |

---

## 6. 数据与接口变更

**事件族（只加不改）**：`persona.updated`、`session.renamed`、`session.archived`、`session.unarchived`、`session.deleted`、`session.restored`、`session.workspace_bound`、`memory.promoted`、`capability.mcp_installed`/`mcp_enabled`、`skill.package_installed`/`upgraded`/`removed`、`plan.proposed`/`plan.approved`、`goal.created`/`goal.updated`、`exec.policy_changed`、`exec.snapshot_created`。

**Schema**：`memory_candidates`/`memory_facts` 增 `scope`；`sessions` 投影增 `archived_at`/`deleted_at`/`workspace`/`attachments`；新增 `thread_goals`、`mcp_servers`、`skill_packages`、`exec_snapshots`。

**端点（新增）**：`GET/PUT /v1/persona`、`POST /v1/sessions/:id/{rename,archive,unarchive,restore}`、`DELETE /v1/sessions/:id`、`PUT /v1/sessions/:id/workspace`、`POST /v1/sessions/:id/attachments`、`GET/POST /v1/mcp/servers`、`POST /v1/skills/install`（npm/文档）、`POST /v1/exec/mode`、`POST /v1/sessions/:id/exec`、`POST /v1/plans/:id/approve`、`GET/POST /v1/goals`、`POST /v1/best/start`。

---

## 7. 安全与风险

1. **沙箱预演不能证明宿主无害** —— 环境不同（网络/凭据/文件系统）。因此"完全权限"的兜底是静态拦截 + 快照 + 审计，不是"先沙箱跑一遍"。此结论来自 Q18 的技术澄清，必须写进用户可见的风险说明。
2. **MCP Server 以宿主权限运行**（ADR-0011）：风险可见 + 权限收窄 + 审计；进程级隔离列为后续。
3. **出网 SSRF**：禁回环/私网/云元数据，仅 https，大小与超时上限，审计。
4. **KV 缓存**：Persona 修改使缓存失效 → 成本与风格漂移，保存前明示。
5. **快照边界**：仅会话工作区；`~/.ssh`/`/etc`/其他项目不在保护内，必须明示。
6. **Best 模式风险叠加**：自动访谈 + 自动改仓库 + 可能的完全权限 → 强制保留"实现前确认"。

---

## 8. 验收（阶段级）

| 阶段 | 门槛 |
|---|---|
| A | Persona 改动生效且缓存警告可见；临时会话读写隔离可验证；改名/归档/软删均可恢复；工作区绑定三种来源可用；同仓库双会话 worktree 隔离；记忆树/时间线只读可用 |
| B | MCP 安装→启用→工具调用全链路（桩 + 一条真实 stdio server）；npm 包安装阻断 postinstall；智能安装需确认；bash 沙箱执行且有网络阻断证据；两种执行模式行为正确 |
| C | Plan 只读可验证（写工具被拒）；Goal 六态与预算可验证；`/best` 全流程两轮通过（真分支、真产物、不 push） |

---

## 9. 非目标

- 容器化 MCP 进程（后续）
- MCP 的 resources/prompts 能力面、HTTP 传输（后续）
- 记忆的实体关系抽取与真图谱（后续，先做树/时间线）
- 跨设备同步会话工作区（工作区为设备本地，仓库通过 git 远程共享）
- 语音（M5 延后，不在 M7）
- 会话级 Persona 覆盖（Q2 已定只做全局）

---

## 10. 依赖与开放项

- 依赖 v0.1.0 已交付的记忆/任务/权限/沙箱/通知基础
- 开放：`usage_limited` 的供应商差异（不同网关的配额错误码不统一，先按 429 + 文案匹配）
- 开放：MCP 生态以 stdio 为主，但存在 HTTP-only server，首版不支持
- 开放：gh token 与 PAT 的优先级与撤销流程需在实现时细化
