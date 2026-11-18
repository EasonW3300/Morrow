# M7 阶段 C 门禁报告（#82）

- **阶段**：M7-C 自动化编排（FR-C1..C16）
- **规格**：#74（`docs/prd/PRD-M7.md` 决策 #30–#41）
- **集成分支**：`integration/m7c`
- **验证时间**：2026-11-18（含 code-review 修复批 `4dfbbb0`）
- **验证口径**：Node 24.22 / macOS arm64

## 0. 一句话结论

16 条功能性需求全部有代码与测试证据；53 条用户故事中 **51 条完整覆盖**，2 条
（FR-C3 的「弹窗」与 FR-C12 的「访谈轮次可见」的**组件级**断言）已实现 UI 但只有
纯逻辑测试（桌面端无 DOM 测试环境，这是 M7-A 起就存在的策略取舍）。
建议打 `v0.4.0`（M7 三段收官）。

## 1. 测试与静态检查总账

| 项 | 数值 | 命令 |
|---|---|---|
| runtime 单元/集成测试 | **1244 通过 / 0 失败** | `pnpm --filter @morrow/runtime test:unit` |
| runtime 故障注入套件 | **25 通过 / 0 失败**（独立脚本） | `pnpm --filter @morrow/runtime test:faults` |
| runtime 真实容器套件 | **12 通过 / 0 失败** | `test/exec.container.test.ts` |
| pi-adapter | **46 通过 / 0 失败**（含 4 项 live） | `pnpm --filter @morrow/pi-adapter test` |
| desktop UI 逻辑测试 | **264 通过 / 0 失败** | `node --experimental-strip-types --test "src/*.test.ts"` |
| 全 workspace typecheck | 干净 | `pnpm -r typecheck` |

阶段 C 新增测试分布：

