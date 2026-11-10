# @morrow/desktop

Tauri 2 + React 桌面壳（票 T6 / Issue #7）。Chat 视图完成流式对话（增量渲染、工具事件可见）
与历史回看；UI 与 Runtime 全部通过本地控制面 API（HTTP + SSE）通信，壳不建私有 IPC 通道。

## 结构

```
src/          React 前端（Vite）：App / SessionList / ChatView
  api.ts                控制面 fetch 封装（错误统一 { error: { code, message } } → ApiError）
  sse.ts                帧 → Chat 投影的纯归约（durable/易失帧语义，node:test 覆盖）
  runtime-endpoint.ts   控制面地址解析（壳内轮询 sidecar_status；浏览器联调用 ?runtime=）
src-tauri/    Tauri 壳（Rust）
  src/sidecar.rs        sidecar 生命周期：拉起 Runtime、stdout ready 协议、SIGTERM 退出
  src/main.rs           装配：setup 拉起 sidecar，sidecar_status 命令暴露给前端
```

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
pnpm --filter @morrow/desktop test    # tsc + node:test（sse 归约）+ cargo test（sidecar，含 dist 全链路冒烟）
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
   `GET /v1/sync/status` 不含对端账本上界。「刷新同步状态」只做查询——M3 尚无「立即
   同步一轮」控制端点，按钮旁明确标注。
5. 冲突审核：来源副本 + 本地/远端/基线三方版本 + 行级 diff；保留本地（keep_old）/
   采用远端（keep_new）/ 合并（必填合并文本）→ 真实裁决写入账本，勾「显示已裁决」可回看。
6. 任务页：需要裁决的任务有橙色警示条与「⚠ 待人工裁决」徽标；详情页横幅展示
   「两设备独立执行过此任务，需你裁决」+ 执行证据（GET /v1/tasks/:id/execution）+
   可选裁决说明 → 「标记为已完成 / 标记为失败」→ 状态离开 needs_reconcile。

## 已知边界（M0）

- 历史回看来自 `GET /v1/sessions/:id/messages` 投影（user/assistant 消息）；历史轮次的
  工具事件不在该投影里，重启后 SSE 重放也只补 `lastSeq` 之后的 durable 帧——工具事件
  的持久回看等 Runtime 提供会话级事件查询后再补。
- .app 未签名（Gatekeeper 首次打开需右键 → 打开）；sidecar 依赖本机 `node`（PATH），
  自包含单二进制是 T8 的事。
