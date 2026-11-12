# 会话工作区：一个会话绑定一个项目目录与分支，执行边界随之收窄

M7 引入会话工作区（Session Workspace）：新建会话时可选择本地项目目录，或输入 GitHub 仓库（无本地副本则 clone 到受管目录），并可选新建分支。决定：

- **工作区 = 目录**（bash、git、快照都以目录为单位）；单文件只作**会话附件**（只读注入上下文，不进工作区）。
- **宿主执行与写操作默认仅限工作区目录**；写工作区之外的路径需要在该会话内显式授权一次，授权入审计。
- **快照由 git 承担**（`stash` 或临时 commit），非 git 目录才用 `cp -a`；「撤销本次执行」只承诺工作区内。
- **同一仓库的多个会话自动用 git worktree 隔离**（复用 M2-T4 能力）；同一分支被占用时拒绝第二个会话并提示持有者。
- 凭据优先复用本机 `gh auth token`，缺失时提示在设置里填 PAT（存 OS 凭据库）；**push 与开 PR 永远需要 Owner 点确认**。

## Considered Options

- **工作区可为单文件**：bash 与 git 无法以文件为单位隔离，快照与回滚会失真。
- **执行不限定目录**：等于放弃 Q18/Q20 建立的"受管路径"边界，让"完全权限"无法定义范围。
- **不允许同仓库多会话**：与"多个想法并行推进"的实际用法冲突，而 worktree 是现成能力。

## Consequences

- 会话元数据新增 `workspace`（路径/分支/仓库来源/基线分支）与 `attachments`；`session.created` 事件 payload 只加字段。
- `~/.morrow/workspaces/` 与 `~/.morrow/worktrees/` 成为受管目录，纳入数据目录约定与清理策略（会话删除不删工作区，需显式清理，避免误删未提交工作）。
- 快照只覆盖工作区，所以"完全权限"的风险说明必须写明：`~/.ssh`、`/etc`、其他项目目录不在保护范围内。

## 实现补充（M7-A-T4 / Issue #61）

- **受管目录**：GitHub 主 clone 落 `~/.morrow/workspaces/<repo>-<url 短哈希>`；会话 worktree 落
  `~/.morrow/worktrees/sessions/<session_id>`（与 M2-T4 的任务 worktree `<dataDir>/worktrees` 分名，
  互不干扰）。会话删除不清理这两个目录——未提交工作由 Owner 显式处理（会话关闭三选一属 T5）。
- **关联判定口径**：按 `remote.origin.url` 归一化比较（协议、凭据、`.git` 后缀、末尾斜杠不参与；
  端口以外的 host 小写）。命中即关联，不重复 clone；否则 clone 到上述目标目录。
- **凭据**：优先 `gh auth token`，其次 OS 凭据库 `service=github, account=pat`；clone 用
  `GIT_CONFIG_KEY_0=http.extraHeader` 注入 Authorization（token 不进 argv、不写进 remote URL）。
  无凭据时 clone 失败返回带"在设置里填 GitHub PAT 或先 gh auth login"的提示（HTTP 502 clone_failed）。
- **分支**：缺省 `morrow/<session 前 6 位>`；基线缺省探测 `origin/HEAD`，失败回退 main → master → HEAD；
  同名分支已存在返回 409 `branch_exists`，同分支被其它 worktree 占用返回 409 `branch_in_use`。
- **附件**：只读、不写入文件；单会话最多 **10 个**、单文件 **256 KiB**、合计 **1 MiB**，二进制
  （含 NUL 字节）拒绝。内容不落账本（`session.attachment_added` 只存 path/name/size），
  发消息时按路径重读并附在**发给 Agent 的 user 消息**末尾的 `<附件内容>` 段落——user 消息账本
  原文不变；这样会话中途新增附件也立即可见（system prompt 只在运行时创建时求值一次）。
