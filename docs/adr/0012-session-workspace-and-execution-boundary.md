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
  `GIT_CONFIG_KEY_0=http.https://<host>/.extraHeader` 注入 Authorization（**按 host 精确限定**，
  token 不进 argv、不写进 remote URL）。**只有白名单 host（当前仅 `github.com`）注入凭据**：
  clone URL 是用户输入，任意 https/scp 地址都可能是第三方；用全局 `http.extraHeader` 会
  把 PAT 送给用户粘贴的任意 host（#64-A1 修复）。非白名单 host 不注入，clone 失败信息里
  说明"凭据只注入 github.com"。运行期清除 `GIT_CURL_VERBOSE` / `GIT_TRACE_CURL`（调试开关会
  把完整请求头打到 stderr），`clone_failed` 的 message/stderr 再过一层脱敏（token 原文与
  Authorization/extraheader 行一律替换）。无凭据时 clone 失败返回带"在设置里填 GitHub PAT
  或先 gh auth login"的提示（HTTP 502 clone_failed）。
- **分支**：缺省 `morrow/<session 短 id>`——短 id 取 **uuidv7 尾部随机位**（8 hex），不是前 6 位。
  uuidv7 前 48 bit 是毫秒时间戳，取前 6 hex 等于取时间高位，约 4.7 小时内新建的会话会得到同一
  默认名，第二个 GitHub 绑定必然 409（Story 21/23「自动隔离」失效；#64-A2 修复）。默认名撞车时
  自动试 `-2`…`-5`（最多 5 次），仍全撞则 409 `branch_exists` 并在 error 信封里给
  `suggested_branch`；用户显式传 `new_branch` 时只试那一个（显式选择撞名要如实报，不偷换）。
  基线缺省探测 `origin/HEAD`，失败回退 main → master → HEAD；同名分支已存在返回 409
  `branch_exists`，同分支被其它 worktree 占用返回 409 `branch_in_use`。
- **附件**：只读、不写入文件；单会话最多 **10 个**、单文件 **256 KiB**、合计 **1 MiB**，二进制
  （含 NUL 字节）拒绝。**数量与总字节按会话累计校验**（#64-A6）：单次请求只带 1 个也能靠反复
  调用突破上限，所以 `addAttachments` 在**合并后的集合**上再校验一次，超限 400
  `attachment_limit_exceeded`（message 写明当前数量/总字节与上限）。`attach()` 的抛错不静默：
  添加端点把错误码如实返回（400），发消息时的注入失败也会在 prompt 里留 `<附件读取失败>` 段落。
  内容不落账本（`session.attachment_added` 只存 path/name/size），发消息时按路径重读并附在
  **发给 Agent 的 user 消息**末尾的 `<附件内容>` 段落——user 消息账本原文不变；这样会话中途
  新增附件也立即可见（system prompt 只在运行时创建时求值一次）。
- **会话关闭三选一（T5）**：commit / keep / discard。discard 只对**会话 worktree**有效：路径必须
  是 `<worktreesRoot>/<sessionId>`，且 `realpath` 解析后仍严格落在 worktreesRoot 之下
  （symlink 逃逸拒绝，`not_isolated`）——**不能**比较 `realpath(actual)` 与 `realpath(expected)`
  （两者由同一字符串推出，恒相等，等于没校验；#64-A5 修复）。local 绑定没有 worktree 隔离，
  **不支持 discard**，返回 409 `discard_not_supported_for_local`（不伪装成 `not_isolated`：
  前者是"该来源不支持这个动作"，UI 据此禁用选项并指向 commit/keep）。
