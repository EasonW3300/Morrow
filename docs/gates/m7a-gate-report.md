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
| FR-A10 禁用写入类能力 | **部分** | `memory.ephemeral.api.test.ts`（调用网关 403）+ `ephemeral-ui.test.ts`（按钮禁用） | 见 §4-1：能力注册/工厂端点无会话归属，HTTP 层无法拒绝 |

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

1. **T3 / FR-A10**：`POST /v1/capabilities` 与能力工厂请求端点**没有会话归属参数**，无法在 HTTP 层把"临时会话"关联上去。因此"临时会话禁写入类能力"落在**能力调用网关 403 + UI 禁用**两道，规格写的"双保险"实际是 1.5 道。补 `session_id` 参数才能真正闭环。
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
| runtime 单测 | **806 tests**（其中 1 条受 §6 影响未稳定完成） | `pnpm --filter @morrow/runtime test:unit` |
| desktop 单测 | **176/176 通过** | `pnpm --filter @morrow/desktop test:ui` |
| desktop 构建 | 通过（427KB / gzip 129KB） | `pnpm --filter @morrow/desktop run build` |
| Rust 测试 | **9/9 通过** | `cd apps/desktop/src-tauri && cargo test` |
| Docker Linux（workspace+session） | **30/30 通过**（git 2.54.1） | `docker run … test/workspace*.test.ts test/sessions*.test.ts` |
| 本阶段新增测试 | **runtime +66 / desktop +37**（按各票自述累计） | 见 §2 各 FR 的指针 |

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