| 票 | 测试文件 | 用例数 |
|---|---|---|
| C1 (#75) | `pi-adapter/test/usage` + `runtime/test/session-usage` | 15 + 5 |
| C2 (#76) | `plan-mode` | 15 |
| C3 (#77) | `plan-mode-c3` | 23 |
| C4 (#78) | `goals` | 23 |
| C5 (#79) | `goal-driver` | 18 |
| C6 (#80) | `best` | 25 |
| C7 (#81) | `best-tickets` | 18 |
| C8 (#82) | `desktop/src/automation-ui` / `plan-readonly-tools` | 20 + 4 |
| code-review 修复批 | `m7c-review-fixes` | 5 |

阶段 C 合计新增 **171** 项测试。

## 2. FR-C1..C16 逐条证据

### 5.1 Plan

| 编号 | 需求 | 实现 | 证据（测试名/断言） | 状态 |
|---|---|---|---|---|
| **FR-C1** | `/plan` 只读：工具层只暴露只读工具；禁止写文件/执行变更命令 | `plan/mode.ts`（`PLAN_MODE_READONLY_CAPABILITIES` 白名单 + `isPlanModeReadOnly`）、`runtime.ts` 的 `agentTools` 过滤 + invoke 拦截 | `plan-mode.test.ts`「权限全空**不**等于只读：memory.write 是写操作（关键反例）」「白名单里的能力若声明了写权限，仍然拒绝」「Plan 模式下 invoke 写能力 → 403，审计留痕，**工作区文件逐字节未变**」「Plan 模式下装配给模型的工具集不含写类能力（装配层硬限制）」 | ✅ |
| **FR-C2** | 三阶段对话流，提问阻塞等待 | `plan/questions.ts`（`PlanQuestionRegistry` 两段式）+ `plan/routes.ts` 的 question/answer 端点 + `plan/prompt.ts` | `plan-mode-c3.test.ts`「提问登记后可查；回答必须带匹配的 question_id」「提问的工具文案明确「不要自行假设答案」」「HTTP：提问 → 待回答可见 → 回答消费」「阶段只能前进或停留，不能后退」 | ✅ |
| **FR-C3** | `<proposed_plan>` 解析后弹「实现这份计划？」三种选择 | `plan/plan-block.ts`（`parseProposedPlan` 严格解析 + `PLAN_DECISIONS`）| 「决策枚举与解析」「合法计划块：解析出标题/步骤/影响文件/风险」「缺块 / 未闭合 / 空块 各自给出可读原因」「HTTP：decision=continue 允许计划不合格（继续规划的路径）」「decision=implement_clean 返回「清空上下文」提示词」 | ✅（UI 有纯逻辑测试，无组件级断言） |
| **FR-C4** | 自动回合不得自行进入/离开 Plan | 只有 HTTP 端点能改 Plan 状态；模型侧**无**对应工具 | `plan-mode.test.ts`「POST plan/enter：进入并写审计」（端点唯一入口）；`plan-mode-c3.test.ts` 的提示词与工具面断言（`PLAN_MODE_SYSTEM_PROMPT` 不含进入/退出指令） | ✅ |
| **FR-C5** | 计划可「转为任务」（需确认），复用 Task DAG | `plan/routes.ts` `handleConvertToTask`（`confirm=true` 硬要求）→ `createTaskFromPlan` → 既有 `TaskService.createTask` | `plan-mode-c3.test.ts`「HTTP：转为任务需 confirm=true；确认后 task_id 与审计回链都在」（未确认 → 400 `confirmation_required`） | ✅ |

### 5.2 Thread Goal

| 编号 | 需求 | 实现 | 证据 | 状态 |
|---|---|---|---|---|
| **FR-C6** | 每会话至多一个未完成 goal；六态状态机 | `goals/state.ts`（显式迁移表）、`goals/store.ts`（`openForSession`） | `goals.test.ts`「迁移表逐格验证（6×6）」「complete 是终态」「HTTP：每会话至多一个未完成 goal（重复创建 409）」「**不允许退回访谈**」 | ✅ |
| **FR-C7** | `create_goal` 仅显式发起 | `goals/service.ts` 的 `confirm=true` 硬要求 + 模型侧无 `create_goal` 工具 | 「HTTP：创建 goal 必须 confirm=true」「模型工具面不含 create_goal（只能由 Owner 显式发起）」 | ✅ |
| **FR-C8** | token（自累加/缺失估算）+ 时间双预算；超限自动停 | `goals/state.ts`（`checkBudget` / `addGoalUsage`）+ C1 的 usage 通道 | 「预算：达到即算用尽（>= 而非 >）」「预算：时间维度独立判定」「预算：估算的 token 在提示里标注」「用量累加：token 与时间分开；估算标记传播」 | ✅ |
| **FR-C9** | `usage_limited`：429/配额错误映射 | `goals/state.ts` `looksLikeUsageLimit` + `goals/driver.ts` 分类 | 「429 与配额文案都被识别为 usage_limited；普通失败不被误判」「配额错误压过阻塞」「端到端：429 错误 → usage_limited（不再自动续跑）」 | ✅ |
| **FR-C10** | 空闲续跑；**Plan 模式下不续跑** | `goals/resume.ts` `decideResume` + `goals/driver.ts` `tick` + `runtime.ts` 定时器 | 「**Plan 模式下不续跑**（FR-C10 的核心断言）」「Plan 检查优先于「忙闲」」「端到端：Plan 模式下 tick 不发起任何轮次」（断言零 `message.user`） | ✅ |
| **FR-C11** | `blocked` 需同一阻塞连续 3 轮 | `goals/state.ts` `advanceBlockedStreak` / `errorSignature` | 「同一阻塞连续 3 轮才判 blocked；中途换了问题就重新数」「换成另一个阻塞 → 计数从 1 重来」「端到端：同一阻塞连续 3 轮 → blocked」 | ✅ |

### 5.3 Best 模式

| 编号 | 需求 | 实现 | 证据 | 状态 |
|---|---|---|---|---|
| **FR-C12** | `/best` → 访谈（逐轮提问、每题给推荐答案） | `best/stage.ts`（`validateQuestion` 强制 recommendation）+ `best/service.ts` `recordExchange` | `best.test.ts`「**每题必须带推荐答案**（缺推荐的问题直接拒绝）」「轮次上限：默认 12；到 0 时强制收束并提示信息可能不足」「HTTP：访谈记录一问一答；缺推荐答案被拒」 | ✅（UI 有纯逻辑测试） |
| **FR-C13** | 规格成稿 → 确认门；拆票不设门 | `best/service.ts` `submitSpec` / `decideSpecGate`、`best/tickets-service.ts` `createTickets`（无门） | 「门被拒后的去向是「停在 spec」而非回退」「**不允许退回访谈**」「HTTP：规格门被拒 → 停在 spec，可再提交」「HTTP：规格门通过 → 进入 tickets 阶段」「HTTP：拆票（无确认门）」 | ✅ |
| **FR-C14** | 实现前确认门（`/best` 下完全权限不得跳过） | `best/tickets.ts` `canEnterImplement` + `best/tickets-service.ts` `startImplementation`（批准状态只从账本推导） | 「**实现门未批准 → 不能进 implement**（这是 FR-C14 的代码层保证）」「HTTP：**未过实现门 → 无分支、无 DAG、无写操作**」「HTTP：**完全权限模式下实现门仍然拦得住**（FR-C14 的核心）」（切 full_access 后仍 409，git branches 前后一致） | ✅ |
| **FR-C15** | `feat/<slug>` 分支 + worktree，展开 Task DAG，提交但不 push | `best/tickets-service.ts` `startImplementation`（复用 `ensureBranch`/`prepareWorktree`）+ `pushPlan` | 「HTTP：过门 → 建 feat 分支 + Task DAG + 不 push」（分支真实存在、task_id 可查、`pushed: false`、`git remote` 仍为空） | ✅ |
| **FR-C16** | 产物：规格 / tickets / 「推送并开 PR」按钮 | `best/tickets.ts`（`specFilePath` / `ticketFilePath` / `ticketIndexMarkdown` / `implementBranch`）、`pushPlan` | 「票 Markdown 含标题/说明/阻塞/验收」「index 含依赖图与开工顺序」「路径与分支命名」「HTTP：拆票 → 本地一票一文件 + index」（真文件落盘断言）「HTTP：push-plan 只返回指令，不执行」 | ✅ |

## 3. 53 条用户故事覆盖

| 分组 | 故事编号 | 覆盖 | 说明 |
|---|---|---|---|
| Plan（1–16） | 1–16 | ✅ 16/16 | 只读标识/代码层限制/三阶段/阻塞提问/`<proposed_plan>`/三种选择/不得自进出自/Goal 不续跑/转任务/不影响普通会话 各有断言 |
| Goal（17–35） | 17–35 | ✅ 19/19 | 显式创建+确认/至多一个/六态/暂停恢复/自动续跑/Plan 不续跑/usage 累加/估算标注/双预算/超预算停/429 映射/3 轮 blocked/累计用量可查/历史迁移/与 Task 分工 |
| Best（36–53） | 36–53 | ✅ 18/18（2 条仅纯逻辑） | 启动/访谈带推荐/轮次可见/规格门/拒绝停在规格/自动拆票/垂直切片+阻塞边/issues 或本地/实现门/完全权限不可跳/feat 分支/DAG/不 push/推送按钮/产物落位/Goal 承载/中止清理/阶段审计 |

> 唯一的覆盖强度差异：故事 7（「计划产出后弹窗」）与 37（「访谈轮次可见」）的**组件级**
> 断言缺失——桌面端自 M7-A 起没有 DOM 测试环境，全部 UI 逻辑走纯函数测试
> （`automation-ui.test.ts` 20 项覆盖了文案、徽标、禁用条件、产物清单）。

## 4. 接缝落实

| 接缝 | 位置 | 测试注入点 |
|---|---|---|
| HTTP/SSE 主接缝 | `runtime.ts` 路由表 | 全部 `*.api.test.ts` / `plan-mode*.test.ts` / `goals.test.ts` / `best*.test.ts` 黑盒 |
| 会话工具装配点（复用，非新增） | `runtime.ts` `agentTools(sessionId)` | `plan-mode.test.ts` 的装配层断言 |
| Task DAG（复用，非新增） | 既有 `TaskService.createTask` | `best-tickets.test.ts` 的 task_id 断言 |
| **`usage` 事件（唯一新增）** | `packages/pi-adapter/src/types.ts` + `usage.ts` | `usage.test.ts` 15 项 + fixtures 回放 + `session-usage.test.ts` 5 项 |

## 5. 偏差与已知缺口（如实记录）

### 5.1 路径命名（已记录，非缺陷）

- 规格的 FR-C14 要求「实现前确认门」；实现取 `POST /v1/best/:id/implement-gate`（设置批准）
  与 `POST /v1/best/:id/implement`（启动）**两个端点**，而不是一个端点带 `confirm` 参数。
  理由：批准是**状态**（要写审计、要在账本里可查、abort 后要失效），不是一次请求的参数。
  `gateApproved` 只从账本推导，客户端无法伪造。

### 5.2 交付过程中发现并修复的真实缺口

| 缺口 | 发现方式 | 处理 |
|---|---|---|
| **阶段 C 完全没有桌面端 UI** | C8 取证时 `grep -rln "/v1/goals\|/v1/best" apps/desktop` 无结果 | 本票补 `PlanPanel` / `GoalPanel` / `BestPanel` + `automation-ui.ts` 纯逻辑（20 项测试）+ 「自动化」导航页 |
| `GoalTransitionError` 用了 TS parameter property | 测试报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | 改显式赋值（node strip-only 模式不支持） |
| `resume` / `complete` 的空 body 被 `readJsonBody` 拒 | `goals.test.ts` 直接失败 | 改用共享 `readOptionalJsonBody`（与 M7-B 同款问题） |
| `errorSignature` 没归一化 `1234ms` | 签名比对测试失败 | 补「数字+单位」规则 |
| `submitSpec` 用 `#requireRunning("interview")` 导致**门被拒后无法重提** | `best.test.ts`「规格门被拒 → 停在 spec，可再提交」失败 | 允许从 `interview` 或 `spec` 提交 |
| Best 拆票测试依赖本机 `gh` 登录状态 | 开发机有 gh → 走了 issues 分支 | 注入 `tokenProvider`，让两条路径都可测 |
| 测试用中文标题时 slug 是哈希，路径写死会 404 | 文件读取 ENOENT | 改用 artifact 返回的实际路径 |

### 5.2.1 code-review 抓到并修复的四个缺陷

实现票全部"测试绿"之后，安全/正确性复审又抓到四个。第一个是本阶段最严重的一个：

| 缺陷 | 症状 | 根因 | 修法 |
|---|---|---|---|
| **Plan 的只读工具全是空壳** | Plan 模式下工具集**为空**——模型只能干看着，「只读研究」完全无法工作 | 白名单写了 6 个"未来会有"的工具名（`fs.read`/`code.search`/`git.read`…），但项目里只有一个 builtin 且它是写工具 | 白名单收敛到真实存在的工具 + 补真实的只读工具 `memory.search`；加测试断言"每个白名单名字都有实现" |
| **Best 中止后承载 goal 仍 active** | 已放弃的目标每 30s 被续跑器拉起来继续烧预算 | `abort` 只改 best 状态，没管它承载的 goal | abort 时把 goal 置 `complete` |
| **Plan 退出后待回答问题残留** | 下次进 Plan 看到上一个已作废的问题 | 退出时没清 `questions` | 退出时 `forget` |
| **无预算的 goal 可无限自跑** | 不设 token/时间预算时，自动续跑永不停止 | 两个预算都允许 null（"不设限"合法），但没有兜底 | 加 100 轮硬上限，到限转 `budget_limited` 并提示设预算 |

第一个缺陷的性质与前两阶段的「MCP 注册了但不可调」「B3 只有库层没有端点」完全同类：
**零件单测全绿、链路实际不通**。这也是为什么门禁取证必须逐条追问"这条真的能用吗"。

### 5.3 测试基础设施的两个真问题

1. **子进程组泄漏**：`checkpoint.faults` 的 `kill -9` 只杀 runtime 子进程，它 spawn 的
   go worker / 工具进程活下来并持有 SQLite 句柄 → `removeDir` 长时间重试 → 文件进程退出
   被拖到兜底超时。改用 `detached: true` + `process.kill(-pid)` 杀整组。
2. **本机 node 22.12 缺 FTS5**：`engines` 从 `">=22"` 收紧到 `">=22.16"`（FTS5 支持起点）。

**另需记录**：本轮验证中出现的 900s+ 超时**不是代码问题**。排查发现是此前多轮验证积累的
**孤儿测试进程**（最久一个存活 15 天）在抢 CPU（load average 一度 7.6–10.8）。清理后同一
套件 128s 跑完、1233 全绿。已修好进程组清理避免再次积累。

### 5.4 仍存在的限制（需 Owner 知晓）

1. **`usage_limited` 靠 429 + 文案匹配**（PRD §10 开放项）：不同网关错误码不统一，
   可能误判。原始错误保留在 goal 的 `last_error` 供核对。
2. **Goal 的 token 用量含估算时不可精确核对**：`chars/4` 对中文系统性偏小，预算判定
   应把它当下界。
3. **Best 的拆票依赖模型输出形状**：`validateTickets` 会拒绝无验收/悬空引用/有环的
   票，但无法判断"票是否真的垂直切片"（这是语义判断）。
4. **Best 实现阶段不自动 push/开 PR**：设计如此（不可撤销 + 对外可见），只给指令。
5. **Plan 的 `request_user_input` 是两段式而非真阻塞**：工具立即返回"已提问"、会话进入
   等回答态，回答作为下一轮 prompt。对模型等价，但不占用一个悬挂的 Promise（理由见
   `plan/questions.ts` 文件头）。
6. **桌面端无 DOM 测试环境**：所有 UI 判定走纯函数测试，无组件级断言。

## 6. 建议

打 **`v0.4.0`**（M7 三段收官）。

发布说明需包含：

- 新增：Plan 模式（只读强制 + 三阶段 + 阻塞提问 + 计划三选一 + 转任务）、
  Thread Goal（六态 + 双预算 + 空闲续跑 + 配额/阻塞区分）、
  Best 模式（访谈→规格门→拆票→实现门→feat 分支，「完全权限也不得跳实现门」）。
- 安全立场：Plan 的只读是**装配层强制**（写工具根本不给）而非提示词约定；
  Best 的实现门**写死在状态迁移里**，不查任何权限开关。
- 已知限制：见 §5.4 六条。
