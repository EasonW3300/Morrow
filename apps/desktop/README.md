# @morrow/desktop

Tauri 2 + React 桌面壳（票 T6 / Issue #7）。Chat 视图完成流式对话（增量渲染、工具事件可见）
与历史回看；UI 与 Runtime 全部通过本地控制面 API（HTTP + SSE）通信，壳不建私有 IPC 通道。

## 结构

```
src/          React 前端（Vite）：App / SessionList / ChatView
  api.ts                控制面 fetch 封装（错误统一 { error: { code, message } } → ApiError）
  sse.ts                帧 → Chat 投影的纯归约（durable/易失帧语义，node:test 覆盖）
  runtime-endpoint.ts   控制面地址解析（壳内轮询 sidecar_status；浏览器联调用 ?runtime=）
  design-system/        Liquid Glass 设计系统（见 UI_DESIGN_SYSTEM.md）
    tokens.css          颜色 / 玻璃 / 圆角 / 间距 / 字体 / 动效 tokens（light + dark）
    theme.ts            主题持久化与 <html data-theme> 应用
    primitives/         GlassSurface / Button / Badge
    ConfirmDialog.tsx   应用内确认框（替代 window.confirm）
  notification-center.ts  通知消费纯逻辑：轮询状态机/去重/ack 退避/权限降级/投影（node:test）
  notification-system.ts  Tauri 通知桥：权限查询/请求/发送（非 Tauri 环境降级）
  NotificationCenter.tsx  顶栏铃铛 + 应用内通知中心面板
src-tauri/    Tauri 壳（Rust）
  src/sidecar.rs        sidecar 生命周期：拉起 Runtime、stdout ready 协议、SIGTERM 退出
  src/main.rs           装配：setup 拉起 sidecar，sidecar_status 命令暴露给前端
  capabilities/default.json  权限：core:default + notification:default（Issue #47）
```

UI 材质约定：玻璃只用于顶栏、侧栏、浮动输入区与浮层（弹窗/确认框）；
消息、任务、设置、表格等正文一律使用标准内容面。深浅色由顶栏右侧按钮切换并持久化。

## sidecar 启动协议

壳启动时拉起 Runtime 子进程，读取 stdout 的**单行 JSON ready 帧**拿控制面地址
（`{"ready":true,"host":"127.0.0.1","port":<随机>,"pid":...}`）；`MORROW_PORT` 默认 0
（随机空闲），无端口冲突。父进程退出 → SIGTERM 子进程 → Runtime 优雅落盘退出
（2s 内未退则 SIGKILL）。ready 等待上限 20s；子进程提前退出/超时通过
`sidecar_status` 命令以 error 态呈现给前端。

### 启动命令可配置（T8 单二进制 / T9 预留）

解析优先级：环境变量 > 默认值。

| 环境变量 | 默认（dev/debug 构建） | 说明 |
| --- | --- | --- |
| `MORROW_SIDECAR_COMMAND` | `node` | sidecar 可执行文件 |
| `MORROW_SIDECAR_ARGS` | `["--experimental-sqlite", <runtime 入口>]` | **JSON 数组**，非法即启动失败 |
| `MORROW_SIDECAR_CWD` | runtime 入口所在目录 | 子进程工作目录 |

runtime 入口：dev（debug 构建）= 仓库内 `apps/runtime/dist/main.js`（esbuild 自包含产物，
`pnpm --filter @morrow/runtime build` 生成）；release 打包 = Tauri 资源目录
`runtime/main.js`（tauri.conf.json `bundle.resources` 注入，随 .app 分发）。
换单二进制（T8）：设 `MORROW_SIDECAR_COMMAND=<binary>`、`MORROW_SIDECAR_ARGS=[]` 即可，壳不改。

Node < 22.13 需要 `--experimental-sqlite`（22.13+ 默认开启，标志保留无害）。
子进程继承壳的环境变量，`MORROW_PROVIDER_*` / `MORROW_DATA_DIR` 等照常生效。

## 命令

```bash
pnpm --filter @morrow/runtime build   # 先产 dist（sidecar 与打包资源的前置）
pnpm --filter @morrow/desktop dev     # vite dev（壳内调试用 tauri dev）
pnpm --filter @morrow/desktop tauri dev    # 完整桌面壳开发模式
pnpm --filter @morrow/desktop tauri build  # 产出 macOS .app（target/release/bundle/macos/）
pnpm --filter @morrow/desktop test    # tsc + node:test（sse/通知中心等纯逻辑）+ cargo test（sidecar，含 dist 全链路冒烟）
```

