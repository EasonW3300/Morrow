# Morrow M7-A 门禁报告（会话体验 · 阶段 A）

**票**：M7-A-T7 / Issue #64　**规格**：Issue #57（FR-A1..A23 + 35 条用户故事）
**集成提交**：`integration/m7a` @ `7e17e7b`（T1–T6 全部合入）
**日期**：2026-11-15

---

## 0. 结论摘要

- **FR-A1..A23：20 项达成 / 2 项部分 / 1 项未验证**（明细见 §2）。
- **35 条用户故事：33 条有对应覆盖**，2 条仅部分（见 §3）。
- **工程侧阻塞项：1 项**（既有测试 `checkpoint.faults` 的 P6 时序脆弱性，**非阶段 A 引入**，见 §6）。
- **建议**：阶段 A 功能面可发 `v0.2.0`；但**必须先清掉 §6 的阻塞项**，否则"全量测试绿"不成立。

---

## 1. 裁决口径

- **达成**：有可复跑的测试名或命令作为证据，且行为与规格一致。
- **部分**：功能存在但保障强度低于规格承诺（例如规格要求"双保险"实际只有一层），或仅覆盖一种形态。
- **未验证**：实现已存在但缺少可复跑证据，需 Owner 真机确认。

写不出证据指针的一律降级为"未验证"，不使用"已验证"这类无法核对的措辞。

---

## 2. FR-A1..A23 逐条裁决

### 2.1 Persona（T1 / #58）

| FR | 裁决 | 证据指针 | 备注 |
|---|---|---|---|
| FR-A1 设置内编辑五字段 | 达成 | `apps/desktop/src/persona-ui.test.ts`（5 例：表单校验/映射/确认状态机） | 名字/语气/职责/禁止/其他 |
| FR-A2 拼装顺序固定不可配 | 达成 | `apps/runtime/test/persona.test.ts`「拼装顺序锁定」 | 改顺序即红 |
| FR-A3 注入会话与抽取器 | 达成 | `persona.test.ts`（FakePi 捕获 systemPrompt + 抽取器提示词断言） | 规划器隔离另有断言 |
| FR-A4 保存前展示受影响会话数 | 达成 | `persona-ui.test.ts`「确认文案…」 | 取消不写入由状态机测试覆盖 |
| FR-A5 变更入账本 | 达成 | `persona.api.test.ts`（5 例，含 `persona.updated` 事件断言） | 随同步传播 |

### 2.2 临时会话（T3 / #60）

| FR | 裁决 | 证据指针 | 备注 |
|---|---|---|---|
| FR-A6 右上角按钮 + 右侧独立面板 | 达成 | `apps/desktop/src/ephemeral-ui.test.ts`（6 例） | UI 逻辑层 |
| FR-A7 可读全局、写入 `scope=session:<id>` | 达成 | `apps/runtime/test/memory.ephemeral.store.test.ts`（3）+ `memory.ephemeral.api.test.ts`（6） | 检索层实现隔离 |
| FR-A8 提升为长期记忆 | 达成 | `memory.ephemeral.api.test.ts`「promote」用例 | `memory.promoted` 事件 |
| FR-A9 24h 可恢复 + 到期逻辑清理 | 达成 | `memory.ephemeral.api.test.ts`（注入时钟，零 sleep） | 账本保留、投影/FTS 移除 |
| FR-A10 禁用写入类能力 | **达成**（code-review 修复批后） | `memory.ephemeral.api.test.ts`（调用网关 403）+ `ephemeral-ui.test.ts`（按钮禁用）+ `m7a-review-fixes.test.ts`（**skill invoke 403** + **任务创建 403**，同一判定函数） | 见附录 A.1-A4：门禁已收敛到 `ephemeral-gate.ts` 单一入口。能力注册/工厂端点仍无会话归属参数（残余缺口见 §4-1） |

### 2.3 会话管理（T2 / #59）

| FR | 裁决 | 证据指针 | 备注 |
|---|---|---|---|
| FR-A11 重命名 | 达成 | `apps/runtime/test/sessions.metadata.test.ts`（4 例含折叠顺序） | `session.renamed` |
| FR-A12 归档/恢复 | 达成 | 同上 + `apps/desktop/src/session-ui.test.ts`（10 例） | 设置内「会话管理」 |
| FR-A13 软删 30 天可恢复 | 达成 | `sessions.metadata.test.ts`「软删 30 天到期」（注入时钟） | 到期剔除折叠、账本保留 |
| FR-A14 两种操作入口 | 达成 | `session-ui.test.ts`（菜单状态机） | 行内「⋯」+ 右键 |
| 删除不影响记忆 | 达成 | `sessions.metadata.test.ts`「删除不影响记忆」 | 规格硬要求，单列 |

