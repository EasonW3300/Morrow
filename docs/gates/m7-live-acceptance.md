# M7 真机验收记录（可自动化部分）

- **日期**：2026-11-18
- **Runtime**：v0.4.0，`MORROW_DATA_DIR=/tmp/morrow-verify-data MORROW_PORT=18787`
- **节点**：Node 24.22 / macOS arm64，Docker 29.4.0（sandbox `ready`）
- **脚本**：`scripts/acceptance/m7-live.mjs`（可复跑）
- **结果**：**23/23 通过**

## 1. 这份记录解决什么

M7-A/B/C 的门禁报告里有一批"需 Owner 真机确认"的项。其中**后端行为与 UI 数据源是否一致**
是可以自动化的部分——这类偏差恰恰最容易藏问题（端点返回了，UI 用的字段却是空的）。

真正需要人眼的部分（弹窗位置、树视图可读性、点击手感）本记录**不覆盖**，见 §4。

## 2. 通过项（23）

### M7-A 会话体验

| 项 | 断言 | 结果 |
|---|---|---|
| A5 Persona GET | 返回结构化字段（name/tone/responsibilities/prohibitions/extra） | ✔ 默认值 `Morrow / 简洁直接 / [个人助理与开发助手]` |
| A5 Persona PUT | 保存成功、字段生效 | ✔ 保存后 `name=小墨` |
| A2 本地工作区绑定 | `PUT /workspace` 200，会话摘要回显同一路径 | ✔ 摘要路径与绑定路径一致 |
| A3 临时会话创建 | `kind=ephemeral` 如实回传 | ✔ |
| A3 不泄漏到全局 | 全局检索为空 | ✔ |

### M7-B 能力扩展

| 项 | 断言 | 结果 |
|---|---|---|
| B2 未勾选风险 | 400 `risk_not_acknowledged`（**装不上**，不是警告） | ✔ |
| B2 勾选后安装 | 201 且 `enabled=false`（默认 disabled） | ✔ |
| B6 已安装页字段 | `source`/`status`/`grants`/`health` 四处齐全 | ✔ `source=manual status=disabled` |
| B7 技能包安装失败 | 可读错误（`npm_failed` 502），不崩 | ✔ |

### M7-C 自动化

| 项 | 断言 | 结果 |
|---|---|---|
| C1 Plan 状态 | 带 `readonly_notice` | ✔ |
| C1 进入 Plan | `active=true` | ✔ |
| C1 Plan 下写能力 | 403 `plan_mode_readonly` | ✔ |
| C1 Plan 下只读检索 | **200 可用**（证明不是空壳名单） | ✔ |
| C4 Goal 未确认 | 400（拒建） | ✔ |
| C4 Goal 创建 | 201 且 `status=active` | ✔ |
| C4 暂停 | `status=paused` | ✔ |
| C4 终态 | `complete` 后 `pause` → 409 | ✔ |
| C6 Best 启动 | `stage=interview` | ✔ |
| C6 访谈缺推荐答案 | 400（强制推荐答案） | ✔ |
| C6 规格提交 | `stage=spec status=awaiting_gate` | ✔ |
| C6 规格通过 | `stage=tickets` | ✔ |
| C7 实现门 | **完全权限下仍 409**（FR-C14） | ✔ |

C7 那一条是本次验收里最关键的：先 `PUT exec-mode {mode: full_access}` 切成完全权限，
再调 `POST /best/:id/implement` —— 仍然 409 `invalid_stage`。这证明"完全权限不能跳实现门"
在真实运行时成立，不只是单测里的断言。

## 3. 验证过程中发现自己脚本的一个假通过

初版脚本里这条断言写成了 `(facts.length ?? 0) >= 0`——**恒真**，无论有没有记忆都会"通过"。
查实际数据发现：临时会话的候选与事实都是空的。

根因是**环境限制不是缺陷**：这台验证 runtime 没有配 Provider，对话轮次以 `agent.error`
收尾，抽取器从未触发。临时会话的记忆作用域隔离由 `memory.ephemeral.api.test.ts` 覆盖
（含注入时钟的 24h 到期语义），本脚本改为只断言"不泄漏到全局"这一条可判定的事实。

记下这件事的理由：**"通过数好看"不能替代"这条断言真的在测东西"**。

## 4. 仍需人眼确认的项（本记录不覆盖）

| # | 项目 | 为什么不能自动化 |
|---|---|---|
| 1 | 记忆页「打开记忆文件目录」唤起 Finder | 需要真实 GUI 会话；非 Tauri 环境降级为显示路径 |
| 2 | 记忆树可读性（多会话 + 多 kind 下的分组/聚类/展开） | 视觉密度与可读性判断 |
| 3 | Persona 确认弹窗的文案与取消行为 | 弹窗是 UI 行为；本脚本只验了 PUT 本身 |
| 4 | MCP 安装页的风险勾选交互（checkbox 与按钮禁用联动） | 同上；本脚本只验了服务端硬门槛 |
| 5 | 技能包升级 diff 的展示布局 | 同上 |
| 6 | 「自动化」页三个面板（Plan/Goal/Best）的实际渲染 | 桌面端无 DOM 测试环境，面板只有纯逻辑测试 |
| 7 | 「推送并开 PR」按钮的确认文案呈现 | 同上 |

## 5. 复跑方法

```bash
# 1) 起干净的 runtime（必须 node >= 22.16，否则缺 FTS5）
MORROW_DATA_DIR=/tmp/morrow-acceptance MORROW_PORT=18787 \
  node --experimental-sqlite --experimental-strip-types apps/runtime/src/main.ts

# 2) 另一个终端
node scripts/acceptance/m7-live.mjs
```

脚本会自己清理它创建的 MCP server；会话与 goal 留在 `/tmp/morrow-acceptance` 里（可随时删）。