### 浏览器联调（无壳）

```bash
MORROW_DATA_DIR=/tmp/morrow-fixture node --experimental-sqlite --experimental-strip-types \
  apps/runtime/scripts/dev-fixture.ts   # 脚本化 Agent 的 Runtime（流式/工具/错误可复现）
# 打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<fixture端口>
```

`?runtime=` 仅用于浏览器联调的端点发现；打包应用内一律走 sidecar 上报的地址，
且无论哪种方式 UI 与 Runtime 都只有控制面 HTTP/SSE 一种通道。

### 设置与健康页联调（票 T7 / Issue #8）

```bash
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/settings-fixture.ts
# 打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<runtime端口>（stdout ready JSON 给出）
```

夹具 = 真实 Runtime（Provider CRUD / 连通性测试 / 会话族，密钥走内存 SecretStore，不碰
系统钥匙串）+ 四条连通性路径的本地 mock（200→ok、401→auth_failed、无人监听端口→
unreachable、500→error）+ 脚本化 Agent（建会话发消息无需真实模型）。浏览器级全流程验证：
新增 Provider（密钥框 password 型、保存后不回显）→ 逐一点「测试连通」核对四类结果的归类
呈现 → 设为默认 → 会话页新建会话发消息 → 健康页核对 /v1/health 全量字段与沙箱桩说明。

### Task 视图与人工介入联调（票 M1-T6 / Issue #18）

```bash
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/task-fixture.ts
# 打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<runtime端口>（stdout ready JSON 给出）
```

夹具 = 真实 Runtime + 脚本化任务（FakePi 规划 3 节点 DAG；节点执行为慢 Agent，每个约 4s，
给「暂停」留出安全点窗口）+ 预置会话与关联任务（session_id 关联）。浏览器级 AC-12 全流程：

1. Chat 页顶部出现本会话的任务状态卡片，点击跳 Task 视图（列表 → 详情）；
2. 详情页点「恢复」→ 节点开始执行（约 4s/个，DAG 按依赖层级分组、事件流分页可见）；
3. 执行中点「暂停」→ 安全点暂停 + checkpoint 落库；
4. 「修改…」改节点目标/模型、增删未完成节点（已完成节点不可改）→ 提交后
   task_version+1、自动落 reason=revise 的新 checkpoint；
5. 「恢复」→ 按新 DAG 跑完 → completed；
6. 节点级：pending 节点「接管」→ 任务转等待输入 → 「完成…」提交结果或「交还调度」；
   全部介入操作在事件流里以 actor=owner 审计事件可查（task.revised /
   task.node_taken_over / task.node_completed_by_owner / task.node_released）。

### 能力管理联调（票 M2-T6 / Issue #27）

```bash
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/capability-fixture.ts
# 打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<前置端口>（stdout ready JSON 给出）
```

夹具 = 真实 Runtime（能力注册表 / 授权面 / 生命周期全走 T1 真实端点）+ 预置演示数据
（memory.write builtin、web.fetch 双版本历史、log.archive 停用态、report.render；授权面
先 PUT 覆盖演示能力——注册校验 permissions ⊆ grants 真实生效）+ 前置端口透明代理 +
T3 工厂接缝 mock 与 T5 Skill 接缝 mock（T3/T5 合入后删除对应 mock 段即可，UI 路径即合约）。
浏览器级全流程验证：

1. 设置 → 能力管理 → 能力清单：核对徽标（author human|ai、runtime、启停态）；点开
   web.fetch 详情——五维权限分组、input/output schema、tests 清单、版本历史时间线、
   source_hash；点「回滚到此版本」→ 二次确认 → 当前版本指针回移（确认门：armed 态展示
   后果说明，取消无副作用）；对 log.archive「启用」、对已启用能力「停用」（同样过确认门）。
2. 预授权页签：改 filesystem 多行文本 / 勾选 shell 类别与渠道 → 保存区实时呈现 diff 与
   审计提示（收窄立即约束运行时复核）→ 保存 → GET /v1/capabilities/grants 反映新授权面，
   capability.grants_updated 审计事件落账本；把 grant 收窄到覆盖不了某能力声明时，
   该能力重新注册会被 400 escalation 拒绝（真实校验）。
3. 工厂页签：提交需求描述 → 进度区走 检索→规划→构建→验证→待确认（约 8s）→ 验证报告
   四类测试（schema/越权/功能/沙箱）→ 候选 manifest 核对 → 「确认注册」→ csv.export
   真实注册进注册表（ai 默认停用，回清单启用）。