### 2.4 会话工作区（T4 / #61、T5 / #63）

| FR | 裁决 | 证据指针 | 备注 |
|---|---|---|---|
| FR-A15 三种来源（本地/GitHub/不绑定） | **部分** | `workspace.api.test.ts`（7）+ `workspace.manager.test.ts`（10） | 见 §4-2：本地形态为文本路径输入；本地绑定不建分支/worktree |
| FR-A16 已有 clone 关联 / 否则 clone | 达成 | `workspace.manager.test.ts`（remote URL 归一化比较，`reused` 断言） | 私有仓库 token 经 `GIT_CONFIG_KEY_0` 注入，不进 argv |
| FR-A17 新建分支（默认 `morrow/<6位>`） | 达成 | `workspace.manager.test.ts`（真实临时仓库，`git branch --show-current` 断言） | 基线默认主分支可改 |
| FR-A18 只读附件 | 达成 | `workspace.api.test.ts`（附件注入断言 + 文件未变） | 注入 user 消息而非 system prompt（理由见 §4-3） |
| FR-A19 同仓库 worktree 隔离 + 同分支拒绝 | 达成 | `workspace.close.test.ts`（9 例，含重启后仍拒绝） | 内存注册表 + 账本重建两处一致 |
| FR-A20 关闭三选一，不自动丢弃 | 达成 | `workspace.close.test.ts`（409 列文件 + commit/keep/discard 三路径） | `discard` 有路径前缀校验 |

### 2.5 记忆视图（T6 / #62）

| FR | 裁决 | 证据指针 | 备注 |
|---|---|---|---|
| FR-A21 树/时间线两视图 | 达成 | `apps/runtime/test/memory.overview.test.ts`（8）+ `memory.overview.api.test.ts`（6） | 聚类复用 consolidator 的 `salientTokens`，确定性 |
| FR-A22 展开版本链与来源 | 达成 | 同上（`revisions` / `revision_history` / `sources[]` 断言） | 见 §4-4：不含 confidence（事实无此属性） |
| FR-A23 打开记忆文件目录 | **未验证** | `memory-ui.test.ts`（11 例覆盖逻辑层） | 见 §4-5：`open_memory_dir` 的 Finder 唤起需真机确认（cargo 编译与 9 项测试已过） |

**统计**：达成 **20** / 部分 **2** / 未验证 **1**。

---

## 3. 35 条用户故事的覆盖盘点

**有明确覆盖：33 条**（Stories 1–33 均能对应到 §2 的 FR 与测试文件）。

**仅部分覆盖：2 条**

| Story | 缺口 |
|---|---|
| Story 12「临时会话不能注册能力、不能生成代码、不能执行写操作」 | 注册能力与工厂生成在 HTTP 层无会话归属参数，只做到"调用网关 403 + UI 禁用"（同 FR-A10） |
| Story 18「新建会话时能选一个本地项目目录」 | 是文本路径输入而非原生目录选择器（同 FR-A15） |

---

## 4. 已知偏离（逐条登记，来源为各票自述）

1. **T3 / FR-A10**（code-review 修复批部分收口）：`POST /v1/capabilities` 与能力工厂请求端点**没有会话归属参数**，无法在 HTTP 层把"临时会话"关联上去。**已补齐**的是"限制任务创建"（`POST /v1/tasks` 403 `ephemeral_task_forbidden`）与 **skill invoke 403**；仍缺的是注册/生成两个端点上的 `session_id`——补上参数才能真正把这三条路径全闭上（见附录 A.1-A4 与 C 清单）。
2. **T4 / FR-A15**：本地目录选择是**文本路径输入**——项目未装 Tauri dialog 插件，规格禁止新增依赖。校验与错误提示齐全，接入原生选择器只需替换输入控件。另：**本地绑定不建分支也不建 worktree**（票面 body 的 local 形态只有 `path`），只有 GitHub 形态才建分支 + 会话 worktree。
3. **T4 / FR-A18**：附件选择注入 **user 消息**而非 system prompt。理由正确——system prompt 只在会话 runtime 创建时求值一次，中途新增附件会看不到。附带上限：单会话 10 个、单文件 256 KiB、合计 1 MiB、二进制拒绝。
4. **T6 / FR-A22**：记忆视图**不含 confidence**。`confidence` 是**候选记忆**的属性，长期事实（fact）没有该字段；为不填假值而省略。要看置信度需走候选端点。
5. **T6 / FR-A23**：来源跳转落在**会话级**（ChatView 无消息级滚动锚点），不做单条消息定位；`open_memory_dir` 命令**未做真机 Finder 唤起验证**（`cargo check` 与 `cargo test` 9 项均通过）。
6. **T1 / FR-A1..A5**：Persona 只影响**新建会话**——系统 prompt 在会话首次创建 AgentRuntime 时注入并随该会话复用，进行中的会话保持原人设。这是设计（已在 UI 文案中如实说明，不再声称"所有既有会话下一轮失效"）。