4. Skill 页签：清单呈现组合的能力芯片；提案批准/拒绝——prop-dangling（引用未注册的
   mail.send）点「批准」→ 409 skill_dangling_reference → 行内呈现悬空引用拒绝理由。
5. Task 视图（配合 task-fixture）：节点执行用到注册表能力时，节点面板出现能力引用芯片
   （名称+版本），点击跳设置→能力管理并预选该能力详情。

### 设备与同步联调（票 M3-T6 / Issue #35）

```bash
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/device-fixture.ts
# 打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<runtime端口>（stdout ready JSON 给出）
```

夹具 = 真实 Runtime（真实 SQLite 账本与配对服务）+ 脚本化预置数据：本机自注册行、
两台已配对设备（各自独立 ed25519 指纹）、一台已撤销设备；两台 peer 的同步游标
（一个双向推进、一个只拉未确认）；一条真实走「记忆写入 → 受控导入 sensitivity 冲突」
的跨设备冲突（附 sync_conflict_meta 来源副本与三方版本）；一个真实创建后冻结为
`needs_reconcile` 的任务（证据写明两个副本各自独立执行过）。浏览器级全流程：

1. 设置 → 设备与同步 → 设备列表：核对 label / 指纹短格式（悬停看完整指纹）/ 信任与
   撤销徽标 / 配对时间 / 最后同步（未写过则「从未」）；对已配对设备「撤销…」→ 二次
   确认 → 行变灰并显示撤销时间；本机行不提供撤销（服务端 409 cannot_revoke_self 同口径）。
2. 生成配对码：6 位码 + mm:ss 倒计时（<1 分钟转警示色）+ 本机指纹；过期后明确提示
   重新生成。
3. 加入另一台设备：地址默认当前 Runtime（同一实例演示闭环）；填入第 2 步的码与指纹
   → claim → 展示双端指纹 → 确认完成（设备出现在列表）或「指纹不一致」→ 立即撤销。
   填写错误指纹时服务端 409 fingerprint_mismatch 且**不消耗配对码**（改值重试可成功）。
4. 同步状态面板：本副本 seq 范围/条数、各 peer 游标（已拉取/已确认/更新时间）、最后
   同步时间、待上传估算（本地上界 − 已确认，钳到 0）；「待下载」显示未知并注明
   `GET /v1/sync/status` 不含对端账本上界。「刷新同步状态」只做查询；面板同时提供
   「立即同步一轮」，调用 Runtime 的 `POST /v1/sync/run`（缺省全部已配对 peer，失败单 peer
   不中断其他 peer）。
5. 冲突审核：来源副本 + 本地/远端/基线三方版本 + 行级 diff；保留本地（keep_old）/
   采用远端（keep_new）/ 合并（必填合并文本）→ 真实裁决写入账本，勾「显示已裁决」可回看。
6. 任务页：需要裁决的任务有橙色警示条与「⚠ 待人工裁决」徽标；详情页横幅展示
   「两设备独立执行过此任务，需你裁决」+ 执行证据（GET /v1/tasks/:id/execution）+
   可选裁决说明 → 「标记为已完成 / 标记为失败」→ 状态离开 needs_reconcile。

### 渠道与联系人联调（票 M4-T8 / Issue #45）

```bash
node --experimental-sqlite --experimental-strip-types apps/desktop/scripts/channel-fixture.ts
# 打开 http://127.0.0.1:1420/?runtime=http://127.0.0.1:<runtime端口>（stdout ready JSON 给出）
```

夹具 = 真实 Runtime（渠道注册表/联系人服务/通知规则/Outbox 全走控制面端点）+ 本地平台协议桩：
飞书适配器接 ChannelTestServer（token TTL 60s → 清单不断刷新后显示「token 已过期 / 不健康」），
QQ 适配器接共享服务器上的 QQ 桩（健康态），微信适配器接 StubLocalBridge 且出厂 disabled
（实验态 + 常驻「实验」徽标）。预置：三个渠道账号、微信/飞书白名单、两个联系人
（林=query+task_execute、周=query）与一条身份歧义、六条通知规则（含跨天免打扰与停用行）、
Outbox sent/failed/needs_review 三种真实状态（403 真实失败；发送超时真实转人工核对），
以及 3 条桌面 pending 通知（completed / failed / 免打扰到点，见「桌面通知中心」）。
浏览器级全流程（本票交付时已按此走查）：