---

## 5. 两条接缝的覆盖情况

| 接缝 | 覆盖的 FR | 说明 |
|---|---|---|
| **HTTP/SSE 控制 API（主接缝）** | FR-A3、A5、A7–A14、A16–A20、A21–A22 | 全部以黑盒请求验证；`workspace.close.test.ts` 用真实临时 git 仓库 |
| **WorkspaceManager 接口（依赖边界）** | FR-A15、A16、A17、A19、A20 | 假实现覆盖 clone 失败/无凭据/分支冲突；真实临时仓库覆盖成功路径 |

**只有 UI 逻辑测试、无端到端的行为**：FR-A6（临时会话面板布局）、FR-A1 的表单交互细节、FR-A14 的右键菜单、FR-A23 的「打开目录」实际唤起。这些依赖浏览器/真机走查（见 §7）。

---

## 6. 工程侧阻塞项（必须清掉才可称"全量绿"）

**`apps/runtime/test/checkpoint.faults.test.ts` 的 [P6] 在全文件运行时挂起（实测 878 秒未返回），单独跑 3.6 秒通过。**

- 这是 **M1-T5 就存在的既有测试脆弱性**，不是阶段 A 引入（本阶段未改动该文件）。
- 表现：全文件跑时 `[P6] kill -9 after pause completed` 不返回，且其对子进程的清理依赖 `t.after` 钩子；`slow` 工具默认时长 `MORROW_TEST_SLOW_MS=60000`，与用例声明的 `{ timeout }` 组合下形成长尾。
- 影响：`pnpm --filter @morrow/runtime test:unit` **无法稳定全绿**（本次实测 `806 tests / 801 pass / 1 fail`，另有数条被判未完成），因此"全量测试通过"这一门禁口径当前不成立。
- 处置：**不在阶段 A 内修**（会与阶段 A 交付纠缠），已单独开票跟踪；在修好之前，阶段 A 的验收以"除 `checkpoint.faults` 外的套件全绿"为准，并明确标注该排除项。

---

## 7. 需 Owner 真机确认的人工项

| # | 项目 | 操作步骤 | 期望 |
|---|---|---|---|
| 1 | 记忆页「打开记忆文件目录」 | 打开 UI → 记忆 → 点该按钮 | Finder 弹出 `~/.morrow/data/memory`（非 Tauri 环境降级为显示路径） |
| 2 | 新建会话工作区选择 | 新建会话 → 工作区 → 输入本地项目路径 | 校验通过并显示在会话摘要；分支形态需 GitHub URL |
| 3 | 临时会话面板 | 点右上角「临时会话」 | 右侧独立面板、标注"临时"、可提升单条记忆 |
| 4 | 记忆树可读性 | 多会话 + 多 kind 数据下浏览树视图 | 分组可读、聚类标签合理、展开版本链与来源不拥挤 |
| 5 | Persona 确认弹窗 | 设置 → Persona → 修改 → 保存 | 弹窗显示会话数与生效范围说明；取消不保存 |

---

## 8. 质量证据汇总

| 项目 | 结果 | 指针 |
|---|---|---|
| typecheck | **5/5 包通过** | `pnpm -r typecheck` |
| runtime 单测（含附录 A 修复批） | **799/799 通过**（排除 `checkpoint.faults` 与两个真实容器套件） | `node --experimental-sqlite --test --experimental-strip-types $(find test -maxdepth 1 -name "*.test.ts" ! -name "sandbox.docker.test.ts" ! -name "capability-factory.harness.container.test.ts" ! -name "checkpoint.faults.test.ts")` |
| desktop 单测（含附录 A 修复批） | **179/179 通过** | `pnpm --filter @morrow/desktop test:ui` |
| desktop 构建 | 通过（427KB / gzip 129KB） | `pnpm --filter @morrow/desktop run build` |
| Rust 测试 | **9/9 通过** | `cd apps/desktop/src-tauri && cargo test` |
| Docker Linux（node:24 / git 2.39.5，workspace+session+ephemeral） | **63/63 通过**（含附录 A 新增的 A1/A2/A5 用例） | `docker run --rm -v "$PWD:/repo" -w /repo/apps/runtime node:24 sh -c 'node --experimental-sqlite --test --experimental-strip-types test/workspace*.test.ts test/sessions*.test.ts test/memory.ephemeral*.test.ts'` |
| 本阶段新增测试 | **runtime +66 / desktop +37**（按各票自述累计）；**code-review 修复批再 +13 runtime / +3 desktop** | 见 §2 各 FR 的指针与附录 A |

---

## 9. 发布建议

**可发 `v0.2.0`（会话体验），前提是先清掉 §6 的阻塞项。**

- 功能面：20/23 FR 达成，2 项部分与 1 项未验证均有明确后续动作（补 `session_id`、接原生选择器、真机验证）。
- 阻塞项只有一条，且是**既有测试**问题而非产品缺陷——修它属于"让门禁可信"，不属于功能开发。
- 发布说明须写明：临时会话禁写入类能力只在调用层生效（§4-1）、本地工作区为路径输入（§4-2）、记忆视图无 confidence（§4-4）。

---

## 10. 未验证项与报告边界

| 项 | 为什么没验 | 怎么补 |
|---|---|---|
| `open_memory_dir` 唤起 Finder | 需 GUI 会话，自动化环境无法确认 | Owner 真机点一次（§7-1） |
| 全量测试稳定绿 | `checkpoint.faults` P6 挂起（§6） | 单独票修复该测试的时序与清理 |
| Tauri 原生目录选择器 | 规格禁止新增依赖 | 后续独立票引入 dialog 插件 |
| 真实 GitHub 私有仓库 clone | 未用真实私有仓库与真实 PAT 跑 | 需 Owner 用自己的私有仓库验证一次 |

**报告边界**：本报告的所有数字来自 `integration/m7a` @ `7e17e7b` 工作树的本机实测，未包含 §6 排除项之后的完整套件；CI 结论以最新 run 为准（见 issue #64 评论）。

---

## 附录 A：M7-A code-review 修复批（来源 #64，双轴发现）

本附录记录门禁之后按 code-review 结论做的修复与复验。**§6 的 checkpoint.faults 阻塞项不在本批范围内**（独立票 #65）。

### A.1 安全 / 正确性（全部修复，带测试证据）

| # | 问题 | 修复 | 证据 |
|---|---|---|---|
| A1 | GitHub PAT 会被送到任意 host | clone 凭据**只注入白名单 host**（当前 `github.com`），且按 host 精确限定 `http.https://<host>/.extraHeader`（不再是全局 `http.extraHeader`）；运行期清除 `GIT_CURL_VERBOSE`/`GIT_TRACE_CURL`；`clone_failed` 的 message/stderr 脱敏（token 原文 + `Authorization:`/`extraheader` 行）。非白名单 host 不注入并在错误里说明 | `workspace.manager.test.ts`：A1×5（捕获 argv/env 断言非 github host 无 token、github host 用限定 key、verbose 被清除、`redactCredentials` 抹净、`credentialHost` 四形态） |
| A2 | 默认分支名会撞车（uuidv7 前 6 hex = 时间戳高位） | 短 id 改取 **uuidv7 尾部 8 hex 随机位**；默认名撞车时自动试 `-2`…`-5`（5 次），全撞 409 且给 `suggested_branch`；显式 `new_branch` 不偷换 | `workspace.manager.test.ts`「同一仓库两次绑定（两个真实会话）」+「撞车 -2 重试」+「同毫秒两个会话名不同」；`m7a-review-fixes.test.ts`「两个真实会话 HTTP 端到端建分支」断言 `git branch --list` 两条都在 |
| A3 | 临时会话过期会因投影重建复活 | 过期状态**由账本重放推出**（`session.ephemeral_closed.closed_at + 24h` vs 当前时间），`expired_at` 仅作缓存；`MemoryProjectionRebuilder` 注入时钟；`overview()`、`promoteMemory()` 入口也 sweep；`memory.promoted` 加入 `needsRebuild` | `m7a-review-fixes.test.ts`：A3×2（重建后检索与 overview 都空；promote 过期 → 409 `memory_invalid_state`） |
| A4 | 临时会话 403 只覆盖能力 invoke | 收敛到 `ephemeral-gate.ts` 单一判定，补齐 **skill invoke**（检查全部 step 能力）与 **任务创建**（403 `ephemeral_task_forbidden`） | `m7a-review-fixes.test.ts`：A4×2（skill invoke 403 + 普通会话不受影响；建任务 403 + 普通/无归属 201） |
| A5 | local 绑定 discard 恒 409 `not_isolated`；realpath 兜底恒真 | local 绑定抛专用 `discard_not_supported_for_local`（409），UI 禁用该选项并说明理由；realpath 改为**前缀判定**（必须仍在 worktreesRoot 之下且等于本会话目录），symlink 逃逸拒绝 | `workspace.manager.test.ts`：A5×2（local 专用码 + 外部 symlink 被拒且外部目录未动）；`session-ui.test.ts`：local discard 有 `disabledReason`、专用码文案 |
| A6 | 附件上限按单次请求而非累计 | `addAttachments` 在**合并后的集合**上校验（≤10 个 / ≤1 MiB），超限 400 `attachment_limit_exceeded`（message 含当前数量与上限）；`attach()` 抛错不再被静默吞掉 | `m7a-review-fixes.test.ts`：A6×2（两次各 6 个 → 第二次 400 且状态不变；attach 错误返回 400 错误码） |