1. 设置 → 渠道：核对飞书/QQ/微信的类型、状态、health（连接/token 剩余或已过期/最近错误/
   本地桥）、capabilities 徽标（主动消息一律「受限」或「不可用」，绝不出现「可用」）；
   飞书/QQ 的「配置凭据…」只显示「已配置（不回显）」投影，填写缺失字段保存后界面
   不出现任何明文（GET/PUT `/v1/channels/:id/secrets`）。
2. 微信「启用（实验）…」→ 弹窗展示完整 risk_notice + 声明环境 → 未勾选时确认按钮
   禁用并说明原因 → 勾选后「确认启用（自担风险）」→ 适配器实际运行、桥进程/登录/窗口
   变为 running/logged_in/available（channel.experimental_enabled 审计）；「实验」徽标常驻。
3. 群聊白名单：选微信 → 新增 `wx-group-ops` + 模式「有限主动消息」→ 保存 → GET allowlist
   反映三行（channel.allowlist_updated 审计）。
4. 可信联系人：输入显示名 → 生成一次性邀请码（MC-…）+ 24 小时倒计时 + 复制；为「周」
   勾选「记忆引用（仅 public）」→ 保存授权（contact.grants_updated）；在身份歧义里选
   「周（家人）」→ 选择此人（contact.ambiguity_resolved），列表转为无待裁决。
5. 通知规则：新增 failed × channel:wechat，免打扰 21:00–06:00（跨天）→ 保存 → 刷新后
   规则仍在（notification.rule_upserted）；起止相同/非法 HH:MM 会被前端拒绝。
6. Outbox：needs_review 行显示内容摘要/失败原因/attempts →「我已核对，重发」→ 二次确认
   后状态重置为 pending（不自动重发，等投递器）；「标记已送达」写人工回执；最近 sent 列表
   始终作为对照。

## 桌面通知中心（Issue #47 / PRD §4.8 FR-NOT-2）

M4 的 runtime 控制面早已提供 `GET /v1/notifications/pending`、`POST /v1/notifications/:id/ack`，
但桌面端此前从不消费（pending 永远停在数据库）。现在桌面壳补齐消费端：

- **轮询**：默认 10s 拉一次 pending（`?notification_poll_ms=2500` 或
  `VITE_NOTIFICATION_POLL_MS` 可配，`0` 关闭），逐条展示后 `POST /:id/ack`（pending → sent）。
- **系统通知**：Tauri v2 官方 `tauri-plugin-notification`（Rust 侧 `.plugin(init())` +
  `capabilities/default.json` 的 `notification:default`；JS 侧 `@tauri-apps/plugin-notification`）。
  首次启动请求一次权限；被拒后写本地标记（`morrow.notification.permissionDenied`）不再自动
  弹系统授权框，通知降级为应用内通知中心展示，面板顶部有说明与「重新请求权限」按钮。
- **去重与重试**：同一 notification id 会话内只弹一次；已 ack 的由服务端 status 兜底。
  ack 失败指数退避重试（上限 3 次），日志只记 id/事件类型/正文长度，**不打印正文**；
  通知正文已由服务端按接收者裁剪，端侧不回读记忆/文件补全。
- **应用内中心**：顶栏铃铛 + 未读数（= pending 条数）；列表含时间/事件类型/任务标题
  （点击跳 Task 视图）/正文摘要；「全部标记已读」逐条 ack；空态有文案。
- **免打扰**：由服务端处理（窗口内落 delayed，到点才出现在 pending），端侧不重复判定。

浏览器级走查（无 Tauri，恒为应用内模式）：`channel-fixture` 预置 3 条 pending
（completed / failed / 免打扰到点），打开后铃铛显示 3 条未读；点开面板可看到列表与权限说明；
点任务标题跳转对应任务；「全部标记已读」后 `GET /v1/notifications/pending` 归零。
追加 `&notification_permission=denied` 可复现「权限被拒」文案。

## 已知边界（M0）

- 历史回看来自 `GET /v1/sessions/:id/messages` 投影（user/assistant 消息）；历史轮次的
  工具事件不在该投影里，重启后 SSE 重放也只补 `lastSeq` 之后的 durable 帧——工具事件
  的持久回看等 Runtime 提供会话级事件查询后再补。
- .app 未签名（Gatekeeper 首次打开需右键 → 打开）；sidecar 依赖本机 `node`（PATH），
  自包含单二进制是 T8 的事。