### A.2 文档与命名（全部修复）

| # | 问题 | 修复 |
|---|---|---|
| B1 | ADR-0009 / GLOSSARY 的 Persona 口径过时 | 按实现修订为"只影响新建会话"，**保留"为什么当初以为是全失效"**的说明（ADR-0009 新增小节），避免以后被当成实现 bug |
| B2 | `apps/runtime/README.md` 缺 M7-A 事件族与端点 | 新增「M7-A 会话体验事件族」与「M7-A 会话体验端点」两节（含临时会话门、discard 边界、到期推导口径） |
| B3 | `not_ephemeral` 两处语义相反；`restoreDeadline`/`canRestore` 同名异义 | 拆为 `already_ephemeral`（普通关闭被喂给临时会话）与 `not_an_ephemeral_session`；重命名为 `sessionRestoreDeadline`/`canRestoreSession`（30 天软删）与 `ephemeralRestoreDeadline`/`canRestoreEphemeral`（24h 关闭） |
| B4 | `SessionSummary` / `MemoryOverviewEntry` runtime 与 desktop 各一份且已漂移 | 收敛进 `@morrow/protocol`（新增 `SessionKind`/`SessionSummary`/`MemoryOverviewEntry`/`MemoryOverviewRevision`/`MemoryOverviewSource`），runtime 与 desktop 改为 re-export；desktop 的 `kind`/`attachment_count` 从可选变必填，漂移消除 |

### A.3 登记不修（技术债，建议独立票）

| # | 问题 | 为什么本轮不修 | 建议 |
|---|---|---|---|
| C1 | `apps/runtime/src/sessions.ts` 1360 行 Divergent Change | 折叠逻辑（`#foldSessions`/`#foldSession`/生命周期折叠）与 Agent Loop 混在一个类，外提 `SessionProjection` 会动到全部会话测试的接缝，重构风险高 | 独立票：把 `#foldSessions`/`#foldSession`/`#lifecycleOf`/`#rebuildBranchRegistry` 外提为 `SessionProjection`（纯函数 + 账本输入），SessionManager 只保留写入与 Loop |
| C2 | `workspace.ts` 与 `worktree.ts` 的 `-c` 身份 + 环境变量注入重复 | 两处注入内容一致但生命周期不同（会话 vs 任务），合并需要先统一"git 子进程身份"的语义边界 | 独立票：抽 `git-identity.ts`（`GIT_IDENTITY` 常量 + `withIdentityEnv()`），两处共用 |
| C3 | `#branchRegistry` 有 7 处就地失效且缓存只写不读 | 每次 `branchHolder()` 都会 `#rebuildBranchRegistry()` 并用账本结果**覆盖**缓存，缓存实际是纯写不读的死结构（性能问题，不是正确性问题——账本仍是唯一真相） | 独立票：要么删掉缓存（当前复杂度 O(账本)，先量化调用频次），要么改成"写路径增量更新 + 读路径只在记账后失效" |
| C4 | `workspace.manager.test.ts` / `workspace.close.test.ts` 用 `execFileSync` 跑真实 git 无 timeout（与 #65 同类脆弱性） | 已在本轮给两处 `git()` 加 `timeout: 60_000` 兜底（避免 git 卡住时挂起整个套件）；更彻底的修法与 #65 同一票（统一子进程测试工具 + 全局超时） | 并入 #65 |
